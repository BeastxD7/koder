/**
 * Scriptable fake OpenAI-compatible /chat/completions server (SSE).
 * Each incoming request pops the next scripted turn (a list of stream events)
 * and replays it as `data: {...}` SSE chunks followed by `data: [DONE]`.
 * Every request body is recorded for assertions.
 */
import { once } from "node:events";
import { createServer, type Server } from "node:http";

export type SseEvent = Record<string, unknown>;
export type ScriptedTurn = SseEvent[];

export interface RecordedRequest {
  model: string;
  messages: Array<Record<string, any>>;
  tools: Array<Record<string, any>>;
  [k: string]: unknown;
}

export class FakeOpenAI {
  /** Parsed JSON bodies of every /chat/completions request, in order. */
  requests: RecordedRequest[] = [];
  /** Authorization header of every request, in order. */
  authHeaders: Array<string | undefined> = [];
  /**
   * `Date.now()` when each request finished arriving (body fully read),
   * parallel to `requests`. Lets a test prove two requests were genuinely
   * in flight at the same time via WHEN they were dispatched (which mostly
   * reflects JS-side scheduling, not artificial response delay) rather than
   * total round-trip wall-clock time — the latter is sensitive to whatever
   * else is contending for CPU when the whole suite runs concurrently,
   * which arrival order is not.
   */
  requestTimestamps: number[] = [];
  port = 0;

  private script: ScriptedTurn[] = [];
  // Parallel to `script`, aligned by push order: how long (ms) to hold a
  // turn's response before writing it. Kept as a separate array (rather than
  // folding into ScriptedTurn's shape) so plain `enqueue()` — used by every
  // existing test — is completely unaffected; only `enqueueDelayed()` below
  // populates a non-zero entry.
  private scriptDelays: number[] = [];
  private stallScript: ScriptedTurn[] = [];
  private continuousScript: Array<{ intervalMs: number; factory: (i: number) => SseEvent }> = [];
  private activeIntervals: Set<ReturnType<typeof setInterval>> = new Set();
  private matchedScript: Array<{ match: (req: RecordedRequest) => boolean; turn: ScriptedTurn; delayMs: number }> = [];
  private server: Server | undefined;

  /** Queue one or more turns; each request consumes one turn FIFO. */
  enqueue(...turns: ScriptedTurn[]): void {
    this.script.push(...turns);
    for (const _ of turns) this.scriptDelays.push(0);
  }

  /**
   * Queue a turn keyed by CONTENT rather than arrival order — checked (in
   * registration order, first unconsumed match wins) BEFORE the plain FIFO
   * `script` queue. Needed whenever two logically-distinct request streams
   * are genuinely concurrent (e.g. a background subtask's own request race
   * against the spawning turn's own next model call) — plain FIFO position
   * is nondeterministic there (which one's HTTP request body finishes
   * arriving first depends on JS/event-loop scheduling, not test intent), so
   * asserting "the Nth request gets the Nth enqueued turn" is flaky. Matching
   * on the request's own `messages` (e.g. a specific tool_call_id's result, or
   * a child's distinctive first user-message text) makes the routing
   * independent of arrival order entirely.
   */
  enqueueMatched(match: (req: RecordedRequest) => boolean, turn: ScriptedTurn, delayMs = 0): void {
    this.matchedScript.push({ match, turn, delayMs });
  }

  /**
   * Same as `enqueue`, but the response is held for `delayMs` before being
   * written. Lets a test prove two requests were genuinely IN FLIGHT AT THE
   * SAME TIME (e.g. `dispatch_subtasks` fanning out concurrent subagents)
   * via wall-clock time, rather than just asserting both eventually
   * happened — a real ordering/timing proof, not just "both ran eventually".
   */
  enqueueDelayed(delayMs: number, turn: ScriptedTurn): void {
    this.script.push(turn);
    this.scriptDelays.push(delayMs);
  }

  /**
   * Queue a turn that streams the given events, then goes silent forever —
   * the connection is deliberately left open (no `[DONE]`, no `res.end()`),
   * simulating a stalled-but-not-closed SSE stream (dead proxy/VPN/upstream,
   * TCP alive, no more bytes ever). Checked ahead of the normal script so a
   * test can queue exactly one of these without disturbing `enqueue()`
   * ordering for everyone else. The connection is force-closed by `stop()`.
   */
  enqueueStall(events: ScriptedTurn): void {
    this.stallScript.push(events);
  }

  /**
   * Queue a turn that streams one event every `intervalMs`, forever — never
   * idle (unlike `enqueueStall`, which goes silent), never `[DONE]`, never
   * `res.end()`. Simulates a genuine runaway/continuous reasoning loop: the
   * model keeps emitting tokens without ever stopping, so a pure
   * silence-based idle timeout never trips. `factory(i)` builds the i-th
   * event (0-indexed); typically `reasoningDelta(...)` on a loop so the
   * client sees a real, growing thinking stream. The interval is force-torn
   * down by `stop()`.
   */
  enqueueContinuous(intervalMs: number, factory: (i: number) => SseEvent): void {
    this.continuousScript.push({ intervalMs, factory });
  }

  async start(): Promise<void> {
    this.server = createServer((req, res) => {
      let body = "";
      req.on("data", (c) => (body += c));
      req.on("end", () => {
        let parsed: RecordedRequest;
        try {
          parsed = JSON.parse(body);
        } catch {
          res.writeHead(400).end("bad json");
          return;
        }
        this.requests.push(parsed);
        this.authHeaders.push(req.headers.authorization);
        this.requestTimestamps.push(Date.now());

        const stall = this.stallScript.shift();
        if (stall) {
          res.writeHead(200, { "content-type": "text/event-stream" });
          for (const ev of stall) res.write(`data: ${JSON.stringify(ev)}\n\n`);
          // deliberately no [DONE], no res.end() — the socket stays open and silent
          return;
        }

        const matchedIdx = this.matchedScript.findIndex((m) => m.match(parsed));
        if (matchedIdx !== -1) {
          const { turn, delayMs } = this.matchedScript.splice(matchedIdx, 1)[0];
          const respondMatched = () => {
            res.writeHead(200, { "content-type": "text/event-stream" });
            for (const ev of turn) res.write(`data: ${JSON.stringify(ev)}\n\n`);
            res.write("data: [DONE]\n\n");
            res.end();
          };
          if (delayMs > 0) setTimeout(respondMatched, delayMs);
          else respondMatched();
          return;
        }

        const continuous = this.continuousScript.shift();
        if (continuous) {
          res.writeHead(200, { "content-type": "text/event-stream" });
          let i = 0;
          const handle = setInterval(() => {
            res.write(`data: ${JSON.stringify(continuous.factory(i))}\n\n`);
            i++;
          }, continuous.intervalMs);
          this.activeIntervals.add(handle);
          res.on("close", () => {
            clearInterval(handle);
            this.activeIntervals.delete(handle);
          });
          // deliberately no [DONE], no res.end() — keeps streaming until the
          // connection is force-closed by stop()
          return;
        }

        const turn = this.script.shift();
        const delay = this.scriptDelays.shift() ?? 0;
        if (!turn) {
          res.writeHead(500, { "content-type": "application/json" });
          res.end(JSON.stringify({ error: { message: "fake-openai: script exhausted" } }));
          return;
        }
        const respond = () => {
          res.writeHead(200, { "content-type": "text/event-stream" });
          for (const ev of turn) res.write(`data: ${JSON.stringify(ev)}\n\n`);
          res.write("data: [DONE]\n\n");
          res.end();
        };
        if (delay > 0) setTimeout(respond, delay);
        else respond();
      });
    });
    this.server.listen(0, "127.0.0.1");
    await once(this.server, "listening");
    this.port = (this.server.address() as { port: number }).port;
  }

  async stop(): Promise<void> {
    if (!this.server) return;
    for (const handle of this.activeIntervals) clearInterval(handle);
    this.activeIntervals.clear();
    // `close()`'s callback only fires once every connection has ended — for
    // a deliberately-stalled (never-closed) connection that would deadlock,
    // so force-close sockets first/concurrently rather than awaiting close()
    // before reaching for closeAllConnections().
    const closed = new Promise<void>((resolve) => this.server!.close(() => resolve()));
    this.server.closeAllConnections?.();
    await closed;
  }
}

/* ---------- SSE event builders (OpenAI streaming wire shapes) ---------- */

export const textDelta = (text: string): SseEvent => ({
  choices: [{ index: 0, delta: { content: text } }],
});

export const reasoningDelta = (text: string): SseEvent => ({
  choices: [{ index: 0, delta: { reasoning_content: text } }],
});

export const toolCallDelta = (id: string, name: string, args: object): SseEvent => ({
  choices: [
    {
      index: 0,
      delta: {
        tool_calls: [
          { index: 0, id, type: "function", function: { name, arguments: JSON.stringify(args) } },
        ],
      },
    },
  ],
});

export const finish = (reason = "stop"): SseEvent => ({
  choices: [{ index: 0, delta: {}, finish_reason: reason }],
});

/** A complete plain-text assistant turn. */
export const textTurn = (text: string): ScriptedTurn => [textDelta(text), finish("stop")];

/** A complete single-tool-call turn. */
export const toolTurn = (id: string, name: string, args: object): ScriptedTurn => [
  toolCallDelta(id, name, args),
  finish("tool_calls"),
];
