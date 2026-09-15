# server/ai/

自定义 AI（P2，B12~B16）。只依赖 L0/L1（`rng` / `unlock`），**不依赖 engine**。

| 文件 | 职责 |
|---|---|
| `ast.js` | 白名单 / 结构 / 深度 / 大小校验 + 合法性（D-101 分支 action 规则）+ 稳定路径 id + `canonicalize`/`programHash` |
| `runtime.js` | 显式状态机续执行（可序列化）、独立作用域 + 调用栈（D-102/103）、trace、`STEP_LIMIT` 兜底（返回 `wait`） |