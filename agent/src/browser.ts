/**
 * `browser_preview` tool implementation — lets the agent load a LOCALHOST-ONLY
 * dev server/webview it just built in a real Chrome/Edge and get back text
 * signals (HTTP status, title, console errors/warnings, page text), PLUS the
 * screenshot itself so a human watching the chat can see the agent's visual
 * verification happen live (loop.ts/server.ts carry it to the client as a
 * separate `image` attachment alongside the text — see `ToolRunResult` in
 * tools.ts). The MODEL still only ever sees the text summary below: no
 * screenshot bytes are fed back to the model as vision input (see
 * `runBrowserPreview`'s doc comment below) — that's a separately scoped
 * future phase (a real `image` ContentBlock variant + provider adapter
 * support + a model-capability gate).
 *
 * Uses `playwright-core` (NOT the full `playwright` package, which downloads
 * ~170-300MB of bundled Chromium binaries via postinstall — incompatible
 * with this repo's dependency-free philosophy and single-file
 * `esbuild --bundle` packaging, see `package.json`'s `bundle` script).
 * `playwright-core` ships no browser at all; it drives whatever's already
 * installed via `{ channel: "chrome" }` / `{ channel: "msedge" }`, falling
 * back cleanly (see `launchBrowser`) instead of crashing when neither exists.
 *
 * SECURITY — this is the load-bearing part of this module, read before
 * touching it:
 *
 * `floor.ts`'s `floorCheck()` is completely skipped in royal mode (`loop.ts`'s
 * royal branch only calls the separate, much narrower `royalTamperCheck()`).
 * That means ANY loopback-only restriction placed in floor.ts would be
 * silently void in the one mode with zero permission prompts and the highest
 * blast radius. So the loopback enforcement here is NOT a floor.ts rule —
 * it's a hard, unconditional check inside this tool's own code, on every
 * code path, regardless of which mode invoked it:
 *
 *  1. `validateInitialUrl` rejects anything whose hostname isn't the LITERAL
 *     string `127.0.0.1`, `::1`, or `localhost` (case-insensitive only for
 *     the hostname string itself), and rejects `file:` (and any non-http(s))
 *     scheme outright. Deliberately no DNS resolution here — resolving the
 *     hostname and checking the resolved IP would open a DNS-rebinding hole:
 *     the check could pass against a first resolution that points at
 *     127.0.0.1, then the actual connection re-resolves to something else.
 *     Matching the literal, pre-resolution hostname string closes that gap.
 *  2. Every subsequent in-page navigation (JS `location = ...`, a 30x
 *     response, a `<meta refresh>`) is intercepted via `context.route()`
 *     BEFORE it reaches the network and aborted if it isn't loopback — a
 *     page that starts on localhost can still try to redirect elsewhere
 *     mid-session, and the disallowed host must never actually be contacted.
 *  3. `page.on("framenavigated")` is a second, independent check — defense
 *     in depth in case a disallowed navigation ever committed despite (2),
 *     which should be impossible. If it ever fires, the whole call fails
 *     loudly instead of silently extracting/screenshotting untrusted content.
 *  4. Every call gets a fresh, isolated `browser.newContext()` — never the
 *     browser's default context — so no cookies/localStorage/session state
 *     persists across calls, and this never touches the user's real,
 *     logged-in browser profile.
 *
 * See test/browser.test.ts for regression coverage of all four.
 */
import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import { chromium } from "playwright-core";
import { summarizeText } from "./audit.js";

export interface BrowserPreviewInput {
  url: string;
  wait_for_selector?: string;
  timeout_ms?: number;
}

/**
 * `runBrowserPreview`'s result: `text` is the same model-facing summary this
 * tool has always returned (HTTP status, title, console entries, page text,
 * ...) — untouched by this. `image`, when a screenshot was actually
 * captured, is an ADDITIVE side-channel for the UI layer only (see
 * `tools.ts`'s `ToolRunResult`) — `base64` is the exact bytes already
 * written to `path` on disk, re-used from `page.screenshot()`'s own return
 * value rather than reading the file back a second time.
 */
export interface BrowserPreviewResult {
  text: string;
  image?: { mimeType: string; base64: string; path: string };
}

const DEFAULT_TIMEOUT_MS = 15_000;
const MAX_PAGE_TEXT_CHARS = 4_000;
const MAX_CONSOLE_ENTRIES = 30;
const MAX_CONSOLE_ENTRY_CHARS = 500;

/**
 * Literal-string-only loopback allowlist — see module doc comment §1.
 * Strips surrounding `[...]` brackets first: WHATWG `URL.hostname` renders
 * an IPv6 literal WITH brackets (`new URL("https://[::1]/").hostname ===
 * "[::1]"`), so without this normalization a bracketed `::1` would be
 * silently rejected even though it's the exact host this allowlist means to
 * accept.
 */
export function isLoopbackHost(hostname: string): boolean {
  const h = hostname.toLowerCase().replace(/^\[|\]$/g, "");
  return h === "127.0.0.1" || h === "::1" || h === "localhost";
}

/**
 * Validate the tool's `url` input before ANY browser/network activity.
 * Throws a plain Error with a message suitable for surfacing straight back
 * to the model as a tool error. Exported for direct unit testing of the
 * pure validation logic without spinning up a browser.
 */
export function validateInitialUrl(raw: string): URL {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    throw new Error(`browser_preview: "${raw}" is not a valid URL.`);
  }
  if (u.protocol === "file:") {
    throw new Error("browser_preview: file:// URLs are not allowed — this tool is loopback-HTTP(S) only.");
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") {
    throw new Error(
      `browser_preview: unsupported protocol "${u.protocol}" — only http/https loopback URLs are allowed.`,
    );
  }
  if (!isLoopbackHost(u.hostname)) {
    throw new Error(
      `browser_preview: hostname "${u.hostname}" is not allowed. Only the literal hosts 127.0.0.1, ::1, or ` +
        `localhost are permitted (no DNS resolution is performed before this check, so this also blocks ` +
        `DNS-rebinding attempts hiding behind those hostnames).`,
    );
  }
  return u;
}

/** True if a URL string is safe to navigate/route to under the loopback allowlist. */
function isAllowedNavigationTarget(rawUrl: string): boolean {
  try {
    const u = new URL(rawUrl);
    if (u.protocol === "file:") return false;
    if (u.protocol !== "http:" && u.protocol !== "https:") return false;
    return isLoopbackHost(u.hostname);
  } catch {
    return false;
  }
}

async function launchBrowser() {
  const errors: string[] = [];
  for (const channel of ["chrome", "msedge"] as const) {
    try {
      return await chromium.launch({ channel, headless: true });
    } catch (err: any) {
      errors.push(`${channel}: ${err?.message ?? String(err)}`);
    }
  }
  throw new Error(
    "browser_preview: no system Chrome or Edge browser found (playwright-core drives the system browser, it " +
      `does not bundle one). Install Google Chrome or Microsoft Edge, then retry.\n${errors.join("\n")}`,
  );
}

/**
 * Run one `browser_preview` tool call: load `input.url` in an isolated
 * browser context, capture load-time signals, save a screenshot to disk, and
 * return a text summary PLUS the screenshot as a UI-only `image` attachment
 * (see `BrowserPreviewResult` above). The returned `text` never contains
 * image data and is exactly what the model sees — no provider/ContentBlock
 * changes happen here, by design (that's the separately scoped "vision
 * input" phase).
 */
export async function runBrowserPreview(
  input: BrowserPreviewInput,
  cwd: string,
  signal?: AbortSignal,
): Promise<BrowserPreviewResult> {
  if (signal?.aborted) throw new Error("browser_preview: cancelled before starting");

  // §1 — hard, unconditional, pre-browser check. Nothing below this line
  // runs unless the INITIAL url is already loopback-literal.
  const targetUrl = validateInitialUrl(input.url);
  const timeoutMs = input.timeout_ms ?? DEFAULT_TIMEOUT_MS;

  const browser = await launchBrowser();
  const onAbort = () => {
    browser.close().catch(() => {});
  };
  signal?.addEventListener("abort", onAbort, { once: true });

  try {
    // §4 — fresh, isolated context per call: no shared cookies/localStorage,
    // never the browser's default/real user profile.
    const context = await browser.newContext();
    try {
      const page = await context.newPage();

      const consoleEntries: string[] = [];
      page.on("console", (msg) => {
        const type = msg.type();
        if ((type === "error" || type === "warning") && consoleEntries.length < MAX_CONSOLE_ENTRIES) {
          consoleEntries.push(`[${type}] ${msg.text()}`);
        }
      });
      page.on("pageerror", (err) => {
        if (consoleEntries.length < MAX_CONSOLE_ENTRIES) {
          consoleEntries.push(`[error] uncaught exception: ${err.message}`);
        }
      });

      // §2 — block any in-page navigation that would leave the loopback
      // allowlist, BEFORE it reaches the network. This also covers the very
      // first navigation (page.goto below), which is harmless since it was
      // already validated by validateInitialUrl above and will simply pass
      // through.
      const blockedNavigations: string[] = [];
      await context.route("**/*", async (route) => {
        const req = route.request();
        if (req.isNavigationRequest() && req.frame() === page.mainFrame() && !isAllowedNavigationTarget(req.url())) {
          blockedNavigations.push(req.url());
          await route.abort("blockedbyclient").catch(() => {});
          return;
        }
        await route.continue().catch(() => {});
      });

      // §3 — defense in depth: independent check, should never fire given
      // §2, but if it does, treat it as fatal rather than trusting the page.
      let escapedLoopback: string | null = null;
      page.on("framenavigated", (frame) => {
        if (frame !== page.mainFrame()) return;
        const url = frame.url();
        if (url === "about:blank") return;
        if (!isAllowedNavigationTarget(url)) escapedLoopback = url;
      });

      let status: number | null = null;
      let gotoError: string | null = null;
      try {
        const response = await page.goto(targetUrl.toString(), { waitUntil: "load", timeout: timeoutMs });
        status = response?.status() ?? null;
      } catch (err: any) {
        gotoError = err?.message ?? String(err);
      }

      if (escapedLoopback) {
        throw new Error(
          `browser_preview: blocked — the page navigated outside the loopback allowlist to "${escapedLoopback}" mid-session.`,
        );
      }

      let selectorFound: boolean | null = null;
      if (input.wait_for_selector) {
        try {
          await page.waitForSelector(input.wait_for_selector, { timeout: Math.min(timeoutMs, 10_000) });
          selectorFound = true;
        } catch {
          selectorFound = false;
        }
      }

      const title = await page.title().catch(() => "");
      const pageText = await page
        .evaluate(() => document.body?.innerText ?? "")
        .catch(() => "");

      // Screenshot saved to a workspace-scoped path — never sent to the
      // model (v1a is text-signals-only for the model), but now ALSO
      // returned to the caller as `image` below so the UI can render it
      // inline for a human. `page.screenshot({ path })` both writes the
      // file AND resolves with the identical bytes, so this reuses that one
      // buffer rather than reading the file back a second time.
      const shotDir = resolve(cwd, ".lakshx", "tmp");
      await mkdir(shotDir, { recursive: true });
      const shotPath = resolve(shotDir, `preview-${Date.now()}.png`);
      const screenshotBuf = await page.screenshot({ path: shotPath }).catch(() => null);

      const lines: string[] = [];
      lines.push(`URL: ${targetUrl.toString()}`);
      lines.push(`HTTP status: ${status ?? "(none — navigation did not complete)"}`);
      if (gotoError) lines.push(`Navigation error: ${summarizeText(gotoError, 300)}`);
      lines.push(`Page title: ${title || "(empty)"}`);
      if (input.wait_for_selector) {
        lines.push(
          `wait_for_selector "${input.wait_for_selector}": ${selectorFound ? "found" : "NOT found within timeout"}`,
        );
      }
      if (blockedNavigations.length) {
        lines.push(
          `SECURITY: blocked ${blockedNavigations.length} in-page navigation attempt(s) outside the loopback ` +
            `allowlist: ${blockedNavigations.slice(0, 5).map((u) => summarizeText(u, 200)).join(", ")}`,
        );
      }
      lines.push(`Console errors/warnings (${consoleEntries.length}):`);
      lines.push(
        consoleEntries.length
          ? consoleEntries.map((e) => `  ${summarizeText(e, MAX_CONSOLE_ENTRY_CHARS)}`).join("\n")
          : "  (none)",
      );
      lines.push(
        screenshotBuf
          ? `Screenshot saved (shown to the human in chat, not sent to you): ${shotPath}`
          : `Screenshot: capture failed — none saved.`,
      );
      lines.push(`Page text (capped):\n${summarizeText(pageText, MAX_PAGE_TEXT_CHARS) || "(empty)"}`);

      return {
        text: lines.join("\n"),
        image: screenshotBuf ? { mimeType: "image/png", base64: screenshotBuf.toString("base64"), path: shotPath } : undefined,
      };
    } finally {
      await context.close().catch(() => {});
    }
  } finally {
    signal?.removeEventListener("abort", onAbort);
    await browser.close().catch(() => {});
  }
}
