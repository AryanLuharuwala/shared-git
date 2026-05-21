# surd

Git-like repository with real-time CRDT collaboration and shared Claude Code sessions.

Git remains the source of truth for committed history (any remote: GitHub, Gitea,
self-hosted). `surd` layers live multi-collaborator sync on top:

- Every keystroke syncs through a Yjs CRDT — Google-Docs-style concurrent edits
- Offline edits merge automatically when peers reconnect
- Branches / commits / push / pull are plain git
- Claude Code sessions for the repo are mirrored to every collaborator in real time

## Workflow

```bash
# Bootstrap (standard git)
git clone git@github.com:you/myrepo.git
cd myrepo

# Join the live session
surd link wss://surd.example.com myrepo
surd watch              # starts the sync daemon

# Edit files in your editor — changes stream to peers immediately
# Commit / push as usual:
git add . && git commit -m "..." && git push
```

The `surd` server can be self-hosted on any machine reachable by collaborators
(VPS, a laptop with a tunnel, a NAS). It only needs to persist Yjs document
state + a small SQLite index — no working trees, no git clones.

## Components

- `server/` — Node.js WebSocket sync hub
- `cli/` — `surd` command line client + sync daemon
- `shared/` — protocol constants and types
- `vscode-extension/` — VS Code extension that surfaces shared Claude sessions
