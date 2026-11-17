# Changelog

## 0.1.0 — 2026-11-17

- 首个版本。
- 多帧 zstd 会话日志解码：逐帧边界扫描，不依赖第三方解码器。
- SQLite 投影：`sessions` / `records` / `segments` / `replacements` / `timeline_events`。
- 三类事故标签：`user-rejected`、`plugin-error`、`runtime-http`。
- 带物理行号的 Markdown / JSON 导出，支持时间窗、标签、会话过滤。
- DSH host 路由与「事故时间线」对话视图面板。
- 独立预览页与演示服务器。
- 50 个测试，零运行时依赖。
