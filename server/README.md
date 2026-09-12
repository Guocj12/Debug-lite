# server/

后端。分层见 `tasks.md` §2.1：

| 路径 | 内容 | 批次 |
|---|---|---|
| `core/` | 确定性内核（纯函数，L11） | B1~B11 |
| `ai/` | AI 解释器（只依赖 L0/L1） | B12~B16 |
| `data/` | 数据表 + schema 校验 | P0-6 |
| `index.js` | `/api/v1` HTTP 层 | P0-8 |
| `ranked.js` | 排位（快照/匹配/晋升） | P5 |

> D-123：本轮不做存档，无 `store.js`。