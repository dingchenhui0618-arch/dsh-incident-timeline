# Changelog

## 0.1.1 — 2026-11-20

- **修复：**唯一那条 fenced 路由现在真的过 DSH 的浏览器信任栅栏（`ctx.connection.requestRejection`）——`Host`/`Origin` 不是这台 DSH 的返回 403，没有浏览器会话 cookie 返回 401；被拒的请求在打开投影库之前就返回，不会触发同步。`inject` 增加 `connection`。
- README 的 curl 示例改成带 `dsh-auth-*` cookie 的写法。
- 测试：栅栏 401/403 与「被拒请求不开投影」各一条，共 51 个测试。

## 0.1.0 — 2026-11-17

- 首个版本。
- 多帧 zstd 会话日志解码：逐帧边界扫描，不依赖第三方解码器。
- SQLite 投影：`sessions` / `records` / `segments` / `replacements` / `timeline_events`。
- 三类事故标签：`user-rejected`、`plugin-error`、`runtime-http`。
- 带物理行号的 Markdown / JSON 导出，支持时间窗、标签、会话过滤。
- DSH host 路由与「事故时间线」对话视图面板。
- 独立预览页与演示服务器。
- 50 个测试，零运行时依赖。
