const express = require("express");
const fs = require("fs");
const http = require("http");
const path = require("path");
const { spawn } = require("child_process");
const { WebSocketServer } = require("ws");

const PORT = Number(process.env.PORT || 3000);
const DEFAULT_CWD = process.env.CODEX_WORKSPACE || process.cwd();
const CODEX_COMMAND = process.env.CODEX_COMMAND || (process.platform === "win32" ? "codex.cmd" : "codex");
const USE_SHELL = process.platform === "win32" && /\.(cmd|bat)$/i.test(CODEX_COMMAND);
const LOG_DIR = path.join(__dirname, "logs");

fs.mkdirSync(LOG_DIR, { recursive: true });

const app = express();
app.use(express.static(path.join(__dirname, "public")));

const server = http.createServer(app);
const wss = new WebSocketServer({ noServer: true });
const hmrWss = new WebSocketServer({ noServer: true });
const PUBLIC_DIR = path.join(__dirname, "public");

function send(ws, payload) {
  if (ws.readyState === ws.OPEN) {
    ws.send(JSON.stringify(payload));
  }
}

function broadcast(wssInstance, payload) {
  for (const client of wssInstance.clients) {
    send(client, payload);
  }
}

function safeTimestampForFile(date = new Date()) {
  return date.toISOString().replace(/[:.]/g, "-");
}

function redactForLog(value) {
  if (Array.isArray(value)) return value.map(redactForLog);
  if (!value || typeof value !== "object") return value;

  const copy = {};
  for (const [key, item] of Object.entries(value)) {
    if (/^(email|token|secret|apiKey|accessToken|refreshToken|idToken|userCode|deviceCode|authCode)$/i.test(key) && typeof item === "string") {
      copy[key] = "[redacted]";
    } else if (key === "text" && typeof item === "string") {
      copy[key] = item.length > 4000 ? `${item.slice(0, 4000)}...[truncated]` : item;
    } else {
      copy[key] = redactForLog(item);
    }
  }
  return copy;
}

function createLogger() {
  const sessionId = safeTimestampForFile();
  const filePath = path.join(LOG_DIR, `session-${sessionId}.jsonl`);

  function write(event, details = {}) {
    const entry = {
      ts: new Date().toISOString(),
      event,
      ...redactForLog(details),
    };
    fs.appendFile(filePath, `${JSON.stringify(entry)}\n`, (error) => {
      if (error) console.error("failed to write log", error);
    });
  }

  write("session.created", {
    cwd: DEFAULT_CWD,
    codexCommand: CODEX_COMMAND,
    pid: process.pid,
  });

  return { filePath, write };
}

function createCodexSession(ws) {
  let nextId = 1;
  let buffer = "";
  let initializeRequestId = null;
  let initialized = false;
  const pending = new Map();
  const logger = createLogger();

  const child = spawn(CODEX_COMMAND, ["app-server", "--listen", "stdio://"], {
    cwd: DEFAULT_CWD,
    stdio: ["pipe", "pipe", "pipe"],
    env: { ...process.env },
    windowsHide: true,
    shell: USE_SHELL,
  });
  logger.write("codex.spawned", { pid: child.pid, command: CODEX_COMMAND, args: ["app-server", "--listen", "stdio://"] });

  function request(method, params = {}) {
    const id = nextId++;
    const message = { jsonrpc: "2.0", id, method, params };
    logger.write("rpc.client.request", { id, method, params });
    child.stdin.write(`${JSON.stringify(message)}\n`);
    return id;
  }

  function notify(method, params = {}) {
    logger.write("rpc.client.notification", { method, params });
    child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method, params })}\n`);
  }

  function reply(id, result) {
    logger.write("rpc.client.response", { id, result });
    child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, result })}\n`);
  }

  function failRequest(id, message) {
    logger.write("rpc.client.error", { id, message });
    child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, error: { code: -32000, message } })}\n`);
  }

  function handleServerMessage(message) {
    logger.write("rpc.server.message", { message });
    send(ws, { type: "codex-message", message });

    if (message.id !== undefined && (message.result !== undefined || message.error !== undefined)) {
      const pendingRequest = pending.get(message.id);
      if (pendingRequest) {
        pending.delete(message.id);
        if (pendingRequest.method === "initialize" && !message.error) {
          initialized = true;
        }
        if (message.error) {
          logger.write("rpc.server.error", { request: pendingRequest, response: message });
        }
        send(ws, { type: "rpc-result", request: pendingRequest, response: message });
      }
      return;
    }

    if (message.id !== undefined && message.method) {
      // App-server can ask the client to approve commands or patches. The demo
      // starts with conservative settings, so unexpected client requests are denied.
      send(ws, { type: "client-request", request: message });
      if (/approval/i.test(message.method)) {
        reply(message.id, { decision: "deny", reason: "Denied by demo client default." });
      } else {
        failRequest(message.id, `Demo client does not implement ${message.method}`);
      }
    }
  }

  child.stdout.on("data", (chunk) => {
    buffer += chunk.toString("utf8");
    const lines = buffer.split(/\r?\n/);
    buffer = lines.pop() || "";

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        handleServerMessage(JSON.parse(trimmed));
      } catch (error) {
        logger.write("rpc.server.parse_error", { line: trimmed, error: error.message });
        send(ws, { type: "parse-error", line: trimmed, error: error.message });
      }
    }
  });

  child.stderr.on("data", (chunk) => {
    const text = chunk.toString("utf8");
    logger.write("codex.stderr", { text });
    send(ws, { type: "stderr", text });
  });

  child.on("error", (error) => {
    logger.write("codex.process_error", { error: error.message, stack: error.stack });
    send(ws, { type: "process-error", error: error.message });
  });

  child.on("exit", (code, signal) => {
    logger.write("codex.exit", { code, signal });
    send(ws, { type: "process-exit", code, signal });
  });

  function trackedRequest(method, params) {
    const id = request(method, params);
    pending.set(id, { id, method, params });
    return id;
  }

  return {
    initialize() {
      if (initialized || initializeRequestId !== null) {
        logger.write("initialize.skipped", { initialized, initializeRequestId });
        return initializeRequestId;
      }
      const id = trackedRequest("initialize", {
        clientInfo: {
          name: "codex_local_web_demo",
          title: "Codex Local Web Demo",
          version: "0.1.0",
        },
        capabilities: {
          experimentalApi: true,
        },
      });
      initializeRequestId = id;
      notify("initialized", {});
      return id;
    },
    accountRead() {
      return trackedRequest("account/read", {});
    },
    loginStart(type) {
      return trackedRequest("account/login/start", { type });
    },
    logout() {
      return trackedRequest("account/logout", undefined);
    },
    startThread(params) {
      return trackedRequest("thread/start", params);
    },
    startTurn(params) {
      return trackedRequest("turn/start", params);
    },
    interrupt(params) {
      return trackedRequest("turn/interrupt", params);
    },
    raw(method, params) {
      return trackedRequest(method, params || {});
    },
    logPath() {
      return logger.filePath;
    },
    log(event, details) {
      logger.write(event, details);
    },
    stop() {
      logger.write("session.closed");
      if (!child.killed) child.kill();
    },
  };
}

wss.on("connection", (ws) => {
  const session = createCodexSession(ws);
  send(ws, {
    type: "ready",
    cwd: DEFAULT_CWD,
    codexCommand: CODEX_COMMAND,
    logPath: session.logPath(),
  });
  session.initialize();

  ws.on("message", (raw) => {
    let message;
    try {
      message = JSON.parse(raw.toString("utf8"));
    } catch (error) {
      session.log("ui.invalid_json", { error: error.message, raw: raw.toString("utf8") });
      send(ws, { type: "ui-error", error: `Invalid JSON: ${error.message}` });
      return;
    }

    session.log("ui.message", { message });

    try {
      if (message.type === "initialize") {
        session.initialize();
      } else if (message.type === "account-read") {
        session.accountRead();
      } else if (message.type === "login-start") {
        session.loginStart(message.loginType || "chatgpt");
      } else if (message.type === "logout") {
        session.logout();
      } else if (message.type === "thread-start") {
        session.startThread({
          model: message.model || undefined,
          cwd: message.cwd || DEFAULT_CWD,
          approvalPolicy: message.approvalPolicy || "never",
          sandbox: message.sandbox || "read-only",
          personality: message.personality || "friendly",
          serviceName: "codex_local_web_demo",
        });
      } else if (message.type === "turn-start") {
        session.startTurn({
          threadId: message.threadId,
          input: [{ type: "text", text: message.text }],
          cwd: message.cwd || DEFAULT_CWD,
          model: message.model || undefined,
          approvalPolicy: message.approvalPolicy || undefined,
          sandbox: message.sandbox || undefined,
        });
      } else if (message.type === "turn-interrupt") {
        session.interrupt({ threadId: message.threadId, turnId: message.turnId });
      } else if (message.type === "raw") {
        session.raw(message.method, message.params);
      }
    } catch (error) {
      session.log("ui.handler_error", { error: error.message, stack: error.stack });
      send(ws, { type: "ui-error", error: error.message });
    }
  });

  ws.on("close", () => session.stop());
});

function setupFrontendHmr() {
  let timer = null;

  function scheduleReload(filePath) {
    clearTimeout(timer);
    timer = setTimeout(() => {
      const normalized = filePath ? filePath.replace(/\\/g, "/") : "";
      const ext = path.extname(normalized).toLowerCase();
      const type = ext === ".css" ? "css" : "reload";
      broadcast(hmrWss, {
        type,
        path: normalized,
        ts: Date.now(),
      });
    }, 80);
  }

  try {
    fs.watch(PUBLIC_DIR, { recursive: true }, (_eventType, filename) => {
      if (!filename) return;
      scheduleReload(filename.toString());
    });
    console.log(`Frontend HMR watching: ${PUBLIC_DIR}`);
  } catch (error) {
    console.warn(`Frontend HMR disabled: ${error.message}`);
  }
}

hmrWss.on("connection", (ws) => {
  send(ws, { type: "connected", ts: Date.now() });
});

server.on("upgrade", (request, socket, head) => {
  const { pathname } = new URL(request.url, `http://${request.headers.host}`);
  const target = pathname === "/ws" ? wss : pathname === "/hmr" ? hmrWss : null;

  if (!target) {
    socket.destroy();
    return;
  }

  target.handleUpgrade(request, socket, head, (ws) => {
    target.emit("connection", ws, request);
  });
});

server.listen(PORT, () => {
  console.log(`Codex local web demo: http://localhost:${PORT}`);
  console.log(`Workspace: ${DEFAULT_CWD}`);
  console.log(`Codex command: ${CODEX_COMMAND}`);
  setupFrontendHmr();
});
