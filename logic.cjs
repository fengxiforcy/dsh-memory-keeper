/**
 * dsh-memory-keeper v3.2 —— 逻辑层（可热加载，CommonJS 以便同步重载）
 *
 * 这个文件里只放「会变的生意逻辑」：阈值判定、记忆提取、压缩动作、提示词。
 * index.js 只是壳：它按 mtime 清 require 缓存后重新 require 本文件，改了这里不用重启 DSH，
 * 下一次 agent 事件就会用新代码。状态（Map/Set）全部由壳持有，通过 env 传进来，
 * 所以重载不会丢进行中的排队与会话水位。
 *
 * 踩过的坑（都留在这，别再犯）：
 *   - reasoning-delta 也有 .text 字段：只收 type==='text-delta'，否则「心里话」会被当成答案；
 *   - 从会话里读到的内容混着系统提示与 AGENTS：必须用 SYSTEM_MARKERS 过滤；
 *   - inject 写成 {required,optional} 会让插件等两个不存在的服务、干脆不加载；
 *   - compaction 服务在第三方插件层两条路都死（动态 ctx.inject 不回调、静态 inject 整插件不加载），
 *     所以自压缩只能走 session.append + surfaceOp，见 compactSelf；
 *   - surfaceOp replace 的 sourceEventSeqs 必须覆盖被 shadow 的每一个节点，漏一个整次拒绝；
 *   - surface 第 0 个节点是 system/message，不能拿普通 user/message 覆盖它，起点要跳过。
 */
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
// 默认目录跟着 DSH_HOME 走（DSH 主进程会设置）；没有则降级到 ~/.dsh
const DSH_HOME = process.env.DSH_HOME || path.join(os.homedir(), '.dsh')
const KEEPER_DIR = path.join(DSH_HOME, 'memory-keeper')

// 全部可被 cordis 配置与 memory-keeper/config.json 覆盖；默认值改动无需重启
const DEFAULTS = {
  logFile: path.join(KEEPER_DIR, 'pressure.jsonl'),
  groomLog: path.join(KEEPER_DIR, 'groom.jsonl'),
  stateFile: path.join(KEEPER_DIR, 'state.json'),
  workspaceStore: path.join(DSH_HOME, 'storages', 'workspace.json'),
  threshold: 0.55,
  minIntervalMs: 10 * 60 * 1000,
  windowFallback: 1048576,
  maxDumpChars: 60000,
  maxDialogChars: 24000,
  maxTokens: 4000,
  llmTimeoutMs: 90000,
  dryRun: false,
  // 老板 2026-11-17 早上定：到 55% 先自动整理「上次压缩到现在」的记忆，整理完再压缩。
  // 可见性由 记忆/topics/整理记录.md 保证（每次整理了哪几条、写到哪一层，都落一行）。
  // core(正殿) 不放行自动写入：有同名 key 才更新，新条目一律进候选区等确认。
  autoExtract: true,
  enabled: true,
  // 自己动手压缩（session.append + surfaceOp）只在白名单工作区启用——
  // 这条路没有 compaction 服务的锁与 tool-pair 校验，先在试验田跑稳再全量。
  selfCompactWorkspaces: [],
  selfCompactThreshold: 0.10,
  selfCompactKeep: 4,
}

// 出现这些词的条目一律不收：那是系统提示/AGENTS 内容，不是对话里的事实
const SYSTEM_MARKERS = [
  'root agent', 'AGENTS.md', 'resident-memory', '记忆（第一动作', 'DeepSeek Harness',
  'current working directory', '你的名字是', '系统提示', 'tool_result', 'tool_use',
  'memory.mjs', 'memory-v2', '工作区说明', '入职说明',
]

const PROMPT = [
  '下面是一段对话记录。请直接列出「值得长期记住」的事实，每条一行。',
  '',
  '【硬性要求】',
  '- 你是一个纯文本提取器，不是助手。',
  '- 你没有工具，不能执行命令，不能读文件，不能查询任何东西。',
  '- 只输出 "key | layer | 内容" 格式的条目，一行一条。',
  '- 如果这段对话里没有值得长期记住的事实，只输出一个字：无',
  '- 任何不是条目格式的行都会被丢弃。',
  '',
  '每行三段，用竖线分隔：',
  'key | layer | 内容',
  '',
  '规则：',
  '1. key 用英文点分，以 boss. / event. / rule. / self. / lesson. 开头，同一件事永远用同一 key；',
  '2. layer 只能是 core / topic / event：core 给身份、红线、边界、老板偏好；topic 给某个人或项目的细节；event 给带时间的事实与决定；',
  '3. 内容不超过 60 个汉字，只写对话里明确出现过的事实，禁止推断；',
  '4. 最多 5 行；',
  '5. 立刻输出正文，不要前言、解释、标题、编号，不要在心里排练；',
  '6. 没有值得记的输出两个字：无',
].join('\n')

// ---------- 基础文件工具 ----------
function ensureDir(f) { try { fs.mkdirSync(path.dirname(f), { recursive: true }) } catch { /* ignore */ } }
function appendLine(f, s) { try { ensureDir(f); fs.appendFileSync(f, s, 'utf8') } catch { /* ignore */ } }
function appendJsonl(f, o) { appendLine(f, JSON.stringify(o) + '\n') }
function readJson(f, d) { try { return JSON.parse(fs.readFileSync(f, 'utf8')) } catch { return d } }
function writeJson(f, o) { try { ensureDir(f); fs.writeFileSync(f, JSON.stringify(o, null, 1), 'utf8') } catch { /* ignore */ } }
function num(...v) { return v.find((x) => typeof x === 'number' && Number.isFinite(x)) ?? null }
function pickUsed(m) { return !m || typeof m !== 'object' ? null : num(m.tokens, m.used, m.usedTokens, m.totalTokens, m.total, m.inputTokens) }

function textOf(ev) {
  const out = []
  let n = 0
  const walk = (x, d) => {
    if (x == null || d > 5 || n > 8000) return
    if (typeof x === 'string') { out.push(x); n += x.length; return }
    if (Array.isArray(x)) { for (const i of x) walk(i, d + 1); return }
    if (typeof x !== 'object') return
    if (x.type === 'text' && typeof x.text === 'string') { out.push(x.text); n += x.text.length; return }
    if (x.type === 'tool_use' || x.type === 'tool_result' || x.type === 'image' || x.type === 'thinking') return
    for (const k of ['content', 'message', 'data', 'text', 'blocks']) {
      if (Object.prototype.hasOwnProperty.call(x, k)) walk(x[k], d + 1)
    }
  }
  try { walk(ev && (ev.content !== undefined ? ev.content : ev), 0) } catch { /* ignore */ }
  return out.join('\n').replace(/\n{3,}/g, '\n\n').trim()
}

function collectSince(session, lastSeq, maxChars) {
  let nodes = []
  try { nodes = (session.surface && session.surface.nodes) || [] } catch { /* ignore */ }
  if (!Array.isArray(nodes) || nodes.length === 0) return { lines: [], lastSeq: lastSeq ?? null }
  let start = 0
  if (lastSeq != null) {
    const i = nodes.indexOf(lastSeq)
    start = i >= 0 ? i + 1 : Math.max(0, nodes.length - 120)
  }
  const lines = []
  let chars = 0
  for (let i = start; i < nodes.length; i += 1) {
    let ev = null
    try { ev = session.eventAt(nodes[i]) } catch { continue }
    const t = ev && ev.type
    if (t !== 'user/message' && t !== 'assistant/message') continue
    const txt = textOf(ev)
    if (!txt) continue
    // 插件自己发的状态通知不是对话内容，别送去提取、也别占提取配额
    if (txt.startsWith('【记忆守夜人】')) continue
    const line = '[' + (t === 'user/message' ? '用户' : '助手') + '] ' + txt
    if (chars + line.length > maxChars) break
    lines.push(line)
    chars += line.length
  }
  return { lines, lastSeq: nodes[nodes.length - 1] }
}

/** 当前 surface 最后一个节点的 seq；压缩会重排 surface，它是「压缩点」的可靠锚。 */
function surfaceTail(session) {
  try {
    const nodes = session && session.surface && session.surface.nodes
    return Array.isArray(nodes) && nodes.length ? nodes[nodes.length - 1] : null
  } catch { return null }
}

function workspacePathOf(sessionId, store) {
  try {
    const j = JSON.parse(fs.readFileSync(store, 'utf8'))
    const ws = (j && j.tables && j.tables.workspaces) || {}
    for (const v of Object.values(ws)) {
      if (v && Array.isArray(v.sessionIds) && v.sessionIds.includes(sessionId) && typeof v.path === 'string') return v.path
    }
  } catch { /* ignore */ }
  return null
}

function looksSystem(item) {
  const blob = (item.key + ' ' + item.text).toLowerCase()
  return SYSTEM_MARKERS.some((m) => blob.includes(m.toLowerCase()))
}

function parseItems(raw) {
  const text = String(raw || '')
  const items = []
  for (const line of text.split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Za-z][A-Za-z0-9_.]*)\s*[|｜]\s*(core|topic|event)\s*[|｜]\s*(.+?)\s*$/i)
    if (!m) continue
    const body = m[3].replace(/^["\'「『]|["\'」』]$/g, '').trim()
    if (!body) continue
    const item = { key: m[1].trim().slice(0, 80), layer: m[2].toLowerCase(), text: body.slice(0, 200) }
    if (looksSystem(item)) continue
    items.push(item)
    if (items.length >= 5) break
  }
  return { items, none: items.length === 0 && /^\s*无\s*$/m.test(text) }
}

function itemsEmpty(parsed) { return parsed.items.length === 0 && !parsed.none }

function updateCoreLine(memDir, item) {
  const p = path.join(memDir, 'core.md')
  let text = ''
  try { text = fs.readFileSync(p, 'utf8') } catch { return false }
  const lines = text.split(/\r?\n/)
  const esc = item.key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const re = new RegExp('key:\\s*' + esc + '(\\s|$)')
  const idx = lines.findIndex((l) => re.test(l))
  if (idx < 0) return false
  const m = lines[idx].match(/^-\s*\[([^\]]+)\]/)
  lines[idx] = '- [' + (m ? m[1] : '信息') + '] ' + item.text + ' | key: ' + item.key
  try { fs.writeFileSync(p, lines.join('\r\n'), 'utf8'); return true } catch { return false }
}

function writePending(memDir, item, today) {
  const p = path.join(memDir, 'topics', 'pending.md')
  ensureDir(path.dirname(p))
  if (!fs.existsSync(p)) fs.writeFileSync(p, '# 候选正殿（待老板点头）\r\n\r\n> 自动整理写这里，点头才进 core.md。\r\n\r\n', 'utf8')
  appendLine(p, '- [' + today + '] ' + item.text + ' | key: ' + item.key + '\r\n')
}

function writeTopic(memDir, item, today) {
  const dir = path.join(memDir, 'topics')
  ensureDir(dir)
  const name = (item.key.split('.')[0] || 'misc').replace(/[^a-z0-9_-]/gi, '') || 'misc'
  const p = path.join(dir, name + '.md')
  let lines = []
  try { lines = fs.readFileSync(p, 'utf8').split(/\r?\n/) } catch { lines = ['# 主题：' + name, ''] }
  const idx = lines.findIndex((l) => l.includes('key: ' + item.key + ' ') || l.trim().endsWith('key: ' + item.key))
  const line = '- ' + item.text + ' | key: ' + item.key + ' | auto: ' + today
  if (idx >= 0) lines[idx] = line
  else lines.push(line)
  fs.writeFileSync(p, lines.join('\r\n'), 'utf8')
}

function writeEvent(memDir, item, today) {
  const dir = path.join(memDir, 'events')
  ensureDir(dir)
  let files = []
  try { files = fs.readdirSync(dir).filter((f) => f.endsWith('.jsonl')) } catch { /* ignore */ }
  for (const f of files) {
    const p = path.join(dir, f)
    try {
      const rows = fs.readFileSync(p, 'utf8').split(/\r?\n/).filter(Boolean)
      const kept = rows.filter((l) => { try { return JSON.parse(l).key !== item.key } catch { return true } })
      if (kept.length !== rows.length) fs.writeFileSync(p, kept.join('\n') + (kept.length ? '\n' : ''), 'utf8')
    } catch { /* ignore */ }
  }
  appendLine(path.join(dir, today.slice(0, 7) + '.jsonl'), JSON.stringify({ at: today, text: item.text, key: item.key, src: 'auto' }) + '\n')
}

/**
 * 正殿改了要同步进 AGENTS.md 的 resident-memory 块，否则下一个会话读到的还是旧的。
 * 老板 2026-11-17 问「别的对话的正殿怎么更新」时发现的断点：
 * memory.mjs add 不自动 sync、插件 updateCoreLine 也不 sync，于是 core.md 新了、AGENTS.md 还是旧的。
 * 只在会话自己所属的工作区里做，跨区一律不碰（红线）。
 */
function syncResident(wsRoot) {
  try {
    const corePath = path.join(wsRoot, '记忆', 'core.md')
    const agentsPath = path.join(wsRoot, 'AGENTS.md')
    let coreText = ''
    let agents = ''
    try { coreText = fs.readFileSync(corePath, 'utf8') } catch { return 'no-core' }
    try { agents = fs.readFileSync(agentsPath, 'utf8') } catch { return 'no-agents' }
    if (!agents.includes('<!-- resident-memory:start')) return 'no-marker'
    const items = coreText.split(/\r?\n/)
      .filter((l) => l.trim().startsWith('- '))
      .map((l) => l.replace(/\s*\|\s*src:.*$/, '').replace(/\s+$/, ''))
    const block = '<!-- resident-memory:start（自动同步自 记忆/core.md，勿手改） -->\n' +
      items.join('\n') + '\n<!-- resident-memory:end -->'
    const next = agents.replace(/<!-- resident-memory:start[\s\S]*?<!-- resident-memory:end -->/, () => block)
    if (next === agents) return 'unchanged'
    fs.writeFileSync(agentsPath, next, 'utf8')
    return items.length
  } catch (err) {
    return 'error:' + String((err && err.message) || err).slice(0, 60)
  }
}

/** 先看缓存拿到了没；没有再退四条探测路：属性直取 / root 属性 / get / root.get。 */
function findCompaction(ctx, cached) {
  if (cached && typeof cached.compactNow === 'function') {
    return { svc: cached, via: 'ctx.inject', report: { 'ctx.inject': 'ok' } }
  }
  const tries = [
    ['ctx.compaction', () => ctx.compaction],
    ['ctx.root.compaction', () => ctx.root && ctx.root.compaction],
    ['ctx.get', () => (ctx.get ? ctx.get('compaction') : undefined)],
    ['ctx.root.get', () => (ctx.root && ctx.root.get ? ctx.root.get('compaction') : undefined)],
  ]
  const report = {}
  for (const [name, fn] of tries) {
    try {
      const v = fn()
      report[name] = v ? (typeof v.compactNow === 'function' ? 'ok' : 'no-compactNow') : 'undefined'
      if (v && typeof v.compactNow === 'function') return { svc: v, via: name, report }
    } catch (err) {
      report[name] = 'throw:' + String((err && err.message) || err).slice(0, 60)
    }
  }
  return { svc: null, via: 'none', report }
}

// ---------- 状态存取 ----------
function loadState(cfg) { return readJson(cfg.stateFile, { sessions: {} }) }
function saveState(cfg, s) { writeJson(cfg.stateFile, s) }

function wsOf(env, sid) {
  if (env.wsMemo.has(sid)) return env.wsMemo.get(sid)
  let p = null
  try { p = workspacePathOf(sid, env.cfg.workspaceStore) } catch { /* ignore */ }
  env.wsMemo.set(sid, p)
  return p
}

function isSelfCompactWs(env, sid) {
  const list = Array.isArray(env.cfg.selfCompactWorkspaces) ? env.cfg.selfCompactWorkspaces : []
  if (!list.length) return false
  const ws = wsOf(env, sid)
  if (!ws) return false
  const norm = (s) => String(s).replace(/[\\/]+$/, '').toLowerCase()
  return list.some((w) => norm(w) === norm(ws))
}

function effectiveThreshold(env, sid) {
  const t = Number(env.cfg.threshold) || 0.55
  if (!isSelfCompactWs(env, sid)) return t
  // 按工作区覆盖阈值：试验田可以 0.10 方便测，正式工作区就是主阈值。
  // 老板 2026-11-17 定：先只放运维部进来跑，稳了再铺开。
  const map = env.cfg.selfCompactThresholds
  const ws = wsOf(env, sid)
  if (map && typeof map === 'object' && ws) {
    const norm = (s) => String(s).replace(/[\\/]+$/, '').toLowerCase()
    for (const k of Object.keys(map)) {
      if (norm(k) === norm(ws)) {
        const n = Number(map[k])
        if (Number.isFinite(n) && n > 0) return Math.min(t, n)
      }
    }
  }
  return Math.min(t, Number(env.cfg.selfCompactThreshold) || t)
}

// ---------- 主流程 ----------
/**
 * 压缩前顺手把会话日志文件本身备份一份（2026-11-17 老板定）。
 * 不搞定时任务：挂在压缩流程里，55% 才触发一次，平时零开销。
 * 会话日志损坏时用这里的回滚点恢复；保留最近 5 份。
 */
function backupSessionFile(env, sid, memDir) {
  try {
    const root = path.join(DSH_HOME, 'sessions')
    let dirs = []
    try { dirs = fs.readdirSync(root) } catch { return false }
    let src = null
    for (const d of dirs) {
      const p = path.join(root, d, String(sid), 'session.v4.jsonl.zstd')
      if (fs.existsSync(p)) { src = p; break }
    }
    if (!src) return false
    const bytes = fs.statSync(src).size
    const dir = path.join(memDir, 'archive', 'session-backups')
    fs.mkdirSync(dir, { recursive: true })
    const stamp = env.stamp().replace(/[:.]/g, '-')
    const dst = path.join(dir, String(sid).slice(-8) + '-' + stamp + '.zstd')
    fs.copyFileSync(src, dst)
    env.sessionLogBytes = env.sessionLogBytes || new Map()
    env.sessionLogBytes.set(sid, bytes)
    const files = fs.readdirSync(dir).filter((f) => f.endsWith('.zstd')).sort()
    while (files.length > 5) { try { fs.unlinkSync(path.join(dir, files.shift())) } catch { /* ignore */ } }
    env.log({ ts: env.stamp(), event: 'session-backup', sessionId: sid, file: dst })
    return true
  } catch { return false }
}

/** 压缩前把原声对话落盘，留一张待复核卡。返回 {file, lines} 或 null。 */
function preserve(env, agent, sid, ratio) {
  const session = agent.session
  const ws = workspacePathOf(sid, env.cfg.workspaceStore)
  if (!ws) return null
  const memDir = path.join(ws, '记忆')
  if (!fs.existsSync(memDir)) return null
  const inc = collectSince(session, env.lastSeqSeen.get(sid) ?? null, env.cfg.maxDumpChars)
  if (!inc.lines.length) return null
  const name = 'session-' + env.stamp().replace(/[:.]/g, '-').slice(0, 16) + '.jsonl'
  const file = path.join(memDir, 'archive', name)
  for (const line of inc.lines) appendLine(file, JSON.stringify({ sessionId: sid, ratio, text: line }) + '\n')
  env.lastSeqSeen.set(sid, inc.lastSeq)
  const card = path.join(memDir, 'topics', '待复核.md')
  if (!fs.existsSync(card)) {
    fs.writeFileSync(card, '# 待复核（压缩前后的对话原文，等 agent 补写记忆）\r\n\r\n> 插件在压缩前把原文 dump 到 archive/，这里只留指针。补写完删掉对应行。\r\n\r\n', 'utf8')
  }
  appendLine(card, '- [' + env.stamp() + '] ' + inc.lines.length + ' 条原文已存档：记忆\\archive\\' + name + '（压力 ' + ratio + '）—— 请补写记忆，写完删本行。\r\n')
  // 压缩前顺手备份会话日志文件本身（损坏时回滚用）
  try { backupSessionFile(env, sid, memDir) } catch { /* 备份失败不影响压缩 */ }
  return { file, lines: inc.lines.length }
}

/**
 * 压缩前从被 shadow 的消息里提炼一段「对话要点」，塞进指针消息。
 * 2026-11-17 老板反馈：旧版只留一句「已存档」指针，压缩后模型丢了来龙去脉，
 * 思考里反复重建上下文（复读），严重时直接断。摘要式压缩保留连贯性。
 */
function buildCompactDigest(session, shadowed, maxItems) {
  const limit = Math.max(3, Number(maxItems) || 8)
  const userBits = []
  let lastAssistant = ''
  for (const seq of shadowed) {
    let ev = null
    try { ev = session.eventAt(seq) } catch { continue }
    if (!ev) continue
    const txt = textOf(ev)
    if (!txt || txt.startsWith('【记忆守夜人】')) continue
    if (txt.includes('<system-reminder>') || txt.startsWith('Time sampled')) continue
    const one = txt.replace(/\s+/g, ' ').trim()
    if (!one) continue
    if (ev.type === 'user/message') {
      const line = one.slice(0, 100)
      if (line && !userBits.includes(line)) userBits.push(line)
    } else if (ev.type === 'assistant/message') {
      lastAssistant = one.slice(0, 150)
    }
  }
  const parts = []
  const picks = userBits.slice(-limit)
  if (picks.length) {
    parts.push('· 此前老板说过（按时间顺序，节选）：')
    picks.forEach((u, i) => parts.push('  ' + (i + 1) + '. ' + u))
  }
  if (lastAssistant) parts.push('· 我最后在说：' + lastAssistant)
  return parts.join('\n')
}

/**
 * 自己动手压缩：把 surface 开头到某个 user/message 边界换成一条指针消息。
 * 只做 surfaceOp replace，不写 compaction/* 记账事件（那只是记录，不影响生效）。
 * 切点选在 user/message 上，天然不会拆开 tool-call/result 配对。
 */
function compactSelf(env, session, sid, ratio, saved) {
  const out = { ok: false }
  try {
    const nodes = session.surface && session.surface.nodes
    out.diag = out.diag || {}
    out.diag.nodes = Array.isArray(nodes) ? nodes.length : 0
    if (!Array.isArray(nodes) || nodes.length < 8) {
      out.reason = 'surface too short (' + (nodes ? nodes.length : 0) + ')'
      return out
    }
    const keep = Math.max(2, Number(env.cfg.selfCompactKeep) || 4)
    // 会话开头的 system/message 不能被普通 user/message 覆盖
    // （实测报错：node 0 holds the system prompt ...），起点要跳过它。
    let startIdx = 0
    for (let i = 0; i < nodes.length; i += 1) {
      let ev = null
      try { ev = session.eventAt(nodes[i]) } catch { continue }
      if (ev && ev.type === 'system/message') { startIdx = i + 1; continue }
      break
    }
    let endIdx = -1
    for (let i = nodes.length - keep - 1; i >= startIdx; i -= 1) {
      let ev = null
      try { ev = session.eventAt(nodes[i]) } catch { continue }
      if (ev && ev.type === 'user/message') { endIdx = i; break }
    }
    out.diag.startIdx = startIdx
    out.diag.endIdx = endIdx
    out.diag.keep = keep
    if (endIdx <= startIdx) { out.reason = 'no safe boundary after system prompt'; return out }
    const startSeq = nodes[startIdx]
    const endSeq = nodes[endIdx]
    const shadowedSeqs = nodes.slice(startIdx, endIdx + 1)
    const digest = buildCompactDigest(session, shadowedSeqs, 8)
    const pointer = '【历史已压缩 ' + env.stamp().slice(0, 16) + '】此前 ' + (endIdx + 1) +
      ' 条消息已替换为这条指针；原文存档：' + (saved && saved.file ? saved.file : '记忆/archive/') +
      '。' + (digest ? '\n压缩前的对话要点（保持上下文连贯）：\n' + digest : '') +
      '\n需要细节时回那份存档检索，别凭印象补。'
    // surfaceOp replace 要求 sourceEventSeqs 覆盖被 shadow 的每一个节点，
    // 漏一个就整次拒绝（2026-11-17 实测报错：missing 7, 8, 9, ...）。
    const shadowed = shadowedSeqs
    const ev = session.append('user/message', {
      // DSH 校验要求 user/message 的 data 带非空 id（"identified message"），
      // 缺了会让整个会话加载失败（2026-11-17 实测：lacks an identified message）。
      id: 'compact-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 10),
      role: 'user',
      content: [{ type: 'text', text: pointer }],
      source: { kind: 'user' },
    }, {
      surfaceOp: { op: 'replace', startSeq, endSeq },
      sourceEventSeqs: shadowed,
    })
    out.diag.startSeq = startSeq
    out.diag.endSeq = endSeq
    out.diag.shadowed = shadowed.length
    out.ok = true
    out.startSeq = startSeq
    out.endSeq = endSeq
    out.shadowed = endIdx + 1
    out.newSeq = ev && ev.seq
  } catch (err) {
    out.reason = String((err && err.message) || err)
  }
  return out
}

function doCompact(env, svc, agent, sid, ratio, saved) {
  const ac = new AbortController()
  const timer = setTimeout(() => ac.abort(), env.cfg.llmTimeoutMs * 2)
  Promise.resolve()
    .then(() => svc.compactNow(agent, ac.signal))
    .then((res) => {
      // 压缩成功后 surface 被重排：把提取水位挪到新的尾节点，
      // 这样下一轮「上次压缩到现在」这份增量才是干净的，不会把已整理过的内容再提一遍。
      let anchor = null
      try {
        anchor = surfaceTail(agent.session)
        const st = loadState(env.cfg)
        if (!st.sessions) st.sessions = {}
        st.sessions[sid] = { ...(st.sessions[sid] || {}), lastSeq: anchor, lastCompactAt: env.stamp(), lastCompactRatio: ratio }
        saveState(env.cfg, st)
        if (anchor != null) env.lastSeqSeen.set(sid, anchor)
      } catch (err) {
        env.log({ ts: env.stamp(), event: 'anchor-error', sessionId: sid, message: String((err && err.message) || err) })
      }
      env.log({
        ts: env.stamp(), event: 'auto-compact', sessionId: sid, ok: true, ratio, anchor,
        shadowedTokens: res && typeof res.shadowedTokenCount === 'number' ? res.shadowedTokenCount : null,
        archive: saved && saved.file,
      })
    })
    .catch((err) => {
      const msg = String((err && err.message) || err)
      env.log({ ts: env.stamp(), event: 'auto-compact', sessionId: sid, ok: false, ratio, message: msg, archive: saved && saved.file })
      if (/active work|no safe|nothing|busy|not idle|idle/i.test(msg)) env.pending.set(sid, { ratio, at: Date.now() })
    })
    .finally(() => clearTimeout(timer))
}

async function extractAndWrite(env, agent, sid, ratio) {
  const session = agent.session
  const cfg = env.cfg
  const state = loadState(cfg)
  const s = (state.sessions && state.sessions[sid]) || {}
  const inc = collectSince(session, s.lastSeq ?? null, cfg.maxDialogChars)
  if (inc.lines.length < 4) { env.glog({ ts: env.stamp(), event: 'skip', sessionId: sid, reason: 'few lines', n: inc.lines.length }); return { applied: 0, pending: [] } }
  const ws = workspacePathOf(sid, cfg.workspaceStore)
  const memDir = ws ? path.join(ws, '记忆') : null
  if (!memDir || !fs.existsSync(memDir)) { env.glog({ ts: env.stamp(), event: 'skip', sessionId: sid, reason: 'no 记忆 dir' }); return { applied: 0, pending: [] } }
  const header = session.requestHeader ? session.requestHeader() : null
  const target = header && header.config ? header.config : null
  if (!target || !target.provider || !target.model) { env.glog({ ts: env.stamp(), event: 'skip', sessionId: sid, reason: 'no model' }); return { applied: 0, pending: [] } }

  // llm 服务同样不能直接点属性（会抛 without inject），用 ctx.get 拿
  const llm = env.ctx.get ? env.ctx.get('llm') : null
  if (!llm || typeof llm.stream !== 'function') { env.glog({ ts: env.stamp(), event: 'skip', sessionId: sid, reason: 'no llm service' }); return { applied: 0, pending: [] } }

  const started = Date.now()
  const ac = new AbortController()
  const timer = setTimeout(() => ac.abort(), cfg.llmTimeoutMs)
  let raw = ''
  try {
    const messages = [{ role: 'user', content: [{ type: 'text', text: PROMPT + '\n\n=== 对话记录 ===\n' + inc.lines.join('\n') }] }]
    for await (const chunk of llm.stream({
      provider: target.provider, model: target.model, messages,
      maxTokens: cfg.maxTokens, sessionId: session.id, purpose: 'compaction', signal: ac.signal,
    })) {
      if (chunk && chunk.type === 'text-delta' && typeof chunk.text === 'string') raw += chunk.text
    }
  } catch (err) {
    env.glog({ ts: env.stamp(), event: 'llm-error', sessionId: sid, ms: Date.now() - started, message: String((err && err.message) || err) })
    return { applied: -1, failed: true, pending: [] }
  } finally { clearTimeout(timer) }

  const parsed = parseItems(raw)
  if (itemsEmpty(parsed)) {
    env.glog({ ts: env.stamp(), event: 'llm-no-items', sessionId: sid, ms: Date.now() - started, rawHead: raw.slice(0, 200) })
    // 模型正常回答「没有值得记的」——不是失败，照常压缩不会丢知识
    return { applied: 0, failed: false, pending: [] }
  }
  const today = env.stamp().slice(0, 10)
  const done = []
  let coreTouched = false
  const pendingAdded = []

  for (const it of parsed.items) {
    try {
      if (cfg.dryRun) { done.push({ ...it, applied: false }); continue }
      if (it.layer === 'core') {
        if (updateCoreLine(memDir, it)) coreTouched = true
        else { writePending(memDir, it, today); pendingAdded.push(it) }
      }
      else if (it.layer === 'topic') writeTopic(memDir, it, today)
      else writeEvent(memDir, it, today)
      done.push({ ...it, applied: true })
    } catch (err) { done.push({ ...it, applied: false, error: String((err && err.message) || err) }) }
  }
  const appliedCount = done.filter((d) => d.applied).length
  // 正殿动过就同步给 AGENTS.md，别的会话下一轮才看得见
  if (coreTouched && !cfg.dryRun) {
    const r = syncResident(path.dirname(memDir))
    env.glog({ ts: env.stamp(), event: 'resident-sync', sessionId: sid, ws: path.dirname(memDir), result: r })
  }
  if (appliedCount > 0 && inc.lastSeq != null) {
    state.sessions = state.sessions || {}
    state.sessions[sid] = { ...(state.sessions[sid] || {}), lastSeq: inc.lastSeq, lastGroomAt: env.stamp() }
    saveState(cfg, state)
  }
  // 老板要看得见：每次整理留一行，写明整理了哪几条、进了哪一层
  try {
    const ledger = path.join(memDir, 'topics', '整理记录.md')
    if (!fs.existsSync(ledger)) {
      fs.writeFileSync(ledger, '# 整理记录（插件自动整理）\r\n\r\n> 每次到 55% 触发一次：时间 | 压力 | 写入条数 | 写了哪几条 | 原文存档\r\n\r\n', 'utf8')
    }
    const keyList = done.map((d) => d.layer + ':' + d.key + (d.applied ? '' : '(未写入)')).join('、')
    appendLine(ledger, '- ' + env.stamp() + ' | 压力 ' + ratio + ' | ' + appliedCount + '/' + done.length + ' 条 | ' + keyList + '\r\n')
  } catch { /* 记录失败不影响整理 */ }

  env.glog({
    ts: env.stamp(), event: 'groom', sessionId: sid, ratio, wsPath: ws,
    fromSeq: s.lastSeq ?? null, toSeq: inc.lastSeq, dialogLines: inc.lines.length,
    ms: Date.now() - started, dryRun: cfg.dryRun, applied: appliedCount, items: done,
    pending: pendingAdded.map((x) => x.key),
  })
  return { applied: appliedCount, pending: pendingAdded }
}

// ---------- 事件入口 ----------
function onPreStep(env, payload) {
  const cfg = env.cfg
  try {
    if (!cfg.enabled) return
    const { agent, signal } = payload || {}
    if (signal && signal.aborted) return
    if (!agent || !agent.session) return
    const session = agent.session
    const sid = session.id || session.sessionId || 'unknown'
    const m = env.ctx.tokenMeter && env.ctx.tokenMeter.measure ? env.ctx.tokenMeter.measure(session) : null
    const used = pickUsed(m)
    const window = Number(cfg.windowFallback) || 1048576
    const ratio = used != null ? Number((used / window).toFixed(4)) : null
    if (!env.flags.announced) {
      env.flags.announced = true
      env.log({ ts: env.stamp(), event: 'loaded', version: '3.2.0', threshold: cfg.threshold, dryRun: cfg.dryRun, hotReload: true })
    }
    if (!env.apiProbed.has(sid)) {
      env.apiProbed.add(sid)
      const list = (o) => {
        if (!o) return []
        const own = Object.keys(o).filter((k) => { try { return typeof o[k] === 'function' } catch { return false } })
        let proto = []
        try {
          proto = Object.getOwnPropertyNames(Object.getPrototypeOf(o) || {}).filter((k) => { try { return typeof o[k] === 'function' } catch { return false } })
        } catch { /* ignore */ }
        return [...new Set([...own, ...proto])]
      }
      let ctxKeys = []
      try { ctxKeys = Object.keys(env.ctx).filter((k) => /compact|summar/i.test(k)) } catch { /* ignore */ }
      env.log({
        ts: env.stamp(), event: 'api-probe', sessionId: sid,
        agent: list(agent).filter((k) => /compact|summar|maintain|pressure/i.test(k)),
        session: list(session).filter((k) => /compact|summar|append|surface|event/i.test(k)),
        ctxKeys,
      })
    }
    // 先生效阈值，日志里能直接看出这个工作区用的是哪一档
    const effThreshold = effectiveThreshold(env, sid)
    const prev = env.lastLog.get(sid) || 0
    if (Date.now() - prev >= 60000) {
      env.lastLog.set(sid, Date.now())
      env.log({ ts: env.stamp(), event: 'step-pressure', sessionId: sid, used, window, ratio, eff: effThreshold, over: ratio != null ? ratio >= effThreshold : null })
    }
    if (ratio != null && ratio >= effThreshold) {
      const state = loadState(cfg)
      const lastAt = Date.parse((state.sessions && state.sessions[sid] && state.sessions[sid].lastGroomAt) || '') || 0
      const backoffUntil = env.backoff.get(sid) || 0
      if (Date.now() >= backoffUntil && Date.now() - lastAt >= cfg.minIntervalMs && !env.pending.has(sid)) {
        env.pending.set(sid, { ratio, at: Date.now() })
        env.log({ ts: env.stamp(), event: 'groom-queued', sessionId: sid, ratio })
      }
    }
    // ---- B 方案（2026-11-19 老板定）：关键事件即时捕获（纯规则，不调模型）----
    try {
      if (env.cfg.instantCapture !== false) {
        const seen = env.instantSeen || (env.instantSeen = new Map())
        const inc = collectSince(session, seen.get(sid) ?? null, 3000)
        if (inc.lines.length) {
          seen.set(sid, inc.lastSeq)
          const KW = ['发布', '上报', '决定', '承诺', '记住', '以后都', '配置变更', '部署', '批准', '同意', '定稿', '删除', '重置']
          const hits = inc.lines.filter((l) => KW.some((k) => String(l).includes(k)))
          if (hits.length) {
            const ws = workspacePathOf(sid, env.cfg.workspaceStore)
            const memDir = ws ? path.join(ws, '记忆') : null
            if (memDir && fs.existsSync(memDir)) {
              const today = env.stamp().slice(0, 10)
              for (const l of hits.slice(0, 3)) {
                const it = { key: 'event.instant.' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6), layer: 'event', text: String(l).replace(/\s+/g, ' ').slice(0, 240) }
                try { writeEvent(memDir, it, today) } catch { /* ignore */ }
              }
              env.log({ ts: env.stamp(), event: 'instant-capture', sessionId: sid, hits: hits.length })
            }
          }
        }
      }
    } catch { /* 即时捕获失败不影响主流程 */ }
    // ---- B 方案：每 5 轮登记一次「只整理不压缩」----
    try {
      const per = Number(env.cfg.groomEverySteps) || 5
      const cnt = env.stepCount || (env.stepCount = new Map())
      const c = (cnt.get(sid) || 0) + 1
      cnt.set(sid, c)
      if (c >= per) {
        cnt.set(sid, 0)
        env.groomDue = env.groomDue || new Map()
        env.groomDue.set(sid, true)
        env.log({ ts: env.stamp(), event: 'groom-due', sessionId: sid, steps: c })
      }
    } catch { /* ignore */ }
  } catch (err) {
    env.log({ ts: env.stamp(), event: 'error', message: String((err && err.message) || err) })
  }
}

/**
 * 通知白名单：只往「界面会话」写提示。QQ 会话（余白）不发——
 * 她的提示不会外发到 QQ，但模型看到后可能在回复里提一句，等于冒泡进群。
 * cfg.notifyWorkspaces 为空 = 全部发；否则只发列表里的工作区。
 */
function shouldNotify(env, sid) {
  const list = env.cfg.notifyWorkspaces
  if (!Array.isArray(list) || list.length === 0) return true
  const ws = workspacePathOf(sid, env.cfg.workspaceStore)
  if (!ws) return false
  return list.some((w) => String(w).toLowerCase() === ws.toLowerCase())
}

/**
 * 开始整理时先打个招呼：老板 2026-11-17 说等待那十几秒没底。
 * 这条只在「确定会压缩」的工作区发，避免只发开始、永远等不到完成。
 */
function notifyStart(env, agent, sid, ratio) {
  try {
    if (!shouldNotify(env, sid)) return
    const pct = ratio == null ? '未知' : (ratio * 100).toFixed(1) + '%'
    const text = '【记忆守夜人】正在整理记忆并压缩，约 20 秒… ⏳\n· 当前上下文 ' + pct + '\n· 完成后会在下面再发一条'
    agent.session.append('user/message', {
      id: 'notify-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 10),
      role: 'user',
      content: [{ type: 'text', text }],
      source: { kind: 'user' },
    }, { surfaceOp: 'append' })
    env.glog({ ts: env.stamp(), event: 'notify-start', sessionId: sid, ratio })
  } catch (err) {
    env.glog({ ts: env.stamp(), event: 'notify-error', sessionId: sid, where: 'start', message: String((err && err.message) || err) })
  }
}

/**
 * 压缩完给用户一个明确信号：在对话里留一条系统通知，写明压了多少、现在多少。
 * 老板 2026-11-17 提的问题：后台压缩没有任何反馈，界面百分比要等下一句话才更新，
 * 他不知道压缩完没完，也不敢立刻继续对话。这条通知就是解决「看不见」。
 * append 只写事件、不触发模型自动回复（2026-11-17 10:44 实测）。
 */
function pendingCount(env, sid) {
  try {
    const ws = workspacePathOf(sid, env.cfg.workspaceStore)
    if (!ws) return 0
    const p = path.join(ws, '记忆', 'topics', 'pending.md')
    return fs.readFileSync(p, 'utf8').split(/\r?\n/).filter((l) => l.trim().startsWith('- ')).length
  } catch { return 0 }
}

/** 待复核（压缩存档等待补写记忆）的条数：让待办跟着完成通知一起送到面前，不再无声积压。 */
function reviewPendingCount(env, sid) {
  try {
    const ws = workspacePathOf(sid, env.cfg.workspaceStore)
    if (!ws) return 0
    const p = path.join(ws, '记忆', 'topics', '待复核.md')
    return fs.readFileSync(p, 'utf8').split(/\r?\n/).filter((l) => l.trim().startsWith('- [')).length
  } catch { return 0 }
}

function notifyDone(env, agent, sid, ratioBefore, groomed, result, pendingAdded) {
  try {
    if (!shouldNotify(env, sid)) return
    const session = agent.session
    let after = null
    try {
      const m = env.ctx.tokenMeter && env.ctx.tokenMeter.measure ? env.ctx.tokenMeter.measure(session) : null
      const used = pickUsed(m)
      const w = Number(env.cfg.windowFallback) || 1048576
      if (used != null) after = used / w
    } catch { /* 量不到就写未知 */ }
    const pct = (r) => (r == null ? '未知' : (r * 100).toFixed(1) + '%')
    const lines = []
    if (result && result.ok) {
      lines.push('【记忆守夜人】整理与压缩已完成 ✅')
      if (typeof groomed === 'number' && groomed > 0) lines.push('· 记忆写入 ' + groomed + ' 条')
      else lines.push('· 记忆：这次没有新条目')
      const d = result.diag || {}
      if (d.shadowed) lines.push('· 压掉 ' + d.shadowed + ' 条历史消息')
      lines.push('· 上下文 ' + pct(ratioBefore) + ' → ' + pct(after))
      // 候选正殿不能是黑洞：老板 2026-11-17 问「她攒着我怎么知道什么时候点头」
      if (pendingAdded && pendingAdded.length) {
        const total = pendingCount(env, sid)
        lines.push('· 📥 候选正殿 +' + pendingAdded.length + ' 条（共 ' + total + ' 条待定）：')
        for (const it of pendingAdded.slice(0, 3)) {
          lines.push('   · ' + String(it.text).slice(0, 40) + '（' + it.key + '）')
        }
        if (pendingAdded.length > 3) lines.push('   · 另有 ' + (pendingAdded.length - 3) + ' 条，见 记忆/topics/pending.md')
        lines.push('   要哪条回我 key，我就搬进正殿')
      }
      const awaitReview = reviewPendingCount(env, sid)
      if (awaitReview > 0) {
        lines.push('· 📝 待复核 ' + awaitReview + ' 条：压缩存档等着补写记忆（不影响对话，下次整理时我会补）')
      }
      // 会话日志体量：每次压缩完成都报账本大小；>50MB 预警（2026-11-18 外部 bug 报告：日志只增不减，过大后请求体可能被静默截断，~91MB 必坏）
      const logBytes = env.sessionLogBytes && env.sessionLogBytes.get(sid)
      if (logBytes) {
        const mb = (logBytes / 1048576).toFixed(1)
        if (logBytes > 50 * 1024 * 1024) {
          lines.push('· ⚠️ 当前账本 ' + mb + 'MB（>50MB 预警）：接近请求体截断风险（~91MB 必坏），建议重置会话')
        } else {
          lines.push('· 当前账本 ' + mb + 'MB（安全线以内）')
        }
      }
      lines.push('· 可以继续对话了')
    } else {
      lines.push('【记忆守夜人】本轮自动压缩没成功 ⚠️')
      lines.push('· 原因：' + String((result && result.reason) || '未知').slice(0, 120))
      lines.push('· 原文已存档，不影响你继续对话；下次到线会再试')
    }
    const text = lines.join('\n')
    session.append('user/message', {
      id: 'notify-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 10),
      role: 'user',
      content: [{ type: 'text', text }],
      source: { kind: 'user' },
    }, { surfaceOp: 'append' })
    env.glog({ ts: env.stamp(), event: 'notify', sessionId: sid, ok: !!(result && result.ok), ratioBefore, ratioAfter: after, text })
  } catch (err) {
    env.glog({ ts: env.stamp(), event: 'notify-error', sessionId: sid, message: String((err && err.message) || err) })
  }
}

function onStatus(env, { agent, status }) {
  const cfg = env.cfg
  try {
    if (!cfg.enabled || status !== 'idle' || !agent || !agent.session) return
    const sid = agent.session.id || agent.session.sessionId
    // ---- B 方案（2026-11-19 老板定）：每 5 轮定期整理（只整理，不压缩；压缩前仍有强制整理）----
    if (env.groomDue && env.groomDue.get(sid) && !env.pending.has(sid)) {
      env.groomDue.delete(sid)
      Promise.resolve()
        .then(() => extractAndWrite(env, agent, sid, null))
        .then((r) => { env.glog({ ts: env.stamp(), event: 'groom-periodic', sessionId: sid, applied: r && typeof r === 'object' ? r.applied : r }) })
        .catch((err) => { env.glog({ ts: env.stamp(), event: 'groom-periodic-error', sessionId: sid, message: String((err && err.message) || err) }) })
      return
    }
    const job = sid ? env.pending.get(sid) : null
    if (!job) return
    env.pending.delete(sid)
    const saved = preserve(env, agent, sid, job.ratio)
    env.log({ ts: env.stamp(), event: 'preserved', sessionId: sid, ratio: job.ratio, lines: saved ? saved.lines : 0, archive: saved ? saved.file : null })

    // 老板要插件自己压：四条路都试，拿到就压，拿不到就只记探针结果
    const probe = findCompaction(env.ctx, env.flags.compactionSvc)
    env.log({ ts: env.stamp(), event: 'compaction-probe', sessionId: sid, via: probe.via, report: probe.report })
    // 确定性判断：这个会话到底会不会真的压缩。只发开始不发完成会更吓人。
    // 通知移到 runCompact 里发——整理失败会延后压缩，不能提前挂"开始"通知。
    const willCompact = isSelfCompactWs(env, sid) || !!probe.svc
    const runCompact = (why, groomed) => {
      if (!willCompact) {
        env.glog({ ts: env.stamp(), event: 'compact-skipped', sessionId: sid, ratio: job.ratio, reason: 'no compaction path', after: why })
        return
      }
      notifyStart(env, agent, sid, job.ratio)
      // 白名单工作区：自己动手压（试验田先跑这条路）
      if (isSelfCompactWs(env, sid)) {
        const r = compactSelf(env, agent.session, sid, job.ratio, saved)
        env.glog({ ts: env.stamp(), event: 'self-compact', sessionId: sid, ratio: job.ratio, after: why, ...r })
        // 先发通知、再把提取水位设到通知之后，
        // 否则这条通知会被下一轮当成「对话内容」再提取一遍
        notifyDone(env, agent, sid, job.ratio, groomed, r, pendingAdded)
        if (r.ok) {
          try {
            const anchor = surfaceTail(agent.session)
            const st = loadState(cfg)
            if (!st.sessions) st.sessions = {}
            st.sessions[sid] = { ...(st.sessions[sid] || {}), lastSeq: anchor, lastCompactAt: env.stamp(), lastCompactRatio: job.ratio }
            saveState(cfg, st)
            if (anchor != null) env.lastSeqSeen.set(sid, anchor)
          } catch { /* ignore */ }
        }
        return
      }
      if (probe.svc) doCompact(env, probe.svc, agent, sid, job.ratio, saved)
      else env.glog({ ts: env.stamp(), event: 'compact-skipped', sessionId: sid, ratio: job.ratio, reason: 'no compaction service', after: why })
    }

    // 老板 2026-11-17 定的顺序：先整理记忆 → 整理完 → 再压缩。严格串行，不并发。
    // 2026-11-17 老板补充：整理「真失败」时不要压——知识没提炼就压掉原文太危险。
    //   区分两种：模型正常答「没有值得记的」= 不算失败，照压；
    //   模型调用出错/超时 = 真失败，跳过本轮压缩，10 分钟冷却后重试；
    //   连续失败 3 次才放行压缩（防整理一直失败把压力憋到 75%）。
    let groomed = null
    let pendingAdded = []
    let groomFailed = false
    if (cfg.autoExtract) {
      Promise.resolve()
        .then(() => extractAndWrite(env, agent, sid, job.ratio))
        .then((r) => {
          const n = r && typeof r === 'object' ? r.applied : (typeof r === 'number' ? r : 0)
          groomed = n
          pendingAdded = (r && r.pending) || []
          groomFailed = !!(r && r.failed)
          env.glog({ ts: env.stamp(), event: 'groom-done', sessionId: sid, ratio: job.ratio, applied: n, failed: groomFailed, pending: pendingAdded.map((x) => x.key) })
          if (typeof n === 'number' && n < 0) env.backoff.set(sid, Date.now() + 10 * 60 * 1000)
        })
        .catch((err) => {
          groomed = -1
          groomFailed = true
          env.glog({ ts: env.stamp(), event: 'groom-error', sessionId: sid, message: String((err && err.message) || err) })
        })
        .finally(() => {
          env.failStreak = env.failStreak || new Map()
          if (groomFailed) {
            const streak = (env.failStreak.get(sid) || 0) + 1
            env.failStreak.set(sid, streak)
            if (streak < 3) {
              env.glog({ ts: env.stamp(), event: 'compact-deferred', sessionId: sid, ratio: job.ratio, reason: 'groom failed', streak })
              return
            }
            env.glog({ ts: env.stamp(), event: 'compact-forced', sessionId: sid, ratio: job.ratio, reason: 'groom failed 3x, keep context alive' })
            env.failStreak.delete(sid)
          } else {
            env.failStreak.delete(sid)
          }
          runCompact('after-groom', groomed)
        })
    } else {
      env.glog({ ts: env.stamp(), event: 'saved-only', sessionId: sid, ratio: job.ratio, archive: saved ? saved.file : null, note: '自动提取已关，等手动整理' })
      runCompact('no-extract', null)
    }
  } catch (err) {
    env.log({ ts: env.stamp(), event: 'idle-error', message: String((err && err.message) || err) })
  }
}


module.exports = {
  DEFAULTS,
  PROMPT,
  SYSTEM_MARKERS,
  appendJsonl,
  appendLine,
  collectSince,
  compactSelf,
  doCompact,
  effectiveThreshold,
  ensureDir,
  extractAndWrite,
  findCompaction,
  isSelfCompactWs,
  itemsEmpty,
  loadState,
  buildCompactDigest,
  looksSystem,
  num,
  onPreStep,
  onStatus,
  parseItems,
  pickUsed,
  preserve,
  readJson,
  saveState,
  surfaceTail,
  textOf,
  updateCoreLine,
  workspacePathOf,
  writeEvent,
  writeJson,
  writePending,
  writeTopic,
  wsOf,
}
