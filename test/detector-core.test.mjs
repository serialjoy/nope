import assert from "node:assert/strict";
import test from "node:test";
import { AudioRing, Detector, NopeReporter, SAMPLE_RATE } from "../public/detector/core.mjs";

const loud = () => Float32Array.from({ length: SAMPLE_RATE }, (_, i) => Math.sin(i / 10) * 0.5);
const quiet = () => new Float32Array(SAMPLE_RATE);

function setup({ scores, now = { t: 1_000_000 }, options } = {}) {
  const events = [];
  const detector = new Detector({
    classify: async () => scores,
    onEvent: (e) => events.push(e),
    now: () => now.t,
    options,
  });
  const fill = (kind = loud) => { for (let i = 0; i < 4; i++) detector.feedAudio(kind()); };
  const shake = () => { for (let i = 0; i < 100; i++) { now.t += 20; detector.feedMotion(i % 2 ? 300 : 20, 0, 0); } };
  return { detector, events, fill, shake, now };
}

test("AudioRing keeps the newest samples and reports when full", () => {
  const ring = new AudioRing(6);
  ring.push(Float32Array.of(1, 2, 3));
  assert.equal(ring.full, false);
  ring.push(Float32Array.of(4, 5, 6, 7));
  assert.equal(ring.full, true);
  assert.deepEqual([...ring.snapshot()], [2, 3, 4, 5, 6, 7]);
  ring.push(Float32Array.of(9, 9, 9, 9, 9, 9, 9, 1));
  assert.deepEqual([...ring.snapshot()], [9, 9, 9, 9, 9, 1]);
});

test("fires once on a confident target with wrist motion, then respects the cooldown", async () => {
  const s = setup({ scores: { lighter: 0.8, can_opening: 0.1, rain: 0.1 } });
  s.fill(); s.shake();
  const first = await s.detector.step();
  assert.equal(first.kind, "lighter");
  assert.equal(first.motion_active, true);
  assert.equal(await s.detector.step(), null, "cooldown");
  s.now.t += 16_000; s.shake();
  assert.equal((await s.detector.step()).id, 2, "fires again after the cooldown");
});

test("motion gate: no wrist motion, no event", async () => {
  const s = setup({ scores: { lighter: 0.9, can_opening: 0.0 } });
  s.fill();
  assert.equal(await s.detector.step(), null);
  assert.equal(s.detector.status.motionActive, false);
  s.detector.options.requireMotion = false;
  assert.equal((await s.detector.step()).kind, "lighter");
});

test("needs the target to be the top label and above the threshold", async () => {
  let s = setup({ scores: { lighter: 0.45, can_opening: 0.1, rain: 0.45 } });
  s.fill(); s.shake();
  assert.equal(await s.detector.step(), null, "below threshold");
  s = setup({ scores: { lighter: 0.55, can_opening: 0.0, rain: 0.9 } });
  s.fill(); s.shake();
  assert.equal(await s.detector.step(), null, "another sound is more likely");
});

test("silence skips the classifier; a half-empty buffer does nothing", async () => {
  let calls = 0;
  const detector = new Detector({ classify: async () => { calls += 1; return { lighter: 1 }; } });
  detector.feedAudio(loud());
  assert.equal(await detector.step(), null);
  for (let i = 0; i < 3; i++) detector.feedAudio(quiet());
  detector.feedAudio(quiet());
  assert.equal(await detector.step(), null);
  assert.equal(calls, 0);
});

function fakeNope(rules) {
  const sent = [];
  const fetchImpl = async (url, init = {}) => {
    if (url === "/api/rules") return { ok: true, json: async () => ({ rules }) };
    if (url === "/api/events") {
      const body = JSON.parse(init.body);
      sent.push(body);
      return { ok: true, json: async () => ({ ok: true, event: { phase: body.phase, correction: { stage: 1, status: "preview" } } }) };
    }
    return { ok: false, status: 404, json: async () => ({}) };
  };
  return { sent, fetchImpl };
}

test("NopeReporter starts each distinct detection, reuses retry identity, and stops the latest occurrence", async () => {
  const nope = fakeNope([
    { id: "old", behaviorId: "smoking", enabled: false, createdAt: "2026-01-01" },
    { id: "r1", behaviorId: "smoking", enabled: true, createdAt: "2026-02-01" },
  ]);
  const timers = [];
  const reporter = new NopeReporter({
    fetchImpl: nope.fetchImpl, bandNumber: 58,
    setTimer: (fn) => { timers.push(fn); return timers.length - 1; }, clearTimer: () => {},
  });
  assert.equal(await reporter.report({ kind: "can_opening" }), null, "no Nope habit for a can");
  assert.equal(await reporter.report({ kind: "lighter", test: true }), null);
  const first = { id: 1, kind: "lighter", time: "2026-11-14T12:00:00.000Z" };
  assert.equal(await reporter.report(first), "started");
  assert.equal(await reporter.report(first), "started", "a delivery retry keeps its occurrence identity");
  assert.equal(await reporter.report({ id: 2, kind: "lighter", time: "2026-11-14T12:00:16.000Z" }), "started");
  await timers.at(-1)();
  assert.deepEqual(nope.sent.map((e) => [e.phase, e.ruleId, e.bandNumber]), [
    ["started", "r1", 58], ["started", "r1", 58], ["started", "r1", 58], ["stopped", "r1", 58],
  ]);
  assert.equal(nope.sent[0].occurrenceId, nope.sent[1].occurrenceId, "retry uses the original occurrence");
  assert.equal(nope.sent[0].eventId, nope.sent[1].eventId, "retry uses the original event ID too");
  assert.notEqual(nope.sent[1].occurrenceId, nope.sent[2].occurrenceId, "a distinct detector event gets a new occurrence");
  assert.equal(nope.sent[3].occurrenceId, nope.sent[2].occurrenceId, "idle stop closes the latest occurrence");
  assert.equal(await reporter.report({ id: 3, kind: "lighter" }), "started", "a new occurrence starts after idle");
});

test("NopeReporter refreshes a changed rule and keeps prior idle cleanup when a delivery fails", async () => {
  const rules = [{ id: "r1", behaviorId: "smoking", enabled: true, createdAt: "2026-01-01" }];
  const sent = [];
  const attempts = [];
  const timers = [];
  const cleared = [];
  let failStarted = false;
  const reporter = new NopeReporter({
    fetchImpl: async (url, init = {}) => {
      if (url === "/api/rules") return { ok: true, json: async () => ({ rules }) };
      const body = JSON.parse(init.body);
      attempts.push(body);
      if (failStarted && body.phase === "started") return { ok: false, status: 409, json: async () => ({}) };
      sent.push(body);
      return { ok: true, json: async () => ({ ok: true, event: { correction: { stage: 1, status: "preview" } } }) };
    },
    setTimer: (fn) => { timers.push(fn); return timers.length - 1; },
    clearTimer: (id) => cleared.push(id),
  });

  await reporter.report({ id: 1, kind: "lighter", time: "2026-11-14T12:00:00.000Z" });
  rules.splice(0, 1, { id: "r2", behaviorId: "smoking", enabled: true, createdAt: "2026-11-15" });
  await reporter.report({ id: 2, kind: "lighter", time: "2026-11-14T12:00:16.000Z" });
  assert.deepEqual(sent.slice(0, 2).map((event) => event.ruleId), ["r1", "r2"], "the replacement rule is used immediately");
  assert.deepEqual(cleared, [0], "the prior timer clears only after replacement succeeds");

  failStarted = true;
  await assert.rejects(
    reporter.report({ id: 3, kind: "lighter", time: "2026-11-14T12:00:32.000Z" }),
    /HTTP 409/,
  );
  assert.equal(attempts.at(-1).ruleId, "r2");
  assert.deepEqual(cleared, [0], "a failed POST leaves the current idle timer intact");
  await timers[1]();
  const stopped = sent.at(-1);
  assert.equal(stopped.phase, "stopped");
  assert.equal(stopped.ruleId, "r2");
  assert.equal(stopped.occurrenceId, sent[1].occurrenceId, "the surviving timer closes the last successful occurrence");
});

test("NopeReporter clears a cached idle episode when its rule is paused", async () => {
  const rules = [{ id: "r1", behaviorId: "smoking", enabled: true, createdAt: "2026-01-01" }];
  const nope = fakeNope(rules);
  const messages = [];
  const timers = [];
  const cleared = [];
  const reporter = new NopeReporter({
    fetchImpl: nope.fetchImpl,
    log: (m) => messages.push(m),
    setTimer: (fn) => { timers.push(fn); return timers.length - 1; },
    clearTimer: (id) => cleared.push(id),
  });
  await reporter.report({ id: 1, kind: "lighter", time: "2026-11-14T12:00:00.000Z" });
  rules[0].enabled = false;
  assert.equal(await reporter.report({ id: 2, kind: "lighter", time: "2026-11-14T12:00:16.000Z" }), null);
  assert.deepEqual(cleared, [0]);
  await timers[0]();
  assert.equal(nope.sent.length, 1, "a cancelled stale timer must not send stopped against a paused rule");
  assert.match(messages.at(-1), /no enabled "smoking" rule/);
});
