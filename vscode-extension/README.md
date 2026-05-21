# surd — Live Repo & Claude Session Sync

VS Code extension for [surd](https://github.com/surd/surd), a git-aware live
collaboration layer. Surfaces the live Claude Code session feed for the linked
repo so every collaborator sees every Claude message in real time.

## Setup

1. Install the [surd CLI](https://github.com/surd/surd): `npm i -g @surd/cli`
2. In your repo: `surd link wss://your-surd-server`
3. Start the sync daemon: `surd watch`
4. Open the repo in VS Code — the extension auto-connects and shows the
   "Surd — Live Claude Feed" view in the Explorer.

## Commands

- **Surd: Open Live Claude Panel** — opens the help panel
- **Surd: Link Workspace to Server** — runs `surd link` in a terminal

## Settings

- `surd.server` — surd server WebSocket URL (default `ws://localhost:4455`)
- `surd.token` — optional bearer token if the server requires auth
