/** @jsxImportSource @opentui/solid */
// @ts-nocheck

// Token Monsters - opencode token-usage sidebar.
//
// Reads the per-request breakdown written by token-usage-capture.ts. Two
// selectors:
//   Session:  Total   (everything since session start, survives compaction)
//             Aktuel  (the last request only)
//   View:     Prompts (per message: Input / Output / Tool calls / Files)
//             Tools   (aggregated: Input, Output, Tools by type)
//
// Overhead (opencode prompt, AGENTS.md, tool defs, skill defs, Skills) is shown
// in both scopes. Counts are o200k: exact for OpenAI models, ~approx otherwise.

import { createMemo, createSignal, onCleanup, onMount, For, Show } from "solid-js"

const PLUGIN_ID = "token-usage"
const DEFAULT_ORDER = 150
const REFRESH_MS = 8000
const EVENT_DEBOUNCE_MS = 700
const TOOL_ROWS = 8
const LABEL_W = 18

// Sidebar on/off, toggled by the /tokenmonster command. Persisted in kv so it
// survives restarts; a module-level signal lets the command hide/show every
// mounted sidebar instance live without a restart.
const [enabled, setEnabled] = createSignal(true)

const NUM = new Intl.NumberFormat("en-US")
const fmt = (n) => NUM.format(Math.round(Number(n) || 0))
const fmtK = (n) => {
  n = Number(n) || 0
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(2)}M`
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`
  return String(Math.round(n))
}
const tokGuess = (s) => Math.ceil(String(s || "").length / 4)
const clip = (v, w) => {
  const s = String(v)
  return s.length <= w ? s : `${s.slice(0, Math.max(0, w - 1))}…`
}
const sumVals = (obj) => Object.values(obj || {}).reduce((a, b) => a + (Number(b) || 0), 0)

// ---------------------------------------------------------------------------
// Cache read.
// ---------------------------------------------------------------------------

async function readCapture(api, sessionID) {
  try {
    if (typeof Bun === "undefined") return null
    const dir = api.state?.path?.config
    if (!dir) return null
    const file = Bun.file(`${dir.replace(/[\\/]+$/, "")}/.token-usage-cache.json`)
    if (!(await file.exists())) return null
    const data = await file.json()
    return data?.sessions?.[sessionID] || null
  } catch {
    return null
  }
}

function fileLabel(p) {
  const raw = p?.filename || p?.source?.path || p?.url || "file"
  const base = String(raw).split(/[\\/]/).pop() || String(raw)
  return base || "file"
}

function shortTarget(raw) {
  if (typeof raw !== "string") return
  const s = raw.trim()
  if (!s) return
  if (/^https?:\/\//i.test(s)) return s
  if (/^[a-zA-Z]:[\\/]/.test(s) || s.startsWith("/") || s.startsWith("./") || s.startsWith("../") || s.includes("\\") || s.includes("/")) return s
}

function addTarget(bucket, raw) {
  const key = shortTarget(raw)
  if (key) bucket[key] = (bucket[key] || 0) + 1
}

function collectTargets(name, input, output) {
  const out = {}
  const add = (raw) => addTarget(out, raw)
  if (name === "read" || name === "edit" || name === "write") add(input?.filePath)
  else if (name === "webfetch") add(input?.url)
  else if (name === "apply_patch") {
    const patch = typeof input?.patchText === "string" ? input.patchText : ""
    for (const m of patch.matchAll(/^\*\*\* (?:Add|Update|Delete) File: (.+)$/gm)) add(m[1])
  }
  else if (name === "glob") add(input?.pattern)
  else if (name === "grep") {
    add(input?.include)
    add(input?.path)
  }
  else if (name === "bash") {
    add(input?.workdir)
    const m = typeof output === "string" ? output.match(/\b([A-Za-z]:\\[^\r\n]+|\/[A-Za-z0-9._\/-]+(?:\.[A-Za-z0-9_-]+)?|https?:\/\/\S+)/g) : null
    for (const hit of m || []) add(hit)
  } else {
    for (const v of Object.values(input || {})) {
      if (typeof v === "string") add(v)
      else if (Array.isArray(v)) for (const x of v) add(x)
    }
  }
  return Object.keys(out)
}

function allocateTargets(targets, total) {
  const uniq = [...new Set((targets || []).filter(Boolean))]
  if (uniq.length === 0) return {}
  const n = Math.max(0, Math.round(Number(total) || 0))
  const base = Math.floor(n / uniq.length)
  let rem = n - base * uniq.length
  const out = {}
  for (const key of uniq) {
    out[key] = base + (rem > 0 ? 1 : 0)
    if (rem > 0) rem--
  }
  return out
}

function toolTargets(name, input, output, totalTokens) {
  return allocateTargets(collectTargets(name, input, output), totalTokens)
}

function fallbackEntry(message, parts) {
  const role = message?.role === "user" ? "u" : "a"
  const e = { r: role, in: 0, out: 0, t: {}, tc: {}, tt: {}, f: 0, fl: {}, s: 0, o: message?.time?.created || 0 }
  for (const p of parts || []) {
    if (p?.type === "text" && !p.synthetic && typeof p.text === "string") {
      const n = tokGuess(p.text)
      if (role === "u") e.in += n
      else e.out += n
    } else if (p?.type === "tool") {
      const name = p.tool || "tool"
      const out = typeof p.state?.output === "string" ? p.state.output : ""
      const args = p.state?.input ? JSON.stringify(p.state.input) : ""
      const n = tokGuess(out) + tokGuess(args)
      if (name === "skill") e.s += n
      else {
        e.t[name] = (e.t[name] || 0) + n
        e.tc[name] = (e.tc[name] || 0) + 1
        const targets = toolTargets(name, p.state?.input, out, n)
        if (Object.keys(targets).length) e.tt[name] = targets
      }
      for (const a of p.state?.attachments || []) {
        const v = a?.source?.text?.value
        if (typeof v === "string") {
          const n = tokGuess(v)
          e.f += n
          const label = fileLabel(a)
          e.fl[label] = (e.fl[label] || 0) + n
        }
      }
    } else if (p?.type === "file") {
      const v = p.source?.text?.value
      if (typeof v === "string") {
        const n = tokGuess(v)
        e.f += n
        const label = fileLabel(p)
        e.fl[label] = (e.fl[label] || 0) + n
      }
    } else if (p?.type === "patch") {
      for (const file of p.files || []) addTarget((e.tt.edit ||= {}), file)
    }
  }
  return e
}

function buildFallback(api, sessionID) {
  const messages = api.state.session.messages(sessionID) || []
  const entries = messages.map((m) => fallbackEntry(m, api.state.part(m.id) || []))
  return { current: entries.length ? [entries[entries.length - 1]] : [], total: entries, overheadCurrent: {}, overheadTotal: {} }
}

// ---------------------------------------------------------------------------
// Node tree builders.  A node = { label, tokens, frac?, children? }.
// ---------------------------------------------------------------------------

function toolChildren(toolsObj, countsObj, targetsObj) {
  const arr = Object.entries(toolsObj || {})
    .map(([name, tokens]) => ({ name, tokens: Number(tokens) || 0, count: countsObj ? Number(countsObj[name]) || 0 : 0, targets: targetsObj?.[name] || null }))
    .filter((t) => t.tokens > 0)
    .sort((a, b) => b.tokens - a.tokens)
  const withLabel = (name, count) => (countsObj && count > 0 ? `${name} (${count})` : name)
  const targetChildren = (targets) => Object.entries(targets || {}).sort((a, b) => b[1] - a[1]).map(([full, count]) => ({ label: clip(full, LABEL_W), fullLabel: full, tokens: 0, count: Number(count) || 0 }))
  const head = arr.slice(0, TOOL_ROWS).map((t) => ({
    label: withLabel(t.name, t.count),
    tokens: t.tokens,
    children: targetChildren(t.targets),
  }))
  const rest = arr.slice(TOOL_ROWS)
  const tail = rest.reduce((s, t) => s + t.tokens, 0)
  if (tail > 0) head.push({ label: withLabel("other", rest.reduce((s, t) => s + t.count, 0)), tokens: tail })
  return head
}

// Files node: a foldable "Files" with one child per loaded file (name -> tokens).
// Falls back to a plain leaf when no per-file detail is present (old cache data).
function filesNode(flObj, total) {
  const kids = Object.entries(flObj || {})
    .map(([label, tokens]) => ({ label: clip(label, LABEL_W), fullLabel: label, tokens: Number(tokens) || 0 }))
    .filter((f) => f.tokens > 0)
    .sort((a, b) => b.tokens - a.tokens)
  return { label: "Files", tokens: total, children: kids }
}

function overheadNode(ov, scope, skillsTotal) {
  const kids = []
  if ((ov.opencode || 0) > 0) kids.push({ label: "opencode", tokens: ov.opencode })
  if ((ov.agents || 0) > 0) kids.push({ label: "AGENTS.md", tokens: ov.agents })
  if ((ov.toolDefs || 0) > 0) {
    const node = { label: "tool defs", tokens: ov.toolDefs }
    if (scope === "current" && ov.toolDefsByTool) node.children = toolChildren(ov.toolDefsByTool)
    kids.push(node)
  }
  if ((ov.skillDefs || 0) > 0) kids.push({ label: "skill defs", tokens: ov.skillDefs })
  if ((skillsTotal || 0) > 0) kids.push({ label: "Skills", tokens: skillsTotal })
  return { label: "Overhead", tokens: kids.reduce((s, k) => s + k.tokens, 0), children: kids }
}

function mergeTools(target, src) {
  for (const [k, v] of Object.entries(src || {})) target[k] = (target[k] || 0) + (Number(v) || 0)
}

function groupTurns(entries) {
  const turns = []
  let turn = null
  const start = () => ({ in: 0, out: 0, t: {}, tc: {}, tt: {}, f: 0, fl: {} })
  for (const e of entries || []) {
    if (e.r === "u") {
      if (turn) turns.push(turn)
      turn = start()
      turn.in += e.in || 0
    } else {
      if (!turn) turn = start()
      turn.out += e.out || 0
    }
    mergeTools(turn.t, e.t)
    mergeTools(turn.tc, e.tc)
    for (const [tool, targets] of Object.entries(e.tt || {})) {
      turn.tt[tool] ||= {}
      mergeTools(turn.tt[tool], targets)
    }
    mergeTools(turn.fl, e.fl)
    turn.f += e.f || 0
  }
  if (turn) turns.push(turn)
  return turns.filter((t) => t.in + t.out + sumVals(t.t) + t.f > 0)
}

function msgNode(t, n) {
  const kids = []
  if (t.in > 0) kids.push({ label: "Input", tokens: t.in })
  if (t.out > 0) kids.push({ label: "Output", tokens: t.out })
  const toolsTotal = sumVals(t.t)
  if (toolsTotal > 0) kids.push({ label: "Tool calls", tokens: toolsTotal, children: toolChildren(t.t, t.tc, t.tt) })
  if (t.f > 0) kids.push(filesNode(t.fl, t.f))
  return { label: `Msg ${n}`, tokens: t.in + t.out + toolsTotal + t.f, children: kids }
}

function buildList(entries, ov, scope, view) {
  let skillsTotal = 0
  let filesTotal = 0
  for (const e of entries || []) {
    skillsTotal += e.s || 0
    filesTotal += e.f || 0
  }
  const list = [overheadNode(ov, scope, skillsTotal)]

  if (view === "prompt") {
    const turns = groupTurns(entries)
    const kids = turns.map((t, i) => msgNode(t, i + 1))
    list.push({ label: "Prompts", tokens: kids.reduce((s, k) => s + k.tokens, 0), children: kids })
  } else {
    let input = 0, output = 0
    const tools = {}, toolCounts = {}, toolTargets = {}, files = {}
    for (const e of entries || []) {
      input += e.in || 0
      output += e.out || 0
      mergeTools(tools, e.t)
      mergeTools(toolCounts, e.tc)
      for (const [tool, targets] of Object.entries(e.tt || {})) {
        toolTargets[tool] ||= {}
        mergeTools(toolTargets[tool], targets)
      }
      mergeTools(files, e.fl)
    }
    const pKids = []
    if (input > 0) pKids.push({ label: "Input", tokens: input })
    if (output > 0) pKids.push({ label: "Output", tokens: output })
    if (filesTotal > 0) pKids.push(filesNode(files, filesTotal))
    list.push({ label: "Prompts", tokens: input + output + filesTotal, children: pKids })
    const toolsTotal = sumVals(tools)
    if (toolsTotal > 0) list.push({ label: "Tools", tokens: toolsTotal, children: toolChildren(tools, toolCounts, toolTargets) })
  }

  setFrac(list)
  return list.filter((n) => n.tokens > 0)
}

function setFrac(nodes) {
  const max = nodes.reduce((m, n) => Math.max(m, n.tokens), 0)
  for (const n of nodes) {
    n.frac = max > 0 ? n.tokens / max : 0
    if (n.children && n.children.length) setFrac(n.children)
  }
}

// ---------------------------------------------------------------------------
// UI primitives.
// ---------------------------------------------------------------------------

function palette(api) {
  const t = api.theme.current
  return { text: t.text, muted: t.textMuted, accent: t.primary, bar: t.primary, track: t.border }
}

function Line(props) {
  return (
    <box flexDirection="row" justifyContent="space-between" gap={1}>
      <text fg={props.colors.muted}>{props.label}</text>
      <text fg={props.strong ? props.colors.text : props.colors.muted}>
        {props.strong ? <b>{props.value}</b> : props.value}
      </text>
    </box>
  )
}

function Bar(props) {
  const width = props.width || 8
  const filled = Math.max(0, Math.min(width, Math.round((props.frac || 0) * width)))
  return (
    <text wrapMode="none">
      <span style={{ fg: props.dim ? props.colors.track : props.colors.bar }}>{"█".repeat(filled)}</span>
      <span style={{ fg: props.colors.track }}>{"░".repeat(width - filled)}</span>
    </text>
  )
}

function Selector(props) {
  return (
    <box flexDirection="row" gap={1} alignItems="center">
      <box width={8}>
        <text fg={props.colors.muted}>{`${props.label}:`}</text>
      </box>
      <text fg={props.colors.muted} onMouseDown={props.onToggle}>{"<"}</text>
      <text fg={props.colors.accent}><b>{props.value}</b></text>
      <text fg={props.colors.muted} onMouseDown={props.onToggle}>{">"}</text>
    </box>
  )
}

function TreeRow(props) {
  const node = props.node
  const foldable = !!(node.children && node.children.length > 0)
  const isOpen = () => !!props.expanded()[props.path]
  const labelStr = () => " ".repeat(props.depth) + (foldable ? (isOpen() ? "▼ " : "▶ ") : "") + node.label
  const value = () => typeof node.count === "number" ? `${node.count}x` : fmtK(node.tokens)
  const click = () => {
    if (node.fullLabel) props.toggleDetail(node.fullLabel)
    else if (foldable) props.toggle(props.path)
  }
  return (
    <box flexDirection="column" gap={0}>
      <box flexDirection="row" gap={1} alignItems="center" title={node.fullLabel || node.label} onMouseDown={click}>
        <box width={LABEL_W}>
          <text fg={props.depth > 0 ? props.colors.muted : props.colors.text}>{clip(labelStr(), LABEL_W)}</text>
        </box>
        <box flexGrow={1}>
          <Bar colors={props.colors} frac={node.frac} dim={props.depth > 0} />
        </box>
        <box width={7} justifyContent="flex-end">
          <text fg={props.colors.muted}>{value()}</text>
        </box>
      </box>
      <Show when={foldable && isOpen()}>
        <For each={node.children}>
          {(child) => (
            <TreeRow node={child} depth={props.depth + 1} path={`${props.path}/${child.label}`} colors={props.colors} expanded={props.expanded} toggle={props.toggle} toggleDetail={props.toggleDetail} />
          )}
        </For>
      </Show>
    </box>
  )
}

// ---------------------------------------------------------------------------
// View.
// ---------------------------------------------------------------------------

function View(props) {
  const api = props.api
  const [capture, setCapture] = createSignal(null)
  const [open, setOpen] = createSignal(false)
  const [expanded, setExpanded] = createSignal({})
  const [detail, setDetail] = createSignal("")
  const [scope, setScope] = createSignal(api.kv?.get?.("tm_scope", "total") || "total")
  const [view, setView] = createSignal(api.kv?.get?.("tm_view", "prompt") || "prompt")

  const toggle = (path) => setExpanded((e) => ({ ...e, [path]: !e[path] }))
  const toggleDetail = (label) => setDetail((cur) => cur === label ? "" : label)
  const toggleScope = () => { const v = scope() === "total" ? "current" : "total"; try { api.kv?.set?.("tm_scope", v) } catch {} ; setScope(v) }
  const toggleView = () => { const v = view() === "prompt" ? "tool" : "prompt"; try { api.kv?.set?.("tm_view", v) } catch {} ; setView(v) }

  let disposed = false
  let unsubscribe, timer, debounce

  const refreshCapture = () => readCapture(api, props.session_id).then((d) => !disposed && setCapture(d)).catch(() => {})

  onMount(() => {
    refreshCapture()
    unsubscribe = api.event.on("message.updated", () => {
      if (debounce) clearTimeout(debounce)
      debounce = setTimeout(refreshCapture, EVENT_DEBOUNCE_MS)
    })
    timer = setInterval(refreshCapture, REFRESH_MS)
  })
  onCleanup(() => {
    disposed = true
    if (unsubscribe) unsubscribe()
    if (timer) clearInterval(timer)
    if (debounce) clearTimeout(debounce)
  })

  const head = createMemo(() => {
    const id = props.session_id
    let last
    if (id) {
      const messages = api.state.session.messages(id) || []
      for (const m of messages) if (m.role === "assistant" && (m.tokens?.output || 0) > 0) last = m
    }
    const ctx = last ? (last.tokens.input || 0) + (last.tokens.output || 0) + (last.tokens.cache?.read || 0) + (last.tokens.cache?.write || 0) : 0
    let limit = 0
    try {
      if (last) limit = api.state.provider.find((p) => p.id === last.providerID)?.models?.[last.modelID]?.limit?.context || 0
    } catch {}
    return {
      has: !!last,
      contextNow: ctx,
      cachedPct: ctx > 0 && last ? Math.round(((last.tokens.cache?.read || 0) / ctx) * 100) : 0,
      limitPct: limit > 0 ? Math.round((ctx / limit) * 100) : 0,
    }
  })

  const model = createMemo(() => {
    const cap = capture() || buildFallback(api, props.session_id)
    const sc = scope()
    if (!cap || (!Array.isArray(cap.current) && !Array.isArray(cap.total))) return { ready: false, list: [] }
    const entries = sc === "total" ? cap.total || [] : cap.current || []
    const ov = sc === "total" ? cap.overheadTotal || {} : cap.overheadCurrent || {}
    return { ready: true, list: buildList(entries, ov, sc === "total" ? "total" : "current", view()) }
  })

  const colors = () => palette(api)
  const scopeLabel = () => (scope() === "total" ? "Total" : "Aktuel")
  const viewLabel = () => (view() === "prompt" ? "Prompts" : "Tools")

  return (
    <Show when={props.session_id && enabled()}>
      <box flexDirection="column" gap={0}>
        <box flexDirection="row" gap={1} alignItems="center" onMouseDown={() => setOpen((o) => !o)}>
          <text fg={colors().text}>{open() ? "▼" : "▶"}</text>
          <text fg={colors().text}><b>Token Monsters:</b></text>
          <Show when={!open() && head().has}>
            <box flexGrow={1} justifyContent="flex-end">
              <text fg={colors().muted}>{fmtK(head().contextNow)}</text>
            </box>
          </Show>
        </box>

        <Show when={open()}>
          <box flexDirection="column" gap={0}>
            <box flexDirection="column" gap={0}>
              <Selector colors={colors()} label="Session" value={scopeLabel()} onToggle={toggleScope} />
              <Selector colors={colors()} label="View" value={viewLabel()} onToggle={toggleView} />
            </box>

            <box flexDirection="column" gap={0} paddingTop={1}>
              <Line colors={colors()} label="Context now" value={head().limitPct > 0 ? `${fmt(head().contextNow)} · ${head().limitPct}%` : fmt(head().contextNow)} strong />
              <Line colors={colors()} label="Cache hit" value={`${head().cachedPct}%`} strong />
              <Show when={detail()}>
                <box flexDirection="column" gap={0} paddingTop={1}>
                  <text fg={colors().muted}>Selected path</text>
                  <text fg={colors().muted} onMouseDown={() => setDetail("")}>{detail()}</text>
                </box>
              </Show>
            </box>

            <box flexDirection="column" gap={0} paddingTop={1}>
              <text fg={colors().muted}>{scope() === "total" ? "Total session ~approx" : "This prompt ~approx"}</text>
              <Show when={model().ready} fallback={<text fg={colors().muted}>No session data</text>}>
                <For each={model().list}>
                  {(item) => <TreeRow node={item} depth={0} path={item.label} colors={colors()} expanded={expanded} toggle={toggle} toggleDetail={toggleDetail} />}
                </For>
              </Show>
            </box>
          </box>
        </Show>
      </box>
    </Show>
  )
}

// Register the /tokenmonster slash command + command-palette entry that toggles
// the sidebar panel. The running opencode (1.17+) exposes api.keymap.registerLayer
// (slashName/run); older typed builds expose api.command.register (slash/onSelect).
// Support both so the toggle works regardless of host version.
function registerCommand(api, toggle) {
  const def = {
    name: "tokenmonster.toggle",
    title: "Token Monsters: toggle sidebar",
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
    try { setEnabled(api.kv?.get?.("tm_enabled", true) !== false) } catch {}
    const toggle = () => {
      const v = !enabled()
      try { api.kv?.set?.("tm_enabled", v) } catch {}
      setEnabled(v)
      try { api.ui?.toast?.({ variant: v ? "success" : "info", message: `Token Monsters ${v ? "shown" : "hidden"}` }) } catch {}
    }
    registerCommand(api, toggle)
    const order = typeof options?.order === "number" ? options.order : DEFAULT_ORDER
    api.slots.register({
      order,
      slots: {
        sidebar_content: (_ctx, slotProps) => <View api={api} session_id={slotProps.session_id} options={options} />,
      },
    })
  },
}

export default TokenMonsters
