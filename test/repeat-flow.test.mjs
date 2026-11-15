import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { GeminiClient } from "../lib/gemini.mjs";
import { createApp } from "../server.mjs";

const DEMO_GEMINI = () => new GeminiClient({ apiKey: "" });

function fakePayments(outcomes = []) {
  const charges = [];
  const queuedOutcomes = [...outcomes];
  return {
    charges,
    service: {
      async status() { return { mode: "demo", connected: false, cardLabel: null }; },
      async createSetup() { return { url: "https://checkout.example.test/session" }; },
      async completeSetup() { return { mode: "demo", connected: false, cardLabel: null }; },
      async charge(args) {
        charges.push(args);
        return queuedOutcomes.shift() ?? { status: "demo" };
      },
    },
  };
}

function controllableClock(initial = "2026-11-14T12:00:00.000Z") {
  let now = Date.parse(initial);
  return {
    clock: () => new Date(now),
    advance(milliseconds) { now += milliseconds; },
  };
}

async function startApp({ dataDirectory, payments, clock }) {
  const app = createApp({ dataDirectory, gemini: DEMO_GEMINI(), payments, clock });
  await new Promise((resolve, reject) => {
    app.server.once("error", reject);
    app.server.listen(0, "127.0.0.1", resolve);
  });
  return { ...app, baseUrl: `http://127.0.0.1:${app.server.address().port}` };
}

async function stopApp(app) {
  if (!app?.server.listening) return;
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

async function withDataDirectory(run) {
  const dataDirectory = await mkdtemp(path.join(os.tmpdir(), "nope-repeat-flow-"));
  try {
    return await run(dataDirectory);
  } finally {
    await rm(dataDirectory, { recursive: true, force: true });
  }
}

async function createRule(baseUrl, penaltyAmount = 5) {
  const created = await request(baseUrl, "/api/rules", {
    method: "POST",
    body: {
      description: "I want to stop doom-scrolling before bed.",
      behaviorId: "scrolling",
      penaltyAmount,
    },
  });
  assert.equal(created.response.status, 201);
  return created.body.rule;
}

function detectorEvent(ruleId, eventId, phase = "started", occurrenceId) {
  return {
    bandNumber: 58,
    ruleId,
    eventId,
    phase,
    ...(occurrenceId ? { occurrenceId } : {}),
  };
}

async function sendEvent(baseUrl, value) {
  const result = await request(baseUrl, "/api/events", { method: "POST", body: value });
  assert.equal(result.response.status, 200);
  return result.body.event.correction;
}

function assertStageOne(correction) {
  assert.ok(correction, "a first occurrence returns a correction");
  assert.equal(correction.stage, 1);
  assert.equal(correction.status, "preview");
  assert.equal(correction.warningArmed, true);
  assert.equal(typeof correction.episodeId, "string");
  assert.ok(correction.episodeId.length > 0);
  return correction.episodeId;
}

function assertStageTwo(correction, { status, amountDollars = 5, warningArmed }) {
  assert.ok(correction, "a charge-eligible occurrence returns a correction");
  assert.equal(correction.stage, 2);
  assert.equal(correction.status, status);
  assert.equal(correction.amountDollars, amountDollars);
  assert.equal(correction.warningArmed, warningArmed);
  assert.equal(typeof correction.episodeId, "string");
  assert.ok(correction.episodeId.length > 0);
  return correction.episodeId;
}

async function assertWarning(baseUrl, ruleId, expected) {
  const current = await request(baseUrl, "/api/rules");
  assert.equal(current.response.status, 200);
  const rule = current.body.rules.find((candidate) => candidate.id === ruleId);
  assert.ok(rule, "the created rule remains visible through the rules list");
  assert.equal(rule.warningArmed, expected);
}

async function stopOccurrence(baseUrl, ruleId, episodeId, reason, warningArmed) {
  const stopped = await request(baseUrl, `/api/rules/${ruleId}/stop`, {
    method: "POST",
    body: { episodeId, reason },
  });
  assert.equal(stopped.response.status, 200);
  assert.deepEqual(stopped.body, { ok: true, episodeId, warningArmed });
}

test("a stopped warning persists across restart, then one distinct occurrence charges and resets", async () => {
  await withDataDirectory(async (dataDirectory) => {
    const payments = fakePayments();
    const time = controllableClock();
    let app = await startApp({ dataDirectory, payments: payments.service, clock: time.clock });
    try {
      const rule = await createRule(app.baseUrl);
      const warningEpisodeId = assertStageOne(await sendEvent(app.baseUrl,
        detectorEvent(rule.id, "first-start", "started", "first-occurrence")));
      await assertWarning(app.baseUrl, rule.id, true);
      await stopOccurrence(app.baseUrl, rule.id, warningEpisodeId, "stopped", true);

      await stopApp(app);
      app = await startApp({ dataDirectory, payments: payments.service, clock: time.clock });

      assertStageTwo(await sendEvent(app.baseUrl,
        detectorEvent(rule.id, "second-start", "started", "second-occurrence")), {
        status: "demo", warningArmed: false,
      });
      assert.equal(payments.charges.length, 1);
      await assertWarning(app.baseUrl, rule.id, false);

      assertStageOne(await sendEvent(app.baseUrl,
        detectorEvent(rule.id, "third-start", "started", "third-occurrence")));
      assert.equal(payments.charges.length, 1);
    } finally {
      await stopApp(app);
    }
  });
});

test("a false alarm clears only its original warning and stale stops cannot clear a newer warning", async () => {
  await withDataDirectory(async (dataDirectory) => {
    const payments = fakePayments();
    const app = await startApp({ dataDirectory, payments: payments.service, clock: controllableClock().clock });
    try {
      const rule = await createRule(app.baseUrl);
      const oldEpisodeId = assertStageOne(await sendEvent(app.baseUrl,
        detectorEvent(rule.id, "mistake", "started", "mistake-occurrence")));
      await stopOccurrence(app.baseUrl, rule.id, oldEpisodeId, "false_alarm", false);

      const currentEpisodeId = assertStageOne(await sendEvent(app.baseUrl,
        detectorEvent(rule.id, "real-start", "started", "real-occurrence")));
      assert.notEqual(currentEpisodeId, oldEpisodeId);
      await assertWarning(app.baseUrl, rule.id, true);

      for (const reason of ["stopped", "false_alarm"]) {
        const stale = await request(app.baseUrl, `/api/rules/${rule.id}/stop`, {
          method: "POST",
          body: { episodeId: oldEpisodeId, reason },
        });
        assert.equal(stale.response.status, 409);
      }
      await assertWarning(app.baseUrl, rule.id, true);
      assert.equal(payments.charges.length, 0);
    } finally {
      await stopApp(app);
    }
  });
});

test("continued packets, duplicate event IDs, and occurrence replays cannot multiply-charge", async () => {
  await withDataDirectory(async (dataDirectory) => {
    const payments = fakePayments();
    const time = controllableClock();
    const app = await startApp({ dataDirectory, payments: payments.service, clock: time.clock });
    try {
      const rule = await createRule(app.baseUrl);
      const firstEpisodeId = assertStageOne(await sendEvent(app.baseUrl,
        detectorEvent(rule.id, "no-id-first", "started")));

      assertStageOne(await sendEvent(app.baseUrl, detectorEvent(rule.id, "no-id-repeat", "started")));
      time.advance(86_400_000);
      assertStageOne(await sendEvent(app.baseUrl, detectorEvent(rule.id, "continued-late", "continued")));
      assertStageOne(await sendEvent(app.baseUrl, detectorEvent(rule.id, "continued-late", "continued")));
      assert.equal(payments.charges.length, 0);

      await stopOccurrence(app.baseUrl, rule.id, firstEpisodeId, "stopped", true);
      const charged = assertStageTwo(await sendEvent(app.baseUrl,
        detectorEvent(rule.id, "charge-once", "started", "charge-occurrence")), {
        status: "demo", warningArmed: false,
      });
      assert.equal(payments.charges.length, 1);

      const replay = assertStageTwo(await sendEvent(app.baseUrl,
        detectorEvent(rule.id, "charge-replay-new-event", "started", "charge-occurrence")), {
        status: "demo", warningArmed: false,
      });
      assert.equal(replay, charged);
      assert.equal(payments.charges.length, 1);
    } finally {
      await stopApp(app);
    }
  });
});

test("a known failed payment keeps the warning armed and a later distinct occurrence can reset it", async () => {
  await withDataDirectory(async (dataDirectory) => {
    const payments = fakePayments([{ status: "failed" }, { status: "demo" }]);
    const app = await startApp({ dataDirectory, payments: payments.service, clock: controllableClock().clock });
    try {
      const rule = await createRule(app.baseUrl);
      const warningEpisodeId = assertStageOne(await sendEvent(app.baseUrl,
        detectorEvent(rule.id, "warning", "started", "warning-occurrence")));
      await stopOccurrence(app.baseUrl, rule.id, warningEpisodeId, "stopped", true);

      assertStageTwo(await sendEvent(app.baseUrl,
        detectorEvent(rule.id, "failed-charge", "started", "failed-occurrence")), {
        status: "failed", warningArmed: true,
      });
      assert.equal(payments.charges.length, 1);
      await assertWarning(app.baseUrl, rule.id, true);

      assertStageTwo(await sendEvent(app.baseUrl,
        detectorEvent(rule.id, "successful-retry", "started", "retry-occurrence")), {
        status: "demo", warningArmed: false,
      });
      assert.equal(payments.charges.length, 2);
      await assertWarning(app.baseUrl, rule.id, false);
    } finally {
      await stopApp(app);
    }
  });
});
