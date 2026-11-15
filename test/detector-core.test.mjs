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
  const s = setup({ scores: { lighter: 0.1, can_opening: 0.8, rain: 0.1 } });
  s.fill(); s.shake();
  const first = await s.detector.step();
  assert.equal(first.kind, "can_opening");
  assert.equal(first.motion_active, true);
  assert.equal(await s.detector.step(), null, "cooldown");
  s.now.t += 6_000; s.shake(); s.detector.feedAudio(loud());
  assert.equal((await s.detector.step()).id, 2, "fires again after the cooldown");
});

test("motion gate: no wrist motion, no event", async () => {
  const s = setup({ scores: { lighter: 0.0, can_opening: 0.9 } });
  s.fill();
  assert.equal(await s.detector.step(), null);
  assert.equal(s.detector.status.motionActive, false);
  s.detector.options.requireMotion = false;
  s.detector.feedAudio(loud());
  assert.equal((await s.detector.step()).kind, "can_opening");
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

test("diagnostics shows live wrist motion even while quiet audio skips the classifier", async () => {
  const now = { t: 1_000_000 };
  const detector = new Detector({ classify: async () => { throw new Error("quiet input must not classify"); }, now: () => now.t });
  for (let i = 0; i < 4; i++) detector.feedAudio(quiet());
  for (let i = 0; i < 100; i++) {
    now.t += 20;
    detector.feedMotion(i % 2 ? 300 : 20, 4, -2);
  }
  assert.equal(await detector.step(), null);
  const first = detector.diagnostics();
  assert.equal(first.decision.reason, "quiet");
  assert.equal(first.audio.silent, true);
  assert.equal(first.audio.bufferedSeconds, 4);
  assert.equal(first.motion.active, true);
  assert.equal(first.motion.sampleCount, 100);
  assert.ok(first.motion.std > first.motion.threshold);
  assert.deepEqual(first.motion.latest, { t: now.t, gx: 300, gy: 4, gz: -2 });
  assert.equal(first.motion.ageMs, 0);
  assert.equal(first.motion.history.length, 100);
  first.motion.history[0].gx = -1;
  assert.notEqual(detector.diagnostics().motion.history[0].gx, -1, "diagnostics returns fresh copies");
});

test("diagnostics counts down the five-second cooldown and resets it for a repeated hit", async () => {
  const s = setup({ scores: { lighter: 0.1, can_opening: 0.9 } });
  s.fill(); s.shake();
  assert.equal((await s.detector.step()).id, 1);
  assert.equal(s.detector.diagnostics().cooldowns.can_opening, 5_000);
  assert.equal(s.detector.diagnostics().decision.cooldownRemainingMs, 5_000);

  s.now.t += 2_000;
  s.detector.feedAudio(loud());
  assert.equal(await s.detector.step(), null);
  let diagnostics = s.detector.diagnostics();
  assert.equal(diagnostics.decision.reason, "cooldown");
  assert.equal(diagnostics.cooldowns.can_opening, 3_000);
  assert.equal(diagnostics.decision.cooldownRemainingMs, 3_000);

  s.now.t += 3_000;
  for (let i = 0; i < 100; i++) s.detector.feedMotion(i % 2 ? 300 : 20, 0, 0);
  s.detector.feedAudio(loud());
  assert.equal((await s.detector.step()).id, 2);
  diagnostics = s.detector.diagnostics();
  assert.equal(diagnostics.decision.reason, "detected");
  assert.equal(diagnostics.cooldowns.can_opening, 5_000);
});

test("resetInput clears monitor inputs without resetting accepted-event cooldowns or IDs", async () => {
  const s = setup({ scores: { lighter: 0.1, can_opening: 0.9 } });
  s.fill(); s.shake();
  assert.equal((await s.detector.step()).id, 1);
  const cooldown = s.detector.diagnostics().cooldowns.can_opening;
  s.detector.resetInput();
  const diagnostics = s.detector.diagnostics();
  assert.equal(diagnostics.audio.bufferedSeconds, 0);
  assert.equal(diagnostics.motion.sampleCount, 0);
  assert.equal(diagnostics.motion.latest, null);
  assert.deepEqual(diagnostics.motion.history, []);
  assert.equal(diagnostics.decision.reason, "warming_up");
  assert.equal(diagnostics.cooldowns.can_opening, cooldown, "reset does not permit an immediate duplicate hit");
  assert.equal(s.detector.events.length, 1);
  assert.equal(await s.detector.step(), null);
});

test("motion history is capped to ten seconds and one thousand raw samples", () => {
  const now = { t: 0 };
  const detector = new Detector({ classify: async () => ({}), now: () => now.t });
  for (let i = 0; i < 1_005; i++) {
    now.t += 1;
    detector.feedMotion(i, i + 1, i + 2);
  }
  let diagnostics = detector.diagnostics();
  assert.equal(diagnostics.motion.history.length, 1_000);
  assert.equal(diagnostics.motion.latest.t, now.t);

  now.t += 10_001;
  detector.feedMotion(1, 2, 3);
  diagnostics = detector.diagnostics();
  assert.deepEqual(diagnostics.motion.history, [{ t: now.t, gx: 1, gy: 2, gz: 3 }]);
});

test("empty classifier output records a classifier error and cannot create a hit", async () => {
  const s = setup({ scores: {} });
  s.fill(); s.shake();
  assert.equal(await s.detector.step(), null);
  const diagnostics = s.detector.diagnostics();
  assert.equal(diagnostics.decision.reason, "classifier_error");
  assert.equal(diagnostics.decision.target, null);
  assert.equal(s.events.length, 0);
});

test("lighter needs fresh two-check confirmation, a clear, and never blocks can-opening", async () => {
  const now = { t: 1_000_000 };
  let scores = { lighter: 0.74, can_opening: 0.1 };
  let calls = 0;
  const detector = new Detector({
    classify: async () => { calls += 1; return scores; },
    now: () => now.t,
  });
  const move = () => { for (let i = 0; i < 100; i++) detector.feedMotion(i % 2 ? 300 : 20, 0, 0); };
  const freshLoud = () => detector.feedAudio(loud());
  const freshQuiet = () => { for (let i = 0; i < 4; i++) detector.feedAudio(quiet()); };
  for (let i = 0; i < 4; i++) freshLoud();

  move();
  assert.equal(await detector.step(), null, "a marginal lighter score is rejected");
  assert.equal(detector.diagnostics().decision.reason, "low_confidence");

  scores = { lighter: 0.9, can_opening: 0.1 };
  now.t += 500; move(); freshLoud();
  assert.equal(await detector.step(), null);
  assert.equal(detector.diagnostics().decision.reason, "confirming");
  assert.equal(detector.diagnostics().gates.lighter.confirmationCount, 1);
  const afterFirstConfirmCalls = calls;
  now.t += 500; move();
  assert.equal(await detector.step(), null, "unchanged audio cannot confirm");
  assert.equal(detector.diagnostics().decision.reason, "waiting_for_audio");
  assert.equal(calls, afterFirstConfirmCalls);

  now.t += 500; move(); freshLoud();
  assert.equal((await detector.step()).kind, "lighter");
  assert.equal(detector.diagnostics().gates.lighter.armed, false);
  now.t += 6_000; move(); freshLoud();
  assert.equal(await detector.step(), null, "cooldown cannot rearm sustained lighter audio");
  assert.equal(detector.diagnostics().decision.reason, "awaiting_clear");

  scores = { lighter: 0.1, can_opening: 0.9 };
  now.t += 500; move(); freshLoud();
  assert.equal((await detector.step()).kind, "can_opening", "a disarmed lighter must not suppress can-opening");
  assert.equal(detector.diagnostics().gates.lighter.clearCount, 1);
  now.t += 500; freshQuiet();
  assert.equal(await detector.step(), null);
  assert.equal(detector.diagnostics().gates.lighter.armed, true, "two fresh clear windows rearm lighter");

  scores = { lighter: 0.9, can_opening: 0.1 };
  now.t += 500; move(); freshLoud();
  assert.equal(await detector.step(), null);
  now.t += 500; move(); freshLoud();
  assert.equal((await detector.step()).kind, "lighter", "a new two-check signal can fire after clear and cooldown");
});

test("invalid fresh classifier output breaks a lighter confirmation streak", async () => {
  const now = { t: 1_000_000 };
  let scores = { lighter: 0.9, can_opening: 0.1 };
  const detector = new Detector({ classify: async () => scores, now: () => now.t });
  const move = () => { for (let i = 0; i < 100; i++) detector.feedMotion(i % 2 ? 300 : 20, 0, 0); };
  const fresh = () => detector.feedAudio(loud());
  for (let i = 0; i < 4; i++) fresh();
  move();
  assert.equal(await detector.step(), null);
  assert.equal(detector.diagnostics().gates.lighter.confirmationCount, 1);
  scores = {};
  now.t += 500; move(); fresh();
  assert.equal(await detector.step(), null);
  assert.equal(detector.diagnostics().decision.reason, "classifier_error");
  assert.equal(detector.diagnostics().gates.lighter.confirmationCount, 0);
  scores = { lighter: 0.9, can_opening: 0.1 };
  now.t += 500; move(); fresh();
  assert.equal(await detector.step(), null, "an error cannot bridge two confirmations");
  assert.equal(detector.diagnostics().decision.reason, "confirming");
});

test("resetInput ignores a classifier result that belongs to removed input", async () => {
  const now = { t: 1_000_000 };
  let resolveScores;
  const detector = new Detector({
    classify: async () => new Promise((resolve) => { resolveScores = resolve; }),
    now: () => now.t,
  });
  for (let i = 0; i < 4; i++) detector.feedAudio(loud());
  for (let i = 0; i < 100; i++) detector.feedMotion(i % 2 ? 300 : 20, 0, 0);
  const pending = detector.step();
  detector.resetInput();
  resolveScores({ lighter: 0.9, can_opening: 0.1 });
  assert.equal(await pending, null);
  assert.equal(detector.events.length, 0);
  assert.equal(detector.diagnostics().decision.reason, "warming_up");
  assert.equal(detector.diagnostics().gates.lighter.armed, true);
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
