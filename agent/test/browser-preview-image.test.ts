/**
 * Loop-level test for the `browser_preview` screenshot side-channel — the
 * gap this feature closes: the agent already ran browser_preview, but the
 * screenshot only ever sat on disk, never surfaced anywhere a human could
 * see it happen. This proves `runPrompt()`'s single `spec.run()` dispatch
 * site (loop.ts) correctly normalizes `browser_preview`'s
 * `{ text, image }` return into `LoopCallbacks.onToolEnd`'s new optional
 * `image` field — WITHOUT leaking any image data into the model-facing
 * tool_result content, which must stay exactly what it always was (a plain
 * text string), per tools.ts's `ToolRunResult` doc comment ("additive,
 * never a breaking change to the shared tool-result shape").
 *
 * Chrome/Edge-gated, like test/browser.test.ts's own e2e suite — skips
 * (never fails) when neither is installed.
 */
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { chromium } from "playwright-core";
import { _resetGuardCacheForTests } from "../src/checkpoint.js";
import type { AgentSession, LoopCallbacks } from "../src/loop.js";
import { runPrompt } from "../src/loop.js";
import type { ToolImageAttachment } from "../src/tools.js";
import { FakeOpenAI, textTurn, toolTurn } from "./helpers/fake-openai.js";

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

function makeRecordingCallbacks(): LoopCallbacks & {
  toolEnds: Array<{ id: string; output: string; isError: boolean; image?: ToolImageAttachment }>;
} {
  const toolEnds: Array<{ id: string; output: string; isError: boolean; image?: ToolImageAttachment }> = [];
  return {
    onText: () => {},
    onThinking: () => {},
    onToolStart: () => {},
    onToolEnd: (c) => toolEnds.push(c),
    onPermission: async () => true,
    toolEnds,
  };
}

async function setupHome(fake: FakeOpenAI): Promise<string> {
  const home = await mkdtemp(join(tmpdir(), "lakshx-bpi-home-"));
  await mkdir(join(home, ".lakshx"), { recursive: true });
  await writeFile(
    join(home, ".lakshx", "providers.json"),
    JSON.stringify({
      defaultModel: "fake/test-model",
      providers: { fake: { kind: "openai", baseUrl: `http://127.0.0.1:${fake.port}/v1`, apiKey: "test-key-123" } },
    }),
  );
  return home;
}

test(
  "runPrompt: browser_preview's screenshot reaches onToolEnd as `image`, and never leaks into the model-facing tool_result text",
  async (t) => {
    if (!(await canLaunchBrowser())) {
      t.skip("no system Chrome/Edge available in this environment");
      return;
    }

    const fake = new FakeOpenAI();
    await fake.start();
    const home = await setupHome(fake);
    const workspace = await mkdtemp(join(tmpdir(), "lakshx-bpi-ws-"));
    const realHome = process.env.HOME;
    process.env.HOME = home;
    _resetGuardCacheForTests();

    const page = await serveHtml(`<!doctype html><html><head><title>Screenshot Test</title></head><body>hi</body></html>`);

    try {
      const session: AgentSession = { cwd: workspace, model: "fake/test-model", mode: "auto", history: [] };
      const cb = makeRecordingCallbacks();

      fake.enqueue(toolTurn("call_bp1", "browser_preview", { url: page.url }));
      fake.enqueue(textTurn("checked it"));

      const stop = await runPrompt(session, "check the page", cb, "pr_bp_image");
      assert.equal(stop, "end_turn");

      assert.equal(cb.toolEnds.length, 1);
      const end = cb.toolEnds[0];
      assert.equal(end.isError, false);

      // The image attachment arrived, with real PNG bytes and a path under
      // this workspace's .lakshx/tmp — exactly what browser.ts produces.
      assert.ok(end.image, "expected onToolEnd to carry an image attachment");
      assert.equal(end.image!.mimeType, "image/png");
      assert.ok(end.image!.path.includes(join(workspace, ".lakshx", "tmp")));
      const bytes = Buffer.from(end.image!.base64, "base64");
      assert.deepEqual([...bytes.subarray(0, 8)], [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

      // The model-facing tool_result content — what actually went into
      // session.history — must stay TEXT ONLY: no base64/image data leaked
      // into what the model sees, and `onToolEnd`'s own `output` string is
      // like every other tool's, unaffected by the new `image` field.
      assert.equal(typeof end.output, "string");
      assert.ok(!end.output.includes("base64"));
      assert.match(end.output, /Page title: Screenshot Test/);

      const toolResultMsg = session.history.find(
        (m) => m.role === "user" && m.content.some((b: any) => b.type === "tool_result"),
      );
      assert.ok(toolResultMsg, "expected a tool_result message in history");
      const toolResult: any = toolResultMsg!.content.find((b: any) => b.type === "tool_result");
      assert.equal(typeof toolResult.content, "string");
      assert.ok(!toolResult.content.includes("base64"));
    } finally {
      process.env.HOME = realHome;
      await page.close();
      await fake.stop();
    }
  },
);
