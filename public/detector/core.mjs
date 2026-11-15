// Detector logic with no browser or model code in it, so it runs the same in a page and in tests.
//
// audio (16 kHz) + wrist motion -> sound classifier -> motion gate -> detection events
// -> Nope occurrences (started / stopped).
//
// Port of the Python detector the team evaluated (sound-lab/server/detector.py + nope_bridge.py).

export const SAMPLE_RATE = 16000;
export const WINDOW_S = 4;                       // the classifier hears the last 4 s
export const TARGETS = ["can_opening", "lighter"];
const MOTION_HISTORY_MS = 10_000;
const MAX_MOTION_HISTORY_SAMPLES = 1_000;
const MIN_MOTION_SAMPLES = 20;
const LIGHTER_CONFIRMATION_REQUIRED = 2;
const LIGHTER_CLEAR_REQUIRED = 2;
const LIGHTER_CHECK_GAP_MS = 500;
const LIGHTER_RESET_THRESHOLD = 0.4;

export const DEFAULTS = Object.freeze({
  threshold: { can_opening: 0.5, lighter: 0.75 }, // classifier probability needed to fire
  cooldownS: 5,                                  // same sound can fire at most this often
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
    this.motionHistory = [];                     // raw {t, gx, gy, gz}, for the monitor only
    this.latestMotion = null;
    this.audioRevision = 0;
    this.lastCheckedAudioRevision = null;
    this.inputGeneration = 0;
    this.lastFire = new Map();
    this.events = [];
    this.status = { windows: 0, scores: {}, motionActive: false, silent: true };
    this.decisionCounter = 0;
    this.decision = null;
    this.lighterGate = {
      armed: true,
      confirmationCount: 0,
      lastConfirmationAt: null,
      clearCount: 0,
      lastClearAt: null,
    };
    this.#recordDecision("warming_up", { at: this.now(), audioPeak: 0, motion: this.#motionMetrics(this.now()) });
  }

  feedAudio(samples) {
    this.ring.push(samples);
    if (samples.length) this.audioRevision += 1;
  }

  feedMotion(gx, gy, gz) {
    const t = this.now();
    const raw = { t, gx, gy, gz };
    this.latestMotion = raw;
    this.motion.push({ t, v: Math.hypot(gx, gy, gz) });
    this.motionHistory.push(raw);
    const keep = t - this.options.motionLookbackS * 1000;
    while (this.motion.length && this.motion[0].t < keep) this.motion.shift();
    const historyKeep = t - MOTION_HISTORY_MS;
    while (this.motionHistory.length && this.motionHistory[0].t < historyKeep) this.motionHistory.shift();
    if (this.motionHistory.length > MAX_MOTION_HISTORY_SAMPLES) {
      this.motionHistory.splice(0, this.motionHistory.length - MAX_MOTION_HISTORY_SAMPLES);
    }
  }

  motionActive() {
    return this.#motionMetrics(this.now()).active;
  }

  /** Look at the last window once. Returns the detection event, or null. Call about once a second. */
  async step() {
    const inputGeneration = this.inputGeneration;
    const checkAt = this.now();
    const audioMetrics = this.#audioMetrics();
    const motion = this.#motionMetrics(checkAt);
    if (!this.ring.full) {
      this.#recordDecision("warming_up", { at: checkAt, audioPeak: audioMetrics.peak, motion });
      return null;
    }
    if (this.lastCheckedAudioRevision === this.audioRevision) {
      this.#recordDecision("waiting_for_audio", { at: checkAt, audioPeak: audioMetrics.peak, motion });
      return null;
    }
    this.lastCheckedAudioRevision = this.audioRevision;
    const audio = this.ring.snapshot();
    if (audioMetrics.silent) {                    // silence: skip the model
      this.status = { ...this.status, scores: {}, motionActive: motion.active, silent: true };
      if (!this.lighterGate.armed && !this.#recordLighterClear(checkAt)) {
        this.#recordDecision("awaiting_clear", { at: checkAt, audioPeak: audioMetrics.peak, motion });
        return null;
      }
      this.#resetLighterConfirmation();
      this.#recordDecision("quiet", { at: checkAt, audioPeak: audioMetrics.peak, motion });
      return null;
    }

    let scores;
    try {
      scores = await this.classify(audio);
    } catch (error) {
      if (inputGeneration !== this.inputGeneration) return null;
      this.status = { ...this.status, scores: {}, motionActive: motion.active, silent: false };
      this.#resetLighterCounters();
      this.#recordDecision("classifier_error", { at: this.now(), audioPeak: audioMetrics.peak, motion });
      throw error;
    }
    if (inputGeneration !== this.inputGeneration) return null;
    const decisionAt = this.now();
    if (!this.#validScores(scores)) {
      this.status = { windows: this.status.windows + 1, scores: {}, motionActive: motion.active, silent: false };
      this.#resetLighterCounters();
      this.#recordDecision("classifier_error", { at: decisionAt, audioPeak: audioMetrics.peak, motion });
      return null;
    }
    this.status = { windows: this.status.windows + 1, scores, motionActive: motion.active, silent: false };

    const scoreFor = (kind) => scores[kind] ?? 0;
    const target = TARGETS.reduce((best, kind) => (scoreFor(kind) > scoreFor(best) ? kind : best));
    const [topLabel, topScore] = Object.entries(scores).reduce((best, score) => (score[1] > best[1] ? score : best));
    const targetScore = scoreFor(target);
    const threshold = this.options.threshold[target];
    const details = { at: decisionAt, target, topLabel, topScore, targetScore, threshold, audioPeak: audioMetrics.peak, motion };
    if (!this.lighterGate.armed) {
      // Clear is deliberately checked before `other_sound`: a low lighter score is useful
      // evidence even when a different sound currently wins the classifier.
      const lighterScore = scores.lighter;
      if (Number.isFinite(lighterScore) && lighterScore < LIGHTER_RESET_THRESHOLD) {
        if (!this.#recordLighterClear(decisionAt)) {
          if (target === "lighter") {
            this.#recordDecision("awaiting_clear", details);
            return null;
          }
        }
      } else {
        this.#resetLighterClear();
        if (target === "lighter") {
          this.#recordDecision("awaiting_clear", details);
          return null;
        }
      }
    }
    const eligibleLighter = target === "lighter"
      && topLabel === "lighter"
      && targetScore >= threshold
      && (!this.options.requireMotion || motion.active);
    if (!eligibleLighter) this.#resetLighterConfirmation();
    if (topLabel !== target) {
      this.#recordDecision("other_sound", details);
      return null;
    }
    if (targetScore < threshold) {
      this.#recordDecision("low_confidence", details);
      return null;
    }
    if (this.options.requireMotion && !motion.active) {
      this.#recordDecision("insufficient_motion", details);
      return null;
    }
    if (target === "lighter" && !this.#recordLighterConfirmation(decisionAt)) {
      this.#recordDecision("confirming", details);
      return null;
    }
    if (this.#cooldownRemaining(target, decisionAt) > 0) {
      this.#recordDecision("cooldown", details);
      return null;
    }
    this.lastFire.set(target, decisionAt);
    if (target === "lighter") this.#disarmLighter();
    this.#recordDecision("detected", details);

    const event = {
      id: this.events.length + 1,
      kind: target,
      confidence: Math.round(targetScore * 1000) / 1000,
      motion_active: motion.active,
      time: new Date(decisionAt).toISOString(),
    };
    this.events.push(event);
    this.onEvent(event);
    return event;
  }

  /** Read-only live monitor state. All nested values are copied for UI consumers. */
  diagnostics() {
    const at = this.now();
    const audio = this.#audioMetrics();
    const motion = this.#motionMetrics(at);
    const historyStart = at - MOTION_HISTORY_MS;
    const latest = this.latestMotion;
    return {
      motion: {
        active: motion.active,
        std: motion.std,
        threshold: this.options.motionGyroStd,
        sampleCount: motion.sampleCount,
        minimumSamples: MIN_MOTION_SAMPLES,
        latest: latest ? { ...latest } : null,
        ageMs: latest ? Math.max(0, at - latest.t) : null,
        history: this.motionHistory.filter((sample) => sample.t >= historyStart).map((sample) => ({ ...sample })),
      },
      audio: {
        bufferedSeconds: this.ring.filled / SAMPLE_RATE,
        requiredSeconds: WINDOW_S,
        peak: audio.peak,
        silent: audio.silent,
      },
      decision: {
        ...this.decision,
        cooldownRemainingMs: this.#cooldownRemaining(this.decision.target, at),
      },
      cooldowns: Object.fromEntries(TARGETS.map((target) => [target, this.#cooldownRemaining(target, at)])),
      gates: {
        lighter: {
          confirmationCount: this.lighterGate.confirmationCount,
          confirmationRequired: LIGHTER_CONFIRMATION_REQUIRED,
          clearCount: this.lighterGate.clearCount,
          clearRequired: LIGHTER_CLEAR_REQUIRED,
          armed: this.lighterGate.armed,
          resetThreshold: LIGHTER_RESET_THRESHOLD,
        },
      },
    };
  }

  /** Reset live inputs only; accepted detections keep their cooldown and IDs. */
  resetInput() {
    this.inputGeneration += 1;
    this.ring.data.fill(0);
    this.ring.filled = 0;
    this.motion.length = 0;
    this.motionHistory.length = 0;
    this.latestMotion = null;
    this.lastCheckedAudioRevision = null;
    this.#resetLighterCounters();
    this.status = { ...this.status, scores: {}, motionActive: false, silent: true };
    const at = this.now();
    this.#recordDecision("warming_up", { at, audioPeak: 0, motion: this.#motionMetrics(at) });
  }

  #motionMetrics(at) {
    const keep = at - this.options.motionLookbackS * 1000;
    const values = this.motion.filter((sample) => sample.t >= keep && Number.isFinite(sample.v)).map((sample) => sample.v);
    const sampleCount = values.length;
    const mean = sampleCount ? values.reduce((sum, value) => sum + value, 0) / sampleCount : 0;
    const std = sampleCount
      ? Math.sqrt(values.reduce((sum, value) => sum + (value - mean) ** 2, 0) / sampleCount)
      : 0;
    return { sampleCount, std, active: sampleCount >= MIN_MOTION_SAMPLES && std > this.options.motionGyroStd };
  }

  #audioMetrics() {
    let peak = 0;
    for (const sample of this.ring.data) peak = Math.max(peak, Math.abs(sample));
    return { peak, silent: peak < this.options.silenceLevel };
  }

  #validScores(scores) {
    if (!scores || typeof scores !== "object" || Array.isArray(scores)) return false;
    const entries = Object.entries(scores);
    return entries.length > 0 && entries.every(([, score]) => Number.isFinite(score) && score >= 0 && score <= 1);
  }

  #cooldownRemaining(target, at) {
    if (!TARGETS.includes(target)) return 0;
    const firedAt = this.lastFire.get(target);
    if (firedAt === undefined) return 0;
    return Math.max(0, this.options.cooldownS * 1000 - (at - firedAt));
  }

  #recordLighterConfirmation(at) {
    const gate = this.lighterGate;
    if (gate.confirmationCount === 0 || at - gate.lastConfirmationAt >= LIGHTER_CHECK_GAP_MS) {
      gate.confirmationCount += 1;
      gate.lastConfirmationAt = at;
      return gate.confirmationCount >= LIGHTER_CONFIRMATION_REQUIRED;
    }
    this.#resetLighterConfirmation();
    return false;
  }

  #recordLighterClear(at) {
    const gate = this.lighterGate;
    if (gate.clearCount === 0 || at - gate.lastClearAt >= LIGHTER_CHECK_GAP_MS) {
      gate.clearCount += 1;
      gate.lastClearAt = at;
    } else {
      this.#resetLighterClear();
      return false;
    }
    if (gate.clearCount < LIGHTER_CLEAR_REQUIRED) return false;
    gate.armed = true;
    this.#resetLighterCounters();
    return true;
  }

  #disarmLighter() {
    this.lighterGate.armed = false;
    this.#resetLighterCounters();
  }

  #resetLighterCounters() {
    this.#resetLighterConfirmation();
    this.#resetLighterClear();
  }

  #resetLighterConfirmation() {
    this.lighterGate.confirmationCount = 0;
    this.lighterGate.lastConfirmationAt = null;
  }

  #resetLighterClear() {
    this.lighterGate.clearCount = 0;
    this.lighterGate.lastClearAt = null;
  }

  #recordDecision(reason, {
    at,
    target = null,
    topLabel = null,
    topScore = null,
    targetScore = null,
    threshold = target ? this.options.threshold[target] ?? null : null,
    audioPeak,
    motion,
  }) {
    this.decision = {
      reason,
      at,
      target,
      topLabel,
      topScore,
      targetScore,
      threshold,
      cooldownRemainingMs: this.#cooldownRemaining(target, at),
      motionStd: motion.std,
      motionActive: motion.active,
      motionSampleCount: motion.sampleCount,
      motionThreshold: this.options.motionGyroStd,
      motionRequired: this.options.requireMotion,
      audioPeak,
      checkId: ++this.decisionCounter,
    };
  }
}

/**
 * Turns detections into Nope's started / stopped occurrences.
 *
 * Every debounced detector event is its own occurrence.  Keeping the generated IDs attached to that
 * detector identity makes a retried delivery harmless, while a later detection can advance Nope's rule.
 * A lighter strike is our evidence of smoking; there is no Nope habit for a can opening.
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
    this.episodes = new Map();                   // behaviorId -> { rule, timer, occurrenceId }
    this.occurrences = new Map();                // detector identity -> { occurrenceId, eventId }
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

  #nextId(prefix) {
    this.counter += 1;
    return `${prefix}-${Date.now()}-${this.counter}`;
  }

  #occurrenceFor(behavior, event) {
    const identity = `${behavior}:${event.id ?? "unknown"}:${event.time ?? "unknown"}`;
    let occurrence = this.occurrences.get(identity);
    if (!occurrence) {
      occurrence = {
        occurrenceId: this.#nextId("vexo-occurrence"),
        eventId: this.#nextId("vexo-web"),
      };
      this.occurrences.set(identity, occurrence);
    }
    return occurrence;
  }

  async #send(rule, phase, { eventId = this.#nextId("vexo-web"), occurrenceId } = {}) {
    const out = await this.#json("/api/events", {
      bandNumber: this.bandNumber, ruleId: rule, eventId, phase, ...(occurrenceId ? { occurrenceId } : {}),
    });
    this.log(`nope: ${phase}`, out.event?.correction ?? null);
    return out;
  }

  /** Call with each detection event. Returns "started" or null. */
  async report(event) {
    const behavior = this.map[event.kind];
    if (!behavior || event.test) return null;
    const prior = this.episodes.get(behavior);
    const rule = await this.#ruleFor(behavior);
    if (!rule) {
      // A paused/deleted rule must not leave an old timer able to report against it.
      if (this.episodes.get(behavior) === prior && prior) {
        this.clearTimer(prior.timer);
        this.episodes.delete(behavior);
      }
      this.log(`nope: no enabled "${behavior}" rule yet, so nothing was sent. Create one in Nope first.`);
      return null;
    }
    const occurrence = this.#occurrenceFor(behavior, event);
    await this.#send(rule, "started", occurrence);
    const next = { rule, timer: null, occurrenceId: occurrence.occurrenceId };
    next.timer = this.setTimer(() => this.#end(behavior, next), this.episodeIdleS * 1000);
    const previous = this.episodes.get(behavior);
    if (previous) this.clearTimer(previous.timer);
    this.episodes.set(behavior, next);
    return "started";
  }

  async #end(behavior, expectedEpisode = null) {
    const episode = this.episodes.get(behavior);
    if (!episode || (expectedEpisode && episode !== expectedEpisode)) return;
    this.episodes.delete(behavior);
    try {
      await this.#send(episode.rule, "stopped", { occurrenceId: episode.occurrenceId });
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
