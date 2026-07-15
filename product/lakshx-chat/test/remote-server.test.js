// Tests for remote-server.js — the LAN Remote Access server (view-only, v1).
// Exercises the server's own request handling directly (no VS Code extension
// host needed): spin it up, hit it with real HTTP requests, assert on the
// auth/off-by-default/Host-header behavior the security design in
// docs/research/10-remote-control.md depends on.
"use strict";

const assert = require("node:assert/strict");
const { test } = require("node:test");
const http = require("node:http");
const { RemoteServer, lanAddress } = require("../remote-server.js");

function fakeAdapter(overrides = {}) {
  return {
    getSnapshot: () => ({
      workspace: "test-workspace",
      mode: "review",
      transcript: [{ type: "system", text: "hello" }],
      ...overrides,
    }),
  };
}

/**
 * A fake adapter that also supports control actions, recording every call to
 * `onControl` (the thing extension.js wires to `AgentViewProvider.onWebviewMessage`)
 * so tests can assert the control routes reach the SAME dispatch a real desktop
 * webview message would — no parallel/second resolution path.
 */
function controlAdapter({ busy = false } = {}) {
  const calls = [];
  return {
    calls,
    getSnapshot: () => ({ workspace: "test-workspace", mode: "review", transcript: [] }),
    isBusy: () => busy,
    onControl: (msg) => {
      calls.push(msg);
      return Promise.resolve();
    },
  };
}

/**
 * Raw HTTP GET so we can control the Host header independently of the
 * socket's real destination (DNS-rebinding-style test). The server binds
 * only to the LAN interface (not loopback) by design, so `connectIp` must be
 * the server's actual LAN address (`server.host.split(":")[0]`) — that's
 * also what makes this a faithful test of the Host-header check: a real
 * attacker reaches the same TCP endpoint a legitimate phone would, just with
 * a forged Host header.
 */
function rawGet(connectIp, port, pathAndQuery, hostHeader) {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { host: connectIp, port, path: pathAndQuery, method: "GET", headers: { Host: hostHeader } },
      (res) => {
        let body = "";
        res.on("data", (d) => (body += d));
        res.on("end", () => resolve({ status: res.statusCode, body }));
      },
    );
    req.on("error", reject);
    req.end();
  });
}

/** The IP part of `server.host` ("<ip>:<port>") — the real address to connect to. */
function ipOf(server) {
  return server.host.split(":")[0];
}

/** Raw HTTP POST with a JSON body, same Host-header-forging capability as rawGet. */
function rawPost(connectIp, port, pathAndQuery, hostHeader, body) {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? "" : JSON.stringify(body);
    const req = http.request(
      {
        host: connectIp,
        port,
        path: pathAndQuery,
        method: "POST",
        headers: { Host: hostHeader, "Content-Type": "application/json", "Content-Length": Buffer.byteLength(payload) },
      },
      (res) => {
        let respBody = "";
        res.on("data", (d) => (respBody += d));
        res.on("end", () => resolve({ status: res.statusCode, body: respBody }));
      },
    );
    req.on("error", reject);
    req.end(payload);
  });
}

test("off by default: a fresh RemoteServer is not running and has no port/token", () => {
  const server = new RemoteServer(fakeAdapter());
  assert.equal(server.isRunning, false);
  assert.equal(server.info().running, false);
  assert.equal(server.info().url, null);
  assert.equal(server.port, null);
  assert.equal(server.token, null);
});

test("start() binds to the LAN interface and issues a random token; stop() releases it", async () => {
  if (!lanAddress()) return; // no LAN interface available in this environment — nothing to test
  const server = new RemoteServer(fakeAdapter());
  const info = await server.start(48920);
  try {
    assert.equal(server.isRunning, true);
    assert.equal(info.running, true);
    assert.match(info.token, /^[0-9a-f]{32}$/);
    assert.equal(info.url, `http://${info.host}/?token=${info.token}`);
  } finally {
    server.stop();
  }
  assert.equal(server.isRunning, false);
  assert.equal(server.port, null);
  assert.equal(server.token, null);
});

test("requests to /state and /events without a valid token are rejected with 401", async () => {
  if (!lanAddress()) return;
  const server = new RemoteServer(fakeAdapter());
  await server.start(48921);
  const ip = ipOf(server);
  try {
    const noToken = await rawGet(ip, server.port, "/state", server.host);
    assert.equal(noToken.status, 401);

    const wrongToken = await rawGet(ip, server.port, "/state?token=0000000000000000000000000000000", server.host);
    assert.equal(wrongToken.status, 401);

    const eventsNoToken = await rawGet(ip, server.port, "/events", server.host);
    assert.equal(eventsNoToken.status, 401);
  } finally {
    server.stop();
  }
});

test("a request with the correct token and correct Host header succeeds", async () => {
  if (!lanAddress()) return;
  const server = new RemoteServer(fakeAdapter());
  const info = await server.start(48922);
  const ip = ipOf(server);
  try {
    const res = await rawGet(ip, server.port, `/state?token=${info.token}`, server.host);
    assert.equal(res.status, 200);
    const snap = JSON.parse(res.body);
    assert.equal(snap.workspace, "test-workspace");
    assert.equal(snap.mode, "review");
    assert.deepEqual(snap.transcript, [{ type: "system", text: "hello" }]);
  } finally {
    server.stop();
  }
});

test("Host-header validation: a request with a forged/mismatched Host is rejected with 400, even with a valid token", async () => {
  if (!lanAddress()) return;
  const server = new RemoteServer(fakeAdapter());
  const info = await server.start(48923);
  const ip = ipOf(server);
  try {
    // Same TCP destination the server is actually bound to, but a Host
    // header that doesn't match "<lan-ip>:<port>" — the DNS-rebinding /
    // 0.0.0.0-day shape named in docs/research/10-remote-control.md §1.2.
    const forged = await rawGet(ip, server.port, `/state?token=${info.token}`, "evil.example.com");
    assert.equal(forged.status, 400);

    const forgedZero = await rawGet(ip, server.port, `/state?token=${info.token}`, `0.0.0.0:${server.port}`);
    assert.equal(forgedZero.status, 400);

    // sanity: the real host string still works against the same endpoint
    const real = await rawGet(ip, server.port, `/state?token=${info.token}`, server.host);
    assert.equal(real.status, 200);
  } finally {
    server.stop();
  }
});

test("GET / serves the mobile page shell without requiring a token", async () => {
  if (!lanAddress()) return;
  const server = new RemoteServer(fakeAdapter());
  await server.start(48924);
  const ip = ipOf(server);
  try {
    const res = await rawGet(ip, server.port, "/", server.host);
    assert.equal(res.status, 200);
    assert.match(res.body, /<title>LakshX Remote<\/title>/);
  } finally {
    server.stop();
  }
});

// ---------- remote-page.js content regressions ----------
// remote-page.js has no dedicated test file of its own (it's a hand-built
// HTML/CSS/JS string, not something node:test can execute in a DOM), so this
// is the only automated guard against a future edit silently dropping the
// interactive mode switcher or the keyboard-avoidance CSS this task added —
// checked here via the one route that actually renders it.
test("GET / renders a tappable mode switcher (review/approve/auto/royal), not just a read-only badge", async () => {
  if (!lanAddress()) return;
  const server = new RemoteServer(fakeAdapter());
  await server.start(48942);
  const ip = ipOf(server);
  try {
    const res = await rawGet(ip, server.port, "/", server.host);
    assert.equal(res.status, 200);
    assert.match(res.body, /id="modeBar"/);
    for (const mode of ["review", "approve", "auto", "royal"]) {
      assert.match(res.body, new RegExp(`data-mode="${mode}"`));
    }
    // the old read-only span this task replaced should be gone, not just supplemented
    assert.doesNotMatch(res.body, /id="modeBadge"/);
    assert.doesNotMatch(res.body, /class="mode-badge"/);
  } finally {
    server.stop();
  }
});

test("GET / uses dvh (not just vh) on the app shell so the layout tracks the visible viewport", async () => {
  if (!lanAddress()) return;
  const server = new RemoteServer(fakeAdapter());
  await server.start(48943);
  const ip = ipOf(server);
  try {
    const res = await rawGet(ip, server.port, "/", server.host);
    assert.match(res.body, /100dvh/);
  } finally {
    server.stop();
  }
});

test("unknown routes 404, non-GET methods are rejected", async () => {
  if (!lanAddress()) return;
  const server = new RemoteServer(fakeAdapter());
  const info = await server.start(48925);
  const ip = ipOf(server);
  try {
    const notFound = await rawGet(ip, server.port, `/nope?token=${info.token}`, server.host);
    assert.equal(notFound.status, 404);
  } finally {
    server.stop();
  }
});

test("broadcast() delivers live events to a connected SSE client", async () => {
  if (!lanAddress()) return;
  const server = new RemoteServer(fakeAdapter());
  const info = await server.start(48926);
  const ip = ipOf(server);
  try {
    const chunks = [];
    const gotFrame = new Promise((resolve, reject) => {
      const req = http.request(
        { host: ip, port: server.port, path: `/events?token=${info.token}`, method: "GET", headers: { Host: server.host } },
        (res) => {
          assert.equal(res.statusCode, 200);
          res.on("data", (d) => {
            chunks.push(d.toString());
            if (chunks.join("").includes("live-event-marker")) resolve();
          });
        },
      );
      req.on("error", reject);
      req.end();
      // give the connection a moment to register before broadcasting
      setTimeout(() => server.broadcast({ type: "system", text: "live-event-marker" }), 100);
      setTimeout(() => reject(new Error("timed out waiting for SSE frame")), 3000);
    });
    await gotFrame;
    assert.match(chunks.join(""), /data: .*live-event-marker/);
  } finally {
    server.stop();
  }
});

test("port auto-increments on EADDRINUSE so two servers can run side by side", async () => {
  if (!lanAddress()) return;
  const a = new RemoteServer(fakeAdapter());
  const b = new RemoteServer(fakeAdapter());
  const infoA = await a.start(48927);
  try {
    const infoB = await b.start(48927); // same base port as `a`, which is already bound
    try {
      assert.notEqual(infoA.port, infoB.port);
    } finally {
      b.stop();
    }
  } finally {
    a.stop();
  }
});

// ---------- Control-layer tests (docs/research/10 Phase B) ----------
// These exercise the auth boundary for control actions *specifically*, not
// just viewing (view-only auth is already covered above) — plus the actual
// dispatch: a control POST must reach `adapter.onControl` with the same
// message shape the desktop webview's postMessage already sends, since
// extension.js wires `onControl` straight to `AgentViewProvider.onWebviewMessage`.

test("POST /control/send without a valid token is rejected with 401 and never reaches onControl", async () => {
  if (!lanAddress()) return;
  const adapter = controlAdapter();
  const server = new RemoteServer(adapter);
  await server.start(48930);
  const ip = ipOf(server);
  try {
    const noToken = await rawPost(ip, server.port, "/control/send", server.host, { text: "hi" });
    assert.equal(noToken.status, 401);
    const wrongToken = await rawPost(ip, server.port, "/control/send?token=deadbeef", server.host, { text: "hi" });
    assert.equal(wrongToken.status, 401);
    assert.equal(adapter.calls.length, 0);
  } finally {
    server.stop();
  }
});

test("POST /control/send with a forged Host header is rejected with 400 even with a valid token", async () => {
  if (!lanAddress()) return;
  const adapter = controlAdapter();
  const server = new RemoteServer(adapter);
  const info = await server.start(48931);
  const ip = ipOf(server);
  try {
    const res = await rawPost(ip, server.port, `/control/send?token=${info.token}`, "evil.example.com", { text: "hi" });
    assert.equal(res.status, 400);
    assert.equal(adapter.calls.length, 0);
  } finally {
    server.stop();
  }
});

test("POST /control/send with a valid token dispatches a 'send' message to onControl (the same path onWebviewMessage's 'send' case uses)", async () => {
  if (!lanAddress()) return;
  const adapter = controlAdapter();
  const server = new RemoteServer(adapter);
  const info = await server.start(48932);
  const ip = ipOf(server);
  try {
    const res = await rawPost(ip, server.port, `/control/send?token=${info.token}`, server.host, { text: "hello from the phone" });
    assert.equal(res.status, 202);
    assert.deepEqual(adapter.calls, [{ type: "send", text: "hello from the phone" }]);
  } finally {
    server.stop();
  }
});

test("POST /control/send is rejected 409 while the agent is busy — the phone can't race the desktop into a second turn", async () => {
  if (!lanAddress()) return;
  const adapter = controlAdapter({ busy: true });
  const server = new RemoteServer(adapter);
  const info = await server.start(48933);
  const ip = ipOf(server);
  try {
    const res = await rawPost(ip, server.port, `/control/send?token=${info.token}`, server.host, { text: "hello" });
    assert.equal(res.status, 409);
    assert.equal(adapter.calls.length, 0); // never dispatched — busy check happens before onControl
  } finally {
    server.stop();
  }
});

test("POST /control/send with missing/blank text is rejected with 400", async () => {
  if (!lanAddress()) return;
  const adapter = controlAdapter();
  const server = new RemoteServer(adapter);
  const info = await server.start(48934);
  const ip = ipOf(server);
  try {
    const missing = await rawPost(ip, server.port, `/control/send?token=${info.token}`, server.host, {});
    assert.equal(missing.status, 400);
    const blank = await rawPost(ip, server.port, `/control/send?token=${info.token}`, server.host, { text: "   " });
    assert.equal(blank.status, 400);
    assert.equal(adapter.calls.length, 0);
  } finally {
    server.stop();
  }
});

test("POST /control/permission with a valid token dispatches a 'permissionChoice' message — same map onWebviewMessage's case uses", async () => {
  if (!lanAddress()) return;
  const adapter = controlAdapter();
  const server = new RemoteServer(adapter);
  const info = await server.start(48935);
  const ip = ipOf(server);
  try {
    const res = await rawPost(ip, server.port, `/control/permission?token=${info.token}`, server.host, {
      id: "call-1",
      optionId: "allow-once",
    });
    assert.equal(res.status, 200);
    assert.deepEqual(adapter.calls, [{ type: "permissionChoice", id: "call-1", optionId: "allow-once" }]);
  } finally {
    server.stop();
  }
});

test("POST /control/permission without a valid token is rejected with 401", async () => {
  if (!lanAddress()) return;
  const adapter = controlAdapter();
  const server = new RemoteServer(adapter);
  await server.start(48936);
  const ip = ipOf(server);
  try {
    const res = await rawPost(ip, server.port, "/control/permission", server.host, { id: "x", optionId: "y" });
    assert.equal(res.status, 401);
    assert.equal(adapter.calls.length, 0);
  } finally {
    server.stop();
  }
});

test("POST /control/permission is NOT blocked by the busy flag — resolving a mid-turn permission must always be allowed through", async () => {
  if (!lanAddress()) return;
  const adapter = controlAdapter({ busy: true });
  const server = new RemoteServer(adapter);
  const info = await server.start(48937);
  const ip = ipOf(server);
  try {
    const res = await rawPost(ip, server.port, `/control/permission?token=${info.token}`, server.host, {
      id: "call-1",
      optionId: "allow-once",
    });
    assert.equal(res.status, 200);
    assert.equal(adapter.calls.length, 1);
  } finally {
    server.stop();
  }
});

test("POST /control/setMode with a valid token dispatches a 'setMode' message", async () => {
  if (!lanAddress()) return;
  const adapter = controlAdapter();
  const server = new RemoteServer(adapter);
  const info = await server.start(48938);
  const ip = ipOf(server);
  try {
    const res = await rawPost(ip, server.port, `/control/setMode?token=${info.token}`, server.host, { mode: "approve" });
    assert.equal(res.status, 200);
    assert.deepEqual(adapter.calls, [{ type: "setMode", mode: "approve" }]);
  } finally {
    server.stop();
  }
});

test("control routes 501 when the adapter doesn't support onControl (view-only adapter, matching Phase A's shape)", async () => {
  if (!lanAddress()) return;
  const server = new RemoteServer(fakeAdapter()); // no isBusy/onControl — a view-only adapter shape
  const info = await server.start(48939);
  const ip = ipOf(server);
  try {
    const res = await rawPost(ip, server.port, `/control/send?token=${info.token}`, server.host, { text: "hi" });
    assert.equal(res.status, 501);
  } finally {
    server.stop();
  }
});

test("malformed JSON body on a control route is rejected with 400, not a crash", async () => {
  if (!lanAddress()) return;
  const adapter = controlAdapter();
  const server = new RemoteServer(adapter);
  const info = await server.start(48940);
  const ip = ipOf(server);
  try {
    const res = await new Promise((resolve, reject) => {
      const req = http.request(
        {
          host: ip,
          port: server.port,
          path: `/control/send?token=${info.token}`,
          method: "POST",
          headers: { Host: server.host, "Content-Type": "application/json" },
        },
        (r) => {
          let b = "";
          r.on("data", (d) => (b += d));
          r.on("end", () => resolve({ status: r.statusCode, body: b }));
        },
      );
      req.on("error", reject);
      req.end("{not valid json");
    });
    assert.equal(res.status, 400);
    assert.equal(adapter.calls.length, 0);
  } finally {
    server.stop();
  }
});

test("unknown /control/* path 404s; a GET to a control path is rejected (control routes are POST-only)", async () => {
  if (!lanAddress()) return;
  const adapter = controlAdapter();
  const server = new RemoteServer(adapter);
  const info = await server.start(48941);
  const ip = ipOf(server);
  try {
    const unknown = await rawPost(ip, server.port, `/control/nope?token=${info.token}`, server.host, {});
    assert.equal(unknown.status, 404);
    const getInstead = await rawGet(ip, server.port, `/control/send?token=${info.token}`, server.host);
    assert.equal(getInstead.status, 404); // GET isn't routed for /control/* at all — falls through to the GET 404 branch
  } finally {
    server.stop();
  }
});
