import assert from "node:assert/strict";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import * as http from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { normalizeContext } from "@earendil-works/pi-ai";
import {
  closeClaudeProcesses,
  discoverClaudeModels,
  getClaudeStatus,
  runClaudeRequest,
  type RunClaudeInput,
} from "../src/claude-cli.ts";
import type { NativeContentBlock, NativeFrame } from "../src/native-types.ts";
import { createClaudeCodeProvider } from "../src/provider.ts";
import { streamClaudeCode } from "../src/stream.ts";

const fakeClaude = String.raw`#!/usr/bin/env node
import { appendFileSync, readFileSync } from "node:fs";
import readline from "node:readline";
if (process.argv.includes("auth")) throw new Error("Gateway clients must not inspect a local login");
if (process.env.PROCESS_LOG) appendFileSync(process.env.PROCESS_LOG, process.pid + "\n");
const emit = (event) => console.log(JSON.stringify(event));
const history = [];
for await (const line of readline.createInterface({ input: process.stdin, crlfDelay: Infinity })) {
  const frame = JSON.parse(line);
  if (frame.type === "control_request") {
    if (process.env.ANTHROPIC_BASE_URL !== process.env.EXPECTED_GATEWAY) throw new Error("Wrong discovery endpoint");
    emit({ type: "control_response", response: { subtype: "success", request_id: frame.request_id,
      response: { models: [{ value: "sonnet", resolvedModel: "claude-sonnet-5", displayName: "Sonnet", description: "Gateway model" }] } } });
    continue;
  }
  history.push(frame.message);
  if (frame.shouldQuery === false) {
    emit({ type: "result", num_turns: 0 });
    continue;
  }
  if (frame.type !== "user") continue;
  if (process.env.FAKE_NATIVE_ERROR === "1") {
    emit({ type: "result", subtype: "error_during_execution", is_error: true });
    continue;
  }
  const base = process.env.FAKE_BYPASS_RELAY === "1" ? process.env.EXPECTED_GATEWAY : process.env.ANTHROPIC_BASE_URL;
  if (process.env.FAKE_BYPASS_RELAY !== "1" && !new URL(base).pathname.startsWith("/turn/")) {
    throw new Error("Claude was not pointed at its turn relay");
  }
  const headers = { "content-type": "application/json" };
  if (process.env.ANTHROPIC_AUTH_TOKEN) headers.authorization = "Bearer " + process.env.ANTHROPIC_AUTH_TOKEN;
  if (process.env.ANTHROPIC_API_KEY) headers["x-api-key"] = process.env.ANTHROPIC_API_KEY;
  const settingsIndex = process.argv.indexOf("--settings");
  const settings = JSON.parse(readFileSync(process.argv[settingsIndex + 1], "utf8"));
  const body = JSON.stringify({ model: "claude-sonnet-5", messages: history, stream: true,
    ...JSON.parse(settings.env.CLAUDE_CODE_EXTRA_BODY) });
  const response = await fetch(base + "/v1/messages", { method: "POST", headers, body });
  const text = await response.text();
  if (!response.ok) {
    emit({ type: "result", subtype: "error_during_execution", is_error: true });
    continue;
  }
  let stop;
  for (const line of text.split("\n")) {
    if (!line.startsWith("data:")) continue;
    const event = JSON.parse(line.slice(5));
    if (event.type === "message_delta") stop = event.delta.stop_reason;
    emit({ type: "stream_event", event });
  }
  if (process.env.FAKE_RETRY === "1") {
    const retry = await fetch(base + "/v1/messages", { method: "POST", headers, body });
    if (retry.status !== 400) throw new Error("Native retry escaped the turn relay");
    await retry.text();
  }
  const usage = { input_tokens: 3, output_tokens: 2 };
  emit({ type: "assistant", message: { role: "assistant", content: [{ type: "text", text: "native projection" }], stop_reason: stop, usage } });
  emit({ type: "result", subtype: stop === "tool_use" ? "error_max_turns" : "success", is_error: stop === "tool_use", usage });
}
`;

interface GatewayRequest {
  url: string;
  headers: http.IncomingHttpHeaders;
  body: { messages: NativeFrame["message"][] };
}

function sendResponse(response: http.ServerResponse, content: NativeContentBlock[]): void {
  const usage = { input_tokens: 3, output_tokens: 2 };
  const events: unknown[] = [
    { type: "message_start", message: { id: "gateway", role: "assistant", content: [], usage } },
  ];
  content.forEach((block, index) => {
    if (block.type === "thinking") {
      events.push(
        { type: "content_block_start", index, content_block: { type: "thinking", thinking: "", signature: "" } },
        { type: "content_block_delta", index, delta: { type: "thinking_delta", thinking: block.thinking } },
        { type: "content_block_delta", index, delta: { type: "signature_delta", signature: block.signature } },
      );
    } else if (block.type === "tool_use") {
      events.push(
        { type: "content_block_start", index, content_block: { ...block, input: {} } },
        {
          type: "content_block_delta",
          index,
          delta: { type: "input_json_delta", partial_json: JSON.stringify(block.input) },
        },
      );
    } else {
      events.push({ type: "content_block_start", index, content_block: block });
    }
    events.push({ type: "content_block_stop", index });
  });
  events.push(
    {
      type: "message_delta",
      delta: { stop_reason: content.some((block) => block.type === "tool_use") ? "tool_use" : "end_turn" },
      usage,
    },
    { type: "message_stop" },
  );
  response.writeHead(200, { "content-type": "text/event-stream" });
  response.end(events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(""));
}

async function fixture(t: TestContext) {
  const root = await mkdtemp(join(tmpdir(), "pi-claude-code-gateway-"));
  const executable = join(root, "fake-claude.mjs");
  const processLog = join(root, "processes.log");
  const toolPath = join(root, "input.txt");
  await writeFile(executable, fakeClaude, "utf8");
  await chmod(executable, 0o755);
  await writeFile(toolPath, "content read by Pi", "utf8");
  const requests: GatewayRequest[] = [];
  let onWait!: () => void;
  let onClose!: () => void;
  const waiting = new Promise<void>((resolve) => (onWait = resolve));
  const closed = new Promise<void>((resolve) => (onClose = resolve));
  const server = http.createServer(async (request, response) => {
    let raw = "";
    for await (const chunk of request) raw += chunk;
    const body = JSON.parse(raw) as GatewayRequest["body"];
    requests.push({ url: request.url!, headers: request.headers, body });
    const last = body.messages.at(-1)?.content as Array<{ text?: string; type?: string }>;
    if (last.some((block) => block.text === "wait")) {
      response.once("close", onClose);
      onWait();
      return;
    }
    if (request.headers.authorization === "Bearer denied") {
      response.writeHead(401, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: { message: "Gateway credential rejected" } }));
      return;
    }
    sendResponse(
      response,
      last.some((block) => block.text === "call-tool")
        ? [
            { type: "thinking", thinking: "Read the file", signature: "signed-thinking" },
            { type: "tool_use", id: "tool_read", name: "mcp__pi__read", input: { path: toolPath } },
          ]
        : [{ type: "text", text: "gateway reply" }],
    );
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const base = `http://127.0.0.1:${address.port}/gateway`;
  const env: Record<string, string | undefined> = {
    PI_CLAUDE_CODE_COMMAND: executable,
    PI_CLAUDE_CODE_USE_GATEWAY: "1",
    ANTHROPIC_BASE_URL: base,
    ANTHROPIC_AUTH_TOKEN: "local-proxy-key",
    ANTHROPIC_API_KEY: undefined,
    CLAUDE_CODE_OAUTH_TOKEN: undefined,
    EXPECTED_GATEWAY: base,
    PROCESS_LOG: processLog,
  };
  t.after(async () => {
    await closeClaudeProcesses();
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(root, { recursive: true, force: true });
  });
  const input: RunClaudeInput = {
    model: "sonnet",
    cwd: root,
    env,
    timeoutMs: 5_000,
    frames: [{ type: "user", message: { role: "user", content: [{ type: "text", text: "hello" }] } }],
    systemPrompt: "system",
    manifest: [],
    extraBody: { tools: [] },
    toolNames: new Set(),
  };
  return { root, env, input, base, requests, waiting, closed, processLog };
}

test("gateway status and provider-scoped configuration do not require a local Claude login", async (t) => {
  const f = await fixture(t);
  const status = await getClaudeStatus(f.env);
  assert.equal(status.available, true);
  assert.equal(status.loggedIn, false);
  assert.equal(status.subscription, false);
  assert.equal(status.authMethod, "gateway");
  assert.match(status.detail!, /configured/i);
  assert.equal(f.requests.length, 0);

  const provider = createClaudeCodeProvider();
  const authInput = {
    ctx: { env: async (name: string) => f.env[name], fileExists: async () => false },
    signal: new AbortController().signal,
  };
  assert.deepEqual(await provider.auth.apiKey!.check!(authInput), { type: "api_key", source: "Claude Code gateway" });
  const resolved = await provider.auth.apiKey!.resolve(authInput);
  assert.ok(resolved);
  assert.equal(resolved.env?.ANTHROPIC_BASE_URL, f.base);
  assert.equal(resolved.env?.ANTHROPIC_AUTH_TOKEN, "local-proxy-key");
  const models = await discoverClaudeModels(f.env, undefined, 5_000);
  assert.equal(models[0]?.value, "sonnet");
  assert.equal(f.requests.length, 0);
  const message = await streamClaudeCode(
    provider.getModels()[0]!,
    normalizeContext({
      messages: [
        { role: "system", content: "system", timestamp: 0 },
        { role: "user", content: "hello", timestamp: 1 },
      ],
    }),
    { env: resolved.env, timeoutMs: 5_000 },
  ).result();
  assert.equal(message.stopReason, "stop");
  assert.deepEqual(message.content, [{ type: "text", text: "gateway reply" }]);
  assert.equal(f.requests[0]?.url, "/gateway/v1/messages");
});

test("gateway relay preserves signed thinking, tool calls and Pi's tool-result continuation", async (t) => {
  const f = await fixture(t);
  const manifest = [
    {
      name: "read",
      description: "Read a file",
      inputSchema: { type: "object", properties: { path: { type: "string" } } },
    },
  ];
  const input = { ...f.input, manifest, toolNames: new Set(["read"]), env: { ...f.env, FAKE_RETRY: "1" } };
  const first = await runClaudeRequest({
    ...input,
    frames: [{ type: "user", message: { role: "user", content: [{ type: "text", text: "call-tool" }] } }],
  });
  assert.deepEqual(first.message.content[0], { type: "thinking", thinking: "Read the file", signature: "signed-thinking" });
  const tool = first.message.content[1];
  assert.ok(tool?.type === "tool_use");
  const result = await readFile(String(tool.input.path), "utf8");
  const second = await runClaudeRequest({
    ...input,
    frames: [
      { type: "user", message: { role: "user", content: [{ type: "text", text: "call-tool" }] }, shouldQuery: false },
      { type: "assistant", message: { role: "assistant", content: first.message.content } },
      {
        type: "user",
        message: { role: "user", content: [{ type: "tool_result", tool_use_id: tool.id, content: result }] },
      },
    ],
  });
  assert.deepEqual(second.message.content, [{ type: "text", text: "gateway reply" }]);
  assert.equal(first.relay.blockedRequests, 1);
  assert.equal(second.relay.blockedRequests, 1);
  assert.equal(f.requests.length, 2);
  assert.equal(f.requests[0]?.headers.authorization, "Bearer local-proxy-key");
  assert.deepEqual(f.requests[1]?.body.messages.at(-1)?.content, [
    { type: "tool_result", tool_use_id: "tool_read", content: "content read by Pi" },
  ]);
});

test("gateway changes replace warm workers and API-key auth reaches only the configured gateway", async (t) => {
  const f = await fixture(t);
  const first = await runClaudeRequest({ ...f.input, sessionId: "gateway-session" });
  const frames: NativeFrame[] = [
    { ...f.input.frames[0]!, shouldQuery: false },
    { type: "assistant", message: { role: "assistant", content: first.message.content } },
    { type: "user", message: { role: "user", content: [{ type: "text", text: "again" }] } },
  ];
  const env = { ...f.env, ANTHROPIC_AUTH_TOKEN: undefined, ANTHROPIC_API_KEY: "rotated-local-key" };
  const second = await runClaudeRequest({ ...f.input, sessionId: "gateway-session", frames, env });
  assert.equal((await readFile(f.processLog, "utf8")).trim().split("\n").length, 2);
  assert.equal(f.requests[1]?.url, "/gateway/v1/messages");
  assert.equal(f.requests[1]?.headers.authorization, undefined);
  assert.equal(f.requests[1]?.headers["x-api-key"], "rotated-local-key");
  await runClaudeRequest({
    ...f.input,
    sessionId: "gateway-session",
    env: { ...env, ANTHROPIC_BASE_URL: `${f.base}/other` },
    frames: [
      ...frames.map((frame): NativeFrame => frame.type === "user" ? { ...frame, shouldQuery: false } : frame),
      { type: "assistant", message: { role: "assistant", content: second.message.content } },
      { type: "user", message: { role: "user", content: [{ type: "text", text: "new gateway" }] } },
    ],
  });
  assert.equal((await readFile(f.processLog, "utf8")).trim().split("\n").length, 3);
  assert.equal(f.requests[2]?.url, "/gateway/other/v1/messages");
});

test("gateway mode rejects invalid configuration before Claude is launched", async (t) => {
  const f = await fixture(t);
  const invalid: Array<Record<string, string | undefined>> = [
    { PI_CLAUDE_CODE_USE_GATEWAY: undefined },
    { ANTHROPIC_BASE_URL: undefined },
    { ANTHROPIC_AUTH_TOKEN: undefined },
    { ANTHROPIC_API_KEY: "second-key" },
    { ANTHROPIC_API_KEY: " " },
    { ANTHROPIC_AUTH_TOKEN: " " },
    { CLAUDE_CODE_USE_BEDROCK: "1" },
    { CLAUDE_CODE_USE_VERTEX: "true" },
    { CLAUDE_CODE_USE_FOUNDRY: "1" },
    { CLAUDE_CODE_OAUTH_TOKEN: "must-not-reach-gateway" },
    { ANTHROPIC_BASE_URL: "http://example.com" },
    { ANTHROPIC_BASE_URL: "https://user:secret@example.com" },
    { ANTHROPIC_BASE_URL: "https://example.com?token=secret" },
  ];
  for (const override of invalid) {
    await assert.rejects(runClaudeRequest({ ...f.input, env: { ...f.env, ...override } }));
  }
  await assert.rejects(runClaudeRequest({ ...f.input, upstreamUrl: "https://different.example" }));
  assert.equal(f.requests.length, 0);
  await assert.rejects(readFile(f.processLog), { code: "ENOENT" });
});

test("a launcher cannot silently bypass the gateway turn relay", async (t) => {
  const f = await fixture(t);
  await assert.rejects(
    runClaudeRequest({ ...f.input, env: { ...f.env, FAKE_BYPASS_RELAY: "1" } }),
    /turn relay|ANTHROPIC_BASE_URL/,
  );
  assert.equal(f.requests.length, 1);
});

test("gateway rejection and cancellation surface without a second upstream request", { timeout: 10_000 }, async (t) => {
  const f = await fixture(t);
  await assert.rejects(
    runClaudeRequest({ ...f.input, env: { ...f.env, FAKE_NATIVE_ERROR: "1" } }),
    /failed before reaching the turn relay: error_during_execution/,
  );
  assert.equal(f.requests.length, 0);
  await assert.rejects(
    runClaudeRequest({ ...f.input, env: { ...f.env, ANTHROPIC_AUTH_TOKEN: "denied" } }),
    /401|Gateway credential rejected/,
  );
  assert.equal(f.requests.length, 1);
  const controller = new AbortController();
  const request = runClaudeRequest({
    ...f.input,
    signal: controller.signal,
    frames: [{ type: "user", message: { role: "user", content: [{ type: "text", text: "wait" }] } }],
  });
  const rejected = assert.rejects(request, /abort/i);
  await f.waiting;
  controller.abort();
  await rejected;
  await f.closed;
  assert.equal(f.requests.length, 2);
});
