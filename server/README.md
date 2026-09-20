# server/

后端。分层见 `tasks.md` §2.1：

| 路径 | 内容 | 批次 |
|---|---|---|
| `core/` | 确定性内核（纯函数，L11） | B1~B11 |
| `ai/` | AI 解释器（只依赖 L0/L1） | B12~B16 |
| `data/` | 数据表 + schema 校验 | P0-6 |
| `index.js` | `/api/v1` HTTP 层 + **`public/` 只读静态托管（P6/F1）** | P0-8 / F1 |
| `ranked.js` | 排位（快照/匹配/晋升） | P5 |
| `store/` | 存储层（唯一允许 `node:fs` 的目录） | P7/B27 |

> D-123：本轮不做存档，无 `store.js`（已由 D-129 的 `store/` 取代）。
>
> F1（`docs/frontend/01-auth.md` §9）：静态托管只服务 `public/`、仅 `GET`、扩展名白名单（`.html/.js/.css/.json/.svg/.ico`）+ 穿越防护；静态分支只在路由表未命中时尝试，`/api/v1/*` 与全部动态路由语义不变；`public/` 不存在时行为与改动前一致。`start({publicDir})` 可覆盖静态根（测试缝）。