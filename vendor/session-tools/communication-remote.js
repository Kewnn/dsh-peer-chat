import { symbols } from '@deepseek-ai/cordis';
import { Remote, RemoteError, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol';
import { z } from 'zod';
import { communicationPermissions, sessionIdentitySchema } from './communication-permissions.js';

const sessionId = sessionIdentitySchema;
const getSchema = z.object({ sessionId }).strict();
const setSchema = z.object({ sessionId, send: z.boolean(), receive: z.boolean(), expectedRevision: z.number().int().nonnegative().safe() }).strict();
const recordSchema = z.object({ send: z.boolean(), receive: z.boolean(), revision: z.number().int().nonnegative().safe() }).strict();
const setResultSchema = z.object({ status: z.enum(['saved', 'conflict']), current: recordSchema }).strict();
export const communicationRemote = {
  package: '@ryuu-64/dsh-session-tools',
  descriptors: ['get', 'set'].map(method => ({
    id: `@ryuu-64/dsh-session-tools:sessionCommunication.${method}`,
    service: 'sessionCommunication', namespace: 'sessionCommunication', method,
    invocation: { kind: 'direct' },
    parameters: [{ name: 'request', wire: 'request', source: 'json', codec: {
      mode: 'strict', typeSymbol: `@ryuu-64/dsh-session-tools:sessionCommunication.${method}:request`,
      create: () => method === 'get' ? getSchema : setSchema,
    } }],
    result: {
      mode: 'strict', typeSymbol: `@ryuu-64/dsh-session-tools:sessionCommunication.${method}:result`,
      create: () => method === 'get' ? recordSchema : setResultSchema,
    },
  })),
};
const initializers = [];
const original = value => value?.[symbols.original] ?? value;
/** A Remote UI surface only. No corresponding model tool is registered. */
export class CommunicationRemote extends TypertRemoteService {
  static inject = ['typert', 'connection', 'storageDomain'];
  constructor(ctx) {
    super(ctx, 'sessionCommunication');
    for (const initialize of initializers) initialize.call(this);
    ctx.typert.register({
      package: communicationRemote.package, face: 'host', schemas: [],
      model: { services: [], events: [], objects: [] },
      invocations: communicationRemote.descriptors,
    });
  }
  authorize() {
    const invocation = this.ctx.invocation;
    const operator = this.ctx.connection.operator;
    if (!invocation || !operator || original(invocation.peer) !== original(operator)) {
      throw new RemoteError('gateway/bad-request', 'Only the authenticated host operator can read or change communication permissions.', {});
    }
    invocation.signal.throwIfAborted();
  }
  async get(request) {
    this.authorize();
    const parsed = getSchema.parse(request);
    return await communicationPermissions(this.ctx).get(parsed.sessionId);
  }
  async set(request) {
    this.authorize();
    const parsed = setSchema.parse(request);
    return await communicationPermissions(this.ctx).set(parsed.sessionId, { send: parsed.send, receive: parsed.receive }, parsed.expectedRevision);
  }
}
// Apply the official standard-decorator initialization contract in plain JS.
for (const method of ['get', 'set']) Remote(CommunicationRemote.prototype[method], {
  kind: 'method', name: method, static: false, private: false,
  addInitializer: initialize => initializers.push(initialize),
});
