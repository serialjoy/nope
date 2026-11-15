// Detector logic with no browser or model code in it, so it runs the same in a page and in tests.
//
// audio (16 kHz) + wrist motion -> sound classifier -> motion gate -> detection events
// -> Nope episodes (started / continued / stopped).
//
// Port of the Python detector the team evaluated (sound-lab/server/detector.py + nope_bridge.py).

export const SAMPLE_RATE = 16000;
export const WINDOW_S = 4;                       // the classifier hears the last 4 s
export const TARGETS = ["can_opening", "lighter"];

export const DEFAULTS = Object.freeze({
  threshold: { can_opening: 0.5, lighter: 0.5 }, // classifier probability needed to fire
  cooldownS: 15,                                 // same sound can fire at most this often
  motionLookbackS: 4,                            // the wrist must have moved within this time
  motionGyroStd: 25,                             // deg/s: below this the wrist counts as still
  silenceLevel: 0.01,                            // peak below this: skip the model
  requireMotion: true,
});

/** Rolling buffer of the newest `size` audio samples. */
export class AudioRing {
  constructor(size) {
    this.size = size;
    this.data = new Float32Array(size);
    this.filled = 0;
  }
  push(samples) {
    const n = samples.length;
    if (n >= this.size) {
      this.data.set(samples.subarray(n - this.size));
      this.filled = this.size;
      return;
    }
    this.data.copyWithin(0, n);
    this.data.set(samples, this.size - n);
    this.filled = Math.min(this.size, this.filled + n);
  }
  get full() {
    return this.filled >= this.size;
  }
  snapshot() {
    return this.data.slice();
  }
}

export class Detector {
  /**
   * @param {object} o
   * @param {(audio: Float32Array) => Promise<Record<string, number>>} o.classify  16 kHz audio -> {label: probability}
   * @param {(event: object) => void} [o.onEvent]
   * @param {() => number} [o.now]  milliseconds, injectable for tests
   */
  constructor({ classify, onEvent = () => {}, now = () => Date.now(), options = {} }) {
    this.classify = classify;
    this.onEvent = onEvent;
    this.now = now;
    this.options = { ...DEFAULTS, ...options, threshold: { ...DEFAULTS.threshold, ...options.threshold } };
    this.ring = new AudioRing(SAMPLE_RATE * WINDOW_S);
    this.motion = [];                            // {t, v}: gyro magnitude
    this.lastFire = new Map();
    this.events = [];
    this.status = { windows: 0, scores: {}, motionActive: false, silent: true };
  }

  feedAudio(samples) {
    this.ring.push(samples);
  }

  feedMotion(gx, gy, gz) {
    const t = this.now();
    this.motion.push({ t, v: Math.hypot(gx, gy, gz) });
    const keep = t - this.options.motionLookbackS * 1000;
    while (this.motion.length && this.motion[0].t < keep) this.motion.shift();
  }

  motionActive() {
    const t = this.now() - this.options.motionLookbackS * 1000;
    const v = this.motion.filter((m) => m.t >= t).map((m) => m.v);
    if (v.length < 20) return false;
    const mean = v.reduce((a, b) => a + b, 0) / v.length;
    const std = Math.sqrt(v.reduce((a, b) => a + (b - mean) ** 2, 0) / v.length);
    return std > this.options.motionGyroStd;
  }

  /** Look at the last window once. Returns the detection event, or null. Call about once a second. */
  async step() {
    if (!this.ring.full) return null;
    const audio = this.ring.snapshot();
    let peak = 0;
    for (const s of audio) peak = Math.max(peak, Math.abs(s));
    const moving = this.motionActive();
    if (peak < this.options.silenceLevel) {       // silence: skip the model
      this.status = { ...this.status, scores: {}, motionActive: moving, silent: true };
      return null;
    }
    const scores = await this.classify(audio);
    this.status = { windows: this.status.windows + 1, scores, motionActive: moving, silent: false };

    const kind = TARGETS.reduce((best, k) => ((scores[k] ?? 0) > (scores[best] ?? 0) ? k : best));
    const top = Object.keys(scores).reduce((best, k) => (scores[k] > scores[best] ? k : best));
    if (top !== kind || scores[kind] < this.options.threshold[kind]) return null;
    if (this.options.requireMotion && !moving) return null;
    const t = this.now();
    if (t - (this.lastFire.get(kind) ?? -Infinity) < this.options.cooldownS * 1000) return null;
    this.lastFire.set(kind, t);

    const event = {
      id: this.events.length + 1,
      kind,
      confidence: Math.round(scores[kind] * 1000) / 1000,
      motion_active: moving,
      time: new Date(t).toISOString(),
    };
    this.events.push(event);
    this.onEvent(event);
    return event;
  }
}

/**
 * Turns detections into Nope's started / continued / stopped episodes.
 *
 * Nope owns the clock and the consequences: after `started` it sends the in-app nudge, and a `continued`
 * more than 60 s later triggers the (test-mode) penalty. So only say `continued` when the behaviour was
 * detected again. A lighter strike is our evidence of smoking; there is no Nope habit for a can opening.
 */
export class NopeReporter {
  constructor({
    baseUrl = "",
    bandNumber = 58,
    map = { lighter: "smoking" },
    episodeIdleS = 120,
    fetchImpl = (...a) => fetch(...a),
    setTimer = (fn, ms) => setTimeout(fn, ms),
    clearTimer = (id) => clearTimeout(id),
    log = () => {},
  } = {}) {
    Object.assign(this, { baseUrl, bandNumber, map, episodeIdleS, fetchImpl, setTimer, clearTimer, log });
    this.episodes = new Map();                   // behaviorId -> { rule, timer }
    this.counter = 0;
  }

  async #json(path, body) {
    const response = await this.fetchImpl(this.baseUrl + path, body === undefined ? {} : {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!response.ok) throw new Error(`${path} -> HTTP ${response.status}`);
    return response.json();
  }

  async #ruleFor(behaviorId) {
    const { rules = [] } = await this.#json("/api/rules");
    const usable = rules.filter((r) => r.behaviorId === behaviorId && r.enabled !== false);
    usable.sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)));
    return usable.at(-1)?.id ?? null;
  }

  async #send(rule, phase) {
    this.counter += 1;
    const eventId = `vexo-web-${Date.now()}-${this.counter}`;
    const out = await this.#json("/api/events", { bandNumber: this.bandNumber, ruleId: rule, eventId, phase });
    this.log(`nope: ${phase}`, out.event?.correction ?? null);
    return out;
  }

  /** Call with each detection event. Returns what was sent ("started" | "continued" | null). */
  async report(event) {
    const behavior = this.map[event.kind];
    if (!behavior || event.test) return null;
    let episode = this.episodes.get(behavior);
    if (episode) this.clearTimer(episode.timer);
    let phase = "continued";
    let rule = episode?.rule;
    if (!episode) {
      rule = await this.#ruleFor(behavior);
      if (!rule) {
        this.log(`nope: no enabled "${behavior}" rule yet, so nothing was sent. Create one in Nope first.`);
        return null;
      }
      phase = "started";
    }
    await this.#send(rule, phase);
    const timer = this.setTimer(() => this.#end(behavior), this.episodeIdleS * 1000);
    this.episodes.set(behavior, { rule, timer });
    return phase;
  }

  async #end(behavior) {
    const episode = this.episodes.get(behavior);
    if (!episode) return;
    this.episodes.delete(behavior);
    try {
      await this.#send(episode.rule, "stopped");
    } catch (error) {
      this.log(`nope: stop failed (${error.message})`);
    }
  }

  /** End every open episode now (when the band disconnects). */
  async stopAll() {
    for (const behavior of [...this.episodes.keys()]) {
      this.clearTimer(this.episodes.get(behavior).timer);
      await this.#end(behavior);
    }
  }
}
