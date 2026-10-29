/**
 * dsh-peer-chat —— 跨 DSH 实例端到端对话，自动识别对端 web token。
 *
 * 三个工具（统一 peer_ 前缀，不与上游 session_* 撞名）：
 *   peer_token({ peer })                      识别 token（只报前 6 位 + 来源，不泄露全文）
 *   peer_ask({ peer, message, ... })           投递消息并取回回复
 *   peer_tail({ peer, sessionId, n })          取对端最近 n 条 assistant 消息
 *
 * 两条路线：
 *   remote（默认）：HTTP 登录取 cookie → 对端 session/create → session/prompt → 轮询对端会话日志。
 *   本机会话（建/投/插）归 dsh-session-tools / dsh-session-plus，本插件不碰。
 *
 * token 识别优先级：
 *   1) config.token / PEER_TOKEN 环境变量
 *   2) <peerHome>/*.log 里最后一处 `dsh web: http://127.0.0.1:P/?token=XXX`
 *   3) peers.json 里缓存的 token
 * 登录遇 401 → 重扫日志 → token 变了就重试一次 → 把新 token 写回 peers.json。
 *
 * 与 session-tools / session-plus 的边界（不重复造轮子、不注册同名 domain）：
 *   - 本插件不注册任何 cordis 服务/domain，只 register 三个 peer_* 工具。
 *   - 本机建会话：优先复用 session-tools 已注册的 session_create 工具；拿不到（或它被审批拦住）时，
 *     回退到自己 ctx.agents.create（照 dsh-session-plus 的写法，agentOptions 必传）。
 *   - 本机插话：优先复用 session-tools 的 session_send；拿不到时走 sessionController.prompt。
 *   - 跨实例（remote）：对端的会话由对端自己的 session-tools / agents 负责，本插件只调对端 HTTP 的
 *     session/create 与 session/prompt，不在本机替对端建会话。
 *
 * 依赖面：本文件不 import 任何宿主内部包，peer 依赖只有 @deepseek-ai/cordis。
 * 工具用「原始 JSON Schema + execute」注册（ctx.tools.register），因此不需要 dsh-tools 的 defineTool。
 *
 * RPC 信封（对齐本仓 packages/client/connection + packages/api/gateway 的实测形状）：
 *   POST <base>/api/<namespace>/<method>
 *   body: { type: 'client-request', rpcId, method, payload: { args: { <wire>: value } } }
 *   resp: { type: 'server-response', result: { ok: true, value } | { ok: false, error } }
 * 注意：peer-chat.mjs 里旧版按 `result.sessionId` 解析，那是过期形状；本插件按上面的实际信封解析。
 */
import { randomUUID } from 'node:crypto'
import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, statSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { zstdDecompressSync } from 'node:zlib'

export const name = 'dsh-peer-chat'
export const inject = ['tools', 'agents']
const PACKAGE_VERSION = '2.2.0'
/** 兜底工作目录：cwd 拿不到时用它，避免会议落到 sessions\_no-cwd（前端 session/not-found）。 */
const DEFAULT_LOCAL_WORKSPACE = 'E:\\dshsystem\\Documents\\deepseek-harness\\default-workspace'

/** zstd 帧起始魔数：会话日志是「多帧首尾相接」的，要逐帧解。 */
const ZSTD_MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd])
const SESSION_FILE = 'session.v4.jsonl.zstd'
const LOG_NAMES = ['web-console.log', 'console.log', 'dsh-web.log']

// CREATE_TRACE：每次"本插件建会话"都留一行，用于区分"插件建的"还是"前端建的"。
// 排查 _no-cwd 时看这个日志里有没有对应 sessionId：没有 → 不是插件建的。
function traceCreate(config, entry) {
  try {
    const home = (typeof config?.localHome === 'string' && config.localHome.trim() !== '') ? config.localHome.trim() : (process.env.DSH_HOME ?? '')
    if (home === '') return
    const dir = join(home, 'peer-chat')
    mkdirSync(dir, { recursive: true })
    appendFileSync(join(dir, 'create.log'), JSON.stringify({ t: new Date().toISOString(), ...entry }) + '\n', 'utf8')
  } catch { /* 日志失败不影响主流程 */ }
}
const TOKEN_IN_LOG = /dsh web:\s*http:\/\/[^\s]*[?&]token=([A-Za-z0-9_-]{20,})/g
const DEFAULT_TIMEOUT_MS = 120_000
const POLL_INTERVAL_MS = 1_500
const RENDER_LIMIT = 4_000
const TAIL_LIMIT = 1_200

// ── 配置面 ──────────────────────────────────────────────────

/**
 * peers 表的位置（换机器也能用）：
 *   1) config.peersFile
 *   2) 环境变量 PEER_CHAT_PEERS
 *   3) <DSH_HOME>/peer-chat/peers.json（推荐，跟着用户 home 走）
 * 都没命中时返回 3) 的路径，用于报错提示。
 */
/**
 * 反推运行时路径：config > env > process.argv 里的 ...\profiles\<name> > cwd。
 * 桌面端（Electron）既不带 DSH_HOME 也不带 DSH_PROFILE_DIR，但 argv 里有 profile 路径。
 */
function runtimePaths(config) {
  const profileFromArgv = () => {
    for (const arg of process.argv ?? []) {
      const hit = String(arg).match(/^(.*[\\/]profiles[\\/][^\\/]+)[\\/]?$/i)
      if (hit !== null) return hit[1]
    }
    return ''
  }
  const profileDir = (typeof config?.profileDir === 'string' && config.profileDir.trim() !== '' ? config.profileDir.trim() : '')
    || (process.env.DSH_PROFILE_DIR ?? '').trim()
    || profileFromArgv()
  const fromProfile = (() => {
    if (profileDir === '') return ''
    const parent = dirname(profileDir)
    return basename(parent).toLowerCase() === 'profiles' ? dirname(parent) : parent
  })()
  const home = (typeof config?.localHome === 'string' && config.localHome.trim() !== '' ? config.localHome.trim() : '')
    || (process.env.DSH_HOME ?? '').trim()
    || fromProfile
  return { home, profileDir }
}

function peersFileOf(config) {
  const fromConfig = typeof config?.peersFile === 'string' ? config.peersFile.trim() : ''
  if (fromConfig !== '') return fromConfig
  const fromEnv = (process.env.PEER_CHAT_PEERS ?? '').trim()
  if (fromEnv !== '') return fromEnv
  const candidates = peersFileCandidates(config)
  return candidates.find((path) => existsSync(path)) ?? candidates[0]
}

function peersFileCandidates(config) {
  const home = runtimePaths(config).home
  if (home === '') return []
  return [join(home, 'peer-chat', 'peers.json')]
}

/** 显式令牌（最高优先级）：config.token 等同旧的 --token，其次 PEER_TOKEN。 */
function overrideTokenOf(config) {
  const fromConfig = typeof config?.token === 'string' ? config.token.trim() : ''
  if (fromConfig !== '') return { token: fromConfig, source: 'config.token（等同 --token）', kind: 'env' }
  const fromEnv = (process.env.PEER_TOKEN ?? '').trim()
  if (fromEnv !== '') return { token: fromEnv, source: 'PEER_TOKEN', kind: 'env' }
  return null
}

function readPeers(file) {
  let raw
  try {
    raw = readFileSync(file, 'utf8').replace(/^\uFEFF/, '')
  } catch (error) {
    throw new Error(`读不到 peers 表 ${file}：${error?.message ?? String(error)}。新建这个文件即可，内容形如 {"longer":{"url":"http://127.0.0.1:3090","home":"<对端 DSH_HOME>"}}；也可用 config.peersFile 或 PEER_CHAT_PEERS 指到别处`)
  }
  let parsed
  try {
    parsed = JSON.parse(raw)
  } catch (error) {
    throw new Error(`peers 表 ${file} 不是合法 JSON：${error?.message ?? String(error)}`)
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`peers 表 ${file} 必须是「名字 → { url, home, token? }」的对象`)
  }
  return parsed
}

/** 原子写：先写同目录临时文件再 rename，避免半截文件。 */
function atomicWriteText(file, text) {
  const temp = `${file}.${process.pid}.${Date.now()}.tmp`
  writeFileSync(temp, text, 'utf8')
  renameSync(temp, file)
}

function savePeers(file, table) {
  atomicWriteText(file, `${JSON.stringify(table, null, 2)}\n`)
}

/**
 * 解析跨端目标：本插件只管「另一个 DSH 进程」。
 * peer 可以是 peers.json 里的名字、本机 self，或**端口**（3090 / "127.0.0.1:3090"）——
 * 端口会先按 peers.json 的 url 匹配，再按自动发现结果匹配，都没有就用 http://127.0.0.1:<port> 直接连。
 */
function normalizePeerEntry(name, entry, config) {
  const home = typeof entry.home === 'string' ? entry.home.trim() : ''
  if (entry.local === true) {
    const localHome = home !== '' ? home : (runtimePaths(config).home)
    if (localHome === '') throw new Error(`peer「${name}」标了 local:true，但既没有 home 也没有 DSH_HOME`)
    return { name, local: true, url: '', home: localHome, token: '' }
  }
  const url = typeof entry.url === 'string' ? entry.url.trim().replace(/\/+$/, '') : ''
  const token = typeof entry.token === 'string' ? entry.token.trim() : ''
  if (url === '') {
    // 只有 home：典型是桌面端（Electron 内部服务，令牌在进程内存里拿不到）——只能 tail
    if (home === '') throw new Error(`peer「${name}」既没有 url 也没有 home`)
    return { name, local: false, tailOnly: true, url: '', home, token }
  }
  return { name, local: false, tailOnly: false, url, home, token }
}

function portOfRaw(raw) {
  if (/^\d{2,5}$/.test(raw)) return raw
  const match = /^\d{1,3}(?:\.\d{1,3}){3}:(\d{2,5})$/.exec(raw)
  return match === null ? '' : match[1]
}

function resolvePeerTarget(args, config) {
  const raw = optionalString(args, 'peer') ?? 'self'
  if (raw === 'self') {
    const home = runtimePaths(config).home
    if (home === '') throw new Error('peer:"self" 需要本机 DSH home：设置 DSH_HOME、传 config.localHome，或让进程参数里带 ...\\profiles\\<name>')
    return { name: 'self', local: true, url: '', home, token: '' }
  }
  const table = readPeers(peersFileOf(config))
  const entry = table[raw]

  if (raw !== 'self' && (entry === undefined || entry === null || typeof entry !== 'object')) {
    const discoveredByName = discoverPeers(config).find((item) => item.name === raw)
    if (discoveredByName !== undefined) {
      return { name: discoveredByName.name, local: false, url: discoveredByName.url, home: discoveredByName.home, token: discoveredByName.token }
    }
    const port = portOfRaw(raw)
    if (port !== '') {
      for (const [name, candidate] of Object.entries(table)) {
        const url = typeof candidate?.url === 'string' ? candidate.url : ''
        if (url !== '' && portOfUrl(url) === port) return normalizePeerEntry(name, candidate, config)
      }
      const discovered = discoverPeers(config)
      const hit = discovered.find((item) => portOfUrl(item.url) === port)
      if (hit !== undefined) return { name: hit.name, local: false, url: hit.url, home: hit.home, token: hit.token }
      return { name: `port-${port}`, local: false, url: `http://127.0.0.1:${port}`, home: '', token: '' }
    }
    const known = Object.keys(table).join(', ') || '（空）'
    const names = discoverPeers(config).map((item) => item.name).join(', ')
    throw new Error(`未知 peer「${raw}」；peers 表里只有：${known}${names === '' ? '' : `；自动发现到：${names}`}；也可以直接给端口（例如 3090）`)
  }

  return normalizePeerEntry(raw, entry, config)
}

// ── 自动发现（本机其它 DSH 实例）──────────────────────────────
const DISCOVER_TTL_MS = 30_000
let discoverState = { at: 0, peers: [] }

/** 从一个 home 的启动日志里同时取 url 与 token：`dsh web: http://127.0.0.1:P/?token=…` 一行就够。 */
function bootLines(home) {
  if (home === '') return []
  const files = []
  const push = (path) => {
    try { files.push({ path, mtime: statSync(path).mtimeMs }) } catch { /* 不在就跳过 */ }
  }
  for (const logName of LOG_NAMES) push(join(home, logName))
  try {
    for (const entry of readdirSync(home, { withFileTypes: true })) {
      if (entry.isFile() && /\.log$/i.test(entry.name)) push(join(home, entry.name))
    }
  } catch { /* home 不可读 */ }
  files.sort((a, b) => b.mtime - a.mtime)
  const out = []
  for (const file of files) {
    let content = ''
    try { content = readFileSync(file.path, 'utf8') } catch { continue }
    const matches = [...content.matchAll(/dsh web:\s*(https?:\/\/[^\s]*[?&]token=([A-Za-z0-9_-]{20,}))/g)]
    if (matches.length === 0) continue
    const last = matches.at(-1)
    let url = ''
    try { const parsed = new URL(last[1]); url = `${parsed.protocol}//${parsed.host}` } catch { /* 坏 URL 跳过 */ }
    if (url !== '') out.push({ url, token: last[2], source: file.path })
  }
  return out
}

/** 扫哪些根目录：config.discoverRoots → DSH_HOME 的同级 → 用户目录 → 各盘根。 */
function discoverRoots(config) {
  const configured = Array.isArray(config?.discoverRoots)
    ? config.discoverRoots.filter((item) => typeof item === 'string' && item.trim() !== '')
    : []
  if (configured.length > 0) return configured
  const roots = []
  const detected = runtimePaths(config).home
  if (detected !== '') roots.push(basename(detected) === 'dsh-home' ? dirname(detected) : detected)
  roots.push(homedir())
  if (process.platform === 'win32') {
    for (const letter of ['C', 'D', 'E', 'F', 'G']) {
      const root = `${letter}:\\`
      if (existsSync(root)) roots.push(root)
    }
  }
  return [...new Set(roots.map((item) => item.replace(/[\\/]+$/, '')))]
}

/**
 * 找本机的其它 DSH 实例：有限深度 + 时间预算内扫根目录，认「含 profiles/ 或名为 dsh-home」的目录，
 * 且有启动日志的才算（没日志拿不到令牌）。结果缓存 30 秒。
 */
function discoverPeers(config, options) {
  const now = Date.now()
  const force = options?.force === true
  if (!force && now - discoverState.at < DISCOVER_TTL_MS) return discoverState.peers
  const maxDepth = Number.isFinite(config?.discoverDepth) ? Math.max(1, Math.min(Math.trunc(config.discoverDepth), 5)) : 3
  const budgetMs = Number.isFinite(options?.budgetMs) ? Math.max(150, Math.trunc(options.budgetMs))
    : Number.isFinite(config?.discoverBudgetMs) ? Math.max(150, Math.trunc(config.discoverBudgetMs))
      : 300
  const maxDirs = Number.isFinite(config?.discoverMaxDirs) ? Math.max(200, Math.trunc(config.discoverMaxDirs)) : 3_000
  const deadline = now + budgetMs
  const skip = new Set(['node_modules', '.git', '.cache', 'sessions', 'profiles', 'attachments', 'storages', 'data', 'logs', 'dist', 'build',
    'Windows', 'Program Files', 'Program Files (x86)', 'ProgramData', 'AppData', '$Recycle.Bin', 'System Volume Information', 'Recovery', 'MSOCache'])
  const found = new Map()

  let scanned = 0
  const visit = (dir, depth) => {
    if (Date.now() > deadline || depth > maxDepth || scanned > maxDirs) return
    let entries
    try { entries = readdirSync(dir, { withFileTypes: true }) } catch { return }
    scanned += 1
    if (scanned > maxDirs || Date.now() > deadline) return
    const names = new Set(entries.map((entry) => entry.name))
    if (names.has('profiles') || basename(dir) === 'dsh-home') {
      const [boot] = bootLines(dir)
      if (boot !== undefined && !found.has(dir)) {
        const name = basename(dir) === 'dsh-home' ? basename(dirname(dir)) : basename(dir)
        found.set(dir, { name, url: boot.url, home: dir, token: boot.token, source: boot.source })
      }
    }
    for (const entry of entries) {
      if (Date.now() > deadline || scanned > maxDirs) return
      if (!entry.isDirectory() || entry.name.startsWith('.') || skip.has(entry.name)) continue
      visit(join(dir, entry.name), depth + 1)
    }
  }

  for (const root of discoverRoots(config)) {
    if (Date.now() > deadline) break
    visit(root, 0)
  }
  const peers = [...found.values()]
  const seen = new Map()
  for (const peer of peers) {
    const count = seen.get(peer.name) ?? 0
    seen.set(peer.name, count + 1)
    if (count > 0) peer.name = `${peer.name}-${count + 1}`
  }
  discoverState = { at: Date.now(), peers }
  return peers
}

// ── token 识别 ──────────────────────────────────────────────

/**
 * 扫 home 下所有 *.log，按修改时间倒序，取每份日志里「最后一处」启动行；按 token 去重后返回候选。
 * 为什么要多候选：「最新写入的日志」不一定属于「正在跑的那个进程」——例如有人另起过一次实例、
 * 把新行 tee 进了 web-console.log，而活着的进程仍然是更早那个 token（实测踩到）。
 */
function tokenCandidates(home) {
  if (home === '') return []
  const files = []
  const push = (path) => {
    try { files.push({ path, mtime: statSync(path).mtimeMs }) } catch { /* 文件不在就跳过 */ }
  }
  for (const logName of LOG_NAMES) push(join(home, logName))
  try {
    for (const entry of readdirSync(home, { withFileTypes: true })) {
      if (entry.isFile() && /\.log$/i.test(entry.name)) push(join(home, entry.name))
    }
  } catch { /* home 不可读：只剩固定名候选 */ }
  files.sort((a, b) => b.mtime - a.mtime)
  const seen = new Set()
  const out = []
  for (const file of files) {
    let text = ''
    try { text = readFileSync(file.path, 'utf8') } catch { continue }
    const matches = [...text.matchAll(TOKEN_IN_LOG)]
    if (matches.length === 0) continue
    const token = matches.at(-1)[1]
    if (seen.has(token)) continue
    seen.add(token)
    out.push({ token, source: file.path })
  }
  return out
}

/** 首选项：最新日志里的最后一处（原来的单值语义）。 */
function tokenFromLogs(home) {
  const [first] = tokenCandidates(home)
  return first === undefined ? null : { token: first.token, source: first.source }
}

function portOfUrl(url) {
  try {
    const parsed = new URL(url)
    return parsed.port !== '' ? parsed.port : (parsed.protocol === 'https:' ? '443' : '80')
  } catch {
    return ''
  }
}

/**
 * tokenCommand：让用户自定义「怎么把对端令牌捞出来」。
 * 模板里可写 {peer} {url} {home} {port}，运行后从 stdout 里取最后一个 `token=xxx`
 * （或最后一段 20+ 位的裸令牌）。典型用法：指到 scripts/read-token.ps1 去读对端 cmd 的控制台缓冲区。
 */
async function tokenFromCommand(peer, config) {
  const template = typeof config?.tokenCommand === 'string' ? config.tokenCommand.trim() : ''
  if (template === '') return null
  const shellValue = (value) => `"${String(value ?? '').replace(/"/g, '')}"`
  const port = portOfUrl(peer.url)
  const command = template
    .replaceAll('{peer}', shellValue(peer.name))
    .replaceAll('{url}', shellValue(peer.url))
    .replaceAll('{home}', shellValue(peer.home))
    .replaceAll('{port}', /^\d+$/.test(port) ? port : '')
  const { exec } = await import('node:child_process')
  const stdout = await new Promise((resolve) => {
    exec(command, { timeout: 15_000, windowsHide: true, maxBuffer: 1 << 20 }, (error, out) => {
      resolve(typeof out === 'string' ? out : String(out ?? ''))
    })
  })
  const tagged = [...stdout.matchAll(/token[=:]\s*([A-Za-z0-9_-]{20,})/gi)]
  const bare = [...stdout.matchAll(/(?:^|\s)([A-Za-z0-9_-]{20,})(?=\s|$)/g)]
  const token = tagged.at(-1)?.[1] ?? bare.at(-1)?.[1] ?? ''
  if (token === '') return null
  return { token, source: `tokenCommand（${command.slice(0, 60)}…）`, kind: 'command' }
}

/** 按优先级解析 token：env → 日志 → tokenCommand → peers.json 缓存；返回 { token, source, kind } 或 null。 */
async function resolveToken(peer, config) {
  const override = overrideTokenOf(config)
  if (override !== null) return override
  const fromLog = tokenFromLogs(peer.home)
  if (fromLog !== null) return { token: fromLog.token, source: fromLog.source, kind: 'log' }
  const fromCommand = await tokenFromCommand(peer, config)
  if (fromCommand !== null) return fromCommand
  if (peer.token !== '') return { token: peer.token, source: 'peers.json（缓存）', kind: 'cache' }
  return null
}

// ── HTTP（remote 路线）──────────────────────────────────────

async function login(base, token) {
  const res = await fetch(`${base}/?token=${encodeURIComponent(token)}`, {
    redirect: 'manual',
    signal: AbortSignal.timeout(8_000),
  })
  const setCookie = typeof res.headers.getSetCookie === 'function' ? res.headers.getSetCookie() : []
  const cookie = setCookie.map((entry) => entry.split(';')[0]).join('; ')
  return { ok: cookie !== '', status: res.status, cookie }
}

/** 一次 unary RPC；失败抛错，401 单独标记给调用方。 */
async function rpc(base, cookie, method, args, signal) {
  const res = await fetch(`${base}/api/${method}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie },
    body: JSON.stringify({
      type: 'client-request',
      rpcId: `dsh-peer-chat-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      method,
      payload: { args },
    }),
    signal,
  })
  const text = await res.text()
  if (res.status === 401) {
    const error = new Error(`${method}：HTTP 401（登录 cookie 失效）`)
    error.unauthorized = true
    throw error
  }
  let body = null
  try { body = JSON.parse(text) } catch { /* 下面对非法响应统一报错 */ }
  const result = body?.result
  if (result === null || typeof result !== 'object') {
    throw new Error(`${method}：HTTP ${res.status} 不是网关响应：${text.slice(0, 200)}`)
  }
  if (result.ok !== true) {
    const failure = result.error ?? {}
    const detail = typeof failure.message === 'string' ? failure.message : text.slice(0, 200)
    throw new Error(`${method} 失败：${failure.code ?? 'unknown'} ${detail}`)
  }
  return result.value
}

/**
 * 登录开路：401 时重扫日志，token 变了就重试一次并写回 peers.json。
 * 显式令牌（config.token / PEER_TOKEN）不做重扫——用户既然指定了，就尊重它。
 */
async function openSession(peer, peersFile, config) {
  const resolved = await resolveToken(peer, config)
  if (resolved === null) {
    throw new Error(`找不到 ${peer.name} 的 token：可用 config.token / PEER_TOKEN 直接给，或配 tokenCommand 让插件自己去捞（例如读对端 cmd 的控制台缓冲区），或用带 tee 的启动器重启对端以产出 ${join(peer.home || '<home>', 'web-console.log')}`)
  }
  let token = resolved
  let logged = await login(peer.url, token.token)
  const explicit = overrideTokenOf(config) !== null
  if (!logged.ok && !explicit) {
    // 401：把「日志候选 + peers.json 缓存 + tokenCommand」合起来依次试一遍（日志最新优先），
    // 第一个能登上的写回缓存。缓存和命令都要进候选：日志可能是过期进程留下的，缓存/命令行反而是新的。
    const candidates = [
      ...tokenCandidates(peer.home),
      ...(peer.token === '' ? [] : [{ token: peer.token, source: 'peers.json（缓存）' }]),
    ]
    const fromCommand = await tokenFromCommand(peer, config)
    if (fromCommand !== null) candidates.push({ token: fromCommand.token, source: fromCommand.source })
    const tried = new Set([token.token])
    for (const candidate of candidates) {
      if (tried.has(candidate.token)) continue
      tried.add(candidate.token)
      const retried = await login(peer.url, candidate.token)
      if (!retried.ok) continue
      logged = retried
      const kind = candidate.source.startsWith('peers.json') ? 'cache'
        : candidate.source.startsWith('tokenCommand') ? 'command' : 'log'
      token = { token: candidate.token, source: candidate.source, kind }
      try {
        const table = readPeers(peersFile)
        table[peer.name] = { ...table[peer.name], token: candidate.token, tokenAt: new Date().toISOString() }
        savePeers(peersFile, table)
      } catch { /* 写回失败不该毁掉这次对话：缓存只是加速，日志才是权威 */ }
      break
    }
    if (!logged.ok) {
      throw new Error(`登录 ${peer.url} 失败（HTTP ${logged.status}）：试过 ${tried.size} 个 token（日志候选 + 缓存 + tokenCommand）都不行。若对端刚重启且没留下 web-console.log，请手工更新 ${peersFile} 里 ${peer.name} 的 token，或配 tokenCommand 去读它的控制台。`)
    }
  }
  if (!logged.ok) {
    throw new Error(`登录 ${peer.url} 失败（HTTP ${logged.status}）：token 无效或实例未起。若对端刚重启且没有 web-console.log，请手工更新 ${peersFile} 里 ${peer.name} 的 token。`)
  }
  return { cookie: logged.cookie, token }
}

// ── 本机会话（local 路线：复用 session-tools，退到 agents.create）──

function errorLine(error) {
  return String(error?.message ?? error ?? '').split(/\r?\n/)[0].slice(0, 160)
}

/** 与 session-tools 的 currentSelection 同口径：先读本会话投影，再退到默认模型。 */
function currentSelectionOf(ctx, agent) {
  const projections = ctx.get?.('sessionProjections')
  if (projections !== undefined && agent?.session !== undefined) {
    try {
      const state = projections.stateOf(agent.session, 'modelSelection')
      const inherited = state?.pending ?? state?.lastUsed
      if (typeof inherited?.provider === 'string' && typeof inherited?.model === 'string') {
        return {
          provider: inherited.provider,
          model: inherited.model,
          ...(inherited.reasoningEffort === undefined ? {} : { reasoningEffort: inherited.reasoningEffort }),
        }
      }
    } catch { /* 没有投影就退到默认模型 */ }
  }
  const selected = ctx.get?.('agentDefaultModel')?.currentSelection?.()
  if (typeof selected?.provider === 'string' && typeof selected?.model === 'string') {
    return { provider: selected.provider, model: selected.model }
  }
  return undefined
}

/** 兜底建会话：ctx.agents.create（照 dsh-session-plus 的写法，agentOptions 必传）。 */
async function createViaAgents(ctx, { preset, cwd, exec }) {
  const agents = ctx.get?.('agents')
  if (agents === undefined || typeof agents.create !== 'function') {
    throw new Error('本机没有 agents 服务，无法建会话（也没装 session-tools 的 session_create）')
  }
  const selection = currentSelectionOf(ctx, exec?.agent)
  if (selection === undefined) {
    throw new Error('拿不到默认 provider/model，无法建会话：先在界面选一次模型，或装 session-tools 用 session_create')
  }
  let presetId
  if (preset !== undefined) {
    const presets = ctx.get?.('agentPresets')
    if (presets === undefined || typeof presets.resolve !== 'function') {
      throw new Error('指定了默认模式，但本机没有 agentPresets 服务')
    }
    try {
      presetId = (await presets.resolve(preset)).id
    } catch {
      throw new Error(`未知模式：${preset}`)
    }
  }
  // header.cwd 是不可变的，只能在 create 时给定（见宿主 agent.ts createAgent: meta: { cwd }）。
  // 创建后再调 workingDirectory.set() 只改"有效目录"，改不了 header → 必须在这里就定下。
  const resolvedCwd = (typeof cwd === 'string' && cwd.trim() !== '') ? cwd.trim() : DEFAULT_LOCAL_WORKSPACE
  try { mkdirSync(resolvedCwd, { recursive: true }) } catch { /* 目录建不上也要让宿主报原错 */ }
  const sessionId = `session-${randomUUID()}`
  const handle = await agents.create({
    signal: exec?.signal,
    sessionId,
    agentOptions: selection,
    meta: {
      cwd: resolvedCwd,
      ...(presetId === undefined ? {} : { agentPreset: presetId }),
    },
    ...(presetId === undefined ? {} : {
      setup: async (agentCtx) => { await ctx.get('agentPresets').mount(agentCtx, presetId) },
    }),
  })
  // cwd 必须走 WorkingDirectoryService：meta.cwd 宿主不读，否则会话落 sessions\_no-cwd，
  // 前端点开会 session/not-found（2026-10-29 实测，产生过 4 个孤儿会话）。
  let wdTrace = 'not-called'
  try {
    const wd = ctx.get?.('workingDirectory')
    const target = (typeof cwd === 'string' && cwd.trim() !== '')
      ? cwd.trim()
      : DEFAULT_LOCAL_WORKSPACE
    if (wd === undefined) wdTrace = 'service-undefined'
    else if (typeof wd.set !== 'function') wdTrace = 'no-set-method'
    else if (handle?.agent === undefined) wdTrace = 'no-agent'
    else {
      await wd.set(handle.agent, target, exec?.signal)
      wdTrace = 'ok:' + target
    }
  } catch (e) { wdTrace = 'threw:' + (e && e.message ? e.message : String(e)).slice(0, 160) }
  const actual = handle?.agent?.session?.header?.id
  // 注意：不要读 ctx.config —— cordis 里未声明 inject 读取会抛
  // "cannot get property config without inject"。这里只用 DSH_HOME 兜底。
  traceCreate({}, {
    path: 'local/agents.create', sessionId, preset: presetId ?? null,
    cwdArg: cwd ?? null, cwdHeader: handle?.agent?.session?.header?.cwd ?? null, wd: wdTrace,
  })
  return typeof actual === 'string' && actual !== '' ? actual : sessionId
}

/** 本机投递：优先 session_send（session-tools），退到 sessionController.prompt。 */
async function deliverLocal(ctx, sessionId, message, exec) {
  const degraded = []
  const sendTool = ctx.tools?.get?.('session_send')
  if (sendTool !== undefined && typeof sendTool.execute === 'function') {
    try {
      await sendTool.execute({ sessionId, message }, { agent: exec?.agent, signal: exec?.signal })
      return { deliverVia: 'session_send（session-tools）', degraded }
    } catch (error) {
      degraded.push(`session_send 不可用：${errorLine(error)}`)
    }
  } else {
    degraded.push('本机没有 session_send（未装 session-tools）')
  }
  const controller = ctx.get?.('sessionController')
  if (controller === undefined || typeof controller.prompt !== 'function') {
    throw new Error(`无法投递到本机会话 ${sessionId}：既没有 session_send，也没有 sessionController.prompt。${degraded.join('；')}`)
  }
  await controller.prompt({
    requestId: `peer-chat-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    sessionId,
    mode: 'queue',
    content: [{ type: 'text', text: message }],
    clientTimeZone: Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC',
  }, exec?.signal ?? new AbortController().signal)
  return { deliverVia: 'sessionController.prompt', degraded }
}

/** 本机建会话：session_create（session-tools）→ agents.create + 投递。 */
async function createLocalSession(ctx, { message, preset, cwd, exec }) {
  const degraded = []
  const createTool = ctx.tools?.get?.('session_create')
  if (preset !== undefined) {
    degraded.push('指定了默认模式，session-tools 的 session_create 改不了，改走 agents.create')
  } else if (createTool === undefined || typeof createTool.execute !== 'function') {
    degraded.push('本机没有 session_create（未装 session-tools）')
  } else {
    try {
      // session_create 自带首条消息投递与标题推导；cwd 只能作为「已存在的工作区路径」传入。
      const value = await createTool.execute(
        { prompt: message, ...(cwd === undefined ? {} : { workspacePath: cwd }) },
        { agent: exec?.agent, signal: exec?.signal },
      )
      const sessionId = typeof value?.sessionId === 'string' ? value.sessionId : ''
      if (sessionId !== '') {
        return { sessionId, createVia: 'session_create（session-tools）', deliverVia: 'session_create（自带投递）', degraded }
      }
      degraded.push('session_create 没返回 sessionId')
    } catch (error) {
      degraded.push(`session_create 不可用：${errorLine(error)}`)
    }
  }
  const sessionId = await createViaAgents(ctx, { preset, cwd, exec })
  const delivered = await deliverLocal(ctx, sessionId, message, exec)
  return {
    sessionId,
    createVia: 'ctx.agents.create（兜底）',
    deliverVia: delivered.deliverVia,
    degraded: [...degraded, ...delivered.degraded],
  }
}

// ── 会话日志 ────────────────────────────────────────────────

/** 逐帧解 zstd 后按行 JSON 化；写一半的尾帧解不出来就跳过（对端可能正在写）。 */
function decodeEvents(file) {
  const buf = readFileSync(file)
  const starts = []
  let at = 0
  for (;;) {
    const found = buf.indexOf(ZSTD_MAGIC, at)
    if (found < 0) break
    starts.push(found)
    at = found + 4
  }
  const chunks = []
  if (starts.length === 0) {
    chunks.push(buf.toString('utf8'))
  } else {
    for (let index = 0; index < starts.length; index += 1) {
      const slice = buf.subarray(starts[index], index + 1 < starts.length ? starts[index + 1] : buf.length)
      try { chunks.push(zstdDecompressSync(slice).toString('utf8')) } catch { /* 半截帧：跳过 */ }
    }
  }
  const events = []
  for (const line of chunks.join('').split(/\r?\n/)) {
    if (line.trim() === '') continue
    try { events.push(JSON.parse(line)) } catch { /* 坏行：跳过 */ }
  }
  return events
}

/** 一条事件的可见正文：只取 text 段，reasoning / 工具调用不入正文。 */
function messageText(event) {
  const content = event?.data?.message?.content ?? event?.data?.content
  if (typeof content === 'string') return content.trim()
  if (!Array.isArray(content)) return ''
  return content
    .filter((part) => part?.type === 'text' && typeof part.text === 'string')
    .map((part) => part.text)
    .join('')
    .trim()
}

/** 汇总：最大 turn、assistant 消息列表、已收尾的 turn 集合。 */
function summarize(events) {
  let lastTurn = 0
  const assistants = []
  const endedTurns = new Set()
  for (const event of events) {
    const turn = typeof event?.data?.turn === 'number' ? event.data.turn : null
    if (turn !== null && turn > lastTurn) lastTurn = turn
    if (event?.type === 'assistant/message') {
      assistants.push({ turn: turn ?? lastTurn, text: messageText(event), time: event?.time })
    } else if (event?.type === 'turn/end' && turn !== null) {
      endedTurns.add(turn)
    }
  }
  return { lastTurn, assistants, endedTurns }
}

/** 会话日志路径：先试 sessions/<sid>/，再扫 sessions/<workspace>/<sid>/。 */
/** sessionId 只允许安全字符，且不许出现 ..（防路径穿越）。 */
function assertSafeSessionId(sessionId) {
  const text = String(sessionId ?? '').trim()
  if (text === '') throw new Error('sessionId 不能为空')
  if (!/^[A-Za-z0-9._-]+$/.test(text) || text.includes('..')) {
    throw new Error(`sessionId 不合法：${text.slice(0, 40)}（只允许字母数字 . _ -，且不能含 ..）`)
  }
  return text
}

function findSessionLog(home, sessionId) {
  if (home === '') return null
  const safeId = assertSafeSessionId(sessionId)
  const root = join(home, 'sessions')
  const direct = join(root, safeId, SESSION_FILE)
  if (existsSync(direct)) return direct
  let workspaces = []
  try {
    workspaces = readdirSync(root, { withFileTypes: true }).filter((entry) => entry.isDirectory())
  } catch {
    return null
  }
  for (const workspace of workspaces) {
    const candidate = join(root, workspace.name, safeId, SESSION_FILE)
    if (existsSync(candidate)) return candidate
  }
  return null
}

/**
 * 对端是不是停在"选择题"上：最后一个 tool/call 是 ask_user_question / show_view(options)，
 * 且之后没有用户回复 → 返回 { question, options:[label...], tool }。
 * 卡片类交互无法用文本回复驱动，所以要把选项翻译成文字，交给调用方决定（peer_send 回一个 label 即可）。
 */
function pendingQuestionOf(home, sessionId) {
  const file = findSessionLog(home, sessionId)
  if (file === null || file === undefined) return null
  let ev = []
  try {
    ev = decodeEvents(file)
  } catch { return null }
  // 精确判定：找最后一次 ask_user_question / show_view 的 tool/call，
  // 再看有没有**同一个 callId** 的 tool/result —— 没有就是还没答，卡片还挂着。
  // （中间的 user/assistant 正文都不能作为"已答"的依据：卡片要结构化答案才会消解。）
  for (let i = ev.length - 1; i >= 0; i--) {
    const e = ev[i]
    if (e?.type !== 'tool/call') continue
    const name = String(e?.data?.name ?? '')
    if (name !== 'ask_user_question' && name !== 'show_view') continue
    const callId = String(e?.data?.callId ?? '')
    const resolved = callId !== ''
      && ev.some((x) => x?.type === 'tool/result' && String(x?.data?.callId ?? '') === callId)
    if (resolved) return null
    let args = {}
    try { args = JSON.parse(String(e?.data?.arguments ?? '{}')) } catch { return null }
    const first = Array.isArray(args.questions) ? args.questions[0] : undefined
    if (first !== undefined) {
      const options = Array.isArray(first.options)
        ? first.options.map((o) => String(o?.label ?? o?.value ?? '')).filter((s) => s !== '')
        : []
      return {
        tool: name,
        question: String(first.question ?? first.header ?? '').trim(),
        options,
      }
    }
    const view = args.view
    if (view !== undefined && Array.isArray(view?.options)) {
      const options = view.options.map((o) => String(o?.label ?? '')).filter((s) => s !== '')
      return { tool: name, question: String(args.title ?? view?.question ?? '').trim(), options }
    }
    return null
  }
  return null
}

function lastTurnOf(home, sessionId) {
  const file = findSessionLog(home, sessionId)
  if (file === null) return 0
  try { return summarize(decodeEvents(file)).lastTurn } catch { return 0 }
}

/** 轮询会话日志，等「投递前最大 turn 之后」的 assistant 正文收尾。 */
async function waitForReply(home, sessionId, before, timeoutMs, signal, startedAt) {
  const deadline = startedAt + timeoutMs
  let reply = ''
  while (Date.now() < deadline) {
    if (signal?.aborted) throw new Error('peer_ask 已被取消')
    await sleep(Math.min(POLL_INTERVAL_MS, Math.max(deadline - Date.now(), 200)), signal)
    const file = findSessionLog(home, sessionId)
    if (file === null) continue
    let summary
    try { summary = summarize(decodeEvents(file)) } catch { continue }
    const fresh = summary.assistants.filter((item) => item.turn > before && item.text !== '')
    if (fresh.length === 0) continue
    reply = fresh.map((item) => item.text).join('\n\n')
    if ([...summary.endedTurns].some((turn) => turn > before)) return reply
    if (Date.now() > deadline - 4_000) return reply
  }
  return reply
}

// ── 小工具 ──────────────────────────────────────────────────

const sleep = (ms, signal) => new Promise((resolve) => {
  const done = () => {
    clearTimeout(timer)
    signal?.removeEventListener('abort', done)
    resolve()
  }
  const timer = setTimeout(done, ms)
  signal?.addEventListener('abort', done, { once: true })
})

function timeoutSignal(signal, ms) {
  const own = AbortSignal.timeout(ms)
  if (signal === undefined || signal === null) return own
  return typeof AbortSignal.any === 'function' ? AbortSignal.any([signal, own]) : own
}

function requireString(args, key, label) {
  const value = args?.[key]
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error(`${label} 必填：请给 ${key}（非空字符串）`)
  }
  return value.trim()
}

function optionalString(args, key) {
  const value = args?.[key]
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined
}

function optionalNumber(args, key, min, max) {
  const value = args?.[key]
  if (value === undefined || value === null) return undefined
  if (typeof value !== 'number' || !Number.isFinite(value)) throw new Error(`${key} 必须是数字`)
  return Math.min(Math.max(Math.round(value), min), max)
}

function truncate(text, limit) {
  return text.length <= limit ? text : `${text.slice(0, limit)}\n…（已截断：共 ${text.length} 字符）`
}

// ── ask（跨端）───────────────────────────────────────────────

async function askRemote(peer, peersFile, config, args, exec) {
  const started = Date.now()
  const message = requireString(args, 'message', 'peer_ask')
  const sessionIdArg = optionalString(args, 'sessionId')
  const preset = optionalString(args, 'preset')
  const cwd = optionalString(args, 'cwd')
  const timeoutMs = optionalNumber(args, 'timeoutMs', 5_000, 600_000) ?? DEFAULT_TIMEOUT_MS
  const rpcSignal = timeoutSignal(exec?.signal, 30_000)

  const session = await openSession(peer, peersFile, config)
  let sessionId = sessionIdArg
  let created = false
  let createVia = '对端既有会话'
  if (sessionId === undefined) {
    const value = await rpc(peer.url, session.cookie, 'session/create', {
      // RPC 参数是扁平对象（见 session-controller/src/client/sessions/manager.ts create()）：
      // { workspaceId? | cwd?, sessionId?, agentPreset? }。多包一层 request 会被忽略 → 落 _no-cwd。
      ...(cwd === undefined ? {} : { cwd }),
      ...(preset === undefined ? {} : { agentPreset: preset }),
    }, rpcSignal)
    sessionId = typeof value?.sessionId === 'string' ? value.sessionId : ''
    if (sessionId === '') {
      throw new Error(`session/create 没返回 sessionId：${JSON.stringify(value).slice(0, 200)}`)
    }
    created = true
    createVia = '对端 HTTP session/create'
    traceCreate(config, {
      path: 'remote/session.create', peer: peer.name, sessionId,
      preset: preset ?? null, cwdArg: cwd ?? null,
    })
  }

  const logFile = findSessionLog(peer.home, sessionId)
  if (!created && logFile === null) {
    throw new Error(`找不到会话 ${sessionId} 的日志（${join(peer.home || '<home>', 'sessions', '<workspace>', sessionId, SESSION_FILE)}）：无法判断哪条是新回复。先确认 peers.json 里 ${peer.name}.home 指向对端 DSH home。`)
  }
  const before = logFile === null ? 0 : lastTurnOf(peer.home, sessionId)
  await rpc(peer.url, session.cookie, 'session/prompt', {
    request: {
      requestId: `peer-chat-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      sessionId,
      mode: 'queue',
      content: [{ type: 'text', text: message }],
      clientTimeZone: Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC',
    },
  }, rpcSignal)

  const reply = await waitForReply(peer.home, sessionId, before, timeoutMs, exec?.signal, started)
  return {
    ok: reply !== '',
    peer: peer.name,
    route: 'remote',
    sessionId,
    created,
    createVia,
    deliverVia: '对端 HTTP session/prompt',
    degraded: [],
    reply,
    timedOut: reply === '',
    pendingQuestion: pendingQuestionOf(peer.home, sessionId) ?? undefined,
    waitedMs: Date.now() - started,
    turnsBefore: before,
    tokenSourceKind: session.token.kind,
    tokenSource: session.token.source,
  }
}

async function askLocal(ctx, peer, args, exec) {
  const started = Date.now()
  const message = requireString(args, 'message', 'peer_ask')
  const sessionIdArg = optionalString(args, 'sessionId')
  const preset = optionalString(args, 'preset')
  const cwd = optionalString(args, 'cwd')
  const timeoutMs = optionalNumber(args, 'timeoutMs', 5_000, 600_000) ?? DEFAULT_TIMEOUT_MS

  let sessionId = sessionIdArg
  let created = false
  let createVia = '本机既有会话'
  let deliverVia = ''
  let degraded = []
  let before = 0

  if (sessionId === undefined) {
    const outcome = await createLocalSession(ctx, { message, preset, cwd, exec })
    sessionId = outcome.sessionId
    created = true
    createVia = outcome.createVia
    deliverVia = outcome.deliverVia
    degraded = outcome.degraded
  } else {
    before = lastTurnOf(peer.home, sessionId)
    const delivered = await deliverLocal(ctx, sessionId, message, exec)
    deliverVia = delivered.deliverVia
    degraded = delivered.degraded
  }

  const reply = await waitForReply(peer.home, sessionId, before, timeoutMs, exec?.signal, started)
  return {
    ok: reply !== '',
    peer: peer.name,
    route: 'local',
    sessionId,
    created,
    createVia,
    deliverVia,
    degraded,
    reply,
    timedOut: reply === '',
    waitedMs: Date.now() - started,
    turnsBefore: before,
    pendingQuestion: pendingQuestionOf(peer.home, sessionId) ?? undefined,
    tokenSourceKind: 'local',
    tokenSource: '本机直连（无需 token）',
  }
}

/** 一步问答：按 peer 的分支走跨会话或跨端。peer_ask 与 peer_chain 共用。 */
async function runAsk(ctx, config, peer, args, exec) {
  if (peer.local) return askLocal(ctx, peer, args, exec)
  if (peer.tailOnly === true) {
    throw new Error(`peer「${peer.name}」只有 home、没有 url/token（例如桌面端内部服务），只能 peer_tail 读它的会话日志`)
  }
  return askRemote(peer, peersFileOf(config), config, args, exec)
}

/** 一步插话：同样按 peer 分支。peer_steer 与 peer_chain 共用。 */
async function runSteer(ctx, config, peer, args, exec) {
  if (peer.local) return steerLocal(ctx, peer, args, exec)
  if (peer.tailOnly === true) {
    throw new Error(`peer「${peer.name}」只有 home、没有 url/token，插话需要能登录的对端`)
  }
  return steerRemote(peer, peersFileOf(config), config, args, exec)
}

/**
 * 发送消息（不等回复）：把任意内容投进已存在的会话。
 * 与 peer_steer 的区别：steer 是"插到下一步边界"（打断当前 turn 语境）；
 * 这里的默认 mode='queue'，等于"发一条消息，等它这轮跑完再处理"。
 */
async function runSend(ctx, config, peer, args, exec) {
  const sessionId = requireString(args, 'sessionId', 'peer_send')
  const message = requireString(args, 'message', 'peer_send')
  const mode = optionalString(args, 'mode') ?? 'queue'

  if (peer.local) {
    if (mode === 'steer') return steerLocal(ctx, peer, { sessionId, message }, exec)
    const delivered = await deliverLocal(ctx, sessionId, message, exec)
    return {
      ok: true,
      peer: peer.name,
      route: 'local',
      sessionId,
      mode,
      deliverVia: delivered.deliverVia,
      degraded: delivered.degraded ?? [],
    }
  }

  if (peer.tailOnly === true) {
    throw new Error(`peer「${peer.name}」只有 home、没有 url/token，发送消息需要能登录的对端`)
  }
  if (mode === 'steer') return steerRemote(peer, peersFileOf(config), config, { sessionId, message }, exec)

  const session = await openSession(peer, peersFileOf(config), config)
  const logFile = findSessionLog(peer.home, sessionId)
  if (logFile === null) {
    throw new Error(`找不到会话 ${sessionId} 的日志（${join(peer.home || '<home>', 'sessions', '<workspace>', sessionId)}）：先确认 peers.json 里 ${peer.name}.home 指向对端 DSH home，且该会话在对端存在。`)
  }
  await rpc(peer.url, session.cookie, 'session/prompt', {
    request: {
      requestId: `peer-chat-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      sessionId,
      mode: 'queue',
      content: [{ type: 'text', text: message }],
      clientTimeZone: Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC',
    },
  }, timeoutSignal(exec?.signal, 30_000))
  return {
    ok: true,
    peer: peer.name,
    route: 'remote',
    sessionId,
    mode,
    deliverVia: '对端 HTTP session/prompt（queue）',
    tokenSourceKind: session.token.kind,
    tokenSource: session.token.source,
  }
}

/**
 * 链路版：按 steps 顺序多跳，上一步的回复作为下一步的上下文。
 * 模板里写 {prev} 就原位替换；没写就把上一步回复附在消息末尾。
 */
/**
 * 链路版：按 steps 顺序多跳，上一步回复作为下一步的上下文。
 * mode = 该步在**对端**用哪个 preset 建会话；优先级 steps[i].mode > 顶层 mode > 对端默认。
 * 无效 mode 报「未知模式」，不静默降级；{prev} 原位替换上一步回复。
 */
/** 链路某步解析出来是空消息时的兜底（面板"运行输入"留空会触发）。 */
const DEFAULT_STEP_MESSAGE = '（这一步没有给出输入。请先用一句话确认你在线，然后等下一步指令。）'

/** 按模式给默认消息模板；模板里可用 {input} / {prev}。 */
const MODE_TEMPLATES = {
  review: '审核上一步的产出。给结论与关键修改意见，最后**单独一行**写 NEXT（通过，进入下一步）或 REWORK（返工，重做上一步）：\n\n{prev}',
  build: '基于以下输入完成任务，直接给结果：\n\n{input}',
  continue: '基于上一步继续，给出下一步结果：\n\n{prev}',
}

function autoTemplateFor(mode, index) {
  const id = (mode ?? '').toLowerCase()
  if (/review|audit|check|审/.test(id)) return MODE_TEMPLATES.review
  if (index === 0) return MODE_TEMPLATES.build
  return MODE_TEMPLATES.continue
}

/**
 * 线性引用：{s1} 取第 1 步回复，{s1.json.foo} 从第 1 步的 JSON 里取字段。
 * 缺步骤 / 不是 JSON / 没这个字段 → 明确报错，不静默塞空串。
 */
function applyStepRefs(template, outputs) {
  return template.replace(/\{s(\d+)((?:\.json(?:\.[\w-]+|\[\d+\])*))?\}/g, (match, rawIndex, jsonPath) => {
    const index = Number(rawIndex) - 1
    const reply = outputs[index]
    if (reply === undefined) throw new Error(`引用了 {s${rawIndex}}，但第 ${rawIndex} 步还没有结果`)
    if (!jsonPath) return reply
    let data
    try {
      data = JSON.parse(reply)
    } catch {
      throw new Error(`第 ${rawIndex} 步的回复不是 JSON，取不到 {s${rawIndex}${jsonPath}}`)
    }
    const keys = []
    const walker = /\.([\w-]+)|\[(\d+)\]/g
    let hit
    while ((hit = walker.exec(jsonPath.slice('.json'.length))) !== null) {
      keys.push(hit[1] !== undefined ? hit[1] : Number(hit[2]))
    }
    let cursor = data
    for (let at = 0; at < keys.length; at += 1) {
      const key = keys[at]
      if (cursor === null || cursor === undefined || typeof cursor !== 'object' || !(key in cursor)) {
        throw new Error(`第 ${rawIndex} 步的 JSON 里没有字段 ${keys.slice(0, at + 1).join('.')}`)
      }
      cursor = cursor[key]
    }
    if (cursor === undefined) return ''
    return typeof cursor === 'string' ? cursor : JSON.stringify(cursor)
  })
}

/** 解析一步的消息：显式 message > 自定义模板（按模式）> 内置模板；随后替换 {sN}/{input}/{prev}。 */
function resolveStepMessage(step, mode, index, previous, input, templates, outputs) {
  const raw = typeof step.message === 'string' ? step.message.trim() : ''
  const custom = mode !== undefined && templates !== null && typeof templates === 'object'
    ? templates[mode]
    : undefined
  const template = raw !== '' && raw !== '__auto__'
    ? raw
    : (typeof custom === 'string' && custom.trim() !== '' ? custom.trim() : autoTemplateFor(mode, index))
  const withStepRefs = applyStepRefs(template, outputs ?? [])
  const withInput = withStepRefs.split('{input}').join(input)
  const built = previous === ''
    ? withInput.split('{prev}').join('')
    : withInput.includes('{prev}')
      ? withInput.split('{prev}').join(previous)
      : `${withInput}\n\n（上一步回复）\n${previous}`
  // 面板里「运行输入」留空时，{input} 会被替换成空串 → 整条消息为空 → peer_ask 报「必填」。
  // 链路不该因此停掉：兜一句最小可执行的默认消息。
  if (built.trim() === '') return DEFAULT_STEP_MESSAGE
  return built
}

/**
 * 返工判定：默认交给模型——回帖最后一行写 NEXT / REWORK（也认 通过/继续/下一个、返工/打回）。
 * 传了 failurePattern 就用正则覆盖；既没指令也没正则 → 默认 NEXT（继续下一个）。
 */
function judgeVerdict(reply, pattern) {
  if (typeof pattern === 'string' && pattern.trim() !== '') {
    try {
      return new RegExp(pattern, 'i').test(reply) ? 'rework' : 'next'
    } catch { /* 正则写坏就走指令 */ }
  }
  const lastLine = String(reply ?? '').split(/\r?\n/).map((line) => line.trim()).filter((line) => line !== '').at(-1) ?? ''
  if (/^(REWORK|返工|打回)\b/i.test(lastLine)) return 'rework'
  if (/^(NEXT|PASS|继续|下一个|通过)\b/i.test(lastLine)) return 'next'
  return 'next'
}

async function runChain(ctx, config, args, exec) {
  const started = Date.now()
  const chainName = optionalString(args, 'name')
  let steps = Array.isArray(args?.steps) ? args.steps : []
  let stopOnError = args?.stopOnError !== false
  let defaultMode = typeof args?.mode === 'string' && args.mode.trim() !== '' ? args.mode.trim() : undefined
  const input = typeof args?.input === 'string' ? args.input : ''
  const templates = args?.templates ?? null
  const failurePattern = typeof args?.failurePattern === 'string' ? args.failurePattern : ''
  const defaultRetries = Number.isFinite(args?.maxRetries) ? Math.max(0, Math.min(Math.trunc(args.maxRetries), 5)) : 2

  if (chainName !== undefined) {
    const table = readChains(chainsFileOf(config))
    const saved = table[chainName]
    if (saved === undefined || saved === null || typeof saved !== 'object') {
      throw new Error(`未知链路「${chainName}」；已有：${Object.keys(table).join(', ') || '（空）'}`)
    }
    if (steps.length === 0 && Array.isArray(saved.steps)) steps = saved.steps
    if (defaultMode === undefined && typeof saved.mode === 'string') defaultMode = saved.mode
    if (args?.stopOnError === undefined && saved.stopOnError === false) stopOnError = false
  }
  if (steps.length === 0) throw new Error('peer_chain 需要 steps（至少一步），或用 name 指定已保存的链路')
  if (steps.length > 10) throw new Error('peer_chain 最多 10 步')

  const totalBudget = Number.isFinite(args?.timeoutMs) ? Math.max(5_000, args.timeoutMs) : 10 * 60_000
  const results = []
  const outputs = []
  let previous = ''
  let reworks = 0

  const runStep = async (index, context) => {
    const step = steps[index]
    const peerName = typeof step.peer === 'string' ? step.peer.trim() : ''
    if (peerName === '') throw new Error(`peer_chain 第 ${index + 1} 步缺 peer`)
    const stepMode = typeof step.mode === 'string' && step.mode.trim() !== '' ? step.mode.trim() : defaultMode
    const message = resolveStepMessage(step, stepMode, index, context, input, templates, outputs)
    const peer = resolvePeerTarget({ peer: peerName }, config)
    const outcome = await runAsk(ctx, config, peer, {
      ...step,
      peer: peerName,
      message,
      ...(stepMode === undefined ? {} : { preset: stepMode }),
      timeoutMs: step.timeoutMs ?? args?.timeoutMs,
    }, exec)
    return { step, peerName, stepMode, message, outcome }
  }

  for (let index = 0; index < steps.length; index += 1) {
    if (Date.now() - started > totalBudget) {
      return { ok: false, timedOut: true, stoppedAt: index + 1, steps: results, final: previous, waitedMs: Date.now() - started }
    }
    let retries = 0
    const limit = Number.isFinite(steps[index]?.maxRetries)
      ? Math.max(0, Math.min(Math.trunc(steps[index].maxRetries), 5))
      : defaultRetries
    for (;;) {
      let run
      try {
        run = await runStep(index, previous)
      } catch (error) {
        const reason = errorLine(error)
        const stepMode = typeof steps[index]?.mode === 'string' && steps[index].mode.trim() !== ''
          ? steps[index].mode.trim()
          : defaultMode
        const invalidMode = stepMode !== undefined && /preset|未知|模式|unknown/i.test(reason)
        results.push({
          index: index + 1, peer: String(steps[index]?.peer ?? ''), sessionId: '', mode: String(stepMode ?? ''),
          status: 'failed', bytes: 0, ok: false, reply: '', waitedMs: 0,
          error: invalidMode ? `未知模式：${stepMode}（${reason}）` : reason,
        })
        if (steps[index]?.onFail === 'skip') {
          results[results.length - 1].status = 'skipped'
          break
        }
        if (stopOnError) return { ok: false, stoppedAt: index + 1, steps: results, final: '', waitedMs: Date.now() - started }
        break
      }

      results.push({
        index: index + 1,
        peer: run.peerName,
        sessionId: run.outcome.sessionId,
        mode: run.stepMode ?? '',
        status: run.outcome.ok ? 'ok' : 'failed',
        bytes: Buffer.byteLength(run.outcome.reply ?? '', 'utf8'),
        ok: run.outcome.ok,
        reply: run.outcome.reply,
        waitedMs: run.outcome.waitedMs,
        ...(retries > 0 ? { rework: retries } : {}),
      })

      const verdict = run.outcome.ok ? judgeVerdict(run.outcome.reply, failurePattern) : 'next'
      const failedReview = verdict === 'rework'
        && index > 0
        && retries < limit
        && steps[index]?.onFail !== 'stop'

      if (failedReview) {
        retries += 1
        reworks += 1
        // 返工：带上审阅意见，重跑上一步，再重回本步
        const reviewNote = `\n\n（上一轮审阅意见）\n${run.outcome.reply}`
        let redo
        try {
          redo = await runStep(index - 1, previous + reviewNote)
        } catch (error) {
          results.push({
            index, peer: String(steps[index - 1]?.peer ?? ''), sessionId: '', mode: '',
            status: 'failed', bytes: 0, ok: false, reply: '', waitedMs: 0, rework: retries, error: errorLine(error),
          })
          if (stopOnError) return { ok: false, stoppedAt: index + 1, steps: results, final: '', waitedMs: Date.now() - started }
          break
        }
        results.push({
          index,
          peer: redo.peerName,
          sessionId: redo.outcome.sessionId,
          mode: redo.stepMode ?? '',
          status: redo.outcome.ok ? 'rework' : 'failed',
          bytes: Buffer.byteLength(redo.outcome.reply ?? '', 'utf8'),
          ok: redo.outcome.ok,
          reply: redo.outcome.reply,
          waitedMs: redo.outcome.waitedMs,
          rework: retries,
        })
        if (!redo.outcome.ok && stopOnError) {
          return { ok: false, stoppedAt: index + 1, steps: results, final: '', waitedMs: Date.now() - started }
        }
        outputs[index - 1] = redo.outcome.reply
        previous = redo.outcome.reply
        continue
      }

      if (!run.outcome.ok) {
        if (steps[index]?.onFail === 'skip') {
          results[results.length - 1].status = 'skipped'
          break
        }
        if (stopOnError) {
          return { ok: false, stoppedAt: index + 1, steps: results, final: '', waitedMs: Date.now() - started }
        }
      }
      outputs[index] = run.outcome.reply
      previous = run.outcome.reply
      break
    }
  }

  return {
    ok: results.every((item) => item.status !== 'failed'),
    stoppedAt: 0,
    steps: results,
    final: previous,
    reworks,
    waitedMs: Date.now() - started,
  }
}

// ── 插话（steer）：回执语义，不等回复 ────────────────────────

/**
 * 远程插话：对端 HTTP session/prompt + mode:'steer'。
 * 语义（3090 实机核对过）：目标正在跑 → 消息在当前 turn 的 next-step 边界被消费，不新开 turn；
 * 目标空闲 → 会唤醒 driver、当场开一个 turn。两种情况都返回 accepted，不报错。
 */
async function steerRemote(peer, peersFile, config, args, exec) {
  const sessionId = requireString(args, 'sessionId', 'peer_steer')
  const message = requireString(args, 'message', 'peer_steer')
  const session = await openSession(peer, peersFile, config)
  await rpc(peer.url, session.cookie, 'session/prompt', {
    request: {
      requestId: `peer-steer-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      sessionId,
      mode: 'steer',
      content: [{ type: 'text', text: message }],
      clientTimeZone: Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC',
    },
  }, timeoutSignal(exec?.signal, 30_000))
  return {
    ok: true,
    peer: peer.name,
    route: 'remote',
    sessionId,
    mode: 'steer',
    accepted: true,
    deliveredVia: '对端 HTTP session/prompt（mode=steer）',
    targetStatus: '',
    degraded: [],
    tokenSourceKind: session.token.kind,
    tokenSource: session.token.source,
  }
}

/**
 * 本机插话：优先复用 dsh-session-plus 的 session_steer（它自己判断 running：跑着就 steer，
 * 空闲就 followup 排队，并在回执里说明用了哪种），拿不到才退到 sessionController.prompt(mode='steer')。
 */
async function steerLocal(ctx, peer, args, exec) {
  const sessionId = requireString(args, 'sessionId', 'peer_steer')
  const message = requireString(args, 'message', 'peer_steer')
  const degraded = []

  const steerTool = ctx.tools?.get?.('session_steer')
  if (steerTool !== undefined && typeof steerTool.execute === 'function') {
    try {
      const value = await steerTool.execute({ sessionId, message }, { agent: exec?.agent, signal: exec?.signal })
      const mode = value?.mode === 'queue' ? 'queue' : 'steer'
      return {
        ok: true,
        peer: peer.name,
        route: 'local',
        sessionId,
        mode,
        accepted: true,
        deliveredVia: 'session_steer（dsh-session-plus）',
        targetStatus: String(value?.targetStatus ?? ''),
        degraded,
        tokenSourceKind: 'local',
        tokenSource: '本机直连（无需 token）',
      }
    } catch (error) {
      degraded.push(`session_steer 不可用：${errorLine(error)}`)
    }
  } else {
    degraded.push('本机没有 session_steer（未装 dsh-session-plus）')
  }

  const controller = ctx.get?.('sessionController')
  if (controller === undefined || typeof controller.prompt !== 'function') {
    throw new Error(`无法向本机会话 ${sessionId} 插话：既没有 session_steer，也没有 sessionController.prompt。${degraded.join('；')}`)
  }
  await controller.prompt({
    requestId: `peer-steer-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    sessionId,
    mode: 'steer',
    content: [{ type: 'text', text: message }],
    clientTimeZone: Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC',
  }, exec?.signal ?? new AbortController().signal)
  return {
    ok: true,
    peer: peer.name,
    route: 'local',
    sessionId,
    mode: 'steer',
    accepted: true,
    deliveredVia: 'sessionController.prompt（mode=steer）',
    targetStatus: '',
    degraded,
    tokenSourceKind: 'local',
    tokenSource: '本机直连（无需 token）',
  }
}

// ── 固定链路（chains.json）──────────────────────────────────

/** 链路文件：config.chainsFile → <DSH_HOME>/peer-chat/chains.json。 */
function chainsFileOf(config) {
  const fromConfig = typeof config?.chainsFile === 'string' ? config.chainsFile.trim() : ''
  if (fromConfig !== '') return fromConfig
  const home = runtimePaths(config).home
  return home === '' ? 'chains.json' : join(home, 'peer-chat', 'chains.json')
}

function readChains(file) {
  let raw
  try { raw = readFileSync(file, 'utf8').replace(/^\uFEFF/, '') } catch { return {} }
  try {
    const parsed = JSON.parse(raw)
    return parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {}
  } catch {
    throw new Error(`链路文件 ${file} 不是合法 JSON`)
  }
}

function saveChains(file, table) {
  mkdirSync(dirname(file), { recursive: true })
  atomicWriteText(file, `${JSON.stringify(table, null, 2)}\n`)
}

/** 内置链路模板：peer 用 'self' 占位，装载时可整体替换。 */
const CHAIN_TEMPLATES = [
  {
    id: 'review-loop',
    description: '写 → 审 → 不过就返工',
    maxRetries: 2,
    steps: [
      { peer: 'self', message: '{input}' },
      { peer: 'self', mode: 'fmd-review' },
    ],
  },
  {
    id: 'relay',
    description: '本端起草 → 加工 → 收口',
    steps: [
      { peer: 'self', message: '{input}' },
      { peer: 'self', message: '基于上一步加工成更完整的版本：{prev}' },
      { peer: 'self', message: '收口成最终版：{prev}' },
    ],
  },
  {
    id: 'quick-ask',
    description: '单步问答',
    steps: [{ peer: 'self', message: '{input}' }],
  },
]

function installTemplate(config, options) {
  const templateId = typeof options?.template === 'string' ? options.template.trim() : ''
  const found = CHAIN_TEMPLATES.find((item) => item.id === templateId)
  if (found === undefined) {
    throw new Error(`未知模板「${templateId}」；可用：${CHAIN_TEMPLATES.map((item) => item.id).join(', ')}`)
  }
  const name = (typeof options?.name === 'string' && options.name.trim() !== '') ? options.name.trim() : found.id
  const peer = typeof options?.peer === 'string' && options.peer.trim() !== '' ? options.peer.trim() : ''
  const file = chainsFileOf(config)
  const table = readChains(file)
  if (table[name] !== undefined && options?.overwrite !== true) {
    throw new Error(`链路「${name}」已存在；要覆盖请 overwrite:true`)
  }
  const steps = found.steps.map((step) => ({ ...step, ...(peer === '' ? {} : { peer }) }))
  table[name] = validateChain(name, {
    description: found.description,
    ...(found.maxRetries === undefined ? {} : { maxRetries: found.maxRetries }),
    steps,
  })
  saveChains(file, table)
  return name
}

function validateChain(name, chain) {
  if (typeof name !== 'string' || name.trim() === '') throw new Error('链路要有名字')
  const steps = Array.isArray(chain?.steps) ? chain.steps : null
  if (steps === null || steps.length === 0) throw new Error(`链路 ${name} 至少要一步`)
  if (steps.length > 10) throw new Error(`链路 ${name} 最多 10 步`)
  for (const [index, step] of steps.entries()) {
    if (typeof step?.peer !== 'string' || step.peer.trim() === '') throw new Error(`链路 ${name} 第 ${index + 1} 步缺 peer`)
    // message 可省略：省略时按该步的 mode 自动生成
  }
  return {
    ...(typeof chain.description === 'string' ? { description: chain.description } : {}),
    ...(typeof chain.mode === 'string' && chain.mode.trim() !== '' ? { mode: chain.mode.trim() } : {}),
    ...(chain.stopOnError === false ? { stopOnError: false } : {}),
    ...(Number.isFinite(chain.maxRetries) ? { maxRetries: chain.maxRetries } : {}),
    steps: steps.map((step) => ({
      peer: step.peer.trim(),
      ...(typeof step.message === 'string' && step.message.trim() !== '' ? { message: step.message } : {}),
      ...(typeof step.mode === 'string' && step.mode.trim() !== '' ? { mode: step.mode.trim() } : {}),
      ...(typeof step.sessionId === 'string' && step.sessionId.trim() !== '' ? { sessionId: step.sessionId.trim() } : {}),
      ...(Number.isFinite(step.timeoutMs) ? { timeoutMs: step.timeoutMs } : {}),
      ...(step.onFail === 'skip' || step.onFail === 'stop' ? { onFail: step.onFail } : {}),
      ...(Number.isFinite(step.maxRetries) ? { maxRetries: step.maxRetries } : {}),
    })),
  }
}

/** 链路面板：每条链路 + 步数 + 用到的模式；附可用模式清单。 */
function renderChainsPanel(value) {
  const rows = value.chains ?? []
  const header = `固定链路 ${rows.length} 条（${value.file}）`
  if (rows.length === 0) {
    return [header, '', '还没有链路。用 peer_chains({ action: "add", name, chain: { steps: [...] } }) 加一条。'].join('\n')
  }
  const nameWidth = Math.max(4, ...rows.map((row) => displayWidth(row.name)))
  const lines = []
  for (const row of rows) {
    const badge = row.mode === '' ? '' : `  [默认 ${row.mode}]`
    lines.push(`${padDisplay(row.name, nameWidth)}  ${row.steps.length} 步${badge}${row.description === '' ? '' : `  — ${row.description}`}`)
    for (const step of row.steps) {
      const mode = step.mode === '' ? '默认' : step.mode
      const preview = step.message.length > 26 ? `${step.message.slice(0, 26)}…` : step.message
      lines.push(`   ${step.index}) ${padDisplay(step.peer, 10)} ${padDisplay(mode, 10)} ${preview}`)
    }
  }
  const modes = Array.isArray(value.modes) && value.modes.length > 0
    ? [`可用模式 ${value.modes.length} 个：${value.modes.join(', ')}`]
    : []
  return [header, '─'.repeat(52), ...lines, ...(modes.length > 0 ? ['', ...modes] : [])].join('\n')
}

// ── 端口段探测（不假设端口是 3090）──────────────────────────

/** 要探的端口：config.discoverPorts 数组，或 config.discoverPortRange "3000-3200"，默认 3000-3200。 */
function discoverPortsOf(config) {
  const configured = Array.isArray(config?.discoverPorts)
    ? config.discoverPorts.map((value) => Number(value)).filter((value) => Number.isInteger(value) && value > 0 && value < 65536)
    : []
  if (configured.length > 0) return [...new Set(configured)].slice(0, 512)
  const range = typeof config?.discoverPortRange === 'string' ? config.discoverPortRange.trim() : '3000-3200'
  const match = /^(\d{2,5})\s*-\s*(\d{2,5})$/.exec(range)
  if (match === null) return []
  const from = Math.min(Number(match[1]), Number(match[2]))
  const to = Math.max(Number(match[1]), Number(match[2]))
  const out = []
  for (let port = from; port <= to && out.length < 512; port += 1) out.push(port)
  return out
}

/** 并发探回环端口：DSH 的根路径没令牌会回 401，这是它的签名。 */
async function probeLoopbackPorts(config, signal) {
  const ports = discoverPortsOf(config)
  const found = []
  const batchSize = 64
  for (let index = 0; index < ports.length; index += batchSize) {
    if (signal?.aborted) break
    const batch = ports.slice(index, index + batchSize)
    const settled = await Promise.all(batch.map(async (port) => {
      try {
        const res = await fetch(`http://127.0.0.1:${port}/`, { redirect: 'manual', signal: AbortSignal.timeout(250) })
        return res.status === 401 ? { port, url: `http://127.0.0.1:${port}` } : null
      } catch {
        return null
      }
    }))
    for (const hit of settled) if (hit !== null) found.push(hit)
  }
  return found.sort((a, b) => a.port - b.port)
}

// ── 模式（agent preset）枚举与面板排版 ──────────────────────

/** 中文字符占两格，面板才对得齐。 */
function displayWidth(value) {
  let width = 0
  for (const char of String(value)) {
    const code = char.codePointAt(0) ?? 0
    width += (code >= 0x1100 && (code <= 0x115f || (code >= 0x2e80 && code <= 0xa4cf)
      || (code >= 0xac00 && code <= 0xd7a3) || (code >= 0xf900 && code <= 0xfaff)
      || (code >= 0xfe30 && code <= 0xfe6f) || (code >= 0xff00 && code <= 0xff60)
      || (code >= 0xffe0 && code <= 0xffe6))) ? 2 : 1
  }
  return width
}

function padDisplay(value, width) {
  const text = String(value)
  const pad = width - displayWidth(text)
  return pad > 0 ? text + ' '.repeat(pad) : text
}

function normalizeMode(row, defaultId) {
  const id = typeof row?.id === 'string' ? row.id : ''
  return {
    id,
    name: typeof row?.name === 'string' ? row.name : '',
    description: typeof row?.description === 'string' ? row.description : '',
    isDefault: row?.isDefault === true || (typeof defaultId === 'string' && defaultId !== '' && id === defaultId),
  }
}

function sortModes(rows) {
  return [...rows].sort((a, b) => {
    const orderA = Number.isFinite(a.order) ? a.order : 0
    const orderB = Number.isFinite(b.order) ? b.order : 0
    if (orderA !== orderB) return orderA - orderB
    return a.id.localeCompare(b.id)
  })
}

/** 面板：标题 + 分隔线 + 对齐表格（★ = 默认模式）。 */
function renderModePanel(value) {
  const rows = value.modes ?? []
  const header = `模式 ${value.count} 个（${value.source}）`
  if (rows.length === 0) return `${header}\n（没有可用的模式）`
  const idWidth = Math.max(4, ...rows.map((row) => displayWidth(row.id)))
  const nameWidth = Math.max(4, ...rows.map((row) => displayWidth(row.name)))
  const body = rows.map((row) => [
    row.isDefault ? '★' : ' ',
    padDisplay(row.id, idWidth),
    padDisplay(row.name, nameWidth),
    row.description.length > 28 ? `${row.description.slice(0, 28)}…` : row.description,
  ].join('  ').trimEnd())
  return [header, '─'.repeat(52), ...body].join('\n')
}

// ── 面板数据接口（给 client 半侧用）────────────────────────

function panelPeersPayload(config, extraRows) {
  const localHome = runtimePaths(config).home
  const rows = [{
    name: 'self',
    url: '',
    home: localHome,
    origin: 'self',
    tokenPrefix: '',
    sourceKind: 'local',
  }]
  let table = {}
  try { table = readPeers(peersFileOf(config)) } catch { table = {} }
  for (const [name, entry] of Object.entries(table)) {
    const home = typeof entry?.home === 'string' ? entry.home : ''
    const fromLog = tokenFromLogs(home)
    const cached = typeof entry?.token === 'string' ? entry.token : ''
    const token = fromLog !== null ? fromLog.token : cached
    rows.push({
      name,
      url: typeof entry?.url === 'string' ? entry.url : '',
      home,
      origin: 'peers.json',
      tokenPrefix: token.slice(0, 6),
      sourceKind: fromLog !== null ? 'log' : cached !== '' ? 'cache' : 'none',
    })
  }
  for (const item of discoverPeers(config)) {
    if (rows.some((row) => row.home === item.home)) continue
    rows.push({ name: item.name, url: item.url, home: item.home, origin: 'discovered', tokenPrefix: item.token.slice(0, 6), sourceKind: 'log' })
  }
  for (const row of extraRows ?? []) {
    if (!rows.some((item) => item.name === row.name)) rows.push(row)
  }
  return rows
}

function panelChainsPayload(config) {
  return Object.entries(readChains(chainsFileOf(config))).map(([name, chain]) => ({
    name,
    description: typeof chain?.description === 'string' ? chain.description : '',
    mode: typeof chain?.mode === 'string' ? chain.mode : '',
    steps: Array.isArray(chain?.steps) ? chain.steps.length : 0,
  }))
}

/** 读一个 JSON 请求体（面板的 POST 用），上限 1MB。 */
function readJsonBody(req, limit = 1 << 20) {
  return new Promise((resolve, reject) => {
    let size = 0
    const chunks = []
    req.on('data', (chunk) => {
      size += chunk.length
      if (size > limit) {
        reject(new Error('请求体过大'))
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => {
      try {
        const raw = Buffer.concat(chunks).toString('utf8')
        resolve(raw.trim() === '' ? {} : JSON.parse(raw))
      } catch (error) {
        reject(new Error(`请求体不是合法 JSON：${errorLine(error)}`))
      }
    })
    req.on('error', (error) => reject(error))
  })
}

// ── 模式识别：服务优先，其次读 profile 里的 preset 声明 ──────────

function presetSearchRoots(config) {
  const roots = []
  const push = (dir) => { if (typeof dir === 'string' && dir.trim() !== '') roots.push(dir.trim()) }
  const detected = runtimePaths(config)
  push(detected.profileDir)
  const home = detected.home
  if (home !== '') {
    push(home)
    try {
      for (const entry of readdirSync(join(home, 'profiles'), { withFileTypes: true })) {
        if (entry.isDirectory()) push(join(home, 'profiles', entry.name))
      }
    } catch { /* 没有 profiles 目录 */ }
  }
  push(process.cwd())
  return [...new Set(roots)]
}

/** 从 profile 的 patch 文件里抠 agent-preset 声明（id/name/order）。 */
function presetsFromProfileFiles(config) {
  const out = []
  const seen = new Set()
  for (const root of presetSearchRoots(config)) {
    for (const file of ['cordis.patch.yml', 'cordis.yml']) {
      let content = ''
      try { content = readFileSync(join(root, file), 'utf8') } catch { continue }
      const pattern = /name:\s*['"]?@deepseek-ai\/dsh-agent-preset['"]?([\s\S]{0,600}?)(?=\n\s*- id:|\n\s*- insert:|$)/g
      let hit
      while ((hit = pattern.exec(content)) !== null) {
        const body = hit[1]
        const idMatch = /\n\s+id:\s*([A-Za-z0-9._-]+)/.exec(body)
        if (idMatch === null) continue
        const id = idMatch[1]
        if (seen.has(id)) continue
        seen.add(id)
        const nameMatch = /\n\s+name:\s*['"]?([^'"\n]+)['"]?/.exec(body)
        const orderMatch = /\n\s+order:\s*(\d+)/.exec(body)
        out.push({
          id,
          name: nameMatch === null ? '' : nameMatch[1].trim(),
          description: '',
          isDefault: false,
          order: orderMatch === null ? 0 : Number(orderMatch[1]),
        })
      }
    }
  }
  return out
}

/** 三级来源：agentPresets 服务 → profile 声明 → 未识别。 */
async function detectModes(ctx, config) {
  const presets = ctx.get?.('agentPresets')
  if (presets !== undefined && typeof presets.list === 'function') {
    try {
      const defaultId = typeof presets.defaultId === 'string' ? presets.defaultId : undefined
      const modes = sortModes((await presets.list()).map((row) => normalizeMode(row, defaultId)))
      if (modes.length > 0) return { modes, source: 'agentPresets 服务' }
    } catch { /* 服务坏了继续往下 */ }
  }
  const fromFiles = sortModes(presetsFromProfileFiles(config).map((row) => normalizeMode(row, undefined)))
  if (fromFiles.length > 0) return { modes: fromFiles, source: 'profile 声明' }
  // 最后兜底：宿主内置 preset（桌面端 profile 里通常没有声明）
  const builtin = [
    { id: 'standard', name: '标准' },
    { id: 'ptc', name: 'PTC' },
    { id: 'minimal', name: '终端+读图' },
    { id: 'cordis', name: 'Creator' },
  ].map((row) => normalizeMode(row, 'standard'))
  return { modes: sortModes(builtin), source: '内置默认（profile 未声明）' }
}

/** 取某个目标（本机或对端）的模式清单：本机走 agentPresets，对端走 HTTP agentPresets/list。 */
async function fetchModeRows(ctx, config, peer, exec) {
  if (peer.local) {
    const detected = await detectModes(ctx, config)
    return { source: `本机 · ${detected.source}`, modes: detected.modes }
  }
  const session = await openSession(peer, peersFileOf(config), config)
  const value = await rpc(peer.url, session.cookie, 'agentPresets/list', {}, timeoutSignal(exec?.signal, 20_000))
  const rows = Array.isArray(value?.presets) ? value.presets : Array.isArray(value) ? value : []
  return { source: `对端 ${peer.name}`, modes: sortModes(rows.map((row) => normalizeMode(row, undefined))) }
}

/** 浏览器面板点开时取数据：GET /dsh-peer-chat-api。 */
function registerPanelRoute(ctx, config) {
  const register = (scoped) => {
    const webServer = scoped.get?.('webServer')
    if (webServer === undefined || typeof webServer.register !== 'function') return
    scoped.effect(() => webServer.register({
    kind: 'exact',
    path: '/dsh-peer-chat-api',
    async handler(req, res) {
      const send = (status, body) => {
        try {
          res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
        } catch { /* 头已发过 */ }
        res.end(JSON.stringify(body))
      }

      // 闸 1：只接受本机 Host
      const headers = req.headers ?? {}
      const hostHeader = String(headers.host ?? '')
      if (hostHeader !== '' && !/^(127\.0\.0\.1|localhost|\[::1\])(:\d+)?$/i.test(hostHeader)) {
        send(403, { ok: false, error: '只接受本机 Host' })
        return
      }
      // 闸 2：拒绝跨源
      const origin = String(headers.origin ?? '')
      if (origin !== '') {
        let sameOrigin = false
        try {
          const parsed = new URL(origin)
          sameOrigin = /^(127\.0\.0\.1|localhost|\[::1\])$/i.test(parsed.hostname)
        } catch { sameOrigin = false }
        if (!sameOrigin) {
          send(403, { ok: false, error: '拒绝跨源请求' })
          return
        }
      }
      // 闸 3：拒绝跨站上下文
      const site = String(headers['sec-fetch-site'] ?? '')
      if (site !== '' && site !== 'same-origin' && site !== 'none') {
        send(403, { ok: false, error: '拒绝跨站请求' })
        return
      }
      // 闸 4：POST 必须 JSON
      if (req.method === 'POST') {
        const contentType = String(headers['content-type'] ?? '').toLowerCase()
        if (!contentType.includes('application/json')) {
          send(415, { ok: false, error: '只接受 application/json' })
          return
        }
      }
      const snapshot = async () => {
        const detected = await detectModes(ctx, config)
        return {
        ok: true,
        peers: panelPeersPayload(config),
        modes: detected.modes,
        modesSource: detected.source,
        chains: panelChainsPayload(config),
        templates: CHAIN_TEMPLATES.map((item) => ({
          id: item.id,
          description: item.description,
          steps: item.steps.length,
        })),
        }
      }

      if (req.method === 'GET') {
        try {
          const url = new URL(req.url ?? '/', 'http://local')
          if ((url.searchParams.get('scan') ?? '') === '1') {
            // 本机端口：从请求的 Host 头取，用来把"自己"从扫描结果里剔掉
            const hostHeader0 = String(req.headers?.host ?? '')
            const selfPort = /:(\d+)$/.exec(hostHeader0)?.[1] ?? ''
            const deep = discoverPeers(config, { budgetMs: 3_000, force: true }).map((row) => ({
              name: row.name,
              url: row.url,
              home: row.home,
              origin: 'discovered',
              tokenPrefix: '',
              sourceKind: row.token === undefined ? 'none' : 'cache',
            }))
            let portHits = []
            try {
              const hits = await probeLoopbackPorts(config, undefined)
              portHits = hits
                .filter((hit) => String(hit.port) !== String(selfPort))   // 不显示自己这个端口
                .map((hit) => ({
                  name: `port-${hit.port}`,
                  url: hit.url,
                  home: '',
                  origin: 'port-scan',
                  tokenPrefix: '',
                  sourceKind: 'none',
                }))
            } catch { /* 端口探测失败不影响目录扫描结果 */ }
            const merged = [...deep, ...portHits]
            // 与默认快照同形状返回（含 modes / chains / templates），
            // 否则前端只拿到 peers，会把下面的模板区清空。
            const baseSnap = await snapshot()
            send(200, { ...baseSnap, peers: panelPeersPayload(config, merged), scanned: merged.length })
            return
          }
          const peerQuery = (url.searchParams.get('peer') ?? '').trim()
          if (peerQuery !== '') {
            const target = resolvePeerTarget({ peer: peerQuery }, config)
            const result = await fetchModeRows(ctx, config, target, undefined)
            send(200, { ok: true, peer: target.name, source: result.source, count: result.modes.length, modes: result.modes })
            return
          }
          send(200, await snapshot())
        } catch (error) {
          send(500, { ok: false, error: errorLine(error) })
        }
        return
      }

      if (req.method === 'POST') {
        try {
          const body = await readJsonBody(req)
          const action = typeof body?.action === 'string' ? body.action : ''
          const file = chainsFileOf(config)
          const table = readChains(file)
          if (action === 'save-chain') {
            const name = requireString(body, 'name', '保存链路')
            table[name] = validateChain(name, body.chain)
            saveChains(file, table)
          } else if (action === 'remove-chain') {
            const name = requireString(body, 'name', '删除链路')
            delete table[name]
            saveChains(file, table)
          } else if (action === 'install-template') {
            installTemplate(config, body)
          } else if (action === 'import') {
            const raw = typeof body.json === 'string' ? body.json : ''
            let parsed
            try {
              parsed = JSON.parse(raw)
            } catch (error) {
              send(400, { ok: false, error: `import 的 JSON 不合法：${errorLine(error)}` })
              return
            }
            if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
              send(400, { ok: false, error: 'import 的 JSON 必须是「名字 → 链路」对象' })
              return
            }
            const conflicts = []
            const merged = { ...table }
            for (const [name, chain] of Object.entries(parsed)) {
              if (merged[name] !== undefined && body.overwrite !== true) { conflicts.push(name); continue }
              merged[name] = validateChain(name, chain)
            }
            if (conflicts.length > 0) {
              send(400, { ok: false, error: `这些链路已存在，未覆盖：${conflicts.join(', ')}（要覆盖请 overwrite:true）` })
              return
            }
            saveChains(file, merged)
          } else if (action === 'export') {
            send(200, { ok: true, json: JSON.stringify(readChains(file), null, 2), count: Object.keys(readChains(file)).length })
            return
          } else if (action === 'send') {
            // 面板「发送消息」：选了目标就发，不建链路、不写脚本。
            // body: { peer?, sessionId?, message, mode?, preset? }
            //   - 有 sessionId → 发进该会话
            //   - 没有 sessionId → 按 preset 新建会话后立刻发第一条（等于"选模式 + 说一句"）
            const message = requireString(body, 'message', '发送消息')
            const peerName = typeof body.peer === 'string' && body.peer.trim() !== '' ? body.peer.trim() : 'self'
            const target = resolvePeerTarget({ peer: peerName }, config)
            const sessionId = typeof body.sessionId === 'string' && body.sessionId.trim() !== '' ? body.sessionId.trim() : undefined
            const preset = typeof body.preset === 'string' && body.preset.trim() !== '' ? body.preset.trim() : undefined
            try {
              if (sessionId !== undefined) {
                const out = await runSend(ctx, config, target, { sessionId, message, mode: body.mode }, {})
                send(200, { ok: true, ...out })
              } else {
                const out = await runAsk(ctx, config, target, { message, preset, mode: body.mode }, {})
                send(200, { ok: true, ...out })
              }
            } catch (error) {
              send(200, { ok: false, error: String((error && error.message) || error) })
            }
            return
          } else if (action === 'run-chain') {
            const name = requireString(body, 'name', '运行链路')
            const controller = new AbortController()
            const abort = () => controller.abort()
            res.on?.('close', abort)
            try {
              const result = await runChain(ctx, config, { name, input: typeof body.input === 'string' ? body.input : '' }, { signal: controller.signal })
              send(200, { ok: true, result })
            } finally {
              res.off?.('close', abort)
            }
            return
          } else {
            send(400, { ok: false, error: `未知 action：${action}` })
            return
          }
          send(200, { ...(await snapshot()), changed: action })
        } catch (error) {
          send(400, { ok: false, error: errorLine(error) })
        }
        return
      }

      send(405, { ok: false, error: '只支持 GET / POST' })
    },
  }))
  }

  if (typeof ctx.inject === 'function') {
    ctx.inject(['webServer'], (scoped) => register(scoped))
  } else {
    register(ctx)
  }
}

// ── 插件本体 ────────────────────────────────────────────────

export async function apply(ctx, config = {}) {
  // ── 内置会话工具与本插件的 peer_* 一起挂载 ──
  // 这样只需安装本插件一行，就同时拥有：
  //   session_create / session_send / session_wait / list_sessions（vendor/session-tools，含审批链）
  //   peer_token / peer_ask / peer_tail（本文件）
  if (config.mergeSessionTools !== false) {
    try {
      const mod = await import(new URL('./vendor/session-tools/index.js', import.meta.url).href)
      ctx.plugin(mod.default ?? mod, {})
    } catch (e) {
      try { ctx.logger?.warn?.('[peer-chat] mount vendor/session-tools failed: ' + (e && e.message)) } catch {}
    }
  }
  if (config.mergeSessionPlus !== false) {
    try {
      const mod = await import(new URL('./vendor/session-plus.js', import.meta.url).href)
      ctx.plugin(mod.default ?? mod, {})
    } catch (e) {
      try { ctx.logger?.warn?.('[peer-chat] mount vendor/session-plus failed: ' + (e && e.message)) } catch {}
    }
  }
  // 加载信标：插件真的被 apply 过就留一条记录
  try {
    const beaconHome = (typeof config?.localHome === 'string' && config.localHome.trim() !== '') ? config.localHome.trim() : (process.env.DSH_HOME ?? '')
    if (beaconHome !== '') {
      const beaconDir = join(beaconHome, 'peer-chat')
      mkdirSync(beaconDir, { recursive: true })
      appendFileSync(join(beaconDir, 'load.log'), `${new Date().toISOString()} loaded pid=${process.pid} v=${PACKAGE_VERSION}\n`)
    }
  } catch { /* 信标失败不影响加载 */ }
  // 加载信标：插件真的被 apply 过就留一条记录（排查"到底加载了没"）
  try {
    const home = (typeof config?.localHome === 'string' && config.localHome.trim() !== '') ? config.localHome.trim() : (process.env.DSH_HOME ?? '')
    if (home !== '') {
      const dir = join(home, 'peer-chat')
      mkdirSync(dir, { recursive: true })

    }
  } catch { /* 信标失败不影响加载 */ }
  // 会话日志是 zstd 帧；zlib 的 zstd 解压在 Node 22.15 才有。缺了就直接说清楚，
  // 别让用户在一堆"解不出日志"的现象里猜。
  if (typeof zstdDecompressSync !== 'function') {
    throw new Error(`dsh-peer-chat 需要 Node >= 22.15（zlib zstd 解压），当前 ${process.version}`)
  }
  ctx.tools.register({
    name: 'peer_token',
    description: '识别另一个 DSH 实例的 web token（不泄露全文）：按 PEER_TOKEN/config.token → <peerHome>/*.log 里的 dsh web 启动行 → peers.json 缓存 解析，返回前 6 位与来源。只读，不发网络请求。',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        peer: { type: 'string', description: '对端名字、端口或 self；省略即本端 self。' },
      },
      required: ['peer'],
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: true,
        properties: {
          peer: { type: 'string' },
          url: { type: 'string' },
          home: { type: 'string' },
          tokenPrefix: { type: 'string' },
          tokenLength: { type: 'number' },
          sourceKind: { type: 'string', enum: ['env', 'log', 'command', 'cache'] },
          source: { type: 'string' },
          candidates: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                tokenPrefix: { type: 'string' },
                source: { type: 'string' },
              },
              additionalProperties: true,
            },
          },
        },
        required: ['peer', 'tokenPrefix', 'tokenLength', 'sourceKind', 'source'],
      },
      render: (args, value) => [{
        type: 'text',
        text: `${value.peer} → ${value.tokenPrefix}…（${value.tokenLength} 字符）｜来源：${value.sourceKind}（${value.source}）`
          + (Array.isArray(value.candidates) && value.candidates.length > 1
            ? `\n候选 ${value.candidates.length} 个：${value.candidates.map((item) => `${item.tokenPrefix}… ← ${item.source}`).join('；')}`
            : ''),
      }],
    },
    async execute(args) {
      const peer = resolvePeerTarget(args, config)
      if (peer.local) {
        throw new Error(`peer「${peer.name}」是本机直连目标（self / local:true），不需要 token：本机会话请用 session_* 工具`)
      }
      const resolved = await resolveToken(peer, config)
      if (resolved === null) {
        throw new Error(`没有识别到 ${peer.name} 的 token：peers.json 无缓存、${join(peer.home || '<home>', 'web-console.log')} 里也没有启动行`)
      }
      return {
        peer: peer.name,
        url: peer.url,
        home: peer.home,
        tokenPrefix: resolved.token.slice(0, 6),
        tokenLength: resolved.token.length,
        sourceKind: resolved.kind,
        source: resolved.source,
        candidates: tokenCandidates(peer.home).map((item) => ({ tokenPrefix: item.token.slice(0, 6), source: item.source })),
      }
    },
  })

  ctx.tools.register({
    name: 'peer_ask',
    description: '给**另一个 DSH 实例**投递一条消息并取回回复：自动识别 token → 登录取 cookie → 对端建/续会话 → 投递 prompt → 轮询对端会话日志。本机（peer:"self"）走 session_create / session_send。local：复用 session-tools 的 session_create / session_send，拿不到时用 ctx.agents.create + sessionController.prompt。',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        peer: { type: 'string', description: '对端名字、端口或 self；**省略即本端 self**。' },
        message: { type: 'string', description: '投递给对端的消息正文（自包含：对端看不到本会话）。' },
        sessionId: { type: 'string', description: '续已有会话时给对端 sessionId；省略则新建会话。与 newSession:true 互斥。' },
        newSession: { type: 'boolean', description: '显式声明新建会话（默认行为即新建；与 sessionId 同时给会报错）。' },
        preset: { type: 'string', description: '新建会话时指定的默认模式（agent preset）id（remote 走对端 session/create）。' },
        cwd: { type: 'string', description: '新建会话时的工作目录：传给对端的 session/create。' },
        timeoutMs: { type: 'number', description: '等待回复的上限毫秒数，默认 120000，范围 5000–600000。' },
      },
      required: ['message'],
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: true,
        properties: {
          ok: { type: 'boolean' },
          peer: { type: 'string' },
          route: { type: 'string', enum: ['remote', 'local'] },
          sessionId: { type: 'string' },
          created: { type: 'boolean' },
          createVia: { type: 'string' },
          deliverVia: { type: 'string' },
          degraded: { type: 'array', items: { type: 'string' } },
          reply: { type: 'string' },
          timedOut: { type: 'boolean' },
          pendingQuestion: {
            type: 'object',
            additionalProperties: true,
            properties: {
              tool: { type: 'string' },
              question: { type: 'string' },
              options: { type: 'array', items: { type: 'string' } },
            },
          },
          waitedMs: { type: 'number' },
          turnsBefore: { type: 'number' },
          tokenSourceKind: { type: 'string' },
          tokenSource: { type: 'string' },
        },
        required: ['ok', 'peer', 'route', 'sessionId', 'created', 'reply', 'timedOut', 'waitedMs'],
      },
      render: (_args, value) => [{
        type: 'text',
        text: [
          `peer=${value.peer} route=${value.route} session=${value.sessionId}${value.created ? '（新建）' : ''}`
            + `｜建会话=${value.createVia ?? '?'}｜投递=${value.deliverVia ?? '?'}｜${Math.round(value.waitedMs / 1000)} 秒`,
          ...(Array.isArray(value.degraded) && value.degraded.length > 0 ? [`降级：${value.degraded.join('；')}`] : []),
          ...(value.pendingQuestion !== undefined
            ? [
              `⏸ 对方停在选择题上（${value.pendingQuestion.tool}）：${value.pendingQuestion.question}`,
              ...(value.pendingQuestion.options ?? []).map((label, index) =>
                /^[A-Za-z][.)、]\s*/.test(label) ? `  ${label}` : `  ${String.fromCharCode(65 + index)}. ${label}`),
              `回一个字母即可：peer_send({ peer: '${value.peer}', sessionId: '${value.sessionId}', message: 'A' })`,
            ]
            : []),
          value.timedOut
            ? `已投递，但没等到 turn 结束${value.reply === '' ? '' : `\n\n${truncate(value.reply, RENDER_LIMIT)}`}`
            : truncate(value.reply, RENDER_LIMIT),
        ].join('\n'),
      }],
    },
    timeoutMs: 660_000,
    async execute(args, exec) {
      const peer = resolvePeerTarget(args, config)
      const sessionIdArg = optionalString(args, 'sessionId')
      if (sessionIdArg !== undefined && args?.newSession === true) {
        throw new Error('sessionId 与 newSession:true 不能同时给：要么续已有会话，要么新建。')
      }
      return runAsk(ctx, config, peer, args, exec)
    },
  })

  ctx.tools.register({
    name: 'peer_chain',
    description: '链路版：按 steps 顺序把多个 DSH 实例/会话串起来，每一步的回复作为下一步的上下文。模式（mode）= 该步在对端用哪个 preset 建会话：优先级 steps[i].mode > 顶层 mode > 对端默认；无效模式报「未知模式」，不静默降级。步内消息写 {prev} 就原位替换上一步回复，没写就附在末尾。任何一步失败默认中断（stopOnError:false 可继续）。每步都走和 peer_ask 相同的分支（跨端 HTTP / 跨会话 session_*）。',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        name: { type: 'string', description: '跑哪条已保存的链路（替代 steps）；用 peer_chains 增删。' },
        input: { type: 'string', description: '替换消息里的 {input}（链路入口参数）。' },
        steps: {
          type: 'array',
          description: '按顺序执行的多跳步骤，每步 { peer, message, mode?, sessionId?, timeoutMs? }。',
          items: {
            type: 'object',
            properties: {
              peer: { type: 'string', description: '对端名、端口或 self；省略即本端 self。' },
              message: { type: 'string', description: '这一步的消息；可写 {prev} 引用上一步回复。' },
              sessionId: { type: 'string', description: '续哪个会话（可选，省略则新建并套用该步 mode 对应的 preset）。' },
              mode: { type: 'string', description: '这一步用哪个对端 preset 建会话（覆盖顶层 mode）。' },
              timeoutMs: { type: 'number', description: '这一步的等待上限（可选）。' },
            },
            required: ['message'],
            additionalProperties: true,
          },
        },
        mode: { type: 'string', description: '整条链默认用哪个对端 preset；每步可用 mode 覆盖，都不给则用对端默认。' },
        maxRetries: { type: 'number', description: '审阅不过时返工次数上限，默认 2（0 关闭返工）。' },
        failurePattern: { type: 'string', description: '判定返工的正则；默认不用正则，看回帖最后一行 NEXT / REWORK。' },
        templates: { type: 'object', additionalProperties: true, description: '按模式自定义消息模板，例如 { "fmd-review": "审核…{prev}" }。' },
        timeoutMs: { type: 'number', description: '每步默认等待上限，默认 120000。' },
        stopOnError: { type: 'boolean', description: '某步失败是否中断，默认 true。' },
      },
      required: [],
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: true,
        properties: {
          ok: { type: 'boolean' },
          stoppedAt: { type: 'number' },
          final: { type: 'string' },
          waitedMs: { type: 'number' },
          steps: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                index: { type: 'number' },
                peer: { type: 'string' },
                mode: { type: 'string' },
                status: { type: 'string' },
                bytes: { type: 'number' },
                sessionId: { type: 'string' },
                ok: { type: 'boolean' },
                error: { type: 'string' },
                reply: { type: 'string' },
                waitedMs: { type: 'number' },
              },
              additionalProperties: true,
            },
          },
        },
        required: ['ok', 'steps', 'final', 'waitedMs'],
      },
      render: (_args, value) => [{
        type: 'text',
        text: value.steps.map((step) => `[${step.index}] ${step.peer} → ${step.ok ? truncate(step.reply, 600) : '（失败）'}`).join('\n')
          + (value.ok ? `\n\n最终：${truncate(value.final, 1200)}` : `\n\n在第 ${value.stoppedAt} 步中断`),
      }],
    },
    timeoutMs: 900_000,
    async execute(args, exec) {
      return runChain(ctx, config, args, exec)
    },
  })

  ctx.tools.register({
    name: 'peer_send',
    description: '把一条消息**发送**进已存在的会话（本机或另一个 DSH 实例），投递完就返回，**不等回复**。消息哪来都行——你写的内容、上一步的产出、外部文本，整段作为 message 传入。要等回复用 peer_ask，要打断当前 turn 用 peer_steer，要读历史用 peer_tail。',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        peer: { type: 'string', description: '对端名字、端口或 self；**省略即本端 self**。' },
        sessionId: { type: 'string', description: '目标会话 id（必须已存在；peer_send 不建会话）。' },
        message: { type: 'string', description: '要发送的消息内容（自包含：目标看不到本会话）。' },
        mode: { type: 'string', enum: ['queue', 'steer'], description: 'queue=排队等这轮跑完再投（默认，等同"发消息"）；steer=插到下一步边界（等同 peer_steer）。' },
      },
      required: ['sessionId', 'message'],
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: true,
        properties: {
          ok: { type: 'boolean' },
          peer: { type: 'string' },
          route: { type: 'string', enum: ['remote', 'local'] },
          sessionId: { type: 'string' },
          mode: { type: 'string' },
          deliverVia: { type: 'string' },
          degraded: { type: 'array', items: { type: 'string' } },
          tokenSourceKind: { type: 'string' },
          tokenSource: { type: 'string' },
        },
        required: ['ok', 'peer', 'route', 'sessionId'],
      },
      render: (_args, value) => [{
        type: 'text',
        text: [
          `已发送：peer=${value.peer} route=${value.route} session=${value.sessionId}｜${value.deliverVia ?? ''}`,
          ...(Array.isArray(value.degraded) && value.degraded.length > 0 ? [`降级：${value.degraded.join('；')}`] : []),
          '（不等回复；要看回复用 peer_tail 或 peer_ask）',
        ].join('\n'),
      }],
    },
    timeoutMs: 30_000,
    async execute(args, exec) {
      const peer = resolvePeerTarget(args, config)
      return runSend(ctx, config, peer, args, exec)
    },
  })

  ctx.tools.register({
    name: 'peer_steer',
    description: '向**另一个 DSH 实例**里已存在的会话插话：投递到当前 turn 的下一步边界，不新开 turn；目标空闲时会唤醒它开一个 turn。回执语义——只报「投递成功 + 用的是哪种模式」，不等回复（要看回复用 peer_ask 或 peer_tail）。本机优先复用 session_steer。',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        peer: { type: 'string', description: '对端名字、端口或 self；**省略即本端 self**。' },
        message: { type: 'string', description: '插话正文（自包含：目标看不到本会话）。' },
        sessionId: { type: 'string', description: '要插话的目标会话 id（必须已存在；插话不建会话）。' },
      },
      required: ['message', 'sessionId'],
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: true,
        properties: {
          ok: { type: 'boolean' },
          peer: { type: 'string' },
          route: { type: 'string', enum: ['remote', 'local'] },
          sessionId: { type: 'string' },
          mode: { type: 'string', enum: ['steer', 'queue'] },
          accepted: { type: 'boolean' },
          deliveredVia: { type: 'string' },
          targetStatus: { type: 'string' },
          degraded: { type: 'array', items: { type: 'string' } },
          tokenSourceKind: { type: 'string' },
          tokenSource: { type: 'string' },
        },
        required: ['ok', 'peer', 'route', 'sessionId', 'mode', 'accepted'],
      },
      render: (_args, value) => [{
        type: 'text',
        text: [
          `peer=${value.peer} route=${value.route} session=${value.sessionId}｜${value.mode === 'steer' ? '插话（next-step）' : '已排队（目标空闲）'}｜${value.deliveredVia ?? '?'}`,
          ...(value.targetStatus ? [`目标状态：${value.targetStatus}`] : []),
          ...(Array.isArray(value.degraded) && value.degraded.length > 0 ? [`降级：${value.degraded.join('；')}`] : []),
        ].join('\n'),
      }],
    },
    timeoutMs: 60_000,
    async execute(args, exec) {
      const peer = resolvePeerTarget(args, config)
      if (args?.newSession === true) {
        throw new Error('peer_steer 只对已存在的会话插话；要新会话请用 peer_ask')
      }
      return runSteer(ctx, config, peer, args, exec)
    },
  })

  ctx.tools.register({
    name: 'peer_list',
    description: '列出可用的对端：peers.json 里配置的 + 本机按名字自动发现到的 DSH 实例（扫 home 目录/启动日志，取 url 与 token）；scan:true 时才额外扫端口段。只报名字、url、home、令牌前 6 位与来源，不联网。自动发现会扫 DSH_HOME 同级、用户目录与各盘根，有限深度 + 4 秒预算，结果缓存 30 秒。',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        discover: { type: 'boolean', description: '是否包含目录发现结果，默认 true。' },
        scan: { type: 'boolean', description: '是否额外扫描回环端口段（认 401 签名的 DSH）；默认 false，只按名字自动发现。' },
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: true,
        properties: {
          peers: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                name: { type: 'string' },
                url: { type: 'string' },
                home: { type: 'string' },
                origin: { type: 'string', enum: ['self', 'peers.json', 'discovered', 'port-scan'] },
                tokenPrefix: { type: 'string' },
                sourceKind: { type: 'string' },
              },
              additionalProperties: true,
            },
          },
          roots: { type: 'array', items: { type: 'string' } },
        },
        required: ['peers'],
      },
      render: (_args, value) => [{
        type: 'text',
        text: value.peers.length === 0
          ? '没有可用的对端：peers.json 为空，也没发现带启动日志的 DSH home'
          : value.peers.map((row) => `${row.name}  ${row.url || '本端（跨会话）'}  [${row.origin}]  ${row.sourceKind === 'local' ? '无需令牌' : row.sourceKind === 'none' ? '无令牌' : `${row.tokenPrefix}…`}`).join('\n'),
      }],
    },
    async execute(args) {
      const localHome = runtimePaths(config).home
      const rows = [{
        name: 'self',
        url: '',
        home: localHome,
        origin: 'self',
        tokenPrefix: '',
        sourceKind: 'local',
      }]
      let table = {}
      try { table = readPeers(peersFileOf(config)) } catch { table = {} }
      for (const [name, entry] of Object.entries(table)) {
        const home = typeof entry?.home === 'string' ? entry.home : ''
        const fromLog = tokenFromLogs(home)
        const cached = typeof entry?.token === 'string' ? entry.token : ''
        const token = fromLog !== null ? fromLog.token : cached
        rows.push({
          name,
          url: typeof entry?.url === 'string' ? entry.url : '',
          home,
          origin: 'peers.json',
          tokenPrefix: token.slice(0, 6),
          sourceKind: fromLog !== null ? 'log' : cached !== '' ? 'cache' : 'none',
        })
      }
      if (args?.discover !== false) {
        for (const item of discoverPeers(config)) {
          if (rows.some((row) => row.home === item.home)) continue
          rows.push({ name: item.name, url: item.url, home: item.home, origin: 'discovered', tokenPrefix: item.token.slice(0, 6), sourceKind: 'log' })
        }
      }
      if (args?.scan === true) {
        for (const hit of await probeLoopbackPorts(config)) {
          if (rows.some((row) => portOfUrl(row.url) === String(hit.port))) continue
          rows.push({ name: `port-${hit.port}`, url: hit.url, home: '', origin: 'port-scan', tokenPrefix: '', sourceKind: 'none' })
        }
      }
      return { peers: rows, roots: discoverRoots(config) }
    },
  })

  ctx.tools.register({
    name: 'peer_modes',
    description: '自检可用模式（agent preset）并面板排版：默认读本机 agentPresets 服务，报出有多少个模式、哪个是默认；给 peer 时尝试从对端 HTTP 的 agentPresets/list 读取（对端不一定暴露这个端点，失败会明确说明）。',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        peer: { type: 'string', description: '对端名（可选）；省略则读本机的模式清单。' },
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: true,
        properties: {
          source: { type: 'string' },
          count: { type: 'number' },
          modes: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                id: { type: 'string' },
                name: { type: 'string' },
                description: { type: 'string' },
                isDefault: { type: 'boolean' },
              },
              additionalProperties: true,
            },
          },
        },
        required: ['source', 'count', 'modes'],
      },
      render: (_args, value) => [{ type: 'text', text: renderModePanel(value) }],
    },
    async execute(args, exec) {
      const peer = resolvePeerTarget(args, config)
      let result
      try {
        result = await fetchModeRows(ctx, config, peer, exec)
      } catch (error) {
        throw new Error(`对端 ${peer.name} 没有暴露模式清单（agentPresets/list）：${errorLine(error)}`)
      }
      return { source: result.source, count: result.modes.length, modes: result.modes }
    },
  })

  ctx.tools.register({
    name: 'peer_chains',
    description: '固定链路面板：列出/新增/删除保存好的链路（存 <DSH_HOME>/peer-chat/chains.json），并附带本机可用模式清单。链路本身用 peer_chain({ name }) 跑，消息里的 {input} 与 {prev} 会被替换。',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        action: { type: 'string', description: 'list（默认）/ add / remove / install-template / export / import', enum: ['list', 'add', 'remove', 'install-template', 'export', 'import'] },
        template: { type: 'string', description: 'install-template 用：review-loop / relay / quick-ask。' },
        peer: { type: 'string', description: 'install-template 用：把模板里的 self 占位替换成这个对端（可选）。' },
        overwrite: { type: 'boolean', description: 'add / install-template / import 时是否允许覆盖同名。' },
        json: { type: 'string', description: 'import 用的链路 JSON（export 的原样输出）。' },
        name: { type: 'string', description: 'add / remove 时的链路名。' },
        chain: {
          type: 'object',
          description: 'add 时的链路定义：{ description?, mode?, stopOnError?, steps: [{ peer, message, mode?, sessionId? }] }',
          additionalProperties: true,
          properties: {},
        },
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: true,
        properties: {
          file: { type: 'string' },
          count: { type: 'number' },
          changed: { type: 'string' },
          modes: { type: 'array', items: { type: 'string' } },
          chains: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                name: { type: 'string' },
                description: { type: 'string' },
                mode: { type: 'string' },
                steps: {
                  type: 'array',
                  items: {
                    type: 'object',
                    properties: {
                      index: { type: 'number' },
                      peer: { type: 'string' },
                      mode: { type: 'string' },
                      message: { type: 'string' },
                    },
                    additionalProperties: true,
                  },
                },
              },
              additionalProperties: true,
            },
          },
        },
        required: ['file', 'count', 'chains'],
      },
      render: (_args, value) => [{ type: 'text', text: renderChainsPanel(value) }],
    },
    async execute(args) {
      const action = optionalString(args, 'action') ?? 'list'
      const file = chainsFileOf(config)
      const table = readChains(file)
      let changed = ''

      if (action === 'install-template') {
        const templateName = requireString(args, 'template', 'peer_chains(install-template)')
        const installed = installTemplate(config, {
          template: templateName,
          name: optionalString(args, 'name'),
          peer: optionalString(args, 'peer'),
          overwrite: args?.overwrite === true,
        })
        changed = `已装载模板 ${templateName} → ${installed}`
      } else if (action === 'export') {
        changed = '已导出'
      } else if (action === 'import') {
        const raw = requireString(args, 'json', 'peer_chains(import)')
        let parsed
        try {
          parsed = JSON.parse(raw)
        } catch (error) {
          throw new Error(`import 的 JSON 不合法：${errorLine(error)}`)
        }
        if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('import 的 JSON 必须是「名字 → 链路」对象')
        const conflicts = []
        const next = { ...table }
        for (const [name, chain] of Object.entries(parsed)) {
          if (next[name] !== undefined && args?.overwrite !== true) { conflicts.push(name); continue }
          next[name] = validateChain(name, chain)
        }
        if (conflicts.length > 0) throw new Error(`这些链路已存在，未覆盖：${conflicts.join(', ')}（要覆盖请 overwrite:true）`)
        saveChains(file, next)
        Object.assign(table, next)
        changed = `已导入 ${Object.keys(parsed).length} 条`
      } else if (action === 'add') {
        const name = requireString(args, 'name', 'peer_chains(add)')
        if (table[name] !== undefined && args?.overwrite !== true) {
          throw new Error(`链路「${name}」已存在；要覆盖请 overwrite:true`)
        }
        table[name] = validateChain(name, args?.chain)
        saveChains(file, table)
        changed = `已保存链路 ${name}`
      } else if (action === 'remove') {
        const name = requireString(args, 'name', 'peer_chains(remove)')
        if (table[name] === undefined) throw new Error(`没有链路「${name}」；已有：${Object.keys(table).join(', ') || '（空）'}`)
        delete table[name]
        saveChains(file, table)
        changed = `已删除链路 ${name}`
      } else if (action !== 'list') {
        throw new Error(`peer_chains 的 action 只能是 list / add / remove，收到 ${action}`)
      }

      const chains = Object.entries(table).map(([name, chain]) => ({
        name,
        description: typeof chain?.description === 'string' ? chain.description : '',
        mode: typeof chain?.mode === 'string' ? chain.mode : '',
        steps: Array.isArray(chain?.steps)
          ? chain.steps.map((step, index) => ({
            index: index + 1,
            peer: String(step?.peer ?? ''),
            mode: typeof step?.mode === 'string' ? step.mode : '',
            message: String(step?.message ?? ''),
          }))
          : [],
      }))

      const detectedForList = await detectModes(ctx, config)
      const modes = detectedForList.modes.map((row) => String(row.id ?? '')).filter((id) => id !== '')

      return {
        file,
        count: chains.length,
        changed,
        chains,
        modes,
        modesSource: detectedForList.source,
        ...(action === 'export' ? { json: JSON.stringify(table, null, 2) } : {}),
        templates: CHAIN_TEMPLATES.map((item) => ({ id: item.id, description: item.description, steps: item.steps.length })),
      }
    },
  })

  ctx.tools.register({
    name: 'peer_tail',
    description: '取某个会话最近 n 条 assistant 消息正文（只读：直接解 <home>/sessions/<workspace>/<sessionId>/session.v4.jsonl.zstd，不联网）。remote 读对端 home，local（self）读本机 DSH_HOME。',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        peer: { type: 'string', description: '对端名字、端口或 self；**省略即本端 self**。' },
        sessionId: { type: 'string', description: '对端的会话 id。' },
        n: { type: 'number', description: '取最近几条 assistant 消息，默认 3，范围 1–20。' },
      },
      required: ['sessionId'],
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: true,
        properties: {
          peer: { type: 'string' },
          sessionId: { type: 'string' },
          logFile: { type: 'string' },
          totalAssistant: { type: 'number' },
          messages: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                turn: { type: 'number' },
                text: { type: 'string' },
              },
              additionalProperties: true,
            },
          },
        },
        required: ['peer', 'sessionId', 'logFile', 'totalAssistant', 'messages'],
      },
      render: (_args, value) => [{
        type: 'text',
        text: value.messages.length === 0
          ? `${value.peer}/${value.sessionId}：日志里还没有 assistant 消息（共 0 条）`
          : value.messages.map((item) => `--- turn ${item.turn}\n${truncate(item.text, TAIL_LIMIT)}`).join('\n'),
      }],
    },
    async execute(args) {
      const peer = resolvePeerTarget(args, config)
      const sessionId = requireString(args, 'sessionId', 'peer_tail')
      const n = optionalNumber(args, 'n', 1, 20) ?? 3
      const file = findSessionLog(peer.home, sessionId)
      if (file === null) {
        throw new Error(`找不到会话日志：${join(peer.home || '<home>', 'sessions', '<workspace>', sessionId, SESSION_FILE)}`)
      }
      const summary = summarize(decodeEvents(file))
      const messages = summary.assistants.filter((item) => item.text !== '').slice(-n)
        .map((item) => ({ turn: item.turn, text: item.text }))
      return {
        peer: peer.name,
        sessionId,
        logFile: file,
        totalAssistant: summary.assistants.length,
        messages,
      }
    },
  })

  registerPanelRoute(ctx, config)
}
