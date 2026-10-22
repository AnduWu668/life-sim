// 角色卡：酒馆卡 PNG（tEXt 块 ccv3 / chara）、JSON（V1 / V2 / V3）统一成同一种结构。

const PNG_SIG = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])

export function readCardFile(buf, filename) {
  const raw = /\.png$/i.test(filename) ? pngCardJson(buf) : JSON.parse(buf.toString('utf8'))
  return normalizeCard(raw)
}

function pngCardJson(buf) {
  if (!buf.subarray(0, 8).equals(PNG_SIG)) throw new Error('不是 PNG 文件')
  const texts = {}
  for (let p = 8; p + 8 <= buf.length; ) {
    const len = buf.readUInt32BE(p)
    const type = buf.toString('latin1', p + 4, p + 8)
    if (type === 'IEND') break
    if (type === 'tEXt') {
      const data = buf.subarray(p + 8, p + 8 + len)
      const z = data.indexOf(0)
      texts[data.toString('latin1', 0, z).toLowerCase()] = data.toString('latin1', z + 1)
    }
    p += 12 + len
  }
  const b64 = texts.ccv3 ?? texts.chara
  if (!b64) throw new Error('PNG 里没有角色卡数据')
  return JSON.parse(Buffer.from(b64, 'base64').toString('utf8'))
}

export function normalizeCard(raw) {
  const d = raw?.data ?? raw ?? {}
  const s = v => (typeof v === 'string' ? v.trim() : '')
  const card = {
    name: s(d.name) || s(d.char_name),
    description: s(d.description) || s(d.char_persona),
    personality: s(d.personality),
    scenario: s(d.scenario) || s(d.world_scenario),
    firstMes: s(d.first_mes) || s(d.char_greeting),
    mesExample: s(d.mes_example) || s(d.example_dialogue),
    worldBook: (d.character_book?.entries ?? [])
      .filter(e => e?.enabled !== false)
      .map(e => s(e.content))
      .filter(Boolean),
  }
  if (!card.name) throw new Error('不是角色卡：缺少名字')
  return card
}

// {{char}} / <BOT> → 角色名，{{user}} / <USER> → 配角名。
export function fillMacros(card, userName) {
  const sub = v =>
    typeof v === 'string'
      ? v.replace(/\{\{char\}\}|<BOT>/gi, () => card.name).replace(/\{\{user\}\}|<USER>/gi, () => userName)
      : Array.isArray(v)
        ? v.map(sub)
        : v
  return Object.fromEntries(Object.entries(card).map(([k, v]) => [k, sub(v)]))
}
