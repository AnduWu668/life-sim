// 假方舟：测试用，也能在没有 key 时看界面。
//   node mock-ark.js 4100
//   ARK_BASE_URL=http://127.0.0.1:4100 DOUBAO_API_KEY=x npm start
import http from 'node:http'

export function startMockArk(port = 0, delay = 0) {
  const requests = []
  const server = http.createServer(async (req, res) => {
    let raw = ''
    for await (const c of req) raw += c
    const body = JSON.parse(raw)
    requests.push(body)
    if (server.mode === 'drop-once') {
      server.mode = undefined
      return req.socket.destroy()
    }
    if (server.mode === 'fail') {
      res.writeHead(500)
      return res.end('mock fail')
    }
    const user = body.messages.at(-1).content
    if (body.stream) {
      const n = user.match(/请写第 (\d+) 段/)?.[1] ?? '?'
      const text = `**标题：第 ${n} 段的事**\n时间：第 ${n} 天\n${`这是假方舟写的第 ${n} 段，用来测试流程。`.repeat(8)}`
      res.writeHead(200, { 'content-type': 'text/event-stream' })
      for (let i = 0; i < text.length; i += 20) {
        res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: text.slice(i, i + 20) } }] })}\n\n`)
        if (delay) await new Promise(r => setTimeout(r, delay))
      }
      const reason = server.mode === 'filter' ? 'content_filter' : 'stop'
      res.write(`data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: reason }] })}\n\n`)
      return res.end('data: [DONE]\n\n')
    }
    const n = user.match(/【新的一段】第 (\d+) 段/)[1]
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ choices: [{ message: { content: `当前时间：第 ${n} 天\n笔记到第 ${n} 段` }, finish_reason: 'stop' }] }))
  })
  return new Promise(resolve =>
    server.listen(port, '127.0.0.1', () => resolve({ server, requests, url: `http://127.0.0.1:${server.address().port}` })),
  )
}

if (import.meta.main) {
  const { url } = await startMockArk(Number(process.argv[2]) || 4100, 40)
  console.log(`假方舟：${url}`)
}
