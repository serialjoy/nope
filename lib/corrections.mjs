import { isCompactRule } from "./validation.mjs";
import { HttpError } from "./errors.mjs";

const PAYMENT_STATUSES = new Set(["demo", "succeeded", "not_connected", "failed", "pending"]);

function safeMessage(value) {
  return typeof value === "string" && value.trim()
    ? value.trim().slice(0, 400)
    : undefined;
}

function normalizeOutcome(value) {
  if (!value || typeof value !== "object" || !PAYMENT_STATUSES.has(value.status)) {
    // An unknown provider result is not safe evidence that a payment failed.
    return { status: "pending", message: "The test penalty is still being confirmed." };
  }
  return {
    status: value.status,
    paymentId: typeof value.paymentId === "string" ? value.paymentId.slice(0, 240) : undefined,
    message: safeMessage(value.message),
  };
}

function correctionFromEpisode(episode, warningArmed) {
  if (episode.stage === 1) {
    return {
      stage: 1,
      status: "preview",
      episodeId: episode.id,
      warningArmed,
    };
  }
  const correction = {
    stage: 2,
    status: episode.charge?.status || "pending",
    amountDollars: episode.amountDollars,
    episodeId: episode.id,
    warningArmed,
  };
  if (episode.charge?.paymentId) correction.paymentId = episode.charge.paymentId;
  if (episode.charge?.message) correction.message = episode.charge.message;
  return correction;
}

function stoppedCorrection(episode, warningArmed) {
  return {
    stage: episode.stage,
    status: "stopped",
    episodeId: episode.id,
    warningArmed,
  };
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

      const rule = await this.#store.get(event.ruleId);
      if (!rule) throw new HttpError(404, "Rule not found.");
      if (!rule.enabled) throw new HttpError(409, "This rule is paused.");

      const correction = await this.#handle({ rule, event });
      const routedEvent = correction ? { ...event, correction } : event;
      const storedEvent = await this.#store.recordEventReceipt(event.eventId, routedEvent);
      return { duplicate: false, event: storedEvent };
    });
  }

  async stop(ruleId, { episodeId = null, reason = "stopped" } = {}) {
    return this.runExclusive(async () => {
      const rule = await this.#store.get(ruleId);
      if (!rule) throw new HttpError(404, "Rule not found.");
      if (!isCompactRule(rule)) {
        return { kind: "none", episode: null, warningArmed: false };
      }
      const stopped = await this.#store.stopRepeatEpisode({
        ruleId: rule.id,
        episodeId,
        reason,
        endedAt: this.#nowIso(),
      });
      if (stopped.kind === "stale") throw new HttpError(409, "That detector occurrence is no longer current.");
      return stopped;
    });
  }

  #nowIso() {
    const value = this.#now();
    const date = value instanceof Date ? value : new Date(value);
    return date.toISOString();
  }

  async #handle({ rule, event }) {
    // Old compact episodes used elapsed time. They are intentionally not resumed
    // into the new repeat-policy cycle after an upgrade.
    if (!isCompactRule(rule)) return null;

    const now = this.#nowIso();
    if (event.phase === "started") {
      const started = await this.#store.startRepeatEpisode({
        ruleId: rule.id,
        startEventId: event.eventId,
        occurrenceId: event.occurrenceId,
        startedAt: now,
        amountDollars: rule.penaltyAmount,
      });
      if (!started.episode) return null;
      if (started.episode.stage === 1) {
        return correctionFromEpisode(started.episode, started.warningArmed);
      }
      return this.#settleStageTwo(started.episode);
    }

    if (event.phase === "stopped") {
      const stopped = await this.#store.stopRepeatEpisode({
        ruleId: rule.id,
        occurrenceId: event.occurrenceId,
        reason: "stopped",
        endedAt: now,
      });
      if (stopped.kind === "stale" || !stopped.episode) return null;
      return stoppedCorrection(stopped.episode, stopped.warningArmed);
    }

    // Continued packets are never evidence of a distinct second occurrence.
    const progress = await this.#store.getRepeatProgress(rule.id);
    if (!progress?.episode) return null;
    // A detector may drain a stale packet after the user has stopped the
    // occurrence. Do not reopen its nudge just because the packet arrived late.
    if (progress.episode.stage === 1 && !progress.episode.active) return null;
    if (progress.episode.stage === 1 || progress.episode.charge?.state === "complete") {
      return correctionFromEpisode(progress.episode, progress.warningArmed);
    }
    return this.#settleStageTwo(progress.episode);
  }

  async #settleStageTwo(episode) {
    let reservation = await this.#store.reserveRepeatCharge({
      episodeId: episode.id,
      now: this.#nowIso(),
    });
    if (!reservation.episode) return null;
    if (reservation.kind === "complete") {
      return correctionFromEpisode(reservation.episode, reservation.warningArmed);
    }

    let charge = reservation.episode.charge;
    if (!charge.paymentSnapshot) {
      const prepared = await this.#prepareCharge({
        amountDollars: charge.amountDollars,
        idempotencyKey: charge.idempotencyKey,
      });
      if (prepared.status !== "ready") {
        const completed = await this.#store.completeRepeatCharge({
          episodeId: reservation.episode.id,
          idempotencyKey: charge.idempotencyKey,
          outcome: normalizeOutcome(prepared),
          completedAt: this.#nowIso(),
        });
        return completed
          ? correctionFromEpisode(completed.episode, completed.warningArmed)
          : correctionFromEpisode(reservation.episode, reservation.warningArmed);
      }
      if (prepared.paymentSnapshot) {
        const saved = await this.#store.setRepeatChargeSnapshot({
          episodeId: reservation.episode.id,
          idempotencyKey: charge.idempotencyKey,
          paymentSnapshot: prepared.paymentSnapshot,
        });
        if (!saved) return null;
        reservation = { ...reservation, episode: saved };
        charge = saved.charge;
      }
    }

    let outcome;
    try {
      outcome = normalizeOutcome(await this.#payments.charge({
        amountDollars: charge.amountDollars,
        idempotencyKey: charge.idempotencyKey,
        paymentSnapshot: charge.paymentSnapshot,
        paymentId: charge.paymentId,
        reservedAt: charge.reservedAt,
      }));
    } catch {
      outcome = { status: "pending", message: "The test penalty is still being confirmed." };
    }
    const completed = await this.#store.completeRepeatCharge({
      episodeId: reservation.episode.id,
      idempotencyKey: charge.idempotencyKey,
      outcome,
      completedAt: this.#nowIso(),
    });
    return completed
      ? correctionFromEpisode(completed.episode, completed.warningArmed)
      : correctionFromEpisode(reservation.episode, reservation.warningArmed);
  }

  async #prepareCharge(input) {
    if (typeof this.#payments.prepareCharge !== "function") {
      return { status: "ready", paymentSnapshot: null };
    }
    try {
      const prepared = await this.#payments.prepareCharge(input);
      if (prepared?.status === "ready") {
        const snapshot = prepared.paymentSnapshot;
        // Test adapters that predate prepareCharge deliberately have no saved-card
        // snapshot.  They are only used through the injected server adapter; the
        // real Stripe implementation always supplies a frozen snapshot.
        if (snapshot === null || snapshot === undefined) {
          return { status: "ready", paymentSnapshot: null };
        }
        if (typeof snapshot !== "object") return { status: "pending" };
        return {
          status: "ready",
          paymentSnapshot: {
            customerId: snapshot.customerId,
            paymentMethodId: snapshot.paymentMethodId,
          },
        };
      }
      return normalizeOutcome(prepared);
    } catch {
      return { status: "pending", message: "The test penalty is still being confirmed." };
    }
  }
}
