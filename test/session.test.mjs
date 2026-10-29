/**
 * session.test.mjs —— 会话面：peer_ask / peer_tail / peer_steer 的两条路线。
 *
 * 覆盖（对应 index.js）：
 *   remote：openSession → login/rpc → askRemote → waitForReply
 *   local ：createLocalSession（session_create 优先 / agents.create 兜底 / preset 挂载）、
 *           deliverLocal（session_send 优先 / sessionController.prompt 兜底）
 *   steer ：steerRemote（mode=steer，不等回复）、steerLocal（session_steer → sessionController）、
 *           peer_tail 的读日志与「省略 peer 默认 self」。
 *
 * 所有落盘都在 os.tmpdir() 的一次性目录里；假对端只写自己 home 下的会话日志。
 */
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import {
  applyPlugin,
  emptyCapture,
  runSuite,
  startFakePeer,
  writeJson,
  writeReply,
  appendSessionLog,
  replyEvents,
} from './fixture.mjs'

await runSuite('session', async ({ check, expectThrow, tempRoot }) => {
  // ── 远程对端：一个会按 prompt 写回复的假实例 ──────────────────
  const remoteDir = join(tempRoot, 'remote')
  const remoteHome = join(remoteDir, 'home')
  const peersFile = join(remoteDir, 'peers.json')
  const capture = emptyCapture()
  const peer = await startFakePeer({ name: 'far', token: 'TOKEN-SESSION-111111111111111111', home: remoteHome, capture })
  writeJson(peersFile, { far: { url: peer.url, home: remoteHome, token: peer.token } })

  const { run, registry } = await applyPlugin({
    config: { peersFile, discoverRoots: [tempRoot], discoverBudgetMs: 200 },
  })

  // 1) 新建会话并取回回复
  const asked = await run('peer_ask', { peer: 'far', message: '只回 OK', newSession: true, timeoutMs: 30_000 })
  check('远程 ask：取到回复', asked.ok === true && asked.reply === '回:只回 OK' && asked.timedOut === false,
    JSON.stringify({ reply: asked.reply, timedOut: asked.timedOut }))
  check('远程 ask：路由与会话标记', asked.route === 'remote' && asked.created === true && asked.sessionId === 'session-far-1' && asked.turnsBefore === 0,
    JSON.stringify({ route: asked.route, created: asked.created, sid: asked.sessionId, before: asked.turnsBefore }))
  check('远程 ask：session/create 信封', JSON.stringify(capture.creates[0]) === '{}', JSON.stringify(capture.creates[0]))

  const promptEnvelope = capture.prompts[0]?.request ?? {}
  check('远程 ask：prompt 信封齐字段',
    promptEnvelope.sessionId === 'session-far-1'
      && promptEnvelope.mode === 'queue'
      && promptEnvelope.content?.[0]?.type === 'text'
      && promptEnvelope.content?.[0]?.text === '只回 OK'
      && typeof promptEnvelope.requestId === 'string',
    JSON.stringify(promptEnvelope).slice(0, 160))

  // 2) 续既有会话：created=false，turnsBefore 如实
  const seeded = 'session-reuse-0001'
  writeReply(remoteHome, seeded, '旧回答', 1)
  const again = await run('peer_ask', { peer: 'far', sessionId: seeded, message: '再来一次', timeoutMs: 30_000 })
  check('远程续会话：不新建且 turnsBefore=1', again.created === false && again.turnsBefore === 1 && again.sessionId === seeded,
    JSON.stringify({ created: again.created, before: again.turnsBefore }))
  check('远程续会话：回复是新一轮', again.reply === '回:再来一次', JSON.stringify(again.reply))

  // 3) 再续一轮，攒出 3 个 turn，供 tail 断言
  await run('peer_ask', { peer: 'far', sessionId: seeded, message: '第三轮', timeoutMs: 30_000 })

  const tail = await run('peer_tail', { peer: 'far', sessionId: seeded, n: 2 })
  check('peer_tail：最近 2 条 + 总数', tail.messages.length === 2
    && tail.messages[0].turn === 2 && tail.messages[0].text === '回:再来一次'
    && tail.messages[1].turn === 3 && tail.messages[1].text === '回:第三轮'
    && tail.totalAssistant === 3,
    JSON.stringify(tail.messages.map((row) => [row.turn, row.text])))
  const tailAll = await run('peer_tail', { peer: 'far', sessionId: seeded, n: 3 })
  check('peer_tail：跨 zstd 帧读到第一轮', tailAll.messages[0].text === '旧回答', tailAll.messages[0].text)

  // 4) 超时：对端不写日志 → timedOut，且不抛错
  {
    const dir = join(tempRoot, 'timeout')
    const home = join(dir, 'home')
    const file = join(dir, 'peers.json')
    mkdirSync(home, { recursive: true })
    const silent = await startFakePeer({ name: 'quiet', token: 'TOKEN-QUIET-2222222222222222222', home: '' })
    writeJson(file, { quiet: { url: silent.url, home, token: silent.token } })
    const ctx = await applyPlugin({ config: { peersFile: file, discoverRoots: [tempRoot], discoverBudgetMs: 200 } })
    const timed = await ctx.run('peer_ask', { peer: 'quiet', message: '没人回', newSession: true, timeoutMs: 5_000 })
    // 契约：消息投出去了但没等到回复 → ok:false + timedOut:true + 空 reply（不是抛错）
    check('远程 ask：超时如实标记 timedOut', timed.ok === false && timed.timedOut === true && timed.reply === '' && timed.waitedMs >= 5_000,
      JSON.stringify({ ok: timed.ok, timedOut: timed.timedOut, reply: timed.reply, waitedMs: timed.waitedMs }))
  }

  // 5) 入参校验
  await expectThrow('peer_ask 缺 message 报错', () => run('peer_ask', { peer: 'far' }), 'peer_ask 必填')
  await expectThrow('sessionId 与 newSession 互斥', () => run('peer_ask', { peer: 'far', sessionId: 's', newSession: true, message: 'x' }), '不能同时给')
  check('peer_ask 的 peer 不是必填', !registry.get('peer_ask').parameters.required.includes('peer'),
    JSON.stringify(registry.get('peer_ask').parameters.required))
  check('peer_tail 的 sessionId 必填', registry.get('peer_tail').parameters.required.includes('sessionId'),
    JSON.stringify(registry.get('peer_tail').parameters.required))

  // ── 本机路线：用桩服务模拟 dsh-session-tools / session-plus ────
  const localHome = join(tempRoot, 'local-home')
  mkdirSync(localHome, { recursive: true })
  const localPeers = join(tempRoot, 'local-peers.json')
  writeJson(localPeers, {})
  const localConfig = { peersFile: localPeers, localHome, discoverRoots: [tempRoot], discoverBudgetMs: 200 }
  const modelServices = () => ({ agentDefaultModel: { currentSelection: () => ({ provider: 'deepseek', model: 'chat' }) } })
  const freshCalls = () => ({ created: [], prompted: [], presets: [], sessionCreate: [], sessionSend: [] })

  // 6) 有 session_create → 直接复用
  {
    const calls = freshCalls()
    const ctx = await applyPlugin({
      config: localConfig,
      services: modelServices(),
      tools: {
        session_create: {
          async execute(args) {
            calls.sessionCreate.push(args)
            writeReply(localHome, 'session-via-tools', 'OK-1', 1)
            return { sessionId: 'session-via-tools' }
          },
        },
      },
    })
    const value = await ctx.run('peer_ask', { peer: 'self', message: 'ping' })
    check('本机：复用 session_create 且只投递一次', value.route === 'local' && value.createVia.startsWith('session_create') && value.reply === 'OK-1' && calls.sessionCreate.length === 1,
      `createVia=${value.createVia} reply=${value.reply}`)
  }

  // 7) session_create 被审批拦下 → agents.create 兜底 + sessionController.prompt
  {
    const calls = freshCalls()
    const ctx = await applyPlugin({
      config: localConfig,
      services: {
        ...modelServices(),
        agents: {
          async create(options) {
            calls.created.push(options)
            if (typeof options.setup === 'function') await options.setup({ marker: 'agentCtx' })
            return { agent: { session: { header: { id: options.sessionId } } } }
          },
        },
        sessionController: {
          async prompt(request) {
            calls.prompted.push(request)
            writeReply(localHome, request.sessionId, 'OK-2', 1)
            return { accepted: true }
          },
        },
      },
      tools: {
        session_create: { async execute() { throw new Error('this DSH cannot establish permission, so create a new session was not done') } },
      },
    })
    const value = await ctx.run('peer_ask', { peer: 'self', message: 'ping' })
    check('本机兜底：走到 ctx.agents.create', value.createVia.startsWith('ctx.agents.create') && value.reply === 'OK-2', `createVia=${value.createVia}`)
    check('本机兜底：agentOptions 必传 model/provider',
      calls.created.length === 1 && calls.created[0].agentOptions?.provider === 'deepseek' && calls.created[0].agentOptions?.model === 'chat',
      JSON.stringify(calls.created[0]?.agentOptions))
    check('本机兜底：投递走 sessionController.prompt', value.deliverVia === 'sessionController.prompt' && calls.prompted.length === 1, value.deliverVia)
    check('本机兜底：降级原因可查',
      value.degraded.some((line) => line.includes('session_create 不可用')) && value.degraded.some((line) => line.includes('没有 session_send')),
      JSON.stringify(value.degraded))
  }

  // 8) 指定 preset → agents.create + agentPresets.mount
  {
    const calls = freshCalls()
    const ctx = await applyPlugin({
      config: localConfig,
      services: {
        ...modelServices(),
        agents: {
          async create(options) {
            calls.created.push(options)
            if (typeof options.setup === 'function') await options.setup({ marker: 'agentCtx' })
            return { agent: { session: { header: { id: options.sessionId } } } }
          },
        },
        agentPresets: {
          async resolve(id) { calls.presets.push(id); return { id } },
          async mount() { calls.presets.push('mount') },
        },
        sessionController: {
          async prompt(request) { calls.prompted.push(request); writeReply(localHome, request.sessionId, 'OK-3', 1); return { accepted: true } },
        },
      },
      tools: { session_create: { async execute() { calls.sessionCreate.push('unexpected'); return { sessionId: 'x' } } } },
    })
    const value = await ctx.run('peer_ask', { peer: 'self', message: 'ping', preset: 'fmd-review' })
    check('本机 preset：走 agents.create 且 meta 带 preset',
      value.createVia.startsWith('ctx.agents.create') && calls.created[0]?.meta?.agentPreset === 'fmd-review' && value.reply === 'OK-3',
      `meta=${JSON.stringify(calls.created[0]?.meta)}`)
    check('本机 preset：挂了预设作用域', calls.presets.includes('fmd-review') && calls.presets.includes('mount'), JSON.stringify(calls.presets))
    check('本机 preset：不碰 session_create', calls.sessionCreate.length === 0, JSON.stringify(calls.sessionCreate))
  }

  // 9) 续本机既有会话 → 优先 session_send
  {
    const sid = 'session-local-existing'
    writeReply(localHome, sid, 'old-reply', 1)
    const calls = freshCalls()
    const ctx = await applyPlugin({
      config: localConfig,
      services: { ...modelServices() },
      tools: {
        session_send: {
          async execute(args) {
            calls.sessionSend.push(args)
            appendSessionLog(localHome, args.sessionId, replyEvents('OK-4', 2))
          },
        },
      },
    })
    const value = await ctx.run('peer_ask', { peer: 'self', sessionId: sid, message: 'again' })
    check('本机续会话：复用 session_send', value.deliverVia.startsWith('session_send') && value.reply === 'OK-4' && value.created === false,
      `deliverVia=${value.deliverVia} reply=${value.reply}`)
    check('本机续会话：turnsBefore 正确', value.turnsBefore === 1, String(value.turnsBefore))
  }

  // 10) 没有默认模型也没有 session_create → 明确报错
  {
    const ctx = await applyPlugin({
      config: localConfig,
      services: { agents: { async create() { throw new Error('should not reach') } } },
    })
    await expectThrow('本机缺模型：提示先在界面选模型', () => ctx.run('peer_ask', { peer: 'self', message: 'ping' }), '先在界面选一次模型')
  }

  // 11) peer_tail 省略 peer 默认本端 self
  {
    const ctx = await applyPlugin({ config: localConfig })
    const value = await ctx.run('peer_tail', { sessionId: 'session-local-existing', n: 1 })
    check('peer_tail：省略 peer 默认本端', value.peer === 'self' && value.messages.length === 1 && value.messages[0].text === 'OK-4',
      JSON.stringify({ peer: value.peer, messages: value.messages }))
  }

  // ── peer_steer ───────────────────────────────────────────────
  // 12) 远程：mode=steer 的一条 prompt，不等回复、不建会话
  {
    const dir = join(tempRoot, 'steer-remote')
    const home = join(dir, 'home')
    const file = join(dir, 'peers.json')
    const steerCapture = emptyCapture()
    const target = await startFakePeer({ name: 'far', token: 'TOKEN-STEER-3333333333333333333', home, capture: steerCapture })
    writeJson(file, { far: { url: target.url, home, token: target.token } })
    const ctx = await applyPlugin({ config: { peersFile: file, discoverRoots: [tempRoot], discoverBudgetMs: 200 } })

    const started = Date.now()
    const value = await ctx.run('peer_steer', { peer: 'far', sessionId: 'session-existing', message: '停一下，只回 OK' })
    const took = Date.now() - started
    check('steer 远程：mode=steer 且立刻回执', value.ok === true && value.mode === 'steer' && value.accepted === true && took < 2_000, `${took}ms mode=${value.mode}`)
    check('steer 远程：不建会话', steerCapture.creates.length === 0, String(steerCapture.creates.length))
    const steering = steerCapture.prompts[0]?.request ?? {}
    check('steer 远程：正文透传且带 sessionId', steering.sessionId === 'session-existing' && steering.mode === 'steer'
      && steering.content?.[0]?.text === '停一下，只回 OK', JSON.stringify(steering).slice(0, 160))
  }

  // 13) 本机：session_steer 优先（运行中 → steer）
  {
    const calls = []
    const ctx = await applyPlugin({
      config: localConfig,
      tools: {
        session_steer: {
          async execute(args, exec) {
            calls.push({ args, hasAgent: exec?.agent !== undefined })
            return { sessionId: args.sessionId, messageId: 'm1', mode: 'steer', targetStatus: 'running' }
          },
        },
      },
    })
    const value = await ctx.run('peer_steer', { peer: 'self', sessionId: 'session-local', message: '插一句' })
    check('steer 本机：复用 session_steer', value.deliveredVia.startsWith('session_steer') && value.mode === 'steer' && value.targetStatus === 'running',
      `${value.deliveredVia} mode=${value.mode} status=${value.targetStatus}`)
    check('steer 本机：参数透传', calls[0]?.args.sessionId === 'session-local' && calls[0]?.args.message === '插一句', JSON.stringify(calls[0]?.args))
  }

  // 14) 本机：目标空闲时如实报 queue
  {
    const ctx = await applyPlugin({
      config: localConfig,
      tools: { session_steer: { async execute(args) { return { sessionId: args.sessionId, mode: 'queue', targetStatus: 'idle' } } } },
    })
    const value = await ctx.run('peer_steer', { peer: 'self', sessionId: 'session-local', message: '插一句' })
    check('steer 本机：空闲如实报 queue', value.mode === 'queue' && value.targetStatus === 'idle', `mode=${value.mode} status=${value.targetStatus}`)
  }

  // 15) 本机：没有 session_steer → sessionController.prompt(mode=steer)
  {
    const prompted = []
    const ctx = await applyPlugin({
      config: localConfig,
      services: {
        sessionController: { async prompt(request) { prompted.push(request); return { accepted: true } } },
      },
    })
    const value = await ctx.run('peer_steer', { peer: 'self', sessionId: 'session-local', message: '插一句' })
    check('steer 本机：退到 sessionController.prompt', value.deliveredVia.startsWith('sessionController.prompt') && prompted[0]?.mode === 'steer',
      `${value.deliveredVia} mode=${prompted[0]?.mode}`)
    check('steer 本机：降级原因可查', value.degraded.some((line) => line.includes('没有 session_steer')), JSON.stringify(value.degraded))
  }

  // 16) 入参校验
  {
    const ctx = await applyPlugin({ config: localConfig })
    await expectThrow('steer 缺 sessionId 报错', () => ctx.run('peer_steer', { peer: 'self', message: 'x' }), '请给 sessionId')
    await expectThrow('steer 拒绝 newSession', () => ctx.run('peer_steer', { peer: 'self', sessionId: 's', message: 'x', newSession: true }), '只对已存在的会话插话')
  }

  // 17) 输出 render：长回复截断 / 超时文案
  {
    const askTool = registry.get('peer_ask')
    const sample = {
      peer: 'far', route: 'remote', sessionId: 'session-x', created: false, createVia: 'x', deliverVia: 'y',
      degraded: [], reply: 'A'.repeat(5_000), timedOut: false, waitedMs: 1_234,
    }
    const longText = askTool.output.render({}, sample)[0].text
    check('peer_ask render：长回复按 4000 字符截断',
      longText.includes('A'.repeat(4_000)) && !longText.includes('A'.repeat(4_001)) && longText.includes('已截断：共 5000 字符'),
      JSON.stringify(longText.slice(-48)))
    const timeoutText = askTool.output.render({}, { ...sample, reply: '', timedOut: true })[0].text
    check('peer_ask render：超时文案明确', timeoutText.includes('没等到 turn 结束'), JSON.stringify(timeoutText.slice(-48)))
  }
})
