# scripts/

构建与门禁脚本（**单进程内联**，沙箱禁 `child_process`）：

| 文件 | 内容 | 批次 |
|---|---|---|
| `gate.js` | 9 项门禁（`tasks.md` §3.4），任一失败即非零退出 | P0-5 |
| `check-arch.js` | 依赖方向 / 循环依赖 / core 越界引用检查 | P0-5 |
| `demo.js` | 跑一场战斗打印逐 tick 摘要；支持 `--log-level trace`（等价 `DL_LOG_LEVEL=trace`） | B11 |