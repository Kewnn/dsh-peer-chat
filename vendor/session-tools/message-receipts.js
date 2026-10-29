import { z } from 'zod';
import { expandAssistantStream, joinAssistantStreamText } from '@deepseek-ai/dsh-llm';

// These are a plugin-owned fold/cache of public rc.2 events, not a host
// message-result API. Checkpoints are disposable; the event log is authoritative.
export const receiptProjectionKey = 'sessionToolsReceipts';
const receiptSchema = z.object({
  state: z.enum(['queued', 'delivered', 'discarded']),
  turn: z.number().nullable(), admitted: z.boolean(), ambiguous: z.boolean(), inherited: z.boolean(),
});
export const receiptProjection = {
  key: receiptProjectionKey,
  stateVersion: 1,
  stateSchema: z.object({
    seq: z.number(), inheritedEventCount: z.number(), valid: z.boolean(),
    openTurn: z.number().nullable(),
    nextTurn: z.array(z.string()), nextStep: z.array(z.string()),
    messages: z.record(z.string(), receiptSchema),
    turns: z.record(z.string(), z.string()),
  }),
  init: (_header, inheritedEventCount = 0) => ({
    seq: -1, inheritedEventCount, valid: true, openTurn: null,
    nextTurn: [], nextStep: [], messages: {}, turns: {},
  }),
  apply: foldReceiptEvent,
};

/** Pure, JSON-only projection. Invalid/incomplete logs fail attribution closed. */
function foldReceiptEvent(previous, event) {
  if (!previous.valid) return previous;
  const state = { ...previous, seq: event.seq };
  const invalid = () => ({ ...state, valid: false });
  if (!Number.isSafeInteger(event.seq) || event.seq !== previous.seq + 1) return invalid();
  const data = event.data ?? {};
  if (event.type === 'turn/start') {
    if (state.openTurn !== null || !Number.isSafeInteger(data.turn) || data.turn <= 0 || Object.hasOwn(state.turns, data.turn)) return invalid();
    return { ...state, openTurn: data.turn };
  }
  if (event.type === 'turn/end') {
    if (state.openTurn !== data.turn || typeof data.reason?.kind !== 'string') return invalid();
    return { ...state, openTurn: null, turns: { ...state.turns, [data.turn]: data.reason.kind } };
  }
  if (event.type === 'agent/inbox/spliced') {
    const key = data.target === 'next-turn' ? 'nextTurn' : data.target === 'next-step' ? 'nextStep' : undefined;
    if (!key) return invalid();
    const list = state[key], count = data.removedCount ?? 0;
    if (!Number.isSafeInteger(data.start) || data.start < 0 || data.start > list.length || !Number.isSafeInteger(count) || count < 0 || data.start + count > list.length || !Array.isArray(data.inserted)) return invalid();
    if (data.outcome !== undefined && data.outcome !== 'canceled') return invalid();
    const inserted = data.inserted.map(message => message?.id);
    if (inserted.some(id => typeof id !== 'string' || id === '')) return invalid();
    const removed = list.slice(data.start, data.start + count);
    const next = list.toSpliced(data.start, count, ...inserted);
    const pending = [...next, ...state[key === 'nextTurn' ? 'nextStep' : 'nextTurn']];
    if (new Set(pending).size !== pending.length) return invalid();
    const messages = { ...state.messages };
    for (const id of removed) {
      // Public claim() uses a pure deletion inside the already-open turn;
      // ordinary remove/replace/clear logs outcome:canceled (discarded).
      if (data.outcome === undefined && (state.openTurn === null || inserted.length !== 0)) return invalid();
      messages[id] = { ...messages[id], state: data.outcome === 'canceled' ? 'discarded' : 'delivered', turn: data.outcome === 'canceled' ? null : state.openTurn };
    }
    for (const id of inserted) {
      messages[id] = { state: 'queued', turn: null, admitted: false, ambiguous: Object.hasOwn(messages, id), inherited: event.seq < state.inheritedEventCount };
    }
    return { ...state, [key]: next, messages };
  }
  if (event.type === 'user/message') {
    const message = state.messages[data.id];
    if (!Object.hasOwn(state.messages, data.id)) return state;
    if (message.state !== 'delivered' || message.turn !== state.openTurn || message.admitted) {
      return { ...state, messages: { ...state.messages, [data.id]: { ...message, ambiguous: true } } };
    }
    return { ...state, messages: { ...state.messages, [data.id]: { ...message, admitted: true } } };
  }
  return state;
}

export function foldReceipts(events, inheritedEventCount = 0) {
  return events.reduce(foldReceiptEvent, receiptProjection.init(undefined, inheritedEventCount));
}

/** Same output selection as rc.2 AssistantOutputFold, restricted to one turn. */
export function turnOutput(events, turn) {
  let message;
  const partial = [];
  let inside = false;
  for (const event of events) {
    if (event.type === 'turn/start' && event.data.turn === turn) inside = true;
    if (event.type === 'turn/end' && event.data.turn === turn) break;
    if (!inside || event.data?.turn !== turn || !['assistant/message', 'assistant/attempt'].includes(event.type)) continue;
    if (event.type === 'assistant/message' && event.data.message?.content?.length > 0) message = event.data.message.content;
    const stream = event.data.stream ?? [];
    // Public stream readers trust types; validate persisted records first.
    expandAssistantStream(stream);
    partial.push(joinAssistantStreamText(stream));
  }
  const text = message === undefined ? partial.join('') : message.filter(block => block.type === 'text').map(block => block.text).join('');
  return text.trim() === '' ? undefined : text;
}

export function messageReceipt(state, messageId, events) {
  const unknown = note => ({ messageStatus: 'unknown', completed: false, attributionNote: note });
  if (!state.valid) return unknown('The event log is incomplete or cannot reliably identify this message.');
  if (!Object.hasOwn(state.messages, messageId)) return unknown('No durable receipt for this message was found.');
  const message = state.messages[messageId];
  if (message.ambiguous || message.inherited) return unknown('This identity is reused or belongs to inherited history; its result cannot be attributed.');
  const base = { messageStatus: message.state, completed: false, ...(message.turn === null ? {} : { turn: message.turn }) };
  if (message.turn === null) return base;
  const kind = state.turns[message.turn];
  if (kind === undefined) return base;
  const ended = { ...base, turnEndKind: kind };
  if (kind === 'completed' && !message.admitted) return { ...ended, ...unknown('The turn ended without admitting this message to the model.') };
  const messageStatus = { completed: 'turnCompleted', aborted: 'cancelled', blocked: 'blocked', error: 'failed', interrupted: 'interrupted', 'max-tokens': 'incomplete' }[kind] ?? 'unknown';
  if (messageStatus !== 'turnCompleted') return { ...ended, messageStatus };
  try {
    const output = turnOutput(events, message.turn);
    return { ...ended, messageStatus, completed: true, ...(output === undefined ? {} : { output }) };
  } catch {
    return { ...ended, ...unknown('The recorded output could not be decoded reliably.') };
  }
}
