/**
 * chain.test.mjs —— 链路面：peer_chain 执行 + peer_chains 管理 + 模板。
 *
 * 覆盖（对应 index.js）：
 *   runChain / runStep（mode 优先级、{input}/{prev}/{sN}/{sN.json.x}、stopOnError、onFail:skip、
 *   自动消息模板、返工判定 judgeVerdict 与 maxRetries）
 *   peer_chains：add / remove / export / import（含冲突与坏 JSON）/ 面板 render
 *   installTemplate / validateChain。
 *
 * 用三个假对端：alpha（固定 A-ANSWER）、beta（固定 B-ANSWER）、jsoner（回一段 JSON）。
 * 所有产物在 os.tmpdir() 的一次性目录里。
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  applyPlugin,
  emptyCapture,
  readJson,
  runSuite,
  startFakePeer,
  writeJson,
} from './fixture.mjs'

await runSuite('chain', async ({ check, expectThrow, tempRoot }) => {
  const dir = join(tempRoot, 'flow')
  const peersFile = join(dir, 'peers.json')
  const chainsFile = join(dir, 'chains.json')
  const capA = emptyCapture()
  const capB = emptyCapture()
  const capJson = emptyCapture()

  const peers = [
    await startFakePeer({ name: 'alpha', token: 'TOKEN-ALPHA-11111111111111111111', home: join(dir, 'alpha-home'), replies: ['A-ANSWER'], capture: capA }),
    await startFakePeer({ name: 'beta', token: 'TOKEN-BETA-22222222222222222222', home: join(dir, 'beta-home'), replies: ['B-ANSWER'], capture: capB }),
    await startFakePeer({ name: 'jsoner', token: 'TOKEN-JSONER-333333333333333333', home: join(dir, 'jsoner-home'), replies: ['{"verdict":"PASS","items":["a","b"]}'], capture: capJson }),
  ]
  writeJson(peersFile, Object.fromEntries(peers.map((peer) => [peer.name, { url: peer.url, home: peer.home, token: peer.token }])))
  writeJson(chainsFile, {})

  const baseConfig = {
    peersFile,
    chainsFile,
    discoverRoots: [tempRoot],
    discoverBudgetMs: 200,
  }
  const services = { agentPresets: { defaultId: 'fmd-review', list: async () => [{ id: 'fmd-review' }, { id: 'fmd-fast' }] } }
  const { run, registry } = await applyPlugin({ config: baseConfig, services })
  const chains = registry.get('peer_chains')

  const runChain = (args) => run('peer_chain', args)

  // ── 1) mode 优先级：顶层 → 步内覆盖 → 都不给就不传 ───────────
  const topMode = await runChain({
    mode: 'fmd-review',
    timeoutMs: 8_000,
    steps: [
      { peer: 'alpha', message: '第一跳' },
      { peer: 'beta', message: '第二跳：{prev}' },
    ],
  })
  check('顶层 mode 传给两个对端', capA.creates[0]?.agentPreset === 'fmd-review' && capB.creates[0]?.agentPreset === 'fmd-review',
    `${capA.creates[0]?.agentPreset} / ${capB.creates[0]?.agentPreset}`)
  const prevPrompt = capB.prompts[0]?.text ?? ''

  const beforeOverride = capB.creates.length
  await runChain({ mode: 'fmd-review', timeoutMs: 8_000, steps: [{ peer: 'beta', message: 'x', mode: 'fmd-fast' }] })
  check('步内 mode 覆盖顶层', capB.creates[beforeOverride]?.agentPreset === 'fmd-fast', String(capB.creates.at(-1)?.agentPreset))

  const beforeNone = capA.creates.length
  await runChain({ timeoutMs: 8_000, steps: [{ peer: 'alpha', message: 'y' }] })
  check('两级都没给就不传 preset', capA.creates[beforeNone] !== undefined && capA.creates[beforeNone].agentPreset === undefined,
    JSON.stringify(capA.creates.at(-1)))

  // ── 2) 结果字段与 {prev} 原位替换 ──────────────────────────
  check('两跳成功且带 status/bytes/mode',
    topMode.ok === true && topMode.steps.length === 2
      && topMode.steps[1].status === 'ok' && topMode.steps[1].bytes === Buffer.byteLength('B-ANSWER', 'utf8')
      && topMode.steps[1].mode === 'fmd-review' && topMode.final === 'B-ANSWER',
    JSON.stringify(topMode.steps.map((step) => [step.mode, step.status, step.bytes])))
  check('{prev} 原位替换', prevPrompt === '第二跳：A-ANSWER', JSON.stringify(prevPrompt))

  // ── 3) {input} 与 {sN} / {sN.json.x} ───────────────────────
  const inputRun = await runChain({
    input: '需求X',
    timeoutMs: 8_000,
    steps: [
      { peer: 'alpha', message: '写一版：{input}' },
      { peer: 'beta', message: '审这个：{prev}' },
    ],
  })
  check('{input} 传进第一步', inputRun.ok === true && capA.prompts.at(-1)?.text === '写一版：需求X', JSON.stringify(capA.prompts.at(-1)?.text))
  check('{prev} 传进第二步（第二轮）', capB.prompts.at(-1)?.text === '审这个：A-ANSWER', JSON.stringify(capB.prompts.at(-1)?.text))

  const jsonRun = await runChain({
    input: '给我 JSON',
    timeoutMs: 8_000,
    steps: [
      { peer: 'jsoner', message: '{input}' },
      { peer: 'beta', message: '结论 {s1.json.verdict}，第二项 {s1.json.items[1]}' },
    ],
  })
  // 注意：消息里没写 {prev} 时，插件会把上一步回复附在末尾（「（上一步回复）」段），所以这里只断言开头。
  check('JSON 字段与数组下标抽取', jsonRun.ok === true && (capB.prompts.at(-1)?.text ?? '').startsWith('结论 PASS，第二项 b'),
    JSON.stringify(capB.prompts.at(-1)?.text))

  await runChain({ timeoutMs: 8_000, steps: [{ peer: 'alpha', message: 'a' }, { peer: 'beta', message: '原样引用：{s1}' }] })
  check('{sN} 普通引用', (capB.prompts.at(-1)?.text ?? '').startsWith('原样引用：A-ANSWER'), JSON.stringify(capB.prompts.at(-1)?.text))

  const missingStep = await runChain({ timeoutMs: 8_000, steps: [{ peer: 'beta', message: '取 {s9}' }] })
  check('引用不存在的步骤报错', missingStep.ok === false && String(missingStep.steps[0]?.error).includes('第 9 步还没有结果'),
    String(missingStep.steps[0]?.error).slice(0, 80))

  const missingField = await runChain({ timeoutMs: 8_000, steps: [{ peer: 'jsoner', message: 'a' }, { peer: 'beta', message: '取 {s1.json.nope}' }] })
  check('JSON 缺字段报错', missingField.ok === false && String(missingField.steps[1]?.error).includes('没有字段 nope'),
    String(missingField.steps[1]?.error).slice(0, 80))

  // ── 4) 失败面：未知模式 / stopOnError / onFail:skip ─────────
  const badMode = await runChain({
    mode: 'bad-preset',
    timeoutMs: 8_000,
    steps: [
      { peer: 'alpha', message: '第一跳' },
      { peer: 'beta', message: '第二跳' },
    ],
  })
  check('未知模式中止在第 1 步', badMode.ok === false && badMode.stoppedAt === 1 && badMode.steps.length === 1, `stoppedAt=${badMode.stoppedAt}`)
  check('未知模式文案正确', String(badMode.steps[0]?.error).includes('未知模式'), String(badMode.steps[0]?.error).slice(0, 100))

  const continued = await runChain({
    mode: 'bad-preset',
    stopOnError: false,
    timeoutMs: 8_000,
    steps: [
      { peer: 'alpha', message: '第一跳' },
      { peer: 'beta', message: '第二跳', mode: 'fmd-fast' },
    ],
  })
  check('stopOnError:false 继续跑完', continued.steps.length === 2 && continued.steps[0].status === 'failed' && continued.steps[1].status === 'ok',
    JSON.stringify(continued.steps.map((step) => step.status)))

  const skipped = await runChain({
    timeoutMs: 8_000,
    steps: [
      { peer: 'alpha', message: 'a' },
      { peer: 'nope', message: '这一步会失败', onFail: 'skip' },
      { peer: 'beta', message: '继续：{prev}' },
    ],
  })
  check('onFail:skip 继续后续步', skipped.steps.some((step) => step.status === 'skipped') && skipped.final === 'B-ANSWER',
    JSON.stringify(skipped.steps.map((step) => [step.index, step.status])))

  // ── 5) 入参校验与自动消息模板 ──────────────────────────────
  await expectThrow('空 steps 报错', () => runChain({ steps: [] }), '至少一步')
  const autoMsg = await runChain({ timeoutMs: 8_000, steps: [{ peer: 'alpha' }] })
  check('省略 message 走自动模板', autoMsg.ok === true && autoMsg.steps[0].status === 'ok' && (capA.prompts.at(-1)?.text ?? '') !== '',
    JSON.stringify({ status: autoMsg.steps[0].status, text: capA.prompts.at(-1)?.text?.slice(0, 40) }))

  // ── 6) 返工：审阅不过 → 重跑上一步 → 再审 ──────────────────
  {
    const rwDir = join(tempRoot, 'rework')
    const rwPeers = join(rwDir, 'peers.json')
    const rwChains = join(rwDir, 'chains.json')
    const workerCap = emptyCapture()
    const reviewCap = emptyCapture()
    const worker = await startFakePeer({ name: 'worker', token: 'TOKEN-WORKER-444444444444444444', home: join(rwDir, 'worker-home'), replies: ['V1 初稿', 'V2 修改稿'], capture: workerCap })
    const reviewer = await startFakePeer({ name: 'reviewer', token: 'TOKEN-REVIEW-555555555555555555', home: join(rwDir, 'reviewer-home'), replies: ['缺少边界说明\nREWORK', '通过\nNEXT'], capture: reviewCap })
    writeJson(rwPeers, {
      worker: { url: worker.url, home: worker.home, token: worker.token },
      reviewer: { url: reviewer.url, home: reviewer.home, token: reviewer.token },
    })
    writeJson(rwChains, {})
    const ctx = await applyPlugin({ config: { peersFile: rwPeers, chainsFile: rwChains, discoverRoots: [tempRoot], discoverBudgetMs: 200 } })

    const reworked = await ctx.run('peer_chain', {
      maxRetries: 1,
      timeoutMs: 8_000,
      steps: [{ peer: 'worker' }, { peer: 'reviewer', mode: 'fmd-review' }],
    })
    check('返工：审阅不过时上一步被重跑', workerCap.prompts.length === 2 && workerCap.prompts[1].text.includes('缺少边界说明'),
      JSON.stringify(workerCap.prompts.map((item) => item.text.slice(0, 24))))
    check('返工：复审拿到 NEXT 收尾', reworked.final.includes('NEXT') && reworked.reworks === 1,
      JSON.stringify({ final: reworked.final, reworks: reworked.reworks }))
    check('返工：步骤结果里标了 rework', reworked.steps.some((step) => step.rework !== undefined),
      JSON.stringify(reworked.steps.map((step) => [step.index, step.status, step.rework])))
    check('返工：审阅步带审核语义与上一步产出', (reviewCap.prompts[0]?.text ?? '').includes('审核') && reviewCap.prompts[0].text.includes('V1 初稿'),
      JSON.stringify(reviewCap.prompts[0]?.text?.slice(0, 40)))

    workerCap.prompts.length = 0
    reviewCap.prompts.length = 0
    const noRework = await ctx.run('peer_chain', {
      maxRetries: 0,
      timeoutMs: 8_000,
      steps: [{ peer: 'worker' }, { peer: 'reviewer', mode: 'fmd-review' }],
    })
    check('maxRetries:0 关闭返工', workerCap.prompts.length === 1 && noRework.reworks === 0 && noRework.final.includes('REWORK'),
      JSON.stringify({ calls: workerCap.prompts.length, final: noRework.final.slice(-20) }))
  }

  // ── 7) peer_chains：增 / 面板 / 按名跑 / 删 ─────────────────
  const added = await chains.execute({
    action: 'add',
    name: 'write-then-review',
    chain: {
      description: '写 → 审',
      mode: 'fmd-fast',
      steps: [
        { peer: 'alpha', message: '写一版：{input}' },
        { peer: 'beta', message: '审这个：{prev}', mode: 'fmd-review' },
      ],
    },
  })
  check('add 落盘', added.count === 1 && readJson(chainsFile)['write-then-review']?.steps?.length === 2, String(added.count))
  check('add 回传可用模式', Array.isArray(added.modes) && [...added.modes].sort().join(',') === 'fmd-fast,fmd-review', JSON.stringify(added.modes))
  const panel = chains.output.render({}, added)[0].text
  check('peer_chains 面板排版', panel.includes('固定链路 1 条') && panel.includes('write-then-review') && panel.includes('1) alpha') && panel.includes('可用模式 2 个'),
    JSON.stringify(panel.split('\n').slice(0, 4)))

  const byName = await runChain({ name: 'write-then-review', input: '需求X', timeoutMs: 8_000 })
  check('按名字跑通', byName.ok === true && byName.steps.length === 2 && byName.final === 'B-ANSWER', JSON.stringify(byName.steps.map((step) => step.status)))
  check('链路默认 mode 生效（顶层 fmd-fast + 步内 fmd-review）',
    capA.creates.at(-1)?.agentPreset === 'fmd-fast' && capB.creates.at(-1)?.agentPreset === 'fmd-review',
    `${capA.creates.at(-1)?.agentPreset} / ${capB.creates.at(-1)?.agentPreset}`)
  check('按名字跑：{input} 落进第一步', capA.prompts.at(-1)?.text === '写一版：需求X', JSON.stringify(capA.prompts.at(-1)?.text))

  const removed = await chains.execute({ action: 'remove', name: 'write-then-review' })
  check('remove 生效', removed.count === 0 && Object.keys(readJson(chainsFile)).length === 0, String(removed.count))

  // ── 8) 校验错误面 ──────────────────────────────────────────
  await expectThrow('add 缺 steps 报错', () => chains.execute({ action: 'add', name: 'x', chain: { steps: [] } }), '至少要一步')
  await expectThrow('add 缺 peer 报错', () => chains.execute({ action: 'add', name: 'y', chain: { steps: [{ message: 'm' }] } }), '缺 peer')
  await expectThrow('remove 不存在报错', () => chains.execute({ action: 'remove', name: 'nope' }), '没有链路')
  await expectThrow('跑不存在链路报错', () => runChain({ name: 'nope' }), '未知链路')
  await expectThrow('非法 action', () => chains.execute({ action: 'explode' }), 'action 只能是')

  // ── 9) export / import ─────────────────────────────────────
  const exported = await chains.execute({ action: 'export' })
  check('export 出 JSON', typeof exported.json === 'string' && typeof JSON.parse(exported.json) === 'object'
    && exported.count === Object.keys(JSON.parse(exported.json)).length, `count=${exported.count}`)

  const imported = await chains.execute({
    action: 'import',
    json: JSON.stringify({ 'from-import': { steps: [{ peer: 'alpha', message: '{input}' }] } }),
  })
  check('import 合并成功', imported.count === exported.count + 1 && imported.chains.some((row) => row.name === 'from-import'), String(imported.count))

  await expectThrow('import 同名冲突报错', () => chains.execute({
    action: 'import',
    json: JSON.stringify({ 'from-import': { steps: [{ peer: 'alpha', message: 'x' }] } }),
  }), '已存在')

  const beforeBad = readFileSync(chainsFile, 'utf8')
  await expectThrow('import 坏 JSON 拒绝', () => chains.execute({ action: 'import', json: '{not json' }), '不合法')
  check('坏 JSON 不写坏文件', readFileSync(chainsFile, 'utf8') === beforeBad, '文件未变')

  // ── 10) 模板装载 ───────────────────────────────────────────
  {
    const tDir = join(tempRoot, 'templates')
    const tChains = join(tDir, 'chains.json')
    writeJson(tChains, {})
    const ctx = await applyPlugin({ config: { peersFile, chainsFile: tChains, discoverRoots: [tempRoot], discoverBudgetMs: 200 }, services })
    const table = ctx.registry.get('peer_chains')

    for (const template of ['review-loop', 'relay', 'quick-ask']) {
      await table.execute({ action: 'install-template', template })
    }
    const onDisk = readJson(tChains)
    check('三条模板落盘且结构正确',
      Object.keys(onDisk).length === 3
        && onDisk['review-loop'].steps.length === 2 && onDisk.relay.steps.length === 3 && onDisk['quick-ask'].steps.length === 1,
      Object.keys(onDisk).join(','))
    check('review-loop 保留 maxRetries', onDisk['review-loop'].maxRetries === 2, String(onDisk['review-loop'].maxRetries))
    check('审阅步带 mode 且无 message',
      onDisk['review-loop'].steps[1].mode === 'fmd-review' && onDisk['review-loop'].steps[1].message === undefined,
      JSON.stringify(onDisk['review-loop'].steps[1]))

    await table.execute({ action: 'install-template', template: 'relay', name: 'relay-3090', peer: '3090' })
    check('peer 覆盖生效', readJson(tChains)['relay-3090'].steps.every((step) => step.peer === '3090'),
      JSON.stringify(readJson(tChains)['relay-3090'].steps.map((step) => step.peer)))

    await expectThrow('同名模板默认报错', () => table.execute({ action: 'install-template', template: 'relay' }), '已存在')
    await table.execute({ action: 'install-template', template: 'quick-ask', name: 'relay', overwrite: true })
    check('overwrite 覆盖成功', readJson(tChains).relay.steps.length === 1, String(readJson(tChains).relay.steps.length))
  }
})
