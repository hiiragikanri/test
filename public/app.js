const state = {
  ws: null,
  threadId: null,
  turnId: null,
  initialized: false,
  currentAssistant: null,
};

const els = {
  status: document.querySelector("#status"),
  logPath: document.querySelector("#logPath"),
  publicWarning: document.querySelector("#publicWarning"),
  initializeBtn: document.querySelector("#initializeBtn"),
  accountBtn: document.querySelector("#accountBtn"),
  deviceLoginBtn: document.querySelector("#deviceLoginBtn"),
  logoutBtn: document.querySelector("#logoutBtn"),
  threadBtn: document.querySelector("#threadBtn"),
  turnForm: document.querySelector("#turnForm"),
  promptInput: document.querySelector("#promptInput"),
  modelInput: document.querySelector("#modelInput"),
  sandboxSelect: document.querySelector("#sandboxSelect"),
  approvalSelect: document.querySelector("#approvalSelect"),
  cwdInput: document.querySelector("#cwdInput"),
  messages: document.querySelector("#messages"),
  events: document.querySelector("#events"),
  clearEventsBtn: document.querySelector("#clearEventsBtn"),
  authBox: document.querySelector("#authBox"),
  authLabel: document.querySelector("#authLabel"),
  authLink: document.querySelector("#authLink"),
  authCode: document.querySelector("#authCode"),
};

function send(payload) {
  if (!state.ws || state.ws.readyState !== WebSocket.OPEN) return;
  state.ws.send(JSON.stringify(payload));
}

function setStatus(text) {
  els.status.textContent = text;
}

function logEvent(payload) {
  els.events.textContent += `${JSON.stringify(redactForDisplay(payload), null, 2)}\n\n`;
  els.events.scrollTop = els.events.scrollHeight;
}

function redactForDisplay(value) {
  if (Array.isArray(value)) return value.map(redactForDisplay);
  if (!value || typeof value !== "object") return value;

  const copy = {};
  for (const [key, item] of Object.entries(value)) {
    if (/^(email|token|secret|apiKey|accessToken|refreshToken|idToken|userCode|deviceCode|authCode)$/i.test(key) && typeof item === "string") {
      copy[key] = "[redacted]";
    } else {
      copy[key] = redactForDisplay(item);
    }
  }
  return copy;
}

function summarizeStderr(text) {
  const trimmed = text.trim().split(/\r?\n/).find(Boolean) || "";
  try {
    const parsed = JSON.parse(trimmed);
    return parsed.fields?.message || parsed.message || "Codex stderr";
  } catch {
    return trimmed.slice(0, 140) || "Codex stderr";
  }
}

function isNoisyStderr(text) {
  return text
    .trim()
    .split(/\r?\n/)
    .filter(Boolean)
    .every((line) => {
      try {
        const parsed = JSON.parse(line);
        const message = parsed.fields?.message || parsed.message || "";
        return (
          message.includes("ignoring interface.icon_small") ||
          message.includes("ignoring interface.icon_large") ||
          message.includes("Failed to create shell snapshot for powershell")
        );
      } catch {
        return false;
      }
    });
}

function addMessage(role, text = "") {
  const node = document.createElement("div");
  node.className = `message ${role}`;
  const label = document.createElement("span");
  label.className = "role";
  label.textContent = role === "user" ? "You" : "Codex";
  const body = document.createElement("div");
  body.textContent = text;
  node.append(label, body);
  els.messages.append(node);
  els.messages.scrollTop = els.messages.scrollHeight;
  return body;
}

function appendAssistantDelta(delta) {
  if (!state.currentAssistant) {
    state.currentAssistant = addMessage("assistant");
  }
  state.currentAssistant.textContent += delta;
  els.messages.scrollTop = els.messages.scrollHeight;
}

function extractThread(response) {
  const thread = response?.result?.thread || response?.result;
  return thread?.id || thread?.threadId;
}

function handleRpcResult(payload) {
  const { request, response } = payload;
  if (response.error) {
    setStatus(`${request.method} error: ${response.error.message || "unknown error"}`);
    return;
  }

  if (request.method === "initialize") {
    state.initialized = true;
    setStatus("Initialized");
    send({ type: "account-read" });
  }

  if (request.method === "account/logout") {
    state.threadId = null;
    setStatus("Auth reset. Use Device Login next.");
    els.authBox.classList.add("hidden");
  }

  if (request.method === "account/login/start") {
    const authUrl =
      response.result?.authUrl ||
      response.result?.url ||
      response.result?.verificationUrl ||
      response.result?.verificationUriComplete ||
      response.result?.verificationUri;
    const userCode = response.result?.userCode || response.result?.code || response.result?.deviceCode;

    if (authUrl) {
      els.authLink.href = authUrl;
      els.authLink.textContent = authUrl;
      els.authLabel.textContent = userCode ? "Open this URL and enter the code:" : "Login URL:";
      els.authBox.classList.remove("hidden");
      setStatus(userCode ? "Enter the displayed code in the ChatGPT auth page" : "Finish login in the browser");
    }

    if (userCode) {
      els.authCode.textContent = userCode;
      els.authCode.classList.remove("hidden");
    } else {
      els.authCode.classList.add("hidden");
    }
  }

  if (request.method === "account/read") {
    const mode = response.result?.authMode || response.result?.account?.authMode || response.result?.account?.type || "unknown";
    const plan = response.result?.planType || response.result?.account?.planType || "";
    setStatus(`account: ${mode}${plan ? ` / ${plan}` : ""}`);
  }

  if (request.method === "thread/start") {
    const threadId = extractThread(response);
    if (threadId) {
      state.threadId = threadId;
      setStatus(`thread: ${threadId}`);
    }
  }

  if (request.method === "turn/start") {
    const turn = response.result?.turn || response.result;
    state.turnId = turn?.id || turn?.turnId || null;
  }
}

function handleCodexMessage(message) {
  if (message.method === "account/updated") {
    const mode = message.params?.authMode || "unknown";
    const plan = message.params?.planType || "";
    setStatus(`account: ${mode}${plan ? ` / ${plan}` : ""}`);
  }

  if (message.method === "thread/started") {
    const threadId = message.params?.thread?.id;
    if (threadId) {
      state.threadId = threadId;
      setStatus(`thread: ${threadId}`);
    }
  }

  if (message.method === "turn/started") {
    state.turnId = message.params?.turn?.id || message.params?.turnId || null;
    state.currentAssistant = null;
  }

  if (message.method === "item/agentMessage/delta") {
    const delta = message.params?.delta || message.params?.text || "";
    appendAssistantDelta(delta);
  }

  if (message.method === "item/agentMessage/completed") {
    const text = message.params?.text || message.params?.message?.text;
    if (text && !state.currentAssistant) appendAssistantDelta(text);
    state.currentAssistant = null;
  }

  if (message.method === "turn/completed" || message.method === "turn/failed") {
    state.currentAssistant = null;
    setStatus(message.method);
  }

  if (message.method === "account/login/completed") {
    setStatus(message.params?.success ? "Login completed. Create a new thread." : `Login failed: ${message.params?.error || "unknown"}`);
  }
}

function connect() {
  const protocol = location.protocol === "https:" ? "wss" : "ws";
  state.ws = new WebSocket(`${protocol}://${location.host}/ws`);

  state.ws.addEventListener("open", () => setStatus("WebSocket connected"));
  state.ws.addEventListener("close", () => setStatus("Disconnected. Reload the page."));
  state.ws.addEventListener("error", () => setStatus("WebSocket error"));
  state.ws.addEventListener("message", (event) => {
    const payload = JSON.parse(event.data);
    const noisyStderr = payload.type === "stderr" && isNoisyStderr(payload.text);
    if (!noisyStderr) logEvent(payload);

    if (payload.type === "ready") {
      els.cwdInput.value = payload.cwd;
      els.logPath.textContent = payload.logPath ? `Log: ${payload.logPath}` : "";
      setStatus(`ready: ${payload.codexCommand}`);
    } else if (payload.type === "rpc-result") {
      handleRpcResult(payload);
    } else if (payload.type === "codex-message") {
      handleCodexMessage(payload.message);
    } else if (payload.type === "stderr" && !noisyStderr) {
      setStatus(summarizeStderr(payload.text));
    } else if (payload.type === "process-exit") {
      setStatus(`Codex process exited: ${payload.code ?? payload.signal}`);
    } else if (payload.type.endsWith("error")) {
      setStatus(payload.error || "error");
    }
  });
}

function connectHmr() {
  const protocol = location.protocol === "https:" ? "wss" : "ws";
  const ws = new WebSocket(`${protocol}://${location.host}/hmr`);

  ws.addEventListener("message", (event) => {
    const payload = JSON.parse(event.data);
    if (payload.type === "css") {
      for (const link of document.querySelectorAll('link[rel="stylesheet"]')) {
        const url = new URL(link.href);
        url.searchParams.set("t", String(payload.ts));
        link.href = url.toString();
      }
    } else if (payload.type === "reload") {
      location.reload();
    }
  });

  ws.addEventListener("close", () => {
    setTimeout(connectHmr, 1000);
  });
}

function showPublicHostWarning() {
  const localHosts = new Set(["localhost", "127.0.0.1", "::1"]);
  if (!localHosts.has(location.hostname)) {
    els.publicWarning.classList.remove("hidden");
  }
}

els.initializeBtn.addEventListener("click", () => send({ type: "initialize" }));
els.accountBtn.addEventListener("click", () => send({ type: "account-read" }));
els.deviceLoginBtn.addEventListener("click", () => send({ type: "login-start", loginType: "chatgptDeviceCode" }));
els.logoutBtn.addEventListener("click", () => send({ type: "logout" }));
els.threadBtn.addEventListener("click", () => {
  send({
    type: "thread-start",
    model: els.modelInput.value.trim(),
    cwd: els.cwdInput.value.trim(),
    sandbox: els.sandboxSelect.value,
    approvalPolicy: els.approvalSelect.value,
  });
});

els.turnForm.addEventListener("submit", (event) => {
  event.preventDefault();
  const text = els.promptInput.value.trim();
  if (!text || !state.threadId) {
    setStatus(!state.threadId ? "Create a new thread first" : "Input is empty");
    return;
  }

  addMessage("user", text);
  state.currentAssistant = null;
  send({
    type: "turn-start",
    threadId: state.threadId,
    text,
    model: els.modelInput.value.trim(),
    cwd: els.cwdInput.value.trim(),
    sandbox: els.sandboxSelect.value,
    approvalPolicy: els.approvalSelect.value,
  });
  els.promptInput.value = "";
});

els.clearEventsBtn.addEventListener("click", () => {
  els.events.textContent = "";
});

connect();
connectHmr();
showPublicHostWarning();
