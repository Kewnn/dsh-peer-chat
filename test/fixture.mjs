/**
 * dsh-peer-chat · 测试夹具（test/ 下所有 *.test.mjs 共用）
 *
 * 约定（下一个人接手请先读这五条）：
 *   1. 一切落盘产物都在 os.tmpdir() 的一次性目录里（makeTempRoot → 跑完自动删），
 *      **不读也不写用户的 DSH_HOME / peers.json / chains.json**；
 *   2. 每个测试用显式 config（peersFile / chainsFile / localHome）把插件钉在临时目录上，
 *      不依赖机器上的真实实例；
 *   3. 会话日志用 zstd 帧写（session.v4.jsonl.zstd），形状与真实 DSH 一致；
 *   4. 假 HTTP 对端只实现本插件会调的方法：`/`（登录取 cookie）、`session/create`、
 *      `session/prompt`、`agentPresets/list`，其余一律 404/失败，防止「静默兼容」；
 *   5. 每个 *.test.mjs 都是独立进程，由 run-all.mjs 逐套拉起（每套 120s 超时），
 *      所以模块级状态（如自动发现缓存 30s）不会跨套件串味。
 *
 * 运行单个套件：node test/token.test.mjs
 */
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { zstdCompressSync, zstdDecompressSync } from 'node:zlib'

export const PLUGIN_URL = new URL('../index.js', import.meta.url).href

const ZSTD_MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd])
const SESSION_FILE = 'session.v4.jsonl.zstd'
const WORKSPACE = '--E-peer-chat-test--'

// ── 环境与临时目录 ────────────────────────────────────────────

/**
 * 抹掉会改变结果的真实环境变量：
 *   - PEER_TOKEN / PEER_CHAT_PEERS：会顶掉测试自己的 token 与 peers 表；
 *   - DSH_HOME / DSH_PROFILE_DIR：会让「读 profile 识别模式」「推导 peers 路径」这两条回退路径
 *     读到测试机的真实 profile（实测踩过：没抹 DSH_PROFILE_DIR 时 profile 回退认出 8 个真实模式）。
 * 需要这些变量的用例自己临时设置、finally 里删掉。
 */
export function sanitizeEnv() {
  for (const key of ['PEER_TOKEN', 'PEER_CHAT_PEERS', 'DSH_HOME', 'DSH_PROFILE_DIR']) delete process.env[key]
}

const tempRoots = []

/** 建一次性临时根目录（系统 temp 下），返回绝对路径。 */
export function makeTempRoot(label = 'peer-chat') {
  const safe = String(label).replace(/[^\w.-]+/g, '-')
  const root = mkdtempSync(join(tmpdir(), `${safe}-`))
  tempRoots.push(root)
  return root
}

/** 删除本轮所有临时根目录。 */
export function cleanupTempRoots() {
  while (tempRoots.length > 0) {
    const root = tempRoots.pop()
    try { rmSync(root, { recursive: true, force: true }) } catch { /* Windows 偶发占用：留给系统 temp 清理 */ }
  }
}

// ── 套件骨架：PASS/FAIL 行 + SUMMARY + 退出码 ─────────────────

const closers = []

/** 登记一个收尾动作（一般是假对端的 close），套件结束前按后进先出执行。 */
export function trackClose(fn) {
  closers.push(fn)
}

async function closeTracked() {
  while (closers.length > 0) {
    const fn = closers.pop()
    try { await fn() } catch { /* 收尾失败不影响结论 */ }
  }
}

export function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/**
 * 跑一个测试套件：
 *   await runSuite('token', async ({ check, expectThrow, tempRoot }) => { ... })
 * 输出格式固定为「PASS/FAIL  用例名  细节」+「SUMMARY passed=… failed=… total=…」，
 * run-all.mjs 靠最后一行计数。任一条 FAIL → 退出码 1。
 */
export async function runSuite(name, body) {
  sanitizeEnv()
  const results = []
  const check = (label, ok, detail = '') => {
    results.push({ label, ok })
    console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail === '' ? '' : `  ${detail}`}`)
  }
  const expectThrow = async (label, fn, fragment) => {
    try {
      await fn()
      check(label, false, '没有抛错')
    } catch (error) {
      const message = String(error?.message ?? error)
      check(label, message.includes(fragment), message.split(/\r?\n/)[0].slice(0, 160))
    }
  }

  console.log(`\n── ${name} ──`)
  try {
    await body({ check, expectThrow, tempRoot: makeTempRoot(name) })
  } catch (error) {
    check('套件自身未抛未捕获异常', false, String(error?.stack ?? error).split(/\r?\n/).slice(0, 3).join(' ⏎ '))
  }
  await closeTracked()
  cleanupTempRoots()
  const failed = results.filter((row) => !row.ok).length
  console.log(`\nSUMMARY passed=${results.length - failed} failed=${failed} total=${results.length}`)
  await sleep(100) // 让 stdout 排空，避免管道下 SUMMARY 被截断
  process.exit(failed === 0 ? 0 : 1)
}

// ── 插件加载与 ctx 桩 ────────────────────────────────────────

let pluginPromise = null

/** 加载被测插件（同一进程只 import 一次）。 */
export function loadPlugin() {
  pluginPromise ??= import(PLUGIN_URL)
  return pluginPromise
}

/** 造一个够用的宿主 ctx：tools.register/get、服务 get、effect（立即执行）。 */
export function makeCtx({ services = {}, tools = {} } = {}) {
  const registry = new Map()
  const ctx = {
    tools: {
      register(definition) {
        registry.set(definition.name, definition)
        return () => registry.delete(definition.name)
      },
      get(name) {
        return tools[name]
      },
    },
    get(name) {
      return services[name]
    },
    effect(fn) {
      const dispose = fn()
      return typeof dispose === 'function' ? dispose : () => {}
    },
  }
  return { ctx, registry }
}

/**
 * 加载插件并 apply 到桩 ctx 上。
 * 返回 { mod, ctx, registry, tool(name), run(name, args, exec) }，run 省略 exec 时给 {}。
 */
export async function applyPlugin({ config = {}, services = {}, tools = {} } = {}) {
  const mod = await loadPlugin()
  const { ctx, registry } = makeCtx({ services, tools })
  mod.apply(ctx, config)
  return {
    mod,
    ctx,
    registry,
    tool: (name) => registry.get(name),
    run: (name, args, exec) => {
      const definition = registry.get(name)
      if (definition === undefined) throw new Error(`工具 ${name} 没注册`)
      return definition.execute(args, exec ?? {})
    },
  }
}

// ── 会话日志（zstd 多帧）─────────────────────────────────────

/** 把事件数组压成一帧。 */
export function frame(events) {
  return zstdCompressSync(Buffer.from(`${events.map((event) => JSON.stringify(event)).join('\n')}\n`))
}

/** 会话日志路径：sessions/<workspace>/<sid>/session.v4.jsonl.zstd。 */
export function sessionPath(home, sessionId) {
  return join(home, 'sessions', WORKSPACE, sessionId, SESSION_FILE)
}

/** 覆盖写一段会话日志（不存在则建目录）。 */
export function writeSessionLog(home, sessionId, events) {
  const file = sessionPath(home, sessionId)
  mkdirSync(dirname(file), { recursive: true })
  writeFileSync(file, frame(events))
  return file
}

/** 往既有日志尾部追加一帧（模拟对端跑完一轮）。 */
export function appendSessionLog(home, sessionId, events) {
  const file = sessionPath(home, sessionId)
  mkdirSync(dirname(file), { recursive: true })
  appendFileSync(file, frame(events))
  return file
}

/** 一轮问答的三条事件：user → assistant → turn/end。 */
export function replyEvents(text, turn = 1) {
  return [
    { type: 'user/message', data: { turn, message: { content: [{ type: 'text', text: 'q' }] } } },
    { type: 'assistant/message', data: { turn, message: { content: [{ type: 'text', text }] } } },
    { type: 'turn/end', data: { turn } },
  ]
}

/** 直接写一轮 assistant 回复。 */
export function writeReply(home, sessionId, text, turn = 1) {
  return writeSessionLog(home, sessionId, replyEvents(text, turn))
}

/** 逐帧解 zstd 后拼成字符串；半截帧跳过（和插件同口径）。 */
function readFrames(file) {
  const buffer = readFileSync(file)
  const starts = []
  let at = 0
  for (;;) {
    const found = buffer.indexOf(ZSTD_MAGIC, at)
    if (found < 0) break
    starts.push(found)
    at = found + 4
  }
  const chunks = []
  if (starts.length === 0) {
    chunks.push(buffer.toString('utf8'))
  } else {
    for (let index = 0; index < starts.length; index += 1) {
      const slice = buffer.subarray(starts[index], index + 1 < starts.length ? starts[index + 1] : buffer.length)
      try { chunks.push(zstdDecompressSync(slice).toString('utf8')) } catch { /* 半截帧 */ }
    }
  }
  return chunks.join('')
}

/** 读会话日志里最大的 turn（没有日志则为 0）。 */
export function lastTurnOf(home, sessionId) {
  if (home === '' || sessionId === '') return 0
  const file = sessionPath(home, sessionId)
  if (!existsSync(file)) return 0
  let last = 0
  for (const line of readFrames(file).split(/\r?\n/)) {
    if (line.trim() === '') continue
    try {
      const turn = JSON.parse(line)?.data?.turn
      if (typeof turn === 'number' && turn > last) last = turn
    } catch { /* 坏行 */ }
  }
  return last
}

// ── peers / chains / 启动日志 ────────────────────────────────

export function writeJson(file, value) {
  mkdirSync(dirname(file), { recursive: true })
  writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`)
}

export function readJson(file) {
  return JSON.parse(readFileSync(file, 'utf8'))
}

/** 写一行 DSH 启动日志（token 的来源）。 */
export function writeBootLog(home, url, token, fileName = 'web-console.log') {
  mkdirSync(home, { recursive: true })
  const file = join(home, fileName)
  writeFileSync(file, `dsh web: ${String(url).replace(/\/+$/, '')}/?token=${token}\n`)
  return file
}

/** 把文件 mtime 往前拨 msAgo 毫秒，用于制造「哪个日志更新」的次序。 */
export function ageFile(file, msAgo) {
  const time = new Date(Date.now() - msAgo)
  utimesSync(file, time, time)
}

// ── 假 HTTP 对端 ────────────────────────────────────────────

export function emptyCapture() {
  return { creates: [], prompts: [], logins: [], methods: [] }
}

/**
 * 起一个假 DSH 对端：
 *   - GET /?token=…        → 303 + set-cookie（token 不对则 401）
 *   - session/create       → 记下请求体；agentPreset 以 bad 开头则回 preset-not-found
 *   - session/prompt       → 记下正文，往 home 的会话日志写一轮回复（turn 自动 +1）
 *   - agentPresets/list    → 返回 presets（给了才实现，否则方法不可用）
 * 返回 { url, home, token, port, capture, close() }；close 已登记到 trackClose。
 */
export async function startFakePeer(options = {}) {
  const {
    name = 'peer',
    token,
    home = '',
    replies = null,          // ((text, index) => string) | string[] | null（默认「回:<正文>」）
    latencyMs = 0,
    presets = null,
    failPresets = false,
    failPresetPrefix = 'bad',
    requireCookie = true,
    capture = emptyCapture(),
    onPrompt = null,
  } = options

  if (typeof token !== 'string' || token === '') throw new Error('startFakePeer 需要 token')

  const cookie = `dsh-auth-${name}=v1.fake.sig`
  let port = 0
  let sessions = 0

  const server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', `http://127.0.0.1:${port}`)
    if (req.method === 'GET' && url.pathname === '/') {
      const given = url.searchParams.get('token') ?? ''
      capture.logins.push(given)
      if (given === token) {
        res.writeHead(303, { 'set-cookie': `${cookie}; Path=/; HttpOnly` })
        res.end()
        return
      }
      res.writeHead(401, { 'content-type': 'text/plain' })
      res.end('unauthorized')
      return
    }
    if (req.method !== 'POST' || !url.pathname.startsWith('/api/')) {
      res.writeHead(404)
      res.end('no')
      return
    }
    const method = url.pathname.slice('/api/'.length)
    if (requireCookie && req.headers.cookie !== cookie) {
      res.writeHead(401, { 'content-type': 'text/plain' })
      res.end('unauthorized')
      return
    }
    let body = ''
    req.on('data', (chunk) => { body += chunk })
    req.on('end', () => {
      capture.methods.push(method)
      let envelope = {}
      try { envelope = JSON.parse(body) } catch { /* 下面按空信封回错 */ }
      const request = envelope?.payload?.args?.request ?? {}
      const ok = (value) => {
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ type: 'server-response', rpcId: envelope.rpcId, result: { ok: true, value } }))
      }
      const fail = (code, message) => {
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ type: 'server-response', rpcId: envelope.rpcId, result: { ok: false, error: { code, message } } }))
      }

      if (method === 'session/create') {
        capture.creates.push(request)
        if (typeof request.agentPreset === 'string' && request.agentPreset.startsWith(failPresetPrefix)) {
          fail('session/preset-not-found', `unknown preset ${request.agentPreset}`)
          return
        }
        sessions += 1
        ok({ sessionId: `session-${name}-${sessions}` })
        return
      }

      if (method === 'session/prompt') {
        const sessionId = request.sessionId
        const text = request.content?.[0]?.text ?? ''
        capture.prompts.push({ sessionId, text, request })
        const pick = () => {
          if (typeof replies === 'function') return replies(text, capture.prompts.length - 1)
          if (Array.isArray(replies)) return replies[Math.min(capture.prompts.length - 1, replies.length - 1)]
          return `回:${text}`
        }
        const write = () => {
          if (home === '') return
          const turn = lastTurnOf(home, sessionId) + 1
          // 真实 DSH 的会话日志是追加帧；已有文件就 append，否则首帧。
          if (existsSync(sessionPath(home, sessionId))) appendSessionLog(home, sessionId, replyEvents(pick(), turn))
          else writeSessionLog(home, sessionId, replyEvents(pick(), turn))
        }
        if (latencyMs > 0) setTimeout(write, latencyMs)
        else write()
        if (typeof onPrompt === 'function') onPrompt({ sessionId, text, request })
        ok({ accepted: true })
        return
      }

      if (method === 'agentPresets/list') {
        if (failPresets) {
          fail('gateway/method-unavailable', 'preset roster not exported')
          return
        }
        if (presets === null) {
          fail('gateway/lookup-not-found', `no method ${method}`)
          return
        }
        ok({ presets })
        return
      }

      fail('gateway/lookup-not-found', `no method ${method}`)
    })
  })

  await new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve()))
  port = server.address().port

  const state = {
    name,
    token,
    home,
    port,
    capture,
    url: `http://127.0.0.1:${port}`,
    async close() {
      await new Promise((resolve) => server.close(resolve))
    },
  }
  trackClose(() => state.close())
  return state
}
