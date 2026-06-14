# Token Monsters

A scrappy [opencode](https://opencode.ai) sidebar plugin that shows, **very roughly**, where the tokens in your current session are going: the system prompt, tool definitions, AGENTS.md, skills, per-tool output, and the conversation itself.

```
▼ Token Monsters:
Context           15,213 · 2%
Output                28
Cost               $0.02
cache hit 100%
Where it goes ~approx
opencode~             90
AGENTS.md            201
▶ tool defs        14.9k
▼ Conversation        21
  ▼ Msg 1             11
     Input             2
     Output            9
  ▶ Msg 2             10
```

Everything is foldable and folded by default. Click the title to expand, click a row with a `▶` to drill in (`tool defs` → per tool, `Conversation` → per message → input/output).

## ⚠️ Read this first

This is **not** a polished or accurate tool. It is a quick hack made purely out of curiosity — to get a rough feeling for **where your tokens roughly disappear to** inside opencode.

- All numbers are **approximate** and counted with the OpenAI **o200k** tokenizer (`gpt-tokenizer`). If you use Claude / Copilot / anything non‑OpenAI, the real token counts differ (often 20–40% higher for code and JSON), so treat everything as a **ballpark**.
- The categories do **not** add up cleanly to the reported context. Different tokenizer + hidden "thinking" tokens (not stored) + provider accounting all make the math fuzzy.
- `opencode~` and `system+tools~` (the `~` means estimate) are derived by subtraction, not measured exactly.
- No tests, no guarantees, written quickly. Expect rough edges. PRs welcome but don't expect this to be maintained.

If you want exact accounting, this is the wrong tool. If you just want to see "oh, *that's* what's eating my context," it does the job.

## What it shows

**Reported (exact, from opencode):**
- `Context` – the current request's prompt size (input + cache), and % of the model's context limit if known
- `Output` – generated tokens (cumulative, incl. tool-call JSON + thinking)
- `Cost` – session cost
- `cache hit` – share of the context served from cache

**Breakdown (`~approx`, tokenized client-side):**
- `opencode` – the base system prompt (+ environment)
- `AGENTS.md` – your instruction/rules files
- `skill defs` – the skill descriptions injected into the system prompt
- `tool defs` – the tool schemas sent to the model, expandable per tool
- per-tool rows (`bash`, `read`, …) – each tool's **output + call args**, summed over the session
- `skills` – content loaded by the `skill` tool
- `Conversation` – your messages + replies, expandable per turn into `Input` / `Output`
- `Files` – attached file contents

Subagent (child session) usage is folded into the totals.

## How it works

opencode never exposes the system prompt or tool definitions to a sidebar/TUI plugin, so this ships **two** pieces:

1. **`plugins/token-usage-capture.ts`** – a *server* plugin. It hooks `experimental.chat.system.transform` (the assembled system prompt) and `tool.definition` (each tool's schema), tokenizes them, and writes a small `~/.config/opencode/.token-usage-cache.json`.
2. **`plugins/token-usage.tsx`** – the *TUI* plugin. It reads that cache plus the live session messages/parts and renders the foldable sidebar block.

Everything else (per-tool output, conversation, files) is read from the session's message parts and tokenized on the fly (cached per part).

## Install (global)

Requires opencode ≥ 1.4 and Bun.

1. Copy both files into your global plugins dir:
   - `plugins/token-usage.tsx` → `~/.config/opencode/plugins/token-usage.tsx`
   - `plugins/token-usage-capture.ts` → `~/.config/opencode/plugins/token-usage-capture.ts`

2. Add the dependency in `~/.config/opencode/package.json` (see [`example/package.json`](example/package.json)):
   ```json
   { "dependencies": { "gpt-tokenizer": "^3.4.0" } }
   ```
   (opencode also needs `@opencode-ai/plugin`, `@opentui/core`, `@opentui/solid`, `solid-js` available in that dir for TUI plugins.)

3. Register the TUI plugin in `~/.config/opencode/tui.json` (see [`example/tui.json`](example/tui.json)):
   ```json
   { "$schema": "https://opencode.ai/tui.json", "plugin": ["./plugins/token-usage.tsx"] }
   ```
   The server plugin auto-loads from `plugins/` — no entry needed.

4. Restart opencode. The exact `opencode` / `skill defs` / `tool defs` split appears after the first message of a session (when the capture hooks fire).

### Options

In `tui.json` you can pass options to the TUI plugin:

```json
{ "plugin": [["./plugins/token-usage.tsx", { "enabled": true, "order": 150 }]] }
```

- `enabled: false` – disable without removing it
- `order` – position among sidebar blocks (built-in Context is `100`)

## License

MIT
