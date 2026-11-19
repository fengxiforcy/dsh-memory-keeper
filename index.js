/**
 * dsh-memory-keeper v3.2 —— 插件壳（稳定，很少改）
 *
 * 只有壳才被 cordis 静态加载。真正会变的逻辑都在 logic.cjs，
 * 壳按 mtime 清 require 缓存再重新 require：改完 logic.cjs，下一条 agent 事件就用新代码，
 * 不用重启 DSH。状态（排队/水位/退避）留在壳里，所以热加载不丢现场。
 *
 * 热加载的两个保险：
 *   1. 新 logic.cjs 解析失败 → 继续用旧版本，只写一条 logic-load-failed 日志，绝不把插件带崩；
 *   2. 参数也能热改：$DSH_HOME/memory-keeper/config.json 每次事件按 mtime 重读，
 *      合并优先级 壳默认 < cordis 配置 < config.json。改阈值、白名单、开关都不用重启。
 *
 * 红线：inject 里永远只写 tokenMeter。写进 compaction 会因为等不到服务导致整插件不加载。
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'

// CommonJS 同步加载：改完 logic.cjs 立刻生效，不存在「异步 import 还没回来」的抢跑
const require = createRequire(import.meta.url)

export const name = 'dsh-memory-keeper'
export const inject = ['tokenMeter']

const HERE = path.dirname(fileURLToPath(import.meta.url))
const LOGIC_PATH = path.join(HERE, 'logic.cjs')
// 运行参数文件：存在就覆盖 cordis 配置，改完不用重启。
// DSH_MEMORY_KEEPER_CONFIG 可指向别处，测试用它隔离真实参数文件。
// 默认目录跟着 DSH_HOME 走（DSH 主进程会设置）；没有则降级到 ~/.dsh
const DSH_HOME = process.env.DSH_HOME || path.join(os.homedir(), '.dsh')
const KEEPER_DIR = path.join(DSH_HOME, 'memory-keeper')
const OVERRIDE_PATH = process.env.DSH_MEMORY_KEEPER_CONFIG || path.join(KEEPER_DIR, 'config.json')
const FALLBACK_LOG = path.join(KEEPER_DIR, 'pressure.jsonl')
const FALLBACK_GROOM = path.join(KEEPER_DIR, 'groom.jsonl')
// 改完文件到下一次事件之间，最多每秒 stat 一次，开销可以忽略
const STAT_INTERVAL_MS = 1000

function ensureDir(f) { try { fs.mkdirSync(path.dirname(f), { recursive: true }) } catch { /* ignore */ } }
function appendJsonl(f, o) { try { ensureDir(f); fs.appendFileSync(f, JSON.stringify(o) + '\n', 'utf8') } catch { /* ignore */ } }
function readJson(f, d) { try { return JSON.parse(fs.readFileSync(f, 'utf8')) } catch { return d } }

export function apply(ctx, config = {}) {
  const env = {
    ctx,
    cfg: {},
    stamp: () => new Date().toISOString(),
    lastLog: new Map(),
    pending: new Map(),
    lastSeqSeen: new Map(),
    backoff: new Map(),
    wsMemo: new Map(),
    apiProbed: new Set(),
    flags: { announced: false, compactionSvc: null },
  }
  env.log = (o) => appendJsonl(env.cfg.logFile || FALLBACK_LOG, o)
  env.glog = (o) => appendJsonl(env.cfg.groomLog || FALLBACK_GROOM, o)

  let L = null
  let loadedMtime = 0
  let lastStat = 0
  let overrideCache = {}
  let overrideMtime = -1

  /** 运行时参数：壳默认 < cordis 配置 < config.json。改完不用重启。 */
  function refreshCfg() {
    let ov = overrideCache
    try {
      const st = fs.statSync(OVERRIDE_PATH)
      if (st.mtimeMs !== overrideMtime) {
        overrideMtime = st.mtimeMs
        overrideCache = readJson(OVERRIDE_PATH, {}) || {}
        ov = overrideCache
        if (L) env.log({ ts: env.stamp(), event: 'config-override', keys: Object.keys(ov) })
      }
    } catch { if (overrideMtime !== -1) { overrideMtime = -1; overrideCache = {} } ov = overrideCache }
    env.cfg = { ...((L && L.DEFAULTS) || {}), ...config, ...ov }
  }

  /** 按 mtime 重新加载 logic.mjs；失败就留着旧版本继续跑。 */
  function tickReload(force) {
    const now = Date.now()
    if (!force && now - lastStat < STAT_INTERVAL_MS) return
    lastStat = now
    let st
    try { st = fs.statSync(LOGIC_PATH) } catch (err) {
      if (!L) env.log({ ts: env.stamp(), event: 'logic-missing', path: LOGIC_PATH, message: String((err && err.message) || err) })
      return
    }
    if (L && st.mtimeMs === loadedMtime) return
    const mtime = Math.round(st.mtimeMs)
    try {
      const resolved = require.resolve(LOGIC_PATH)
      delete require.cache[resolved]
      const m = require(resolved)
      const first = !L
      L = m
      loadedMtime = st.mtimeMs
      env.log({ ts: env.stamp(), event: first ? 'logic-loaded' : 'logic-reloaded', mtime })
    } catch (err) {
      // 新版本解析失败：旧 L 原样保留，插件继续用上一份逻辑跑，绝不被新代码带崩
      env.log({ ts: env.stamp(), event: 'logic-load-failed', mtime, keeping: L ? 'previous' : 'none', message: String((err && err.message) || err).slice(0, 400) })
    }
  }

  // 先用 cordis 配置把日志路径定下来，再加载 logic.cjs：
  // 否则首次的 logic-loaded 会落到默认路径，而不是配置里指定的 logFile。
  refreshCfg()
  tickReload(true)
  refreshCfg()

  ctx.on('agent/pre-step', (payload, next) => {
    try {
      tickReload()
      if (L) { refreshCfg(); L.onPreStep(env, payload) }
    } catch (err) {
      env.log({ ts: env.stamp(), event: 'shell-error', where: 'pre-step', message: String((err && err.message) || err) })
    }
    return next()
  })

  ctx.on('agent/status', (evt) => {
    try {
      tickReload()
      if (L) { refreshCfg(); L.onStatus(env, evt || {}) }
    } catch (err) {
      env.log({ ts: env.stamp(), event: 'shell-error', where: 'status', message: String((err && err.message) || err) })
    }
  })

  // 启动 4 秒后探一次压缩服务（不等压力到线），结果直接落日志
  setTimeout(() => {
    try {
      tickReload(true)
      refreshCfg()
      if (!L) { env.log({ ts: env.stamp(), event: 'compaction-probe-boot', via: 'logic-not-ready' }); return }
      const probe = L.findCompaction(ctx, env.flags.compactionSvc)
      env.log({ ts: env.stamp(), event: 'compaction-probe-boot', via: probe.via, report: probe.report })
    } catch (err) {
      env.log({ ts: env.stamp(), event: 'compaction-probe-error', message: String((err && err.message) || err) })
    }
  }, 4000)
}
