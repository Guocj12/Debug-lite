# shared/

**L-1 层：唯一允许的跨层共享模块**（`tasks.md` §2.1 分层）。

- `log.js`（P0-4 落地）：零依赖 UMD 日志——Node `require` 与浏览器 `window.DLLog` 双入口。
- 约定：除本目录外，任何跨层共享一律禁止（`scripts/check-arch.js` 检查项）。