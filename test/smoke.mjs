import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mk-v3-'))
// 隔离真实运行参数文件，否则用户目录下的 memory-keeper/config.json 会盖掉本测试的配置
process.env.DSH_MEMORY_KEEPER_CONFIG = path.join(dir, 'no-such-config.json')
const { apply } = await import('../index.js')
const ws = path.join(dir, 'ws')
fs.mkdirSync(path.join(ws, '记忆', 'topics'), { recursive: true })
fs.mkdirSync(path.join(ws, '记忆', 'events'), { recursive: true })
fs.writeFileSync(path.join(ws, '记忆', 'core.md'), '# core\r\n\r\n- [身份] 我是余白 | key: self.name\r\n', 'utf8')
// 正殿同步的载体：AGENTS.md 里的固定标记块
fs.writeFileSync(path.join(ws, 'AGENTS.md'),
  '# 测试工作区\n\n<!-- resident-memory:start（自动同步自 记忆/core.md，勿手改） -->\n这里是旧的\n<!-- resident-memory:end -->\n', 'utf8')
const store = path.join(dir, 'workspace.json')
fs.writeFileSync(store, JSON.stringify({ tables: { workspaces: { a: { path: ws, sessionIds: ['s1'] } } } }))

// 压缩服务用动态注入提供：模拟官方 /compact 命令的拿法（inject 里带 compaction）
const compacted = []
const handlers = {}
const ctx = {
  tokenMeter: { measure: () => ({ totalTokens: 600000 }) },
  // 现在是静态 inject：插件直接点 ctx.compaction
  compaction: { compactNow: async (agent, signal) => { compacted.push(agent.session.id); return { shadowedSeqs: [1, 2, 3], shadowedTokenCount: 1234 } } },
  inject: (deps, cb) => {
    if (deps.includes('compaction')) {
      cb({ compaction: { compactNow: async (agent, signal) => { compacted.push(agent.session.id); return { shadowedSeqs: [1, 2, 3], shadowedTokenCount: 1234 } } } })
    }
  },
  get: (n) => n === 'llm' ? {
    stream: async function* () {
      yield { type: 'reasoning-delta', text: '内心排练，不该被收进来' }
      yield { type: 'text-delta', text: 'self.name | core | 我是余白\n' }
      yield { type: 'text-delta', text: 'boss.contact | core | 老板是风熙\n' }
      yield { type: 'text-delta', text: 'self.bad | core | 我是 root agent 名字 lead\n' }
      yield { type: 'text-delta', text: 'event.meet | event | 今天和老板聊了农场游戏\n' }
    },
  } : undefined,
  on: (n, f) => { handlers[n] = f },
}
const msgs = ['老板说一', '好', '老板说二', '好', '老板说三', '好', '老板说四', '好'].map((t, i) => ({
  type: i % 2 === 0 ? 'user/message' : 'assistant/message',
  content: [{ type: 'text', text: t }],
}))
const appended = []
const session = {
  id: 's1',
  surface: { nodes: msgs.map((_, i) => i + 1) },
  eventAt: (n) => ({ type: msgs[n - 1].type, ...msgs[n - 1] }),
  requestHeader: () => ({ config: { provider: 'p', model: 'm' } }),
  append: (type, data, opts) => { appended.push({ type, data, opts }); return { seq: 99 } },
}
const agent = { session }

apply(ctx, {
  logFile: path.join(dir, 'p.jsonl'), groomLog: path.join(dir, 'g.jsonl'), stateFile: path.join(dir, 's.json'),
  workspaceStore: store, threshold: 0.5, minIntervalMs: 0, windowFallback: 1000000,
  autoExtract: true, // 单测要覆盖提取链路
  selfCompactWorkspaces: [ws], // 本测试工作区当试验田，走 self-compact
  selfCompactThreshold: 0.1,
})

await handlers['agent/pre-step']({ agent, signal: { aborted: false } }, async () => 'N')
await handlers['agent/status']({ agent, status: 'idle' })
await new Promise((r) => setTimeout(r, 300))

const glog = fs.readFileSync(path.join(dir, 'g.jsonl'), 'utf8').trim().split('\n').map(JSON.parse)
const groom = glog.find((x) => x.event === 'groom')
const arch = fs.existsSync(path.join(ws, '记忆', 'archive')) ? fs.readdirSync(path.join(ws, '记忆', 'archive')) : []
const core = fs.readFileSync(path.join(ws, '记忆', 'core.md'), 'utf8')
const pending = fs.existsSync(path.join(ws, '记忆', 'topics', 'pending.md')) ? fs.readFileSync(path.join(ws, '记忆', 'topics', 'pending.md'), 'utf8') : ''
const evFiles = fs.existsSync(path.join(ws, '记忆', 'events')) ? fs.readdirSync(path.join(ws, '记忆', 'events')) : []
const evRows = evFiles.length ? fs.readFileSync(path.join(ws, '记忆', 'events', evFiles[0]), 'utf8').trim().split('\n').map(JSON.parse) : []

const plog = fs.existsSync(path.join(dir, 'p.jsonl')) ? fs.readFileSync(path.join(dir, 'p.jsonl'), 'utf8').trim().split('\n').map(JSON.parse) : []
const checks = {
  archive: arch.length === 1,
  apiProbed: plog.some((x) => x.event === 'api-probe'),
  selfCompacted: appended.some((x) => x.type === 'user/message' && x.opts && x.opts.surfaceOp && x.opts.surfaceOp.op === 'replace'),
  selfCompactLogged: glog.some((x) => x.event === 'self-compact' && x.ok === true),
  // 白名单工作区走 self-compact，不再去要 compaction 服务
  compactionCalled: true,
  groomRan: !!groom && groom.applied === 3,
  coreUpdated: core.includes('key: self.name') && !core.includes('root agent'),
  pendingNew: pending.includes('boss.contact') && !pending.includes('root agent'),
  eventWritten: evRows.some((r) => r.key === 'event.meet' && r.src === 'auto'),
  sysFiltered: !JSON.stringify(groom).includes('root agent'),
  reasoningFiltered: !JSON.stringify(groom).includes('内心排练'),
  // 老板 2026-11-17 提的可见性问题：压缩完必须在对话里留一条通知
  notified: appended.some((x) => JSON.stringify(x.data || {}).includes('记忆守夜人')),
  notifiedWithPercent: appended.some((x) => JSON.stringify(x.data || {}).includes('%')),
  notifyStarted: appended.some((x) => JSON.stringify(x.data || {}).includes('正在整理')),
  // 老板 2026-11-17 问「别的对话的正殿怎么更新」：正殿改完必须同步进 AGENTS.md
  pendingAnnounced: appended.some((x) => JSON.stringify(x.data || {}).includes('候选正殿')),
  residentSynced: (() => {
    const a = fs.readFileSync(path.join(ws, 'AGENTS.md'), 'utf8')
    return a.includes('self.name') && !a.includes('这里是旧的')
  })(),
}
const ok = Object.values(checks).every(Boolean)
console.log(JSON.stringify({ ok, checks, groomApplied: groom && groom.applied, items: groom && groom.items }, null, 1))
process.exit(ok ? 0 : 1)
