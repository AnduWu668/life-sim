import http from 'node:http'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { mkdir, readFile, readdir, rename, writeFile } from 'node:fs/promises'
import { fillMacros, readCardFile } from './card.js'
import { toMarkdown, writeSegment } from './story.js'

const ROOT = import.meta.dirname
const CARDS = path.join(ROOT, 'cards')
const STORIES = path.join(ROOT, 'data', 'stories')
const PORT = Number(process.env.PORT) || 3000
const busy = new Set() // 正在写的故事 id

await mkdir(STORIES, { recursive: true })

const httpError = (status, message) => Object.assign(new Error(message), { status })

function json(res, data, status = 200) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' })
  res.end(JSON.stringify(data))
}

async function readBody(req, limit = 10 << 20) {
  const chunks = []
  let size = 0
  for await (const c of req) {
    if ((size += c.length) > limit) throw httpError(413, '文件太大')
    chunks.push(c)
  }
  return Buffer.concat(chunks)
}

const readJson = async req => JSON.parse((await readBody(req, 1 << 20)).toString('utf8') || '{}')

function cardPath(id) {
  if (typeof id !== 'string' || path.basename(id) !== id || !/\.(png|json)$/i.test(id)) throw httpError(400, '无效的角色卡')
  return path.join(CARDS, id)
}

function storyPath(id) {
  if (!/^[\w-]+$/.test(id)) throw httpError(400, '无效的故事 id')
  return path.join(STORIES, `${id}.json`)
}

const loadStory = async id => JSON.parse(await readFile(storyPath(id), 'utf8'))

async function saveStory(story) {
  const p = storyPath(story.id)
  await writeFile(`${p}.tmp`, JSON.stringify(story, null, 1))
  await rename(`${p}.tmp`, p)
}

function cleanTone(t = {}) {
  const tags = Array.isArray(t.tags) ? t.tags.filter(x => typeof x === 'string').map(x => x.slice(0, 10)).slice(0, 6) : []
  return { tags, text: typeof t.text === 'string' ? t.text.trim().slice(0, 200) : '' }
}

async function listCards(req, res) {
  const cards = []
  for (const id of (await readdir(CARDS)).filter(f => /\.(png|json)$/i.test(f)).sort()) {
    try {
      const c = readCardFile(await readFile(path.join(CARDS, id)), id)
      cards.push({ id, name: c.name, intro: fillMacros(c, '{{user}}').description.slice(0, 80) })
    } catch (e) {
      console.warn(`跳过 ${id}：${e.message}`)
    }
  }
  json(res, cards)
}

// 导入：原文件存进 cards/，酒馆卡和自定义卡（V2 JSON）走同一条路。
async function uploadCard(req, res, url) {
  const ext = path.extname(url.searchParams.get('name') || '').toLowerCase()
  if (ext !== '.png' && ext !== '.json') throw httpError(400, '只支持 .png 或 .json 角色卡')
  const buf = await readBody(req)
  let card
  try {
    card = readCardFile(buf, ext)
  } catch (e) {
    throw httpError(400, `读不出角色卡：${e.message}`)
  }
  const id = `${Date.now()}-${card.name.replace(/[^\p{L}\p{N}_-]/gu, '').slice(0, 20) || 'card'}${ext}`
  await writeFile(cardPath(id), buf)
  json(res, { id, name: card.name }, 201)
}

async function listStories(req, res) {
  const list = []
  for (const f of (await readdir(STORIES)).filter(f => f.endsWith('.json'))) {
    const s = JSON.parse(await readFile(path.join(STORIES, f), 'utf8'))
    list.push({ id: s.id, name: s.card.name, style: s.style, tone: s.tone, count: s.segments.length, updatedAt: s.updatedAt })
  }
  json(res, list.sort((a, b) => b.updatedAt - a.updatedAt))
}

async function createStory(req, res) {
  const { cardId, style, userName, tone } = await readJson(req)
  if (style !== '小说' && style !== '日记') throw httpError(400, '文体只能是小说或日记')
  const name = (typeof userName === 'string' && userName.trim().slice(0, 20)) || '阿远'
  const card = fillMacros(readCardFile(await readFile(cardPath(cardId)), cardId), name)
  const now = Date.now()
  const story = { id: randomUUID(), cardId, card, style, userName: name, tone: cleanTone(tone), event: '', notes: '', segments: [], createdAt: now, updatedAt: now }
  await saveStory(story)
  json(res, story, 201)
}

async function patchStory(req, res, url, id) {
  const body = await readJson(req)
  const story = await loadStory(id)
  if ('tone' in body) story.tone = cleanTone(body.tone)
  if ('event' in body) story.event = typeof body.event === 'string' ? body.event.trim().slice(0, 300) : ''
  await saveStory(story)
  json(res, story)
}

// 流式写一段（NDJSON：{delta} … 然后 {story} 或 {error}）。写失败什么都不存。
async function write(req, res, url, id, kind) {
  if (busy.has(id)) throw httpError(409, '这个故事正在写')
  const story = await loadStory(id)
  busy.add(id)
  const ac = new AbortController()
  res.on('close', () => ac.abort()) // 观看者点停止 = 断开连接 = 这一段作废
  res.writeHead(200, { 'content-type': 'application/x-ndjson; charset=utf-8' })
  const send = o => !res.destroyed && res.write(JSON.stringify(o) + '\n')
  try {
    const { segments, notes } = await writeSegment(story, { rewrite: kind === 'rewrite', onDelta: delta => send({ delta }), signal: ac.signal })
    // 写的时候观看者可能改了走向：以磁盘上最新的为准，只有用掉的那条事件才清空
    const fresh = await loadStory(id)
    const saved = { ...fresh, segments, notes, event: fresh.event === story.event ? '' : fresh.event, updatedAt: Date.now() }
    await saveStory(saved)
    send({ story: saved })
  } catch (e) {
    if (!ac.signal.aborted) console.warn(`[${id}] 写失败：${e.message}`, e.cause?.code ?? '')
    send({ error: ac.signal.aborted ? '已停止' : e.message })
  } finally {
    busy.delete(id)
    res.end()
  }
}

async function exportStory(req, res, url, id) {
  res.writeHead(200, { 'content-type': 'text/markdown; charset=utf-8' })
  res.end(toMarkdown(await loadStory(id)))
}

async function index(req, res) {
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
  res.end(await readFile(path.join(ROOT, 'public', 'index.html')))
}

const routes = [
  ['GET', /^\/$/, index],
  ['GET', /^\/api\/cards$/, listCards],
  ['POST', /^\/api\/cards$/, uploadCard],
  ['GET', /^\/api\/stories$/, listStories],
  ['POST', /^\/api\/stories$/, createStory],
  ['GET', /^\/api\/stories\/([\w-]+)$/, async (req, res, url, id) => json(res, await loadStory(id))],
  ['PATCH', /^\/api\/stories\/([\w-]+)$/, patchStory],
  ['POST', /^\/api\/stories\/([\w-]+)\/(next|rewrite)$/, write],
  ['GET', /^\/api\/stories\/([\w-]+)\.md$/, exportStory],
]

http
  .createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost')
    try {
      for (const [method, re, fn] of routes) {
        const m = url.pathname.match(re)
        if (m && req.method === method) return await fn(req, res, url, ...m.slice(1))
      }
      throw httpError(404, '没有这个地址')
    } catch (e) {
      if (res.headersSent) return res.end()
      const status = e.status ?? (e.code === 'ENOENT' ? 404 : e instanceof SyntaxError ? 400 : 500)
      if (status === 500) console.error(e)
      json(res, { error: status === 404 && e.code === 'ENOENT' ? '找不到' : e.message }, status)
    }
  })
  .listen(PORT, '127.0.0.1', () => console.log(`角色生活模拟：http://127.0.0.1:${PORT}`))
