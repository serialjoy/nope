import assert from 'node:assert/strict';
import test from 'node:test';
import http from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createApp } from '../server.mjs';
import { GeminiClient } from '../lib/gemini.mjs';

test('warning responses emit correlated reset signals without changing warning or charge semantics', async () => {
  const dataDirectory = await mkdtemp(path.join(os.tmpdir(), 'nope-reset-'));
  const app = createApp({ dataDirectory, gemini: new GeminiClient({ apiKey: '' }), payments: { charge: async () => ({ status: 'demo' }) } });
  await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${app.server.address().port}`;
  const signals = [];
  let request;
  const connected = new Promise((resolve, reject) => {
    request = http.get(`${base}/api/events`, response => {
      let buffer = '';
      response.setEncoding('utf8');
      response.on('data', chunk => {
        buffer += chunk;
        let boundary;
        while ((boundary = buffer.indexOf('\n\n')) >= 0) {
          const frame = buffer.slice(0, boundary); buffer = buffer.slice(boundary + 2);
          if (frame.startsWith(': connected')) resolve();
          if (frame.startsWith('event: detector-reset\n')) signals.push(JSON.parse(frame.split('\ndata: ')[1]));
        }
      });
    }).on('error', reject);
  });
  const post = async (url, body) => {
    const res = await fetch(base + url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    return { status: res.status, data: await res.json() };
  };
  const waitFor = async count => {
    for (let n = 0; signals.length < count && n < 100; n++) await new Promise(resolve => setTimeout(resolve, 5));
    assert.equal(signals.length, count);
  };
  try {
    await connected;
    const created = await post('/api/rules', { description: 'Stop smoking', behaviorId: 'smoking', penaltyAmount: 5 });
    assert.equal(created.status, 201);
    const ruleId = created.data.rule.id;
    let counter = 0;
    const hit = () => { counter++; return post('/api/events', { bandNumber: 58, ruleId, eventId: `reset-hit-${counter}`, occurrenceId: `reset-occurrence-${counter}`, phase: 'started' }); };
    const first = await hit();
    const episodeId = first.data.event.correction.episodeId;
    const endpoint = `/api/rules/${ruleId}/stop`;
    const stopped = await post(endpoint, { episodeId, reason: 'stopped' });
    assert.deepEqual(stopped.data, { ok: true, episodeId, warningArmed: true });
    await waitFor(1);
    assert.deepEqual(signals[0], { resetId: `${episodeId}:stopped`, bandNumber: 58, ruleId, episodeId, occurrenceId: 'reset-occurrence-1', delayMs: 3000 });
    await post(endpoint, { episodeId, reason: 'stopped' });
    await waitFor(2);
    assert.equal(signals[1].resetId, signals[0].resetId, 'retry identity allows browser deduplication');
    const dismissed = await post(endpoint, { episodeId, reason: 'false_alarm' });
    assert.equal(dismissed.data.warningArmed, false);
    await waitFor(3);
    assert.equal(signals[2].resetId, `${episodeId}:false_alarm`);
    assert.equal((await post(endpoint, { episodeId: 'unknown-episode', reason: 'stopped' })).status, 409);
    assert.equal((await post(endpoint, { reason: 'invalid' })).status, 400);
    await hit();
    const second = await hit();
    assert.equal(second.data.event.correction.stage, 2);
    assert.equal((await post(endpoint, { episodeId: second.data.event.correction.episodeId, reason: 'stopped' })).status, 200);
    await new Promise(resolve => setTimeout(resolve, 30));
    assert.equal(signals.length, 3, 'stage two and rejected requests never clear the detector');
  } finally {
    request.destroy();
    app.server.closeAllConnections();
    await new Promise(resolve => app.server.close(resolve));
    await rm(dataDirectory, { recursive: true, force: true });
  }
});
