/**
 * Unit tests for AzureResponsesAdapter's `toWire` neutral→Responses-API
 * translation (Azure Responses API migration — hosted "lakshx" provider).
 * Pure message-shape tests, no network: `toWire` is exported for exactly
 * this, same convention as provider-image-wire.test.ts's Anthropic/OpenAI
 * coverage.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { toWire } from "../src/providers/azure-responses.js";
import type { ChatMessage } from "../src/providers/types.js";
import { IMAGE_UNSUPPORTED_PLACEHOLDER } from "../src/vision.js";

const PNG_B64 = Buffer.from("fake-png-bytes").toString("base64");

test("toWire: plain user text becomes a role:user message item with an input_text part", () => {
  const messages: ChatMessage[] = [{ role: "user", content: [{ type: "text", text: "hello" }] }];
  const wire = toWire(messages, true);
  assert.deepEqual(wire, [{ type: "message", role: "user", content: [{ type: "input_text", text: "hello" }] }]);
});

test("toWire: assistant text + tool_use becomes a message item followed by a function_call item", () => {
  const messages: ChatMessage[] = [
    {
      role: "assistant",
      content: [
        { type: "text", text: "reading the file" },
        { type: "tool_use", id: "call_1", name: "read_file", input: { path: "a.ts" } },
      ],
    },
  ];
  const wire = toWire(messages, true);
  assert.deepEqual(wire, [
    { type: "message", role: "assistant", content: [{ type: "output_text", text: "reading the file" }] },
    { type: "function_call", call_id: "call_1", name: "read_file", arguments: '{"path":"a.ts"}' },
  ]);
});

test("toWire: assistant message with only a tool_use (no text) emits just the function_call item", () => {
  const messages: ChatMessage[] = [
    { role: "assistant", content: [{ type: "tool_use", id: "call_2", name: "bash", input: { command: "ls" } }] },
  ];
  const wire = toWire(messages, true);
  assert.deepEqual(wire, [{ type: "function_call", call_id: "call_2", name: "bash", arguments: '{"command":"ls"}' }]);
});

test("toWire: multiple tool_use blocks in one assistant turn each become their own function_call item, in order", () => {
  const messages: ChatMessage[] = [
    {
      role: "assistant",
      content: [
        { type: "tool_use", id: "call_a", name: "read_file", input: { path: "a.ts" } },
        { type: "tool_use", id: "call_b", name: "read_file", input: { path: "b.ts" } },
      ],
    },
  ];
  const wire = toWire(messages, true);
  assert.deepEqual(wire, [
    { type: "function_call", call_id: "call_a", name: "read_file", arguments: '{"path":"a.ts"}' },
    { type: "function_call", call_id: "call_b", name: "read_file", arguments: '{"path":"b.ts"}' },
  ]);
});

test("toWire: plain string tool_result becomes a function_call_output item keyed by call_id", () => {
  const messages: ChatMessage[] = [
    { role: "user", content: [{ type: "tool_result", tool_use_id: "call_1", content: "file contents", is_error: false }] },
  ];
  const wire = toWire(messages, true);
  assert.deepEqual(wire, [{ type: "function_call_output", call_id: "call_1", output: "file contents" }]);
});

test("toWire: is_error tool_result gets the [tool failed] prefix, same convention as openai-compat", () => {
  const messages: ChatMessage[] = [
    { role: "user", content: [{ type: "tool_result", tool_use_id: "call_1", content: "boom", is_error: true }] },
  ];
  const wire = toWire(messages, true);
  assert.deepEqual(wire[0], { type: "function_call_output", call_id: "call_1", output: "[tool failed] boom" });
});

test("toWire: tool_result followed by user text emits function_call_output then a message item, in order", () => {
  const messages: ChatMessage[] = [
    {
      role: "user",
      content: [
        { type: "tool_result", tool_use_id: "call_1", content: "ok", is_error: false },
        { type: "text", text: "now what?" },
      ],
    },
  ];
  const wire = toWire(messages, true);
  assert.deepEqual(wire, [
    { type: "function_call_output", call_id: "call_1", output: "ok" },
    { type: "message", role: "user", content: [{ type: "input_text", text: "now what?" }] },
  ]);
});

test("toWire: a rich (image) tool_result defers the image to a follow-up user message with an input_image part", () => {
  const messages: ChatMessage[] = [
    {
      role: "user",
      content: [
        {
          type: "tool_result",
          tool_use_id: "call_1",
          content: [
            { type: "text", text: "Screenshot saved." },
            { type: "image", mimeType: "image/png", base64: PNG_B64, path: "/ws/.lakshx/tmp/act-1.png" },
          ],
        },
      ],
    },
  ];
  const wire = toWire(messages, true);
  assert.equal(wire.length, 2);

  const output = wire[0] as any;
  assert.equal(output.type, "function_call_output");
  assert.equal(output.call_id, "call_1");
  assert.match(output.output, /Screenshot saved\./);
  assert.match(output.output, /attached in the next input item/);

  const imageMsg = wire[1] as any;
  assert.equal(imageMsg.type, "message");
  assert.equal(imageMsg.role, "user");
  const imagePart = imageMsg.content.find((p: any) => p.type === "input_image");
  assert.ok(imagePart, "expected an input_image part");
  assert.equal(imagePart.image_url, `data:image/png;base64,${PNG_B64}`);
});

test("toWire: image degrades to the honest placeholder (and no follow-up message) when not vision-capable", () => {
  const messages: ChatMessage[] = [
    {
      role: "user",
      content: [
        {
          type: "tool_result",
          tool_use_id: "call_1",
          content: [
            { type: "text", text: "Screenshot saved." },
            { type: "image", mimeType: "image/png", base64: PNG_B64 },
          ],
        },
      ],
    },
  ];
  const wire = toWire(messages, false);
  assert.equal(wire.length, 1, "no follow-up image message may be emitted");
  assert.ok((wire[0] as any).output.includes(IMAGE_UNSUPPORTED_PLACEHOLDER));
  assert.ok(!JSON.stringify(wire).includes(PNG_B64), "no image bytes may reach a non-vision wire");
});

test("toWire: system prompt is NOT an input item at all (handled via top-level `instructions` in runTurn)", () => {
  // toWire only ever sees `messages` — `req.system` is passed separately as
  // `instructions` by runTurn (see azure-responses.ts). This test just
  // documents/pins that contract: an empty/user-only history never smuggles
  // system-prompt-shaped content into the input array.
  const wire = toWire([{ role: "user", content: [{ type: "text", text: "hi" }] }], true);
  assert.ok(wire.every((item: any) => item.role !== "system" && item.role !== "developer"));
});
