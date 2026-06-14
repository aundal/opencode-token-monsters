import type { Plugin } from "@opencode-ai/plugin"
import { countTokens } from "gpt-tokenizer"
import { existsSync, readFileSync, writeFileSync } from "node:fs"
import { dirname, join } from "node:path"

// ---------------------------------------------------------------------------
// token-usage-capture (server plugin)
//
// The TUI sidebar cannot see opencode's system prompt or tool definitions -
// they are never stored on messages. This server plugin hooks the two points
// where that text actually exists:
//
//   experimental.chat.system.transform -> the full system prompt (string[])
//   tool.definition                     -> each tool's description + schema
//
// It tokenizes them (gpt-tokenizer / o200k, same as the sidebar) and writes a
// compact cache file that the TUI plugin reads to show an exact overhead split:
// opencode prompt / AGENTS.md / skill descriptions / tool definitions.
// ---------------------------------------------------------------------------

const CONFIG_DIR = dirname(import.meta.dir) // plugins/ -> config dir
const CACHE_FILE = join(CONFIG_DIR, ".token-usage-cache.json")
const WRITE_DEBOUNCE_MS = 750

const tok = (s: string) => {
  if (typeof s !== "string" || !s) return 0
  try {
    return countTokens(s, { allowedSpecial: "all" })
  } catch {
    return Math.ceil((s || "").length / 4)
  }
}

// In-memory state (persists for the life of the server process).
const tools: Record<string, number> = {}
const sessions: Record<string, { base: number; environment: number; agents: number; skills: number; total: number }> = {}

let writeTimer: ReturnType<typeof setTimeout> | undefined
function scheduleWrite() {
  if (writeTimer) return
  writeTimer = setTimeout(() => {
    writeTimer = undefined
    try {
      const toolsTotal = Object.values(tools).reduce((a, b) => a + b, 0)
      writeFileSync(
        CACHE_FILE,
        JSON.stringify({ tools: { total: toolsTotal, byTool: tools }, sessions, updatedAt: Date.now() }),
      )
    } catch {}
  }, WRITE_DEBOUNCE_MS)
}

// Collect AGENTS.md / rules contents that might be embedded in the system prompt.
function instructionTexts(directory?: string, worktree?: string): string[] {
  const out: string[] = []
  const seen = new Set<string>()
  for (const base of [CONFIG_DIR, worktree, directory]) {
    if (!base || base === "/") continue
    const file = join(base, "AGENTS.md")
    if (seen.has(file)) continue
    seen.add(file)
    try {
      if (existsSync(file)) out.push(readFileSync(file, "utf8").trim())
    } catch {}
  }
  return out
}

function classifySystem(system: string, instructions: string[]) {
  const total = tok(system)

  // Skill descriptions: the "<available_skills>...</available_skills>" block
  // (plus the short intro line opencode puts before it, when present).
  let skills = 0
  const skillEnd = system.indexOf("</available_skills>")
  if (skillEnd >= 0) {
    let start = system.indexOf("<available_skills>")
    const intro = system.lastIndexOf("Skills provide", start)
    if (intro >= 0 && start - intro < 400) start = intro
    if (start >= 0) skills = tok(system.slice(start, skillEnd + "</available_skills>".length))
  }

  // Environment block.
  let environment = 0
  const envIdx = system.search(/Here is some useful information about the environment/i)
  if (envIdx >= 0) {
    const envEnd = system.indexOf("</env>", envIdx)
    environment = tok(system.slice(envIdx, envEnd > 0 ? envEnd + 6 : Math.min(system.length, envIdx + 800)))
  }

  // AGENTS.md / rules: instruction files whose text is embedded in the prompt.
  let agents = 0
  for (const text of instructions) {
    const probe = text.slice(0, 80)
    if (probe && system.includes(probe)) agents += tok(text)
  }

  const base = Math.max(0, total - skills - environment - agents)
  return { base, environment, agents, skills, total }
}

export const TokenUsageCapture: Plugin = async ({ directory, worktree }) => {
  return {
    "tool.definition": async (input, output) => {
      try {
        const id = input.toolID
        if (!id || id in tools) return // tool schemas are static; measure once
        tools[id] = tok(output.description || "") + tok(JSON.stringify(output.parameters ?? {}))
        scheduleWrite()
      } catch {}
    },

    "experimental.chat.system.transform": async (input, output) => {
      try {
        const sessionID = input.sessionID
        if (!sessionID || !Array.isArray(output.system)) return
        const joined = output.system.join("\n")
        const prev = sessions[sessionID]
        // Re-tokenize only when the prompt size changes (cheap guard).
        if (prev && prev.total > 0 && Math.abs(prev.total - Math.ceil(joined.length / 4)) < 50) return
        sessions[sessionID] = classifySystem(joined, instructionTexts(directory, worktree))
        scheduleWrite()
      } catch {}
    },
  }
}

export default TokenUsageCapture
