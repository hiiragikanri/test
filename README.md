# Codex Local Web Demo

This is a localhost-only prototype that connects a browser UI to `codex app-server`
through a small Node.js WebSocket bridge.

## Run

```powershell
npm.cmd install
npm.cmd run dev
```

Open http://localhost:3000.

## Frontend HMR

While `npm.cmd run dev` is running, files under `public/` are watched.
CSS edits are swapped into the page without a full refresh. HTML and JS edits
trigger a browser reload.

## Flow

1. Click `初期化`.
2. Click `アカウント確認`.
3. If needed, click `ChatGPTログイン` and open the displayed auth URL.
4. Click `新規スレッド`.
5. Send a prompt.

## Environment

- `PORT`: web server port, default `3000`.
- `CODEX_WORKSPACE`: working directory passed to Codex, default this project.
- `CODEX_COMMAND`: Codex executable, default `codex.cmd` on Windows.

## Logs

Each browser connection writes a JSONL log under `logs/session-*.jsonl`.
The UI also shows the active log path at the top of the page.

The log includes UI messages, JSON-RPC requests/responses, Codex stderr, process
errors, and exit codes. Email addresses, tokens, secrets, and auth/device codes
are redacted before being written.

This is for local experiments. Do not expose it directly to the public internet.
