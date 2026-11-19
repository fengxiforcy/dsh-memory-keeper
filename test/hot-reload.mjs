/**
 * 热加载验收：改 logic.cjs 后，不重启进程，下一条事件必须用新代码。
 * 用「阈值翻转」作为可观测证据：默认 0.55，改成 0.95 后同一条压力样本的 over 必须从 true 变 false。
 * 再补一条鲁棒性：把 logic.cjs 写坏，插件必须继续用上一份逻辑跑，只落一条 logic-load-failed。
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

const SRC = path.resolve(import.meta.dirname, '..')
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mk-hot-'))
for (const f of ['index.js', 'logic.cjs', 'package.json']) {
  fs.copyFileSync(path.join(SRC, f), path.join(dir, f))
}
const LOGIC = path.join(dir, 'logic.cjs')

process.env.DSH_MEMORY_KEEPER_CONFIG = path.join(dir, 'no-such-config.json')
const { apply } = await import(pathToFileURL(path.join(dir, 'index.js')).href)

const logFile = path.join(dir, 'p.jsonl')
const handlers = {}
const ctx = {
  tokenMeter: { measure: () => ({ totalTokens: 600000 }) },
  on: (n, f) => { handlers[n] = f },
  get: () => undefined,
}
// 故意不传 threshold：要测的是 logic.cjs 里 DEFAULTS 改了能不能立刻生效
apply(ctx, {
  logFile,
  groomLog: path.join(dir, 'g.jsonl'),
  stateFile: path.join(dir, 's.json'),
  workspaceStore: path.join(dir, 'none.json'),
  windowFallback: 1000000,
  minIntervalMs: 999999,
})

const readLog = () => fs.readFileSync(logFile, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse)
const step = (sid) => handlers['agent/pre-step']({ agent: { session: { id: sid, surface: { nodes: [] }, eventAt: () => null } }, signal: { aborted: false } }, async () => 'N')
const lastPressure = (sid) => [...readLog()].reverse().find((x) => x.event === 'step-pressure' && x.sessionId === sid)

step('s1')
const before = lastPressure('s1')

const src = fs.readFileSync(LOGIC, 'utf8')
if (!src.includes('threshold: 0.55,')) throw new Error('测试前置失败：没找到默认阈值')
fs.writeFileSync(LOGIC, src.replace('threshold: 0.55,', 'threshold: 0.95,'), 'utf8')
await new Promise((r) => setTimeout(r, 1200))
step('s2')
const after = lastPressure('s2')

// 鲁棒性：写坏文件，看插件是否还活着
fs.writeFileSync(LOGIC, 'this is ( not { valid javascript', 'utf8')
await new Promise((r) => setTimeout(r, 1200))
step('s3')
const after2 = lastPressure('s3')
const logs = readLog()

// 修回来，确认能自愈（模拟「改错了再改对」）
fs.writeFileSync(LOGIC, src, 'utf8')
await new Promise((r) => setTimeout(r, 1200))
step('s4')
const after3 = lastPressure('s4')

const checks = {
  loadedFirstTime: logs.some((x) => x.event === 'logic-loaded'),
  thresholdWasDefault: before && before.over === true,
  hotReloadApplied: after && after.over === false,
  reloadLogged: logs.some((x) => x.event === 'logic-reloaded'),
  brokenFileRejected: logs.some((x) => x.event === 'logic-load-failed'),
  survivedBrokenFile: after2 && after2.over === false,      // 继续用上一份（0.95）逻辑
  healedAfterFix: after3 && after3.over === true,           // 改回 0.55 又生效
  noCrash: true,
}
const ok = Object.values(checks).every(Boolean)
console.log(JSON.stringify({ ok, checks, trace: { before: before && before.over, after: after && after.over, broken: after2 && after2.over, healed: after3 && after3.over } }, null, 1))
process.exit(ok ? 0 : 1)
