/**
 * 用假的 ExtensionAPI / ctx 驱动真实的 /vision 命令与 describe_image 工具。
 */
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const HOME = mkdtempSync(join(tmpdir(), "pi-vision-cmd-"));
process.env.HOME = HOME;

const CONFIG = join(HOME, ".pi", "agent", "vision-config.json");
mkdirSync(join(HOME, ".pi", "agent"), { recursive: true });

const factory = (await import("../extensions/index.ts")).default;

let handler!: (args: string, ctx: any) => Promise<void>;
let completions!: (prefix: string) => any;
let tool!: any;
let activeTools: string[] = [];
const events: Record<string, Function> = {};

factory({
  on: (name: string, fn: Function) => (events[name] = fn),
  getActiveTools: () => activeTools,
  setActiveTools: (t: string[]) => (activeTools = t),
  registerCommand: (_n: string, o: any) => {
    handler = o.handler;
    completions = o.getArgumentCompletions;
  },
  registerTool: (t: any) => (tool = t),
} as any);

const read = () => JSON.parse(readFileSync(CONFIG, "utf-8"));
const seed = {
  current: "doubao",
  providers: {
    doubao: { baseUrl: "https://old/v1", model: "old-m", apiKey: "sk-old-secret-value" },
    other: { baseUrl: "https://o/v1", model: "om" },
  },
};
const writeSeed = () => writeFileSync(CONFIG, JSON.stringify(seed));

function makeCtx(opts: { inputs?: (string | undefined)[]; selects?: (string | undefined)[]; confirm?: boolean } = {}) {
  const inputs = [...(opts.inputs ?? [])];
  const selects = [...(opts.selects ?? [])];
  const notices: string[] = [];
  const confirms: string[] = [];
  // 面板把模型列表铺在 select 标题里，断言得看得见它
  const selectTitles: string[] = [];
  let inputCount = 0;
  return {
    notices,
    confirms,
    selectTitles,
    inputCount: () => inputCount,
    ctx: {
      model: { id: "deepseek-chat", input: ["text"] },
      signal: undefined,
      ui: {
        input: async () => {
          inputCount++;
          return inputs.shift();
        },
        select: async (title: string) => {
          selectTitles.push(title);
          return selects.shift();
        },
        editor: async () => undefined,
        confirm: async (title: string, msg: string) => {
          confirms.push(`${title}: ${msg}`);
          return opts.confirm ?? false;
        },
        notify: (m: string) => notices.push(m),
      },
    },
  };
}

beforeEach(() => writeSeed());

// ---------------- edit ----------------

test("edit 能真正改掉 baseUrl / model / apiKey", async () => {
  const t = makeCtx({ inputs: ["", "https://new/v1", "sk-new", "new-m"] });
  await handler("edit doubao", t.ctx);
  assert.deepEqual(read().providers.doubao, { baseUrl: "https://new/v1", apiKey: "sk-new", model: "new-m" });
});

test("edit 全部留空 = 保持原值", async () => {
  const t = makeCtx({ inputs: ["", "", "", ""] });
  await handler("edit doubao", t.ctx);
  assert.deepEqual(read().providers.doubao, seed.providers.doubao);
});

test("edit apiKey 输入 - 可清除", async () => {
  const t = makeCtx({ inputs: ["", "", "-", ""] });
  await handler("edit doubao", t.ctx);
  assert.equal(read().providers.doubao.apiKey, undefined);
  assert.equal(read().providers.doubao.model, seed.providers.doubao.model);
});

test("edit 重命名时同步 current，不会静默切到别的模型", async () => {
  const t = makeCtx({ inputs: ["renamed", "", "", ""] });
  await handler("edit doubao", t.ctx);
  const cfg = read();
  assert.ok(!cfg.providers.doubao);
  assert.deepEqual(cfg.providers.renamed, seed.providers.doubao);
  assert.equal(cfg.current, "renamed");
});

test("edit 保留 headers / maxTokens（向导没有入口的字段不该被吃掉）", async () => {
  writeFileSync(
    CONFIG,
    JSON.stringify({ providers: { a: { baseUrl: "https://a/v1", model: "m", headers: { "x-k": "v" }, maxTokens: 999 } } }),
  );
  const t = makeCtx({ inputs: ["", "https://b/v1", "", ""] });
  await handler("edit a", t.ctx);
  assert.deepEqual(read().providers.a.headers, { "x-k": "v" });
  assert.equal(read().providers.a.maxTokens, 999);
});

test("edit 名称带空格被拒且不写坏配置", async () => {
  const t = makeCtx({ inputs: ["bad name", "", "", ""] });
  await handler("edit doubao", t.ctx);
  assert.ok(t.notices.some((n) => n.includes("空格")));
  assert.deepEqual(read().providers, seed.providers);
});

test("ESC 取消不写盘", async () => {
  const before = readFileSync(CONFIG, "utf-8");
  const t = makeCtx({ inputs: [undefined] });
  await handler("edit doubao", t.ctx);
  assert.equal(readFileSync(CONFIG, "utf-8"), before);
});

// ---------------- 重名保护 ----------------

test("add 重名立刻确认；拒绝后旧配置分毫未动且不再追问", async () => {
  const t = makeCtx({ inputs: ["doubao", "https://NEW/v1", "sk-new", "new-m"], confirm: false });
  await handler("add", t.ctx);
  assert.ok(t.confirms.some((c) => c.includes("已存在")));
  assert.equal(t.inputCount(), 1, "拒绝后不该继续问剩余字段");
  assert.deepEqual(read().providers.doubao, seed.providers.doubao);
});

test("add 重名确认后正常覆盖", async () => {
  const t = makeCtx({ inputs: ["doubao", "https://NEW/v1", "sk-new", "new-m"], confirm: true });
  await handler("add", t.ctx);
  assert.equal(read().providers.doubao.baseUrl, "https://NEW/v1");
  assert.ok(t.notices.some((n) => n.includes("已覆盖")));
});

test("add 新名字不弹确认，且首次添加自动设为 current", async () => {
  writeFileSync(CONFIG, JSON.stringify({ providers: {} }));
  const t = makeCtx({ inputs: ["fresh", "https://n/v1", "", "nm"] });
  await handler("add", t.ctx);
  assert.equal(t.confirms.length, 0);
  assert.equal(read().current, "fresh");
});

test("edit 改名撞上已有模型同样要确认", async () => {
  const t = makeCtx({ inputs: ["other", "", "", ""], confirm: false });
  await handler("edit doubao", t.ctx);
  assert.ok(t.confirms.some((c) => c.includes("已存在")));
  assert.deepEqual(read().providers, seed.providers);
});

test("edit 不改名时不弹确认", async () => {
  const t = makeCtx({ inputs: ["", "https://edited/v1", "", ""] });
  await handler("edit doubao", t.ctx);
  assert.equal(t.confirms.length, 0);
  assert.equal(read().providers.doubao.baseUrl, "https://edited/v1");
});

// ---------------- use / remove ----------------

test("use 切换 current；不存在的名字报错且不改动", async () => {
  await handler("use other", makeCtx().ctx);
  assert.equal(read().current, "other");
  const t = makeCtx();
  await handler("use nonexistent", t.ctx);
  assert.ok(t.notices.some((n) => n.includes("未找到")));
  assert.equal(read().current, "other");
});

test("remove 需确认；删掉 current 后 current 被清空", async () => {
  const declined = makeCtx({ confirm: false });
  await handler("remove doubao", declined.ctx);
  assert.ok(read().providers.doubao, "拒绝确认后不该删除");

  const t = makeCtx({ confirm: true });
  await handler("remove doubao", t.ctx);
  const cfg = read();
  assert.ok(!cfg.providers.doubao);
  assert.equal(cfg.current, undefined);
});

// ---------------- 面板 / 健壮性 ----------------

test("列表与面板都不打印明文 apiKey", async () => {
  for (const cmd of ["list", ""]) {
    const t = makeCtx();
    await handler(cmd, t.ctx);
    // 面板的列表在 select 标题里，notify 只剩告警；两条路径都不该出现密钥
    const all = [...t.notices, ...t.selectTitles].join("\n");
    assert.ok(!all.includes("sk-old-secret-value"), `「/vision ${cmd}」泄露了明文 apiKey`);
  }
});

test("面板标题直接铺出模型列表，当前项有标记", async () => {
  const t = makeCtx({ selects: [undefined] });
  await handler("", t.ctx);
  const title = t.selectTitles[0] ?? "";
  assert.match(title, /● doubao/);
  assert.match(title, /other/);
  assert.match(title, /old-m @ https:\/\/old\/v1/);
});

test("未知子命令给出提示，且已删掉的子命令不再被识别", async () => {
  for (const gone of ["nonsense", "show", "config", "test", "passthrough"]) {
    const t = makeCtx();
    await handler(gone, t.ctx);
    assert.ok(
      t.notices.some((n) => n.includes("未知子命令")),
      `「${gone}」没被当成未知子命令`
    );
  }
});

test("passthrough 字段没有命令入口，但手改文件仍然生效", async () => {
  // 逃生阀：auto 判断失灵时用户改文件强制，扩展必须照做
  writeFileSync(CONFIG, JSON.stringify({ passthrough: "off", providers: {} }));
  activeTools = [];
  events.model_select!({ model: { id: "gpt-4o", input: ["text", "image"] } }, { ui: { notify: () => {} } });
  assert.ok(activeTools.includes("describe_image"), "手改的 passthrough=off 被忽略了");
});

test("畸形配置不会把命令打崩", async () => {
  for (const bad of [
    '{"current":"a","providers":{"a":null}}',
    '{"providers":{"a":[1,2]}}',
    '{"providers":[]}',
    "{ 根本不是 json ",
    '{"current":"a","providers":{"a":{"baseUrl":"","model":""}}}',
  ]) {
    writeFileSync(CONFIG, bad);
    for (const cmd of ["list", "", "use x", "edit x", "remove x", "nonsense"]) {
      await assert.doesNotReject(() => handler(cmd, makeCtx().ctx), `「${cmd}」在配置 ${bad} 下崩了`);
    }
  }
});

// ---------------- 补全 ----------------

test("补全：第一段补子命令", () => {
  assert.deepEqual(
    completions("us").map((i: any) => i.value),
    ["use"],
  );
  assert.deepEqual(
    completions("").map((i: any) => i.value),
    ["list", "add", "edit", "remove", "use"],
  );
  assert.equal(completions("zzz"), null);
});

test("补全：第二段补模型名，且 value 是完整参数串", () => {
  const items = completions("use ");
  assert.deepEqual(
    items.map((i: any) => i.value),
    ["use doubao", "use other"],
  );
  assert.equal(items[0].label, "doubao");
  assert.match(items[0].description, /old-m @ https:\/\/old\/v1/);
  assert.deepEqual(
    completions("edit dou").map((i: any) => i.value),
    ["edit doubao"],
  );
});

test("补全：不接名字的子命令不补第二段", () => {
  assert.equal(completions("list "), null);
  assert.equal(completions("add x"), null);
  assert.equal(completions("passthrough o"), null, "已删掉的子命令不该还有补全");
});

// ---------------- describe_image 工具 ----------------

test("未配置模型时工具返回可操作的错误", async () => {
  writeFileSync(CONFIG, JSON.stringify({ providers: {} }));
  const r = await tool.execute("id", { path: "/x/a.png" }, undefined, undefined, makeCtx().ctx);
  assert.equal(r.isError, true);
  assert.match(r.content[0].text, /vision add/);
});

test("配置损坏时工具报的是配置问题，而不是「未配置」", async () => {
  writeFileSync(CONFIG, "{ 坏 ");
  const r = await tool.execute("id", { path: "/x/a.png" }, undefined, undefined, makeCtx().ctx);
  assert.equal(r.isError, true);
  assert.match(r.content[0].text, /配置无法读取/);
});

test("参数非法时返回错误而不是抛异常", async () => {
  writeSeed();
  const r = await tool.execute("id", {}, undefined, undefined, makeCtx().ctx);
  assert.equal(r.isError, true);
  assert.match(r.content[0].text, /需要提供/);
});

test("取消不算失败（不设 isError）", async () => {
  writeSeed();
  const ac = new AbortController();
  ac.abort();
  const real = join(HOME, "real.png");
  const { generateTestPngBase64 } = await import("./test-image.ts");
  writeFileSync(real, Buffer.from(generateTestPngBase64(), "base64"));
  const r = await tool.execute("id", { path: real }, ac.signal, undefined, makeCtx().ctx);
  assert.notEqual(r.isError, true, "取消被当成了失败");
  assert.match(r.content[0].text, /已取消/);
});

// ---------------- 透传模式联动 ----------------

test("text-only 主模型 → 启用 describe_image；多模态 → 隐藏", () => {
  writeFileSync(CONFIG, JSON.stringify({ passthrough: "auto", providers: {} }));
  activeTools = [];
  events.session_start!({}, { model: { id: "deepseek", input: ["text"] } });
  assert.ok(activeTools.includes("describe_image"));

  events.model_select!({ model: { id: "gpt-4o", input: ["text", "image"] } }, { ui: { notify: () => {} } });
  assert.ok(!activeTools.includes("describe_image"));
});

test("passthrough=off 时即使主模型多模态也保留工具", () => {
  writeFileSync(CONFIG, JSON.stringify({ passthrough: "off", providers: {} }));
  activeTools = [];
  events.model_select!({ model: { id: "gpt-4o", input: ["text", "image"] } }, { ui: { notify: () => {} } });
  assert.ok(activeTools.includes("describe_image"));
});
