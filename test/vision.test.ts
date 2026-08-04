/**
 * 视觉调用：鉴权头、超时、响应形态、体积上限、类型嗅探。
 * 用本地 http server 当假端点，不触碰真实网络。
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const HOME = mkdtempSync(join(tmpdir(), "pi-vision-net-"));
process.env.HOME = HOME;

const {
  callVision,
  resolveImageSource,
  parseBase64Input,
  looksLikeScreenshot,
  buildPrompt,
  VisionAbortError,
  MAX_IMAGE_BYTES,
} = await import("../src/vision.ts");
const { generateTestPngBase64 } = await import("./test-image.ts");

type Mode = "string" | "array" | "reasoning" | "empty" | "truncated" | "error500" | "hang" | "resp";
let mode: Mode = "string";
let lastHeaders: Record<string, string> = {};
let lastBody: any = null;
let server: Server;
let baseUrl = "";

const png = { kind: "base64" as const, data: generateTestPngBase64(), mimeType: "image/png", label: "t.png" };

before(async () => {
  server = createServer((req, res) => {
    lastHeaders = req.headers as any;
    if (mode === "hang") return; // 永不响应
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      lastBody = JSON.parse(raw);
      if (mode === "error500") {
        res.writeHead(500, { "Content-Type": "text/plain" });
        res.end("upstream exploded");
        return;
      }
      const payloads: Record<string, unknown> = {
        string: { choices: [{ message: { content: "字符串正文" }, finish_reason: "stop" }], usage: { total_tokens: 42 } },
        array: { choices: [{ message: { content: [{ type: "text", text: "数组分片正文" }] } }] },
        reasoning: { choices: [{ message: { content: "", reasoning_content: "推理字段正文" } }] },
        empty: { choices: [{ message: { content: "" } }], error: { message: "上游说没内容" } },
        truncated: { choices: [{ message: { content: "被截断的正文" }, finish_reason: "length" }] },
        resp: {
          output: [
            { type: "reasoning", summary: [] },
            { type: "message", status: "completed", content: [{ type: "output_text", text: "Responses 协议正文" }] },
          ],
          usage: { total_tokens: 7 },
        },
      };
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(payloads[mode]));
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  baseUrl = `http://127.0.0.1:${(server.address() as any).port}/v1`;
});

after(() => server.close());

test("配了自定义 header 时 Authorization 仍然发送", async () => {
  mode = "string";
  await callVision({ baseUrl, apiKey: "sk-secret", model: "m", headers: { "x-custom": "v" } }, png, "p");
  assert.equal(lastHeaders["authorization"], "Bearer sk-secret");
  assert.equal(lastHeaders["x-custom"], "v");
});

test("自定义 Authorization 优先于默认 Bearer（大小写不敏感）", async () => {
  await callVision({ baseUrl, apiKey: "sk-secret", model: "m", headers: { authorization: "Custom xyz" } }, png, "p");
  assert.equal(lastHeaders["authorization"], "Custom xyz");
});

test("未配 apiKey 时不发 Authorization", async () => {
  await callVision({ baseUrl, model: "m" }, png, "p");
  assert.equal(lastHeaders["authorization"], undefined);
});

test("apiKey 支持 $ENV_NAME", async () => {
  process.env.PI_VISION_NET_KEY = "sk-env-value";
  await callVision({ baseUrl, apiKey: "$PI_VISION_NET_KEY", model: "m" }, png, "p");
  assert.equal(lastHeaders["authorization"], "Bearer sk-env-value");
});

test("请求体形状：model / max_tokens / image_url + text", async () => {
  await callVision({ baseUrl, model: "the-model", maxTokens: 123 }, png, "看看这个");
  assert.equal(lastBody.model, "the-model");
  assert.equal(lastBody.max_tokens, 123);
  const parts = lastBody.messages[0].content;
  assert.equal(parts[0].type, "image_url");
  assert.match(parts[0].image_url.url, /^data:image\/png;base64,/);
  assert.equal(parts[1].text, "看看这个");
});

test("responses 协议：input + input_image/input_text + max_output_tokens", async () => {
  mode = "resp";
  const respBaseUrl = `http://127.0.0.1:${(server.address() as any).port}/v1/responses`;
  await callVision({ baseUrl: respBaseUrl, model: "the-model", maxTokens: 123 }, png, "看看这个");
  assert.equal(lastBody.model, "the-model");
  assert.equal(lastBody.max_output_tokens, 123);
  assert.equal(lastBody.max_tokens, undefined);
  const parts = lastBody.input[0].content;
  assert.equal(parts[0].type, "input_image");
  assert.match(parts[0].image_url, /^data:image\/png;base64,/);
  assert.equal(parts[1].type, "input_text");
  assert.equal(parts[1].text, "看看这个");
});

test("responses 协议：从 output[].message.content 提取正文", async () => {
  mode = "resp";
  const respBaseUrl = `http://127.0.0.1:${(server.address() as any).port}/v1/responses`;
  const out = await callVision({ baseUrl: respBaseUrl, model: "m" }, png, "p");
  assert.match(out, /Responses 协议正文/);
  assert.match(out, /tokens: 7/);
});

test("content 为字符串 / 数组分片 / 仅 reasoning_content 都能提取", async () => {
  mode = "string";
  assert.match(await callVision({ baseUrl, model: "m" }, png, "p"), /字符串正文/);
  mode = "array";
  assert.match(await callVision({ baseUrl, model: "m" }, png, "p"), /数组分片正文/);
  mode = "reasoning";
  assert.match(await callVision({ baseUrl, model: "m" }, png, "p"), /推理字段正文/);
});

test("无内容时带上上游 error.message", async () => {
  mode = "empty";
  await assert.rejects(() => callVision({ baseUrl, model: "m" }, png, "p"), /上游说没内容/);
});

test("finish_reason=length 时提示被截断", async () => {
  mode = "truncated";
  const out = await callVision({ baseUrl, model: "m", maxTokens: 16 }, png, "p");
  assert.match(out, /被截断/);
  assert.match(out, /16/);
});

test("非 2xx 带上状态码与响应片段", async () => {
  mode = "error500";
  await assert.rejects(() => callVision({ baseUrl, model: "m" }, png, "p"), /API 500.*upstream exploded/s);
});

test("挂起请求会被超时中断，不会无限等待", async () => {
  mode = "hang";
  const t0 = Date.now();
  await assert.rejects(
    () => callVision({ baseUrl, model: "m" }, png, "p", AbortSignal.timeout(600)),
    (err: Error) => err instanceof VisionAbortError || /超时/.test(err.message),
  );
  assert.ok(Date.now() - t0 < 5000);
});

test("外部 signal 取消 → VisionAbortError（可与真失败区分）", async () => {
  mode = "hang";
  const ac = new AbortController();
  setTimeout(() => ac.abort(), 100);
  await assert.rejects(() => callVision({ baseUrl, model: "m" }, png, "p", ac.signal), VisionAbortError);
});

test("连不上的地址给出可读错误", async () => {
  await assert.rejects(
    () => callVision({ baseUrl: "http://127.0.0.1:1/v1", model: "m" }, png, "p"),
    /请求失败/,
  );
});

test("resolveImageSource 参数互斥与 data URL 解析", () => {
  assert.throws(() => resolveImageSource({ path: "a.png", data: "x" }), /只能传其中一个/);
  assert.throws(() => resolveImageSource({}), /需要提供/);
  assert.deepEqual(resolveImageSource({ path: "/a/b.png" }), { kind: "path", path: "/a/b.png" });
  const fromDataUrl = resolveImageSource({ path: "data:image/jpeg;base64,AAAA" });
  assert.equal(fromDataUrl.kind, "base64");
  assert.equal((fromDataUrl as any).mimeType, "image/jpeg");
});

test("parseBase64Input 去前缀去空白", () => {
  assert.deepEqual(parseBase64Input("data:image/gif;base64,AA BB\nCC"), { data: "AABBCC", mimeType: "image/gif" });
  assert.deepEqual(parseBase64Input("AABB"), { data: "AABB", mimeType: "image/png" });
  assert.equal(parseBase64Input("AABB", "image/webp").mimeType, "image/webp");
});

test("超大 base64 被拒（不会撑爆内存）", async () => {
  const huge = { kind: "base64" as const, data: "A".repeat(MAX_IMAGE_BYTES * 2), mimeType: "image/png" };
  await assert.rejects(() => callVision({ baseUrl, model: "m" }, huge, "p"), /图片过大/);
});

test("超大文件被拒", async () => {
  const big = join(HOME, "big.png");
  writeFileSync(big, Buffer.alloc(MAX_IMAGE_BYTES + 1024));
  await assert.rejects(() => callVision({ baseUrl, model: "m" }, { kind: "path", path: big }, "p"), /图片过大/);
});

test("目录 / 不存在 / 空文件 / 非图片扩展名 都被明确拒绝", async () => {
  const p = (path: string) => ({ kind: "path" as const, path });
  await assert.rejects(() => callVision({ baseUrl, model: "m" }, p(join(HOME, "nope.png")), "x"), /无法读取文件/);
  await assert.rejects(() => callVision({ baseUrl, model: "m" }, p(HOME), "x"), /不支持的文件格式/);
  writeFileSync(join(HOME, "empty.png"), "");
  await assert.rejects(() => callVision({ baseUrl, model: "m" }, p(join(HOME, "empty.png")), "x"), /文件为空/);
  writeFileSync(join(HOME, "a.txt"), "hi");
  await assert.rejects(() => callVision({ baseUrl, model: "m" }, p(join(HOME, "a.txt")), "x"), /不支持的文件格式/);
});

test("扩展名骗人时以文件头为准（.png 里装 JPEG → 发 image/jpeg）", async () => {
  mode = "string";
  const liar = join(HOME, "liar.png");
  writeFileSync(liar, Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(64)]));
  await callVision({ baseUrl, model: "m" }, { kind: "path", path: liar }, "p");
  assert.match(lastBody.messages[0].content[0].image_url.url, /^data:image\/jpeg;base64,/);
});

test("真 PNG 正常识别为 image/png，label 用文件名", async () => {
  const real = join(HOME, "real.png");
  writeFileSync(real, Buffer.from(generateTestPngBase64(), "base64"));
  const out = await callVision({ baseUrl, model: "m" }, { kind: "path", path: real }, "p");
  assert.match(lastBody.messages[0].content[0].image_url.url, /^data:image\/png;base64,/);
  assert.match(out, /\[real\.png\]/);
});

test("压缩：sharp 未安装时退化原始字节，不报错", async () => {
  // 测试环境不装 sharp，走 fallback：compress 请求与不压缩结果一致，且请求体仍是原格式
  const real = join(HOME, "compress.png");
  writeFileSync(real, Buffer.from(generateTestPngBase64(), "base64"));
  await callVision({ baseUrl, model: "m" }, { kind: "path", path: real }, "p", undefined, true);
  assert.match(lastBody.messages[0].content[0].image_url.url, /^data:image\/png;base64,/);
});

test("压缩：compress=false 时强制直发原始字节", async () => {
  await callVision({ baseUrl, model: "m" }, png, "p", undefined, false);
  assert.match(lastBody.messages[0].content[0].image_url.url, /^data:image\/png;base64,/);
});

test("截图启发式：粘贴的 base64 与带线索的文件名算截图，普通照片不算", () => {
  assert.equal(looksLikeScreenshot({ kind: "base64", data: "x", mimeType: "image/png" }), true);
  assert.equal(looksLikeScreenshot({ kind: "path", path: "/a/Screenshot 2026-01-01.png" }), true);
  assert.equal(looksLikeScreenshot({ kind: "path", path: "/a/CleanShot.png" }), true);
  assert.equal(looksLikeScreenshot({ kind: "path", path: "/a/截图 1.png" }), true);
  assert.equal(looksLikeScreenshot({ kind: "path", path: "/a/IMG_1234.jpg" }), false);
  assert.notEqual(buildPrompt(true), buildPrompt(false));
});
