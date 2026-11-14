import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { BehaviorClassifier, GEMINI_DECISIONS_URL } from "../lib/classifier.mjs";
import { GeminiClient } from "../lib/gemini.mjs";
import { createApp } from "../server.mjs";

const DEMO_GEMINI = () => new GeminiClient({ apiKey: "" });

function decision(choice, confidence = 0.99) {
  const ids = ["scrolling", "nail_biting", "vaping", "smoking", "porn", "snacking", "unsupported"];
  const probabilities = Object.fromEntries(ids.map((id) => [id, 0]));
  probabilities[choice] = 1;
  return { answers: { behavior: { type: "choice", choice, confidence, probabilities } } };
}

function fakePayments(outcome = { status: "demo", message: "No money was charged." }) {
  const charges = [];
  return {
    charges,
    service: {
      async status() { return { mode: "demo", connected: false, cardLabel: null }; },
      async createSetup() { return { url: "https://checkout.example.test/session" }; },
      async completeSetup() { return { mode: "demo", connected: false, cardLabel: null }; },
      async charge(args) { charges.push(args); return { ...outcome }; },
    },
  };
}

async function startApp({ dataDirectory, classifier = new BehaviorClassifier({ apiKey: "" }), payments, clock } = {}) {
  const app = createApp({ dataDirectory, gemini: DEMO_GEMINI(), classifier, payments, clock });
  await new Promise((resolve, reject) => {
    app.server.once("error", reject);
    app.server.listen(0, "127.0.0.1", resolve);
  });
  return { ...app, baseUrl: `http://127.0.0.1:${app.server.address().port}` };
}

async function stopApp(app) {
  await new Promise((resolve) => app.server.close(resolve));
}

async function request(baseUrl, pathname, { method = "GET", body } = {}) {
  const response = await fetch(`${baseUrl}${pathname}`, {
    method,
    headers: body === undefined ? undefined : { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  return { response, body: text ? JSON.parse(text) : null };
}

async function withApp(run, options = {}) {
  const dataDirectory = options.dataDirectory ?? await mkdtemp(path.join(os.tmpdir(), "end-itt-compact-"));
  const app = await startApp({ ...options, dataDirectory });
  try {
    return await run(app, dataDirectory);
  } finally {
    await stopApp(app);
    if (!options.dataDirectory) await rm(dataDirectory, { recursive: true, force: true });
  }
}

async function createCompactRule(baseUrl, { description = "I want to stop scrolling before bed.", behaviorId = "scrolling", penaltyAmount = 5 } = {}) {
  const result = await request(baseUrl, "/api/rules", { method: "POST", body: { description, behaviorId, penaltyAmount } });
  assert.equal(result.response.status, 201);
  return result.body.rule;
}

function event(ruleId, eventId, phase) {
  return { bandNumber: 58, ruleId, eventId, phase };
}

test("Decision API classifier uses choice schema and maps unsupported to null", async () => {
  let captured;
  const classifier = new BehaviorClassifier({
    apiKey: "test-key-not-to-log",
    fetchImpl: async (url, options) => {
      captured = { url, options };
      return new Response(JSON.stringify(decision("scrolling")), { status: 200 });
    },
  });
  assert.deepEqual(await classifier.classify("I keep scrolling social media in bed."), {
    mode: "gemini", behaviorId: "scrolling", confidence: 0.99,
  });
  assert.equal(captured.url, GEMINI_DECISIONS_URL);
  const body = JSON.parse(captured.options.body);
  assert.equal(body.model, "gemini-decision-1");
  assert.equal(body.questions.behavior.type, "choice");
  assert.deepEqual(Object.keys(body.questions.behavior.criteria).sort(), [
    "nail_biting", "porn", "scrolling", "smoking", "snacking", "unsupported", "vaping",
  ]);
  assert.match(body.questions.behavior.criteria.porn, /pornography/i);
  assert.match(body.questions.behavior.criteria.porn, /adult videos/i);
  assert.equal(captured.options.body.includes("test-key-not-to-log"), false);

  const unsupported = new BehaviorClassifier({
    apiKey: "test-key",
    fetchImpl: async () => new Response(JSON.stringify(decision("unsupported")), { status: 200 }),
  });
  assert.equal((await unsupported.classify("Help me focus better.")).behaviorId, null);

  const lowConfidence = new BehaviorClassifier({
    apiKey: "test-key",
    fetchImpl: async () => new Response(JSON.stringify(decision("smoking", 0.54)), { status: 200 }),
  });
  const lowResult = await lowConfidence.classify("I want to quit smoking.");
  assert.equal(lowResult.behaviorId, null);
  assert.equal(lowResult.confidence, 0.54);
});

test("porn descriptions map only when explicit in demo and Gemini accepts porn", async () => {
  const demo = new BehaviorClassifier({ apiKey: "" });
  assert.deepEqual(await demo.classify("I want to stop watching adult videos."), {
    mode: "demo", behaviorId: "porn", confidence: null,
  });
  assert.deepEqual(await demo.classify("I want to stop eating snacks after dinner."), {
    mode: "demo", behaviorId: "snacking", confidence: null,
  });
  assert.deepEqual(await demo.classify("I want to stop drinking."), {
    mode: "demo", behaviorId: null, confidence: null,
  });
  assert.deepEqual(await demo.classify("I want to masturbate less often."), {
    mode: "demo", behaviorId: null, confidence: null,
  });

  const gemini = new BehaviorClassifier({
    apiKey: "test-key",
    fetchImpl: async () => new Response(JSON.stringify(decision("porn")), { status: 200 }),
  });
  assert.deepEqual(await gemini.classify("I want to stop watching pornography."), {
    mode: "gemini", behaviorId: "porn", confidence: 0.99,
  });
});

test("config/classification are truthful without a key and API failure is not demo", async () => {
  const payments = fakePayments();
  await withApp(async ({ baseUrl }) => {
    const config = await request(baseUrl, "/api/config");
    assert.deepEqual(config.body.behaviors.map(({ id, label }) => [id, label]), [
      ["scrolling", "Doom-scroll"],
      ["nail_biting", "Nail biting"],
      ["vaping", "Vaping"],
      ["smoking", "Smoking"],
      ["porn", "Porn"],
      ["snacking", "Snacks"],
    ]);
    assert.deepEqual(config.body.penaltyAmounts, [1, 5, 10]);
    assert.equal(config.body.graceSeconds, 60);
    assert.equal(config.body.decisionModel, null);
    assert.deepEqual((await request(baseUrl, "/api/classify", { method: "POST", body: { description: "I want to quit vaping." } })).body,
      { mode: "demo", behaviorId: "vaping", confidence: null });
  }, { payments: payments.service });

  const unavailable = new BehaviorClassifier({ apiKey: "test-key", fetchImpl: async () => new Response("{}", { status: 503 }) });
  await withApp(async ({ baseUrl }) => {
    const result = await request(baseUrl, "/api/classify", { method: "POST", body: { description: "Stop smoking." } });
    assert.equal(result.response.status, 502);
    assert.match(result.body.error, /unavailable/i);
  }, { classifier: unavailable, payments: payments.service });
});

test("compact rules validate their catalog and fixed two-stage schema", async () => {
  const payments = fakePayments();
  await withApp(async ({ baseUrl }) => {
    const rule = await createCompactRule(baseUrl, { behaviorId: "nail_biting", penaltyAmount: 10 });
    assert.deepEqual(rule.steps.map(({ kind, afterMinutes, amount }) => [kind, afterMinutes, amount]), [
      ["notification", 0, null], ["commitment", 1, 10],
    ]);
    assert.equal(rule.schemaVersion, 2);
    assert.equal(rule.graceSeconds, 60);
    assert.equal((await request(baseUrl, "/api/rules", {
      method: "POST", body: { description: "Stop something", behaviorId: "coffee", penaltyAmount: 5 },
    })).response.status, 400);
    assert.equal((await request(baseUrl, "/api/rules", {
      method: "POST", body: { description: "Stop snacks", behaviorId: "snacking", penaltyAmount: 7 },
    })).response.status, 400);
  }, { payments: payments.service });
});

test("corrections honor server grace, charge once, and stop/pause/edit terminate an episode", async () => {
  let now = Date.parse("2026-11-14T12:00:00.000Z");
  const payments = fakePayments();
  await withApp(async ({ baseUrl }) => {
    const rule = await createCompactRule(baseUrl);
    const started = await request(baseUrl, "/api/events", { method: "POST", body: event(rule.id, "start", "started") });
    assert.deepEqual(started.body.event.correction, { stage: 1, status: "preview" });
    now += 59_000;
    const early = await request(baseUrl, "/api/events", { method: "POST", body: event(rule.id, "early", "continued") });
    assert.deepEqual(early.body.event.correction, { stage: 1, status: "preview" });
    assert.equal(payments.charges.length, 0);
    now += 1_000;
    const charged = await request(baseUrl, "/api/events", { method: "POST", body: event(rule.id, "charge", "continued") });
    assert.equal(charged.body.event.correction.status, "demo");
    assert.equal(payments.charges.length, 1);
    await request(baseUrl, "/api/events", { method: "POST", body: event(rule.id, "repeat", "continued") });
    assert.equal(payments.charges.length, 1);

    const stopRule = await createCompactRule(baseUrl, { behaviorId: "snacking", penaltyAmount: 1 });
    await request(baseUrl, "/api/events", { method: "POST", body: event(stopRule.id, "stop-start", "started") });
    assert.deepEqual((await request(baseUrl, `/api/rules/${stopRule.id}/stop`, { method: "POST", body: {} })).body, { ok: true });
    now += 61_000;
    const afterStop = await request(baseUrl, "/api/events", { method: "POST", body: event(stopRule.id, "after-stop", "continued") });
    assert.equal(afterStop.body.event.correction, undefined);
    assert.equal(payments.charges.length, 1);

    const editRule = await createCompactRule(baseUrl, { penaltyAmount: 1 });
    await request(baseUrl, "/api/events", { method: "POST", body: event(editRule.id, "edit-start", "started") });
    const edited = await request(baseUrl, `/api/rules/${editRule.id}`, {
      method: "PATCH", body: { description: "Stop scrolling after work", behaviorId: "scrolling", penaltyAmount: 10 },
    });
    assert.equal(edited.body.rule.penaltyAmount, 10);
    now += 61_000;
    await request(baseUrl, "/api/events", { method: "POST", body: event(editRule.id, "old-episode", "continued") });
    assert.equal(payments.charges.length, 1);
    await request(baseUrl, "/api/events", { method: "POST", body: event(editRule.id, "new-start", "started") });
    now += 61_000;
    await request(baseUrl, "/api/events", { method: "POST", body: event(editRule.id, "new-charge", "continued") });
    assert.equal(payments.charges.at(-1).amountDollars, 10);

    await request(baseUrl, `/api/rules/${editRule.id}`, { method: "PATCH", body: { enabled: false } });
    assert.equal((await request(baseUrl, "/api/events", { method: "POST", body: event(editRule.id, "paused", "started") })).response.status, 409);
  }, { payments: payments.service, clock: () => new Date(now) });
});

test("completed episodes survive a restart and legacy rules never charge", async () => {
  let now = Date.parse("2026-11-14T12:00:00.000Z");
  const payments = fakePayments();
  const dataDirectory = await mkdtemp(path.join(os.tmpdir(), "end-itt-restart-"));
  let app = await startApp({ dataDirectory, payments: payments.service, clock: () => new Date(now) });
  try {
    const compact = await createCompactRule(app.baseUrl, { penaltyAmount: 1 });
    await request(app.baseUrl, "/api/events", { method: "POST", body: event(compact.id, "restart-start", "started") });
    now += 60_000;
    await request(app.baseUrl, "/api/events", { method: "POST", body: event(compact.id, "restart-charge", "continued") });
    assert.equal(payments.charges.length, 1);

    await stopApp(app);
    app = await startApp({ dataDirectory, payments: payments.service, clock: () => new Date(now) });
    const replay = await request(app.baseUrl, "/api/events", { method: "POST", body: event(compact.id, "restart-replay", "continued") });
    assert.equal(replay.body.event.correction.status, "demo");
    assert.equal(payments.charges.length, 1);

    const legacy = await request(app.baseUrl, "/api/rules", {
      method: "POST",
      body: {
        title: "Old rule", behavior: "Old behavior", trigger: "Old trigger", responsePlan: "Old plan",
        steps: [{ kind: "notification", afterMinutes: 0, description: "Old reminder", amount: null, contact: null }],
      },
    });
    assert.equal(legacy.response.status, 201);
    await request(app.baseUrl, "/api/events", { method: "POST", body: event(legacy.body.rule.id, "legacy-start", "started") });
    now += 61_000;
    const legacyContinued = await request(app.baseUrl, "/api/events", {
      method: "POST", body: event(legacy.body.rule.id, "legacy-continued", "continued"),
    });
    assert.equal(legacyContinued.body.event.correction, undefined);
    assert.equal(payments.charges.length, 1);
  } finally {
    await stopApp(app);
    await rm(dataDirectory, { recursive: true, force: true });
  }
});
