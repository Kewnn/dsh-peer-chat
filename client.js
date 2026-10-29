/**
 * dsh-peer-chat 浏览器半侧：左下角侧栏入口 + 面板（对端 / 模式 / 链路编辑器）。
 * 数据与写入都走宿主的 GET/POST /dsh-peer-chat-api。
 * 注册 id 必须等于 loader entry id（dsh-peer-chat），否则 ModuleLoader 会拒绝。
 */
window.__ModuleLoader__.load({
  id: 'dsh-peer-chat',
  factory: (require) => {
    var module = { exports: {} }
    var exports = module.exports
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' })

    const React = require('react')
    const h = React.createElement

    let open = false
    const listeners = new Set()
    const subscribe = (fn) => { listeners.add(fn); return () => listeners.delete(fn) }
    const setOpen = (value) => { open = value; for (const fn of listeners) fn(open) }
    const useOpen = () => {
      const [value, setValue] = React.useState(open)
      React.useEffect(() => subscribe(setValue), [])
      return value
    }

    const S = {
      wrap: { display: 'flex', flexDirection: 'column', gap: 14, fontSize: 13, color: 'var(--dsw-alias-label-primary, #ddd)' },
      head: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8 },
      title: { fontSize: 13, fontWeight: 600 },
      group: { display: 'flex', flexDirection: 'column', gap: 8 },
      label: { fontSize: 11, letterSpacing: '.04em', textTransform: 'uppercase', color: 'var(--dsw-alias-label-secondary, #999)' },
      row: { display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' },
      mono: { fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace', fontSize: 12 },
      muted: { color: 'var(--dsw-alias-label-secondary, #999)', fontSize: 12 },
      err: { color: 'var(--dsw-alias-label-danger, #e66)', fontSize: 12 },
      ok: { color: 'var(--dsw-alias-label-success, #6c6)', fontSize: 12 },
      input: {
        background: 'var(--dsw-alias-bg-layer-2, #2a2a2a)',
        color: 'var(--dsw-alias-label-primary, #ddd)',
        border: '1px solid var(--dsw-alias-border-l1, #444)',
        borderRadius: 8,
        padding: '4px 8px',
        fontSize: 12,
      },
      btn: {
        background: 'var(--dsw-alias-bg-layer-2, #2a2a2a)',
        color: 'var(--dsw-alias-label-primary, #ddd)',
        border: '1px solid var(--dsw-alias-border-l1, #444)',
        borderRadius: 8,
        padding: '4px 12px',
        fontSize: 12,
        cursor: 'pointer',
      },
      chip: { padding: '2px 8px', borderRadius: 999, border: '1px solid var(--dsw-alias-border-l1, #444)', fontSize: 12, whiteSpace: 'nowrap' },
      backdrop: { position: 'fixed', inset: 0, background: 'rgba(0,0,0,.45)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 2147483000 },
      dialog: { width: 'min(820px, 94vw)', maxHeight: '84vh', overflow: 'auto', background: 'var(--dsw-alias-bg-layer-1, #1d1d1d)', color: 'var(--dsw-alias-label-primary, #ddd)', border: '1px solid var(--dsw-alias-border-l1, #444)', borderRadius: 12, padding: 18, boxShadow: '0 18px 48px rgba(0,0,0,.35)' },
      sidebarBtn: { display: 'flex', alignItems: 'center', gap: 8, width: '100%', background: 'transparent', border: 'none', color: 'var(--dsw-alias-label-secondary, #aaa)', fontSize: 12, padding: '6px 8px', borderRadius: 8, cursor: 'pointer', textAlign: 'left' },
    }

    const chip = (text, key) => h('span', { key, style: S.chip }, text)

    /** 消息列的可选项：不用再手打 {input}/{prev}。 */
    const MESSAGE_TOKENS = [
      { value: '__auto__', label: '自动（按模式）' },
      { value: '{input}', label: '入口 {input}' },
      { value: '{prev}', label: '上一步 {prev}' },
      { value: '{input} + {prev}', label: '入口 + 上一步' },
      { value: '__custom__', label: '自定义…' },
    ]

    /** 一个下拉选择器。 */
    function Select(props) {
      return h('select', {
        value: props.value,
        style: { ...S.input, minWidth: props.width || 150 },
        onChange: (event) => props.onChange(event.target.value),
        'aria-label': props.label,
      }, props.options.map((option) => h('option', { key: option.value, value: option.value }, option.label)))
    }

    function ChainEditor(props) {
      const { peers, modes, onSaved } = props
      const [name, setName] = React.useState('')
      const [rows, setRows] = React.useState([{ peer: 'self', mode: '', message: '__auto__', enabled: true, manualMode: false }])
      const [runInput, setRunInput] = React.useState('')
      const [message, setMessage] = React.useState('')
      const [error, setError] = React.useState('')
      const [saving, setSaving] = React.useState(false)

      const peerOptions = peers.map((peer) => ({
        value: peer.name,
        label: peer.name === 'self'
          ? 'self ·（本端 / 跨会话）'
          : peer.url === '' ? `${peer.name}（同实例）` : `${peer.name} · ${peer.url.replace(/^https?:\/\//, '')}`,
      }))
      const [modesByPeer, setModesByPeer] = React.useState({})
      const [modeSource, setModeSource] = React.useState({})

      React.useEffect(() => {
        if (!Array.isArray(modes) || modes.length === 0) return
        setModesByPeer((prev) => (Array.isArray(prev.self) && prev.self.length > 0 ? prev : { ...prev, self: modes }))
      }, [modes])

      const requestSeq = React.useRef({})
      const loadPeerModes = React.useCallback(async (peer) => {
        if (peer === '' || peer === undefined || modesByPeer[peer] !== undefined) return
        const seq = (requestSeq.current[peer] ?? 0) + 1
        requestSeq.current[peer] = seq
        setModeSource((prev) => ({ ...prev, [peer]: '读取对端模式…' }))
        try {
          const res = await fetch(`/dsh-peer-chat-api?peer=${encodeURIComponent(peer)}`, { cache: 'no-store' })
          const json = await res.json()
          if (requestSeq.current[peer] !== seq) return
          if (!json || json.ok !== true) throw new Error((json && json.error) || '读取失败')
          setModesByPeer((prev) => ({ ...prev, [peer]: json.modes || [] }))
          setModeSource((prev) => ({ ...prev, [peer]: `${json.source}：${(json.modes || []).length} 个模式` }))
        } catch (failure) {
          if (requestSeq.current[peer] !== seq) return
          setModesByPeer((prev) => ({ ...prev, [peer]: modes }))
          setModeSource((prev) => ({ ...prev, [peer]: `读不到对端模式，用本机清单（${String((failure && failure.message) || failure)}）` }))
        }
      }, [modes, modesByPeer])

      const listFor = (peer) => {
        const fetched = modesByPeer[peer]
        if (Array.isArray(fetched) && fetched.length > 0) return fetched
        return Array.isArray(modes) ? modes : []
      }

      const modeOptionsFor = (peer) => [{ value: '', label: '（对端默认）' }].concat(
        listFor(peer).map((mode) => ({ value: mode.id, label: `${mode.isDefault ? '★ ' : ''}${mode.id}` })),
      )

      const update = (index, patch) => setRows((prev) => prev.map((row, i) => (i === index ? { ...row, ...patch } : row)))
      const addRow = () => setRows((prev) => {
        const last = prev.at(-1)
        return [...prev, { peer: last?.peer ?? 'self', mode: '', message: '__auto__', enabled: true, manualMode: last?.manualMode ?? false }]
      })
      const removeRow = (index) => setRows((prev) => (prev.length <= 1 ? prev : prev.filter((_, i) => i !== index)))

      const save = async (thenRun) => {
        setSaving(true)
        setError('')
        setMessage('')
        try {
          if (name.trim() === '') throw new Error('给链路起个名字')
          const steps = rows
            .filter((row) => row.enabled && row.peer !== '')
            .map((row) => ({
              peer: row.peer,
              ...(row.message === '__auto__' || row.message.trim() === ''
                ? {}
                : { message: row.message.trim() }),
              ...(row.mode === '' ? {} : { mode: row.mode }),
            }))
          if (steps.length === 0) throw new Error('至少勾选一个对端')
          const res = await fetch('/dsh-peer-chat-api', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ action: 'save-chain', name: name.trim(), chain: { steps } }),
          })
          const json = await res.json()
          if (!json || json.ok !== true) throw new Error((json && json.error) || '保存失败')
          setMessage(`已保存：${name.trim()}（${steps.length} 步）`)
          setName('')
          setRows([{ peer: 'self', mode: '', message: '__auto__', enabled: true, manualMode: false }])
          if (onSaved) onSaved(json)
          if (thenRun && typeof props.onRun === 'function') props.onRun(name.trim(), runInput)
        } catch (failure) {
          setError(String((failure && failure.message) || failure))
        } finally {
          setSaving(false)
        }
      }

      return h('div', { style: S.group },
        h('div', { style: S.label }, '新建链路（A → B → C → D）'),
        h('div', { style: S.row },
          h('input', {
            style: { ...S.input, minWidth: 180 },
            placeholder: '链路名，例如 write-then-review',
            value: name,
            onChange: (event) => setName(event.target.value),
          }),
          h('button', { style: S.btn, onClick: addRow }, '+ 加一行'),
          h('input', {
            style: { ...S.input, minWidth: 170 },
            placeholder: '本次发送的 {input}（可留空）',
            value: runInput,
            onChange: (event) => setRunInput(event.target.value),
          }),
          h('button', { style: S.btn, onClick: () => save(false), disabled: saving }, saving ? '保存中…' : '保存链路'),
          h('button', { style: S.btn, onClick: () => save(true), disabled: saving }, '保存并发送'),
          h('button', {
            style: { ...S.btn, fontWeight: 600 },
            disabled: saving,
            title: '不走链路：把这条内容发给第一个目标；填了模式就按该模式新建会话再发',
            onClick: async () => {
              const first = rows.find((row) => row.enabled && row.peer !== '') ?? rows[0]
              const rowText = first && first.message !== '__auto__' ? String(first.message ?? '').trim() : ''
              // 顶部输入优先；没填就用第一行写的消息内容
              const text = ((runInput ?? '').trim() || rowText)
              if (text === '') { setError('先写要发送的内容（顶部输入框或第一行的消息内容）'); return }
              setSaving(true); setError(''); setMessage('')
              try {
                const res = await fetch('/dsh-peer-chat-api', {
                  method: 'POST',
                  headers: { 'content-type': 'application/json' },
                  body: JSON.stringify({
                    action: 'send',
                    peer: first?.peer ?? 'self',
                    message: text,
                    ...(first?.mode ? { preset: first.mode } : {}),
                  }),
                })
                const json = await res.json()
                if (!json || json.ok !== true) throw new Error((json && (json.error || json.reply)) || '发送失败')
                setMessage(`已发送${json.sessionId ? `：${json.sessionId}` : ''}${json.reply ? `\n${json.reply}` : ''}`)
                // 发送成功后 1 秒自动关闭面板（先把回执显示出来）
                setTimeout(() => setOpen(false), 1000)
              } catch (failure) {
                setError(String((failure && failure.message) || failure))
              } finally { setSaving(false) }
            },
          }, '直接发送'),
        ),
        rows.map((row, index) => h('div', { key: index, style: S.row },
          h('label', { style: { ...S.row, gap: 4, cursor: 'pointer' }, title: '勾选 = 这一步选这个对端的端口' },
            h('input', { type: 'checkbox', checked: row.enabled, onChange: (event) => update(index, { enabled: event.target.checked }) }),
            h('span', { style: S.mono }, `${index + 1}.`),
          ),
          h(Select, {
            value: row.peer,
            options: peerOptions,
            label: '对端',
            onChange: (value) => {
              update(index, { peer: value })
              loadPeerModes(value)
            },
          }),
          h('button', {
            style: S.btn,
            title: '在「自动识别」和「手动填写」之间切换',
            onClick: () => update(index, { manualMode: !row.manualMode }),
          }, row.manualMode ? '自动' : '手动'),
          (() => {
            const options = modeOptionsFor(row.peer)
            if (options.length <= 1) {
              return h('input', {
                style: { ...S.input, minWidth: 120 },
                placeholder: '模式 id（清单为空，手填）',
                value: row.mode,
                onChange: (event) => update(index, { mode: event.target.value }),
              })
            }
            return row.manualMode
              ? h('input', {
                style: { ...S.input, minWidth: 120 },
                placeholder: '手动填模式 id',
                value: row.mode,
                onChange: (event) => update(index, { mode: event.target.value }),
              })
              : h(Select, { value: row.mode, options, label: '模式', onChange: (value) => update(index, { mode: value }) })
          })(),
          modeSource[row.peer] ? h('span', { style: S.muted }, modeSource[row.peer]) : null,
          // 消息内容：直接给输入框（不再选模板、不写占位符）。留空 = 按模式自动生成。
          h('input', {
            style: { ...S.input, flex: 1, minWidth: 200 },
            placeholder: '这一步要发送的消息内容（留空 = 自动）',
            value: row.message === '__auto__' ? '' : row.message,
            onChange: (event) => update(index, { message: event.target.value }),
          }),
          h('button', { style: S.btn, onClick: () => removeRow(index), disabled: rows.length <= 1 }, '删除'),
          index < rows.length - 1 ? h('span', { style: S.muted }, '→') : null,
        )),
        error !== '' ? h('div', { style: S.err }, error) : null,
        message !== '' ? h('div', { style: S.ok }, message) : null,
        h('div', { style: S.muted }, '保存后跑 peer_chain({ name, input })；链路存 <DSH_HOME>/peer-chat/chains.json。'),
      )
    }

    function PeerPanel() {
      const [data, setData] = React.useState(null)
      const [error, setError] = React.useState('')
      const [loading, setLoading] = React.useState(false)
      const [runDialog, setRunDialog] = React.useState(null)
      const [runInput, setRunInput] = React.useState('')
      const [ioText, setIoText] = React.useState('')
      const [ioMessage, setIoMessage] = React.useState('')
      const [importOpen, setImportOpen] = React.useState(false)

      const load = React.useCallback(async () => {
        setLoading(true)
        try {
          const res = await fetch('/dsh-peer-chat-api', { cache: 'no-store' })
          const json = await res.json()
          if (!json || json.ok !== true) throw new Error((json && json.error) || '读取失败')
          setData(json); setError('')
        } catch (failure) {
          setError(String((failure && failure.message) || failure))
        } finally {
          setLoading(false)
        }
      }, [])

      const callApi = React.useCallback(async (body) => {
        const res = await fetch('/dsh-peer-chat-api', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(body),
        })
        const json = await res.json()
        if (!json || json.ok !== true) throw new Error((json && json.error) || '请求失败')
        return json
      }, [])

      const runChain = React.useCallback(async (name, inputOverride) => {
        setRunDialog({ name, running: true, result: null, error: '' })
        try {
          const json = await callApi({ action: 'run-chain', name, input: typeof inputOverride === 'string' ? inputOverride : runInput })
          setRunDialog({ name, running: false, result: (json && json.result) || {}, error: '' })
        } catch (failure) {
          setRunDialog({ name, running: false, result: null, error: String((failure && failure.message) || failure) })
        }
      }, [callApi, runInput])

      const installTemplate = React.useCallback(async (template) => {
        try {
          await callApi({ action: 'install-template', template })
          setIoMessage(`已装载模板 ${template}`)
          await load()
        } catch (failure) {
          setIoMessage(`装载失败：${String((failure && failure.message) || failure)}`)
        }
      }, [callApi, load])

      const exportChains = React.useCallback(async () => {
        try {
          const json = await callApi({ action: 'export' })
          setIoText(json.json || '')
          setIoMessage(`已导出 ${json.count} 条（复制下面文本即可分享）`)
        } catch (failure) {
          setIoMessage(`导出失败：${String((failure && failure.message) || failure)}`)
        }
      }, [callApi])

      const importChains = React.useCallback(async () => {
        try {
          const json = await callApi({ action: 'import', json: ioText })
          setIoMessage(`已导入，共 ${json.count} 条链路`)
          await load()
        } catch (failure) {
          setIoMessage(`导入失败：${String((failure && failure.message) || failure)}`)
        }
      }, [callApi, ioText, load])

      React.useEffect(() => { load() }, [load])

      const scanPeers = React.useCallback(async () => {
        setLoading(true)
        try {
          const res = await fetch('/dsh-peer-chat-api?scan=1', { cache: 'no-store' })
          const json = await res.json()
          if (!json || json.ok !== true) throw new Error((json && json.error) || '扫描失败')
          // 扫描只返回 peers；不能整体替换，否则模式/链路/模板会被冲掉
          setData((prev) => ({ ...(prev ?? {}), ...json, peers: json.peers ?? (prev?.peers ?? []) }))
          setError('')
        } catch (failure) {
          setError(String((failure && failure.message) || failure))
        } finally {
          setLoading(false)
        }
      }, [])

      const peers = (data && data.peers) || []
      const modes = (data && data.modes) || []
      const chains = (data && data.chains) || []

      return h('div', { style: S.wrap },
        h('div', { style: S.head },
          h('span', { style: S.title }, `跨端对话 · ${peers.length} 对端 / ${modes.length} 模式（${(data && data.modesSource) || '未识别'}） / ${chains.length} 链路`),
          h('button', { style: S.btn, onClick: load, disabled: loading }, loading ? '刷新中…' : '刷新'),
          h('button', { style: S.btn, onClick: scanPeers, disabled: loading }, '扫描对端'),
        ),
        error !== '' ? h('div', { style: S.err }, `读取失败：${error}`) : null,

        h('div', { style: S.group },
          h('div', { style: S.label }, '对端'),
          peers.length === 0
            ? h('div', { style: S.muted }, '还没发现对端：写一条 peers.json，或让对端留下启动日志。')
            : peers.map((peer) => h('div', { key: `${peer.origin}:${peer.name}`, style: S.row },
              h('span', { style: { ...S.mono, minWidth: 120 } }, peer.name),
              h('span', { style: S.mono }, peer.url || '本端（跨会话）'),
              chip(peer.origin === 'self' ? '本端' : peer.origin === 'peers.json' ? '配置' : '发现', `o-${peer.name}`),
              chip(peer.sourceKind === 'local' ? '无需令牌' : peer.sourceKind === 'none' ? '无令牌' : `${peer.tokenPrefix}…`, `t-${peer.name}`),
            )),
        ),

        h('div', { style: S.group },
          h('div', { style: S.label }, '模式'),
          modes.length === 0
            ? h('div', { style: S.muted }, '本机没有 agent 预设。')
            : h('div', { style: S.row }, modes.map((mode) => chip(`${mode.isDefault ? '★ ' : ''}${mode.id}`, mode.id))),
        ),

        h(ChainEditor, { peers, modes, onSaved: (json) => setData(json), onRun: runChain }),

        h('div', { style: S.group },
          h('div', { style: S.label }, '固定链路'),
          chains.length === 0
            ? h('div', { style: S.muted }, '还没有链路。')
            : chains.map((chain) => h('div', { key: chain.name, style: S.row },
              h('span', { style: { ...S.mono, minWidth: 140 } }, chain.name),
              chip(`${chain.steps} 步`, `s-${chain.name}`),
              chain.mode === '' ? null : chip(`默认 ${chain.mode}`, `m-${chain.name}`),
              h('span', { style: S.muted }, chain.description),
              h('button', { style: S.btn, onClick: () => runChain(chain.name) }, '运行'),
            )),
          h('div', { style: S.row },
            h('span', { style: S.muted }, '模板：'),
            ((data && data.templates) || []).map((template) => h('button', {
              key: template.id,
              style: S.btn,
              title: template.description,
              onClick: () => installTemplate(template.id),
            }, `+${template.id}`)),
            h('input', {
              style: { ...S.input, minWidth: 160 },
              placeholder: '运行输入（{input}）',
              value: runInput,
              onChange: (event) => setRunInput(event.target.value),
            }),
            h('button', { style: S.btn, onClick: exportChains }, '导出'),
            h('button', { style: S.btn, onClick: () => setImportOpen((prev) => !prev) }, importOpen ? '收起导入' : '导入…'),
            h('button', { style: S.btn, onClick: importChains, disabled: ioText.trim() === '' }, '确认导入'),
          ),
          (importOpen || ioText.trim() !== '') ? h('textarea', {
            style: { ...S.input, width: '100%', minHeight: 90, fontFamily: 'ui-monospace, monospace' },
            value: ioText,
            onChange: (event) => setIoText(event.target.value),
          }) : null,
          ioMessage === '' ? null : h('div', { style: S.muted }, ioMessage),
        ),
        runDialog === null ? null : h('div', { style: S.backdrop },
          h('div', { style: { ...S.dialog, width: 'min(680px, 92vw)' }, onClick: (event) => event.stopPropagation() },
            h('div', { style: S.head },
              h('span', { style: S.title }, `链路结果 · ${runDialog.name}`),
              h('button', { style: S.btn, onClick: () => setRunDialog(null) }, '关闭'),
            ),
            h('div', { style: { height: 10 } }),
            runDialog.running ? h('div', { style: S.muted }, '运行中…') : null,
            runDialog.error !== '' ? h('div', { style: S.err }, runDialog.error) : null,
            runDialog.result === null ? null : h('div', { style: S.group },
              h('div', { style: S.muted }, `${runDialog.result.ok ? '完成' : '中断'} · ${(runDialog.result.steps || []).length} 步 · ${Math.round((runDialog.result.waitedMs || 0) / 1000)}s`),
              (runDialog.result.steps || []).map((step) => h('div', { key: `${step.index}-${step.status}`, style: S.row },
                chip(`${step.index}`, `i${step.index}`),
                chip(step.peer, `p${step.index}`),
                step.mode === '' ? null : chip(step.mode, `m${step.index}`),
                chip(step.status, `s${step.index}`),
                h('span', { style: S.muted }, `${step.waitedMs || 0}ms · ${step.bytes || 0}B`),
                step.error ? h('span', { style: S.err }, step.error) : null,
              )),
              h('div', { style: S.row },
                h('span', { style: S.muted }, `最终结果 · ${String(runDialog.result.final || '').length} 字`),
                h('button', {
                  style: S.btn,
                  onClick: () => { try { navigator.clipboard.writeText(String(runDialog.result.final || '')) } catch { /* 忽略 */ } },
                }, '复制'),
              ),
              h('pre', { style: { ...S.muted, whiteSpace: 'pre-wrap', maxHeight: '38vh', overflow: 'auto', margin: 0 } }, String(runDialog.result.final || '')),
              (runDialog.result.timedOut ? h('div', { style: S.err }, '注意：链路因总预算耗尽被中断') : null),
            ),
          ),
        ),
      )
    }

    function PeerDialog() {
      const visible = useOpen()
      if (!visible) return null
      return h('div', { style: S.backdrop, onClick: () => setOpen(false) },
        h('div', { style: S.dialog, onClick: (event) => event.stopPropagation() },
          h('div', { style: S.head },
            h('span', { style: S.title }, '跨端对话'),
            h('button', { style: S.btn, onClick: () => setOpen(false) }, '关闭'),
          ),
          h('div', { style: { height: 12 } }),
          h(PeerPanel),
        ),
      )
    }

    function SidebarAction() {
      return h('button', {
        type: 'button',
        style: S.sidebarBtn,
        title: '跨端对话：对端 / 模式 / 链路',
        onClick: () => setOpen(true),
        onMouseEnter: (event) => { event.currentTarget.style.background = 'var(--dsw-alias-bg-layer-2, #2a2a2a)' },
        onMouseLeave: (event) => { event.currentTarget.style.background = 'transparent' },
      }, h('span', { 'aria-hidden': 'true' }, '🐟'), h('span', null, '跨端对话'))
    }

    function apply(ctx) {
      const slots = ctx.get('slots')
      if (slots === undefined) return
      slots.inject('sidebar.footer.action', () => slots.register(
        { name: 'sidebar.footer.action', id: 'peer-chat', order: 40, label: '跨端对话' },
        () => h(SidebarAction),
      ))
      slots.inject('shell.overlay', () => slots.register(
        { name: 'shell.overlay', id: 'peer-chat-dialog' },
        () => h(PeerDialog),
      ))
      slots.inject('settings.section', () => slots.register(
        { name: 'settings.section', id: 'peer-chat', order: 30, label: '跨端对话' },
        () => h(PeerPanel),
      ))
      slots.inject('plugins.bundle.config', () => slots.register(
        { name: 'plugins.bundle.config', key: 'dsh-peer-chat' },
        () => h(PeerPanel),
      ))
    }

    exports.apply = apply
    exports.inject = ['slots']
    return module.exports
  },
})
