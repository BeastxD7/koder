/**
 * Unit + e2e tests for src/browser.ts — the `browser_preview` tool.
 *
 * The security boundary (loopback-only, no DNS resolution, no file://, no
 * mid-session redirect out of the allowlist, isolated context per call) is
 * the part that most needs a regression guard — see the module doc comment
 * on src/browser.ts for the full threat model this defends against
 * (floor.ts's floorCheck() is skipped entirely in royal mode, so this
 * enforcement lives in the tool's own run() path, not floor.ts).
 *
 * The pure-validation tests (isLoopbackHost / validateInitialUrl, and
 * runBrowserPreview rejecting a non-loopback URL) never launch a browser —
 * they run in any CI environment. The e2e tests actually drive a system
 * Chrome/Edge against a local HTTP server and are skipped (not failed) when
 * neither is installed.
 */
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { chromium } from "playwright-core";
import { isLoopbackHost, runBrowserPreview, validateInitialUrl } from "../src/browser.js";

async function withTmp<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), "lakshx-browser-"));
  try {
    return await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/** Serve `html` at "/" on a random port; returns the base URL and a closer. */
async function serveHtml(html: string): Promise<{ url: string; close: () => Promise<void> }> {
  const server: Server = createServer((_req, res) => {
    res.writeHead(200, { "content-type": "text/html" });
    res.end(html);
  });
  await new Promise<void>((res) => server.listen(0, "127.0.0.1", res));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("expected a network address");
  return {
    url: `http://127.0.0.1:${address.port}/`,
    close: () => new Promise((res) => server.close(() => res())),
  };
}

/**
 * Whether a system Chrome or Edge is actually launchable here — e2e tests
 * skip (not fail) if not. Memoized: each real launch spawns several native
 * Chrome processes, and node:test runs test *files* concurrently by
 * default, so re-probing per-test measurably adds to system load that other
 * files' timing-sensitive tests (e.g. checkpoint.test.ts's crash-window
 * test) can be sensitive to. One probe launch, cached, keeps this file's
 * total Chrome-process footprint down to one per actual e2e test run.
 */
let browserAvailable: Promise<boolean> | undefined;
function canLaunchBrowser(): Promise<boolean> {
  if (!browserAvailable) {
    browserAvailable = (async () => {
      for (const channel of ["chrome", "msedge"] as const) {
        try {
          const b = await chromium.launch({ channel, headless: true });
          await b.close();
          return true;
        } catch {
          /* try next channel */
        }
      }
      return false;
    })();
  }
  return browserAvailable;
}

/* ==================== pure validation — no browser required ==================== */

test("isLoopbackHost accepts only the literal loopback hostnames", () => {
  assert.equal(isLoopbackHost("127.0.0.1"), true);
  assert.equal(isLoopbackHost("::1"), true);
  assert.equal(isLoopbackHost("localhost"), true);
  assert.equal(isLoopbackHost("LOCALHOST"), true); // hostname casing only
});

test("isLoopbackHost rejects near-miss and adjacent hosts", () => {
  // Other addresses in the 127.0.0.0/8 loopback block are NOT accepted —
  // the spec calls for exact literal matches only, not the whole CIDR block.
  assert.equal(isLoopbackHost("127.0.0.2"), false);
  assert.equal(isLoopbackHost("0.0.0.0"), false);
  assert.equal(isLoopbackHost("example.com"), false);
  // hostname-confusion attempts — must not match as a substring/suffix
  assert.equal(isLoopbackHost("localhost.evil.com"), false);
  assert.equal(isLoopbackHost("127.0.0.1.evil.com"), false);
  assert.equal(isLoopbackHost("evil-localhost"), false);
});

test("validateInitialUrl accepts loopback http/https URLs with any port/path", () => {
  assert.doesNotThrow(() => validateInitialUrl("http://localhost:3000/"));
  assert.doesNotThrow(() => validateInitialUrl("http://127.0.0.1:8080/some/path?x=1"));
  assert.doesNotThrow(() => validateInitialUrl("https://[::1]:5173/"));
});

test("validateInitialUrl rejects a non-localhost URL — the core security regression case", () => {
  assert.throws(() => validateInitialUrl("https://example.com"), /not allowed/);
  assert.throws(() => validateInitialUrl("http://8.8.8.8/"), /not allowed/);
  assert.throws(() => validateInitialUrl("http://internal.corp.example/"), /not allowed/);
});

test("validateInitialUrl rejects file:// URLs entirely", () => {
  assert.throws(() => validateInitialUrl("file:///etc/passwd"), /file:\/\//);
});

test("validateInitialUrl rejects non-http(s) schemes", () => {
  assert.throws(() => validateInitialUrl("ftp://localhost/x"), /unsupported protocol/);
  assert.throws(() => validateInitialUrl("ws://localhost:1234"), /unsupported protocol/);
});

test("validateInitialUrl rejects garbage input", () => {
  assert.throws(() => validateInitialUrl("not a url"), /not a valid URL/);
});

test(
  "runBrowserPreview rejects a non-localhost URL before ever touching a browser (no Chrome required)",
  async () => {
    await withTmp(async (dir) => {
      await assert.rejects(
        runBrowserPreview({ url: "https://example.com" }, dir),
        /not allowed/,
      );
      // Confirms rejection happened pre-launch, not just eventually: no
      // screenshot directory should have been created.
      assert.equal(existsSync(join(dir, ".lakshx")), false);
    });
  },
);

test("runBrowserPreview rejects file:// before touching a browser", async () => {
  await withTmp(async (dir) => {
    await assert.rejects(runBrowserPreview({ url: "file:///etc/passwd" }, dir), /file:\/\//);
  });
});

/* ==================== e2e — real Chrome/Edge against a local server ==================== */

test("e2e: browser_preview reports status, title, console errors/warnings, and selector match", async (t) => {
  if (!(await canLaunchBrowser())) {
    t.skip("no system Chrome/Edge available in this environment");
    return;
  }
  const page = await serveHtml(`<!doctype html>
<html><head><title>Test Page</title></head>
<body>
  <div id="app">Hello</div>
  <script>
    console.error("boom");
    console.warn("careful");
  </script>
</body></html>`);
  try {
    await withTmp(async (dir) => {
      const result = await runBrowserPreview({ url: page.url, wait_for_selector: "#app" }, dir);
      assert.match(result.text, /HTTP status: 200/);
      assert.match(result.text, /Page title: Test Page/);
      assert.match(result.text, /\[error\] boom/);
      assert.match(result.text, /\[warning\] careful/);
      assert.match(result.text, /wait_for_selector "#app": found/);
      assert.match(result.text, /Screenshot saved/);

      // Screenshot actually landed under the workspace-scoped .lakshx/tmp path.
      const shots = await readdir(join(dir, ".lakshx", "tmp"));
      assert.equal(shots.length, 1);
      assert.match(shots[0], /^preview-\d+\.png$/);

      // The same screenshot is ALSO returned as an `image` attachment (the
      // UI side-channel loop.ts/server.ts carry to the client — see
      // tools.ts's ToolImageAttachment) — proves the returned base64 is
      // real image bytes, not just a stub, and that its `path` matches the
      // file actually saved to disk.
      assert.ok(result.image, "expected an image attachment");
      assert.equal(result.image!.mimeType, "image/png");
      assert.equal(result.image!.path, join(dir, ".lakshx", "tmp", shots[0]));
      const bytes = Buffer.from(result.image!.base64, "base64");
      assert.ok(bytes.length > 8, "expected non-trivial image bytes");
      // PNG magic number — confirms this decodes to a real PNG, not garbage.
      assert.deepEqual([...bytes.subarray(0, 8)], [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    });
  } finally {
    await page.close();
  }
});

test("e2e: browser_preview reports a missing selector without failing the call", async (t) => {
  if (!(await canLaunchBrowser())) {
    t.skip("no system Chrome/Edge available in this environment");
    return;
  }
  const page = await serveHtml(`<!doctype html><html><head><title>No Selector</title></head><body>plain</body></html>`);
  try {
    await withTmp(async (dir) => {
      const result = await runBrowserPreview({ url: page.url, wait_for_selector: "#does-not-exist", timeout_ms: 2000 }, dir);
      assert.match(result.text, /wait_for_selector "#does-not-exist": NOT found/);
    });
  } finally {
    await page.close();
  }
});

test(
  "e2e SECURITY: an in-page redirect to a non-loopback host is blocked, never reached",
  async (t) => {
    if (!(await canLaunchBrowser())) {
      t.skip("no system Chrome/Edge available in this environment");
      return;
    }
    const page = await serveHtml(`<!doctype html>
<html><head><title>Redirect Attempt</title></head>
<body>
  <script>window.location.href = "http://evil.invalid.test/steal";</script>
</body></html>`);
    try {
      await withTmp(async (dir) => {
        let result: { text: string; image?: { mimeType: string; base64: string; path: string } } | undefined;
        let thrown: unknown;
        try {
          result = await runBrowserPreview({ url: page.url, timeout_ms: 5000 }, dir);
        } catch (err) {
          thrown = err;
        }
        if (thrown) {
          // Defense-in-depth path (framenavigated) firing is also an
          // acceptable outcome — either way, "reached evil.invalid.test
          // silently" is the one outcome that must never happen.
          assert.match(String((thrown as Error).message ?? thrown), /blocked/i);
        } else {
          assert.ok(result, "expected a result when not thrown");
          assert.match(result!.text, /SECURITY: blocked/);
          assert.match(result!.text, /evil\.invalid\.test/);
          // The original page's title must still be intact — proof the
          // browser never actually navigated to the disallowed host.
          assert.match(result!.text, /Page title: Redirect Attempt/);
        }
      });
    } finally {
      await page.close();
    }
  },
);

test("e2e: each call gets an isolated context — no cookies persist across calls", async (t) => {
  if (!(await canLaunchBrowser())) {
    t.skip("no system Chrome/Edge available in this environment");
    return;
  }
  // First visit sets a cookie via a Set-Cookie header; second (separate)
  // call to the SAME server must arrive with no Cookie header at all if
  // contexts are truly isolated per call.
  let secondRequestCookieHeader: string | undefined | null = null;
  const server = createServer((req, res) => {
    if (req.url === "/set") {
      res.writeHead(200, { "content-type": "text/html", "set-cookie": "sid=secret-session; Path=/" });
      res.end("<title>Set</title>");
      return;
    }
    secondRequestCookieHeader = req.headers.cookie ?? undefined;
    res.writeHead(200, { "content-type": "text/html" });
    res.end("<title>Check</title>");
  });
  await new Promise<void>((res) => server.listen(0, "127.0.0.1", res));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("expected a network address");
  const base = `http://127.0.0.1:${address.port}`;
  try {
    await withTmp(async (dir) => {
      await runBrowserPreview({ url: `${base}/set` }, dir);
      await runBrowserPreview({ url: `${base}/` }, dir);
      assert.equal(secondRequestCookieHeader, undefined);
    });
  } finally {
    await new Promise((res) => server.close(() => res(undefined)));
  }
});
