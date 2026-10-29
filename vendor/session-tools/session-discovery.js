import { createHmac, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { isAbsolute } from "node:path";
import { symbols } from "@deepseek-ai/cordis";
import { communicationPermissions, trustedSource, unknownCommunication } from "./communication-permissions.js";

// Resource guards, not measured throughput promises. No event/log/Agent is retained.
const TTL = 5 * 60_000;
const MAX_SETS = 16;
const MAX_SET_IDS = 10_000;
const MAX_IDS = 50_000;
const MAX_BYTES = 8 * 1024 * 1024;
const TITLE_BATCH_IDS = 64;
const identity = service => service?.[symbols.original] ?? service;
const ordinary = ({ header }) => (header.delegationDepth ?? 0) <= 0 && header.origin !== "subagent";
const normalizeTitle = value => value.normalize("NFC").trim().replace(/\s+/gu, " ").toLowerCase();
const fail = message => new Error(`list_sessions: ${message}`);

function optionalText(value, name, bytes) {
	if (value === undefined) return undefined;
	if (typeof value !== "string" || !value.trim() || Buffer.byteLength(value) > bytes) {
		throw fail(`${name} must be a nonempty string of at most ${bytes} UTF-8 bytes`);
	}
	return value;
}
function filters(args) {
	const title = optionalText(args.titleQuery, "titleQuery", 1024);
	const workspaceId = optionalText(args.workspaceId, "workspaceId", 256);
	const workspacePath = optionalText(args.workspacePath, "workspacePath", 4096);
	if (workspaceId !== undefined && workspacePath !== undefined) throw fail("workspaceId and workspacePath are mutually exclusive");
	if (workspacePath !== undefined && !isAbsolute(workspacePath)) throw fail("workspacePath must be absolute");
	return { titleQuery: title === undefined ? undefined : normalizeTitle(title), workspaceId, workspacePath };
}

/** One plugin instance owns these short-lived result sets. Tokens never authorize a read. */
export function createSessionDiscovery(ctx, sortByActivity, inSlot, sessionState) {
	const sets = new Map();
	const key = randomBytes(32);
	let sources;
	let disposed = false;
	let count = 0, bytes = 0, expiryTimer;
	const remove = id => {
		const set = sets.get(id);
		if (!set) return;
		count -= set.rows.length; bytes -= set.bytes; sets.delete(id);
	};
	const clear = () => { clearTimeout(expiryTimer); expiryTimer = undefined; sets.clear(); count = 0; bytes = 0; };
	ctx.on?.("dispose", () => { disposed = true; clear(); });
	const services = () => ["sessionQuery", "sessionPersistence", "workspaceRegistry", "sessions"].map(name => identity(ctx.get(name))).concat(identity(ctx.agents));
	const equalSources = (a, b) => a.length === b.length && a.every((value, i) => value === b[i]);
	const sweep = () => { for (const [id, set] of sets) if (Date.now() >= set.expiresAt) remove(id); };
	const scheduleExpiry = () => {
		clearTimeout(expiryTimer);
		expiryTimer = undefined;
		if (!sets.size) return;
		const expiresAt = Math.min(...Array.from(sets.values(), set => set.expiresAt));
		expiryTimer = setTimeout(() => { sweep(); scheduleExpiry(); }, Math.max(1, expiresAt - Date.now()));
		expiryTimer.unref();
	};
	function token(id, offset) {
		const body = Buffer.from(JSON.stringify([id, offset])).toString("base64url");
		return `${body}.${createHmac("sha256", key).update(body).digest("base64url")}`;
	}
	function decode(value) {
		optionalText(value, "cursor", 512);
		try {
			const [body, signature, extra] = value.split(".");
			if (extra !== undefined) throw Error();
			const expected = createHmac("sha256", key).update(body).digest();
			const actual = Buffer.from(signature, "base64url");
			if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) throw Error();
			const [id, offset] = JSON.parse(Buffer.from(body, "base64url").toString());
			if (typeof id !== "string" || !Number.isSafeInteger(offset) || offset < 1) throw Error();
			return { id, offset };
		} catch { throw fail("invalid cursor; start a new query without cursor"); }
	}
	async function workspace(filter, signal) {
		if (filter.workspaceId === undefined && filter.workspacePath === undefined) return undefined;
		const registry = ctx.get("workspaceRegistry");
		let result;
		if (filter.workspaceId !== undefined) {
			if (typeof registry?.get !== "function") throw fail("this host cannot look up workspace IDs");
			result = registry.get(filter.workspaceId);
		} else {
			if (typeof registry?.resolveByPath !== "function") throw fail("this host cannot resolve workspace paths");
			try { result = await registry.resolveByPath(filter.workspacePath); }
			catch (cause) { throw fail(`workspacePath could not be resolved (${cause.message}); use an existing registered workspace`); }
		}
		signal?.throwIfAborted();
		if (!result) throw fail("workspace is not registered; use an existing workspace ID or path");
		return { id: String(result.id), path: String(result.path), ids: new Set(result.sessionIds.map(String)) };
	}
	async function matchingTitles(query, records, text, signal) {
		if (typeof query.readTitleSnapshots !== "function") throw fail("titleQuery needs the host's readTitleSnapshots API");
		const titles = new Map();
		for (let start = 0; start < records.length; start += TITLE_BATCH_IDS) {
			const ids = records.slice(start, start + TITLE_BATCH_IDS).map(record => String(record.header.id));
			// One corpus listing per batch. Reserve all permits atomically so no other
			// plugin activity/title read overlaps this batch. The provider owns its
			// internal concurrency (default 4); at most 64 requested IDs can be active.
			const result = await inSlot(() => query.readTitleSnapshots(ids, signal), signal, 4);
			signal?.throwIfAborted();
			if (!Array.isArray(result) || result.length !== ids.length) throw fail("incomplete title batch; no complete matching result is available");
			for (let index = 0; index < ids.length; index++) {
				const id = ids[index], observation = result[index];
				if (observation?.sessionId !== id || observation.status !== "fulfilled" || String(observation.value?.session?.id) !== id) {
					throw fail(`could not read the title of ${id}; no complete matching result is available`);
				}
				// The same read may observe a newer header than the directory scan.
				if (!ordinary({ header: observation.value.session })) throw fail("session visibility changed during title scan; start a new query");
				const title = observation.value.title?.title;
				if (title !== undefined && typeof title !== "string") throw fail(`invalid title snapshot for ${id}`);
				if (title !== undefined && normalizeTitle(title).includes(text)) titles.set(id, title);
			}
		}
		return titles;
	}
	return async (args, exec) => {
		exec.signal?.throwIfAborted();
		if (disposed) throw fail("plugin was unloaded; start a new query");
		const currentSources = services();
		if (sources && !equalSources(sources, currentSources)) clear();
		sources = currentSources;
		sweep();
		const query = ctx.get("sessionQuery");
		if (query === undefined) throw fail("needs session lookup, which this DSH does not offer");
		if (args.limit !== undefined && (typeof args.limit !== "number" || !Number.isFinite(args.limit))) throw fail("limit must be a finite number");
		const limit = Math.max(1, Math.min(100, Math.trunc(args.limit ?? 20)));
		// Agent.id is the existing public tool-execution identity; arguments cannot supply it.
		const owner = typeof exec.agent?.id === "string" && exec.agent.id ? exec.agent.id : undefined;
		let filter = filters(args), set, offset = 0, setId;
		if (args.cursor !== undefined) {
			({ id: setId, offset } = decode(args.cursor));
			set = sets.get(setId);
			if (!set) throw fail("cursor expired, was evicted, or belongs to another plugin/host; start a new query without cursor");
			if (!owner || owner !== set.owner) throw fail("cursor belongs to a different calling session");
			if (offset >= set.rows.length) throw fail("invalid cursor offset");
			if (filter.titleQuery !== undefined && filter.titleQuery !== set.filter.titleQuery) throw fail("cursor titleQuery does not match its original query");
			filter = { ...set.filter, ...(filter.workspaceId !== undefined || filter.workspacePath !== undefined ? { workspaceId: filter.workspaceId, workspacePath: filter.workspacePath } : {}) };
		}
		const selected = await workspace(filter, exec.signal);
		if (set && (selected?.id !== set.workspaceId || selected?.path !== set.workspacePath)) throw fail("cursor workspace does not match its original query");
		const records = await query.listSessions(exec.signal);
		exec.signal?.throwIfAborted();
		sortByActivity.prune(records);
		let candidates = records.filter(record => ordinary(record) && (!selected || selected.ids.has(String(record.header.id))));
		const byId = new Map(candidates.map(record => [String(record.header.id), record]));
		if (set) {
			// Recheck the entire frozen range, not just the requested slice. Never silently skip.
			if (set.rows.some(row => !byId.has(row.id))) {
				remove(setId);
				throw fail("result set contains a session no longer visible or in this workspace; start a new query");
			}
		} else {
			if ((owner || filter.titleQuery !== undefined) && candidates.length > MAX_SET_IDS) throw fail(`candidate set exceeds ${MAX_SET_IDS} sessions; narrow the workspace filter`);
			const titles = filter.titleQuery === undefined ? undefined : await matchingTitles(query, candidates, filter.titleQuery, exec.signal);
			if (titles) candidates = candidates.filter(record => titles.has(String(record.header.id)));
			const ordered = await sortByActivity(candidates, exec.signal, records);
			const rows = ordered.map(record => ({ id: String(record.header.id), ...(titles ? { title: titles.get(String(record.header.id)) } : {}) }));
			set = { owner, filter: { titleQuery: filter.titleQuery, workspaceId: selected?.id }, rows, workspaceId: selected?.id, workspacePath: selected?.path, createdAt: Date.now() };
			set.expiresAt = set.createdAt + TTL;
			set.bytes = Buffer.byteLength(JSON.stringify(set));
			if (owner && rows.length > limit && set.bytes > MAX_BYTES) throw fail("result set exceeds the 8 MiB metadata budget; narrow the query");
		}
		const page = set.rows.slice(offset, offset + limit);
        let communication;
        try {
            communication = await communicationPermissions(ctx).statuses(trustedSource(exec), page.map(row => row.id));
        } catch {
            communication = page.map(() => unknownCommunication());
        }
        exec.signal?.throwIfAborted();
		const listed = [];
		for (const [pageIndex, row] of page.entries()) {
			exec.signal?.throwIfAborted();
			const header = byId.get(row.id).header;
			let title = row.title;
			if (set.filter.titleQuery === undefined) try {
				// Legacy no-query listing keeps best-effort titles and reads only this page.
				title = (await inSlot(() => query.readTitle(row.id, exec.signal), exec.signal))?.title;
			} catch {}
			exec.signal?.throwIfAborted();
			listed.push({ sessionId: row.id, communication: communication[pageIndex],
				...title === undefined || title === "" ? {} : { title: String(title) },
				...header.cwd === undefined ? {} : { cwd: String(header.cwd) },
				state: sessionState(ctx, row.id), ...row.id === owner ? { current: true } : {},
			});
		}
		exec.signal?.throwIfAborted();
		if (disposed) throw fail("plugin was unloaded; start a new query");
		const hasMore = offset + listed.length < set.rows.length;
		if (setId || (hasMore && owner)) {
			if (!equalSources(currentSources, services())) { clear(); throw fail("host services changed; start a new query"); }
			if (Date.now() >= set.expiresAt) { if (setId) remove(setId); throw fail("cursor expired while reading; start a new query"); }
			if (!setId) {
				sweep();
				while (sets.size >= MAX_SETS || count + set.rows.length > MAX_IDS || bytes + set.bytes > MAX_BYTES) remove(sets.keys().next().value);
				setId = randomUUID(); count += set.rows.length; bytes += set.bytes;
			} else {
				// An overlapping call may have evicted this set while this page was read.
				if (sets.get(setId) !== set) throw fail("cursor was evicted while reading; start a new query");
				sets.delete(setId);
			}
			sets.set(setId, set);
			scheduleExpiry();
		}
		return { sessions: listed, total: records.length, matchedTotal: set.rows.length,
			...(setId ? { resultSetCreatedAt: set.createdAt, resultSetExpiresAt: set.expiresAt,
				...(hasMore ? { nextCursor: token(setId, offset + listed.length) } : {}) } : {}),
			...(hasMore && !owner ? { paginationUnavailable: "A calling Agent identity is required to continue; run list_sessions through the host tool runtime." } : {}),
			...(selected ? { workspaceId: selected.id, workspacePath: selected.path } : {}),
		};
	};
}
