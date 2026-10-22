# 实现方案

需求见 [task.md](./task.md)，术语见 [../CONTEXT.md](../CONTEXT.md)。

## 形态

- 本地 Node 服务（`node:http` + `fetch`，零依赖）+ 一个网页。key 只在服务端 `.env`。
- 故事存为 `data/stories/<id>.json`：角色卡、各段（带基调、事件、故事内时间）、故事笔记、当前基调、文体。

## 模型（火山方舟，沿用 master-app 的接法）

- `POST $ARK_BASE_URL/chat/completions`，`Authorization: Bearer $DOUBAO_API_KEY`，OpenAI 兼容。
- 只用按量 `/api/v3`，不用 Coding Plan `/api/coding/v3`。
- 写段：`ARK_MODEL=doubao-seed-2-0-pro-260215`，流式；更新故事笔记：`ARK_NOTES_MODEL=doubao-seed-2-0-lite-260215`。两者都带 `thinking: {type: "disabled"}`。
- key 用个人火山账号。

## 写一段

输入：人设（含世界书）+ 文体 + 故事笔记 + 最近 3 段原文 + 当前基调 + 事件（有就带）。
输出流式显示；写完存段，清空事件，再用 lite 模型更新故事笔记。写失败不存、不更新笔记。

## 角色卡

- 酒馆卡 PNG（读 `chara` / `ccv3` 文本块）、JSON（V1/V2/V3 归一化）、页面表单自定义卡。
- 导入时给 `{{user}}` 起名，成为配角；`{{char}}` 换成角色名。
- 开篇按人设和 `scenario` 重写，`first_mes` 只作参考。

## 页面操作

下一段（流式）、连续写 N 段（可停）、重写最后一段、改基调、填事件、看故事笔记。
加分项：同一角色两个故事并排对比。不做：从任意段回退、社交媒体文体。

## 测试与证据

- 自写 3 张差异大的卡 + 2 张公开全年龄酒馆卡 PNG。
- 1 个角色跑到 100+ 段，其余各 20–30 段；同一角色「治愈」vs「虐心」各 20 段做对比。
- 导出为 `samples/` 下的 Markdown，提交进仓库。

## 重写

基调用当前的；事件沿用被重写那段原来的，观看者此刻填了新事件就用新的。重写同时作废那段带来的笔记更新：每段存下写它之前的故事笔记，重写时从那份笔记重新更新。

## 语言

故事一律中文，英文卡也写中文故事。
