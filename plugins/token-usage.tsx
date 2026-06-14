/** @jsxImportSource @opentui/solid */

// Token usage sidebar for opencode.
//
// Shows, for the current session (+ its subagents), where the token budget goes.
//
//   Reported  - exact numbers from opencode (context size, output, cost).
//   ~approx   - a breakdown of the actual content that fills the context,
//               tokenized client-side with gpt-tokenizer (o200k_base):
//                 System+tools base, AGENTS.md, Skills, per-tool, Conversation, Files.
//
// What can / cannot be itemized:
//   * AGENTS.md, per-tool output+args, skills, conversation, files -> measured
//     from stored message parts.
//   * The opencode system prompt + tool definitions are never exposed, so they
//     are estimated as the FIRST request's prompt size (which contains only the
//     scaffolding) minus the first user message and AGENTS.md.
//   * "Thinking" is folded into output by Copilot/Claude (reasoning text is not
//     persisted), so it cannot be shown separately.
// Counts use the OpenAI o200k tokenizer; for Claude they are approximate, hence
// the "~approx" label.

import { createMemo, createSignal, onCleanup, onMount, For, Show } from "solid-js"
import { countTokens } from "gpt-tokenizer"

const PLUGIN_ID = "token-usage"
const DEFAULT_ORDER = 150 // sits just after the built-in Context block (100)
const CHILD_REFRESH_MS = 15000
const EVENT_DEBOUNCE_MS = 800
const TOOL_ROWS = 6 // collapse the long tail of tools into "other tools"

const NUM = new Intl.NumberFormat("en-US")
const USD = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
})

function fmt(n) {
  return NUM.format(Math.round(Number(n) || 0))
}

function fmtK(n) {
  n = Number(n) || 0
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(2)}M`
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`
  return String(Math.round(n))
}

function clip(value, width) {
  const s = String(value)
  if (s.length <= width) return s
  return `${s.slice(0, Math.max(0, width - 1))}…`
}

// ---------------------------------------------------------------------------
// Tokenization (cached by a stable key so each part is tokenized once).
// ---------------------------------------------------------------------------

const tokenCache = new Map()

function tokenize(text, key) {
  if (typeof text !== "string" || text.length === 0) return 0
  if (key && tokenCache.has(key)) return tokenCache.get(key)

  let n
  try {
    n = countTokens(text, { allowedSpecial: "all" })
  } catch {
    try {
      n = countTokens(text)
    } catch {
      n = Math.ceil(text.length / 4)
    }
  }
  if (typeof n !== "number" || !Number.isFinite(n)) n = Math.ceil(text.length / 4)

  if (key) {
    tokenCache.set(key, n)
    if (tokenCache.size > 8000) tokenCache.delete(tokenCache.keys().next().value)
  }
  return n
}

// ---------------------------------------------------------------------------
// Bucketing of message parts.
// ---------------------------------------------------------------------------

const SKILL_KEY = "Skills"
const CONVERSATION_KEY = "Conversation"
const FILES_KEY = "Files"
const TOOL_PREFIX = "tool:"

function addBucket(buckets, key, tokens) {
  if (tokens > 0) buckets.set(key, (buckets.get(key) || 0) + tokens)
}

function bucketPart(part, buckets) {
  if (!part || !part.type) return
  if (part.type === "text") {
    if (part.synthetic) return
    addBucket(buckets, CONVERSATION_KEY, tokenize(part.text, `t:${part.id}:${part.text?.length || 0}`))
  } else if (part.type === "tool") {
    const name = part.tool || "tool"
    const out = typeof part.state?.output === "string" ? part.state.output : ""
    const args = part.state?.input ? safeJson(part.state.input) : ""
    const key = `t:${part.id}:${part.state?.status || ""}:${out.length}:${args.length}`
    const tokens = tokenize(out, key + ":o") + tokenize(args, key + ":a")
    addBucket(buckets, name === "skill" ? SKILL_KEY : TOOL_PREFIX + name, tokens)
  } else if (part.type === "file") {
    const value = part.source?.text?.value
    if (typeof value === "string") addBucket(buckets, FILES_KEY, tokenize(value, `t:${part.id}:${value.length}`))
  }
}

function safeJson(value) {
  try {
    return JSON.stringify(value)
  } catch {
    return ""
  }
}

function emptyAgg() {
  return { output: 0, cost: 0, buckets: new Map() }
}

// entries: Array<{ info: Message, parts: Part[] }>
function accumulate(entries, agg) {
  for (const entry of entries) {
    const info = entry?.info
    if (info?.role === "assistant" && info.tokens) {
      agg.output += info.tokens.output || 0
      agg.cost += info.cost || 0
    }
    for (const part of entry?.parts || []) bucketPart(part, agg.buckets)
  }
}

// ---------------------------------------------------------------------------
// Subagents (child sessions) - fetched async via the SDK client.
// ---------------------------------------------------------------------------

async function fetchChildren(api, sessionID) {
  const agg = emptyAgg()
  try {
    if (typeof api.client?.session?.children !== "function") return agg
    const res = await api.client.session.children({ sessionID })
    for (const kid of res?.data ?? res ?? []) {
      if (!kid?.id) continue
      try {
        const mres = await api.client.session.messages({ sessionID: kid.id })
        accumulate(mres?.data ?? mres ?? [], agg)
      } catch {}
    }
  } catch {}
  return agg
}

// ---------------------------------------------------------------------------
// Instruction files (AGENTS.md / rules).
// ---------------------------------------------------------------------------

function isAbsolute(p) {
  return /^([a-zA-Z]:[\\/]|\/|\\\\)/.test(p)
}

function join(base, rel) {
  if (!base) return rel
  return `${base.replace(/[\\/]+$/, "")}/${rel}`
}

function instructionFiles(api) {
  const path = api.state?.path || {}
  const out = new Set()
  for (const base of [path.config, path.worktree, path.directory]) {
    if (base && base !== "/") out.add(join(base, "AGENTS.md"))
  }
  const instr = api.state?.config?.instructions
  if (Array.isArray(instr)) {
    for (const entry of instr) {
      if (typeof entry !== "string" || entry.includes("*")) continue
      out.add(isAbsolute(entry) ? entry : join(path.directory || path.worktree || path.config || ".", entry))
    }
  }
  return [...out]
}

async function readInstructions(api) {
  let total = 0
  if (typeof Bun === "undefined") return 0
  for (const file of instructionFiles(api)) {
    try {
      const handle = Bun.file(file)
      if (!(await handle.exists())) continue
      const text = await handle.text()
      total += tokenize(text, `instr:${file}:${text.length}`)
    } catch {}
  }
  return total
}

// ---------------------------------------------------------------------------
// Exact overhead (system prompt + tool definitions) captured by the companion
// server plugin (token-usage-capture.ts) and written to a shared cache file.
// ---------------------------------------------------------------------------

async function readCapture(api, sessionID) {
  try {
    if (typeof Bun === "undefined") return null
    const dir = api.state?.path?.config
    if (!dir) return null
    const file = Bun.file(join(dir, ".token-usage-cache.json"))
    if (!(await file.exists())) return null
    const data = await file.json()
    return { session: data?.sessions?.[sessionID], tools: data?.tools }
  } catch {
    return null
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

// Recursive, foldable breakdown row. A node is { label, tokens, frac, children? }.
function TreeRow(props) {
  const node = props.node
  const foldable = !!(node.children && node.children.length > 0)
  const isOpen = () => !!props.expanded()[props.path]
  const labelStr = () => " ".repeat(props.depth) + (foldable ? (isOpen() ? "▼ " : "▶ ") : "") + node.label
  return (
    <box flexDirection="column" gap={0}>
      <box
        flexDirection="row"
        gap={1}
        alignItems="center"
        onMouseDown={foldable ? () => props.toggle(props.path) : undefined}
      >
        <box width={14}>
          <text fg={props.depth > 0 ? props.colors.muted : props.colors.text}>{clip(labelStr(), 14)}</text>
        </box>
        <box flexGrow={1}>
          <Bar colors={props.colors} frac={node.frac} dim={props.depth > 0} />
        </box>
        <box width={7} justifyContent="flex-end">
          <text fg={props.colors.muted}>{fmtK(node.tokens)}</text>
        </box>
      </box>
      <Show when={foldable && isOpen()}>
        <For each={node.children}>
          {(child) => (
            <TreeRow
              node={child}
              depth={props.depth + 1}
              path={`${props.path}/${child.label}`}
              colors={props.colors}
              expanded={props.expanded}
              toggle={props.toggle}
            />
          )}
        </For>
      </Show>
    </box>
  )
}

// ---------------------------------------------------------------------------
// Main view.
// ---------------------------------------------------------------------------

function View(props) {
  const [childAgg, setChildAgg] = createSignal(emptyAgg())
  const [instrTokens, setInstrTokens] = createSignal(0)
  const [capture, setCapture] = createSignal(null)
  const [open, setOpen] = createSignal(false) // whole block folded by default
  const [expanded, setExpanded] = createSignal({}) // per-row child fold state
  const toggle = (label) => setExpanded((e) => ({ ...e, [label]: !e[label] }))

  let disposed = false
  let unsubscribe
  let timer
  let debounce

  const refreshChildren = () => {
    fetchChildren(props.api, props.session_id)
      .then((agg) => !disposed && setChildAgg(agg))
      .catch(() => {})
  }
  const refreshInstructions = () => {
    readInstructions(props.api)
      .then((tokens) => !disposed && setInstrTokens(tokens))
      .catch(() => {})
  }
  const refreshCapture = () => {
    readCapture(props.api, props.session_id)
      .then((data) => !disposed && setCapture(data))
      .catch(() => {})
  }

  onMount(() => {
    refreshInstructions()
    refreshChildren()
    refreshCapture()
    unsubscribe = props.api.event.on("message.updated", () => {
      if (debounce) clearTimeout(debounce)
      debounce = setTimeout(() => {
        refreshChildren()
        refreshCapture()
      }, EVENT_DEBOUNCE_MS)
    })
    timer = setInterval(() => {
      refreshChildren()
      refreshCapture()
    }, CHILD_REFRESH_MS)
  })

  onCleanup(() => {
    disposed = true
    if (unsubscribe) unsubscribe()
    if (timer) clearInterval(timer)
    if (debounce) clearTimeout(debounce)
  })

  // Main session: reactive over messages + parts -> recomputes every message.
  const main = createMemo(() => {
    const id = props.session_id
    const agg = emptyAgg()
    const turnsRaw = []
    let turn = null
    let firstAssistant
    let lastAssistant
    let firstUserText = ""
    if (id) {
      const messages = props.api.state.session.messages(id) || []
      for (const message of messages) {
        const parts = props.api.state.part(message.id) || []
        accumulate([{ info: message, parts }], agg)
        if (message.role === "assistant" && (message.tokens?.output || 0) > 0) {
          if (!firstAssistant) firstAssistant = message
          lastAssistant = message
        }
        // Text tokens of this message (cached by part id).
        const textTokens = parts
          .filter((p) => p.type === "text" && !p.synthetic && typeof p.text === "string")
          .reduce((sum, p) => sum + tokenize(p.text, `t:${p.id}:${p.text.length}`), 0)
        if (message.role === "user") {
          // A user message starts a new turn (its text = the turn's Input).
          if (turn) turnsRaw.push(turn)
          turn = { input: textTokens, output: 0 }
          if (!firstUserText) {
            firstUserText = parts
              .filter((p) => p.type === "text" && typeof p.text === "string")
              .map((p) => p.text)
              .join("\n")
          }
        } else if (message.role === "assistant") {
          // Assistant reply text adds to the current turn's Output.
          if (!turn) turn = { input: 0, output: 0 }
          turn.output += textTokens
        }
      }
      if (turn) turnsRaw.push(turn)
    }
    const convTurns = turnsRaw
      .map((t) => ({ input: t.input, output: t.output, tokens: t.input + t.output }))
      .filter((t) => t.tokens > 0)
      .map((t, i) => ({ ...t, label: `Msg ${i + 1}` }))
    const reqSize = (m) => (m ? (m.tokens.input || 0) + (m.tokens.cache?.read || 0) + (m.tokens.cache?.write || 0) : 0)
    return {
      agg,
      convTurns,
      hasAssistant: !!lastAssistant,
      last: lastAssistant,
      contextNow: reqSize(lastAssistant),
      cacheRead: lastAssistant ? lastAssistant.tokens.cache?.read || 0 : 0,
      firstReq: reqSize(firstAssistant),
      firstUserTokens: firstUserText ? tokenize(firstUserText, `first:${id}:${firstUserText.length}`) : 0,
    }
  })

  // Model context limit (to make the "context" number make sense), if known.
  const contextLimit = createMemo(() => {
    const last = main().last
    if (!last) return 0
    try {
      const provider = props.api.state.provider.find((p) => p.id === last.providerID)
      return provider?.models?.[last.modelID]?.limit?.context || 0
    } catch {
      return 0
    }
  })

  const model = createMemo(() => {
    const m = main()
    const child = childAgg()
    const agents = instrTokens()

    const output = m.agg.output + child.output
    const cost = m.agg.cost + child.cost

    // Merge estimated buckets (main + subagents).
    const buckets = new Map(m.agg.buckets)
    for (const [key, value] of child.buckets) addBucket(buckets, key, value)

    const cap = capture()
    const toolsTotal = cap?.tools?.total || 0
    const list = []

    // --- Fixed overhead (sent on every request) ---
    if (cap?.session) {
      // Exact split captured by the companion server plugin.
      const s = cap.session
      const opencode = (s.base || 0) + (s.environment || 0)
      if (opencode > 0) list.push({ label: "opencode", tokens: opencode })
      const agentsTok = s.agents || agents
      if (agentsTok > 0) list.push({ label: "AGENTS.md", tokens: agentsTok })
      if ((s.skills || 0) > 0) list.push({ label: "skill defs", tokens: s.skills })
    } else if (toolsTotal > 0) {
      // Tool defs known but no per-session system split yet. Estimate the system
      // prompt ALONE (first request minus user msg, AGENTS.md and tool defs) so it
      // does not double-count the "tool defs" line below.
      const sys = m.firstReq > 0 ? Math.max(0, m.firstReq - m.firstUserTokens - agents - toolsTotal) : 0
      if (sys > 0) list.push({ label: "opencode~", tokens: sys })
      if (agents > 0) list.push({ label: "AGENTS.md", tokens: agents })
    } else {
      // No capture at all (before the first request): single lumped estimate.
      const base = m.firstReq > 0 ? Math.max(0, m.firstReq - m.firstUserTokens - agents) : 0
      if (base > 0) list.push({ label: "system+tools~", tokens: base })
      if (agents > 0) list.push({ label: "AGENTS.md", tokens: agents })
    }
    if (toolsTotal > 0) {
      const entries = Object.entries(cap.tools.byTool || {})
        .map(([label, tokens]) => ({ label, tokens }))
        .sort((a, b) => b.tokens - a.tokens)
      const childMax = entries.reduce((mx, e) => Math.max(mx, e.tokens), 0)
      const children = entries.map((e) => ({ ...e, frac: childMax > 0 ? e.tokens / childMax : 0 }))
      list.push({ label: "tool defs", tokens: toolsTotal, children })
    }

    // --- Per-tool output (results + call args) ---
    const tools = [...buckets.entries()]
      .filter(([key]) => key.startsWith(TOOL_PREFIX))
      .map(([key, value]) => ({ label: key.slice(TOOL_PREFIX.length), tokens: value }))
      .sort((a, b) => b.tokens - a.tokens)
    for (const t of tools.slice(0, TOOL_ROWS)) list.push(t)
    const tail = tools.slice(TOOL_ROWS).reduce((sum, t) => sum + t.tokens, 0)
    if (tail > 0) list.push({ label: "other tools", tokens: tail })

    // --- Loaded skill content + conversation + files ---
    const skillsOut = buckets.get(SKILL_KEY) || 0
    if (skillsOut > 0) list.push({ label: "skills", tokens: skillsOut })
    const conversation = buckets.get(CONVERSATION_KEY) || 0
    if (conversation > 0) {
      const turns = m.convTurns || []
      const turnMax = turns.reduce((mx, t) => Math.max(mx, t.tokens), 0)
      const children = turns.map((t) => {
        const subMax = Math.max(t.input, t.output)
        return {
          label: t.label,
          tokens: t.tokens,
          frac: turnMax > 0 ? t.tokens / turnMax : 0,
          children: [
            { label: "Input", tokens: t.input, frac: subMax > 0 ? t.input / subMax : 0 },
            { label: "Output", tokens: t.output, frac: subMax > 0 ? t.output / subMax : 0 },
          ],
        }
      })
      list.push({ label: "Conversation", tokens: conversation, children })
    }
    const files = buckets.get(FILES_KEY) || 0
    if (files > 0) list.push({ label: "Files", tokens: files })

    const maxTokens = list.reduce((max, item) => Math.max(max, item.tokens), 0)
    for (const item of list) item.frac = maxTokens > 0 ? item.tokens / maxTokens : 0
    const limit = contextLimit()

    return {
      hasAssistant: m.hasAssistant,
      contextNow: m.contextNow,
      cachedPct: m.contextNow > 0 ? Math.round((m.cacheRead / m.contextNow) * 100) : 0,
      limitPct: limit > 0 ? Math.round((m.contextNow / limit) * 100) : 0,
      output,
      cost,
      list,
      maxTokens,
    }
  })

  const colors = () => palette(props.api)

  return (
    <Show when={props.session_id}>
      <box flexDirection="column" gap={0}>
        <box flexDirection="row" gap={1} alignItems="center" onMouseDown={() => setOpen((o) => !o)}>
          <text fg={colors().text}>{open() ? "▼" : "▶"}</text>
          <text fg={colors().text}>
            <b>Token Monsters:</b>
          </text>
          <Show when={!open() && model().hasAssistant}>
            <box flexGrow={1} justifyContent="flex-end">
              <text fg={colors().muted}>{fmtK(model().contextNow)}</text>
            </box>
          </Show>
        </box>

        <Show when={open()}>
          <Show when={model().hasAssistant} fallback={<text fg={colors().muted}>No usage yet</text>}>
            <box flexDirection="column" gap={0}>
              <Line
                colors={colors()}
                label="Context"
                value={model().limitPct > 0 ? `${fmt(model().contextNow)} · ${model().limitPct}%` : fmt(model().contextNow)}
                strong
              />
              <Line colors={colors()} label="Output" value={fmt(model().output)} />
              <Line colors={colors()} label="Cost" value={USD.format(model().cost)} strong />
              <Show when={model().cachedPct > 0}>
                <text fg={colors().muted}>{`cache hit ${model().cachedPct}%`}</text>
              </Show>

              <Show when={model().list.length > 0}>
                <box flexDirection="column" gap={0} paddingTop={1}>
                  <text fg={colors().muted}>Where it goes ~approx</text>
                  <For each={model().list}>
                    {(item) => (
                      <TreeRow node={item} depth={0} path={item.label} colors={colors()} expanded={expanded} toggle={toggle} />
                    )}
                  </For>
                </box>
              </Show>
            </box>
          </Show>
        </Show>
      </box>
    </Show>
  )
}

const plugin = {
  id: PLUGIN_ID,
  async tui(api, options) {
    if (options?.enabled === false) return
    const order = typeof options?.order === "number" ? options.order : DEFAULT_ORDER
    api.slots.register({
      order,
      slots: {
        sidebar_content: (_ctx, slotProps) => <View api={api} session_id={slotProps.session_id} options={options} />,
      },
    })
  },
}

export default plugin
