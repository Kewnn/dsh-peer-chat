/**
 * panel.test.mjs —— 对外表面：工具注册契约 + 浏览器面板路由。
 *
 * 覆盖（对应 index.js）：
 *   apply() 里 8 个工具的参数/输出 schema 与 render；
 *   registerPanelRoute：GET 快照（peers/modes/chains/templates）、GET ?peer 读对端模式、
 *   POST save-chain / remove-chain / install-template / import / export / run-chain、非法 method 与 action；
 *   renderChainsPanel / renderModePanel 两个面板 render。
 *
 * 面板路由不真起 HTTP：直接拿 registerPanelRoute 注册的 handler，用最小 req/res 桩调用。
 */
import { EventEmitter } from 'node:events'
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import {
  applyPlugin,
  emptyCapture,
  readJson,
  runSuite,
  startFakePeer,
  writeJson,
} from './fixture.mjs'

/** 用最小 req/res 桩调面板 handler，返回 { status, json }。 */
function makeInvoker(getRoute) {
  return async function invoke({ method = 'GET', query = '', body, headers = {} } = {}) {
    const route = getRoute()
    if (route === undefined) throw new Error('面板路由还没注册')
    // 默认模拟「本机浏览器」：Host 是本机、POST 带 JSON content-type；用例可覆盖个别头做安全闸测试。
    const requestHeaders = {
      host: '127.0.0.1:3130',
      ...(method === 'POST' ? { 'content-type': 'application/json' } : {}),
      ...headers,
    }
    let status = 0
    let text = ''
    const res = {
      writeHead(code) { status = code; return this },
      end(value) { if (value !== undefined) text = String(value); return this },
      on() { return this },
      off() { return this },
    }
    if (method === 'POST') {
      const req = new EventEmitter()
      req.method = 'POST'
      req.url = '/dsh-peer-chat-api'
      req.headers = requestHeaders
      const pending = route.handler(req, res)
      req.emit('data', Buffer.from(JSON.stringify(body ?? {})))
      req.emit('end')
      await pending
    } else {
      await route.handler({ method, url: `/dsh-peer-chat-api${query}`, headers: requestHeaders }, res)
    }
    let json = null
    try { json = JSON.parse(text) } catch { /* 非 JSON 响应 */ }
    return { status, text, json }
  }
}

await runSuite('panel', async ({ check, tempRoot }) => {
  const dir = join(tempRoot, 'panel')
  const peersFile = join(dir, 'peers.json')
  const chainsFile = join(dir, 'chains.json')
  const alphaHome = join(dir, 'alpha-home')
  const capture = emptyCapture()
  const alpha = await startFakePeer({
    name: 'alpha',
    token: 'TOKEN-PANEL-111111111111111111111',
    home: alphaHome,
    presets: [{ id: 'remote-x', name: 'X 模式' }, { id: 'remote-y', name: 'Y 模式' }],
    capture,
  })
  writeJson(peersFile, { alpha: { url: alpha.url, home: alphaHome, token: alpha.token } })
  writeJson(chainsFile, {})

  let route = null
  const services = {
    webServer: {
      register(definition) {
        route = definition
        return () => { route = null }
      },
    },
    agentPresets: {
      defaultId: 'fmd-review',
      list: async () => [
        { id: 'fmd-review', name: '审核模式', description: '独立第三方验收', order: 70 },
        { id: 'fmd-fast', name: '快炼模式', description: '小批量一轮做完', order: 50 },
      ],
    },
  }
  const localHome = join(dir, 'local-home')
  mkdirSync(localHome, { recursive: true })
  const { registry, tool } = await applyPlugin({
    config: { peersFile, chainsFile, localHome, discoverRoots: [tempRoot], discoverBudgetMs: 200 },
    services,
  })

  // ── 1) 工具注册契约：8 个工具、参数 schema 完整、输出带 schema+render ──
  const expectedTools = ['peer_token', 'peer_ask', 'peer_chain', 'peer_steer', 'peer_list', 'peer_modes', 'peer_chains', 'peer_tail']
  check('注册了 8 个 peer_* 工具', expectedTools.every((name) => registry.has(name)) && registry.size === expectedTools.length,
    [...registry.keys()].join(','))

  for (const name of expectedTools) {
    const definition = registry.get(name)
    const properties = definition?.parameters?.properties ?? {}
    const required = definition?.parameters?.required ?? []
    const missingMeta = Object.keys(properties).filter((key) => typeof properties[key].description !== 'string' || properties[key].type === undefined)
    check(`${name}：参数 schema 完整`,
      definition.parameters.type === 'object'
        && required.every((key) => Object.hasOwn(properties, key))
        && missingMeta.length === 0,
      `props=${Object.keys(properties).join('/')} 缺描述=${missingMeta.join(',') || '无'}`)
    check(`${name}：输出 schema + render`,
      definition.output?.schema?.type === 'object' && typeof definition.output.render === 'function',
      definition.output?.schema?.type ?? '缺 schema')
  }
  check('没有工具占用 run_code', expectedTools.every((name) => name !== 'run_code'), 'ok')

  // ── 2) 面板路由注册 ────────────────────────────────────────
  check('注册了面板路由（exact + 路径）', route?.kind === 'exact' && route?.path === '/dsh-peer-chat-api', String(route?.path))
  const invoke = makeInvoker(() => route)

  // ── 3) GET 快照 ────────────────────────────────────────────
  const snapshot = await invoke()
  const peers = snapshot.json?.peers ?? []
  check('快照：对端列表含本端与 peers.json', snapshot.json?.ok === true && peers.length === 2 && peers[0].name === 'self' && peers[1].name === 'alpha',
    JSON.stringify(peers.map((row) => [row.name, row.origin])))
  check('快照：带 3 条模板', Array.isArray(snapshot.json?.templates) && snapshot.json.templates.length === 3,
    JSON.stringify((snapshot.json?.templates ?? []).map((row) => row.id)))
  check('快照：本机模式 + 默认标记', snapshot.json?.modes?.length === 2 && snapshot.json.modes.some((row) => row.id === 'fmd-review' && row.isDefault === true),
    JSON.stringify(snapshot.json?.modes))
  check('快照：模式来源非空', typeof snapshot.json?.modesSource === 'string' && snapshot.json.modesSource !== '', String(snapshot.json?.modesSource))
  check('快照：链路列表是数组', Array.isArray(snapshot.json?.chains) && snapshot.json.chains.length === 0, JSON.stringify(snapshot.json?.chains))

  // ── 4) GET ?peer=alpha 读对端模式 ──────────────────────────
  const remoteModes = await invoke({ query: '?peer=alpha' })
  check('GET ?peer：读对端模式清单', remoteModes.json?.ok === true && remoteModes.json.count === 2
    && remoteModes.json.modes.map((row) => row.id).join(',') === 'remote-x,remote-y'
    && String(remoteModes.json.source).includes('alpha'),
    JSON.stringify({ count: remoteModes.json?.count, source: remoteModes.json?.source }))

  // ── 5) POST install-template ───────────────────────────────
  const installed = await invoke({ method: 'POST', body: { action: 'install-template', template: 'quick-ask', peer: 'alpha' } })
  check('POST 装载模板', installed.json?.ok === true && (installed.json.chains ?? []).some((row) => row.name === 'quick-ask'),
    JSON.stringify((installed.json?.chains ?? []).map((row) => row.name)))
  check('模板落盘且 peer 覆盖', readJson(chainsFile)['quick-ask']?.steps?.[0]?.peer === 'alpha',
    JSON.stringify(readJson(chainsFile)['quick-ask']?.steps?.[0]))

  // ── 6) POST run-chain ──────────────────────────────────────
  const ran = await invoke({ method: 'POST', body: { action: 'run-chain', name: 'quick-ask', input: '面板触发' } })
  check('POST 运行链路', ran.json?.ok === true && ran.json.result?.ok === true && ran.json.result?.steps?.length === 1
    && ran.json.result.steps[0].status === 'ok',
    JSON.stringify({ ok: ran.json?.result?.ok, steps: ran.json?.result?.steps?.length }))
  check('POST 运行链路：{input} 真传给了对端', (capture.prompts.at(-1)?.text ?? '').startsWith('面板触发'), JSON.stringify(capture.prompts.at(-1)?.text))

  // ── 7) POST save-chain / remove-chain ──────────────────────
  const saved = await invoke({
    method: 'POST',
    body: { action: 'save-chain', name: 'from-panel', chain: { description: '面板存', steps: [{ peer: 'alpha', message: '{input}' }] } },
  })
  check('POST 保存链路', saved.json?.ok === true && readJson(chainsFile)['from-panel']?.steps?.length === 1
    && (saved.json.chains ?? []).some((row) => row.name === 'from-panel'),
    JSON.stringify((saved.json?.chains ?? []).map((row) => row.name)))

  const dropped = await invoke({ method: 'POST', body: { action: 'remove-chain', name: 'from-panel' } })
  check('POST 删除链路', dropped.json?.ok === true && readJson(chainsFile)['from-panel'] === undefined, JSON.stringify(dropped.json?.changed))

  // ── 8) POST export / import（坏 JSON）──────────────────────
  const exported = await invoke({ method: 'POST', body: { action: 'export' } })
  let exportedJson = null
  try { exportedJson = JSON.parse(exported.json?.json ?? '') } catch { /* 下面断言 */ }
  check('POST 导出链路 JSON', exported.json?.ok === true && exportedJson !== null && exported.json.count === Object.keys(exportedJson).length,
    `count=${exported.json?.count}`)

  const badImport = await invoke({ method: 'POST', body: { action: 'import', json: '{oops' } })
  check('POST 导入坏 JSON 被拒（400）', badImport.status === 400 && badImport.json?.ok === false && String(badImport.json.error).includes('不合法'),
    String(badImport.json?.error).slice(0, 60))

  // ── 9) 错误面：未知 action / 非法 method ───────────────────
  const unknownAction = await invoke({ method: 'POST', body: { action: 'explode' } })
  check('POST 未知 action 被拒（400）', unknownAction.status === 400 && String(unknownAction.json?.error).includes('未知 action'),
    String(unknownAction.json?.error))
  const wrongMethod = await invoke({ method: 'PUT' })
  check('非 GET/POST 返回 405', wrongMethod.status === 405 && String(wrongMethod.json?.error).includes('只支持'), String(wrongMethod.json?.error))

  // ── 9.5) 四道安全闸（Host / Origin / Sec-Fetch-Site / content-type）──
  const foreignHost = await invoke({ method: 'POST', headers: { host: 'evil.example.com' }, body: { action: 'export' } })
  check('安全闸：非本机 Host 被拒（403）', foreignHost.status === 403 && String(foreignHost.json?.error).includes('本机 Host'),
    String(foreignHost.json?.error))
  const foreignOrigin = await invoke({ method: 'POST', headers: { origin: 'https://evil.example.com' }, body: { action: 'export' } })
  check('安全闸：跨源 Origin 被拒（403）', foreignOrigin.status === 403 && String(foreignOrigin.json?.error).includes('跨源'),
    String(foreignOrigin.json?.error))
  const crossSite = await invoke({ method: 'POST', headers: { 'sec-fetch-site': 'cross-site' }, body: { action: 'export' } })
  check('安全闸：跨站上下文被拒（403）', crossSite.status === 403 && String(crossSite.json?.error).includes('跨站'),
    String(crossSite.json?.error))
  const notJson = await invoke({ method: 'POST', headers: { 'content-type': 'text/plain' }, body: { action: 'export' } })
  check('安全闸：POST 非 JSON 被拒（415）', notJson.status === 415 && String(notJson.json?.error).includes('application/json'),
    String(notJson.json?.error))
  const localOrigin = await invoke({ method: 'POST', headers: { origin: 'http://127.0.0.1:3130' }, body: { action: 'export' } })
  check('安全闸：同源 Origin 放行', localOrigin.status === 200 && localOrigin.json?.ok === true, String(localOrigin.status))

  // ── 10) 两个 render 的排版 ─────────────────────────────────
  const modesValue = await tool('peer_modes').execute({}, {})
  const modesPanel = tool('peer_modes').output.render({}, modesValue)[0].text
  check('peer_modes render：标题 + 默认星标', modesPanel.startsWith('模式 2 个') && modesPanel.includes('★'),
    JSON.stringify(modesPanel.split('\n').slice(0, 3)))

  const chainsList = await tool('peer_chains').execute({ action: 'list' })
  const chainsPanel = tool('peer_chains').output.render({}, chainsList)[0].text
  check('peer_chains render：标题 + 链路行', chainsPanel.includes('固定链路') && chainsPanel.includes('quick-ask'),
    JSON.stringify(chainsPanel.split('\n').slice(0, 3)))
})
