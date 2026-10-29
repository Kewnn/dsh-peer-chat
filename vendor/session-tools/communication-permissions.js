import { HarnessError } from '@deepseek-ai/dsh-llm';
import { symbols } from '@deepseek-ai/cordis';
import { defineDomain, domainTable } from '@deepseek-ai/dsh-storage-domain';
import { z } from 'zod';

const recordSchema = z.object({
  send: z.boolean(), receive: z.boolean(), revision: z.number().int().nonnegative().safe(),
}).strict();
const spec = defineDomain({
  name: 'session_tools_communication', version: 1,
  // Authoritative data: malformed records reject the whole domain, never skip.
  tables: { sessions: domainTable(recordSchema) },
});
const states = new WeakMap();
const defaults = Object.freeze({ send: true, receive: true, revision: 0 });
export class CommunicationDenied extends HarnessError {
  constructor(direction) {
    super(`未送达、未排队：${direction === 'send' ? '来源会话已关闭发送。' : '目标会话已关闭接收。'}没有消息回执；通信权限改变前不要重复发送。`, 'session-tools/permission-denied');
    this.name = 'CommunicationDenied';
  }
}
export const sessionIdentitySchema = z.string().min(1).max(1024);
function sessionKey(id) {
  sessionIdentitySchema.parse(id);
  return id;
}
export function trustedSource(exec) { return sessionKey(exec?.agent?.session?.header?.id); }

/** One queue shared by all plugin instances, writes and final admissions alike. */
export function communicationPermissions(ctx) {
  const service = ctx.get('storageDomain');
  if (typeof service?.open !== 'function') throw new Error('Session communication controls require DSH 0.2.0-rc.2 storageDomain.');
  const identity = service[symbols.original] ?? service;
  let state = states.get(identity);
  if (state) return state;
  const ready = service.open(spec);
  // Keep a malformed/unavailable domain closed, while avoiding unhandled rejection.
  ready.catch(() => {});
  let tail = Promise.resolve();
  const serial = (action) => {
    const result = tail.then(async () => action((await ready).table('sessions')));
    tail = result.then(() => {}, () => {});
    return result;
  };
  const read = (table, id) => ({ ...recordSchema.parse(table.get(sessionKey(id)) ?? defaults) });
  const check = (table, sourceId, targetId) => {
    if (!read(table, sourceId).send) throw new CommunicationDenied('send');
    if (targetId !== undefined && !read(table, targetId).receive) throw new CommunicationDenied('receive');
  };
  state = {
    get: (id) => serial(table => read(table, id)),
    check: (sourceId, targetId) => serial(table => check(table, sourceId, targetId)),
    // One authoritative snapshot for the current visible page; never retain it
    // in discovery cursors. This is switch capability, not delivery or approval.
    statuses: (sourceId, targetIds) => serial(table => {
      const source = read(table, sourceId);
      const checkedAt = Date.now();
      return targetIds.map(targetId => {
        const target = read(table, targetId);
        const reason = !source.send && !target.receive ? 'both_disabled'
          : !source.send ? 'sender_send_disabled' : !target.receive ? 'target_receive_disabled' : 'switches_allow';
        return { state: source.send && target.receive ? 'allowed' : 'blocked', reason,
          senderSend: source.send, targetReceive: target.receive, checkedAt };
      });
    }),
    set: (id, patch, expectedRevision) => serial(async table => {
      const parsed = recordSchema.parse({ ...patch, revision: expectedRevision });
      const current = read(table, id);
      if (current.revision !== expectedRevision) return { status: 'conflict', current };
      if (current.revision === Number.MAX_SAFE_INTEGER) throw new Error('Permission revision exhausted');
      const next = { send: parsed.send, receive: parsed.receive, revision: current.revision + 1 };
      await table.put(sessionKey(id), next);
      return { status: 'saved', current: { ...next } };
    }),
    // No await between the final synchronous read/check and followup callback.
    admit: (sourceId, targetId, exec, followup) => serial(table => {
      exec.signal?.throwIfAborted();
      check(table, sourceId, targetId);
      return followup();
    }),
  };
  states.set(identity, state);
  return state;
}

// Explicit unknown never invents open defaults when identity/storage is unavailable.
export const unknownCommunication = () => ({ state: 'unknown', reason: 'unavailable', checkedAt: Date.now() });
export const communicationStatusSchema = {
  type: 'object', additionalProperties: false,
  properties: {
    state: { type: 'string', required: true, enum: ['allowed', 'blocked', 'unknown'] },
    reason: { type: 'string', required: true, enum: ['switches_allow', 'sender_send_disabled', 'target_receive_disabled', 'both_disabled', 'unavailable'] },
    senderSend: { type: 'boolean' }, targetReceive: { type: 'boolean' },
    checkedAt: { type: 'number', required: true },
  },
};
export function communicationStatusText(status) {
  return ({ switches_allow: '通信开关允许', sender_send_disabled: '当前会话已关闭发送',
    target_receive_disabled: '目标已关闭接收', both_disabled: '当前会话已关闭发送，目标已关闭接收',
    unavailable: '通信状态无法确认' })[status.reason] ?? '通信状态无法确认';
}
