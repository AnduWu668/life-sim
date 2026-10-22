// 写一段：拼提示词 → 方舟流式写段 → lite 模型更新故事笔记。纯函数，不碰存储。

const STYLE_RULES = {
  小说: '第三人称小说。要有具体场景、动作、对话和细节，用情节推动，少用概括。',
  日记: `角色本人写的第一人称日记。私密、真诚，有当天的琐事，也有情绪起伏和没说出口的话。`,
}

const SEGMENT_SYSTEM = style => `你是一位中文连载作者，正在为一个角色写 TA 的生活故事。读者只是旁观者，不在故事里。

写作要求：
- 文体：${STYLE_RULES[style]}
- 每段 400–800 字，不要超过 800 字。
- 每段是角色生活里一个新的片段：一件事、一个人或一个转折。和上一段之间通常隔几天到几周，换场景、换人、换事；同一个场景最多连着写两段，不要把一个下午拆成很多段。
- 承接前文：人物、关系、地点、已发生的事保持一致；故事内时间只往后走。
- 言行符合人设。不要复述人设，用事情把性格演出来。
- 不断引入新的人、新的地方、新的麻烦；不要重复前几段的情节套路。生活要有起有落，让读者跟着难过、开心或被治愈。
- 段尾留一点余味或悬念（没说出口的念头、还没结果的事），让人想看下一段；但下一段不必从那里直接接着写。
- 不对读者说话，不写「你」，不写作者旁白或总结。
- 一律用中文写。设定是英文时，地名、物品、生物、衣着等全部译成中文（如 glade→林间空地），正文里不要夹英文单词；人名可以音译或保留原文。

输出格式（严格遵守，不要输出别的）：
标题：<不超过 12 个字>
时间：<故事内时间，如「第 3 天·傍晚」或「1998 年 4 月 2 日」>
<正文>`

const NOTES_SYSTEM = `你在维护一部连载故事的笔记，供作者写后续时查阅。根据【旧笔记】和【新的一段】输出更新后的完整笔记，格式：

当前时间：<故事内最新时间>
人物：<每人一行：名字——和主角的关系、最近状态>
地点：<重要或常去的地方，一行>
未收的线头：<还没有结果的事、埋下的伏笔，每条一行；已经解决的删掉>
已发生的大事：<按时间顺序，每条一句，最多 15 条，旧的合并压缩>

只写事实，不评价。总长度不超过 800 字，超出就合并压缩次要内容。只输出笔记本身。`

const RECENT = 3
const WORLD_BOOK_MAX = 6000 // ponytail: 世界书整体截断，条目多到超出时再做关键词触发

export async function chat(model, messages, { onDelta, signal, maxTokens } = {}) {
  const key = process.env.DOUBAO_API_KEY
  if (!key) throw new Error('没有配置 DOUBAO_API_KEY（见 .env.example）')
  const base = process.env.ARK_BASE_URL || 'https://ark.cn-beijing.volces.com/api/v3'
  let res
  // 建连失败（方舟偶发断开复用的连接）重试两次；已经开始输出后断了就算写失败，不重试
  for (let attempt = 1; !res; attempt++) {
    try {
      res = await fetch(`${base}/chat/completions`, {
        method: 'POST',
        headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
        body: JSON.stringify({ model, messages, stream: !!onDelta, max_tokens: maxTokens, thinking: { type: 'disabled' } }),
        signal: AbortSignal.any([signal, AbortSignal.timeout(90_000)].filter(Boolean)),
      })
    } catch (e) {
      if (signal?.aborted || attempt === 3) throw new Error(`连不上方舟：${e.cause?.code || e.cause?.message || e.message}`)
      await new Promise(r => setTimeout(r, 1000 * attempt))
    }
  }
  if (!res.ok) throw new Error(`方舟返回 ${res.status}：${(await res.text()).slice(0, 300)}`)
  if (!onDelta) return finish((await res.json()).choices?.[0])

  let text = '', buf = '', reason
  const decoder = new TextDecoder()
  for await (const chunk of res.body) {
    buf += decoder.decode(chunk, { stream: true })
    let i
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i).trim()
      buf = buf.slice(i + 1)
      if (!line.startsWith('data:') || line === 'data: [DONE]') continue
      const choice = JSON.parse(line.slice(5)).choices?.[0]
      const delta = choice?.delta?.content
      if (delta) {
        text += delta
        onDelta(delta)
      }
      reason = choice?.finish_reason ?? reason
    }
  }
  return finish({ message: { content: text }, finish_reason: reason })
}

function finish(choice) {
  if (choice?.finish_reason === 'content_filter') throw new Error('内容被模型拒绝')
  return choice?.message?.content ?? ''
}

export function parseSegment(text) {
  const lines = text.trim().split('\n')
  const head = {}
  let m
  while (lines.length && (m = lines[0].replace(/[*#]/g, '').trim().match(/^(标题|时间)[:：]\s*(.*)$/))) {
    head[m[1]] = m[2].trim()
    lines.shift()
  }
  const body = lines.join('\n').trim().replace(/^(<正文>|正文[:：])\s*/, '') // 模型偶尔把格式占位符抄进来
  if (body.length < 100) throw new Error('这一段太短，可能被截断或被拒绝')
  return { title: head.标题 ?? '', time: head.时间 ?? '', body }
}

const toneLine = tone =>
  [tone.tags.join('、'), tone.text].filter(Boolean).join('；') || '不限，顺着人设自然发展'

function segmentMessages(story, base, notes, event, n) {
  const c = story.card
  const persona = [
    `名字：${c.name}`,
    c.description && `描述：${c.description}`,
    c.personality && `性格：${c.personality}`,
    c.scenario && `处境：${c.scenario}`,
    c.worldBook.length && `世界设定：\n${c.worldBook.join('\n').slice(0, WORLD_BOOK_MAX)}`,
    c.mesExample && `说话方式示例（只参考语气）：\n${c.mesExample}`,
    c.firstMes && `卡里的开场白（只参考，不要照搬）：\n${c.firstMes}`,
    `设定里提到的「${story.userName}」是角色生活里的一个普通配角，可以出场也可以不出场。`,
  ].filter(Boolean)
  const recent = base
    .slice(-RECENT)
    .map(s => `第 ${s.n} 段 ${s.title}（${s.time}）\n${s.body}`)
    .join('\n\n')
  const parts = [
    `【角色】\n${persona.join('\n')}`,
    notes && `【故事笔记】\n${notes}`,
    recent && `【最近几段】\n${recent}`,
    `【故事走向】\n基调：${toneLine(story.tone)}（接下来故事的整体感觉往这个方向走）` +
      (event ? `\n本段事件：${event}（这一段必须写到这件事）` : ''),
    n === 1
      ? '请写第 1 段，也就是开篇：从一个具体场景切入，让读者认识角色此刻的生活处境。'
      : `请写第 ${n} 段。上一段的故事内时间是「${base.at(-1).time}」，这一段要往后跳。`,
  ].filter(Boolean)
  return [
    { role: 'system', content: SEGMENT_SYSTEM(story.style) },
    { role: 'user', content: parts.join('\n\n') },
  ]
}

const notesMessages = (notes, seg) => [
  { role: 'system', content: NOTES_SYSTEM },
  { role: 'user', content: `【旧笔记】\n${notes || '（还没有）'}\n\n【新的一段】第 ${seg.n} 段 ${seg.title}（${seg.time}）\n${seg.body}` },
]

// 重写：换掉最后一段，笔记从那段之前的版本重新更新；事件沿用那段的，除非观看者填了新的。
export async function writeSegment(story, { rewrite = false, onDelta = () => {}, signal } = {}) {
  const last = story.segments.at(-1)
  if (rewrite && !last) throw new Error('还没有可以重写的段')
  const base = rewrite ? story.segments.slice(0, -1) : story.segments
  const notesBefore = rewrite ? last.notesBefore : story.notes
  const event = story.event || (rewrite ? last.event : '')
  const n = base.length + 1

  const model = process.env.ARK_MODEL || 'doubao-seed-2-0-pro-260215'
  const text = await chat(model, segmentMessages(story, base, notesBefore, event, n), { onDelta, signal, maxTokens: 2048 })
  const seg = { n, ...parseSegment(text), tone: story.tone, event, notesBefore }

  const notesModel = process.env.ARK_NOTES_MODEL || 'doubao-seed-2-0-lite-260215'
  const notes = await chat(notesModel, notesMessages(notesBefore, seg), { signal, maxTokens: 1500 })
  return { segments: [...base, seg], notes: notes.trim() }
}

export function toMarkdown(story) {
  const out = [`# ${story.card.name}的生活（${story.style}）`, '', `角色卡：${story.cardId} · 共 ${story.segments.length} 段`, '']
  for (const s of story.segments) {
    out.push(`## 第 ${s.n} 段 · ${s.title}`, '', `*${s.time} ｜ 基调：${toneLine(s.tone)}${s.event ? ` ｜ 事件：${s.event}` : ''}*`, '', s.body, '')
  }
  return out.join('\n')
}
