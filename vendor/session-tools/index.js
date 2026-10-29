import { setTimeout as delay } from "node:timers/promises";
import { randomUUID } from "node:crypto";
import { isAbsolute } from "node:path";
import z from "@deepseek-ai/schemastery";
import { defineTool } from "@deepseek-ai/dsh-tools";
import { createUserMessage } from "@deepseek-ai/dsh-llm";
import { brandString } from "@deepseek-ai/dsh-brand";
import { symbols } from "@deepseek-ai/cordis";
import { fallbackSessionTitle } from "@deepseek-ai/dsh-session-title";
import { receiptProjection, receiptProjectionKey, foldReceipts, messageReceipt } from "./message-receipts.js";
import { createActivitySorter, readSlots } from "./session-activity.js";
import { createSessionDiscovery } from "./session-discovery.js";
import { communicationPermissions, trustedSource, unknownCommunication, communicationStatusSchema, communicationStatusText } from "./communication-permissions.js";
import { CommunicationRemote } from "./communication-remote.js";

/** Stable Loader identity and producer-owned message source (V3 and V4). */
const name = "tool-session";
/** Nothing to configure. */
const Config = z.object({});
// Public fallback helper, using the shipped dsh-base 0.1.5-rc.2 limits.
// SessionTitleService.rename still enforces the host's accepted-title limit.
const fallbackTitleWords = 5;
const fallbackTitleBytes = 40;
/** Host services this tool needs: where it registers tools, and what it creates a session with. */
const inject = [
	"tools",
	"agents",
	"sessionTitle",
	"workspaceRegistry",
	"agentDefaultModel",
	"storageDomain"
];
/** List the existing workspaces, so a rejected path tells the caller what to use instead. */
function workspaceCatalogue(registry) {
	const items = registry.list();
	return items.map((workspace) => `${workspace.title} (${workspace.path})`).join("; ");
}
/**
* Name a session in tool output, the way a person would say it: the title they
* will see in the sidebar, plus the id when the title is not known yet.
*
* Deliberately NOT the `@[label](dsh-session:…)` mention form. That form renders
* as a chip in message text but carries no navigation — it is a label, not a
* link — and whether it renders at all depends on machinery a tool result does
* not have. A receipt should read the same everywhere.
* @param title - the session's title, when it is known yet.
* @param sessionId - the session's id.
* @returns one line naming the session.
*/
function sessionReference(title, sessionId) {
	// Title reads hand back a snapshot, not a string; take the text either way so
	// a receipt can never print an object.
	const raw = typeof title === "object" && title !== null ? title.title : title;
	const label = typeof raw === "string" ? raw.trim() : "";
	return label === "" ? sessionId : `${label} · ${sessionId}`;
}
/**
* Ask before touching another session, except for the explicit full-access
* preset. Sandbox and approval are independent policies: `never` alone denies
* approval requests, it does not grant permission.
* @param ctx - services of the calling agent.
* @param exec - the running tool execution, including its cancellation signal.
* @param reason - what is about to happen, in the person's own terms.
* @throws when permission cannot be established or the request is not allowed.
*/
async function requireApproval(ctx, exec, reason) {
	const cancelled = () => {
		if (exec.signal?.aborted) throw new Error(`the tool was cancelled, so ${reason} was not done`);
	};
	cancelled();
	const approval = ctx.get("approval");
	const sandboxPolicy = ctx.get("sandboxPolicy");
	if (typeof approval?.overrideOf !== "function" || typeof approval?.request !== "function" || typeof sandboxPolicy?.resolve !== "function") {
		throw new Error(`this DSH cannot establish permission, so ${reason} was not done`);
	}
	const session = exec.agent.session;
	const mode = sandboxPolicy.resolve({ session })?.mode;
	const policy = approval.overrideOf(session) ?? approval.config?.policy ?? "ask";
	if (!["read-only", "workspace-write", "danger-full-access"].includes(mode) || !["ask", "never"].includes(policy)) {
		throw new Error(`this DSH cannot establish permission, so ${reason} was not done`);
	}
	cancelled();
	if (mode === "danger-full-access" && policy === "never") return;
	const outcome = await approval.request({
		agent: exec.agent,
		toolName: exec.name,
		callId: exec.callId,
		reason,
		signal: exec.signal
	});
	// A late answer must not revive a tool execution that has been cancelled.
	cancelled();
	if (outcome === "allowed-once") return;
	throw new Error(
		outcome === "rejected"
			? `the person declined: ${reason} was not done`
			: `no answer to the approval request, so ${reason} was not done (${outcome})`
	);
}
/**
* Give the new session the same model as this one: read the model the calling
* session is using, and fall back to the default when it has not chosen one.
*/
function currentSelection(ctx, agent) {
	const projections = ctx.get("sessionProjections");
	let inherited;
	if (projections !== void 0) try {
		const state = projections.stateOf(agent.session, "modelSelection");
		inherited = state?.pending ?? state?.lastUsed ?? void 0;
	} catch {}
	if (inherited !== void 0) return {
		provider: inherited.provider,
		model: inherited.model,
		...inherited.reasoningEffort === void 0 ? {} : { reasoningEffort: inherited.reasoningEffort }
	};
	const selected = ctx.agentDefaultModel.currentSelection();
	return {
		provider: selected.provider,
		model: selected.model
	};
}
/**
* Find the agent preset the new session should start on: the one this session
* uses, or the default preset when this session has none. A new session without
* a preset gets no tools, so it would sit in the list unable to do anything.
* @param ctx - services of the calling agent.
* @param agent - the calling agent.
* @param presets - the preset registry, when one is composed.
* @returns the preset id to use, or undefined when there is none.
*/
async function resolvePreset(ctx, agent, presets) {
	const projections = ctx.get("sessionProjections");
	if (projections !== void 0) try {
		const current = projections.stateOf(agent.session, "agentPreset");
		if (current !== void 0) return current;
	} catch {}
	if (presets === void 0) return void 0;
	try {
		return (await presets.resolve(void 0)).id;
	} catch {
		return void 0;
	}
}
/**
* Bound a wait request to a usable budget: a missing or nonsensical value falls
* back to the default, and the ceiling keeps one tool call from hanging a turn
* forever. A timeout is reported, never treated as an error.
* @param requested - the caller's requested budget in milliseconds, if any.
* @returns the budget actually used.
*/
function waitBudgetMs(requested) {
	const DEFAULT_MS = 60_000;
	const MAX_MS = 300_000;
	if (typeof requested !== "number" || !Number.isFinite(requested) || requested <= 0) return DEFAULT_MS;
	return Math.max(1, Math.min(Math.trunc(requested), MAX_MS));
}
/** Own only this observation: never forward its abort signal to a target agent. */
async function observeWait(requested, callerSignal, observe) {
	const startedAt = Date.now();
	const controller = new AbortController();
	const cleanups = new Set();
	const stopped = Promise.withResolvers();
	let status;
	const stop = (reason) => {
		if (status !== undefined) return;
		status = reason;
		stopped.resolve({ waitStatus: reason, completed: false });
		controller.abort();
	};
	const onAbort = () => stop("callerCancelled");
	let timer;
	try {
		callerSignal?.addEventListener("abort", onAbort, { once: true });
		if (callerSignal?.aborted) onAbort();
		else timer = setTimeout(() => stop("timedOut"), waitBudgetMs(requested));
		const result = await Promise.race([
			stopped.promise,
			(async () => {
				controller.signal.throwIfAborted();
				const value = await observe(controller.signal, (cleanup) => cleanups.add(cleanup));
				controller.signal.throwIfAborted();
				return { waitStatus: "completed", completed: true, ...value };
			})()
		]);
		return { ...result, elapsedMs: Date.now() - startedAt };
	} finally {
		clearTimeout(timer);
		callerSignal?.removeEventListener("abort", onAbort);
		// This also releases an outstanding polling timer or cancellable log read.
		controller.abort();
		await Promise.all([...cleanups].map(cleanup => cleanup()));
	}
}

/** Snapshot the delivery itself, including reentrant claims/removals in followup. */
function deliveredReceipt(agent, messageId) {
	try {
		const events = agent.session.snapshotEvents?.();
		if (events !== undefined) {
			const result = messageReceipt(foldReceipts(events, agent.session.inheritedEventCount), messageId, events);
			if (result.messageStatus !== "unknown") return result;
		}
		if ([agent.inbox?.nextTurn, agent.inbox?.nextStep].some(list => Array.isArray(list) && list.some(message => message.id === messageId))) return { messageStatus: "queued", completed: false };
	} catch {}
	return { messageStatus: "unknown", completed: false, attributionNote: "Delivery returned, but this host does not provide reliable message attribution." };
}

/** Read one exact message receipt. Quiet or a missing queue entry proves nothing. */
async function waitForReceipt(ctx, sessionId, messageId, signal, onCleanup, onProgress) {
	for (;;) {
		signal.throwIfAborted();
		const log = await readSessionLog(ctx, sessionId, signal, onCleanup);
		const target = ctx.agents.get(sessionId);
		const cached = log.session !== undefined && target?.session === log.session ? ctx.get?.("sessionProjections")?.stateOf?.(log.session, receiptProjectionKey) : undefined;
		const state = cached !== undefined && cached.seq === (log.events.at(-1)?.seq ?? -1) ? cached : foldReceipts(log.events, log.inheritedEventCount);
		let value = messageReceipt(state, messageId, log.events);
		// Pending live input is positive queue evidence even on a host without
		// durable inbox events. Its later disappearance will NEVER imply success.
		if (value.messageStatus === "unknown" && [target?.inbox?.nextTurn, target?.inbox?.nextStep].some(list => Array.isArray(list) && list.some(message => message.id === messageId))) {
			value = { messageStatus: "queued", completed: false };
		}
		if (target === undefined && ["queued", "delivered"].includes(value.messageStatus)) value = { ...value, attributionNote: "The saved message has no recorded turn result. This read does not resume the target." };
		onProgress(value);
		if (!["queued", "delivered"].includes(value.messageStatus) || target === undefined) return value;
		await delay(25, undefined, { signal });
	}
}

/** Preserve the last receipt state on timeout/caller cancellation, never its output. */
async function observeReceipt(ctx, sessionId, messageId, requested, callerSignal) {
	let latest = { messageStatus: "unknown", completed: false };
	const result = await observeWait(requested, callerSignal, (signal, onCleanup) =>
		waitForReceipt(ctx, sessionId, messageId, signal, onCleanup, value => { latest = value; }));
	if (result.waitStatus === "completed") return result;
	const { output, ...receipt } = latest;
	return { ...receipt, ...result };
}

const receiptProperties = {
	messageId: { type: "string" },
	messageStatus: { type: "string", enum: ["queued", "delivered", "turnCompleted", "discarded", "cancelled", "blocked", "failed", "interrupted", "incomplete", "unknown"] },
	turn: { type: "number" },
	turnEndKind: { type: "string" },
	attributionNote: { type: "string" },
	output: { type: "string" }
};

function receiptMeta(value) {
	return Object.fromEntries(["sessionId", "messageId", "messageStatus", "waitStatus", "turn", "turnEndKind", "attributionNote"].filter(key => value[key] !== undefined).map(key => [key, value[key]]));
}
const statusLabels = {
	queued: "已排队", delivered: "已交给目标", turnCompleted: "目标本轮结束（不等于任务成功）",
	discarded: "取消", cancelled: "取消", interrupted: "中断", failed: "失败",
	incomplete: "未完整结束", blocked: "未完整结束", unknown: "暂无法确认",
};
function receiptText(value) {
	const receipt = `Receipt: sessionId=${value.sessionId}, messageId=${value.messageId}`;
	const notice = waitNotice(value);
	return `${statusLabels[value.messageStatus] ?? "暂无法确认"}\n${receipt}` +
		(value.attributionNote ? `\n${value.attributionNote}` : "") + (notice ? `\n${notice}` : "") +
		(value.output === undefined ? "" : `\n${value.output}`);
}

/** A stopped observation says nothing about the target task's final outcome. */
function waitNotice(value) {
	if (value.waitStatus === "callerCancelled") return "Waiting cancelled by the caller; the target task was not cancelled.";
	if (value.waitStatus === "timedOut") return "Wait timed out; the target task was not cancelled. " + (value.messageId === undefined ? "Query this session overview again later." : "Query again with the same sessionId and messageId receipt; do not resend.");
	return undefined;
}

/** Read a live snapshot or a cancellable, read-only persistence handle. */
async function readSessionLog(ctx, sessionId, signal, onCleanup = () => {}) {
	signal?.throwIfAborted();
	const live = ctx.agents.get(sessionId);
	const own = typeof live?.session?.snapshotEvents === "function" ? live.session.snapshotEvents() : undefined;
	let log = own === undefined ? undefined : { events: own, inheritedEventCount: live.session.inheritedEventCount ?? 0, session: live.session };
	if (log === undefined) {
		const persistence = ctx.get("sessionPersistence");
		if (persistence !== undefined) {
			// rc.2 query.readSession has no cancellation argument. Own a read-only
			// persistence handle instead, never a resumed/writable target agent.
			const reader = await persistence.open(sessionId, "read", { signal });
			let closing;
			const close = () => closing ??= Promise.resolve().then(() => reader.close());
			onCleanup(close);
			try {
				signal?.throwIfAborted();
				log = { ...await reader.read(undefined, undefined, { signal }), inheritedEventCount: reader.inheritedEventCount ?? 0 };
			} finally {
				await close();
			}
		} else {
			const query = ctx.get("sessionQuery");
			if (query === undefined) throw new Error(`this DSH cannot read session ${JSON.stringify(sessionId)}`);
			// Compatibility with hosts exposing only the query service: the outer
			// observation remains bounded, but that service owns its read lifetime.
			log = await query.readSession(sessionId);
		}
		signal?.throwIfAborted();
	}
	return log;
}

/** Session-only overview, explicitly not a message result. */
async function readFinalAnswer(ctx, sessionId, signal, onCleanup) {
	const { events } = await readSessionLog(ctx, sessionId, signal, onCleanup);
	const texts = (content) => (content ?? []).filter((block) => block.type === "text").map((block) => block.text).join("");
	let answer;
	const accumulated = [];
	for (const event of events) {
		if (event.type !== "assistant/message") continue;
		const text = texts(event.data.message?.content);
		if (text.trim() !== "") answer = text;
		else accumulated.push(text);
	}
	const found = answer ?? (accumulated.length === 0 ? undefined : accumulated.join(""));
	return found === undefined || found.trim() === "" ? undefined : found;
}
/**
* Report what a session is doing right now: working, waiting, or put away. The
* archive set lives on the workspace registry and answers whether the person has
* hidden the session from the sidebar, so it needs no log read of its own.
* @param ctx - services of the calling agent.
* @param sessionId - the session to describe.
* @returns `"running"`, `"archived"`, or `"idle"`.
*/
function sessionState(ctx, sessionId) {
	if (ctx.get("workspaceRegistry")?.archivedSessionIds?.some((id) => String(id) === sessionId) === true) return "archived";
	return ctx.agents.get(sessionId)?.status === "running" ? "running" : "idle";
}
/** Pending resumes are shared by plugin instances using the same agent service. */
const targetResumes = new WeakMap();

function checkSendTarget(sessionId, header, callerAgent) {
	if (sessionId === String(callerAgent.id) || sessionId === String(callerAgent.session?.header.id)) throw new Error("session_send cannot send to its own session: use the current conversation instead");
	if ((header.delegationDepth ?? 0) > 0) throw new Error(`session_send cannot send to ${JSON.stringify(sessionId)}: that is a subagent session, not a regular one. Use send_message for it.`);
	if (typeof header.cwd !== "string" || header.cwd.trim() === "") throw new Error(`session_send cannot open ${JSON.stringify(sessionId)}: this saved session does not record a working directory, and reopening it needs one. Send to a session that has a directory, or ask the person to open that session once.`);
}

/** Read target metadata without opening a writable session or publishing an agent. */
async function inspectSendTarget(ctx, sessionId, exec) {
	exec.signal?.throwIfAborted();
	if (sessionId === String(exec.agent.id) || sessionId === String(exec.agent.session?.header.id)) throw new Error("session_send cannot send to its own session: use the current conversation instead");
	const live = ctx.agents.get(sessionId);
	if (live !== void 0) {
		checkSendTarget(sessionId, live.session.header, exec.agent);
		return { agent: live, header: live.session.header };
	}
	const query = ctx.get("sessionQuery");
	if (query === void 0) throw new Error(`session_send cannot open ${JSON.stringify(sessionId)}: this DSH does not offer session lookup`);
	let record;
	try {
		// listSessions owns and releases its read resources; no handle escapes.
		record = (await query.listSessions(exec.signal)).find((entry) => String(entry.header.id) === sessionId);
	} catch (error) {
		throw new Error(`session_send cannot read ${JSON.stringify(sessionId)}: ${error instanceof Error ? error.message : String(error)}`);
	}
	exec.signal?.throwIfAborted();
	if (record === void 0) throw new Error(`session_send cannot find session ${JSON.stringify(sessionId)}: no open or saved session has that id`);
	checkSendTarget(sessionId, record.header, exec.agent);
	return { header: record.header };
}

/** Recheck after approval, then serialize resumes so concurrent sends share one agent. */
async function resolveTargetAgent(ctx, sessionId, exec) {
	const agents = ctx.agents;
	// Cordis creates a fresh traced proxy on each service read. Its exported
	// original symbol gives stable identity; keep using the traced service for
	// method calls so ownership and caller context are still preserved.
	const serviceIdentity = agents[symbols.original] ?? agents;
	let pending = targetResumes.get(serviceIdentity);
	if (pending === void 0) targetResumes.set(serviceIdentity, pending = new Map());
	const previous = pending.get(sessionId);
	const operation = (async () => {
		// A failed/cancelled earlier sender must not invalidate this sender's grant.
		if (previous !== void 0) await previous.catch(() => {});
		const inspected = await inspectSendTarget(ctx, sessionId, exec);
		exec.signal?.throwIfAborted();
		// Another host caller may have published the agent during the metadata read.
		const live = agents.get(sessionId);
		if (live !== void 0) {
			checkSendTarget(sessionId, live.session.header, exec.agent);
			return live;
		}
		const agentPresets = ctx.get("agentPresets");
		const presetId = inspected.header.agentPreset;
		const setup = agentPresets === void 0 || presetId === void 0 ? void 0 : async (agentCtx) => {
			await agentPresets.mount(agentCtx, presetId);
		};
		const resumed = await agents.resume({
			resumeSessionId: sessionId,
			agentOptions: currentSelection(ctx, exec.agent),
			signal: exec.signal,
			...setup === void 0 ? {} : { setup }
		});
		return resumed.agent;
	})();
	pending.set(sessionId, operation);
	const release = () => {
		if (pending.get(sessionId) === operation) pending.delete(sessionId);
	};
	// Keep the queue slot until the actual operation settles, even if this
	// caller stops waiting. Otherwise a later sender could bypass an active resume.
	void operation.then(release, release);
	if (previous !== void 0 && exec.signal !== void 0) {
		const cancelled = Promise.withResolvers();
		const onAbort = () => cancelled.reject(exec.signal.reason);
		try {
			exec.signal.addEventListener("abort", onAbort, { once: true });
			if (exec.signal.aborted) onAbort();
			await Promise.race([previous.catch(() => {}), cancelled.promise]);
		} finally {
			exec.signal.removeEventListener("abort", onAbort);
		}
	}
	return await operation;
}
/**
* Register `session_create` and `session_send`.
* @param ctx - services of the agent this plugin was loaded for.
*/
function apply(ctx) {
	const permissions = communicationPermissions(ctx);
	ctx.inject(["typert", "connection"], scope => { scope.plugin(CommunicationRemote); });
	const inSlot = readSlots();
	const sortByActivity = createActivitySorter(ctx, inSlot);
	const listSessions = createSessionDiscovery(ctx, sortByActivity, inSlot, sessionState);
    ctx.tools.register(defineTool({
        name: "session_communication_status",
        description: "Read whether this session's send switch and a visible ordinary target's receive switch currently allow communication. Optional: use when you only want to check a known target, including whether it has reopened. This does not send, wake, subscribe, grant approval, or guarantee later delivery. Normal sends need no separate preflight; session_send always rechecks.",
        parameters: { sessionId: { type: "string", required: true, description: "Target ordinary session ID." } },
        output: {
            schema: { type: "object", additionalProperties: false, properties: {
                sessionId: { type: "string", required: true },
                communication: { ...communicationStatusSchema, required: true },
            } },
            render: (_args, value) => [{ type: "text", text: `${communicationStatusText(value.communication)}。仅为当前开关状态，不代表已投递，也不替代审批和其他发送限制；发送时仍会重检。` }],
        },
        async execute(args, exec) {
            const requested = args.sessionId.trim();
            let communication = unknownCommunication();
            try {
                const sourceId = trustedSource(exec);
                if (!requested || requested.length > 1024) return { sessionId: requested, communication };
                // Resolve visibility before reading permissions: arbitrary IDs must
                // never reveal defaults or records outside the host's catalog.
                const query = ctx.get("sessionQuery");
                if (!query) return { sessionId: requested, communication };
                const record = (await query.listSessions(exec.signal)).find(row =>
                    String(row.header.id) === requested && (row.header.delegationDepth ?? 0) <= 0 && row.header.origin !== "subagent");
                exec.signal?.throwIfAborted();
                if (!record) return { sessionId: requested, communication };
                // Read switch state only. cwd/self and other delivery restrictions
                // remain session_send concerns, just as for list_sessions rows.
                [communication] = await permissions.statuses(sourceId, [requested]);
            } catch {
                exec.signal?.throwIfAborted();
            }
            return { sessionId: requested, communication };
        },
    }));
	// Optional capability; the same pure fold also works over a read-only full log.
	if (typeof ctx.inject === "function") ctx.inject(["sessionProjections"], scope => {
		scope.sessionProjections.register(receiptProjection);
	});
	ctx.tools.register(defineTool({
		name: "session_create",
		description: "Start a new chat session the person can see in the session list. The new session runs its own first turn and keeps going on its own; this call returns as soon as it exists. Pass workspacePath to put it under that workspace, or leave it out to leave it ungrouped. Use this when the work deserves its own session the person can open and continue; use a subagent instead when the work should stay inside this conversation.",
		parameters: {
			prompt: {
				type: "string",
				required: true,
				description: "The new session's first task, delivered with plugin provenance. Write it self-contained: the new session cannot see this conversation."
			},
			workspacePath: {
				type: "string",
				description: "Full path of a workspace that already exists (for example \"E:\\\\Users\\\\Ryuu\\\\Desktop\"). Leave it out to leave the new session ungrouped. This tool never creates a workspace, so an unknown path fails with the list of existing ones."
			},
			title: {
				type: "string",
				description: "Optional fixed title. If omitted or blank, derive it once from the prompt using the host's public normalization and truncation rules (first 5 whitespace-delimited words, at most 40 UTF-8 bytes). No extra model call; later messages do not automatically rename it. The person can still rename it manually."
			},
			wait: {
				type: "boolean",
				description: "Wait for the first message's recorded turn to end before returning. Defaults to false; bounded by timeoutMs."
			},
			timeoutMs: {
				type: "number",
				description: "Wait budget in milliseconds. Defaults to 60000, at most 300000. Timeout or caller cancellation only ends this wait."
			}
		},
		output: {
			schema: {
				type: "object",
				additionalProperties: false,
				properties: {
					sessionId: {
						type: "string",
						required: true
					},
					grouped: {
						type: "boolean",
						required: true
					},
					cwd: {
						type: "string",
						required: true
					},
					workspaceId: { type: "string" },
					workspacePath: { type: "string" },
					title: { type: "string" },
					waited: { type: "boolean" },
					completed: { type: "boolean" },
					waitStatus: { type: "string", enum: ["completed", "timedOut", "callerCancelled"] },
					elapsedMs: { type: "number" },
					...receiptProperties
				}
			},
			// rc.2 persists this projection on tool/result and exposes it as
			// ToolResultNode.meta. The canonical value alone does not survive replay.
			presentationMeta: (_args, value) => ({
				sessionId: value.sessionId,
				...receiptMeta(value),
				...typeof value.title === "string" ? { title: value.title } : {}
			}),
			// Keep the receipt readable for clients without the session card.
			render: (_args, value) => [{
				type: "text",
				text: (value.grouped === true
					? `Created session: ${sessionReference(value.title, value.sessionId)} in workspace ${value.workspacePath}`
					: `Created session: ${sessionReference(value.title, value.sessionId)} (ungrouped)`) + `\n${receiptText(value)}`
			}]
		},
		async execute(args, exec) {
			if (exec.agent === void 0) throw new Error("session_create must run inside a session");
			const sourceId = trustedSource(exec);
			await permissions.check(sourceId);
			const prompt = args.prompt.trim();
			if (prompt === "") throw new Error("session_create needs a prompt: it becomes the new session's first user message");
			let workspace;
			let cwd;
			if (args.workspacePath !== void 0) {
				const requested = args.workspacePath.trim();
				if (!isAbsolute(requested)) throw new Error(`session_create needs a full workspace path, got ${JSON.stringify(args.workspacePath)}`);
				workspace = await ctx.workspaceRegistry.resolveByPath(requested);
				if (workspace === void 0) {
					throw new Error(`session_create cannot use ${JSON.stringify(requested)}: no workspace has that path, and this tool does not create workspaces. Existing workspaces: ${workspaceCatalogue(ctx.workspaceRegistry)}. Use one of those paths, or leave workspacePath out to create the session under Ungrouped.`);
				}
				cwd = workspace.path;
			} else {
				cwd = exec.agent.session.header.cwd;
				if (cwd === void 0) throw new Error("session_create needs a working directory, and this session has none");
			}
			// Ask before creating anything: a session that appears in the person's
			// list without them knowing about it is the whole risk of this tool.
			const where = workspace === void 0 ? "ungrouped" : `in workspace ${JSON.stringify(workspace.path)}`;
			await permissions.check(sourceId);
			await requireApproval(ctx, exec, `create a new session ${where}, starting with: ${prompt.slice(0, 120)}`);
			await permissions.check(sourceId);
			const agentOptions = currentSelection(ctx, exec.agent);
			const agentPresets = ctx.get("agentPresets");
			const presetId = await resolvePreset(ctx, exec.agent, agentPresets);
			exec.signal?.throwIfAborted();
			const sessionId = brandString(`session-${randomUUID()}`);
			let handle;
			let attached = false;
			let sent;
			try {
				handle = await ctx.agents.create({
					signal: exec.signal,
					sessionId,
					agentOptions,
					meta: {
						cwd,
						parentSession: String(exec.agent.session.header.id),
						...presetId === void 0 ? {} : { agentPreset: presetId }
					},
					...agentPresets === void 0 || presetId === void 0 ? {} : { setup: async (agentCtx) => {
						await agentPresets.mount(agentCtx, presetId);
					} }
				});
				exec.signal?.throwIfAborted();
				if (workspace !== void 0) {
					await workspace.attachSession(sessionId);
					attached = true;
				}
				exec.signal?.throwIfAborted();
				const title = args.title?.trim() || fallbackSessionTitle(prompt, fallbackTitleWords, fallbackTitleBytes);
				// The public rename operation logs and pins the initial title. It
				// does not change the first message's plugin provenance below.
				ctx.sessionTitle.rename(handle.agent.session, title);
				exec.signal?.throwIfAborted();
				sent = createUserMessage({
					content: [{
						type: "text",
						text: prompt
					}],
					source: {
						kind: name,
						form: "relay"
					}
				});
				await permissions.admit(sourceId, String(sessionId), exec, () => handle.agent.followup(sent));
			} catch (error) {
				if (attached) try {
					await workspace.detachSession(sessionId);
				} catch {}
				if (handle !== void 0) try {
					await handle.dispose();
				} catch {}
				throw error;
			}
			// Once delivered, the target owns its lifetime. Ending this observation
			// must not detach its workspace or dispose its handle.
			const waited = args.wait === true ? await observeReceipt(ctx, String(sessionId), sent.id, args.timeoutMs, exec.signal) : undefined;
			// Read the accepted title after host normalization (or a manual rename).
			let currentTitle;
			try {
				// The service returns a title snapshot; the text lives on `.title`.
				currentTitle = ctx.sessionTitle.get(handle.agent.session)?.title;
			} catch {}
			return {
				sessionId: String(sessionId),
				messageId: sent.id,
				...waited === undefined ? deliveredReceipt(handle.agent, sent.id) : { waited: true, ...waited },
				grouped: workspace !== void 0,
				cwd,
				...currentTitle === void 0 || currentTitle === "" ? {} : { title: String(currentTitle) },
				...workspace === void 0 ? {} : {
					workspaceId: String(workspace.id),
					workspacePath: workspace.path
				}
			};
		}
	}));
	ctx.tools.register(defineTool({
		name: "session_send",
		description: "Send a message to an existing chat session so that session continues on its own — including one this session started earlier. It cannot send to itself, cannot send to a subagent the agent spawned (use send_message for those), and never rewrites past messages. Sending returns right away; the target handles the message when it can.",
		parameters: {
			sessionId: {
				type: "string",
				required: true,
				description: "Target Session id, for example \"session-2330bd36-fe62-4621-8d42-c7e04566f447\"."
			},
			message: {
				type: "string",
				required: true,
				description: "Message text. Write it self-contained: the target cannot see this conversation unless the person linked the two."
			},
			wait: {
				type: "boolean",
				description: "Wait for the target to finish working on this message before returning, and report its answer. Defaults to false: sending returns as soon as the target accepts the message. Waiting is bounded by timeoutMs."
			},
			timeoutMs: {
				type: "number",
				description: "How long to observe this receipt when wait is true, in milliseconds. Defaults to 60000, at most 300000. Timeout never proves success or failure and never resends or cancels the target."
			}
		},
		output: {
			schema: {
				type: "object",
				additionalProperties: false,
				properties: {
					sessionId: {
						type: "string",
						required: true
					},
					cwd: {
						type: "string",
						required: true
					},
					waited: { type: "boolean" },
					completed: { type: "boolean" },
					waitStatus: { type: "string", enum: ["completed", "timedOut", "callerCancelled"] },
					elapsedMs: { type: "number" },
					...receiptProperties
				}
			},
			presentationMeta: (_args, value) => receiptMeta(value),
			render: (_args, value) => [{
				type: "text",
				text: receiptText(value)
			}]
		},
		async execute(args, exec) {
			if (exec.agent === void 0) throw new Error("session_send must run inside a session");
			const sourceId = trustedSource(exec);
			const requested = args.sessionId.trim();
			if (requested === "") throw new Error("session_send needs a session id");
			const message = args.message.trim();
			if (message === "") throw new Error("session_send needs a message");
			await permissions.check(sourceId, requested);
			await inspectSendTarget(ctx, requested, exec);
			await permissions.check(sourceId, requested);
			await requireApproval(ctx, exec, `send a message into session ${JSON.stringify(requested)}: ${message.slice(0, 120)}`);
			await permissions.check(sourceId, requested);
			const target = await resolveTargetAgent(ctx, requested, exec);
			exec.signal?.throwIfAborted();
			const targetId = String(target.id);
			if (targetId !== requested) throw new Error("session_send resolved a different target; no message was sent");
			checkSendTarget(targetId, target.session.header, exec.agent);
			const sent = createUserMessage({
				content: [{
					type: "text",
					text: message
				}],
				source: {
					kind: name,
					form: "relay"
				}
			});
			await permissions.admit(sourceId, targetId, exec, () => target.followup(sent));
			if (args.wait !== true) return {
				sessionId: targetId,
				messageId: sent.id,
				...deliveredReceipt(target, sent.id),
				cwd: String(target.session.header.cwd ?? "")
			};
			const result = await observeReceipt(ctx, targetId, sent.id, args.timeoutMs, exec.signal);
			return {
				sessionId: targetId,
				messageId: sent.id,
				cwd: String(target.session.header.cwd ?? ""),
				waited: true,
				...result
			};
		}
	}));
	ctx.tools.register(defineTool({
		name: "list_sessions",
		description: "List the sessions the person can see, most recent conversation activity first, with each id and current state (working, waiting, or put away). New input, model output/attempts, execution starts and non-recovery turn endings count. Bare step/tool completion, title-only changes and recovery do not advance activity. Sessions without conversation activity use creation time; ties keep the host's order. Use it before session_send when the target is described by name rather than by id. Each row includes a fresh caller-to-target communication-switch snapshot, not approval or a delivery guarantee; never cache it as permission to send.",
		parameters: {
			titleQuery: { type: "string", description: "Literal title substring, NFC/whitespace normalized and case-insensitive; at most 1024 UTF-8 bytes. Applied before limit. A failed title read fails the complete query." },
			workspaceId: { type: "string", description: "Existing workspace ID (at most 256 UTF-8 bytes); mutually exclusive with workspacePath. Uses actual workspace membership." },
			workspacePath: { type: "string", description: "Absolute path of an existing registered workspace (at most 4096 UTF-8 bytes); mutually exclusive with workspaceId." },
			cursor: { type: "string", description: "Opaque nextCursor from this caller's previous page. Omit filters to inherit them; explicit filters must match. Expires after 5 minutes; no cursor starts a fresh query." },
			limit: {
				type: "number",
				description: "How many sessions to list, most recently active first. Defaults to 20, capped at 100. May change between pages."
			}
		},
		output: {
			schema: {
				type: "object",
				additionalProperties: false,
				properties: {
					sessions: {
						type: "array",
						required: true,
						items: {
							type: "object",
							additionalProperties: false,
							properties: {
								sessionId: {
									type: "string",
									required: true
								},
								title: { type: "string" },
								cwd: { type: "string" },
								state: {
									type: "string",
									required: true,
									enum: ["running", "idle", "archived"],
									description: "What the session is doing right now: running (working on a turn), idle (open or saved, not working), archived (put away from the sidebar)."
								},
								current: { type: "boolean" },
								subagent: { type: "boolean" },
                                communication: { ...communicationStatusSchema, required: true }
							}
						}
					},
					matchedTotal: { type: "number", required: true, description: "Ordinary sessions matching the initial successful scan, before limit; frozen across pages." },
					nextCursor: { type: "string" },
					resultSetCreatedAt: { type: "number", description: "Result set creation time in Unix milliseconds; not an atomic database snapshot." },
					resultSetExpiresAt: { type: "number", description: "Fixed expiration time in Unix milliseconds." },
					paginationUnavailable: { type: "string" },
					workspaceId: { type: "string" },
					workspacePath: { type: "string" },
					total: {
						type: "number",
						required: true
					}
				}
			},
			render: (_args, value) => [{
				type: "text",
				text: value.sessions.length === 0
					? "No matching sessions."
					: [
						value.sessions.map((entry) => [
							sessionReference(entry.title, entry.sessionId),
							entry.current === true ? "(this session)" : undefined,
							entry.subagent === true ? "(subagent)" : undefined,
							entry.state === "running" ? "(working now)" : undefined,
							entry.state === "archived" ? "(put away)" : undefined,
							entry.cwd,
                                communicationStatusText(entry.communication)
						].filter((part) => part !== undefined).join("  ·  ")).join("\n"),
						"通信状态仅为当前开关快照，不替代审批或其他发送限制；发送时仍重检。",
						value.sessions.some((entry) => entry.state === "archived") ? "Sessions marked (put away) are archived: they are hidden from the sidebar but still listed here." : undefined,
						value.nextCursor ? `More matching sessions: use nextCursor ${value.nextCursor} before ${new Date(value.resultSetExpiresAt).toISOString()}.` : undefined,
						value.paginationUnavailable
					].filter((part) => part !== undefined).join("\n")
			}]
		},
		execute: listSessions
	}));
	ctx.tools.register(defineTool({
		name: "session_wait",
		description: "Query a delivery receipt using sessionId and messageId from session_send or session_create. Wait for that message's recorded turn, never a later answer. Omitting messageId returns a session overview, not a message result. Read-only: never resumes, resends, changes, or interrupts the target.",
		parameters: {
			sessionId: {
				type: "string",
				required: true,
				description: "Target Session id, for example \"session-2330bd36-fe62-4621-8d42-c7e04566f447\"."
			},
			messageId: {
				type: "string",
				description: "The exact messageId returned with sessionId by session_send or session_create, including after timeout. Omit only for a session overview."
			},
			timeoutMs: {
				type: "number",
				description: "How long to wait, in milliseconds. Defaults to 60000, at most 300000. A timeout reports that the session is still working rather than failing."
			}
		},
		output: {
			schema: {
				type: "object",
				additionalProperties: false,
				properties: {
					sessionId: {
						type: "string",
						required: true
					},
					running: {
						type: "boolean",
						required: true
					},
					completed: {
						type: "boolean",
						required: true
					},
					waitStatus: { type: "string", enum: ["completed", "timedOut", "callerCancelled"] },
					elapsedMs: { type: "number" },
					scope: { type: "string", enum: ["message", "sessionOverview"] },
					...receiptProperties
				}
			},
			presentationMeta: (_args, value) => ({ ...receiptMeta(value), scope: value.scope }),
			render: (_args, value) => [{
				type: "text",
				text: value.scope === "message" ? receiptText(value) :
					`Session overview for ${value.sessionId} (not a message result): ` +
					(waitNotice(value) ?? (value.running ? "running" : "idle")) +
					(value.output === undefined ? "" : `\nLatest session answer, not attributed to any receipt:\n${value.output}`)
			}]
		},
		async execute(args, exec) {
			const requested = args.sessionId.trim();
			if (requested === "") throw new Error("session_wait needs a session id");
			if (exec.agent !== void 0 && requested === String(exec.agent.id)) throw new Error("session_wait cannot wait on its own session: that would wait for the answer it is writing");
			const target = ctx.agents.get(requested);
			if (args.messageId !== undefined) {
				const messageId = args.messageId.trim();
				if (messageId === "") throw new Error("session_wait needs a non-empty messageId, or omit it for a session overview");
				const result = await observeReceipt(ctx, requested, messageId, args.timeoutMs, exec.signal);
				return {
					sessionId: requested, messageId, scope: "message", running: ctx.agents.get(requested)?.status === "running",
					...result
				};
			}

			const result = await observeWait(args.timeoutMs, exec.signal, async (signal, onCleanup) => {
				if (target === undefined) {
					const query = ctx.get("sessionQuery");
					if (query === undefined) throw new Error(`session_wait cannot check ${JSON.stringify(requested)}: this DSH does not offer session lookup`);
					const known = (await query.listSessions(signal)).some(entry => String(entry.header.id) === requested);
					signal.throwIfAborted();
					if (!known) throw new Error(`session_wait cannot find session ${JSON.stringify(requested)}: no open or saved session has that id`);
				} else await target.whenIdle();
				signal.throwIfAborted();
				const answer = await readFinalAnswer(ctx, requested, signal, onCleanup);
				return answer === undefined ? {} : { output: answer };
			});
			return {
				sessionId: requested,
				scope: "sessionOverview",
				running: target?.status === "running",
				...result
			};
		}
	}));
}
export { Config, apply, inject, name };
