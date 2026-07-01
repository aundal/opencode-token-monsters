# Token Monsters for OpenCode

Token Monsters adds a token usage sidebar to OpenCode. It shows the current context size, cache hit percentage, session totals, current prompt totals, prompt/tool/file breakdowns, and tool-definition overhead.

## Install

Add the plugin to your OpenCode config.

`~/.config/opencode/opencode.json`

```json
{
  "$schema": "https://opencode.ai/config.json",
  "plugin": [
    "@aundal/opencode-token-monsters@latest"
  ]
}
```

Restart OpenCode after saving. OpenCode installs npm plugins automatically at startup.

## Usage

Token Monsters appears in the session sidebar.

Use `/tokenmonster` to hide or show the sidebar panel.

## Views

- `Session: Total` shows everything captured since the session started.
- `Session: Aktuel` shows the last request only.
- `View: Prompts` groups usage per prompt turn.
- `View: Tools` aggregates tool and file usage.

## Package

The package exports one OpenCode plugin module with both server and TUI hooks. The server hook writes token capture data, and the TUI hook renders the sidebar.

## Development

```sh
bun install
bun run build
npm pack
```

## Publish

```sh
npm publish --access public
```

## License

MIT
