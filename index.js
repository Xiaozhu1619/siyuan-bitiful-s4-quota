/* 缤纷云 S4 用量看板 —— 思源笔记插件（零构建纯 JS）
 *
 * 目的：一眼看清三个免费额度的消耗 —— API 请求数、出口流量、存储容量。
 *
 * 免费额度（缤纷云官方口径，实名账户）：
 *   - API 请求数：每月 10 万次（每日限 1 万次），每月重置
 *   - 出口流量  ：每月 10 GB （每日限 5 GB），每月重置
 *   - 存储容量  ：50 GiB，不重置
 *   注意单位体系不同：流量按十进制（1 GB = 1000 MB），存储按二进制（1 GiB = 1024^3 B）。
 *   额度按【账户】汇总，多桶共用同一份额度，因此本插件支持填写多个桶并合并统计。
 *
 * 安全与影响面（本插件绝不触碰你的笔记）：
 *   - 只调用两个接口：缤纷云 S4 的 usage（读容量）与 logs（读日志），全部只读。
 *   - 不调用任何思源笔记/块/文件相关 API，不读写任何文档、不修改任何块。
 *   - 唯一的本地写入是思源提供的插件私有存储 saveData()，
 *     落在 {工作空间}/data/storage/petal/siyuan-bitiful-s4-quota/ 下，仅本插件自己的目录。
 *
 * 为什么必须走内核代理：
 *   缤纷云 API 不返回任何 CORS 头、OPTIONS 预检返回 404，插件前端直接 fetch 必被浏览器拦截，
 *   因此全部请求经思源内核侧正向代理 /api/network/proxy 发出（Go 侧请求，无同源限制）。
 */

const { Plugin, Setting, showMessage } = require("siyuan");

const API_BASE = "https://api.bitiful.com";
const PAGE_LIMIT = 1000;
const MAX_PAGES = 12;

// 免费额度
const QUOTA = {
    req: 100000,                       // 次 / 月
    trafficBytes: 10 * 1000 ** 3,      // 10 GB（十进制）
    storageBytes: 50 * 1024 ** 3,      // 50 GiB（二进制）
};
const DAILY_REQ_CAP = 10000;           // 每日请求限额
const DAILY_TRAFFIC_CAP = 5 * 1000 ** 3; // 每日流量限额 5 GB
const KEEP_DAYS = 120;                 // 本地日账保留天数

const DEFAULT_CONFIG = {
    token: "",
    buckets: "",          // 逗号分隔，多桶合并统计
    autoRefresh: true,
    intervalSec: 300,
};

const TOPBAR_ICON = '<svg viewBox="0 0 32 32" width="32" height="32"><path fill="currentColor" d="M7 20.5A4.5 4.5 0 0 1 8.5 12a6.5 6.5 0 0 1 12.6-2.1A5 5 0 0 1 24 20.5H7Z" opacity=".9"/><rect x="8" y="23" width="16" height="2.6" rx="1.3" fill="currentColor"/></svg>';

/* ---------- 工具 ---------- */

// Go base64.RawURLEncoding：URL 安全、无 = 补位
function b64url(str) {
    const bytes = new TextEncoder().encode(str);
    let bin = "";
    for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
    return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function pad2(n) { return String(n).padStart(2, "0"); }
function dayKey(ms) {
    const d = new Date(ms);
    return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}
function monthKey(ms) { return dayKey(ms).slice(0, 7); }

function fmtInt(n) { return (n || 0).toLocaleString("zh-CN"); }

// 流量：十进制
function fmtDec(bytes) {
    const b = bytes || 0;
    if (b >= 1000 ** 3) return (b / 1000 ** 3).toFixed(2) + " GB";
    if (b >= 1000 ** 2) return (b / 1000 ** 2).toFixed(1) + " MB";
    if (b >= 1000) return (b / 1000).toFixed(1) + " KB";
    return b + " B";
}

// 存储：二进制
function fmtBin(bytes) {
    const b = bytes || 0;
    if (b >= 1024 ** 3) return (b / 1024 ** 3).toFixed(2) + " GiB";
    if (b >= 1024 ** 2) return (b / 1024 ** 2).toFixed(1) + " MiB";
    if (b >= 1024) return (b / 1024).toFixed(1) + " KiB";
    return b + " B";
}

/* ---------- 插件 ---------- */

class BitifulS4Quota extends Plugin {

    async onload() {
        const cfg = await this.loadData("config.json").catch(() => null);
        this.config = Object.assign({}, DEFAULT_CONFIG, (cfg && typeof cfg === "object") ? cfg : {});

        const st = await this.loadData("stats.json").catch(() => null);
        this.stats = (st && typeof st === "object") ? st : {};
        if (!this.stats.cursors || typeof this.stats.cursors !== "object") this.stats.cursors = {};
        if (!this.stats.days || typeof this.stats.days !== "object") this.stats.days = {};
        if (!this.stats.storage) this.stats.storage = { bytes: 0, files: 0, at: 0 };

        this.state = { loading: false, error: "", lastSync: 0 };
        this.timer = null;
        this.panel = null;

        this.buildSetting();
    }

    onLayoutReady() {
        this.topBarEl = this.addTopBar({
            icon: TOPBAR_ICON,
            title: "缤纷云 S4 用量",
            position: "right",
            callback: () => this.togglePanel(),
        });
        this.addCommand({ langKey: "openPanel", hotkey: "", callback: () => this.togglePanel() });
        this.addCommand({ langKey: "refreshNow", hotkey: "", callback: () => this.refresh(true) });
        if (this.config.autoRefresh) this.restartTimer();
    }

    onunload() {
        this.stopTimer();
        if (this.onDocClick) {
            document.removeEventListener("click", this.onDocClick);
            this.onDocClick = null;
        }
        if (this.panel) { this.panel.remove(); this.panel = null; }
    }

    bucketList() {
        return String(this.config.buckets || "")
            .split(/[,，\s]+/)
            .map((s) => s.trim())
            .filter(Boolean);
    }

    /* ---------- 配置 ---------- */

    buildSetting() {
        const setting = new Setting({
            confirmCallback: async () => {
                await this.persistConfig();
                this.stopTimer();
                if (this.config.autoRefresh) this.restartTimer();
                else this.refresh(true);
                this.render();
                showMessage("缤纷云 S4 用量：配置已保存");
            },
        });

        const mkInput = (value, placeholder, type) => {
            const el = document.createElement("input");
            el.className = "b3-text-field fn__flex-1";
            el.type = type || "text";
            el.value = value || "";
            el.placeholder = placeholder || "";
            el.spellcheck = false;
            return el;
        };

        this.elToken = mkInput(this.config.token, "在 console.bitiful.com/apiToken 获取", "password");
        this.elBuckets = mkInput(this.config.buckets, "桶名，多个用逗号分隔");
        this.elInterval = mkInput(String(this.config.intervalSec), "300", "number");
        this.elAuto = document.createElement("input");
        this.elAuto.type = "checkbox";
        this.elAuto.checked = !!this.config.autoRefresh;

        setting.addItem({
            title: "API Token",
            description: "缤纷云控制台 API Token。将明文保存在本插件的私有目录中，建议使用专用 Token。",
            actionElement: this.elToken,
        });
        setting.addItem({
            title: "桶名称",
            description: "要统计的 S4 桶名。因免费额度按账户汇总，多桶请用逗号分隔，将合并计算。",
            actionElement: this.elBuckets,
        });
        setting.addItem({
            title: "自动刷新间隔（秒）",
            description: "建议 300 秒。缤纷云日志仅保留最近 3 天左右，间隔过长可能导致漏计。",
            actionElement: this.elInterval,
        });
        setting.addItem({
            title: "启用自动刷新",
            description: "关闭后仅在点击顶栏图标或手动刷新时统计。",
            actionElement: this.elAuto,
        });

        const btn = document.createElement("button");
        btn.className = "b3-button b3-button--outline";
        btn.textContent = "清空本地累计数据";
        btn.addEventListener("click", async () => {
            this.stats = { cursors: {}, days: {}, storage: { bytes: 0, files: 0, at: 0 } };
            await this.persistStats();
            this.render();
            showMessage("已清空本地累计数据");
        });
        setting.addItem({
            title: "重置统计",
            description: "仅清除本插件累积的日账，不会影响缤纷云上的任何数据，也不会改动你的笔记。",
            actionElement: btn,
        });

        this.setting = setting;
    }

    async persistConfig() {
        this.config = {
            token: (this.elToken.value || "").trim(),
            buckets: (this.elBuckets.value || "").trim(),
            intervalSec: Math.max(60, parseInt(this.elInterval.value, 10) || 300),
            autoRefresh: !!this.elAuto.checked,
        };
        try {
            await this.saveData("config.json", this.config);
        } catch (e) {
            showMessage("配置保存失败：当前为只读或发布模式");
        }
    }

    async persistStats() {
        try {
            await this.saveData("stats.json", this.stats);
        } catch (e) { /* 只读模式忽略 */ }
    }

    /* ---------- 网络（全部经内核正向代理，规避 CORS） ---------- */

    async apiGet(path) {
        const q = `u=${b64url(API_BASE + path)}`
            + `&h=${b64url(JSON.stringify({ Authorization: [this.config.token] }))}&t=30s`;
        const res = await fetch(`/api/network/proxy?${q}`, { method: "GET" });
        const text = await res.text();
        let json = null;
        try { json = JSON.parse(text); } catch (e) { /* 非 JSON */ }
        return { status: res.status, json, text };
    }

    // 读单个桶的容量
    async fetchStorage(bucket) {
        const { status, json } = await this.apiGet(`/s4/data/${encodeURIComponent(bucket)}/usage`);
        if (status !== 200 || !json || typeof json.total_bytes !== "number") {
            return { ok: false, status };
        }
        return { ok: true, bytes: json.total_bytes, files: json.total_files || 0 };
    }

    // 读单个桶的增量日志，返回新增记录（游标向过去翻页）
    async fetchNewLogs(bucket, lastSeen) {
        let cursor = Date.now() * 1e6;
        const fresh = [];
        for (let page = 0; page < MAX_PAGES; page++) {
            const { status, json } = await this.apiGet(
                `/s4/data/${encodeURIComponent(bucket)}/logs?start_time=${cursor}&codes=ALL&limit=${PAGE_LIMIT}`);
            if (status === 403) return { fresh, error: "" };            // 超出可查窗口 = 正常终止
            if (status !== 200 || !json || !Array.isArray(json.data)) {
                return { fresh, error: `HTTP ${status}` };
            }
            const data = json.data;
            if (!data.length) break;
            let hitOld = false;
            for (const rec of data) {
                if (lastSeen && rec.access_time <= lastSeen) { hitOld = true; break; }
                fresh.push(rec);
            }
            if (hitOld || data.length < PAGE_LIMIT) break;
            cursor = data[data.length - 1].access_time - 1;   // 以最旧一条为游标继续向过去翻
        }
        return { fresh, error: "" };
    }

    /* ---------- 主流程 ---------- */

    async refresh(manual) {
        if (this.state.loading) return;
        const buckets = this.bucketList();
        if (!this.config.token || !buckets.length) {
            this.state.error = "尚未配置，请点「设置」填写 API Token 与桶名称";
            this.render();
            if (manual) showMessage("请先在插件设置中填写 API Token 与桶名称");
            return;
        }

        this.state.loading = true;
        this.state.error = "";
        this.render();

        try {
            // 1) 各桶增量日志 -> 累加到本地日账
            for (const bucket of buckets) {
                const lastSeen = this.stats.cursors[bucket] || 0;
                const { fresh, error } = await this.fetchNewLogs(bucket, lastSeen);
                if (error) { this.state.error = `${bucket}: ${error}`; continue; }
                let maxNs = lastSeen;
                for (const r of fresh) {
                    const k = dayKey(r.access_time / 1e6);
                    const d = this.stats.days[k] || (this.stats.days[k] = { req: 0, bytes: 0 });
                    d.req += 1;
                    d.bytes += Number(r.size) || 0;
                    if (r.access_time > maxNs) maxNs = r.access_time;
                }
                if (fresh.length) this.stats.cursors[bucket] = maxNs;
                else if (!lastSeen) this.stats.cursors[bucket] = Date.now() * 1e6;
            }

            // 2) 容量（实时，取各桶之和）
            let bytes = 0, files = 0, usageOk = false;
            for (const bucket of buckets) {
                const u = await this.fetchStorage(bucket);
                if (u.ok) { bytes += u.bytes; files += u.files; usageOk = true; }
                else if (!this.state.error) this.state.error = `${bucket}: 容量读取失败 (HTTP ${u.status})`;
            }
            if (usageOk) this.stats.storage = { bytes, files, at: Date.now() };

            this.prune();
            await this.persistStats();
            this.state.lastSync = Date.now();
        } catch (e) {
            this.state.error = String((e && e.message) || e);
        } finally {
            this.state.loading = false;
            this.render();
        }
    }

    prune() {
        const cutoff = dayKey(Date.now() - KEEP_DAYS * 86400000);
        for (const k of Object.keys(this.stats.days)) {
            if (k < cutoff) delete this.stats.days[k];
        }
    }

    restartTimer() {
        this.stopTimer();
        this.timer = window.setInterval(() => this.refresh(false), Math.max(60, this.config.intervalSec) * 1000);
        this.refresh(false);
    }

    stopTimer() {
        if (this.timer) { window.clearInterval(this.timer); this.timer = null; }
    }

    /* ---------- 汇总 ---------- */

    totals() {
        const now = Date.now();
        const today = dayKey(now);
        const mk = monthKey(now);
        let mReq = 0, mBytes = 0, tReq = 0, tBytes = 0;
        for (const k in this.stats.days) {
            const d = this.stats.days[k];
            if (k.startsWith(mk)) { mReq += d.req; mBytes += d.bytes; }
            if (k === today) { tReq += d.req; tBytes += d.bytes; }
        }
        return { mReq, mBytes, tReq, tBytes };
    }

    /* ---------- UI ---------- */

    reducedMotion() {
        return !!(window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches);
    }

    openPanel() {
        if (this.panel) return;
        const el = document.createElement("div");
        el.className = "bs4q-panel";
        el.innerHTML = this.template();
        el.addEventListener("click", (ev) => {
            const t = ev.target.closest("[data-act]");
            if (!t || t.disabled) return;
            const act = t.getAttribute("data-act");
            if (act === "refresh") this.refresh(true);
            else if (act === "setting") this.openSetting();
            else if (act === "close") this.closePanel();
        });
        document.body.appendChild(el);
        this.panel = el;
        this.render();   // 只渲染已缓存的数据，打开面板不发任何请求

        // 点击面板和顶栏图标之外的空白处自动收起。
        // 延后一帧注册，避免"用于打开面板的那一次点击"立刻把它关掉。
        this.onDocClick = (ev) => {
            if (!this.panel) return;
            if (this.panel.contains(ev.target)) return;
            if (this.topBarEl && this.topBarEl.contains(ev.target)) return;
            this.closePanel();
        };
        window.setTimeout(() => {
            if (this.panel) document.addEventListener("click", this.onDocClick);
        }, 0);
    }

    closePanel() {
        if (this.onDocClick) {
            document.removeEventListener("click", this.onDocClick);
            this.onDocClick = null;
        }
        const el = this.panel;
        if (!el) return;
        this.panel = null;
        if (this.reducedMotion()) { el.remove(); return; }
        el.classList.add("bs4q-out");          // 播完退出动画再移除
        window.setTimeout(() => el.remove(), 150);
    }

    togglePanel() {
        if (this.panel) this.closePanel();
        else this.openPanel();
    }

    template() {
        return `
<div class="bs4q-head">
  <div class="bs4q-title">缤纷云 S4 用量</div>
  <div class="bs4q-actions">
    <button class="b3-button b3-button--outline bs4q-btn bs4q-primary" data-act="refresh">立即更新</button>
    <button class="b3-button b3-button--outline bs4q-btn" data-act="setting">设置</button>
    <button class="b3-button b3-button--outline bs4q-btn bs4q-x" data-act="close" title="关闭">×</button>
  </div>
</div>
<div class="bs4q-sub" data-role="sub"></div>
<div class="bs4q-today">
  <div class="bs4q-tl">今日使用</div>
  <div class="bs4q-tv"><span data-role="tReq">-</span> 次请求 · <span data-role="tBytes">-</span></div>
  <div class="bs4q-tn" data-role="tNote"></div>
</div>
<div data-role="quotas"></div>
<div class="bs4q-foot" data-role="foot"></div>`;
    }

    bar(pct) {
        const cls = pct >= 100 ? "bs4q-over" : (pct >= 80 ? "bs4q-warn" : "");
        // 宽度先留空，由 render() 在下一帧设为目标值，从而触发 CSS 过渡形成填充动画
        return `<div class="bs4q-bar"><i class="${cls}" data-pct="${pct.toFixed(2)}"></i></div>`;
    }

    quotaRow(label, usedText, capText, pct, remainText) {
        return `
<div class="bs4q-row">
  <div class="bs4q-rhead">
    <span class="bs4q-rlabel">${label}</span>
    <span class="bs4q-rpct">${pct.toFixed(1)}%</span>
  </div>
  ${this.bar(pct)}
  <div class="bs4q-rfoot">
    <span class="bs4q-rval">${usedText} / ${capText}</span>
    <span class="bs4q-rrem">${remainText}</span>
  </div>
</div>`;
    }

    render() {
        if (!this.panel) return;
        const q = (s) => this.panel.querySelector(s);
        const { mReq, mBytes, tReq, tBytes } = this.totals();

        q('[data-role="sub"]').textContent = this.config.buckets || "未配置";

        q('[data-role="tReq"]').textContent = fmtInt(tReq);
        q('[data-role="tBytes"]').textContent = fmtDec(tBytes);
        const tPctR = tReq / DAILY_REQ_CAP * 100;
        const tPctB = tBytes / DAILY_TRAFFIC_CAP * 100;
        q('[data-role="tNote"]').textContent =
            `占每日限额：请求 ${tPctR.toFixed(1)}%（上限 1 万次）· 流量 ${tPctB.toFixed(1)}%（上限 5 GB）`;

        const pReq = mReq / QUOTA.req * 100;
        const pBytes = mBytes / QUOTA.trafficBytes * 100;
        const sBytes = this.stats.storage.bytes || 0;
        const pStore = sBytes / QUOTA.storageBytes * 100;

        q('[data-role="quotas"]').innerHTML =
            this.quotaRow("API 请求数", fmtInt(mReq) + " 次", "10 万次",
                pReq, `剩余 ${fmtInt(Math.max(0, QUOTA.req - mReq))} 次`) +
            this.quotaRow("出口流量", fmtDec(mBytes), "10.0 GB",
                pBytes, `剩余 ${fmtDec(Math.max(0, QUOTA.trafficBytes - mBytes))}`) +
            this.quotaRow("存储容量", fmtBin(sBytes), "50.0 GiB",
                pStore, `剩余 ${fmtBin(Math.max(0, QUOTA.storageBytes - sBytes))}`);

        // 按钮加载态
        const btn = q('[data-act="refresh"]');
        if (btn) {
            btn.disabled = this.state.loading;
            btn.classList.toggle("bs4q-busy", this.state.loading);
            btn.textContent = this.state.loading ? "更新中" : "立即更新";
        }

        // 进度条填充动画：宽度先为空，下一帧再赋目标值以触发 CSS transition
        const bars = this.panel.querySelectorAll(".bs4q-bar > i");
        const paint = () => {
            for (const el of bars) {
                el.style.width = Math.min(100, parseFloat(el.getAttribute("data-pct"))) + "%";
            }
        };
        if (this.reducedMotion()) paint();
        else window.requestAnimationFrame(paint);

        const parts = [];
        if (this.state.error) parts.push(`<span class="bs4q-err">${this.state.error}</span>`);
        else if (this.state.lastSync) parts.push(`更新于 ${new Date(this.state.lastSync).toLocaleTimeString("zh-CN")}`);
        else parts.push("点「立即更新」获取数据");
        if (this.stats.storage.files) parts.push(`${fmtInt(this.stats.storage.files)} 个文件`);
        q('[data-role="foot"]').innerHTML = parts.join(" · ");
    }
}

// 测试接缝：暴露纯函数，便于在不安装思源的情况下做回归测试
BitifulS4Quota._b64url = b64url;
BitifulS4Quota._fmtDec = fmtDec;   // 流量：十进制
BitifulS4Quota._fmtBin = fmtBin;   // 存储：二进制
BitifulS4Quota._QUOTA = QUOTA;

module.exports = BitifulS4Quota;
