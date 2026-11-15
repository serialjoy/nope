import assert from "node:assert/strict";
import http from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { GeminiClient } from "../lib/gemini.mjs";
import { planFromGemini } from "../lib/planner.mjs";
import { createApp } from "../server.mjs";

const demoGemini = () => new GeminiClient({ apiKey: "" });

async function startApp(dataDirectory, gemini = demoGemini()) {
  const app = createApp({ dataDirectory, gemini });
  await new Promise((resolve, reject) => {
    app.server.once("error", reject);
    app.server.listen(0, "127.0.0.1", resolve);
  });
  const { port } = app.server.address();
  return { ...app, baseUrl: `http://127.0.0.1:${port}` };
}

async function stopApp(app) {
  await new Promise((resolve) => app.server.close(resolve));
}

async function withApp(run) {
  const dataDirectory = await mkdtemp(path.join(os.tmpdir(), "end-itt-test-"));
  const app = await startApp(dataDirectory);
  try {
    return await run(app, dataDirectory);
  } finally {
    await stopApp(app);
    await rm(dataDirectory, { recursive: true, force: true });
  }
}

async function request(baseUrl, pathname, { method = "GET", body, headers = {} } = {}) {
  const response = await fetch(`${baseUrl}${pathname}`, {
    method,
    headers: body === undefined ? headers : { "content-type": "application/json", ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  return { response, body: text ? JSON.parse(text) : null, text };
}

async function createRule(baseUrl) {
  const planned = await request(baseUrl, "/api/plan", {
    method: "POST",
    body: {
      description: "When I start scrolling at night, help me put my phone down.",
      clarification: "When I get into bed.",
      responsePlan: "If I keep going for 5 minutes, ask me to check in, then after 10 minutes, remind me to call my accountability partner.",
    },
  });
  assert.equal(planned.response.status, 200);
  return request(baseUrl, "/api/rules", { method: "POST", body: planned.body.rule });
}

function connectSse(baseUrl) {
  const received = [];
  let response;
  let buffer = "";
  let markReady;
  const ready = new Promise((resolve) => { markReady = resolve; });
  const requestHandle = http.get(`${baseUrl}/api/events`, (incoming) => {
    response = incoming;
    incoming.setEncoding("utf8");
    incoming.on("data", (chunk) => {
      buffer += chunk;
      let boundary;
      while ((boundary = buffer.indexOf("\n\n")) !== -1) {
        const frame = buffer.slice(0, boundary);
        buffer = buffer.slice(boundary + 2);
        if (frame.startsWith(": connected")) markReady();
        if (frame.startsWith("event: detection")) {
          const dataLine = frame.split("\n").find((line) => line.startsWith("data: "));
          if (dataLine) received.push(JSON.parse(dataLine.slice(6)));
        }
      }
    });
  });
  return {
    received,
    ready,
    close() {
      requestHandle.destroy();
      response?.destroy();
    },
  };
}

async function waitFor(predicate, timeout = 1_000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.fail("Timed out waiting for expected result.");
}

test("demo plan preserves text, understands common timing, and avoids invented commitments", async () => {
  await withApp(async ({ baseUrl }) => {
    const result = await request(baseUrl, "/api/plan", {
      method: "POST",
      body: {
        description: "When I start scrolling at night, help me put my phone down.",
        clarification: "When I get into bed.",
        responsePlan: "If I keep going for 5 minutes, ask me to check in, then after 10 minutes, remind me to call my accountability partner.",
      },
    });
    assert.equal(result.response.status, 200);
    assert.equal(result.body.mode, "demo");
    assert.equal(result.body.rule.behavior, "When I start scrolling at night, help me put my phone down.");
    assert.equal(result.body.rule.responsePlan, "If I keep going for 5 minutes, ask me to check in, then after 10 minutes, remind me to call my accountability partner.");
    assert.deepEqual(result.body.rule.steps.map((step) => [step.kind, step.afterMinutes]), [
      ["notification", 0],
      ["check_in", 5],
      ["contact", 10],
    ]);
    assert.equal(result.body.rule.steps[2].contact, "accountability partner");
    assert.equal(result.body.rule.steps[1].amount, null);
  });
});

test("rules persist, invalid rule schema is refused, and secrets are never served", async () => {
  const dataDirectory = await mkdtemp(path.join(os.tmpdir(), "end-itt-test-"));
  let app = await startApp(dataDirectory, new GeminiClient({ apiKey: "private-test-key" }));
  try {
    const config = await request(app.baseUrl, "/api/config");
    assert.equal(config.body.aiMode, "gemini");
    assert.equal(config.text.includes("private-test-key"), false);

    const bad = await request(app.baseUrl, "/api/rules", {
      method: "POST",
      body: {
        title: "Bad",
        behavior: "A behavior",
        trigger: "A trigger",
        responsePlan: "A plan",
        steps: [{ kind: "check_in", afterMinutes: 0, description: "Wrong first step", amount: null, contact: null }],
      },
    });
    assert.equal(bad.response.status, 400);
    assert.match(bad.body.error, /first response/i);
  } finally {
    await stopApp(app);
  }

  app = await startApp(dataDirectory);
  try {
    const created = await createRule(app.baseUrl);
    assert.equal(created.response.status, 201);
    const createdId = created.body.rule.id;
    await stopApp(app);
    app = await startApp(dataDirectory);
    const rules = await request(app.baseUrl, "/api/rules");
    assert.equal(rules.response.status, 200);
    assert.equal(rules.body.rules[0].id, createdId);
  } finally {
    await stopApp(app);
    await rm(dataDirectory, { recursive: true, force: true });
  }
});

test("wrong-band and paused detector events are rejected", async () => {
  await withApp(async ({ baseUrl }) => {
    const created = await createRule(baseUrl);
    const ruleId = created.body.rule.id;
    const wrongBand = await request(baseUrl, "/api/events", {
      method: "POST",
      body: { bandNumber: 57, ruleId, eventId: "wrong-band", phase: "started" },
    });
    assert.equal(wrongBand.response.status, 400);

    const paused = await request(baseUrl, `/api/rules/${ruleId}`, { method: "PATCH", body: { enabled: false } });
    assert.equal(paused.response.status, 200);
    const pausedEvent = await request(baseUrl, "/api/events", {
      method: "POST",
      body: { bandNumber: 58, ruleId, eventId: "paused", phase: "started" },
    });
    assert.equal(pausedEvent.response.status, 409);
  });
});

test("duplicate detector events are returned but emitted through SSE once", async () => {
  await withApp(async ({ baseUrl }) => {
    const created = await createRule(baseUrl);
    const ruleId = created.body.rule.id;
    const sse = connectSse(baseUrl);
    try {
      await sse.ready;
      const event = { bandNumber: 58, ruleId, eventId: "detector-1", phase: "started", occurredAt: "2026-11-14T12:00:00.000Z" };
      const first = await request(baseUrl, "/api/events", { method: "POST", body: event });
      assert.equal(first.response.status, 200);
      await waitFor(() => sse.received.length === 1);
      const duplicate = await request(baseUrl, "/api/events", { method: "POST", body: event });
      assert.equal(duplicate.response.status, 200);
      await new Promise((resolve) => setTimeout(resolve, 50));
      assert.equal(sse.received.length, 1);
      assert.deepEqual(sse.received[0], { ...event, occurrenceId: null, source: "detector" });
    } finally {
      sse.close();
    }
  });
});

test("Gemini plans keep validated model steps beyond the deterministic demo parser", () => {
  const input = {
    description: "I want to pause scrolling.",
    clarification: "When I notice I am zoning out.",
    responsePlan: "Ask me to take a breath and check in.",
  };
  const rule = planFromGemini({
    title: "Pause the scroll",
    steps: [
      { kind: "notification", afterMinutes: 0, description: "Take a breath.", amount: null, contact: null },
      { kind: "check_in", afterMinutes: 3, description: "Check in with yourself.", amount: null, contact: null },
    ],
  }, input);
  assert.equal(rule.steps[1].afterMinutes, 3);
  assert.equal(rule.steps[1].description, "Check in with yourself.");
  assert.equal(rule.trigger, input.clarification);
  assert.equal(rule.responsePlan, input.responsePlan);
});

test("Gemini uses a stateless structured Interactions request", async () => {
  let captured;
  const client = new GeminiClient({
    apiKey: "test-key-not-to-log",
    fetchImpl: async (url, options) => {
      captured = { url, options };
      return new Response(JSON.stringify({
        output_text: JSON.stringify({ question: "When would a pause help most?", suggestions: ["At night", "During a break"] }),
      }), { status: 200 });
    },
  });
  const output = await client.clarify("Help me stop scrolling.");
  const body = JSON.parse(captured.options.body);
  assert.equal(captured.url, "https://generativelanguage.googleapis.com/v1beta/interactions");
  assert.equal(body.model, "gemini-2.5-flash-lite");
  assert.equal(body.store, false);
  assert.equal(body.response_format.mime_type, "application/json");
  assert.deepEqual(output.suggestions, ["At night", "During a break"]);
  assert.equal(captured.options.body.includes("test-key-not-to-log"), false);
});
