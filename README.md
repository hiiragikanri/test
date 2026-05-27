# Codex Local Web Demo

This is a small Node.js web UI that connects a browser to `codex app-server`
through a WebSocket bridge.

Live test URL:

https://test-hy6s.onrender.com/

## Important Security Note

This app uses the Codex authentication stored on the machine/server that runs
`codex app-server`. On a public host, visitors can use that server-side Codex
account unless you add your own access control and user isolation.

Use this as a trusted prototype, not as an open public chat service.

## Run Locally

```powershell
npm.cmd install
npm.cmd run dev
```

Open http://localhost:3000.

## Flow

1. Click `Reset Auth` if the existing token is stale.
2. Click `Device Login`.
3. Enter the displayed code on the displayed auth page.
4. Wait for login completion.
5. Click `New Thread`.
6. Send a prompt.

Do not use the browser OAuth callback URL if you see one like
`http://localhost:1455/auth/callback?...`. That flow is for a local Codex
callback listener and does not work from the Render-hosted page. Use
`Device Login` instead.

## Frontend HMR

While `npm.cmd run dev` is running, files under `public/` are watched.
CSS edits are swapped into the page without a full refresh. HTML and JS edits
trigger a browser reload.

## Environment

- `PORT`: web server port, default `3000`.
- `CODEX_WORKSPACE`: working directory passed to Codex, default this project.
- `CODEX_COMMAND`: Codex executable, default `codex.cmd` on Windows and `codex` elsewhere.

## Logs

Each browser connection writes a JSONL log under `logs/session-*.jsonl`.
The UI also shows the active log path at the top of the page.

The log includes UI messages, JSON-RPC requests/responses, Codex stderr, process
errors, and exit codes. Email addresses, tokens, secrets, and auth/device codes
are redacted before being written.
