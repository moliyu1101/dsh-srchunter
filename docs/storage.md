## 存储说明

- bundle 只装一个 sqlite 后端，落在 `dshHomePath('storages','srchunter-sessions.db')`，
  并且只把 `srchunter` 域路由到它；其他存储域继续用宿主的 `json` 后端。
- 需要 Node.js 的 `node:sqlite`（宿主运行时 >= 22.5）。
- 每条记录以 `sessionId:id` 为键；`srchunter_add_goal` 只清空调用方所在会话的行。
