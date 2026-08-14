/** @jsxImportSource @opentui/solid */
// @ts-nocheck

import { createMemo, createSignal, For, onCleanup, onMount, Show } from "solid-js"

const PLUGIN_ID = "token-usage"
const DEFAULT_ORDER = 150
const OPEN_KV_KEY = "tm_open"
const SCOPE_KV_KEY = "tm_scope"
const VIEW_KV_KEY = "tm_view"
const REFRESH_MS = 8000
const EVENT_DEBOUNCE_MS = 700
const TOOL_ROWS = 8
const LABEL_W = 18

let toggleOpenFromCommand: (() => void) | undefined

const sumValues = (obj) => Object.values(obj || {}).reduce((sum, value) => sum + (Number(value) || 0), 0)

function entryTotal(entry) {
  return (Number(entry?.in) || 0) + (Number(entry?.out) || 0) + sumValues(entry?.t) + (Number(entry?.f) || 0) + (Number(entry?.s) || 0)
}

function overheadTotal(overhead) {
  return (Number(overhead?.opencode) || 0) + (Number(overhead?.agents) || 0) + (Number(overhead?.skillDefs) || 0) + (Number(overhead?.toolDefs) || 0)
}

function entryBreakdown(entries) {
  return (entries || []).reduce((acc, entry) => ({
    input: acc.input + (Number(entry?.in) || 0),
    output: acc.output + (Number(entry?.out) || 0),
    tools: acc.tools + sumValues(entry?.t),
    files: acc.files + (Number(entry?.f) || 0),
    skills: acc.skills + (Number(entry?.s) || 0),
  }), { input: 0, output: 0, tools: 0, files: 0, skills: 0 })
}

function detailedMergeTools(target, source) {
  for (const [key, value] of Object.entries(source || {})) target[key] = (target[key] || 0) + (Number(value) || 0)
}

function detailedToolChildren(toolsObj, countsObj, targetsObj) {
  const items = Object.entries(toolsObj || {})
    .map(([name, value]) => ({ name, value: Number(value) || 0, count: Number(countsObj?.[name]) || 0, targets: targetsObj?.[name] || {} }))
    .filter((item) => item.value > 0)
    .sort((a, b) => b.value - a.value)

  const top = items.slice(0, TOOL_ROWS).map((item) => ({
    label: item.count > 0 ? `${item.name} (${item.count})` : item.name,
    value: formatCount(item.value),
    children: Object.entries(item.targets)
      .map(([target, count]) => ({ label: shortLabel(target), value: `${Math.round(Number(count) || 0)}x`, title: target }))
      .sort((a, b) => (Number(String(b.value).replace(/[^0-9.-]/g, "")) || 0) - (Number(String(a.value).replace(/[^0-9.-]/g, "")) || 0)),
  }))

  const rest = items.slice(TOOL_ROWS)
  const restTotal = rest.reduce((sum, item) => sum + item.value, 0)
  if (restTotal > 0) top.push({ label: "other", value: formatCount(restTotal) })
  return top
}

function detailedFilesNode(filesObj, total) {
  return {
    label: "Files",
    value: formatCount(total),
    children: Object.entries(filesObj || {})
      .map(([label, value]) => ({ label: shortLabel(label), value: formatCount(value), title: label }))
      .filter((item) => item.value !== "-")
      .sort((a, b) => (Number(String(b.value).replace(/,/g, "")) || 0) - (Number(String(a.value).replace(/,/g, "")) || 0)),
  }
}

function detailedOverheadNode(overhead, scope, skillsValue) {
  const children = []
  if ((overhead?.opencode || 0) > 0) children.push({ label: "opencode", value: formatCount(overhead.opencode) })
  if ((overhead?.agents || 0) > 0) children.push({ label: "AGENTS.md", value: formatCount(overhead.agents) })
  if ((overhead?.toolDefs || 0) > 0) {
    const node = { label: "tool defs", value: formatCount(overhead.toolDefs) }
    if (scope === "current" && overhead?.toolDefsByTool) node.children = detailedToolChildren(overhead.toolDefsByTool)
    children.push(node)
  }
  if ((overhead?.skillDefs || 0) > 0) children.push({ label: "skill defs", value: formatCount(overhead.skillDefs) })
  if ((skillsValue || 0) > 0) children.push({ label: "Skills", value: formatCount(skillsValue) })
  return { label: "Overhead", value: formatCount(overheadTotal(overhead) + (Number(skillsValue) || 0)), children }
}

function detailedGroupTurns(entries) {
  const turns = []
  let turn = null
  const start = () => ({ in: 0, out: 0, t: {}, tc: {}, tt: {}, f: 0, fl: {} })
  for (const entry of entries || []) {
    if (entry?.r === "u") {
      if (turn) turns.push(turn)
      turn = start()
      turn.in += Number(entry?.in) || 0
    } else {
      if (!turn) turn = start()
      turn.out += Number(entry?.out) || 0
    }
    detailedMergeTools(turn.t, entry?.t)
    detailedMergeTools(turn.tc, entry?.tc)
    for (const [tool, targets] of Object.entries(entry?.tt || {})) {
      turn.tt[tool] ||= {}
      detailedMergeTools(turn.tt[tool], targets)
    }
    detailedMergeTools(turn.fl, entry?.fl)
    turn.f += Number(entry?.f) || 0
  }
  if (turn) turns.push(turn)
  return turns.filter((turn) => turn.in + turn.out + sumValues(turn.t) + turn.f > 0)
}

function detailedMsgNode(turn, index) {
  const children = []
  if (turn.in > 0) children.push({ label: "Input", value: formatCount(turn.in) })
  if (turn.out > 0) children.push({ label: "Output", value: formatCount(turn.out) })
  const toolsTotal = sumValues(turn.t)
  if (toolsTotal > 0) children.push({ label: "Tool calls", value: formatCount(toolsTotal), children: detailedToolChildren(turn.t, turn.tc, turn.tt) })
  if (turn.f > 0) children.push(detailedFilesNode(turn.fl, turn.f))
  return { label: `Msg ${index}`, value: formatCount(turn.in + turn.out + toolsTotal + turn.f), children }
}

function buildModelList(entries, overhead, scope, view) {
  let skillsValue = 0
  let filesTotal = 0
  for (const entry of entries || []) {
    skillsValue += Number(entry?.s) || 0
    filesTotal += Number(entry?.f) || 0
  }

  const list = [detailedOverheadNode(overhead, scope, skillsValue)]

  if (view === "prompt") {
    const turns = detailedGroupTurns(entries)
    const children = turns.map((turn, index) => detailedMsgNode(turn, index + 1))
    list.push({
      label: "Prompts",
      value: formatCount(children.reduce((sum, item) => sum + (Number(String(item.value).replace(/,/g, "")) || 0), 0)),
      children,
    })
    return list.map((item) => addFractions(item))
  }

  let input = 0
  let output = 0
  const tools = {}
  const toolCounts = {}
  const toolTargets = {}
  const files = {}
  for (const entry of entries || []) {
    input += Number(entry?.in) || 0
    output += Number(entry?.out) || 0
    detailedMergeTools(tools, entry?.t)
    detailedMergeTools(toolCounts, entry?.tc)
    for (const [tool, targets] of Object.entries(entry?.tt || {})) {
      toolTargets[tool] ||= {}
      detailedMergeTools(toolTargets[tool], targets)
    }
    detailedMergeTools(files, entry?.fl)
  }

  const promptChildren = []
  if (input > 0) promptChildren.push({ label: "Input", value: formatCount(input) })
  if (output > 0) promptChildren.push({ label: "Output", value: formatCount(output) })
  if (filesTotal > 0) promptChildren.push(detailedFilesNode(files, filesTotal))
  list.push({ label: "Prompts", value: formatCount(input + output + filesTotal), children: promptChildren })

  const toolsTotal = sumValues(tools)
  if (toolsTotal > 0) list.push({ label: "Tools", value: formatCount(toolsTotal), children: detailedToolChildren(tools, toolCounts, toolTargets) })
  return list.map((item) => addFractions(item))
}

function shortLabel(value, width = 28) {
  const text = String(value || "")
  return text.length <= width ? text : `${text.slice(0, Math.max(0, width - 1))}...`
}

function shortTreeLabel(value, width = LABEL_W) {
  const text = String(value || "")
  return text.length <= width ? text : `${text.slice(0, Math.max(0, width - 3))}...`
}

function Selector(props) {
  return (
    <box flexDirection="row" gap={1}>
      <text fg={props.colors.textMuted}>{`${props.label}:`}</text>
      <text fg={props.colors.textMuted} onMouseUp={props.onToggle}>{"<"}</text>
      <text fg={props.colors.text}><b>{props.value}</b></text>
      <text fg={props.colors.textMuted} onMouseUp={props.onToggle}>{">"}</text>
    </box>
  )
}

function Bar(props) {
  const width = props.width || 8
  const filled = Math.max(0, Math.min(width, Math.round((Number(props.frac) || 0) * width)))
  return (
    <text wrapMode="none">
      <span style={{ fg: props.dim ? props.colors.border : props.colors.primary }}>{"█".repeat(filled)}</span>
      <span style={{ fg: props.colors.border }}>{"░".repeat(width - filled)}</span>
    </text>
  )
}

function TreeRow(props) {
  const foldable = () => Array.isArray(props.node?.children) && props.node.children.length > 0
  const prefix = () => `${" ".repeat(props.depth || 0)}${foldable() ? (props.isOpen(props.path) ? "▼ " : "▶ ") : "  "}`
  const click = () => {
    if (foldable()) props.onToggle(props.path)
    else if (props.node?.title) props.onSelect(props.node.title)
  }

  return (
    <box flexDirection="column">
      <box flexDirection="row" gap={1} alignItems="center">
        <box width={LABEL_W}>
          <text fg={props.depth > 0 ? props.colors.textMuted : props.colors.text} title={props.node?.title} onMouseUp={click}>{shortTreeLabel(`${prefix()}${props.node.label}`)}</text>
        </box>
        <box flexGrow={1}>
          <Bar colors={props.colors} frac={props.node?.frac} dim={props.depth > 0} />
        </box>
        <box width={8} justifyContent="flex-end">
          <text fg={props.colors.textMuted}>{props.node.value}</text>
        </box>
      </box>
      <Show when={foldable() && props.isOpen(props.path)}>
        <For each={props.node.children}>
          {(child, index) => (
            <TreeRow
              node={child}
              path={`${props.path}/${index()}`}
              depth={(props.depth || 0) + 1}
              colors={props.colors}
              isOpen={props.isOpen}
              onToggle={props.onToggle}
              onSelect={props.onSelect}
            />
          )}
        </For>
      </Show>
    </box>
  )
}

function formatCount(value) {
  const num = Math.round(Number(value) || 0)
  return num > 0 ? num.toLocaleString("en-US") : "-"
}

function fallbackEntry(message, parts) {
  const role = message?.role === "user" ? "u" : "a"
  const entry = { r: role, in: 0, out: 0, t: {}, tc: {}, tt: {}, f: 0, fl: {}, s: 0, o: message?.time?.created || 0 }
  for (const part of parts || []) {
    if (part?.type === "text" && !part.synthetic && typeof part.text === "string") {
      const tokens = Math.ceil(part.text.length / 4)
      if (role === "u") entry.in += tokens
      else entry.out += tokens
      continue
    }
    if (part?.type === "tool") {
      const name = part.tool || "tool"
      const output = typeof part.state?.output === "string" ? part.state.output : ""
      const args = part.state?.input ? JSON.stringify(part.state.input) : ""
      const tokens = Math.ceil(output.length / 4) + Math.ceil(args.length / 4)
      if (name === "skill") {
        entry.s += tokens
      } else {
        entry.t[name] = (entry.t[name] || 0) + tokens
        entry.tc[name] = (entry.tc[name] || 0) + 1
        const targets = entry.tt[name] || {}
        const direct = part.state?.input?.filePath || part.state?.input?.url || part.state?.input?.path || part.state?.input?.include
        if (typeof direct === "string" && direct) targets[direct] = (targets[direct] || 0) + tokens
        entry.tt[name] = targets
      }
      continue
    }
    if (part?.type === "file") {
      const text = part.source?.text?.value
      if (typeof text === "string") {
        const tokens = Math.ceil(text.length / 4)
        const name = part.filename || part.source?.path || part.url || "file"
        entry.f += tokens
        entry.fl[name] = (entry.fl[name] || 0) + tokens
      }
    }
  }
  return entry
}

function buildFallback(api, sessionID) {
  if (!sessionID) return { current: [], total: [], overheadCurrent: {}, overheadTotal: {} }
  const messages = api.state?.session?.messages?.(sessionID) || []
  const entries = messages.map((message) => fallbackEntry(message, api.state?.part?.(message.id) || []))
  return {
    current: entries.length > 0 ? [entries[entries.length - 1]] : [],
    total: entries,
    overheadCurrent: {},
    overheadTotal: {},
  }
}

function mergeLiveEntries(captured, live) {
  const merged = Array.isArray(captured) ? [...captured] : []
  for (const liveEntry of live || []) {
    const index = merged.findIndex((entry) => entry?.o === liveEntry?.o && entry?.r === liveEntry?.r)
    if (index >= 0) {
      if (entryTotal(liveEntry) >= entryTotal(merged[index])) merged[index] = liveEntry
      continue
    }
    merged.push(liveEntry)
  }
  return merged.sort((a, b) => (a?.o || 0) - (b?.o || 0))
}

function addFractions(node) {
  const children = Array.isArray(node?.children) ? node.children : []
  const max = children.reduce((current, child) => Math.max(current, Number(String(child?.value || "0").replace(/,/g, "")) || 0), Number(String(node?.value || "0").replace(/,/g, "")) || 0)
  const withChildren = children.map((child) => addFractions(child))
  return {
    ...node,
    frac: max > 0 ? ((Number(String(node?.value || "0").replace(/,/g, "")) || 0) / max) : 0,
    children: withChildren.map((child) => ({
      ...child,
      frac: max > 0 ? ((Number(String(child?.value || "0").replace(/,/g, "")) || 0) / max) : 0,
    })),
  }
}

async function readCapture(api, sessionID) {
  try {
    if (typeof Bun === "undefined" || !sessionID) return null
    const configDir = api.state?.path?.config
    if (!configDir) return null
    const file = Bun.file(`${String(configDir).replace(/[\\/]+$/, "")}/.token-usage-cache.json`)
    if (!(await file.exists())) return null
    const data = await file.json()
    return data?.sessions?.[sessionID] || null
  } catch {
    return null
  }
}

function currentSessionID(api, sessionID?: string) {
  if (sessionID) return sessionID
  const route = api.route?.current
  return route?.name === "session" && typeof route.params?.sessionID === "string" ? route.params.sessionID : undefined
}

function getStats(api, sessionID?: string) {
  try {
    const id = currentSessionID(api, sessionID)
    if (!id) return { context: "-", cache: "-" }
    const messages = api.state?.session?.messages?.(id) || []
    let last
    for (let i = messages.length - 1; i >= 0; i--) {
      const item = messages[i]
      if (item?.role !== "assistant") continue
      if ((item?.tokens?.total || item?.tokens?.output || 0) <= 0) continue
      last = item
      break
    }
    if (!last?.tokens) return { context: "-", cache: "-" }
    const total = Number(last.tokens.total) || (Number(last.tokens.input) || 0) + (Number(last.tokens.output) || 0) + (Number(last.tokens.reasoning) || 0) + (Number(last.tokens.cache?.read) || 0) + (Number(last.tokens.cache?.write) || 0)
    const cacheRead = Number(last.tokens.cache?.read) || 0
    return {
      context: total > 0 ? formatCount(total) : "-",
      cache: total > 0 ? `${Math.round((cacheRead / total) * 100)}%` : "-",
    }
  } catch {
    return { context: "-", cache: "-" }
  }
}

function View(props) {
  const api = props.api
  const [open, setOpen] = createSignal(false)
  const [capture, setCapture] = createSignal(null)
  const [scope, setScope] = createSignal("current")
  const [view, setView] = createSignal("prompt")
  const [expanded, setExpanded] = createSignal({})
  const [detail, setDetail] = createSignal("")

  const applyOpen = (next) => {
    try { api.kv?.set?.(OPEN_KV_KEY, next) } catch {}
    setOpen(next)
  }

  const toggleOpen = () => {
    applyOpen(!open())
  }

  const toggleScope = () => {
    const next = scope() === "total" ? "current" : "total"
    try { api.kv?.set?.(SCOPE_KV_KEY, next) } catch {}
    setScope(next)
  }

  const toggleView = () => {
    const next = view() === "tool" ? "prompt" : "tool"
    try { api.kv?.set?.(VIEW_KV_KEY, next) } catch {}
    setView(next)
  }

  const isOpen = (path) => expanded()[path] === true
  const toggleTree = (path) => {
    setExpanded((state) => ({ ...state, [path]: !isOpen(path) }))
  }

  const toggleDetail = (value) => {
    setDetail((current) => current === value ? "" : value)
  }

  onMount(() => {
    try { setOpen(api.kv?.get?.(OPEN_KV_KEY, false) === true) } catch {}
    try { setScope(api.kv?.get?.(SCOPE_KV_KEY, "current") === "total" ? "total" : "current") } catch {}
    try { setView(api.kv?.get?.(VIEW_KV_KEY, "prompt") === "tool" ? "tool" : "prompt") } catch {}
    toggleOpenFromCommand = () => applyOpen(!open())

    let disposed = false
    let timer
    let debounce
    const refreshCapture = () => readCapture(api, currentSessionID(api, props.session_id)).then((data) => {
      if (!disposed) setCapture(data)
    }).catch(() => {})

    void refreshCapture()
    const unsubscribe = api.event?.on?.("message.updated", () => {
      if (debounce) clearTimeout(debounce)
      debounce = setTimeout(() => {
        void refreshCapture()
      }, EVENT_DEBOUNCE_MS)
    })
    timer = setInterval(() => {
      void refreshCapture()
    }, REFRESH_MS)

    onCleanup(() => {
      disposed = true
      if (timer) clearInterval(timer)
      if (debounce) clearTimeout(debounce)
      if (unsubscribe) unsubscribe()
    })
  })

  onCleanup(() => {
    if (toggleOpenFromCommand) toggleOpenFromCommand = undefined
  })

  const colors = () => api.theme.current
  const stats = createMemo(() => getStats(api, props.session_id))
  const summary = createMemo(() => {
    const live = buildFallback(api, currentSessionID(api, props.session_id))
    const data = capture() || live
    const scopeValue = scope()
    const viewValue = view()
    if (!data) {
      return {
        scope: scopeValue,
        view: viewValue,
        requests: "-",
        current: "-",
        input: "-",
        output: "-",
        tools: "-",
        files: "-",
        skills: "-",
        entries: [],
        overheadRaw: {},
      }
    }

    const entries = scopeValue === "total"
      ? mergeLiveEntries(data.total || [], live.total || [])
      : mergeLiveEntries(data.current || [], live.current || [])
    const breakdown = entryBreakdown(entries)
    const selectedTotal = entries.reduce((sum, entry) => sum + entryTotal(entry), 0)
    return {
      scope: scopeValue,
      view: viewValue,
      requests: formatCount(scopeValue === "total" ? data.reqCount : 1),
      current: formatCount(selectedTotal),
      input: formatCount(breakdown.input),
      output: formatCount(breakdown.output),
      tools: formatCount(breakdown.tools),
      files: formatCount(breakdown.files),
      skills: formatCount(breakdown.skills),
      entries,
      overheadRaw: scopeValue === "total" ? (data.overheadTotal || {}) : (data.overheadCurrent || {}),
    }
  })
  const currentPromptLabel = createMemo(() => summary().scope === "total"
    ? `Session total: ${summary().current}`
    : `This prompt: ${stats().context} (${stats().cache} cache hit)`)

  const model = createMemo(() => buildModelList(summary().entries, summary().overheadRaw, summary().scope === "total" ? "total" : "current", summary().view === "tool" ? "tool" : "prompt"))

  return (
    <box flexDirection="column">
      <box flexDirection="row" gap={1} onMouseUp={toggleOpen}>
        <text fg={colors().text}><b>{open() ? "▼" : "▶"}</b></text>
        <text fg={colors().text}><b>Token Monsters</b></text>
      </box>
      <Show when={open()}>
        <box flexDirection="column">
          <Selector colors={colors()} label="Session" value={summary().scope === "total" ? "Total" : "Aktuel"} onToggle={toggleScope} />
          <Selector colors={colors()} label="View" value={summary().view === "tool" ? "Tools" : "Prompts"} onToggle={toggleView} />
          <text fg={colors().textMuted}>{currentPromptLabel()}</text>
          <Show when={detail()}>
            <text fg={colors().textMuted}>{`Selected path: ${detail()}`}</text>
          </Show>
          <text fg={colors().textMuted}> </text>
          <box flexDirection="column">
            <For each={model()}>
              {(item, index) => <TreeRow node={item} path={`${item.label}-${index()}`} depth={0} colors={colors()} isOpen={isOpen} onToggle={toggleTree} onSelect={toggleDetail} />}
            </For>
          </box>
          <text fg={colors().textMuted}>{`Requests: ${summary().requests}`}</text>
        </box>
      </Show>
    </box>
  )
}

function registerCommand(api, toggle) {
  const def = {
    name: "tokenmonster.toggle",
    title: "Token Monsters: fold sidebar",
    category: "Token Monsters",
    namespace: "palette",
    slashName: "tokenmonster",
    run: () => toggle(),
  }
  try {
    if (api.keymap?.registerLayer) {
      api.keymap.registerLayer({ commands: [def], bindings: [] })
      return
    }
  } catch {}
  try {
    if (api.command?.register) {
      api.command.register(() => [
        { title: def.title, value: def.name, category: def.category, slash: { name: def.slashName }, onSelect: () => toggle() },
      ])
    }
  } catch {}
}

export const TokenMonsters = {
  id: PLUGIN_ID,
  async tui(api, options) {
    if (options?.enabled === false) return
    const toggle = () => {
      toggleOpenFromCommand?.()
      const next = api.kv?.get?.(OPEN_KV_KEY, false) === true
      try { api.ui?.toast?.({ variant: next ? "success" : "info", message: `Token Monsters ${next ? "expanded" : "collapsed"}` }) } catch {}
    }
    registerCommand(api, toggle)
    const order = typeof options?.order === "number" ? options.order : DEFAULT_ORDER
    api.slots.register({
      order,
      slots: {
        sidebar_content(props: { session_id?: string }) {
          return <View api={api} session_id={props.session_id} options={options} />
        },
      },
    })
  },
}

export default TokenMonsters
