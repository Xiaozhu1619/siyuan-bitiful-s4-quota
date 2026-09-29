# 开发与发布说明

> 这份是给维护者看的。用户请看 [README_zh_CN.md](README_zh_CN.md)。

## 目录结构

```
plugin.json            插件清单（集市读取）
index.js               插件主体，纯 JS 零构建
index.css              面板样式
icon.png               图标 160×160（由 tests/make_icon.py 生成）
preview.png            预览图 1024×768
i18n/                  多语言
tests/
  integration.test.js  集成测试：模拟思源宿主 + 真实调 API
  make_icon.py         程序化生成 icon.png
build.py               打包 package.zip
```

## 本地测试

在 Node 里模拟思源宿主环境（注入 `require("siyuan")` + 模拟内核正向代理），
**打真实 API**，共 34 项断言：

```bash
BITIFUL_TOKEN=your_token BITIFUL_BUCKET=your_bucket node tests/integration.test.js
```

覆盖：加载契约（`exports` 可实例化、`prototype instanceof Plugin`）、
十进制/二进制单位不混用、首次回填、增量游标不重复计数、额度占比、多桶合并、错误路径。

## 重新生成图标

```bash
python tests/make_icon.py     # 纯标准库，无需 Pillow
```

## 发布新版本

1. **改版本号**：编辑 `plugin.json` 的 `version`（遵循 semver）。
2. **打包**：
   ```bash
   python build.py
   ```
   产出 `package.zip`（已加进 `.gitignore`，不进版本库）。
3. **提交并打标签**：
   ```bash
   git add -A
   git commit -m "feat: ..."
   git tag -a v0.2.0 -m "v0.2.0"
   git push origin main --tags
   ```
4. **建 Release**：在 GitHub 上以该 tag 建 Release，**把 `package.zip` 作为二进制附件上传**。
   集市是通过 Release 附件取包的，只推代码不建 Release 不会生效。
5. 首次发布还需要向 [siyuan-note/bazaar](https://github.com/siyuan-note/bazaar) 提一个 PR，
   在 `plugins.txt` 里**新增一行** `Xiaozhu1619/siyuan-bitiful-s4-quota`。
   之后更新版本无需再提 PR，集市约每小时自动更新索引。

## 技术要点（改代码前先看）

- **跨域**：缤纷云 API 不返回任何 CORS 头、`OPTIONS` 预检 404，插件前端不能直接 `fetch`。
  所有请求必须经思源内核正向代理 `/api/network/proxy`，
  参数 `u`/`h` 用 **Go `base64.RawURLEncoding`**（URL 安全、无 `=` 补位）。
- **日志窗口**：缤纷云日志只保留约 3 天，超出返回 **HTTP 403**（不是 404 也不是空数组），
  要当正常终止处理。因此用每桶游标增量累积本地日账。
- **分页语义**：`start_time` 是**上界**、结果**时间倒序**，
  翻页游标取本页最旧一条的 `access_time - 1`。
- **单位**：流量**十进制**（1 GB = 1000 MB），存储**二进制**（1 GiB = 1024³ B）。不可混用。
- **额度按账户汇总**，不是按桶，所以支持多桶合并统计。
- **移动端**：`addTopBar` 的 `element` 形式在移动端被禁用，必须用 `icon` 形式；
  入口会渲染成顶栏插件菜单里的菜单项。
- **动画陷阱**：不要给内容块加 `animation-fill-mode: backwards` 的淡入——
  刷新会重建 `innerHTML`，导致元素在动画开始前停在 `opacity:0`，看起来像丢数据。
- **CSS 自包含**：面板自带 `box-sizing: border-box` 重置，不依赖宿主是否设置。
