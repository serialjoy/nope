import { isCompactRule } from "./validation.mjs";
import { HttpError } from "./errors.mjs";

const PAYMENT_STATUSES = new Set(["demo", "succeeded", "not_connected", "failed"]);

function safeMessage(value) {
  return typeof value === "string" && value.trim()
    ? value.trim().slice(0, 400)
    : undefined;
}

function normalizeOutcome(value) {
  if (!value || typeof value !== "object" || !PAYMENT_STATUSES.has(value.status)) {
    return { status: "failed", message: "The test penalty could not be completed. Please try again later." };
  }
  return {
    status: value.status,
    paymentId: typeof value.paymentId === "string" ? value.paymentId.slice(0, 240) : undefined,
    message: safeMessage(value.message),
  };
}

function correctionFromCharge(episode) {
  const correction = {
    stage: 2,
    status: episode.charge.status,
    amountDollars: episode.amountDollars,
  };
  if (episode.charge.message) correction.message = episode.charge.message;
  return correction;
}

export class CorrectionsEngine {
  #store;
  #payments;
  #now;
  #queue = Promise.resolve();

  constructor({ store, payments, now = () => new Date() }) {
    this.#store = store;
    this.#payments = payments;
    this.#now = now;
  }

  async runExclusive(work) {
    const run = this.#queue.then(work);
    this.#queue = run.catch(() => {});
    return run;
  }

  async mutateRule(work) {
    return this.runExclusive(() => work(this.#nowIso()));
  }

  async processEvent(event) {
    return this.runExclusive(async () => {
      const prior = await this.#store.getEventReceipt(event.eventId);
      if (prior) return { duplicate: true, event: prior };

      // Read enabled/settings after this event reaches the serialized queue.
      // A queued started event must not revive a rule that was paused or edited first.
      const rule = await this.#store.get(event.ruleId);
      if (!rule) throw new HttpError(404, "Rule not found.");
      if (!rule.enabled) throw new HttpError(409, "This rule is paused.");

      const correction = await this.#handle({ rule, event });
      const routedEvent = correction ? { ...event, correction } : event;
      const storedEvent = await this.#store.recordEventReceipt(event.eventId, routedEvent);
      return { duplicate: false, event: storedEvent };
    });
  }

  async stop(ruleId) {
    return this.runExclusive(async () => {
      const rule = await this.#store.get(ruleId);
      if (!rule) throw new HttpError(404, "Rule not found.");
      if (!isCompactRule(rule)) return null;
      return this.#store.stopActiveEpisode(rule.id, this.#nowIso());
    });
  }

  #nowIso() {
    const value = this.#now();
    const date = value instanceof Date ? value : new Date(value);
    return date.toISOString();
  }

  async #handle({ rule, event }) {
    // Legacy rules remain visible and can receive detector events, but never charge.
    if (!isCompactRule(rule)) return null;

    const now = this.#nowIso();
    if (event.phase === "started") {
      await this.#store.beginEpisode({
        ruleId: rule.id,
        startEventId: event.eventId,
        startedAt: now,
        amountDollars: rule.penaltyAmount,
        graceSeconds: rule.graceSeconds,
      });
      return { stage: 1, status: "preview" };
    }

    if (event.phase === "stopped") {
      await this.#store.stopActiveEpisode(rule.id, now);
      return null;
    }

    const reservation = await this.#store.reserveEpisodeCharge({
      ruleId: rule.id,
      now,
      // Existing episodes use their persisted snapshot. These fields document the
      // current-rule call site and are intentionally not authoritative in the store.
      graceSeconds: rule.graceSeconds,
      amountDollars: rule.penaltyAmount,
    });
    if (reservation.kind === "no_episode") return null;
    if (reservation.kind === "preview") return { stage: 1, status: "preview" };
    if (reservation.kind === "complete") return correctionFromCharge(reservation.episode);

    let outcome;
    try {
      outcome = normalizeOutcome(await this.#payments.charge({
        amountDollars: reservation.episode.charge.amountDollars,
        idempotencyKey: reservation.episode.charge.idempotencyKey,
      }));
    } catch {
      outcome = { status: "failed", message: "The test penalty could not be completed. Please try again later." };
    }
    const completed = await this.#store.completeEpisodeCharge({
      episodeId: reservation.episode.id,
      idempotencyKey: reservation.episode.charge.idempotencyKey,
      outcome,
      completedAt: this.#nowIso(),
    });
    // A persisted reservation is always retried using its original key if a process
    // is interrupted before this completion write succeeds.
    return completed ? correctionFromCharge(completed) : {
      stage: 2,
      status: outcome.status,
      amountDollars: reservation.episode.amountDollars,
      ...(outcome.message ? { message: outcome.message } : {}),
    };
  }
}
