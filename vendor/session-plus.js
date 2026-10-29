/**
 * dsh-session-plus —— 我们自己的会话增强插件（不打上游补丁）。
 *
 * 提供两件上游暂时没有的能力：
 *   session_steer  —— 对运行中的会话插话（next-step），空闲时自动排队
 *   session_spawn  —— 按指定 preset 新建会话并投递首条任务
 *
 * 放在 profile 的 node_modules 里，和 @ryuu-64/dsh-session-tools 同级，导入解析一致。
 */
import { randomUUID } from 'node:crypto'
import { appendFileSync } from 'node:fs'

const DEBUG_LOG = 'E:\\dshlonger\\dsh-home\\_tmp\\session-plus.log'
function debug(obj) { try { appendFileSync(DEBUG_LOG, JSON.stringify({ t: new Date().toISOString(), ...obj }) + '\n') } catch {} }
import z from '@deepseek-ai/schemastery'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { brandString } from '@deepseek-ai/dsh-brand'

export const name = 'dsh-session-plus'
export const inject = ['tools', 'agents']
export const Config = z.object({})

const SOURCE = 'dsh-session-plus'

function textMessage(text) {
  return createUserMessage({
    content: [{ type: 'text', text }],
    source: { kind: SOURCE, form: 'relay' },
  })
}

export function apply(ctx) {
  ctx.tools.register(defineTool({
    name: 'session_steer',
    description: 'Interject a message into another chat session. While the target is running, the message is delivered at its next step (steering) instead of waiting for the turn to end; when idle it is queued as the next turn. Returns immediately.',
    parameters: {
      sessionId: {
        type: 'string',
        required: true,
        description: 'Target session id, for example session-2330bd36-fe62-4621-8d42-c7e04566f447.',
      },
      message: {
        type: 'string',
        required: true,
        description: 'Message text. Write it self-contained: the target cannot see this conversation.',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: true,
        properties: {
          sessionId: { type: 'string', required: true },
          messageId: { type: 'string', required: true },
          mode: { type: 'string', required: true },
          targetStatus: { type: 'string', required: true },
        },
      },
      render: (_args, value) => [{
        type: 'text',
        text: value.mode === 'steer'
          ? `已插话：${value.sessionId}（下一步送达）`
          : `已排队：${value.sessionId}（目标当前 ${value.targetStatus}）`,
      }],
    },
    async execute(args, exec) {
      const sessionId = String(args.sessionId ?? '').trim()
      if (sessionId === '') throw new Error('session_steer requires a sessionId')
      const text = String(args.message ?? '').trim()
      if (text === '') throw new Error('session_steer requires a non-empty message')
      const callerId = String(exec.agent?.session?.header?.id ?? '')
      if (sessionId === callerId) throw new Error('session_steer 不能对自己插话')
      const agents = ctx.get('agents')
      if (agents === undefined) throw new Error('agents 服务未加载')
      const target = agents.get(sessionId)
      if (target === undefined) throw new Error(`目标会话不存在或未加载：${sessionId}`)
      const sent = textMessage(text)
      const rawStatus = target.status
      const status = String(rawStatus ?? 'idle')
      const running = !['idle', 'stopped', 'disposed', 'error'].includes(status)
      if (running) target.steer(sent)
      else target.followup(sent)
      return { sessionId, messageId: sent.id, mode: running ? 'steer' : 'queue', targetStatus: status }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'session_spawn',
    description: 'Create a visible chat session bound to a specific agent preset, then deliver its first task. Unlike session_create, the preset is explicit (for example drama-review or fmd-distill). Returns immediately unless wait is true.',
    parameters: {
      prompt: { type: 'string', required: true, description: 'First task for the new session. Write it self-contained.' },
      preset: { type: 'string', required: true, description: 'Target preset config.id, for example drama-write.' },
      title: { type: 'string', description: 'Optional title. Defaults to "spawn · <preset>".' },
      workspacePath: { type: 'string', description: 'Existing workspace path. Omit to reuse the caller working directory.' },
      provider: { type: 'string', description: '可选：模型提供方（如 wb / deepseek-official）。省略则用当前默认模型。' },
      model: { type: 'string', description: '可选：模型 id（如 deepseek-v4.1-flash）。省略则用当前默认模型。' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: true,
        properties: {
          sessionId: { type: 'string', required: true },
          messageId: { type: 'string', required: true },
          preset: { type: 'string', required: true },
          cwd: { type: 'string', required: true },
          provider: { type: 'string' },
          model: { type: 'string' },
        },
      },
      render: (_args, value) => [{
        type: 'text',
        text: `已建会话 ${value.sessionId}（preset=${value.preset}，模型=${value.provider}/${value.model}，cwd=${value.cwd}）`,
      }],
    },
    async execute(args, exec) {
      const prompt = String(args.prompt ?? '').trim()
      if (prompt === '') throw new Error('session_spawn requires a non-empty prompt')
      const requested = String(args.preset ?? '').trim()
      if (requested === '') throw new Error('session_spawn requires a preset id')
      const presets = ctx.get('agentPresets')
      if (presets === undefined) throw new Error('agentPresets 服务未加载')
      let presetId
      try {
        presetId = (await presets.resolve(requested)).id
      } catch {
        throw new Error(`未知预设：${requested}`)
      }
      const agents = ctx.get('agents')
      if (agents === undefined) throw new Error('agents 服务未加载')
      const callerCwd = exec.agent?.session?.header?.cwd
      let cwd = callerCwd
      if (args.workspacePath) {
        const registry = ctx.get('workspaceRegistry')
        if (registry === undefined) throw new Error('workspaceRegistry 服务未加载')
        const workspace = await registry.resolveByPath(String(args.workspacePath))
        if (workspace === undefined) throw new Error(`没有该路径的工作区：${args.workspacePath}`)
        cwd = workspace.path
      }
      // DEFAULT_WORKSPACE_FALLBACK: 调用者本身可能就没有 cwd（会级联产生 sessions\\_no-cwd，前端会 session/not-found）
    if (cwd === undefined) {
      cwd = (typeof config?.defaultWorkspace === 'string' && config.defaultWorkspace.trim() !== '')
        ? config.defaultWorkspace.trim()
        : 'E:\\dshsystem\\Documents\\deepseek-harness\\default-workspace'
    }
      const sessionId = brandString(`session-${randomUUID()}`)
      const parentSession = String(exec.agent?.session?.header?.id ?? '')
      const wantProvider = String(args.provider ?? '').trim()
      const wantModel = String(args.model ?? '').trim()
      let agentOptions
      if (wantProvider !== '' && wantModel !== '') {
        agentOptions = { provider: wantProvider, model: wantModel }
      } else if (wantProvider !== '' || wantModel !== '') {
        throw new Error('provider 与 model 必须同时给')
      } else {
        const defaultModel = ctx.get('agentDefaultModel')
        const selection = defaultModel?.currentSelection?.() ?? {}
        agentOptions = (selection.provider && selection.model)
          ? { provider: selection.provider, model: selection.model }
          : undefined
      }
      if (agentOptions === undefined) throw new Error('拿不到默认 provider/model，无法建会话（先在界面选一次模型）')
      const handle = await agents.create({
        signal: exec.signal,
        sessionId,
        agentOptions,
        meta: {
          cwd,
          ...(parentSession === '' ? {} : { parentSession }),
          agentPreset: presetId,
        },
        setup: async (agentCtx) => {
          // WORKING_DIRECTORY_FIX: 宿主不读 meta.cwd；cwd 只能由 WorkingDirectoryService 设置，
          // 否则会话落到 sessions\\_no-cwd，前端点开会 session/not-found。
          try {
            const wd = ctx.get('workingDirectory')
            if (wd !== undefined && typeof wd.set === 'function' && typeof cwd === 'string' && cwd !== '') {
              await wd.set(agentCtx.agent, cwd, exec.signal)
            }
          } catch (e) {
            try { ctx.logger?.warn?.('[session-plus] set working directory failed: ' + (e && e.message)) } catch {}
          }
          await presets.mount(agentCtx, presetId)
        },
      })
      try {
        const titleService = ctx.get('sessionTitle')
        const title = String(args.title ?? '').trim() || `spawn · ${presetId}`
        if (titleService !== undefined) {
          try { titleService.rename(handle.agent.session, title) } catch {}
        }
        const sent = textMessage(prompt)
        handle.agent.followup(sent)
        debug({ tool: 'session_spawn', sessionId: String(sessionId), preset: String(presetId), provider: agentOptions.provider, model: agentOptions.model })
        return { sessionId: String(sessionId), messageId: sent.id, preset: String(presetId), cwd: String(cwd), provider: agentOptions.provider, model: agentOptions.model }
      } catch (error) {
        try { await handle.dispose() } catch {}
        throw error
      }
    },
  }))
}
