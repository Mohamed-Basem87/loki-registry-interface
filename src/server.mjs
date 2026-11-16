import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { createServer } from "node:http";
import { loadConfig } from "./config.mjs";
import { GitHubAppClient } from "./github.mjs";
import { registerCategory, registerSource } from "./operations.mjs";
import { SenderApi } from "./sender.mjs";
import { RequestError, slugify } from "./validation.mjs";

const config = loadConfig();
const github = new GitHubAppClient(config.github);
const sender = new SenderApi({
  baseUrl: config.senderBaseUrl,
  token: config.senderToken,
});
const sessions = new Map();
const loginNonces = new Map();
const loginFailures = new Map();
const SESSION_COOKIE = "loki_registry_session";
const LOGIN_COOKIE = "loki_registry_login";
const SESSION_LIFETIME_MS = 8 * 60 * 60 * 1000;
const MAX_FORM_BYTES = 16 * 1024;

function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"']/g, (character) => {
    const entities = {
      "&": "&amp;",
      "<": "&lt;",
      ">": "&gt;",
      '"': "&quot;",
      "'": "&#39;",
    };
    return entities[character];
  });
}

function cookieOptions(maxAge) {
  return [
    "Path=/",
    "HttpOnly",
    "SameSite=Strict",
    `Max-Age=${maxAge}`,
    ...(config.cookieSecure ? ["Secure"] : []),
  ].join("; ");
}

function appendCookie(response, name, value, maxAge) {
  const cookie = `${name}=${value}; ${cookieOptions(maxAge)}`;
  const existing = response.getHeader("Set-Cookie");
  response.setHeader("Set-Cookie", existing ? [...existing, cookie] : cookie);
}

function clearCookie(response, name) {
  appendCookie(response, name, "", 0);
}

function cookies(request) {
  const result = {};
  for (const part of String(request.headers.cookie || "").split(";")) {
    const separator = part.indexOf("=");
    if (separator > 0) {
      result[part.slice(0, separator).trim()] = part.slice(separator + 1).trim();
    }
  }
  return result;
}

function equalSecret(left, right) {
  const a = Buffer.from(String(left));
  const b = Buffer.from(String(right));
  return a.length === b.length && timingSafeEqual(a, b);
}

function signSession(id) {
  return createHmac("sha256", config.sessionSecret).update(id).digest("base64url");
}

function createSession(response) {
  const id = randomBytes(32).toString("base64url");
  const csrf = randomBytes(24).toString("base64url");
  const expiresAt = Date.now() + SESSION_LIFETIME_MS;
  sessions.set(id, { csrf, expiresAt });
  appendCookie(
    response,
    SESSION_COOKIE,
    `${id}.${signSession(id)}`,
    Math.floor(SESSION_LIFETIME_MS / 1000),
  );
  return { csrf };
}

function getSession(request) {
  const value = cookies(request)[SESSION_COOKIE] || "";
  const separator = value.lastIndexOf(".");
  if (separator < 1) return null;

  const id = value.slice(0, separator);
  const providedSignature = value.slice(separator + 1);
  if (!equalSecret(providedSignature, signSession(id))) return null;

  const session = sessions.get(id);
  if (!session || session.expiresAt <= Date.now()) {
    sessions.delete(id);
    return null;
  }
  return { id, ...session };
}

function setSecurityHeaders(response) {
  response.setHeader("X-Content-Type-Options", "nosniff");
  response.setHeader("X-Frame-Options", "DENY");
  response.setHeader("Referrer-Policy", "no-referrer");
  response.setHeader(
    "Content-Security-Policy",
    "default-src 'self'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'",
  );
  response.setHeader("Cache-Control", "no-store");
}

function sendHtml(response, statusCode, html) {
  response.writeHead(statusCode, { "Content-Type": "text/html; charset=utf-8" });
  response.end(html);
}

function sendJson(response, statusCode, value) {
  response.writeHead(statusCode, {
    "Content-Type": "application/json; charset=utf-8",
  });
  response.end(JSON.stringify(value));
}

function redirect(response, location) {
  response.writeHead(303, { Location: location });
  response.end();
}

function layout(title, body) {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${escapeHtml(title)} · Loki Registry</title>
  <style>
    :root { color-scheme: dark; font-family: Inter, ui-sans-serif, system-ui, sans-serif; background: #0b1020; color: #e8ecf7; }
    * { box-sizing: border-box; }
    body { margin: 0; min-height: 100vh; background: radial-gradient(ellipse at 8% 0%, #1b2b4a 0, #0b1020 45%); }
    a { color: #a9c5ff; }
    .shell { max-width: 1080px; margin: auto; padding: 32px 20px 64px; }
    header { display: flex; justify-content: space-between; align-items: center; gap: 20px; margin-bottom: 32px; }
    .brand { display: flex; align-items: center; gap: 13px; }
    .mark { width: 42px; height: 42px; border-radius: 14px; display: grid; place-items: center; background: #7aa2ff; color: #10172a; font-weight: 900; }
    h1 { font-size: 23px; margin: 0; letter-spacing: -.03em; }
    h2 { font-size: 17px; margin: 0 0 7px; }
    p { color: #aab4ca; line-height: 1.55; margin: 7px 0 0; }
    .subtitle { font-size: 13px; }
    .grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 18px; }
    .card { border: 1px solid #29334b; border-radius: 18px; background: rgba(18, 26, 45, .92); padding: 22px; box-shadow: 0 16px 48px #02061755; }
    .card-head { display: flex; justify-content: space-between; align-items: flex-start; gap: 14px; margin-bottom: 20px; }
    .eyebrow { color: #90a0be; text-transform: uppercase; letter-spacing: .12em; font-size: 10px; font-weight: 800; margin-bottom: 8px; }
    label { display: block; color: #d6def0; font-size: 12px; font-weight: 700; margin: 15px 0 7px; }
    input { width: 100%; padding: 12px 13px; border: 1px solid #37435e; border-radius: 10px; background: #0d1426; color: #f3f6ff; font: inherit; outline: none; }
    input:focus { border-color: #82a8ff; box-shadow: 0 0 0 3px #82a8ff22; }
    input::placeholder { color: #71809d; }
    .hint { font-size: 11px; color: #8e9bb4; margin-top: 6px; }
    button { border: 0; border-radius: 10px; padding: 11px 15px; color: #10172a; background: #9ab7ff; font: inherit; font-size: 13px; font-weight: 800; cursor: pointer; }
    button:hover { background: #b6cbff; }
    .primary { margin-top: 20px; width: 100%; }
    .logout { background: transparent; color: #bdc8dc; border: 1px solid #39445d; }
    .notice { margin: 18px 0; padding: 14px 16px; border-radius: 12px; border: 1px solid #37435e; background: #131d33; color: #dce5f7; font-size: 13px; line-height: 1.5; }
    .notice.error { border-color: #854c5a; background: #351c2a; }
    .notice.success { border-color: #326b61; background: #15322e; }
    .status { display: inline-flex; gap: 7px; align-items: center; color: #aab4ca; font-size: 11px; margin-top: 10px; }
    .dot { width: 7px; height: 7px; border-radius: 50%; background: #6a7894; }
    .dot.ok { background: #58d5a1; }
    .catalog { margin-top: 22px; }
    .catalog-list { list-style: none; margin: 12px 0 0; padding: 0; max-height: 210px; overflow: auto; }
    .catalog-list li { display: flex; justify-content: space-between; gap: 12px; padding: 9px 0; border-top: 1px solid #29334b; font-size: 12px; }
    code { color: #b8caff; font-size: 11px; overflow-wrap: anywhere; }
    .empty { color: #8997b1; font-size: 12px; padding: 9px 0; }
    .steps { display: flex; flex-wrap: wrap; gap: 8px; margin-top: 14px; }
    .pill { border: 1px solid #37435e; border-radius: 99px; padding: 6px 9px; color: #aab4ca; font-size: 10px; }
    .login { max-width: 430px; margin: 12vh auto 0; }
    footer { color: #74819a; font-size: 11px; margin-top: 25px; }
    @media (max-width: 740px) { .grid { grid-template-columns: 1fr; } header { align-items: flex-start; } .shell { padding: 22px 14px 40px; } .card { padding: 18px; } }
  </style>
</head>
<body><main class="shell">${body}</main></body>
</html>`;
}

function renderLogin(nonce, error = "") {
  const body = `<section class="card login">
    <div class="brand"><div class="mark">L</div><div><h1>Loki Registry</h1><p class="subtitle">Private administration</p></div></div>
    ${error ? `<div class="notice error">${escapeHtml(error)}</div>` : ""}
    <form method="post" action="/login">
      <input type="hidden" name="csrf" value="${escapeHtml(nonce)}">
      <label for="username">Username</label><input id="username" name="username" autocomplete="username" required>
      <label for="password">Password</label><input id="password" type="password" name="password" autocomplete="current-password" required>
      <button class="primary" type="submit">Sign in</button>
    </form>
  </section>`;
  return layout("Sign in", body);
}

function renderRecords(records, error) {
  if (error) return `<div class="empty">${escapeHtml(error)}</div>`;
  if (!records?.length) return '<div class="empty">No records registered yet.</div>';
  return `<ul class="catalog-list">${records
    .map(
      (record) =>
        `<li><span>${escapeHtml(record.name || record.display_name || "")}</span><code>${escapeHtml(record.id)}</code></li>`,
    )
    .join("")}</ul>`;
}

async function catalogSnapshot() {
  if (!sender.isConfigured()) {
    return {
      categories: { error: "Sender API URL is not configured." },
      sources: { error: "Sender API URL is not configured." },
    };
  }
  const [categories, sources] = await Promise.allSettled([
    sender.list("categories"),
    sender.list("sources"),
  ]);
  return {
    categories:
      categories.status === "fulfilled"
        ? { records: categories.value }
        : { error: categories.reason.message },
    sources:
      sources.status === "fulfilled"
        ? { records: sources.value }
        : { error: sources.reason.message },
  };
}

function resultNotice(result) {
  if (!result) return "";
  const commitText = result.commit
    ? `<a href="${escapeHtml(result.commit.url)}" target="_blank" rel="noreferrer">View commit ${escapeHtml(result.commit.sha.slice(0, 7))}</a>`
    : "The Loki config already contained this registration; no new commit was needed.";
  const senderText = result.senderCreated
    ? "Registered in sender catalog."
    : "Already registered in sender catalog.";
  return `<div class="notice success"><strong>${escapeHtml(result.name)} (${escapeHtml(result.id)}) registered.</strong><br>${senderText}<br>${commitText}<br><span class="hint">Loki CI/deployment runs after the GitHub push. Source registration does not add an ingestion adapter; category classification guidance remains a developer task.</span></div>`;
}

async function renderDashboard(session, { result = null, error = "" } = {}) {
  const snapshot = await catalogSnapshot();
  const githubReady = github.isConfigured();
  const senderReady =
    snapshot.categories.records !== undefined &&
    snapshot.sources.records !== undefined;
  const body = `<header>
    <div class="brand"><div class="mark">L</div><div><h1>Registry Interface</h1><p class="subtitle">Manage shared IDs across Loki and the sender</p></div></div>
    <form method="post" action="/logout"><input type="hidden" name="csrf" value="${escapeHtml(session.csrf)}"><button class="logout" type="submit">Sign out</button></form>
  </header>
  ${resultNotice(result)}
  ${error ? `<div class="notice error">${escapeHtml(error)}</div>` : ""}
  <div class="card">
    <div class="eyebrow">Connection status</div>
    <span class="status"><i class="dot ${githubReady ? "ok" : ""}"></i> GitHub App ${githubReady ? "configured" : "not configured"}</span>
    <span class="status"><i class="dot ${senderReady ? "ok" : ""}"></i> Sender API ${senderReady ? "reachable" : "unavailable"}</span>
    <div class="steps"><span class="pill">1 · Register sender ID</span><span class="pill">2 · Commit to Loki on GitHub</span><span class="pill">3 · CI deploys Loki</span></div>
  </div>
  <section class="grid" style="margin-top:18px">
    <article class="card">
      <div class="card-head"><div><div class="eyebrow">Source registry</div><h2>Add a source name</h2><p class="subtitle">Registers metadata only; it does not configure or create an ingestion adapter.</p></div></div>
      <form method="post" action="/sources">
        <input type="hidden" name="csrf" value="${escapeHtml(session.csrf)}">
        <label for="source-name">Display name</label><input id="source-name" name="name" maxlength="200" placeholder="Upwork" required>
        <label for="source-id">Stable ID</label><input id="source-id" name="id" maxlength="60" pattern="[a-z0-9_]+" placeholder="upwork" required>
        <div class="hint">Lowercase snake_case, at most 60 characters. The same ID must be emitted by future Loki source code.</div>
        <button class="primary" type="submit">Register source</button>
      </form>
      <div class="catalog"><div class="eyebrow">Sender sources</div>${renderRecords(snapshot.sources.records, snapshot.sources.error)}</div>
    </article>
    <article class="card">
      <div class="card-head"><div><div class="eyebrow">Category scaffold</div><h2>Add a category</h2><p class="subtitle">Creates the standard Python package and registers its ID. Classification details are left for a developer.</p></div></div>
      <form method="post" action="/categories">
        <input type="hidden" name="csrf" value="${escapeHtml(session.csrf)}">
        <label for="category-name">Display name</label><input id="category-name" name="name" maxlength="200" placeholder="DevOps Engineering" required>
        <label for="category-id">Stable ID</label><input id="category-id" name="id" maxlength="60" pattern="[a-z0-9_]+" placeholder="devops_engineering" required>
        <div class="hint">Creates profile.py, keywords.py, llm_prompt.py, guard_prompt.py, and __init__.py with safe placeholders.</div>
        <button class="primary" type="submit">Create category scaffold</button>
      </form>
      <div class="catalog"><div class="eyebrow">Sender categories</div>${renderRecords(snapshot.categories.records, snapshot.categories.error)}</div>
    </article>
  </section>
  <footer>Registrations are written to the sender first, then committed to the configured Loki branch. A partial failure is reported rather than hidden.</footer>
  <script>
    function bindSlug(nameId, idId) {
      const name = document.getElementById(nameId);
      const id = document.getElementById(idId);
      let edited = false;
      id.addEventListener("input", () => { edited = true; });
      name.addEventListener("input", () => {
        if (!edited) id.value = name.value.normalize("NFKD").replace(/[\\u0300-\\u036f]/g, "").toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 60).replace(/_+$/g, "");
      });
    }
    bindSlug("source-name", "source-id");
    bindSlug("category-name", "category-id");
  </script>`;
  return layout("Registry", body);
}

function renderLoginPage(response, message = "") {
  const nonce = randomBytes(24).toString("base64url");
  loginNonces.set(nonce, Date.now() + 10 * 60 * 1000);
  appendCookie(response, LOGIN_COOKIE, nonce, 600);
  sendHtml(response, message ? 401 : 200, renderLogin(nonce, message));
}

async function readForm(request) {
  const chunks = [];
  let length = 0;
  for await (const chunk of request) {
    length += chunk.length;
    if (length > MAX_FORM_BYTES) {
      throw new RequestError("Form submission is too large.", 413);
    }
    chunks.push(chunk);
  }
  return Object.fromEntries(new URLSearchParams(Buffer.concat(chunks).toString("utf8")));
}

function assertSameOrigin(request) {
  const origin = request.headers.origin;
  if (!origin) return;
  // Sandboxed iframes and some privacy modes send "null"; the per-form CSRF
  // nonce below is still validated, so do not reject those requests.
  if (origin === "null") return;
  let parsed;
  try {
    parsed = new URL(origin);
  } catch {
    throw new RequestError("Invalid request origin.", 403);
  }
  if (parsed.host !== request.headers.host) {
    throw new RequestError("Cross-origin form submission rejected.", 403);
  }
}

function checkLoginRateLimit(request) {
  const address = request.socket.remoteAddress || "unknown";
  const attempt = loginFailures.get(address);
  if (attempt?.blockedUntil > Date.now()) {
    throw new RequestError("Too many failed sign-in attempts. Try again later.", 429);
  }
  if (attempt?.blockedUntil && attempt.blockedUntil <= Date.now()) {
    loginFailures.delete(address);
  }
  return address;
}

function recordLoginFailure(address) {
  const previous = loginFailures.get(address);
  const failures = (previous?.failures || 0) + 1;
  loginFailures.set(address, {
    failures,
    blockedUntil: failures >= 5 ? Date.now() + 15 * 60 * 1000 : 0,
  });
}

async function handle(request, response) {
  setSecurityHeaders(response);
  const url = new URL(request.url, "http://localhost");

  if (request.method === "GET" && url.pathname === "/healthz") {
    return sendJson(response, 200, { status: "ok" });
  }
  if (request.method === "GET" && url.pathname === "/login") {
    return renderLoginPage(response);
  }
  if (request.method === "POST" && url.pathname === "/login") {
    assertSameOrigin(request);
    const address = checkLoginRateLimit(request);
    const form = await readForm(request);
    const nonce = cookies(request)[LOGIN_COOKIE];
    const expiresAt = loginNonces.get(form.csrf);
    loginNonces.delete(form.csrf);
    clearCookie(response, LOGIN_COOKIE);

    if (
      !nonce ||
      !equalSecret(nonce, form.csrf || "") ||
      !expiresAt ||
      expiresAt < Date.now()
    ) {
      return renderLoginPage(response, "Sign-in form expired. Please try again.");
    }
    if (
      !equalSecret(form.username || "", config.adminUsername) ||
      !equalSecret(form.password || "", config.adminPassword)
    ) {
      recordLoginFailure(address);
      return renderLoginPage(response, "Incorrect username or password.");
    }

    loginFailures.delete(address);
    const session = createSession(response);
    return redirect(response, "/");
  }
  if (request.method === "GET" && url.pathname === "/") {
    const session = getSession(request);
    if (!session) return redirect(response, "/login");
    return sendHtml(response, 200, await renderDashboard(session));
  }

  const session = getSession(request);
  if (!session) return redirect(response, "/login");

  if (request.method === "POST" && url.pathname === "/logout") {
    assertSameOrigin(request);
    const form = await readForm(request);
    if (!equalSecret(form.csrf || "", session.csrf)) {
      throw new RequestError("Invalid form token. Reload the page and retry.", 403);
    }
    const cookie = cookies(request)[SESSION_COOKIE] || "";
    sessions.delete(cookie.slice(0, cookie.lastIndexOf(".")));
    clearCookie(response, SESSION_COOKIE);
    return redirect(response, "/login");
  }

  if (
    request.method === "POST" &&
    (url.pathname === "/sources" || url.pathname === "/categories")
  ) {
    assertSameOrigin(request);
    const form = await readForm(request);
    if (!equalSecret(form.csrf || "", session.csrf)) {
      throw new RequestError("Invalid form token. Reload the page and retry.", 403);
    }

    try {
      const result =
        url.pathname === "/sources"
          ? await registerSource(form, { sender, github })
          : await registerCategory(form, { sender, github });
      return sendHtml(
        response,
        200,
        await renderDashboard(session, { result }),
      );
    } catch (error) {
      const status = Number.isInteger(error.statusCode) ? error.statusCode : 502;
      if (status >= 500) {
        console.error(`Registration failed: ${error.message}`);
      }
      return sendHtml(
        response,
        status,
        await renderDashboard(session, { error: error.message }),
      );
    }
  }

  return sendHtml(response, 404, layout("Not found", "<div class=\"card\"><h1>Not found</h1></div>"));
}

const server = createServer((request, response) => {
  handle(request, response).catch((error) => {
    const status = Number.isInteger(error.statusCode) ? error.statusCode : 500;
    if (status >= 500) console.error(error);
    if (response.headersSent) {
      response.destroy();
      return;
    }
    setSecurityHeaders(response);
    sendHtml(
      response,
      status,
      layout(
        "Request failed",
        `<div class="card"><div class="notice error">${escapeHtml(error.message)}</div><a href="/">Return to registry</a></div>`,
      ),
    );
  });
});

server.listen(config.port, "0.0.0.0", () => {
  console.log(`Loki Registry Interface listening on port ${config.port}`);
});
