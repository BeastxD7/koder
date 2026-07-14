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
    assert.match(res.body, /<title>Koder Remote<\/title>/);
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
