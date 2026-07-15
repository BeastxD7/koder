/** Smoke test: drive the LakshX runtime over ACP exactly like the panel will. */
import { spawn } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Readable, Writable } from "node:stream";
import * as acp from "@agentclientprotocol/sdk";

const __dirname = dirname(fileURLToPath(import.meta.url));
const server = join(__dirname, "server.ts");
const workspace = resolve(__dirname, "../../examples/acp-demo");

const child = spawn("npx", ["tsx", server], {
  stdio: ["pipe", "pipe", "inherit"],
  cwd: workspace,
});
const stream = acp.ndJsonStream(
  Writable.toWeb(child.stdin),
  Readable.toWeb(child.stdout) as ReadableStream<Uint8Array>,
);

try {
  await acp
    .client({ name: "lakshx-test" })
    .onRequest(acp.methods.client.session.requestPermission, async (ctx) => {
      console.log(`  [permission] ${ctx.params.toolCall.title} → auto-allow`);
      return { outcome: { outcome: "selected", optionId: "allow" } };
    })
    .connectWith(stream, async (ctx) => {
      const init = await ctx.request(acp.methods.agent.initialize, {
        protocolVersion: acp.PROTOCOL_VERSION,
        clientCapabilities: {},
      });
      console.log(`✅ initialize ok (protocol v${init.protocolVersion})`);

      const models = await ctx.request<{ defaultModel: string; providers: string[] }>("lakshx/models", {});
      console.log(`✅ lakshx/models → default=${models.defaultModel} providers=[${models.providers.join(", ")}]`);

      if (models.providers.length === 0) {
        console.log("⚠️  no API keys configured — skipping live prompt (set ANTHROPIC_API_KEY etc.)");
        return;
      }

      return ctx.buildSession(workspace).withSession(async (session) => {
        console.log(`✅ session ${session.sessionId}`);
        session.prompt("Run `echo lakshx-runtime-ok` with bash and tell me the output. Be brief.");
        for (;;) {
          const msg = await session.nextUpdate();
          if (msg.kind === "stop") {
            console.log(`\n✅ stopReason=${msg.response.stopReason}`);
            return;
          }
          const u: any = msg.update;
          if (u.sessionUpdate === "agent_message_chunk" && u.content.type === "text") {
            process.stdout.write(u.content.text);
          } else if (u.sessionUpdate === "tool_call") {
            console.log(`\n  [tool] ${u.title} (${u.status})`);
          } else if (u.sessionUpdate === "tool_call_update") {
            console.log(`  [tool] ${u.toolCallId} → ${u.status}`);
          }
        }
      });
    });
  console.log("🎉 runtime smoke test PASSED");
} finally {
  child.kill();
  process.exit(0);
}
