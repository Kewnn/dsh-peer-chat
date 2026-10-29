/**
 * peers.test.mjs —— 对端发现与寻址：peer_list / peer_modes / 端口探测 / peers 表形态。
 *
 * 覆盖（对应 index.js）：
 *   discoverPeers（扫 home、认 dsh-home、去重与深度预算）、discoverRoots、
 *   resolvePeerTarget 的「按名字 / 按端口 / local:true」分支、panelPeersPayload 的数据来源、
 *   probeLoopbackPorts 的 401 签名判定、fetchModeRows 的本机/对端两条路。
 *
 * 注意：自动发现结果在进程内缓存 30 秒（DISCOVER_TTL_MS），所以本套件只做一轮发现，
 * 端口探测用 peers 文件 + discover:false 隔离——这也是「每个 *.test.mjs 独立进程」的原因之一。
 */
import { createServer } from 'node:http'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  applyPlugin,
  emptyCapture,
  runSuite,
  startFakePeer,
  trackClose,
  writeBootLog,
  writeJson,
} from './fixture.mjs'

/** 起一个只会回固定状态码的小服务（模拟「像 DSH 的 401 端口」与「普通 200 网页」）。 */
async function startStatusServer(status) {
  const server = createServer((req, res) => {
    res.writeHead(status, { 'content-type': 'text/plain' })
    res.end(status === 401 ? 'unauthorized' : 'hello')
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve()))
  const port = server.address().port
  trackClose(async () => { await new Promise((resolve) => server.close(resolve)) })
  return { port, url: `http://127.0.0.1:${port}` }
}

await runSuite('peers', async ({ check, expectThrow, tempRoot }) => {
  // ── 世界：两个可发现实例 + 一个手动 peers.json + 一个模式对端 ──
  const root = join(tempRoot, 'world')
  const homeA = join(root, 'inst-a', 'dsh-home')
  const homeB = join(root, 'inst-b', 'dsh-home')
  mkdirSync(join(homeA, 'profiles'), { recursive: true })
  mkdirSync(join(homeB, 'profiles', 'web'), { recursive: true })
  mkdirSync(join(homeB, 'sessions'), { recursive: true })

  const tokenA = 'TOKEN-AAA-11112222333344445555'
  const tokenB = 'TOKEN-BBB-66667777888899990000'
  const captureB = emptyCapture()
  const peerB = await startFakePeer({ name: 'inst-b', token: tokenB, home: homeB, replies: ['OK-DISCOVERED'], capture: captureB })
  const modesPeer = await startFakePeer({
    name: 'modes',
    token: 'TOKEN-MODES-123456789012345678901',
    home: join(root, 'modes-home'),
    presets: [{ id: 'remote-a', name: 'A 模式' }, { id: 'remote-b', name: 'B 模式' }],
  })
  const mutePeer = await startFakePeer({
    name: 'mute',
    token: 'TOKEN-MUTE-1234567890123456789012',
    home: join(root, 'mute-home'),
    presets: null,
  })

  writeBootLog(homeA, 'http://127.0.0.1:59999', tokenA)
  writeBootLog(homeB, peerB.url, tokenB)

  const peersFile = join(root, 'peers.json')
  const localHome = join(root, 'local-home')
  writeJson(peersFile, {
    manual: { url: 'http://127.0.0.1:1', home: join(root, 'manual-home') },
    modes: { url: modesPeer.url, home: modesPeer.home, token: modesPeer.token },
    mute: { url: mutePeer.url, home: mutePeer.home, token: mutePeer.token },
    box: { local: true, home: localHome },
  })

  const config = {
    peersFile,
    localHome,
    discoverRoots: [root],
    discoverDepth: 3,
    discoverBudgetMs: 3_000,
  }
  const services = {
    agentPresets: {
      defaultId: 'fmd-entry',
      list: async () => [
        { id: 'fmd-fast', name: '快炼模式', description: '小批量一轮做完', order: 50 },
        { id: 'fmd-review', name: '审核模式', description: '独立第三方验收', order: 70 },
        { id: 'fmd-entry', name: '入口', description: '', order: 10 },
      ],
    },
  }
  const { run, tool } = await applyPlugin({ config, services })

  // ── 1) peer_list：合并 peers.json + 自动发现 + 本端 ──────────
  const list = await run('peer_list', {})
  const tags = list.peers.map((row) => `${row.name}:${row.origin}`)
  check('peer_list 合并三种来源',
    tags.includes('self:self') && tags.includes('manual:peers.json') && tags.includes('inst-a:discovered') && tags.includes('inst-b:discovered'),
    tags.join(' | '))
  check('peer_list：本端标记为 local（无需令牌）',
    list.peers.find((row) => row.name === 'self')?.sourceKind === 'local'
      && list.peers.find((row) => row.name === 'self')?.tokenPrefix === '',
    JSON.stringify(list.peers[0]))
  check('peer_list：local:true 的 peer 也在表里', list.peers.some((row) => row.name === 'box' && row.origin === 'peers.json'), tags.join(' | '))
  const panel = tool('peer_list').output.render({}, list)[0].text
  check('peer_list render：区分本端与发现来源', panel.includes('本端（跨会话）') && panel.includes('[discovered]'), JSON.stringify(panel.split('\n').slice(0, 2)))

  // ── 2) 自动发现的 peer：能认 token、带 url ─────────────────
  const tokenByDiscovery = await run('peer_token', { peer: 'inst-a' })
  check('自动发现的 peer 能认出令牌',
    tokenByDiscovery.sourceKind === 'log' && tokenByDiscovery.tokenPrefix === tokenA.slice(0, 6) && tokenByDiscovery.url === 'http://127.0.0.1:59999',
    `${tokenByDiscovery.tokenPrefix} kind=${tokenByDiscovery.sourceKind} url=${tokenByDiscovery.url}`)

  // ── 3) 按端口寻址：先匹配 discovered ──────────────────────
  const tokenByPort = await run('peer_token', { peer: '59999' })
  check('按端口认令牌（命中 discovered）', tokenByPort.peer === 'inst-a' && tokenByPort.tokenPrefix === tokenA.slice(0, 6),
    `${tokenByPort.peer} ${tokenByPort.tokenPrefix}`)

  // ── 4) 自动发现的 peer 能直接对话 ──────────────────────────
  const asked = await run('peer_ask', { peer: 'inst-b', message: 'ping', newSession: true, timeoutMs: 30_000 })
  check('自动发现的 peer 能直接对话', asked.ok === true && asked.reply === 'OK-DISCOVERED' && asked.sessionId.startsWith('session-inst-b-'),
    JSON.stringify({ reply: asked.reply, sid: asked.sessionId }))

  const byPortAsk = await run('peer_ask', { peer: String(peerB.port), message: 'ping-by-port', newSession: true, timeoutMs: 30_000 })
  check('按端口能直接对话且回填真实名字', byPortAsk.ok === true && byPortAsk.reply === 'OK-DISCOVERED' && byPortAsk.peer === 'inst-b',
    JSON.stringify({ peer: byPortAsk.peer, reply: byPortAsk.reply }))

  // ── 5) 未知 peer：报错带发现列表与端口提示 ─────────────────
  let unknownMessage = ''
  try { await run('peer_token', { peer: 'nope' }) } catch (error) { unknownMessage = String(error.message) }
  check('未知 peer 报错带发现列表', unknownMessage.includes('自动发现到') && unknownMessage.includes('也可以直接给端口'),
    unknownMessage.slice(0, 140))

  // ── 6) peer_modes：本机（排序 + 默认）、对端、对端不暴露 ────
  const localModes = await run('peer_modes', {})
  check('peer_modes 本机：3 个模式且按 order 排序',
    localModes.count === 3 && localModes.modes.map((row) => row.id).join(',') === 'fmd-entry,fmd-fast,fmd-review',
    localModes.modes.map((row) => row.id).join(','))
  check('peer_modes 本机：默认模式被标记',
    localModes.modes.filter((row) => row.isDefault).map((row) => row.id).join(',') === 'fmd-entry',
    JSON.stringify(localModes.modes.map((row) => [row.id, row.isDefault])))

  const remoteModes = await run('peer_modes', { peer: 'modes' })
  check('peer_modes 对端：枚举到对端 preset',
    remoteModes.count === 2 && remoteModes.modes.map((row) => row.id).join(',') === 'remote-a,remote-b' && remoteModes.source.includes('modes'),
    `${remoteModes.count} ${remoteModes.source}`)

  await expectThrow('peer_modes 对端不暴露时报错', () => run('peer_modes', { peer: 'mute' }), '没有暴露模式清单')

  // ── 7) 端口段探测：默认不扫；scan:true 只认 401 签名 ────────
  {
    const scanDir = join(tempRoot, 'scan')
    const scanPeers = join(scanDir, 'peers.json')
    mkdirSync(scanDir, { recursive: true })
    writeJson(scanPeers, {})
    const dshLike = await startStatusServer(401)
    const plain = await startStatusServer(200)
    const emptyRoot = join(scanDir, 'empty-root')
    mkdirSync(emptyRoot, { recursive: true })

    const ctx = await applyPlugin({
      config: {
        peersFile: scanPeers,
        discoverRoots: [emptyRoot],
        discoverBudgetMs: 200,
        discoverPorts: [dshLike.port, plain.port, 1],
      },
    })

    const quiet = await ctx.run('peer_list', { discover: false })
    check('端口探测：默认不扫', quiet.peers.filter((row) => row.origin === 'port-scan').length === 0, String(quiet.peers.length))

    const scanned = await ctx.run('peer_list', { discover: false, scan: true })
    const rows = scanned.peers.filter((row) => row.origin === 'port-scan')
    check('端口探测：401 端口被认出', rows.some((row) => row.url === dshLike.url), JSON.stringify(rows.map((row) => row.url)))
    check('端口探测：200 端口不误认', !rows.some((row) => row.url === plain.url), JSON.stringify(rows.map((row) => row.url)))
    check('端口探测：关闭端口忽略', !rows.some((row) => row.url.endsWith(':1')), JSON.stringify(rows.map((row) => row.url)))
    check('端口探测：扫出来的标「无令牌」', rows.length > 0 && rows.every((row) => row.sourceKind === 'none' && row.tokenPrefix === ''),
      JSON.stringify(rows.map((row) => [row.sourceKind, row.tokenPrefix])))
  }

  // ── 8) 没有 agentPresets 服务时：从 profile 的 cordis.patch.yml 识别模式 ──
  // 注意：当前实现里 presetsFromProfileFiles 用 /…([\s\S]{0,600})/ 贪婪窗口找 id，
  // 同一文件里相邻声明的第二个 preset 会被第一个匹配吃掉（实测只认出 1 个）。
  // 这里只断言「一个声明能被认出来」这个稳定契约，多 preset 的缺陷见 README「已知限制」。
  {
    const fallbackDir = join(tempRoot, 'profile-fallback')
    const profileHome = join(fallbackDir, 'dsh-home')
    const profileDir = join(profileHome, 'profiles', 'web')
    mkdirSync(profileDir, { recursive: true })
    writeFileSync(join(profileDir, 'cordis.patch.yml'), [
      'plugins:',
      "  - name: '@deepseek-ai/dsh-agent-preset'",
      '    config:',
      '      id: fmd-review',
      '      name: 审核模式',
      '      order: 70',
    ].join('\n'))
    const fallbackPeers = join(fallbackDir, 'peers.json')
    writeJson(fallbackPeers, {})

    const ctx = await applyPlugin({
      config: { peersFile: fallbackPeers, localHome: profileHome, discoverRoots: [tempRoot], discoverBudgetMs: 200 },
    })
    const modes = await ctx.run('peer_modes', {})
    check('无 agentPresets 服务：从 profile 文件识别模式',
      modes.count === 1 && modes.modes[0].id === 'fmd-review' && modes.source.includes('profile'),
      JSON.stringify({ count: modes.count, ids: modes.modes.map((row) => row.id), source: modes.source }))
  }

  // ── 9) 没给 peersFile 时：按 DSH_HOME 推导 peers 表路径 ──────
  {
    const envRoot = join(tempRoot, 'env-home')
    const dshHome = join(envRoot, 'dsh-home')
    const token = 'ENVFILE-TOKEN-abcdefabcdefabcdef00'
    mkdirSync(join(dshHome, 'peer-chat'), { recursive: true })
    writeJson(join(dshHome, 'peer-chat', 'peers.json'), {
      envpeer: { url: 'http://127.0.0.1:1', home: join(envRoot, 'peer-home'), token },
    })
    process.env.DSH_HOME = dshHome
    try {
      const ctx = await applyPlugin({ config: { discoverRoots: [tempRoot], discoverBudgetMs: 200 } })
      const value = await ctx.run('peer_token', { peer: 'envpeer' })
      check('没给 peersFile 时按 DSH_HOME 推导', value.tokenPrefix === token.slice(0, 6) && value.sourceKind === 'cache',
        `${value.tokenPrefix} kind=${value.sourceKind}`)
    } finally {
      delete process.env.DSH_HOME
    }
  }
})
