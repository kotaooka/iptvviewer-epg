import { readFile, writeFile } from 'node:fs/promises'

const PLAYLIST = process.env.PLAYLIST || 'https://iptv-org.github.io/iptv/index.m3u'
const GUIDES = process.env.GUIDES || 'https://iptv-org.github.io/api/guides.json'
const COUNTRIES = (process.env.COUNTRIES || 'jp,us,uk,kr,cn,hk').toLowerCase().split(',').map(s => s.trim()).filter(Boolean)

async function load(src) {
  if (/^https?:\/\//.test(src)) {
    const res = await fetch(src)
    if (!res.ok) throw new Error(`${src}: HTTP ${res.status}`)
    return res.text()
  }
  return readFile(src, 'utf8')
}

const esc = s => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')

function channelsXml(assignments) {
  const lines = ['<?xml version="1.0" encoding="UTF-8"?>', '<channels>']
  for (const { id, g } of assignments) {
    lines.push(`  <channel site="${esc(g.site)}" lang="${esc(g.lang || 'en')}" xmltv_id="${esc(id)}" site_id="${esc(g.site_id)}">${esc(g.site_name || id)}</channel>`)
  }
  lines.push('</channels>', '')
  return lines.join('\n')
}

function siteStats(state) {
  const stats = new Map()
  for (const entry of Object.values(state.channels)) {
    for (const t of entry.tried) {
      const s = stats.get(t.site) || { ok: 0, total: 0 }
      s.total++
      if (t.ok) s.ok++
      stats.set(t.site, s)
    }
  }
  return stats
}

function pick(candidates, coverage, stats) {
  const score = g => {
    const s = stats.get(g.site)
    if (s && s.total >= 3 && s.ok === 0) return -1
    const rate = s && s.total ? s.ok / s.total : 0.5
    return rate * 1e6 + (coverage.get(g.site) || 0)
  }
  let best = null
  for (const g of candidates) {
    const sc = score(g)
    if (sc < 0) continue
    if (!best || sc > best.sc) best = { g, sc }
  }
  return best?.g || null
}

function summarize(assignments, label) {
  const bySite = new Map()
  for (const { g } of assignments) bySite.set(g.site, (bySite.get(g.site) || 0) + 1)
  console.log(`${label}: channels=${assignments.length} sites=${bySite.size}`)
  for (const [site, n] of [...bySite].sort((a, b) => b[1] - a[1]).slice(0, 15)) console.log(`  ${site}: ${n}`)
}

function programmeChannels(xml) {
  const ids = new Set()
  for (const m of xml.matchAll(/<programme\b([^>]*?)(\/?)>/g)) {
    if (m[2]) continue
    const id = /\bchannel="([^"]+)"/.exec(m[1])
    if (id) ids.add(id[1])
  }
  return ids
}

async function init(statePath, outPath) {
  const [m3u, guidesText] = await Promise.all([load(PLAYLIST), load(GUIDES)])
  const guides = JSON.parse(guidesText)
  const byChannel = new Map()
  for (const g of guides) {
    if (!g.site || !g.site_id || g.site_id === '#') continue
    if (!byChannel.has(g.channel)) byChannel.set(g.channel, [])
    byChannel.get(g.channel).push(g)
  }
  const ids = [...new Set([...m3u.matchAll(/tvg-id="([^"]+)"/g)].map(m => m[1]))].sort()
  const channels = {}
  for (const id of ids) {
    const [channel, feed = ''] = id.split('@')
    if (!COUNTRIES.includes(channel.split('.').pop().toLowerCase())) continue
    const all = byChannel.get(channel) || []
    const same = all.filter(g => (g.feed || '') === feed)
    const rest = all.filter(g => (g.feed || '') !== feed)
    const seen = new Set()
    const candidates = [...same, ...rest].filter(g => {
      const key = `${g.site}|${g.site_id}`
      if (seen.has(key)) return false
      seen.add(key)
      return true
    })
    if (candidates.length) channels[id] = { candidates, tried: [], ok: false }
  }
  const state = { countries: COUNTRIES, channels, pending: [] }
  await assign(state, outPath, 'pass 1')
  await writeFile(statePath, JSON.stringify(state))
}

async function assign(state, outPath, label) {
  const coverage = new Map()
  const stats = siteStats(state)
  const open = Object.entries(state.channels).filter(([, e]) => !e.ok)
  for (const [, e] of open) {
    for (const site of new Set(e.candidates.map(g => g.site))) coverage.set(site, (coverage.get(site) || 0) + 1)
  }
  const assignments = []
  for (const [id, e] of open) {
    const triedSites = new Set(e.tried.map(t => t.site))
    const left = e.candidates.filter(g => !triedSites.has(g.site))
    const g = pick(left, coverage, stats)
    if (g) assignments.push({ id, g })
  }
  state.pending = assignments.map(({ id, g }) => ({ id, site: g.site, site_id: g.site_id }))
  await writeFile(outPath, channelsXml(assignments))
  summarize(assignments, label)
  return assignments.length
}

async function next(statePath, guidePath, outPath, label) {
  const state = JSON.parse(await readFile(statePath, 'utf8'))
  let xml = ''
  try { xml = await readFile(guidePath, 'utf8') } catch {}
  const got = programmeChannels(xml)
  let ok = 0
  for (const p of state.pending) {
    const e = state.channels[p.id]
    const success = got.has(p.id)
    e.tried.push({ site: p.site, site_id: p.site_id, ok: success })
    if (success) { e.ok = true; ok++ }
  }
  console.log(`result: ${ok}/${state.pending.length} channels got programmes`)
  const n = await assign(state, outPath, label)
  await writeFile(statePath, JSON.stringify(state))
  console.log(`remaining=${n}`)
}

async function merge(outPath, inputs) {
  const channelBlocks = new Map()
  const programmes = []
  const owner = new Map()
  for (const [i, path] of inputs.entries()) {
    let xml
    try { xml = await readFile(path, 'utf8') } catch { continue }
    for (const m of xml.matchAll(/<channel\b([^>]*?)(?:\/>|>[\s\S]*?<\/channel>)/g)) {
      const id = /\bid="([^"]+)"/.exec(m[1])?.[1]
      if (id && !channelBlocks.has(id)) channelBlocks.set(id, m[0])
    }
    for (const m of xml.matchAll(/<programme\b([^>]*?)(\/>|>[\s\S]*?<\/programme>)/g)) {
      if (m[2] === '/>') continue
      const id = /\bchannel="([^"]+)"/.exec(m[1])?.[1]
      if (!id) continue
      if (!owner.has(id)) owner.set(id, i)
      if (owner.get(id) === i) programmes.push(m[0])
    }
  }
  const used = new Set(owner.keys())
  const out = ['<?xml version="1.0" encoding="UTF-8" ?><tv date="' + new Date().toISOString().slice(0, 10).replace(/-/g, '') + '">']
  for (const [id, block] of channelBlocks) if (used.has(id)) out.push(block)
  out.push(...programmes, '</tv>', '')
  await writeFile(outPath, out.join('\n'))
  console.log(`merged: channels=${used.size} programmes=${programmes.length}`)
}

const [cmd, ...args] = process.argv.slice(2)
if (cmd === 'init') await init(args[0], args[1])
else if (cmd === 'next') await next(args[0], args[1], args[2], args[3] || 'next pass')
else if (cmd === 'merge') await merge(args[0], args.slice(1))
else {
  console.error('usage: epg.mjs init <state.json> <channels.xml> | next <state.json> <guide.xml> <channels.xml> [label] | merge <out.xml> <guide1.xml> ...')
  process.exit(2)
}
