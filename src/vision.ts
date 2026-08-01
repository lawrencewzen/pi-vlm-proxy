/**
 * 通用 OpenAI 兼容视觉调用
 * 任何支持 image_url 的 /chat/completions 端点都可直接用：
 * 火山引擎 Ark、阶跃 StepFun、OpenAI、DeepSeek VL、通义 Qwen-VL、
 * OpenRouter、本地 vLLM / Ollama / llama.cpp 等
 */

import { readFileSync, statSync } from "node:fs";
import { extname, basename } from "node:path";
import {
  type VisionProviderConfig,
  resolveApiKey,
  normalizeBaseUrl,
} from "./config.ts";

const IMAGE_EXTS = new Set([".png", ".jpg", ".jpeg", ".gif", ".webp", ".bmp"]);
const MIME_FROM_EXT: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".bmp": "image/bmp",
};
const EXT_FROM_MIME: Record<string, string> = {
  "image/png": ".png",
  "image/jpeg": ".jpg",
  "image/jpg": ".jpg",
  "image/gif": ".gif",
  "image/webp": ".webp",
  "image/bmp": ".bmp",
};

/** 图片体积上限：base64 后约 1.34 倍，再整体塞进 JSON body，需要留出内存余量 */
export const MAX_IMAGE_BYTES = 10 * 1024 * 1024;

/** 单次视觉请求的默认超时。ctx.signal 在 agent 空闲时为 undefined，不能只依赖它 */
export const REQUEST_TIMEOUT_MS = 120_000;

/** 用户主动取消（区别于真正的失败，调用方不该把它当错误汇报） */
export class VisionAbortError extends Error {
  constructor(message = "已取消") {
    super(message);
    this.name = "VisionAbortError";
  }
}

export type ImageSource =
  | { kind: "path"; path: string }
  | { kind: "base64"; data: string; mimeType: string; label?: string };

/** 去掉 `data:image/...;base64,` 前缀；返回 { data, mimeType? } */
export function parseBase64Input(raw: string, mimeHint?: string): { data: string; mimeType: string } {
  const trimmed = raw.trim();
  const m = /^data:([^;]+);base64,(.+)$/is.exec(trimmed);
  if (m) {
    return { data: m[2].replace(/\s+/g, ""), mimeType: mimeHint || m[1] || "image/png" };
  }
  return { data: trimmed.replace(/\s+/g, ""), mimeType: mimeHint || "image/png" };
}

/** 统一入参：path 或 data(+mimeType)，二选一 */
export function resolveImageSource(params: {
  path?: string;
  data?: string;
  mimeType?: string;
}): ImageSource {
  const path = params.path?.trim();
  const data = params.data?.trim();

  if (path && data) throw new Error("path 与 data 只能传其中一个");
  if (!path && !data) throw new Error("需要提供 path（本地路径）或 data（base64）");

  if (path && /^data:image\//i.test(path)) {
    const parsed = parseBase64Input(path);
    return { kind: "base64", data: parsed.data, mimeType: parsed.mimeType, label: "data-url" };
  }
  if (path) return { kind: "path", path };
  const parsed = parseBase64Input(data!, params.mimeType);
  if (!parsed.data) throw new Error("data 为空");
  return { kind: "base64", data: parsed.data, mimeType: parsed.mimeType, label: "base64" };
}

/** 按文件头识别真实图片类型，识别不出返回 undefined */
function sniffMime(buf: Buffer): string | undefined {
  if (buf.length >= 8 && buf.readUInt32BE(0) === 0x89504e47) return "image/png";
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return "image/jpeg";
  if (buf.length >= 6 && buf.toString("ascii", 0, 4) === "GIF8") return "image/gif";
  if (buf.length >= 12 && buf.toString("ascii", 0, 4) === "RIFF" && buf.toString("ascii", 8, 12) === "WEBP") {
    return "image/webp";
  }
  if (buf.length >= 2 && buf[0] === 0x42 && buf[1] === 0x4d) return "image/bmp";
  return undefined;
}

function formatMB(bytes: number): string {
  return `${(bytes / 1024 / 1024).toFixed(1)}MB`;
}

function loadImageBytes(source: ImageSource): { base64: string; mimeType: string; label: string } {
  if (source.kind === "path") {
    const ext = extname(source.path).toLowerCase();
    if (!IMAGE_EXTS.has(ext)) throw new Error(`不支持的文件格式: ${ext || "(无扩展名)"}`);

    let stat;
    try {
      stat = statSync(source.path);
    } catch (err: any) {
      throw new Error(`无法读取文件 ${source.path}: ${err?.message ?? err}`);
    }
    if (!stat.isFile()) throw new Error(`不是普通文件: ${source.path}`);
    if (stat.size === 0) throw new Error(`文件为空: ${source.path}`);
    if (stat.size > MAX_IMAGE_BYTES) {
      throw new Error(
        `图片过大 (${formatMB(stat.size)})，上限 ${formatMB(MAX_IMAGE_BYTES)}。请先压缩或裁剪后再识别。`
      );
    }

    const buffer = readFileSync(source.path);
    // 扩展名可能骗人（.png 里装的是 JPEG），以文件头为准
    const mimeType = sniffMime(buffer) || MIME_FROM_EXT[ext] || "image/png";
    return { base64: buffer.toString("base64"), mimeType, label: basename(source.path) };
  }

  const mime = source.mimeType.toLowerCase();
  if (!mime.startsWith("image/")) throw new Error(`不支持的 mimeType: ${source.mimeType}`);
  if (source.data.length < 32) throw new Error("base64 数据过短，不像有效图片");
  const approxBytes = Math.floor((source.data.length * 3) / 4);
  if (approxBytes > MAX_IMAGE_BYTES) {
    throw new Error(
      `图片过大 (约 ${formatMB(approxBytes)})，上限 ${formatMB(MAX_IMAGE_BYTES)}。请先压缩后再识别。`
    );
  }
  const ext = EXT_FROM_MIME[mime] || ".png";
  return {
    base64: source.data,
    mimeType: mime === "image/jpg" ? "image/jpeg" : mime,
    label: source.label || `image${ext}`,
  };
}

/** 组装请求头：仅当自定义 headers 里没有 authorization 时才补默认 Bearer */
function buildHeaders(provider: VisionProviderConfig): Record<string, string> {
  const custom = provider.headers ?? {};
  const hasAuthHeader = Object.keys(custom).some((k) => k.toLowerCase() === "authorization");
  const apiKey = resolveApiKey(provider.apiKey);
  return {
    "Content-Type": "application/json",
    ...custom,
    ...(apiKey && !hasAuthHeader ? { Authorization: `Bearer ${apiKey}` } : {}),
  };
}

/** 合并调用方 signal 与本地超时；调用方未传时仍然有超时兜底 */
function withTimeout(signal: AbortSignal | undefined, ms: number): AbortSignal {
  const timeout = AbortSignal.timeout(ms);
  return signal ? AbortSignal.any([signal, timeout]) : timeout;
}

/**
 * 从 OpenAI 兼容响应里取正文。
 * content 可能是字符串，也可能是分片数组（部分网关/国内端点如此），
 * 少数推理模型只填 reasoning_content。
 */
function extractText(message: any): string {
  if (!message || typeof message !== "object") return "";
  const content = message.content;
  if (typeof content === "string" && content.trim()) return content;
  if (Array.isArray(content)) {
    const joined = content
      .map((part: any) => {
        if (typeof part === "string") return part;
        if (part && typeof part.text === "string") return part.text;
        return "";
      })
      .filter(Boolean)
      .join("");
    if (joined.trim()) return joined;
  }
  if (typeof message.reasoning_content === "string" && message.reasoning_content.trim()) {
    return message.reasoning_content;
  }
  return "";
}

/**
 * 调用任意 OpenAI 兼容的多模态端点识别图片
 * @returns 视觉模型返回的文字描述
 */
export async function callVision(
  provider: VisionProviderConfig,
  source: ImageSource,
  prompt: string,
  signal?: AbortSignal
): Promise<string> {
  const { base64, mimeType, label } = loadImageBytes(source);
  const url = normalizeBaseUrl(provider.baseUrl);

  let response: Response;
  try {
    response = await fetch(url, {
      method: "POST",
      headers: buildHeaders(provider),
      body: JSON.stringify({
        model: provider.model,
        max_tokens: provider.maxTokens ?? 4096,
        messages: [
          {
            role: "user",
            content: [
              { type: "image_url", image_url: { url: `data:${mimeType};base64,${base64}` } },
              { type: "text", text: prompt },
            ],
          },
        ],
      }),
      signal: withTimeout(signal, REQUEST_TIMEOUT_MS),
    });
  } catch (err: any) {
    if (err?.name === "TimeoutError") {
      throw new Error(`请求超时（${REQUEST_TIMEOUT_MS / 1000}s）: ${url}`);
    }
    if (err?.name === "AbortError") throw new VisionAbortError();
    throw new Error(`请求失败 (${url}): ${err?.message ?? err}`);
  }

  if (!response.ok) {
    const err = await response.text().catch(() => "");
    throw new Error(`API ${response.status}: ${err.slice(0, 300)}`);
  }

  const data = (await response.json().catch(() => null)) as any;
  const choice = data?.choices?.[0];
  const text = extractText(choice?.message);
  if (!text) {
    const hint = data?.error?.message ? `: ${String(data.error.message).slice(0, 200)}` : "";
    throw new Error(`API 未返回内容${hint}`);
  }

  const maxTokens = provider.maxTokens ?? 4096;
  // 被 max_tokens 截断时必须说明，否则「描述不全」会被当成模型能力问题
  const truncated =
    choice?.finish_reason === "length" || choice?.finish_reason === "max_tokens"
      ? `\n⚠️ 输出已被 maxTokens (${maxTokens}) 截断，以上描述可能不完整。可在配置里调大 maxTokens 后重试。`
      : "";

  return (
    `[${label}]\n${text}\n` +
    `[模型: ${provider.model}, tokens: ${data.usage?.total_tokens ?? "?"}]${truncated}`
  );
}

const SCREENSHOT_HINT = /(screen[ _-]?shot|screen[ _-]?capture|cleanshot|snip|截图|截屏)/i;

/**
 * 判断是否更可能是截图（决定用哪套提示词）。
 * 聊天里粘贴的 base64 几乎都是截图；磁盘文件看文件名线索。
 */
export function looksLikeScreenshot(source: ImageSource): boolean {
  if (source.kind === "base64") return true;
  return SCREENSHOT_HINT.test(basename(source.path));
}

/** 常用识别提示词 */
export function buildPrompt(isScreenshotLikely: boolean): string {
  return isScreenshotLikely
    ? "详细描述这张截图/图片的全部内容。逐字转述所有可见文字、代码、命令、菜单、按钮、数字、图表。包括颜色、布局、位置关系。直接用中文描述。"
    : "详细描述这张图片的全部内容。直接用中文描述。";
}
