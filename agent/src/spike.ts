/**
 * Phase 0 spike: Koder ⇄ Claude Code over ACP (Agent Client Protocol).
 *
 * Proves the core architecture bet from PLAN.md: the agent runtime lives in its
 * own process and talks to the editor over ACP, so Claude Code / Codex / Gemini
 * are swappable runtimes. This client plays the "editor" role: it owns the
 * filesystem, renders session updates, and answers permission requests with a
 * receipt for every decision.
 *
 * Run: npm run spike  (requires `claude` CLI authenticated on this machine)
 */
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Readable, Writable } from "node:stream";
import * as acp from "@agentclientprotocol/sdk";

const __dirname = dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);

const workspace = resolve(__dirname, "../../examples/acp-demo");
const adapterBin = join(
  dirname(require.resolve("@zed-industries/claude-code-acp/package.json")),
  "dist/index.js",
);

const PROMPT = `Create a file named hello.ts that exports a function greet(name: string): string returning "Hello, <name>! — from Koder via ACP". Keep it minimal. Then stop.`;

function receipt(kind: string, detail: string) {
  console.log(`  ⎿  [receipt] ${kind}: ${detail}`);
}

async function main() {
  await mkdir(workspace, { recursive: true });

  // The agent is an independent process; scrub any enclosing Claude Code
  // session markers so the adapter doesn't refuse as a "nested session".
  const env = { ...process.env };
  delete env.CLAUDECODE;
  delete env.CLAUDE_CODE_ENTRYPOINT;
  delete env.CLAUDE_CODE_SSE_PORT;

  const agentProcess = spawn(process.execPath, [adapterBin], {
    stdio: ["pipe", "pipe", "inherit"],
    cwd: workspace,
    env,
  });
  const stream = acp.ndJsonStream(
    Writable.toWeb(agentProcess.stdin),
    Readable.toWeb(agentProcess.stdout),
  );

  try {
    const result = await acp
      .client({ name: "koder", version: "0.0.1" })
      .onRequest(acp.methods.client.session.requestPermission, async (ctx) => {
        const { toolCall, options } = ctx.params;
        // Phase 0 policy: auto-approve with a logged receipt. The real permission
        // ladder (Plan/Ask/Accept-edits/Auto) replaces this in Phase 1.
        const allow =
          options.find((o) => o.kind === "allow_once") ?? options[0];
        receipt("permission", `${toolCall.title ?? toolCall.toolCallId} → ${allow.name}`);
        return { outcome: { outcome: "selected", optionId: allow.optionId } };
      })
      .onRequest(acp.methods.client.fs.readTextFile, async (ctx) => {
        receipt("fs.read", ctx.params.path);
        return { content: await readFile(ctx.params.path, "utf8") };
      })
      .onRequest(acp.methods.client.fs.writeTextFile, async (ctx) => {
        receipt("fs.write", ctx.params.path);
        await mkdir(dirname(ctx.params.path), { recursive: true });
        await writeFile(ctx.params.path, ctx.params.content, "utf8");
        return {};
      })
      .connectWith(stream, async (ctx) => {
        const init = await ctx.request(acp.methods.agent.initialize, {
          protocolVersion: acp.PROTOCOL_VERSION,
          clientCapabilities: {
            fs: { readTextFile: true, writeTextFile: true },
          },
        });
        console.log(
          `✅ connected: ${init.agentCapabilities ? "claude-code-acp" : "agent"} (protocol v${init.protocolVersion})`,
        );

        return ctx.buildSession(workspace).withSession(async (session) => {
          console.log(`✅ session ${session.sessionId} in ${workspace}`);
          console.log(`\n💬 ${PROMPT}\n`);
          session.prompt(PROMPT);

          for (;;) {
            const message = await session.nextUpdate();
            if (message.kind === "stop") return message.response;

            const update = message.update;
            switch (update.sessionUpdate) {
              case "agent_message_chunk":
                if (update.content.type === "text") process.stdout.write(update.content.text);
                break;
              case "agent_thought_chunk":
                break; // keep spike output readable
              case "tool_call":
                console.log(`\n🔧 ${update.title} [${update.status}]`);
                break;
              case "tool_call_update":
                if (update.status) console.log(`   ↳ ${update.toolCallId}: ${update.status}`);
                break;
              case "plan":
                console.log(`\n📋 plan: ${update.entries.map((e) => e.content).join(" · ")}`);
                break;
              default:
                break;
            }
          }
        });
      });

    console.log(`\n\n✅ turn finished: ${result.stopReason}`);

    // Self-verification — the PLAN.md ethos: don't trust "done", check.
    const produced = await readFile(join(workspace, "hello.ts"), "utf8");
    if (!produced.includes("greet")) throw new Error("hello.ts missing greet()");
    console.log(`✅ verified: hello.ts exists (${produced.length} bytes) and defines greet()`);
    console.log("\n🎉 ACP spike PASSED — editor-independent agent runtime works.");
  } finally {
    agentProcess.kill();
  }
}

main().catch((err) => {
  console.error("\n❌ ACP spike failed:", err);
  process.exit(1);
});
