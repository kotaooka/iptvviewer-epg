import { readFile, writeFile } from 'node:fs/promises'

const PLAYLIST = process.env.PLAYLIST || 'https://iptv-org.github.io/iptv/index.m3u'
const GUIDES = process.env.GUIDES || 'https://iptv-org.github.io/api/guides.json'
const COUNTRIES = (process.env.COUNTRIES || 'jp,us,uk,kr').toLowerCase().split(',').map(s => s.trim()).filter(Boolean)
const OUTPUT = process.argv[2] || 'channels.xml'

async function load(src) {
  if (/^https?:\/\//.test(src)) {
    const res = await fetch(src)
    if (!res.ok) throw new Error(`${src}: HTTP ${res.status}`)
    return res.text()
  }
  return readFile(src, 'utf8')
}

const esc = s => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')

const [m3u, guidesText] = await Promise.all([load(PLAYLIST), load(GUIDES)])
const guides = JSON.parse(guidesText)

const byChannel = new Map()
for (const g of guides) {
  if (!g.site || !g.site_id || g.site_id === '#') continue
  if (!byChannel.has(g.channel)) byChannel.set(g.channel, [])
  byChannel.get(g.channel).push(g)
}

const ids = new Set([...m3u.matchAll(/tvg-id="([^"]+)"/g)].map(m => m[1]))
const selected = []
for (const id of ids) {
  const [channel, feed = ''] = id.split('@')
  const cc = channel.split('.').pop().toLowerCase()
  if (!COUNTRIES.includes(cc)) continue
  const all = byChannel.get(channel) || []
  const candidates = all.filter(g => (g.feed || '') === feed)
  const list = candidates.length ? candidates : all
  if (list.length) selected.push({ id, list })
}

const siteCount = new Map()
for (const { list } of selected) {
  for (const site of new Set(list.map(g => g.site))) siteCount.set(site, (siteCount.get(site) || 0) + 1)
}

const lines = ['<?xml version="1.0" encoding="UTF-8"?>', '<channels>']
const usedSites = new Map()
for (const { id, list } of selected.sort((a, b) => a.id.localeCompare(b.id))) {
  const best = list.reduce((a, b) => (siteCount.get(b.site) > siteCount.get(a.site) ? b : a))
  usedSites.set(best.site, (usedSites.get(best.site) || 0) + 1)
  lines.push(`  <channel site="${esc(best.site)}" lang="${esc(best.lang || 'en')}" xmltv_id="${esc(id)}" site_id="${esc(best.site_id)}">${esc(best.site_name || id)}</channel>`)
}
lines.push('</channels>', '')
await writeFile(OUTPUT, lines.join('\n'))

console.log(`countries=${COUNTRIES.join(',')} channels=${selected.length} sites=${usedSites.size}`)
for (const [site, n] of [...usedSites].sort((a, b) => b[1] - a[1])) console.log(`  ${site}: ${n}`)
