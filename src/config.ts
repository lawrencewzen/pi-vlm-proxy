/**
 * 通用配置管理 —— 不绑定任何厂商，全部由用户配置
 *
 * 配置文件: ~/.pi/agent/vision-config.json
 *
 * {
 *   "current": "my-model",                       // 当前使用的视觉模型名
 *   "providers": {
 *     "my-model": {                              // 任意名字，由用户自定义（不能含空格）
 *       "baseUrl": "https://api.example.com/v1", // OpenAI 兼容地址（自动补 /chat/completions）
 *       "apiKey": "$MY_API_KEY",                 // 支持 $ENV_NAME 引用环境变量，避免明文
 *       "model": "vision-model-name",            // 模型 ID
 *       "headers": { "x-custom": "..." },        // 可选：额外请求头（同名头会覆盖默认 Authorization）
 *       "maxTokens": 4096                        // 可选：输出上限
 *     }
 *   }
 * }
 */

import {
  readFileSync,
  writeFileSync,
  mkdirSync,
  chmodSync,
  copyFileSync,
  existsSync,
  renameSync,
  unlinkSync,
} from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export interface VisionProviderConfig {
  baseUrl: string;
  apiKey?: string;
  model: string;
  headers?: Record<string, string>;
  maxTokens?: number;
}

export interface VisionConfig {
  current?: string;
  /**
   * 透传模式。**没有对应的子命令，只能手改本文件** —— 日常不需要碰它，
   * 留着是给 auto 判断失灵时（主模型元数据没标 image、或标了却调不通）的逃生阀。
   * - "auto"（默认）主模型多模态 → 图片原生透传，隐藏 describe_image；text-only → 启用代理
   * - "on"   强制透传（隐藏 describe_image）
   * - "off"  强制代理（总是显示 describe_image）
   */
  passthrough?: "auto" | "on" | "off";
  providers: Record<string, VisionProviderConfig>;
}

export const CONFIG_PATH = join(homedir(), ".pi", "agent", "vision-config.json");
const CONFIG_DIR = join(homedir(), ".pi", "agent");

/** loadConfig 的详细结果：区分「文件不存在」与「文件损坏」 */
export interface LoadConfigResult {
  config: VisionConfig;
  /** 仅在文件存在但读取/解析失败时有值；此时 config 退化为空配置 */
  error?: string;
}

/** 一个 provider 条目是否可用（至少要有 baseUrl 和 model） */
function isUsableProvider(p: unknown): p is VisionProviderConfig {
  if (!p || typeof p !== "object" || Array.isArray(p)) return false;
  const pp = p as Record<string, unknown>;
  return (
    typeof pp.baseUrl === "string" &&
    !!pp.baseUrl.trim() &&
    typeof pp.model === "string" &&
    !!pp.model.trim()
  );
}

/**
 * 规范化。手工编辑的文件可能塞进 null / 数字 / 缺字段的条目，
 * 这里直接过滤掉并回报名字 —— 否则后续 `p.model` 会读到 undefined（静默发错请求），
 * 条目为 null 时更是直接抛 TypeError 把 /vision list 打崩。
 */
function normalize(parsed: any): { config: VisionConfig; skipped: string[] } {
  const passthrough = parsed.passthrough;
  const rawProviders =
    parsed.providers && typeof parsed.providers === "object" && !Array.isArray(parsed.providers)
      ? (parsed.providers as Record<string, unknown>)
      : {};

  const providers: Record<string, VisionProviderConfig> = {};
  const skipped: string[] = [];
  for (const [name, value] of Object.entries(rawProviders)) {
    if (isUsableProvider(value)) providers[name] = value;
    else skipped.push(name);
  }

  return {
    config: {
      current: typeof parsed.current === "string" ? parsed.current : undefined,
      passthrough:
        passthrough === "on" || passthrough === "off" || passthrough === "auto" ? passthrough : undefined,
      providers,
    },
    skipped,
  };
}

/**
 * 读取配置。文件不存在 → 空配置且无 error；文件存在但坏掉 → 空配置 + error 说明，
 * 由调用方决定是否提示用户（旧实现把两者都静默吞掉，用户会以为配置凭空丢了）。
 */
export function loadConfigResult(): LoadConfigResult {
  let raw: string;
  try {
    raw = readFileSync(CONFIG_PATH, "utf-8");
  } catch (err: any) {
    if (err?.code === "ENOENT") return { config: { providers: {} } };
    return { config: { providers: {} }, error: `读取配置失败 (${CONFIG_PATH}): ${err?.message ?? err}` };
  }
  try {
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return { config: { providers: {} }, error: `配置文件顶层不是对象 (${CONFIG_PATH})，本次按未配置处理` };
    }
    const { config, skipped } = normalize(parsed);
    if (skipped.length > 0) {
      return {
        config,
        error:
          `配置中有 ${skipped.length} 个模型条目格式非法、已被忽略: ${skipped.join(", ")}\n` +
          `每个模型至少需要 baseUrl 和 model 两个非空字符串。检查 ${CONFIG_PATH}`,
      };
    }
    return { config };
  } catch (err: any) {
    return {
      config: { providers: {} },
      error: `配置文件 JSON 解析失败 (${CONFIG_PATH}): ${err?.message ?? err}\n本次按未配置处理；下次写入前会自动备份为 vision-config.json.bak`,
    };
  }
}

export function loadConfig(): VisionConfig {
  return loadConfigResult().config;
}

export function saveConfig(cfg: VisionConfig) {
  mkdirSync(CONFIG_DIR, { recursive: true });
  // 现有文件损坏时先备份，避免直接覆盖掉用户手写的内容
  if (existsSync(CONFIG_PATH) && loadConfigResult().error) {
    try {
      copyFileSync(CONFIG_PATH, `${CONFIG_PATH}.bak`);
    } catch {
      // 备份失败不阻塞保存
    }
  }
  // 先写同目录临时文件再 rename：rename 在同一文件系统上是原子的，
  // 中途崩溃只会留下 .tmp，不会把配置截断成半截 JSON。
  // 顺带解决权限问题：新建的 tmp 一定是 0600，rename 后沿用，
  // 不依赖「mode 只在创建时生效」的 writeFileSync 行为。
  const tmpPath = `${CONFIG_PATH}.tmp`;
  try {
    writeFileSync(tmpPath, JSON.stringify(cfg, null, 2) + "\n", { mode: 0o600 });
    try {
      chmodSync(tmpPath, 0o600);
    } catch {
      // 某些文件系统不支持 chmod，忽略
    }
    renameSync(tmpPath, CONFIG_PATH);
  } catch (err) {
    try {
      unlinkSync(tmpPath);
    } catch {
      // 清理失败不掩盖原始错误
    }
    throw err;
  }
}

/** provider 名称合法性：非空且不含空格（子命令按空格分词） */
export function validateProviderName(name: string): string | undefined {
  const trimmed = name.trim();
  if (!trimmed) return "名称不能为空";
  if (/\s/.test(trimmed)) return "名称不能包含空格（/vision use 等子命令按空格分词，带空格的名字无法被选中）";
  return undefined;
}

/** 当前启用的 provider 名（未配置返回 undefined） */
export function getCurrentProviderName(cfg: VisionConfig): string | undefined {
  const name = cfg.current;
  if (name && cfg.providers[name]) return name;
  const keys = Object.keys(cfg.providers);
  return keys[0]; // 未指定时取第一个
}

/** 解析 apiKey，支持 $ENV_NAME 引用环境变量 */
export function resolveApiKey(apiKey: string | undefined): string | undefined {
  if (!apiKey) return undefined;
  const m = /^\$([A-Za-z_][A-Za-z0-9_]*)$/.exec(apiKey.trim());
  if (m) return process.env[m[1]] || undefined;
  return apiKey;
}

/** 密钥脱敏用于展示。`$ENV_NAME` 引用不是密钥本体，原样返回 */
export function maskSecret(secret: string | undefined): string | undefined {
  if (secret === undefined) return undefined;
  const trimmed = secret.trim();
  if (!trimmed) return trimmed;
  if (/^\$[A-Za-z_][A-Za-z0-9_]*$/.test(trimmed)) return trimmed;
  if (trimmed.length <= 8) return "********";
  return `${trimmed.slice(0, 4)}…${trimmed.slice(-4)}`;
}

/** 规范化 baseUrl：自动补 /chat/completions */
export function normalizeBaseUrl(baseUrl: string): string {
  let url = baseUrl.trim().replace(/\/+$/, "");
  if (!/\/chat\/completions$/.test(url)) {
    url += "/chat/completions";
  }
  return url;
}

/** 列出所有已配置的 provider 名 */
export function listProviders(cfg: VisionConfig): string[] {
  return Object.keys(cfg.providers);
}
