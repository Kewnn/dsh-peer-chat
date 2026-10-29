/**
 * Browser half: render the `session_create` tool card as something the person
 * can act on. The host half persists an explicit target in presentationMeta;
 * this half uses that durable identity, never an id guessed from the receipt.
 *
 * Loaded by the browser module table as a CJS closure factory; `require` resolves
 * only platform seeds and other registered bundles.
 */
window.__ModuleLoader__.load({
	id: "@ryuu-64/dsh-session-tools",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });

		const react = require("react");
		const { MenuItemButton, Modal, Button, Switch, ReferenceIconRegular } = require("@deepseek-ai/dsh-client-ui-primitives");

		/** Slots this client half needs before it can register anything. */
		const inject = ["slots", "sessions"];

		/**
		* Flatten a settled result's content blocks, mirroring how `ui-tool` reads
		* them: text blocks verbatim, anything else as JSON.
		* @param node - a candidate settled result node.
		* @returns the flattened text, or "" when this is not a result node.
		*/
		function resultText(node) {
			if (node === null || typeof node !== "object" || !Array.isArray(node.content)) return "";
			return node.content
				.map((part) => (part !== null && typeof part === "object" && part.type === "text" && typeof part.text === "string"
					? part.text
					: JSON.stringify(part)))
				.join("\n");
		}

		/**
		* Read only the successful ToolResultNode's durable presentation metadata.
		* rc.2 projects event.data.meta here; canonical value is not persisted.
		* Old receipts cannot prove identity, even when only one id is visible.
		* @param block - the running or settled tool call block handed to the slot.
		* @returns the session id and optional title, or undefined.
		*/
		function readCreatedSession(block) {
			if (block === null || typeof block !== "object" || block.kind !== "tool-result" || block.isError !== false) return undefined;
			const meta = block.meta;
			if (meta === null || typeof meta !== "object" || Array.isArray(meta)) return undefined;
			if (typeof meta.sessionId !== "string" || !/^session-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u.test(meta.sessionId)) return undefined;
			return { sessionId: meta.sessionId, title: typeof meta.title === "string" ? meta.title : undefined };
		}

		/**
		* One row for a finished `session_create` call: what was created, and a
		* button that opens it in the conversation area.
		* @param props - slot owner props plus the injected `openSession`.
		* @returns the row element.
		*/
		function SessionCreateRow(props) {
			const openSession = props.openSession ?? props.slot?.injected?.openSession;
			const created = readCreatedSession(props.block);
			if (created === undefined) {
				// Keep errors and legacy receipts readable, without claiming a
				// successful creation or inventing a clickable navigation target.
				const text = resultText(props.block);
				const fallback = props.block?.kind === "tool-result" ? "没有可用的会话创建结果" : "正在创建会话…";
				return react.createElement("div", { style: { whiteSpace: "pre-wrap", overflowWrap: "anywhere" } }, text || fallback);
			}
			const title = created.title === undefined || created.title === "" ? "会话" : created.title;
			const canOpen = typeof openSession === "function";
			const onOpen = () => {
				if (!canOpen) return;
				try {
					openSession(created.sessionId);
				} catch (error) {
					console.error("[session-tools] opening the session failed:", error);
				}
			};
			return react.createElement(
				"div",
				{
					style: {
						display: "flex",
						alignItems: "center",
						gap: "8px",
						flexWrap: "wrap",
						fontSize: "13px",
					},
				},
				react.createElement("span", null, "已创建会话"),
				react.createElement(
					"button",
					{
						type: "button",
						onClick: onOpen,
						disabled: !canOpen,
						title: created.sessionId,
						style: {
							border: "1px solid var(--dsh-border, #3a4150)",
							background: "transparent",
							color: "inherit",
							borderRadius: "999px",
							padding: "1px 10px",
							cursor: canOpen ? "pointer" : "default",
							font: "inherit",
							opacity: canOpen ? "1" : "0.55",
						},
					},
					title,
				),
				react.createElement("span", { style: { opacity: 0.55, fontFamily: "ui-monospace, monospace", fontSize: "11px" } }, created.sessionId),
				react.createElement("div", { style: { flexBasis: "100%" } }, react.createElement(MessageStateRow, { block: props.block })),
			);
		}


		const statusLabels = {
			queued: "已排队", delivered: "已交给目标", turnCompleted: "目标本轮结束（不等于任务成功）",
			discarded: "取消", cancelled: "取消", interrupted: "中断", failed: "失败", incomplete: "未完整结束",
			blocked: "未完整结束", unknown: "暂无法确认",
		};
		function MessageStateRow({ block }) {
			const text = resultText(block);
			if (block?.kind !== "tool-result") return react.createElement("span", { role: "status" }, "正在处理…");
			const meta = block.meta;
			if (block.isError || meta?.scope === "sessionOverview" || typeof meta?.messageId !== "string") {
				return react.createElement("div", { style: { whiteSpace: "pre-wrap", overflowWrap: "anywhere" } }, text || "暂无法确认");
			}
			return react.createElement("div", { style: { display: "grid", gap: 6 } },
				react.createElement("strong", null, statusLabels[meta.messageStatus] ?? "暂无法确认"),
				meta.waitStatus === "timedOut" && react.createElement("div", null, "等待超时。没有重发，也没有取消；请用同一消息编号继续查询。"),
				meta.waitStatus === "callerCancelled" && react.createElement("div", null, "已停止等待，目标会话继续处理。"),
				react.createElement("details", null, react.createElement("summary", null, "消息编号与结果详情"),
					react.createElement("div", { style: { whiteSpace: "pre-wrap", overflowWrap: "anywhere", color: "var(--dsw-alias-label-secondary)" } }, text)));
		}
		const remoteContribution = (() => {
			// TypertSchema requires parse(value); keep these strict schemas local to
			// this browser bundle because Zod is not a platform module seed.
			const scalar = check => value => {
				if (!check(value)) throw new TypeError("Invalid session communication field");
				return value;
			};
			const object = fields => ({ parse(value) {
				if (!value || typeof value !== "object" || Array.isArray(value)
					|| Object.keys(value).some(key => !Object.hasOwn(fields, key))
					|| Object.keys(fields).some(key => !Object.hasOwn(value, key))) {
					throw new TypeError("Invalid session communication object");
				}
				return Object.fromEntries(Object.entries(fields).map(([key, parse]) => [key, parse(value[key])]));
			} });
			const sessionId = scalar(value => typeof value === "string" && value.length >= 1 && value.length <= 1024);
			const boolean = scalar(value => typeof value === "boolean");
			const revision = scalar(value => Number.isSafeInteger(value) && value >= 0);
			const getSchema = object({ sessionId });
			const setSchema = object({ sessionId, send: boolean, receive: boolean, expectedRevision: revision });
			const recordSchema = object({ send: boolean, receive: boolean, revision });
			const setResultSchema = object({ status: scalar(value => value === "saved" || value === "conflict"), current: value => recordSchema.parse(value) });
			return {
				package: "@ryuu-64/dsh-session-tools",
				descriptors: ["get", "set"].map(method => ({
					id: `@ryuu-64/dsh-session-tools:sessionCommunication.${method}`,
					service: "sessionCommunication", namespace: "sessionCommunication", method,
					invocation: { kind: "direct" },
					parameters: [{ name: "request", wire: "request", source: "json", codec: {
						mode: "strict", typeSymbol: `@ryuu-64/dsh-session-tools:sessionCommunication.${method}:request`,
						create: () => method === "get" ? getSchema : setSchema,
					} }],
					result: {
						mode: "strict", typeSymbol: `@ryuu-64/dsh-session-tools:sessionCommunication.${method}:result`,
						create: () => method === "get" ? recordSchema : setResultSchema,
					},
				})),
			};
		})();
		function validRecord(value) {
			return value && typeof value.send === "boolean" && typeof value.receive === "boolean" && Number.isSafeInteger(value.revision) && value.revision >= 0;
		}
		// One authoritative cache per client, shared by every pane and the menu.
		// Other windows are reconciled by bounded polling and focus/visibility reads.
		function createCommunicationStore() {
			let api;
			const entries = new Map();
			const entryFor = id => {
				if (!entries.has(id)) entries.set(id, { listeners: new Set(), active: 0, token: 0, reading: false, saving: false,
					value: { record: null, busy: false, failed: false, notice: "正在读取设置…" } });
				return entries.get(id);
			};
			const publish = (entry, patch) => {
				entry.value = { ...entry.value, ...patch };
				entry.listeners.forEach(listener => listener());
			};
			const read = async (id, verifyPending = false) => {
				const entry = entryFor(id);
				if (!api || entry.reading || (entry.saving && !verifyPending)) return;
				entry.reading = true;
				if (!entry.value.record) publish(entry, { busy: true });
				const token = ++entry.token;
				let timer;
				try {
					const result = await Promise.race([api.get({ sessionId: id }), new Promise((_, reject) => {
						timer = setTimeout(() => reject(new Error("read timeout")), 12000);
					})]);
					if (token !== entry.token) return;
					if (!result.ok || !validRecord(result.value)) throw new Error("unavailable");
					if (entry.value.record && result.value.revision < entry.value.record.revision) return;
					const changed = entry.value.record && result.value.revision !== entry.value.record.revision;
					publish(entry, { record: result.value, failed: changed ? false : !!entry.value.record && entry.value.failed,
						notice: entry.saving ? "已读取当前设置，保存请求仍未结束；暂不能再次更改。" : changed ? "设置已在其他页面更改，已同步最新状态。" : entry.value.record ? entry.value.notice : "已读取最新设置。更改后立即生效。" });
				} catch {
					if (token === entry.token) publish(entry, { record: null, failed: true, notice: "状态未知，暂时无法读取设置。请重试。" });
				} finally {
					clearTimeout(timer); entry.reading = false;
					if (token === entry.token) publish(entry, { busy: entry.saving });
					if (!entry.listeners.size && !entry.saving) entries.delete(id);
				}
			};
			const change = async (id, key, next) => {
				const entry = entryFor(id), record = entry.value.record;
				if (!api || !record || entry.saving) return;
				const owner = api;
				entry.saving = true; ++entry.token;
				publish(entry, { busy: true, failed: false, notice: "正在保存…" });
				// A timeout cannot cancel an accepted write. Keep the write lock until
				// it settles; never replay it or offer a misleading rollback.
				let timedOut = false, staleResponse = false;
				const timer = setTimeout(() => {
					if (api !== owner) return;
					timedOut = true;
					publish(entry, { record: null, failed: true, notice: "保存结果尚未确认，仍在等待。不会重复提交；关闭面板不会取消更改。" });
					void read(id, true);
				}, 12000);
				try {
					const result = await owner.set({ sessionId: id, send: record.send, receive: record.receive, [key]: next, expectedRevision: record.revision });
					if (api !== owner) return;
					if (!result.ok || !validRecord(result.value?.current) || !["saved", "conflict"].includes(result.value?.status)) throw new Error("unconfirmed");
					if (entry.value.record && result.value.current.revision < entry.value.record.revision) { staleResponse = true; return; }
					publish(entry, { record: result.value.current, failed: result.value.status === "conflict",
						notice: result.value.status === "saved" ? "已保存，立即生效。" : "设置已在其他页面更改。已显示最新设置，请确认后再操作。" });
				} catch {
					if (api !== owner) return;
					publish(entry, { record: null, failed: true, notice: "保存结果暂无法确认，正在重新读取；不会自动重复保存。" });
				} finally {
					clearTimeout(timer); ++entry.token; entry.saving = false; publish(entry, { busy: false });
					if (api !== owner || timedOut || staleResponse || !entry.value.record) void read(id);
					else if (!entry.listeners.size && !entry.reading) entries.delete(id);
				}
			};
			const refresh = () => { if (document.visibilityState === "hidden") return; for (const [id, entry] of entries) if (entry.active) void read(id); };
			return {
				connect(value) {
					api = value; refresh();
					return () => {
						if (api !== value) return;
						api = undefined;
						for (const entry of entries.values()) {
							++entry.token;
							publish(entry, { record: null, busy: entry.saving, failed: true, notice: "连接已断开，状态未知。恢复连接后会重新读取。" });
						}
					};
				},
				get: id => entryFor(id).value, read, change,
				subscribe(id, listener, active) {
					const entry = entryFor(id); entry.listeners.add(listener);
					if (active) entry.active++;
					if (active && entry.active === 1) {
						entry.timer = setInterval(() => { if (document.visibilityState !== "hidden") void read(id); }, 3000);
						window.addEventListener("focus", refresh);
						document.addEventListener("visibilitychange", refresh);
					}
					if (active) void read(id);
					return () => {
						entry.listeners.delete(listener);
						if (active) entry.active--;
						if (!entry.active) clearInterval(entry.timer);
						if (![...entries.values()].some(item => item.active)) {
							window.removeEventListener("focus", refresh); document.removeEventListener("visibilitychange", refresh);
						}
						if (!entry.listeners.size && !entry.reading && !entry.saving) entries.delete(id);
					};
				},
			};
		}
		function CommunicationControls({ sessionId, store, compact = false, visible = true }) {
			const subscribe = react.useCallback(listener => store.subscribe(sessionId, listener, visible), [store, sessionId, visible]);
			const snapshot = react.useCallback(() => store.get(sessionId), [store, sessionId]);
			const { record, busy, failed, notice } = react.useSyncExternalStore(subscribe, snapshot);
			react.useEffect(() => { if (visible) void store.read(sessionId); }, [store, sessionId, visible]);
			const row = (key, label, description) => react.createElement("div", { key, style: { display: "flex", alignItems: "center", justifyContent: "space-between", gap: compact ? 8 : 24, padding: compact ? "10px 0" : "16px 0", borderBottom: "0.5px solid var(--dsw-alias-border-l2)" } },
				react.createElement("div", { title: description, style: { flex: 1, minWidth: 0, fontSize: compact ? 13 : 14, lineHeight: "20px", color: "var(--dsw-alias-label-primary)" } }, label,
					!compact && react.createElement("div", { style: { marginTop: 4, fontSize: 12, lineHeight: "18px", color: "var(--dsw-alias-label-secondary)" } }, description)),
				react.createElement("span", { "aria-hidden": true, style: { flexShrink: 0, color: "var(--dsw-alias-label-secondary)", fontSize: 12 } }, record ? record[key] ? "开启" : "关闭" : "未知"),
				record && react.createElement(Switch, { checked: record[key], onChange: value => void store.change(sessionId, key, value), label, disabled: busy }));
			return react.createElement("section", { "aria-label": "会话通信", "aria-busy": busy, "data-communication-session": sessionId, style: { padding: compact ? "0 6px 12px" : 0, minWidth: 0 } },
				row("receive", "接收其他会话消息", "关闭会拒绝新的插件消息：未送达、未排队；已接收消息继续处理。"),
				row("send", "向其他会话发送", "也控制创建带首条消息的新会话。"),
				(!compact || record?.receive === false) && react.createElement("p", { style: { color: "var(--dsw-alias-label-secondary)", fontSize: 12, lineHeight: "18px" } }, "仅控制本插件的新消息。关闭接收后，新消息未送达、未排队；已经接收的消息继续处理，历史仍可查看。"),
				react.createElement("div", { role: failed ? "alert" : "status", "aria-live": "polite", style: { marginTop: 8, fontSize: 12, lineHeight: "18px", color: failed ? "var(--dsw-alias-state-error-primary)" : "var(--dsw-alias-label-secondary)" } }, notice),
				!record && !busy && react.createElement(Button, { variant: "outline", onClick: () => void store.read(sessionId) }, "重新读取"));
		}
		function CommunicationForm({ request, store, close }) {
			return react.createElement(Modal, { open: true, onClose: close, closeLabel: "关闭", title: "会话通信", description: request.title || request.sessionId,
				footer: react.createElement(Button, { variant: "outline", onClick: close }, "关闭"),
			}, react.createElement(CommunicationControls, { sessionId: request.sessionId, store }));
		}
		/** Direct ordinary children from the public, durable host catalog.
		 * The client controller maps header.parentSession to summary.parentId.
		 * Never infer lineage from workspace, title or message text. Native
		 * subagents keep their existing catalog and continuation semantics.
		 */
		function RelatedConversationRows({ sessionId, useSessions, useWorkspaces, openSession }) {
			const catalog = useSessions(state => state);
			const workspaces = useWorkspaces(state => state);
			const [expandedSession, setExpandedSession] = react.useState(null);
			const expanded = expandedSession === sessionId;
			const scrollRegion = react.useRef(null);
			const firstAdded = react.useRef(null);
			const expansion = react.useRef(null);
			react.useLayoutEffect(() => {
				const pending = expansion.current, region = scrollRegion.current;
				if (!expanded || !pending || !region) return;
				expansion.current = null;
				region.scrollTop = pending.scrollTop;
				if (pending.keyboard && firstAdded.current) {
					firstAdded.current.focus({ preventScroll: true });
					const item = firstAdded.current.getBoundingClientRect(), bounds = region.getBoundingClientRect();
					if (item.height > bounds.height) region.scrollTop += item.top - bounds.top;
					else if (item.bottom > bounds.bottom) region.scrollTop += item.bottom - bounds.bottom;
					else if (item.top < bounds.top) region.scrollTop -= bounds.top - item.top;
				}
			}, [expanded]);
			// Identity order is stable across activity/title updates and remounts.
			const children = catalog.ids.map(id => catalog.byId[id]).filter(row =>
				row && row.id !== sessionId && row.parentId === sessionId && row.origin !== "subagent" && !workspaces.archivedSessionIds.includes(row.id))
				.sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
			const parentId = catalog.byId[sessionId]?.parentId;
			const parent = parentId && parentId !== sessionId ? catalog.byId[parentId] : null;
			const workspaceOf = id => workspaces.items.find(item => item.sessionIds.includes(id));
			const currentWorkspace = workspaceOf(sessionId);
			const titleOf = row => row.title?.trim() ? row.title : row.id;
			const visible = expanded ? children : children.slice(0, 3);
			const listId = "session-tools-children-" + sessionId;
			if ((!parentId || parentId === sessionId) && children.length === 0) return react.createElement("p", { style: { margin: 8, color: "var(--dsw-alias-label-secondary)", fontSize: 13 } }, "当前对话还没有相关对话。");
			return react.createElement("section", {
				"aria-label": "相关对话", ref: scrollRegion,
				style: { padding: "4px 6px 6px", minWidth: 0, minHeight: 0, overflowY: "auto" },
			},
				parentId && parentId !== sessionId ? react.createElement(Button, {
					variant: "ghost", disabled: workspaces.archivedSessionIds.includes(parentId), onClick: () => openSession(parentId),
					style: { width: "100%", justifyContent: "flex-start", height: "auto", padding: "6px 8px", textAlign: "left", whiteSpace: "normal", overflowWrap: "anywhere" },
				}, (workspaces.archivedSessionIds.includes(parentId) ? "父对话已归档 · " : "返回父对话 · ") + (parent ? titleOf(parent) : parentId)) : null,
				children.length ? react.createElement(react.Fragment, null,
					react.createElement("div", { style: { padding: "2px 8px", fontSize: 12, lineHeight: "18px", color: "var(--dsw-alias-label-secondary)" } }, "创建的对话 · " + children.length),
					react.createElement("div", { id: listId }, visible.map((child, index) => {
						const workspace = workspaceOf(child.id);
						const crossWorkspace = workspaces.phase === "ready" && workspaces.state !== "error" && workspace?.workspaceId !== currentWorkspace?.workspaceId;
						return react.createElement(Button, {
							key: child.id, ref: index === 3 ? firstAdded : undefined, variant: "ghost", title: child.id, onClick: () => openSession(child.id),
							style: { width: "100%", display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12, padding: "6px 8px", height: "auto", minWidth: 0, textAlign: "left" },
						},
							react.createElement("span", { style: { minWidth: 0, overflowWrap: "anywhere", whiteSpace: "normal", fontSize: 13, lineHeight: "20px" } },
								titleOf(child),
								crossWorkspace ? react.createElement("span", { style: { display: "block", fontSize: 11, color: "var(--dsw-alias-label-secondary)" } }, "跨工作区 · " + (workspace?.title || workspace?.path || "未分组")) : null),
							react.createElement("span", { style: { flexShrink: 0, color: "var(--dsw-alias-label-secondary)", fontSize: 12 } }, child.running === true ? "运行中" : child.running === false ? "空闲" : "状态未知"));
					})),
					children.length > 3 ? react.createElement(Button, {
						variant: "ghost", "aria-expanded": expanded, "aria-controls": listId,
						onClick: event => {
							expansion.current = expanded ? null : { keyboard: event.detail === 0, scrollTop: scrollRegion.current?.scrollTop || 0 };
							setExpandedSession(expanded ? null : sessionId);
						},
						style: { width: "100%", fontSize: 12, height: "auto", padding: "6px 8px" },
					}, expanded ? "收起列表" : "展开更多（" + (children.length - 3) + "）") : null) : null);
		}

        const RELATIONS_TAB = "@ryuu-64/dsh-session-tools/relations";
        const RELATIONS_KIND = "session-tools.relations";
        // Only the automatic first reveal is plugin-owned. All pane geometry,
        // collapse, movement, docking and layout persistence belong to DSH.
        function hasRelations(sessionId, catalog, workspaces) {
            const archived = workspaces.archivedSessionIds;
            const parentId = catalog.byId[sessionId]?.parentId;
            return (!!parentId && parentId !== sessionId && !!catalog.byId[parentId] && !archived.includes(parentId)) ||
                catalog.ids.some(id => {
                    const row = catalog.byId[id];
                    return row && id !== sessionId && row.parentId === sessionId && row.origin !== "subagent" && !archived.includes(id);
                });
        }
        function RelationsTab(props) {
            const { tab } = props.useTabInfo();
            react.useLayoutEffect(() => {
                props.visibility.set(tab.id, tab.visible);
                return () => props.visibility.delete(tab.id);
            }, [props.visibility, tab.id, tab.visible]);
            return react.createElement("div", {
                "data-session-tools-tab": props.sessionId,
                style: { height: "100%", minHeight: 0, overflow: "auto", padding: 8, boxSizing: "border-box" },
            }, react.createElement(CommunicationControls, { key: props.sessionId, sessionId: props.sessionId, store: props.communication, compact: true, visible: tab.visible }),
                react.createElement(RelatedConversationRows, { ...props, key: tab.id }));
        }
        function RelationsEntry(props) {
            const catalog = props.useSessions(state => state);
            const workspaces = props.useWorkspaces(state => state);
            const mounted = react.useSyncExternalStore(props.sidebar?.mounted.subscribe ?? (() => () => {}), props.sidebar?.mounted.getSnapshot ?? (() => undefined));
            const available = workspaces.phase === "ready" && hasRelations(props.sessionId, catalog, workspaces);
            react.useEffect(() => {
                if (!props.sidebar || !available || mounted !== props.sessionId || props.wasShown(props.sessionId)) return;
                // This is synchronous and rechecks the host's owner before opening.
                // Record success only after the native tab actually exists.
                props.reveal(props.sessionId, true);
            }, [available, mounted, props.sessionId, props.reveal, props.wasShown]);
            if (!props.sessionId) return null;
            return react.createElement(Button, {
                variant: "ghost", size: "sm", title: props.sidebar ? "会话通信与相关对话" : "会话工具不可用：宿主未提供会话工具停靠接口", "aria-label": props.sidebar ? "会话通信与相关对话" : "会话工具不可用：宿主未提供会话工具停靠接口", disabled: !props.sidebar,
                style: { flex: "none", width: 28, padding: 0, color: "var(--dsw-alias-label-secondary)" },
                onClick: () => props.reveal(props.sessionId, false),
            }, react.createElement(ReferenceIconRegular, { kind: "session", size: 16 }));
        }
		function registerCommunicationUI(ctx, store) {
			let request = null;
			const listeners = new Set();
			const publish = value => { request = value; for (const listener of listeners) listener(); };
			const subscribe = listener => { listeners.add(listener); return () => listeners.delete(listener); };
			function Overlay() {
				const current = react.useSyncExternalStore(subscribe, () => request);
				return current ? react.createElement(CommunicationForm, { key: current.sessionId, request: current, store, close: () => publish(null) }) : null;
			}
			ctx.slots.inject("shell.overlay", () => ctx.slots.register({ name: "shell.overlay", id: "session-tools.communication" }, Overlay));
			ctx.slots.inject("sidebar.workspaces.session.menu.item", () => ctx.slots.register({ name: "sidebar.workspaces.session.menu.item", id: "session-tools.communication", order: 350 },
				({ sessionId, displayTitle, useMenuOpenState }) => {
					const [, setMenuOpen] = useMenuOpenState();
					return react.createElement(MenuItemButton, { onSelect: () => { setMenuOpen(false); publish({ sessionId, title: displayTitle }); } }, "会话通信…");
				}));
		}

		/**
		* Wait for the tool view slot list to exist, then register a keyed row that
		* replaces the default card for `session_create`.
		* @param ctx - the browser plugin context.
		*/
		function apply(ctx) {
            const communication = createCommunicationStore();
			ctx.inject(["remote"], async scope => {
				try {
					await scope.remote.$mount(remoteContribution);
					scope.inject(["remote.sessionCommunication"], ui => {
						ui.effect(() => communication.connect(ui.remote.sessionCommunication));
                        registerCommunicationUI(ui, communication);
					});
				} catch(error) { console.error("[session-tools] communication UI initialization failed", error); throw error; }
			});
			ctx.slots.inject("tool.call.toolview", function* () {
				for (const key of ["session_send", "session_wait"]) yield ctx.slots.register({ name: "tool.call.toolview", key }, MessageStateRow);
			});
			const register = (scope, openSession) => {
                let capabilities = {};
                const listeners = new Set();
                const subscribe = listener => { listeners.add(listener); return () => listeners.delete(listener); };
                const snapshot = () => capabilities;
                scope.slots.inject("conversation.session.header.utilities", () => scope.slots.register({
                    name: "conversation.session.header.utilities", id: "session-tools.relations",
                }, props => react.createElement(RelationsEntry, { ...props, ...react.useSyncExternalStore(subscribe, snapshot) })));
                scope.inject(["sidebarRight", "sidebarRightTabs"], ui => {
                    const sidebar = ui.sidebarRight;
                    if (!["openTab", "tabsIn", "focus"].every(key => typeof sidebar[key] === "function") || typeof sidebar.mounted?.getSnapshot !== "function" || typeof sidebar.mounted?.subscribe !== "function" || typeof sidebar.tabDomain?.occurrence !== "function" || typeof ui.sidebarRightTabs.register !== "function") return;
                    const shown = new Set(), visibility = new Map();
                    const storageKey = id => "dsh-session-tools:relations-shown:" + id;
                    const wasShown = id => {
                        if (shown.has(id)) return true;
                        try { return localStorage.getItem(storageKey(id)) === "1"; } catch { return false; }
                    };
                    const markShown = id => {
                        shown.add(id);
                        try { localStorage.setItem(storageKey(id), "1"); } catch { /* In-memory suppression still respects a close this run. */ }
                    };
                    const reveal = (id, automatic) => {
                        if (ui.sidebarRight.mounted.getSnapshot() !== id) return;
                        const existing = ui.sidebarRight.tabsIn(id).find(tab => tab.kind === RELATIONS_KIND);
                        if (existing) {
                            // A restored layout must keep the user's selected tab and collapsed state.
                            if (!automatic) {
                                const occurrence = sidebar.tabDomain.occurrence(id, { id: existing.id });
                                if (typeof sidebar.revealOccurrence === "function") sidebar.revealOccurrence(occurrence);
                                else if (visibility.get(existing.id)) sidebar.focus(existing.id);
                                else occurrence.tabActions.openTab(RELATIONS_KIND);
                            }
                        } else ui.sidebarRight.openTab(RELATIONS_KIND);
                        if (ui.sidebarRight.tabsIn(id).some(tab => tab.kind === RELATIONS_KIND)) markShown(id);
                    };
                    ui.effect(() => ui.sidebarRightTabs.register({
                        id: RELATIONS_TAB, kind: RELATIONS_KIND, keepMounted: true,
                        title: () => "会话",
                    }));
                    ui.slots.inject("sidebar.right.pane.tab", () => ui.slots.register({
                        name: "sidebar.right.pane.tab", key: RELATIONS_TAB, inject: () => ({ openSession, visibility, communication }),
                    }, RelationsTab));
                    ui.effect(() => {
                        capabilities = { sidebar, reveal, wasShown };
                        listeners.forEach(listener => listener());
                        return () => { capabilities = {}; listeners.forEach(listener => listener()); };
                    });
                });
				return scope.slots.inject("tool.call.toolview", () => scope.slots.register(
				{
					name: "tool.call.toolview",
					key: "session_create",
					inject: () => ({ openSession }),
				},
				SessionCreateRow,
			));
			};
			// Pre-0.2 hosts put UI selection on sessions. In 0.2 the Session
			// Controller only owns data/references; UIWorkspace owns mainView
			// retention, selection, panel reveal and release. Do not retain a
			// second reference here or await a history load before navigating.
			if (typeof ctx.sessions.open === "function") {
				register(ctx, (sessionId) => ctx.sessions.open(sessionId));
			} else {
				// Package client.inject is not a startup-order guarantee. Wait for
				// the actual service and bind the row to that service's lifetime.
				ctx.inject(["uiWorkspace"], (scope) => register(scope,
					(sessionId) => scope.uiWorkspace.openSession(sessionId)));
			}
		}

		exports.apply = apply;
		exports.inject = inject;
		return module.exports;
	},
});
