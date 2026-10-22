# 角色生活模拟

导入一张角色卡（酒馆卡 PNG / JSON，或页面上自己写），让这个角色一段一段地过下去；观看者用「故事走向」调整接下来的生活。题目见 [docs/task.md](docs/task.md)，术语见 [CONTEXT.md](CONTEXT.md)，怎么做的见 [docs/implementation.md](docs/implementation.md)。

## 运行

需要 Node.js 22.9+，没有任何 npm 依赖。

```bash
cp .env.example .env   # 填 DOUBAO_API_KEY（火山方舟按量 /api/v3）
npm start              # http://127.0.0.1:3000
```

没有 key 也能看界面：先 `node mock-ark.js 4100`，再 `ARK_BASE_URL=http://127.0.0.1:4100 DOUBAO_API_KEY=x npm start`。

测试：`npm test`。

## 题目要求对照

| 要求 | 做法 |
| --- | --- |
| 1. 连续、一段段、100 段以上 | 每段是一个新的生活片段，带小标题和故事内时间，和上一段通常隔几天到几周。写第 N 段时给模型人设 + 故事笔记 + 最近 3 段原文；每写完一段用 lite 模型更新故事笔记（人物关系、地点、没收的线头、大事记），所以输入长度不随段数增长。周建国一条写了 105 段，见下方样例。 |
| 2. 符合角色设定、走向可控 | 人设、性格、处境、世界书都进提示词；`{{user}}` 改成一个普通配角，观看者不进故事。 |
| 3. 故事走向起作用 | 走向分两种：**基调**（标签 + 一句话，一直生效直到改掉，管整体感觉）和**事件**（只管下一段，写完清空，不会被反复写）。每段记下自己是在哪个基调和事件下写的。同一角色可以开两条线，在「对比两个故事」里并排看。 |
| 4. 有吸引力 | 文体可选小说或日记；提示词要求用事情演性格、不断引入新的人和麻烦、有起有落、段尾留余味。 |
| 5. 3–5 个角色 | `cards/` 里自带 3 张差异大的卡（上海广告文案 / 北宋说书女先生 / 东北退休老工人），另用 2 张公开酒馆卡测了 PNG 导入，共 5 个角色、6 条故事。 |
| 6. 可交互演示 | 本地网页：导入卡、建故事、下一段（流式）、连续写 N 段、停止、重写最后一段、改走向、看故事笔记、导出 Markdown。 |

## 样例

`samples/` 里是用真实方舟跑出来的 6 条故事，每段都标了故事内时间、基调和事件。

| 文件 | 角色 · 卡的来源 | 文体 · 基调 | 段数 | 故事内时间 |
| --- | --- | --- | --- | --- |
| [zhou-jianguo-105.md](samples/zhou-jianguo-105.md) | 周建国 · 自写 | 小说 · 治愈 → 虐心（第 26 段起）→ 治愈、甜（第 51 段起）→ 冒险（第 76 段起） | 105 | 11月12日 → 两年多后的四月二十日 |
| [lin-wan-healing.md](samples/lin-wan-healing.md) | 林晚 · 自写 | 小说 · 治愈 | 20 | 3月12日 → 6月18日 |
| [lin-wan-heartbreak.md](samples/lin-wan-heartbreak.md) | 林晚 · 自写 | 小说 · 虐心 | 20 | 3月12日 → 4月28日 |
| [su-xiaoman-diary.md](samples/su-xiaoman-diary.md) | 苏小满 · 自写，带世界书 | 日记 · 冒险、悬疑 | 25 | 三月初六 → 三月二十八 |
| [seraphina.md](samples/seraphina.md) | Seraphina · 公开卡 | 小说 · 治愈、冒险 | 20 | 第 1 天 → 第 14 天 |
| [lara-lightland.md](samples/lara-lightland.md) | Lara Lightland · 公开卡，英文 | 小说 · 悬疑、日常 | 20 | 10月17日 → 12月12日 |

看走向的效果：林晚两条线第 1 段相同，从第 2 段起分开；周建国第 26 段、第 51 段准时写到了预设的事件（刘阿姨住院、女儿突然回家）。

公开卡没有放进仓库，要复现请自己下载后放进 `cards/`：[Seraphina](https://github.com/SillyTavern/SillyTavern/blob/release/default/content/default_Seraphina.png)（SillyTavern 官方默认卡）、[Lara Lightland](https://chub.ai/characters/shaolan98/lara-lightland)（chub.ai）。

已知不足：部分段落超过 800 字（周建国 105 段里有 52 段）；英文卡偶尔漏出英文词；故事笔记实测 1000–2200 字，超过提示里写的 800 字，但不随段数一直增长；「冒险」「悬疑」基调在高潮时会把几段挤在一两天里。

## 结构

- `server.js`：HTTP 接口和存储（`data/stories/<id>.json`）
- `story.js`：提示词、方舟调用、写一段 / 重写
- `card.js`：酒馆卡 PNG（`ccv3` / `chara` 文本块）与 JSON V1/V2/V3 解析
- `public/index.html`：页面
- `mock-ark.js`、`test.js`：假方舟和测试

模型走火山方舟 OpenAI 兼容接口：写段 `doubao-seed-2-0-pro`，更新笔记 `doubao-seed-2-0-lite`，都关闭深度思考。
