import { after, before, test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fillMacros, readCardFile } from './card.js'
import { parseSegment, writeSegment } from './story.js'
import { startMockArk } from './mock-ark.js'

// 拼一个只有 tEXt 块的 PNG（解析器不校验 CRC 和图像数据）
function png(texts) {
  const chunk = (type, data) => {
    const len = Buffer.alloc(4)
    len.writeUInt32BE(data.length)
    return Buffer.concat([len, Buffer.from(type, 'latin1'), data, Buffer.alloc(4)])
  }
  const tEXt = Object.entries(texts).map(([k, v]) =>
    chunk('tEXt', Buffer.from(`${k}\0${Buffer.from(JSON.stringify(v)).toString('base64')}`, 'latin1')),
  )
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', Buffer.alloc(13)), ...tEXt, chunk('IEND', Buffer.alloc(0))])
}

test('酒馆卡 PNG：优先读 ccv3，世界书只收启用的条目', () => {
  const card = readCardFile(
    png({
      chara: { spec: 'chara_card_v2', data: { name: '旧版' } },
      ccv3: { spec: 'chara_card_v3', data: { name: '新卡', description: '描述', character_book: { entries: [{ content: '世界' }, { content: '关掉的', enabled: false }] } } },
    }),
    'x.png',
  )
  assert.equal(card.name, '新卡')
  assert.deepEqual(card.worldBook, ['世界'])
})

test('V1 JSON 字段归一化；不是角色卡就报错', () => {
  const card = readCardFile(Buffer.from(JSON.stringify({ char_name: '老卡', char_persona: '人设', char_greeting: '你好' })), 'x.json')
  assert.equal(card.name, '老卡')
  assert.equal(card.description, '人设')
  assert.equal(card.firstMes, '你好')
  assert.throws(() => readCardFile(Buffer.from('{}'), 'x.json'), /缺少名字/)
  assert.throws(() => readCardFile(Buffer.from('not png'), 'x.png'), /不是 PNG/)
})

test('宏替换：{{user}} 变配角名，名字里的 $ 不被当成替换模式', () => {
  const c = fillMacros({ name: 'A$&', description: '{{user}}遇见{{char}}，<USER>', worldBook: ['{{CHAR}}'] }, '阿远')
  assert.equal(c.description, '阿远遇见A$&，阿远')
  assert.deepEqual(c.worldBook, ['A$&'])
})

test('parseSegment：去掉标题和时间行，容忍 markdown 加粗', () => {
  const s = parseSegment(`**标题：雨夜**\n时间：第 3 天·夜\n${'正文'.repeat(60)}`)
  assert.equal(s.title, '雨夜')
  assert.equal(s.time, '第 3 天·夜')
  assert.ok(s.body.startsWith('正文'))
  assert.ok(parseSegment(`标题：雨夜\n时间：第 3 天\n<正文>\n${'雨'.repeat(120)}`).body.startsWith('雨'))
  assert.throws(() => parseSegment('标题：短\n太短了'), /太短/)
})

let mock
before(async () => {
  mock = await startMockArk()
  process.env.ARK_BASE_URL = mock.url
  process.env.DOUBAO_API_KEY = 'test'
})
after(() => mock.server.close())

const newStory = event => ({
  card: fillMacros(readCardFile(readFileSync('cards/lin-wan.json'), 'lin-wan.json'), '阿远'),
  style: '小说',
  userName: '阿远',
  tone: { tags: ['治愈'], text: '慢慢好起来' },
  event,
  notes: '',
  segments: [],
})

test('写一段：基调和事件进提示词，流式输出，笔记随之更新', async () => {
  mock.requests.length = 0
  const deltas = []
  const r = await writeSegment(newStory('她捡到一只猫'), { onDelta: d => deltas.push(d) })
  const [seg] = r.segments
  assert.equal(seg.n, 1)
  assert.equal(seg.title, '第 1 段的事')
  assert.equal(seg.event, '她捡到一只猫')
  assert.equal(seg.notesBefore, '')
  assert.equal(r.notes, '当前时间：第 1 天\n笔记到第 1 段')
  assert.ok(deltas.length > 1)
  const prompt = mock.requests[0].messages[1].content
  assert.match(prompt, /本段事件：她捡到一只猫/)
  assert.match(prompt, /基调：治愈；慢慢好起来/)
  assert.match(prompt, /开篇/)
  assert.doesNotMatch(prompt, /\{\{user\}\}/)
  assert.deepEqual(mock.requests[0].thinking, { type: 'disabled' })
})

test('重写：沿用那段的事件，笔记从那段之前的版本重新更新；填了新事件就用新的', async () => {
  const s1 = await writeSegment(newStory('她捡到一只猫'))
  const s2 = await writeSegment({ ...newStory(''), ...s1 })
  assert.equal(s2.segments[1].notesBefore, s1.notes)

  mock.requests.length = 0
  const re = await writeSegment({ ...newStory(''), ...s2 }, { rewrite: true })
  assert.equal(re.segments.length, 2)
  assert.equal(re.segments[1].notesBefore, s1.notes)
  assert.match(mock.requests[1].messages[1].content, /【旧笔记】\n当前时间：第 1 天/)

  const first = await writeSegment({ ...newStory(''), ...s1 }, { rewrite: true })
  assert.equal(first.segments[0].event, '她捡到一只猫')
  const changed = await writeSegment({ ...newStory('她搬家了'), ...s1 }, { rewrite: true })
  assert.equal(changed.segments[0].event, '她搬家了')
  await assert.rejects(writeSegment(newStory(''), { rewrite: true }), /没有可以重写/)
})

test('建连被断开：自动重试后照常写完', async () => {
  mock.server.mode = 'drop-once'
  const r = await writeSegment(newStory(''))
  assert.equal(r.segments.length, 1)
})

test('写失败：方舟报错或内容被拒都抛出', async () => {
  mock.server.mode = 'fail'
  await assert.rejects(writeSegment(newStory('')), /方舟返回 500/)
  mock.server.mode = 'filter'
  await assert.rejects(writeSegment(newStory(''), { onDelta() {} }), /被模型拒绝/)
  mock.server.mode = undefined
})
