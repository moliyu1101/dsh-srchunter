# `srchunter_add_goal` 的重置语义

`srchunter_add_goal` 会重置调用方所在会话的整张探索链路图。一次新的 goal 调用会清空该会话的
intents/facts/findings/assets/edges，并让确定性计数器从 `<kind>-1` 重新开始计数。

- 会话里任何能用到工具的 agent 都能触发这次清空——把它当成一次高权限的破坏性操作来对待。
- 想留存数据，就在重置前先用 `srchunter_state` / `srchunter_graph` / `srchunter_report` 导出。
- 跨会话隔离依然成立：重置绝不触碰其他会话的行（键是 `sessionId:id`）。

另需注意：sqlite 后端按 unit 名+版本登记，域名或库文件名换了就是另一份库——旧库不会被读取、也不会自动
搬迁，名字不一致的库直接拒绝打开。

实现见 `src/dsh-srchunter/src/store.ts` 的 `clearSession` / `initGoal`，
以及 `src/dsh-srchunter/README.md` 的「工具」一节。
