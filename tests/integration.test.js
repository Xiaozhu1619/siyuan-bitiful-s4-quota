/* 集成测试：在 Node 中模拟思源宿主环境，验证插件核心逻辑
 *
 * 模拟内容：
 *   - require("siyuan") 由宿主注入       → 桩
 *   - /api/network/proxy 内核正向代理    → 解码 u/h 参数后真实请求缤纷云 API
 *   - this.loadData / this.saveData      → 内存桩
 *
 * 可在不安装思源的前提下回归：b64url 编码、代理参数格式、增量游标、
 * 额度计算、十进制/二进制单位换算、多桶合并、错误路径。
 *
 * 用法：BITIFUL_TOKEN=xxx BITIFUL_BUCKET=yyy node tests/integration.test.js
 */

const path = require("path");
const fs = require("fs");

const TOKEN = process.env.BITIFUL_TOKEN;
const BUCKET = process.env.BITIFUL_BUCKET;
if (!TOKEN || !BUCKET) {
    console.error("请设置 BITIFUL_TOKEN 与 BITIFUL_BUCKET 环境变量");
    process.exit(1);
}

/* ---------- 1. 模拟宿主注入的 require("siyuan") ---------- */

class FakePlugin {
    constructor(opts) {
        Object.assign(this, opts);
        this.i18n = (opts && opts.i18n) || {};
    }
}
class FakeSetting {
    constructor(opts) { this.options = opts; this.items = []; }
    addItem(i) { this.items.push(i); }
    open() {}
}

const siyuanStub = {
    Plugin: FakePlugin,
    Setting: FakeSetting,
    showMessage: (m) => console.log("    [showMessage]", m),
    Dialog: class {},
};

const requireStub = (key) => (key === "siyuan" ? siyuanStub : require(key));

/* ---------- 2. 模拟 /api/network/proxy ---------- */

function b64urlDecode(s) {
    const pad = s.length % 4 ? "=".repeat(4 - (s.length % 4)) : "";
    return Buffer.from(s.replace(/-/g, "+").replace(/_/g, "/") + pad, "base64").toString("utf8");
}

const realFetch = globalThis.fetch;   // 必须在覆盖之前捕获
let proxyCalls = 0;

global.fetch = async (url, init) => {
    const m = /^\/api\/network\/proxy\?(.*)$/.exec(url);
    if (!m) throw new Error("非代理请求（会触发 CORS）: " + url);
    proxyCalls++;

    const params = new URLSearchParams(m[1]);
    const target = b64urlDecode(params.get("u"));
    const headers = JSON.parse(b64urlDecode(params.get("h")));

    // 契约校验：目标必须 https，请求头必须是 map[string][]string
    if (!target.startsWith("https://")) throw new Error("目标非 https: " + target);
    for (const k in headers) {
        if (!Array.isArray(headers[k])) throw new Error("header 值必须是数组: " + k);
    }
    if (!params.get("t")) throw new Error("缺少超时参数 t");

    const hdr = {};
    for (const k in headers) hdr[k] = headers[k].join(", ");
    const res = await realFetch(target, { method: (init && init.method) || "GET", headers: hdr });
    const text = await res.text();
    return { status: res.status, text: async () => text };
};

/* ---------- 3. 按思源 loader 的方式加载插件 ---------- */

const src = fs.readFileSync(path.join(__dirname, "..", "index.js"), "utf8");
const moduleObj = { exports: {} };
const exportsObj = {};
new Function("require", "module", "exports", src + "\n//# sourceURL=plugin:siyuan-bitiful-s4-quota")(
    requireStub, moduleObj, exportsObj);

const pluginClass = (moduleObj.exports || exportsObj).default || moduleObj.exports;

/* ---------- 4. 断言 ---------- */

let pass = 0, fail = 0;
function check(name, cond, extra) {
    if (cond) { pass++; console.log(`  ✓ ${name}`); }
    else { fail++; console.log(`  ✗ ${name}${extra !== undefined ? "  → " + JSON.stringify(extra) : ""}`); }
}

function makePlugin(config) {
    const p = new pluginClass({ app: {}, displayName: "t", name: "t", i18n: {} });
    const store = {};
    p.loadData = async (n) => store[n] || null;
    p.saveData = async (n, v) => { store[n] = JSON.parse(JSON.stringify(v)); };
    p.config = Object.assign({ token: TOKEN, buckets: BUCKET, autoRefresh: false, intervalSec: 300 }, config || {});
    p.stats = { cursors: {}, days: {}, storage: { bytes: 0, files: 0, at: 0 } };
    p.state = { loading: false, error: "", lastSync: 0 };
    p.busy = false;
    p.panel = null;
    p._store = store;
    return p;
}

(async () => {
    const F = pluginClass;

    console.log("\n=== A. 加载契约 ===");
    check("exports 是函数（类）", typeof pluginClass === "function");
    check("prototype 继承宿主 Plugin（loader 的 instanceof 校验）",
        pluginClass.prototype instanceof FakePlugin);

    console.log("\n=== B. 单位换算：流量十进制 / 存储二进制 ===");
    check("10 GB（十进制）= \"10.00 GB\"", F._fmtDec(10 * 1000 ** 3) === "10.00 GB", F._fmtDec(10 * 1000 ** 3));
    check("50 GiB（二进制）= \"50.00 GiB\"", F._fmtBin(50 * 1024 ** 3) === "50.00 GiB", F._fmtBin(50 * 1024 ** 3));
    check("同一字节数两种口径不同（关键：不能混用）",
        F._fmtDec(10 * 1024 ** 3) !== F._fmtBin(10 * 1024 ** 3),
        { dec: F._fmtDec(10 * 1024 ** 3), bin: F._fmtBin(10 * 1024 ** 3) });
    check("10 GiB 按十进制读作 10.74 GB", F._fmtDec(10 * 1024 ** 3) === "10.74 GB", F._fmtDec(10 * 1024 ** 3));
    check("50 GiB 若误用十进制会读成 53.69 GB（故存储必须用二进制）",
        F._fmtDec(50 * 1024 ** 3) === "53.69 GB", F._fmtDec(50 * 1024 ** 3));
    check("KB / KiB 分档正确", F._fmtDec(1000) === "1.0 KB" && F._fmtBin(1024) === "1.0 KiB",
        { dec: F._fmtDec(1000), bin: F._fmtBin(1024) });

    console.log("\n=== C. 额度常量 ===");
    check("请求额度 = 100000 次", F._QUOTA.req === 100000);
    check("流量额度 = 10 GB（十进制）", F._QUOTA.trafficBytes === 10 * 1000 ** 3);
    check("存储额度 = 50 GiB（二进制）", F._QUOTA.storageBytes === 50 * 1024 ** 3);

    console.log("\n=== D. 首次同步（回填 + 读容量）===");
    const p = makePlugin();
    await p.refresh(true);
    check("无错误", p.state.error === "", p.state.error);
    check("游标已写入", p.stats.cursors[BUCKET] > 0, p.stats.cursors[BUCKET]);
    check("日账已建立", Object.keys(p.stats.days).length > 0, Object.keys(p.stats.days));
    check("容量已读取", p.stats.storage.bytes > 0, p.stats.storage);
    check("已持久化", !!p._store["stats.json"]);
    const t1 = p.totals();
    const cursor1 = p.stats.cursors[BUCKET];

    console.log("\n=== E. 二次同步（增量，不重复计数）===");
    await p.refresh(true);
    const t2 = p.totals();
    check("游标未回退", p.stats.cursors[BUCKET] >= cursor1);
    check("月请求数未异常增长", t2.mReq >= t1.mReq && t2.mReq <= t1.mReq + 100,
        { first: t1.mReq, second: t2.mReq });
    check("月流量未异常增长", t2.mBytes >= t1.mBytes);

    console.log("\n=== F. 额度占比与剩余量 ===");
    const pReq = t2.mReq / F._QUOTA.req * 100;
    const pTr = t2.mBytes / F._QUOTA.trafficBytes * 100;
    const pSt = p.stats.storage.bytes / F._QUOTA.storageBytes * 100;
    check("请求占比在 0–100% 之间", pReq > 0 && pReq < 100);
    check("流量占比在 0–100% 之间", pTr >= 0 && pTr < 100);
    check("存储占比在 0–100% 之间", pSt > 0 && pSt < 100);
    check("剩余量非负",
        Math.max(0, F._QUOTA.req - t2.mReq) >= 0 && Math.max(0, F._QUOTA.storageBytes - p.stats.storage.bytes) >= 0);
    console.log(`    本月请求 ${t2.mReq} 次（${pReq.toFixed(2)}%）· `
        + `流量 ${F._fmtDec(t2.mBytes)}（${pTr.toFixed(2)}%）· `
        + `存储 ${F._fmtBin(p.stats.storage.bytes)}（${pSt.toFixed(2)}%）`);
    console.log(`    今日 ${t2.tReq} 次 · ${F._fmtDec(t2.tBytes)}`);

    console.log("\n=== G1. 同一个桶重复填写 → 去重，不重复计数（正确行为）===");
    const pd = makePlugin({ buckets: `${BUCKET},${BUCKET}` });
    await pd.refresh(true);
    const td = pd.totals();
    check("游标键只有 1 个（按桶名去重）", Object.keys(pd.stats.cursors).length === 1, Object.keys(pd.stats.cursors));
    check("请求数未被重复计入", Math.abs(td.mReq - t2.mReq) <= 5, { single: t2.mReq, dup: td.mReq });

    console.log("\n=== G2. 多桶合并：用桩数据验证真正的聚合 ===");
    const pm = makePlugin({ buckets: "fakeA,fakeB" });
    const NOW_NS = Date.now() * 1e6;
    pm.apiGet = async (p) => {
        if (p.includes("/usage")) {
            const bytes = p.includes("fakeA") ? 1000 : 2000;
            return { status: 200, json: { total_bytes: bytes, total_files: 1 } };
        }
        const n = p.includes("fakeA") ? 2 : 3;   // A 桶 2 条，B 桶 3 条
        return {
            status: 200,
            json: { data: Array.from({ length: n }, (_, i) => ({
                access_time: NOW_NS - i * 1000, size: 100, code: 200, remote_ip: "1.1.1.1",
            })) },
        };
    };
    await pm.refresh(true);
    const tm = pm.totals();
    check("两个桶各写入一个游标", Object.keys(pm.stats.cursors).length === 2, Object.keys(pm.stats.cursors));
    check("请求数相加 = 2 + 3 = 5", tm.mReq === 5, tm.mReq);
    check("流量相加 = 5 × 100 = 500 字节", tm.mBytes === 500, tm.mBytes);
    check("容量相加 = 1000 + 2000 = 3000 字节", pm.stats.storage.bytes === 3000, pm.stats.storage.bytes);
    check("文件数相加 = 1 + 1 = 2", pm.stats.storage.files === 2, pm.stats.storage.files);
    check("bucketList 正确切分逗号、中文逗号与空格",
        JSON.stringify(makePlugin({ buckets: " a, b ，c " }).bucketList()) === JSON.stringify(["a", "b", "c"]),
        makePlugin({ buckets: " a, b ，c " }).bucketList());

    console.log("\n=== H. 错误路径：无效 Token 必须报错而非静默 ===");
    const pe = makePlugin({ token: "INVALID_TOKEN_FOR_TEST" });
    await pe.refresh(true);
    check("无效 Token 被捕获", pe.state.error !== "", pe.state.error);
    check("不会误报容量数据", pe.stats.storage.bytes === 0, pe.stats.storage);
    console.log("    错误信息:", pe.state.error);

    console.log("\n=== I. 未配置时的行为 ===");
    const pn = makePlugin({ token: "", buckets: "" });
    await pn.refresh(true);
    check("提示未配置", /尚未配置/.test(pn.state.error), pn.state.error);

    console.log(`\n代理调用次数: ${proxyCalls}`);
    console.log(`\n结果: ${pass} 通过 / ${fail} 失败\n`);
    process.exit(fail ? 1 : 0);
})().catch((e) => {
    console.error("\n测试异常:", e);
    process.exit(1);
});
