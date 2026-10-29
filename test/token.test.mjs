/**
 * token.test.mjs —— peer_token 的识别链与「不泄露全文」契约。
 *
 * 覆盖（对应 index.js）：
 *   resolveToken / tokenCandidates / tokenFromLogs / tokenFromCommand / overrideTokenOf /
 *   normalizePeerEntry（tailOnly）/ readPeers 的报错面。
 *
 * 设计要点：token 的优先级是 显式(env/config) → 日志（最新优先，多候选择一） → tokenCommand → peers.json 缓存。
 * 这里用不同的临时 home 分别构造「只有缓存」「只有日志」「两个日志一新一死」「401 后重扫」等场景。
 */
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  ageFile,
  applyPlugin,
  emptyCapture,
  readJson,
  runSuite,
  startFakePeer,
  writeBootLog,
  writeJson,
} from './fixture.mjs'

await runSuite('token', async ({ check, expectThrow, tempRoot }) => {
  // 钉死自动发现范围：只扫本轮临时目录，绝不扫用户 home / 盘符。
  const baseConfig = (peersFile, extra = {}) => ({
    peersFile,
    discoverRoots: [tempRoot],
    discoverBudgetMs: 200,
    ...extra,
  })

  // ── 1) 日志里没有 token 时回落到 peers.json 缓存 ──────────────
  {
    const dir = join(tempRoot, 'cache-fallback')
    const home = join(dir, 'home')
    const peersFile = join(dir, 'peers.json')
    const token = 'CACHE-TOKEN-11112222333344445555'
    mkdirSync(home, { recursive: true })
    writeJson(peersFile, { far: { url: 'http://127.0.0.1:1', home, token } })

    const { run, tool } = await applyPlugin({ config: baseConfig(peersFile) })
    const value = await run('peer_token', { peer: 'far' })
    check('缓存回落：kind=cache 且只报前缀', value.sourceKind === 'cache' && value.tokenPrefix === token.slice(0, 6) && value.tokenLength === token.length,
      `${value.tokenPrefix}… kind=${value.sourceKind}`)
    check('缓存回落：不泄露全文', JSON.stringify(value).includes(token) === false, 'value 里没有完整 token')
    const rendered = tool('peer_token').output.render({}, value)[0].text
    check('缓存回落：面板一行含前缀与来源', rendered.includes(token.slice(0, 6)) && rendered.includes('cache'), rendered.split('\n')[0])
  }

  // ── 2) 日志优先于缓存 ───────────────────────────────────────
  {
    const dir = join(tempRoot, 'log-priority')
    const home = join(dir, 'home')
    const peersFile = join(dir, 'peers.json')
    const logToken = 'LOG-TOKEN-22223333444455556666'
    const cacheToken = 'CACHE-TOKEN-99998888777766665555'
    writeBootLog(home, 'http://127.0.0.1:59999', logToken)
    writeJson(peersFile, { far: { url: 'http://127.0.0.1:59999', home, token: cacheToken } })

    const { run } = await applyPlugin({ config: baseConfig(peersFile) })
    const value = await run('peer_token', { peer: 'far' })
    check('日志优先于缓存', value.sourceKind === 'log' && value.tokenPrefix === logToken.slice(0, 6) && value.source.endsWith('web-console.log'),
      `${value.tokenPrefix} kind=${value.sourceKind} ${value.source}`)
    check('日志优先：候选只列日志那一个', value.candidates.length === 1, JSON.stringify(value.candidates.map((row) => row.tokenPrefix)))
  }

  // ── 3) 多日志：最新日志是死 token，候选里两个都能看到 ─────────
  {
    const dir = join(tempRoot, 'multi-log')
    const home = join(dir, 'home')
    const peersFile = join(dir, 'peers.json')
    const stale = 'STALE-TOKEN-aaaa1111bbbb2222cccc33'
    const valid = 'VALID-TOKEN-dddd4444eeee5555ffff66'
    const validLog = writeBootLog(home, 'http://127.0.0.1:59999', valid, 'web-console.log')
    const staleLog = writeBootLog(home, 'http://127.0.0.1:59999', stale, 'zzz-stale.log')
    ageFile(validLog, 60_000) // 老日志才是活 token
    writeJson(peersFile, { far: { url: 'http://127.0.0.1:59999', home, token: stale } })

    const { run } = await applyPlugin({ config: baseConfig(peersFile) })
    const value = await run('peer_token', { peer: 'far' })
    check('多日志：首选最新日志的 token', value.sourceKind === 'log' && value.tokenPrefix === stale.slice(0, 6), `${value.tokenPrefix}…`)
    check('多日志：候选列出两个', value.candidates.length === 2 && value.candidates[0].tokenPrefix === stale.slice(0, 6),
      JSON.stringify(value.candidates.map((row) => row.tokenPrefix)))
    check('多日志：候选也不泄露全文', JSON.stringify(value).includes(stale) === false && JSON.stringify(value).includes(valid) === false,
      'ok')
    check('多日志：最新日志确实更新（前置检查）', staleLog !== validLog, '两个文件已分离')
  }

  // ── 4) 401 → 重扫日志换到活 token → 写回缓存 ────────────────
  {
    const dir = join(tempRoot, 'rescan')
    const home = join(dir, 'home')
    const peersFile = join(dir, 'peers.json')
    const stale = 'STALE-TOKEN-00001111222233334444'
    const valid = 'VALID-TOKEN-55556666777788889999'
    const capture = emptyCapture()
    const peer = await startFakePeer({ name: 'far', token: valid, home, capture })
    const validLog = writeBootLog(home, peer.url, valid, 'web-console.log')
    writeBootLog(home, peer.url, stale, 'zzz-stale.log')
    ageFile(validLog, 60_000)
    writeJson(peersFile, { far: { url: peer.url, home, token: stale } })

    const { run } = await applyPlugin({ config: baseConfig(peersFile) })
    const asked = await run('peer_ask', { peer: 'far', message: 'ping', newSession: true, timeoutMs: 5_000 })
    check('401 重扫：拿到回复', asked.reply === '回:ping' && asked.ok === true, JSON.stringify({ reply: asked.reply }))
    check('401 重扫：两个 token 都试过（先死后台）', capture.logins.length === 2 && capture.logins[0] === stale && capture.logins[1] === valid,
      capture.logins.map((item) => item.slice(0, 6)).join(' → '))
    check('401 重扫：回执标 token 来源为日志', asked.tokenSourceKind === 'log' && asked.tokenSource.endsWith('web-console.log'), String(asked.tokenSource))
    const cached = readJson(peersFile).far
    check('401 重扫：活 token 写回 peers.json', cached.token === valid && typeof cached.tokenAt === 'string',
      `${String(cached.token).slice(0, 6)}… tokenAt=${cached.tokenAt}`)
  }

  // ── 5) config.token 显式指定：最高优先级，且不做 401 重扫 ─────
  {
    const dir = join(tempRoot, 'explicit-token')
    const home = join(dir, 'home')
    const peersFile = join(dir, 'peers.json')
    const explicit = 'EXPLICIT-TOKEN-abcdefabcdefabcdef00'
    const capture = emptyCapture()
    const peer = await startFakePeer({ name: 'far', token: explicit, home, capture })
    mkdirSync(home, { recursive: true })
    writeJson(peersFile, { far: { url: peer.url, home, token: 'CACHE-TOKEN-' + '0'.repeat(20) } })

    const { run } = await applyPlugin({ config: baseConfig(peersFile, { token: explicit }) })
    const value = await run('peer_token', { peer: 'far' })
    check('显式 token：kind=env 且来源写明 config.token', value.sourceKind === 'env' && value.source.includes('config.token'), String(value.source))
    const asked = await run('peer_ask', { peer: 'far', message: 'hello', newSession: true, timeoutMs: 5_000 })
    check('显式 token：只用它登录（不重扫）', capture.logins.length === 1 && capture.logins[0] === explicit, `logins=${capture.logins.length}`)
    check('显式 token：对话跑通', asked.reply === '回:hello' && asked.tokenSourceKind === 'env', JSON.stringify({ reply: asked.reply }))
  }

  // ── 6) PEER_TOKEN 环境变量 ──────────────────────────────────
  {
    const dir = join(tempRoot, 'env-token')
    const home = join(dir, 'home')
    const peersFile = join(dir, 'peers.json')
    const envToken = 'ENV-TOKEN-12341234123412341234'
    mkdirSync(home, { recursive: true })
    writeJson(peersFile, { far: { url: 'http://127.0.0.1:1', home, token: 'CACHE-TOKEN-' + '1'.repeat(20) } })

    const { run } = await applyPlugin({ config: baseConfig(peersFile) })
    process.env.PEER_TOKEN = envToken
    try {
      const value = await run('peer_token', { peer: 'far' })
      check('PEER_TOKEN：kind=env 且来源 PEER_TOKEN', value.sourceKind === 'env' && value.source === 'PEER_TOKEN' && value.tokenPrefix === envToken.slice(0, 6),
        String(value.source))
    } finally {
      delete process.env.PEER_TOKEN
    }
  }

  // ── 7) tokenCommand：日志和缓存都没有时，用命令去捞 ────────────
  {
    const dir = join(tempRoot, 'token-command')
    const home = join(dir, 'home')
    const peersFile = join(dir, 'peers.json')
    const script = join(dir, 'emit-token.mjs')
    const commandToken = 'CMD-TOKEN-aaaaaaaaaaaabbbbbbbb'
    mkdirSync(home, { recursive: true })
    writeFileSync(script, `process.stdout.write('token=${commandToken}')\n`)
    writeJson(peersFile, { far: { url: 'http://127.0.0.1:1', home } })

    const { run } = await applyPlugin({
      config: baseConfig(peersFile, { tokenCommand: `"${process.execPath}" "${script}"` }),
    })
    const value = await run('peer_token', { peer: 'far' })
    check('tokenCommand：kind=command 且取到 stdout 里的 token',
      value.sourceKind === 'command' && value.tokenPrefix === commandToken.slice(0, 6) && value.source.includes('tokenCommand'),
      `${value.tokenPrefix} kind=${value.sourceKind}`)
  }

  // ── 8) 一处都找不到 → 明确报错 ──────────────────────────────
  {
    const dir = join(tempRoot, 'no-token')
    const home = join(dir, 'home')
    const peersFile = join(dir, 'peers.json')
    mkdirSync(home, { recursive: true })
    writeJson(peersFile, { far: { url: 'http://127.0.0.1:1', home } })

    const { run } = await applyPlugin({ config: baseConfig(peersFile) })
    await expectThrow('找不到 token 时报错可读', () => run('peer_token', { peer: 'far' }), '没有识别到')
  }

  // ── 9) self 与 local:true 不需要 token ──────────────────────
  {
    const dir = join(tempRoot, 'self-token')
    const localHome = join(dir, 'dsh-home')
    const peersFile = join(dir, 'peers.json')
    mkdirSync(localHome, { recursive: true })
    writeJson(peersFile, { box: { local: true, home: localHome } })

    const { run } = await applyPlugin({ config: baseConfig(peersFile, { localHome }) })
    await expectThrow('self 不需要 token', () => run('peer_token', { peer: 'self' }), '不需要 token')
    await expectThrow('local:true 的 peer 也不需要 token', () => run('peer_token', { peer: 'box' }), '不需要 token')
  }

  // ── 10) 只有 home 没有 url（桌面端）也能认 token ──────────────
  {
    const dir = join(tempRoot, 'tail-only')
    const home = join(dir, 'home')
    const peersFile = join(dir, 'peers.json')
    const token = 'DESKTOP-TOKEN-77778888999900001111'
    writeBootLog(home, 'http://127.0.0.1:6100', token)
    writeJson(peersFile, { desk: { home } })

    const { run } = await applyPlugin({ config: baseConfig(peersFile) })
    const value = await run('peer_token', { peer: 'desk' })
    check('只有 home 的对端：url 为空但能认 token', value.url === '' && value.sourceKind === 'log' && value.tokenPrefix === token.slice(0, 6),
      JSON.stringify({ url: value.url, kind: value.sourceKind }))
  }

  // ── 11) 错误面：未知 peer / peers 表缺失 ────────────────────
  {
    const dir = join(tempRoot, 'errors')
    const peersFile = join(dir, 'peers.json')
    writeJson(peersFile, {})

    const { run } = await applyPlugin({ config: baseConfig(peersFile) })
    let unknownMessage = ''
    try { await run('peer_token', { peer: 'nope' }) } catch (error) { unknownMessage = String(error.message) }
    check('未知 peer：提示可用名字与端口', unknownMessage.includes('未知 peer') && unknownMessage.includes('也可以直接给端口'),
      unknownMessage.slice(0, 120))

    const missing = join(dir, 'no-such-peers.json')
    const missingCtx = await applyPlugin({ config: baseConfig(missing) })
    await expectThrow('peers 表缺失：报错带路径', () => missingCtx.run('peer_token', { peer: 'far' }), '读不到 peers 表')
  }
})
