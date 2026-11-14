import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { BAND_NUMBER } from "../config.mjs";
import { createApp } from "../server.mjs";

async function startApp(dataDirectory, options = {}) {
  const app = createApp({ dataDirectory, ...options });
  await new Promise((resolve, reject) => {
    const fail = (error) => {
      app.server.off("listening", ready);
      reject(error);
    };
    const ready = () => {
      app.server.off("error", fail);
      resolve();
    };
    app.server.once("error", fail);
    app.server.once("listening", ready);
    app.server.listen(0, "127.0.0.1");
  });
  const { port } = app.server.address();
  return { ...app, baseUrl: `http://127.0.0.1:${port}` };
}

async function stopApp(app) {
  if (!app?.server.listening) return;
  await new Promise((resolve) => app.server.close(resolve));
}

async function withDataDirectory(run) {
  const dataDirectory = await mkdtemp(path.join(os.tmpdir(), "nope-recordings-test-"));
  try {
    return await run(dataDirectory);
  } finally {
    await rm(dataDirectory, { recursive: true, force: true });
  }
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

async function createRecording(baseUrl, description = "I pace when I am nervous.", behaviorId = null) {
  const result = await request(baseUrl, "/api/recordings", {
    method: "POST",
    body: { description, behaviorId },
  });
  assert.equal(result.response.status, 201);
  return result.body.recording;
}

function clockAt(initial) {
  let now = Date.parse(initial);
  return {
    clock: () => new Date(now),
    advance(milliseconds) {
      now += milliseconds;
    },
  };
}

function recordingUpdate(status, extra = {}) {
  return { bandNumber: BAND_NUMBER, status, ...extra };
}

test("recording requests persist their metadata through the requested, recording, and recorded lifecycle", async () => {
  await withDataDirectory(async (dataDirectory) => {
    const time = clockAt("2026-11-14T12:00:00.000Z");
    let app = await startApp(dataDirectory, { clock: time.clock });
    try {
      const created = await createRecording(app.baseUrl, "  I pace when I am nervous.  ");
      assert.match(created.id, /^recording_/);
      assert.deepEqual({
        description: created.description,
        behaviorId: created.behaviorId,
        bandNumber: created.bandNumber,
        durationSeconds: created.durationSeconds,
        status: created.status,
        recordingRef: created.recordingRef,
        sampleCount: created.sampleCount,
      }, {
        description: "I pace when I am nervous.",
        behaviorId: null,
        bandNumber: BAND_NUMBER,
        durationSeconds: 10,
        status: "requested",
        recordingRef: null,
        sampleCount: null,
      });
      assert.equal(created.createdAt, "2026-11-14T12:00:00.000Z");
      assert.equal(created.updatedAt, created.createdAt);

      const listed = await request(app.baseUrl, "/api/recordings");
      assert.equal(listed.response.status, 200);
      assert.deepEqual(listed.body.recordings, [created]);

      time.advance(1_000);
      const recording = await request(app.baseUrl, `/api/recordings/${created.id}`, {
        method: "PATCH",
        body: recordingUpdate("recording"),
      });
      assert.equal(recording.response.status, 200);
      assert.equal(recording.body.recording.status, "recording");
      assert.equal(recording.body.recording.createdAt, created.createdAt);
      assert.equal(recording.body.recording.updatedAt, "2026-11-14T12:00:01.000Z");

      time.advance(1_000);
      const completed = await request(app.baseUrl, `/api/recordings/${created.id}`, {
        method: "PATCH",
        body: recordingUpdate("recorded", { recordingRef: "detector-capture-7", sampleCount: 24 }),
      });
      assert.equal(completed.response.status, 200);
      assert.deepEqual(completed.body.recording, {
        ...recording.body.recording,
        status: "recorded",
        updatedAt: "2026-11-14T12:00:02.000Z",
        recordingRef: "detector-capture-7",
        sampleCount: 24,
      });

      await stopApp(app);
      app = await startApp(dataDirectory, { clock: time.clock });
      const reloaded = await request(app.baseUrl, `/api/recordings/${created.id}`);
      assert.equal(reloaded.response.status, 200);
      assert.deepEqual(reloaded.body.recording, completed.body.recording);
    } finally {
      await stopApp(app);
    }
  });
});

test("recording APIs reject malformed data, unsupported habits, missing requests, and every wrong-band update", async () => {
  await withDataDirectory(async (dataDirectory) => {
    const app = await startApp(dataDirectory);
    try {
      const blank = await request(app.baseUrl, "/api/recordings", {
        method: "POST",
        body: { description: "   " },
      });
      assert.equal(blank.response.status, 400);

      const unsupported = await request(app.baseUrl, "/api/recordings", {
        method: "POST",
        body: { description: "Something new", behaviorId: "other" },
      });
      assert.equal(unsupported.response.status, 400);

      const rawStatus = await request(app.baseUrl, "/api/recordings", {
        method: "POST",
        body: { description: "Something new", status: "recorded" },
      });
      assert.equal(rawStatus.response.status, 400);

      const absent = await request(app.baseUrl, "/api/recordings/no-such-request");
      assert.equal(absent.response.status, 404);
      const absentPatch = await request(app.baseUrl, "/api/recordings/no-such-request", {
        method: "PATCH",
        body: recordingUpdate("cancelled"),
      });
      assert.equal(absentPatch.response.status, 404);

      const created = await createRecording(app.baseUrl);
      const wrongBand = await request(app.baseUrl, `/api/recordings/${created.id}`, {
        method: "PATCH",
        body: { bandNumber: BAND_NUMBER - 1, status: "cancelled" },
      });
      assert.equal(wrongBand.response.status, 400);

      const forbiddenMetadata = await request(app.baseUrl, `/api/recordings/${created.id}`, {
        method: "PATCH",
        body: recordingUpdate("recording", { recordingRef: null }),
      });
      assert.equal(forbiddenMetadata.response.status, 400);

      const unapprovedField = await request(app.baseUrl, `/api/recordings/${created.id}`, {
        method: "PATCH",
        body: recordingUpdate("recording", { ruleId: "must-not-be-created" }),
      });
      assert.equal(unapprovedField.response.status, 400);
    } finally {
      await stopApp(app);
    }
  });
});

test("cancel races serialize, cancellation is idempotent, and terminal requests cannot reopen", async () => {
  await withDataDirectory(async (dataDirectory) => {
    const app = await startApp(dataDirectory);
    try {
      const created = await createRecording(app.baseUrl);
      const [start, cancel] = await Promise.all([
        request(app.baseUrl, `/api/recordings/${created.id}`, {
          method: "PATCH",
          body: recordingUpdate("recording"),
        }),
        request(app.baseUrl, `/api/recordings/${created.id}`, {
          method: "PATCH",
          body: recordingUpdate("cancelled"),
        }),
      ]);
      assert.ok([200, 409].includes(start.response.status));
      assert.ok([200, 409].includes(cancel.response.status));
      assert.ok(start.response.status === 200 || cancel.response.status === 200);

      const current = await request(app.baseUrl, `/api/recordings/${created.id}`);
      assert.equal(current.body.recording.status, "cancelled");

      const firstRepeat = await request(app.baseUrl, `/api/recordings/${created.id}`, {
        method: "PATCH",
        body: recordingUpdate("cancelled"),
      });
      const secondRepeat = await request(app.baseUrl, `/api/recordings/${created.id}`, {
        method: "PATCH",
        body: recordingUpdate("cancelled"),
      });
      assert.equal(firstRepeat.response.status, 200);
      assert.equal(secondRepeat.response.status, 200);
      assert.deepEqual(firstRepeat.body.recording, current.body.recording);
      assert.deepEqual(secondRepeat.body.recording, current.body.recording);

      const reopened = await request(app.baseUrl, `/api/recordings/${created.id}`, {
        method: "PATCH",
        body: recordingUpdate("recording"),
      });
      assert.equal(reopened.response.status, 409);
    } finally {
      await stopApp(app);
    }
  });
});

test("recorded acknowledgments require matching completion metadata and are idempotent only when it matches", async () => {
  await withDataDirectory(async (dataDirectory) => {
    const time = clockAt("2026-11-14T12:00:00.000Z");
    const app = await startApp(dataDirectory, { clock: time.clock });
    try {
      const created = await createRecording(app.baseUrl);
      const premature = await request(app.baseUrl, `/api/recordings/${created.id}`, {
        method: "PATCH",
        body: recordingUpdate("recorded", { recordingRef: "capture-1", sampleCount: 1 }),
      });
      assert.equal(premature.response.status, 409);

      const recording = await request(app.baseUrl, `/api/recordings/${created.id}`, {
        method: "PATCH",
        body: recordingUpdate("recording"),
      });
      assert.equal(recording.response.status, 200);

      for (const body of [
        recordingUpdate("recorded", { sampleCount: 10 }),
        recordingUpdate("recorded", { recordingRef: "capture-1", sampleCount: 0 }),
        recordingUpdate("recorded", { recordingRef: "capture-1", sampleCount: 1.5 }),
        recordingUpdate("recorded", { recordingRef: "capture-1", sampleCount: 1, extra: true }),
      ]) {
        const invalid = await request(app.baseUrl, `/api/recordings/${created.id}`, { method: "PATCH", body });
        assert.equal(invalid.response.status, 400);
      }

      time.advance(1_000);
      const acknowledged = await request(app.baseUrl, `/api/recordings/${created.id}`, {
        method: "PATCH",
        body: recordingUpdate("recorded", { recordingRef: "capture-1", sampleCount: 10 }),
      });
      assert.equal(acknowledged.response.status, 200);
      const acknowledgedAt = acknowledged.body.recording.updatedAt;

      time.advance(1_000);
      const retry = await request(app.baseUrl, `/api/recordings/${created.id}`, {
        method: "PATCH",
        body: recordingUpdate("recorded", { recordingRef: "capture-1", sampleCount: 10 }),
      });
      assert.equal(retry.response.status, 200);
      assert.deepEqual(retry.body.recording, acknowledged.body.recording);
      assert.equal(retry.body.recording.updatedAt, acknowledgedAt);

      const changedMetadata = await request(app.baseUrl, `/api/recordings/${created.id}`, {
        method: "PATCH",
        body: recordingUpdate("recorded", { recordingRef: "capture-2", sampleCount: 10 }),
      });
      assert.equal(changedMetadata.response.status, 409);

      const cancelledCompleted = await request(app.baseUrl, `/api/recordings/${created.id}`, {
        method: "PATCH",
        body: recordingUpdate("cancelled"),
      });
      assert.equal(cancelledCompleted.response.status, 409);
    } finally {
      await stopApp(app);
    }
  });
});

test("recording requests do not create rules or trigger payments", async () => {
  await withDataDirectory(async (dataDirectory) => {
    const calls = [];
    const payments = {
      status: async () => ({ mode: "demo", connected: false, cardLabel: null }),
      createSetup: async () => { calls.push("setup"); return {}; },
      completeSetup: async () => { calls.push("complete"); return {}; },
      charge: async () => { calls.push("charge"); return {}; },
    };
    const app = await startApp(dataDirectory, { payments });
    try {
      const created = await createRecording(app.baseUrl, "A new behavior", null);
      const rules = await request(app.baseUrl, "/api/rules");
      assert.equal(rules.response.status, 200);
      assert.deepEqual(rules.body.rules, []);
      assert.equal(created.ruleId, undefined);
      assert.deepEqual(calls, []);
    } finally {
      await stopApp(app);
    }
  });
});

test("the saved-request cap returns a clear conflict without deleting existing requests", async () => {
  await withDataDirectory(async (dataDirectory) => {
    const app = await startApp(dataDirectory);
    try {
      for (let index = 0; index < 100; index += 1) {
        const created = await request(app.baseUrl, "/api/recordings", {
          method: "POST",
          body: { description: `New behavior ${index}` },
        });
        assert.equal(created.response.status, 201);
      }
      const overflow = await request(app.baseUrl, "/api/recordings", {
        method: "POST",
        body: { description: "One too many" },
      });
      assert.equal(overflow.response.status, 409);
      assert.match(overflow.body.error, /100 saved recording requests/i);

      const listed = await request(app.baseUrl, "/api/recordings");
      assert.equal(listed.body.recordings.length, 100);
      assert.equal(listed.body.recordings[0].description, "New behavior 0");
    } finally {
      await stopApp(app);
    }
  });
});
