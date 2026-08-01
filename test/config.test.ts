/**
 * 配置读写 / 校验 / 脱敏。
 * CONFIG_PATH 在模块加载时由 homedir() 算出，所以必须在 import 之前隔离 HOME，
 * 否则测试会写到用户真实的 ~/.pi/agent/vision-config.json。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, readFileSync, existsSync, statSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const HOME = mkdtempSync(join(tmpdir(), "pi-vision-config-"));
process.env.HOME = HOME;

const {
  CONFIG_PATH,
  loadConfig,
  loadConfigResult,
  saveConfig,
  getCurrentProviderName,
  listProviders,
  resolveApiKey,
  normalizeBaseUrl,
  maskSecret,
  redactConfig,
  validateConfig,
  validateProviderName,
} = await import("../src/config.ts");

assert.ok(CONFIG_PATH.startsWith(HOME), "HOME 未隔离，拒绝运行测试");
mkdirSync(join(HOME, ".pi", "agent"), { recursive: true });

const write = (raw: string) => writeFileSync(CONFIG_PATH, raw);
const read = () => JSON.parse(readFileSync(CONFIG_PATH, "utf-8"));
const ok = { baseUrl: "https://x/v1", model: "m" };

test("文件不存在 → 空配置且不报错", () => {
  const r = loadConfigResult();
  assert.equal(r.error, undefined);
  assert.deepEqual(r.config.providers, {});
});

test("JSON 语法错误 → 明确告警，而不是静默当作未配置", () => {
  write("{ 坏掉的 json ");
  const r = loadConfigResult();
  assert.match(r.error ?? "", /解析失败/);
  assert.deepEqual(r.config.providers, {});
});

test("非法 provider 条目被过滤并告警，合法的保留", () => {
  write(JSON.stringify({ current: "a", providers: { a: null, b: 123, c: { model: "m" }, good: ok } }));
  const r = loadConfigResult();
  assert.match(r.error ?? "", /3 个模型条目格式非法/);
  assert.deepEqual(Object.keys(r.config.providers), ["good"]);
});

test("provider 为 null 时不再打崩调用方", () => {
  write(JSON.stringify({ current: "a", providers: { a: null } }));
  const cfg = loadConfig();
  assert.equal(getCurrentProviderName(cfg), undefined);
  assert.deepEqual(listProviders(cfg), []);
});

test("passthrough 非法值被忽略", () => {
  write(JSON.stringify({ passthrough: "maybe", providers: {} }));
  assert.equal(loadConfig().passthrough, undefined);
});

test("保存后权限收紧为 600（即使原文件是 644）", () => {
  write(JSON.stringify({ providers: {} }));
  assert.doesNotThrow(() => statSync(CONFIG_PATH));
  saveConfig({ providers: { a: ok } });
  assert.equal(statSync(CONFIG_PATH).mode & 0o777, 0o600);
});

test("原子写：保存后不留 .tmp 残留，内容是完整 JSON", () => {
  saveConfig({ current: "a", providers: { a: ok } });
  assert.equal(existsSync(`${CONFIG_PATH}.tmp`), false, "残留了 .tmp");
  assert.deepEqual(read(), { current: "a", providers: { a: ok } });
});

test("覆盖损坏文件前自动备份 .bak", () => {
  write("{ 完全坏掉 ");
  saveConfig({ providers: { a: ok } });
  assert.ok(existsSync(`${CONFIG_PATH}.bak`), "未备份");
  assert.match(readFileSync(`${CONFIG_PATH}.bak`, "utf-8"), /完全坏掉/);
});

test("getCurrentProviderName：current 缺失时回落到第一个", () => {
  assert.equal(getCurrentProviderName({ providers: { a: ok, b: ok } }), "a");
  assert.equal(getCurrentProviderName({ current: "b", providers: { a: ok, b: ok } }), "b");
  assert.equal(getCurrentProviderName({ providers: {} }), undefined);
});

test("resolveApiKey 支持 $ENV_NAME", () => {
  process.env.PI_VISION_TEST_KEY = "sk-from-env";
  assert.equal(resolveApiKey("$PI_VISION_TEST_KEY"), "sk-from-env");
  assert.equal(resolveApiKey("sk-literal"), "sk-literal");
  assert.equal(resolveApiKey("$NOT_SET_ANYWHERE_12345"), undefined);
  assert.equal(resolveApiKey(undefined), undefined);
});

test("normalizeBaseUrl 自动补 /chat/completions 且不重复补", () => {
  assert.equal(normalizeBaseUrl("https://x/v1"), "https://x/v1/chat/completions");
  assert.equal(normalizeBaseUrl("https://x/v1///"), "https://x/v1/chat/completions");
  assert.equal(normalizeBaseUrl("  https://x/v1/chat/completions  "), "https://x/v1/chat/completions");
});

test("maskSecret 脱敏，但 $ENV 引用原样保留", () => {
  assert.equal(maskSecret("sk-abcdefghijklmn"), "sk-a…klmn");
  assert.equal(maskSecret("short"), "********");
  assert.equal(maskSecret("$MY_KEY"), "$MY_KEY");
  assert.equal(maskSecret(undefined), undefined);
});

test("redactConfig 处理 apiKey 与疑似密钥 header，普通 header 不动", () => {
  const red = redactConfig({
    providers: {
      a: {
        ...ok,
        apiKey: "sk-abcdefghijklmn",
        headers: { "x-api-key": "sk-abcdefghijklmn", Authorization: "Bearer sk-abcdefghijklmn", "x-plain": "keep" },
      },
    },
  });
  assert.equal(red.providers.a.apiKey, "sk-a…klmn");
  assert.equal(red.providers.a.headers!["x-api-key"], "sk-a…klmn");
  assert.equal(red.providers.a.headers!["Authorization"], "Bear…klmn");
  assert.equal(red.providers.a.headers!["x-plain"], "keep");
});

test("validateProviderName 拒绝空和带空格", () => {
  assert.equal(validateProviderName("doubao"), undefined);
  assert.match(validateProviderName("  ") ?? "", /不能为空/);
  assert.match(validateProviderName("my model") ?? "", /空格/);
});

test("validateConfig 捕获各类非法配置", () => {
  assert.deepEqual(validateConfig({ providers: { a: ok } }), []);
  assert.deepEqual(validateConfig({ current: "a", passthrough: "on", providers: { a: ok } }), []);
  assert.ok(validateConfig(null).length > 0);
  assert.ok(validateConfig([]).length > 0);
  assert.ok(validateConfig({ providers: [] }).length > 0);
  assert.ok(validateConfig({ providers: { a: {} } }).some((e) => e.includes("baseUrl")));
  assert.ok(validateConfig({ providers: { a: { baseUrl: "u" } } }).some((e) => e.includes("model")));
  assert.ok(validateConfig({ providers: { a: { ...ok, maxTokens: 0 } } }).some((e) => e.includes("maxTokens")));
  assert.ok(validateConfig({ providers: { a: { ...ok, headers: { x: 1 } } } }).some((e) => e.includes("headers")));
  assert.ok(validateConfig({ passthrough: "yes", providers: {} }).some((e) => e.includes("passthrough")));
  assert.ok(validateConfig({ current: "nope", providers: {} }).some((e) => e.includes("不存在")));
  assert.ok(validateConfig({ providers: { "a b": ok } }).some((e) => e.includes("空格")));
});
