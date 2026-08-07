/**
 * pi-vlm-proxy —— 通用视觉代理扩展
 *
 * 让非多模态模型（DeepSeek 等）通过 describe_image 工具，把图片识别
 * 委托给任意 OpenAI 兼容的多模态模型。零厂商硬编码，全部由用户配置。
 *
 * 配置一个模型只需三样东西：API 地址、API Key、模型 ID。
 *
 * 配置方式：
 *   1. /vision 交互面板（顶部铺出列表 + 增删改查菜单）
 *   2. /vision list | add | edit | remove | use
 *   3. 直接编辑 ~/.pi/agent/vision-config.json
 */

import type {
  ExtensionAPI,
  ExtensionCommandContext,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import {
  type VisionConfig,
  type VisionProviderConfig,
  CONFIG_PATH,
  loadConfig,
  loadConfigResult,
  saveConfig,
  getCurrentProviderName,
  listProviders,
  maskSecret,
  validateProviderName,
} from "../src/config.ts";
import {
  callVision,
  resolveImageSource,
  buildPrompt,
  looksLikeScreenshot,
  VisionAbortError,
  type ImageSource,
} from "../src/vision.ts";

export default function (pi: ExtensionAPI) {
  // ================================================================
  // 能力感知：主模型是否支持视觉
  // ================================================================

  // 只依赖 input 字段，不绑定 pi 内部类型
  type AnyModel = { id?: string; input?: readonly string[] };

  const TOOL_NAME = "describe_image";

  const SUBCOMMANDS = ["list", "add", "edit", "remove", "use"];
  /** 第二个参数是模型名的子命令 */
  const NAME_TAKING = new Set(["edit", "remove", "use"]);

  function isMultimodal(model: AnyModel | undefined): boolean {
    return !!model && Array.isArray(model.input) && model.input.includes("image");
  }

  /** 解析最终透传模式：auto → 看主模型能力；on/off → 用户强制 */
  function resolvePassthrough(cfg: VisionConfig, model: AnyModel | undefined): boolean {
    const setting = cfg.passthrough ?? "auto";
    if (setting === "on") return true;
    if (setting === "off") return false;
    return isMultimodal(model);
  }

  /**
   * 根据当前主模型能力同步工具可见性：
   * - 多模态 → 隐藏 describe_image，图片由 pi 原生透传，零额外 API 调用
   * - text-only → 启用 describe_image 代理
   */
  function syncVisionMode(model: AnyModel | undefined, notify?: (msg: string) => void) {
    const cfg = loadConfig();
    const passthrough = resolvePassthrough(cfg, model);
    const active = pi.getActiveTools();
    const hasTool = active.includes(TOOL_NAME);
    if (passthrough && hasTool) {
      pi.setActiveTools(active.filter((t) => t !== TOOL_NAME));
      if (notify) notify(`主模型 ${model?.id ?? "?"} 支持视觉 → 已隐藏 ${TOOL_NAME}，图片原生透传`);
    } else if (!passthrough && !hasTool) {
      pi.setActiveTools([...active, TOOL_NAME]);
      if (notify) notify(`主模型 ${model?.id ?? "?"} 不支持视觉 → 已启用 ${TOOL_NAME} 代理识别`);
    }
    return passthrough;
  }

  // 模型切换时自动同步（/model、Ctrl+P、会话恢复都会触发）
  pi.on("model_select", (event, ctx) => {
    syncVisionMode(event.model, (msg) => ctx.ui.notify(msg, "info"));
  });

  // 启动 / 会话恢复时初始化
  pi.on("session_start", (_event, ctx) => {
    syncVisionMode(ctx.model);
  });

  // ================================================================
  // 内部工具函数
  // ================================================================

  function requireProvider(
    cfg: VisionConfig,
    name?: string
  ): { name: string; provider: VisionProviderConfig } | undefined {
    const target = name || getCurrentProviderName(cfg);
    if (!target || !cfg.providers[target]) return undefined;
    return { name: target, provider: cfg.providers[target] };
  }

  function describeProvider(name: string, cfg: VisionConfig): string {
    const p = cfg.providers[name];
    const current = getCurrentProviderName(cfg);
    const mark = name === current ? " ●" : "";
    return `${name}${mark}  (${p.model} @ ${p.baseUrl})`;
  }

  // ================================================================
  // 添加 / 编辑向导
  // ================================================================

  /** 用户按 ESC 取消 */
  const CANCELLED = Symbol("cancelled");
  /** 编辑模式下清除某个可选字段的输入标记 */
  const CLEAR_TOKEN = "-";

  type WizardResult =
    | { ok: true; name: string; provider: VisionProviderConfig }
    | { ok: false; message?: string; level?: "info" | "error" };

  /**
   * 询问一个必填字段。
   * - 新增模式（current 为 undefined）：留空 = 取消
   * - 编辑模式：留空 = 保持原值（ui.input 只有 placeholder、没有默认值，所以只能这样做）
   */
  async function promptRequired(
    ctx: ExtensionCommandContext,
    label: string,
    placeholder: string,
    current?: string
  ): Promise<string | typeof CANCELLED> {
    const suffix = current === undefined ? "" : `（当前: ${current}；留空 = 不变）`;
    const answer = await ctx.ui.input(`${label}${suffix}:`, placeholder);
    if (answer === undefined) return CANCELLED;
    const trimmed = answer.trim();
    if (!trimmed) return current === undefined ? CANCELLED : current;
    return trimmed;
  }

  /** apiKey 是可选字段，需要单独处理「留空」与「清除」的区别 */
  async function promptApiKey(
    ctx: ExtensionCommandContext,
    isEdit: boolean,
    current?: string
  ): Promise<string | undefined | typeof CANCELLED> {
    const suffix = isEdit
      ? `（当前: ${maskSecret(current) ?? "(未设置)"}；留空 = 不变，输入 ${CLEAR_TOKEN} = 清除）`
      : "（可填 $ENV_NAME 引用环境变量，避免明文；不需要可留空）";
    const answer = await ctx.ui.input(`API Key${suffix}:`, "sk-... 或 $MY_VISION_KEY");
    if (answer === undefined) return CANCELLED;
    const trimmed = answer.trim();
    if (!trimmed) return isEdit ? current : undefined;
    if (trimmed === CLEAR_TOKEN) return undefined;
    return trimmed;
  }

  /**
   * 添加 / 编辑向导。
   * 编辑模式下每个字段都会重新询问并展示当前值 —— 旧实现用 `initial?.x || await input(...)`
   * 短路掉了全部输入框，导致 /vision edit 只能原样存回、什么都改不了。
   */
  async function providerWizard(
    ctx: ExtensionCommandContext,
    existingNames: string[],
    initialName?: string,
    initial?: VisionProviderConfig
  ): Promise<WizardResult> {
    const isEdit = initial !== undefined;

    const name = await promptRequired(
      ctx,
      "模型名称（任意，如 doubao / gpt-4o / qwen-vl）",
      "例如: my-vision",
      initialName
    );
    if (name === CANCELLED) return { ok: false };
    const nameErr = validateProviderName(name);
    if (nameErr) return { ok: false, message: `名称无效: ${nameErr}` };

    // 重名会覆盖掉别人的地址与密钥，先确认 —— 且在这一步就问，
    // 而不是等用户白填完剩下三个字段
    if (name !== initialName && existingNames.includes(name)) {
      const ok = await ctx.ui.confirm(
        "名称已存在",
        `「${name}」已配置过，继续将覆盖它的地址、密钥和模型 ID。确定覆盖？`
      );
      if (!ok) {
        return {
          ok: false,
          message: `已取消，「${name}」保持不变。换个名字重试，或用 /vision edit ${name} 修改它`,
          level: "info",
        };
      }
    }

    const baseUrl = await promptRequired(
      ctx,
      "API 地址（完整路径，以 /responses 结尾走 Responses API，否则走 chat/completions）",
      "https://api.example.com/v1/chat/completions",
      initial?.baseUrl
    );
    if (baseUrl === CANCELLED) return { ok: false };

    const apiKey = await promptApiKey(ctx, isEdit, initial?.apiKey);
    if (apiKey === CANCELLED) return { ok: false };

    const model = await promptRequired(
      ctx,
      "模型 ID",
      "如 doubao-seed-2-1-turbo-260628",
      initial?.model
    );
    if (model === CANCELLED) return { ok: false };

    const provider: VisionProviderConfig = {
      baseUrl,
      ...(apiKey ? { apiKey } : {}),
      model,
      // headers / maxTokens / compress / maxDimension / jpegQuality 没有向导入口，编辑时原样保留（要改直接编辑配置文件）
      ...(initial?.headers ? { headers: initial.headers } : {}),
      ...(initial?.maxTokens ? { maxTokens: initial.maxTokens } : {}),
      ...(initial?.compress !== undefined ? { compress: initial.compress } : {}),
      ...(initial?.maxDimension ? { maxDimension: initial.maxDimension } : {}),
      ...(initial?.jpegQuality ? { jpegQuality: initial.jpegQuality } : {}),
    };

    return { ok: true, name: name.trim(), provider };
  }

  // ================================================================
  // /vision 命令
  // ================================================================

  async function visionHandler(args: string, ctx: ExtensionCommandContext, nested = false) {
    const trimmedArgs = (args || "").trim();
    // 注意：split 的 limit 是截断而非「剩余归尾」，这里手工切分，
    // 保证 arg 拿到第一个空格之后的完整内容
    const spaceAt = trimmedArgs.search(/\s/);
    const sub = spaceAt === -1 ? trimmedArgs : trimmedArgs.slice(0, spaceAt);
    const arg = spaceAt === -1 ? undefined : trimmedArgs.slice(spaceAt + 1).trim() || undefined;

    const loaded = loadConfigResult();
    // 配置损坏时明确告警，而不是静默当作「未配置」
    if (loaded.error && !nested) ctx.ui.notify(loaded.error, "error");
    const cfg = loaded.config;
    const names = listProviders(cfg);

    // ---------- 子命令 ----------
    if (sub === "list") {
      if (names.length === 0) {
        ctx.ui.notify("尚未配置任何视觉模型，运行 /vision add 添加", "warning");
        return;
      }
      const current = getCurrentProviderName(cfg);
      ctx.ui.notify(
        `视觉模型列表 (${names.length}):\n` +
          names.map((n) => `  ${n === current ? "● " : "  "}${describeProvider(n, cfg)}`).join("\n"),
        "info"
      );
      return;
    }

    if (sub === "add") {
      const result = await providerWizard(ctx, names);
      if (!result.ok) {
        if (result.message) ctx.ui.notify(result.message, result.level ?? "error");
        return;
      }
      const cfg2 = loadConfig();
      const overwriting = !!cfg2.providers[result.name];
      cfg2.providers[result.name] = result.provider;
      if (!cfg2.current) cfg2.current = result.name;
      saveConfig(cfg2);
      ctx.ui.notify(
        `${overwriting ? "已覆盖" : "已添加"}视觉模型「${result.name}」(${result.provider.model}) ✅`,
        "info"
      );
      return;
    }

    if (sub === "use") {
      const target = arg || (await ctx.ui.select("选择要使用的视觉模型:", names));
      if (!target || !cfg.providers[target]) {
        ctx.ui.notify(target ? `未找到模型「${target}」` : "已取消", target ? "error" : "info");
        return;
      }
      // 与其它分支一致：重新读盘再写，避免覆盖交互期间的外部改动
      const cfg2 = loadConfig();
      if (!cfg2.providers[target]) {
        ctx.ui.notify(`模型「${target}」已不存在`, "error");
        return;
      }
      cfg2.current = target;
      saveConfig(cfg2);
      ctx.ui.notify(`当前视觉模型: ${target} ✅`, "info");
      return;
    }

    if (sub === "edit") {
      const target = arg || (await ctx.ui.select("选择要编辑的模型:", names));
      if (!target || !cfg.providers[target]) {
        ctx.ui.notify(target ? `未找到模型「${target}」` : "已取消", target ? "error" : "info");
        return;
      }
      const result = await providerWizard(ctx, names, target, cfg.providers[target]);
      if (!result.ok) {
        if (result.message) ctx.ui.notify(result.message, result.level ?? "error");
        return;
      }
      const cfg2 = loadConfig();
      cfg2.providers[result.name] = result.provider;
      if (result.name !== target) {
        delete cfg2.providers[target];
        // 重命名时同步 current，否则它会指向已删除的名字，
        // 之后被静默 fallback 到「第一个 provider」，当前模型悄悄变掉
        if (cfg2.current === target) cfg2.current = result.name;
      }
      saveConfig(cfg2);
      ctx.ui.notify(
        result.name !== target
          ? `已更新并重命名为「${result.name}」✅`
          : `已更新视觉模型「${result.name}」✅`,
        "info"
      );
      return;
    }

    if (sub === "remove") {
      const target = arg || (await ctx.ui.select("选择要删除的模型:", names));
      if (!target || !cfg.providers[target]) {
        ctx.ui.notify(target ? `未找到模型「${target}」` : "已取消", target ? "error" : "info");
        return;
      }
      const ok = await ctx.ui.confirm("删除确认", `确定删除视觉模型「${target}」？`);
      if (!ok) return;
      const cfg2 = loadConfig();
      delete cfg2.providers[target];
      if (cfg2.current === target) cfg2.current = undefined;
      saveConfig(cfg2);
      ctx.ui.notify(`已删除「${target}」✅`, "info");
      return;
    }

    if (sub && sub !== "") {
      ctx.ui.notify(`未知子命令「${sub}」，可用: ${SUBCOMMANDS.join(" | ")}`, "error");
      return;
    }

    // ---------- 无参数：交互面板 ----------
    const current = getCurrentProviderName(cfg);
    // 透传状态只展示不可点：它由主模型能力自动决定，没有对应的操作项
    const status = resolvePassthrough(cfg, ctx.model)
      ? `⚙️ 主模型 ${ctx.model?.id ?? "?"} 支持视觉 → 图片直发主模型，${TOOL_NAME} 已隐藏`
      : `⚙️ 主模型 ${ctx.model?.id ?? "?"} 不支持视觉 → 由 ${TOOL_NAME} 委托下面的模型识别`;

    // 列表直接铺在标题里，省掉一次「进列表再退出来」的往返
    const list =
      names.length > 0
        ? names.map((n) => `  ${n === current ? "●" : " "} ${describeProvider(n, cfg)}`).join("\n")
        : "  (未配置任何视觉模型)";

    const title = `Vision 设置面板\n${status}\n\n📋 视觉模型 (${names.length}):\n${list}`;
    const menu = [
      ...(names.length > 0 ? ["1. 切换当前模型 (use)"] : []),
      "2. 添加模型 (add)",
      ...(names.length > 0 ? ["3. 编辑模型 (edit)", "4. 删除模型 (remove)"] : []),
      "0. 退出",
    ];
    const picked = await ctx.ui.select(title, menu);
    if (!picked || picked.startsWith("0.")) return;

    // 重新触发对应子命令
    const action = picked.split(" ")[0].replace(".", "");
    const subMap: Record<string, string> = {
      "1": "use",
      "2": "add",
      "3": "edit",
      "4": "remove",
    };
    const subCmd = subMap[action];
    if (subCmd) {
      await visionHandler(subCmd, ctx, true);
    }
  }

  pi.registerCommand("vision", {
    description: "视觉代理配置：面板 /vision，或子命令 list|add|edit|remove|use",
    // prefix 是 "/vision " 之后的**全部**文本，且补全项的 value 会整体替换它，
    // 所以第二段补全必须回填 "<子命令> <值>"，不能只回值
    getArgumentCompletions: (prefix) => {
      const spaceAt = prefix.search(/\s/);

      // 第一段：补子命令
      if (spaceAt === -1) {
        const items = SUBCOMMANDS.filter((s) => s.startsWith(prefix)).map((v) => ({
          value: v,
          label: v,
        }));
        return items.length > 0 ? items : null;
      }

      // 第二段：只有接受模型名的子命令才补
      const sub = prefix.slice(0, spaceAt);
      const rest = prefix.slice(spaceAt + 1).trimStart();
      if (!NAME_TAKING.has(sub)) return null;

      const cfg = loadConfig();
      const items = listProviders(cfg)
        .filter((n) => n.startsWith(rest))
        .map((n) => ({
          value: `${sub} ${n}`,
          label: n,
          description: `${cfg.providers[n].model} @ ${cfg.providers[n].baseUrl}`,
        }));
      return items.length > 0 ? items : null;
    },
    handler: async (args, ctx) => {
      await visionHandler(args || "", ctx);
    },
  });

  // ================================================================
  // describe_image 工具（LLM 调用）
  // ================================================================

  pi.registerTool({
    name: TOOL_NAME,
    label: "Describe Image",
    description:
      "调用视觉模型识别图片内容，返回详细文字描述（适用于当前主模型不支持视觉的情况；主模型支持视觉时会自动隐藏本工具）。" +
      "两种用法二选一：" +
      "① path=本地图片路径；" +
      "② data=图片 base64（可带 data:image/...;base64, 前缀）+ 可选 mimeType。" +
      "聊天里粘贴的截图若当前模型不支持视觉，优先用 data；磁盘上的图用 path。",
    promptSnippet: "调用视觉模型识别图片（支持文件路径或 base64）",
    parameters: Type.Object({
      path: Type.Optional(
        Type.String({
          description: "本地图片路径，如 /path/to/screenshot.png。与 data 二选一。",
        })
      ),
      data: Type.Optional(
        Type.String({
          description:
            "图片 base64。可只传裸 base64，或完整 data URL（data:image/png;base64,...）。与 path 二选一。",
        })
      ),
      mimeType: Type.Optional(
        Type.String({
          description: "MIME 类型，如 image/png、image/jpeg。使用裸 base64 时建议提供，默认 image/png。",
        })
      ),
      compress: Type.Optional(
        Type.Boolean({
          description:
            "是否压缩图片后再发送（需安装 sharp）。true=缩小到最长边 1568px、去 alpha、转 JPEG，payload 约减 4x；" +
            "false=原图直发，用于需要像素级精度的场景（坐标、小字、色值）。省略时用 provider 配置的 compress（默认 true）。",
        })
      ),
    }),

    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      try {
        const loaded = loadConfigResult();
        if (loaded.error) {
          return {
            isError: true,
            content: [{ type: "text", text: `视觉配置无法读取: ${loaded.error}` }],
            details: { error: loaded.error },
          };
        }
        const found = requireProvider(loaded.config);
        if (!found) {
          return {
            isError: true,
            content: [
              {
                type: "text",
                text: `未配置视觉模型。请运行 /vision add 添加（模型名 + API 地址 + API Key + 模型 ID），或直接编辑 ${CONFIG_PATH}`,
              },
            ],
            details: { error: "no provider configured" },
          };
        }

        const source: ImageSource = resolveImageSource({
          path: params.path,
          data: params.data,
          mimeType: params.mimeType,
        });

        const description = await callVision(
          found.provider,
          source,
          buildPrompt(looksLikeScreenshot(source)),
          signal ?? ctx.signal,
          params.compress
        );
        return {
          content: [{ type: "text", text: description }],
          details: {
            provider: found.name,
            model: found.provider.model,
            source: source.kind,
            path: source.kind === "path" ? source.path : undefined,
          },
        };
      } catch (err: any) {
        // 用户主动取消不是失败，不该以 isError 污染对话历史
        if (err instanceof VisionAbortError) {
          return {
            content: [{ type: "text", text: "图片识别已取消。" }],
            details: { cancelled: true },
          };
        }
        return {
          isError: true,
          content: [{ type: "text", text: `识别失败: ${err.message}` }],
          details: { error: err.message },
        };
      }
    },
  });
}
