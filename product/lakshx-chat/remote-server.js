// LakshX Remote Access — LAN mobile view + control of agent progress.
// Plain Node `http`, zero new dependencies. Off by default: nothing in this
// file runs any network code until `start()` is called explicitly, which
// only happens from the "LakshX: Enable Remote Access" command.
//
// Design + security rationale in full: docs/research/10-remote-control.md.
// This module deliberately does NOT `require("vscode")` — it depends only on
// a small adapter object (`{ getSnapshot, isBusy, onControl }`) so it can be
// started, driven, and torn down in a plain node:test process without the
// extension host. extension.js supplies that adapter and owns the two narrow
// integration points: AgentViewProvider.post() calls
// `this.remote?.broadcast(msg)`, and the control routes below call
// `adapter.onControl(msg)`, which extension.js wires straight to
// `AgentViewProvider.onWebviewMessage(msg)` — the SAME dispatch the desktop
// webview's `postMessage` already drives for "send"/"permissionChoice"/
// "setMode". There is no second/parallel resolution mechanism here: the
// phone is just another caller of that one method.
//
// Security model (see doc §2.3, §3 for the full accounting):
//  - Off by default; a session-lifetime random token; no disk persistence.
//  - Host-header validated on every request (GET and POST alike) — rejects
//    anything not addressed to exactly the LAN ip:port this server bound to
//    (the concrete mitigation for the 0.0.0.0-day / DNS-rebinding class of
//    attack, doc §1.2).
//  - Token compared with a constant-time comparison, required on every route
//    except the bare `/` page shell (which carries no chat data).
//  - Deliberate deviation from doc §2.4's "control needs a second toggle /
//    TLS-only" recommendation: this build folds control into the same
//    session token as view access (see extension.js's enable-time warning,
//    which is now written to describe full control, not view-only, and is
//    re-shown once even to users who already acked the older view-only
//    wording). Tracked as a known simplification, not a silent gap.
"use strict";

const http = require("http");
const crypto = require("crypto");
const os = require("os");
const { renderMobilePage } = require("./remote-page.js");

const DEFAULT_BASE_PORT = 47820;
const PORT_SCAN_ATTEMPTS = 20;
const MAX_BODY_BYTES = 64 * 1024; // a phone prompt or a mode/permission choice is tiny; guards against a slow-body DoS

/** First non-internal IPv4 LAN address, or null if there isn't one (e.g. offline). */
function lanAddress() {
  const nets = os.networkInterfaces();
  for (const name of Object.keys(nets)) {
    for (const net of nets[name] ?? []) {
      if (net.family === "IPv4" && !net.internal) return net.address;
    }
  }
  return null;
}

class RemoteServer {
  /**
   * @param {{
   *   getSnapshot: () => { workspace: string, mode: string, transcript: any[] },
   *   isBusy?: () => boolean,
   *   onControl?: (msg: object) => any,
   * }} adapter
   */
  constructor(adapter) {
    this.adapter = adapter;
    this.server = null;
    this.token = null;
    this.port = null;
    this.host = null; // "<lan-ip>:<port>" — the exact value we validate the Host header against
    this.clients = new Set(); // open SSE response objects
    this.connectionSeen = false;
  }

  get isRunning() {
    return this.server != null;
  }

  /** Starts listening on the LAN interface; resolves with pairing info. Throws if no LAN interface is up. */
  start(basePort = DEFAULT_BASE_PORT) {
    if (this.server) return Promise.resolve(this.info());
    const ip = lanAddress();
    if (!ip) {
      return Promise.reject(new Error("No LAN network interface found — connect to WiFi or Ethernet first."));
    }
    this.token = crypto.randomBytes(16).toString("hex");
    this.connectionSeen = false;
    return this._listen(ip, basePort).then(() => this.info());
  }

  // Sets this.server/this.port/this.host synchronously inside the listen
  // callback (not in a later .then()) so there is no window, however small,
  // between "accepting connections" and "Host-header validation has the
  // right value to check against."
  _listen(ip, basePort) {
    return new Promise((resolve, reject) => {
      const tryPort = (p, attemptsLeft) => {
        const server = http.createServer((req, res) => this._handle(req, res));
        server.once("error", (err) => {
          if (err.code === "EADDRINUSE" && attemptsLeft > 0) {
            tryPort(p + 1, attemptsLeft - 1);
          } else {
            reject(err);
          }
        });
        server.listen(p, ip, () => {
          this.server = server;
          this.port = p;
          this.host = `${ip}:${p}`;
          resolve(p);
        });
      };
      tryPort(basePort, PORT_SCAN_ATTEMPTS);
    });
  }

  /** Pairing info for the QR/URL display. `url` is null if not running. */
  info() {
    return {
      running: this.isRunning,
      host: this.host,
      port: this.port,
      token: this.token,
      url: this.isRunning ? `http://${this.host}/?token=${this.token}` : null,
    };
  }

  /** Stops the server, closes all open SSE connections, and invalidates the token (no rotation/persistence). */
  stop() {
    for (const res of this.clients) {
      try { res.end(); } catch {}
    }
    this.clients.clear();
    if (this.server) {
      try { this.server.close(); } catch {}
      this.server = null;
    }
    this.token = null;
    this.port = null;
    this.host = null;
  }

  /** Fan out one transcript/control event to every connected phone. No-op if nobody's listening. */
  broadcast(msg) {
    if (!this.clients.size) return;
    const frame = `data: ${JSON.stringify(msg)}\n\n`;
    for (const res of this.clients) {
      try { res.write(frame); } catch { this.clients.delete(res); }
    }
  }

  _timingSafeTokenMatch(candidate) {
    if (!candidate || !this.token) return false;
    const a = Buffer.from(String(candidate));
    const b = Buffer.from(this.token);
    if (a.length !== b.length) return false;
    return crypto.timingSafeEqual(a, b);
  }

  /**
   * Reject anything whose Host header isn't exactly the LAN ip:port we bound
   * to. This is the concrete mitigation named in doc §1.2/§3 for the
   * 0.0.0.0-day / DNS-rebinding class: a browser tab elsewhere on the LAN (or
   * on the same machine) that tries to reach this server by IP/0.0.0.0/a
   * rebound hostname sends a Host header that won't match, and gets a 400
   * before any handler runs.
   */
  _validHost(req) {
    return req.headers.host === this.host;
  }

  _handle(req, res) {
    this.connectionSeen = true;
    let url;
    try {
      url = new URL(req.url, `http://${this.host}`);
    } catch {
      res.writeHead(400).end("bad request");
      return;
    }

    if (!this._validHost(req)) {
      res.writeHead(400, { "Content-Type": "text/plain" }).end("bad host");
      return;
    }

    if (req.method === "GET") {
      if (url.pathname === "/") return this._serveIndex(res);
      if (url.pathname === "/state") return this._serveState(url, res);
      if (url.pathname === "/events") return this._serveEvents(url, req, res);
      res.writeHead(404).end("not found");
      return;
    }

    if (req.method === "POST") {
      if (url.pathname === "/control/send") return this._handleControl(url, req, res, "send");
      if (url.pathname === "/control/permission") return this._handleControl(url, req, res, "permission");
      if (url.pathname === "/control/setMode") return this._handleControl(url, req, res, "setMode");
      res.writeHead(404).end("not found");
      return;
    }

    res.writeHead(405).end("method not allowed");
  }

  _serveIndex(res) {
    // The page shell carries no chat data — it does its own token check via
    // JS before it ever calls /state or /events, which are the routes that
    // actually gate on the token. Handing out the empty shell without a
    // token is equivalent to what a plain "view source" on the QR would show.
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    res.end(renderMobilePage());
  }

  _serveState(url, res) {
    if (!this._timingSafeTokenMatch(url.searchParams.get("token"))) {
      res.writeHead(401, { "Content-Type": "text/plain" }).end("unauthorized");
      return;
    }
    const snap = this.adapter.getSnapshot();
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(snap));
  }

  _serveEvents(url, req, res) {
    if (!this._timingSafeTokenMatch(url.searchParams.get("token"))) {
      res.writeHead(401, { "Content-Type": "text/plain" }).end("unauthorized");
      return;
    }
    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
    });
    res.write(":connected\n\n");
    this.clients.add(res);
    req.on("close", () => this.clients.delete(res));
  }

  _sendJson(res, status, body) {
    res.writeHead(status, { "Content-Type": "application/json" }).end(JSON.stringify(body));
  }

  /** Reads a small JSON body off `req`; calls back(err) or back(null, obj). Caps size at MAX_BODY_BYTES. */
  _readJsonBody(req, cb) {
    let data = "";
    let failed = false;
    req.on("data", (chunk) => {
      if (failed) return;
      data += chunk;
      if (data.length > MAX_BODY_BYTES) {
        failed = true;
        cb(new Error("body too large"));
        req.destroy();
      }
    });
    req.on("error", (err) => {
      if (!failed) { failed = true; cb(err); }
    });
    req.on("end", () => {
      if (failed) return;
      if (!data) { cb(null, {}); return; }
      try {
        cb(null, JSON.parse(data));
      } catch {
        cb(new Error("invalid JSON body"));
      }
    });
  }

  /**
   * POST /control/{send,permission,setMode} — the control-layer routes
   * (docs/research/10 Phase B). Token- and Host-gated exactly like the view
   * routes above (see file header); the only thing new here is that a valid
   * request calls `adapter.onControl(msg)` instead of just reading state.
   * `onControl` is extension.js's `AgentViewProvider.onWebviewMessage` — the
   * exact function the desktop webview's own postMessage already drives, so
   * there is no parallel permission-resolution or send/setMode code path to
   * keep in sync; the phone is just another caller.
   */
  _handleControl(url, req, res, kind) {
    if (!this._timingSafeTokenMatch(url.searchParams.get("token"))) {
      this._sendJson(res, 401, { error: "unauthorized" });
      req.resume(); // drain the unread body so the socket can be reused/closed cleanly
      return;
    }
    if (!this.adapter.onControl) {
      this._sendJson(res, 501, { error: "control actions are not supported by this adapter" });
      req.resume();
      return;
    }
    this._readJsonBody(req, (err, body) => {
      if (err) return this._sendJson(res, 400, { error: err.message });

      if (kind === "send") {
        const text = typeof body.text === "string" ? body.text.trim() : "";
        if (!text) return this._sendJson(res, 400, { error: "missing 'text'" });
        // Race handling (doc 10, task item 4): the desktop and the phone
        // share one turn-in-progress flag on AgentViewProvider. Reject here
        // rather than letting a second session/prompt race the first one —
        // whichever request (desktop click or phone POST) got there first
        // wins, the other gets a clean 409 instead of corrupting turn state.
        if (this.adapter.isBusy && this.adapter.isBusy()) {
          return this._sendJson(res, 409, { error: "agent is busy with another turn" });
        }
        Promise.resolve(this.adapter.onControl({ type: "send", text })).catch(() => {});
        return this._sendJson(res, 202, { ok: true });
      }

      if (kind === "permission") {
        if (!body.id || !body.optionId) return this._sendJson(res, 400, { error: "missing 'id' or 'optionId'" });
        // No busy/race guard needed: this reuses extension.js's
        // `permissionWaiters` map verbatim (get → delete → resolve). If the
        // desktop already resolved this same permission, the waiter is
        // already gone and this becomes a harmless no-op — first responder
        // wins, second gets a quiet 200, never an error or a hang.
        Promise.resolve(this.adapter.onControl({ type: "permissionChoice", id: body.id, optionId: body.optionId })).catch(() => {});
        return this._sendJson(res, 200, { ok: true });
      }

      if (kind === "setMode") {
        if (typeof body.mode !== "string" || !body.mode) return this._sendJson(res, 400, { error: "missing 'mode'" });
        Promise.resolve(this.adapter.onControl({ type: "setMode", mode: body.mode })).catch(() => {});
        return this._sendJson(res, 200, { ok: true });
      }
    });
  }
}

module.exports = { RemoteServer, lanAddress };
