import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";

const MAX_EVENT_RECEIPTS = 1_000;
const REPEAT_POLICY_VERSION = 2;
const EMPTY_STATE = {
  rules: [],
  episodes: [],
  eventReceipts: [],
  warnings: [],
  occurrenceReceipts: [],
  noIdBoundaries: [],
};

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function isRepeatEpisode(episode) {
  return episode?.repeatPolicyVersion === REPEAT_POLICY_VERSION;
}

function isResetOutcome(status) {
  return status === "succeeded" || status === "demo";
}

export class RulesStore {
  #dataDirectory;
  #filePath;
  #state = null;
  #initializing = null;
  #queue = Promise.resolve();

  constructor(dataDirectory) {
    this.#dataDirectory = dataDirectory;
    this.#filePath = path.join(dataDirectory, "rules.json");
  }

  async init() {
    if (this.#state) return;
    if (!this.#initializing) {
      this.#initializing = (async () => {
        await mkdir(this.#dataDirectory, { recursive: true });
        try {
          const parsed = JSON.parse(await readFile(this.#filePath, "utf8"));
          if (!parsed || !Array.isArray(parsed.rules)) throw new Error("invalid state");
          this.#state = {
            rules: parsed.rules,
            episodes: Array.isArray(parsed.episodes) ? parsed.episodes : [],
            eventReceipts: Array.isArray(parsed.eventReceipts) ? parsed.eventReceipts : [],
            warnings: Array.isArray(parsed.warnings) ? parsed.warnings : [],
            // Occurrence identities must outlive the shorter transport receipt history.
            occurrenceReceipts: Array.isArray(parsed.occurrenceReceipts) ? parsed.occurrenceReceipts : [],
            noIdBoundaries: Array.isArray(parsed.noIdBoundaries) ? parsed.noIdBoundaries : [],
          };
        } catch (error) {
          if (error?.code === "ENOENT") {
            this.#state = clone(EMPTY_STATE);
            return;
          }
          throw new Error("Could not read saved rules.");
        }
      })();
    }
    try {
      await this.#initializing;
    } finally {
      this.#initializing = null;
    }
  }

  async list() {
    await this.init();
    return clone(this.#state.rules);
  }

  async get(id) {
    await this.init();
    const rule = this.#state.rules.find((item) => item.id === id);
    return rule ? clone(rule) : null;
  }

  async warningArmed(ruleId) {
    await this.init();
    return Boolean(this.#warningForRule(this.#state, ruleId));
  }

  async create(rule) {
    return this.#withWrite((state) => {
      state.rules.push(rule);
      return rule;
    });
  }

  async update(id, change, {
    endActiveEpisodesAt = null,
    endReason = null,
    resetWarning = false,
  } = {}) {
    return this.#withWrite((state) => {
      const index = state.rules.findIndex((rule) => rule.id === id);
      if (index === -1) return null;
      state.rules[index] = { ...state.rules[index], ...change };
      if (endActiveEpisodesAt) this.#endActiveEpisodes(state, id, endActiveEpisodesAt, endReason || "rule_changed");
      // An unresolved payment is a durable safety boundary and cannot be discarded by an edit.
      if (resetWarning && !this.#pendingWarning(state, id)) {
        this.#removeWarning(state, id);
        this.#clearNoIdBoundary(state, id);
        state.occurrenceReceipts = state.occurrenceReceipts.filter((receipt) => receipt.ruleId !== id);
      }
      return state.rules[index];
    });
  }

  async remove(id) {
    return this.#withWrite((state) => {
      const index = state.rules.findIndex((rule) => rule.id === id);
      if (index === -1) return false;
      state.rules.splice(index, 1);
      this.#endActiveEpisodes(state, id, new Date().toISOString(), "rule_deleted");
      this.#removeWarning(state, id, { removeOccurrenceReceipts: true });
      this.#clearNoIdBoundary(state, id);
      return true;
    });
  }

  async getEventReceipt(eventId) {
    await this.init();
    const receipt = this.#state.eventReceipts.find((item) => item.eventId === eventId);
    return receipt ? clone(receipt.event) : null;
  }

  async recordEventReceipt(eventId, event) {
    return this.#withWrite((state) => {
      const prior = state.eventReceipts.find((item) => item.eventId === eventId);
      if (prior) return prior.event;
      state.eventReceipts.push({ eventId, event });
      if (state.eventReceipts.length > MAX_EVENT_RECEIPTS) state.eventReceipts.shift();
      return event;
    });
  }

  async startRepeatEpisode({
    ruleId,
    startEventId,
    occurrenceId = null,
    startedAt,
    amountDollars,
  }) {
    return this.#withWrite((state) => {
      const priorEvent = state.episodes.find((episode) => isRepeatEpisode(episode)
        && episode.ruleId === ruleId && episode.startEventId === startEventId);
      if (priorEvent) return this.#episodeStartResult(state, "existing", priorEvent);

      if (occurrenceId) {
        const priorOccurrence = state.occurrenceReceipts.find((receipt) => receipt.ruleId === ruleId
          && receipt.occurrenceId === occurrenceId);
        if (priorOccurrence) {
          const episode = state.episodes.find((item) => item.id === priorOccurrence.episodeId);
          if (episode) return this.#episodeStartResult(state, "existing", episode);
        }
      }
      const noIdBoundary = occurrenceId ? null : this.#noIdBoundaryForRule(state, ruleId);
      if (noIdBoundary && !noIdBoundary.stopped) {
        const episode = state.episodes.find((item) => item.id === noIdBoundary.episodeId)
          || this.#latestRepeatEpisodeForRule(state, ruleId);
        return this.#episodeStartResult(state, "ignored", episode);
      }

      let warning = this.#warningForRule(state, ruleId);
      if (!warning) {
        warning = {
          id: "warning_" + randomUUID(),
          ruleId,
          warningEpisodeId: null,
          activeEpisodeId: null,
          startBoundaryReached: false,
          createdAt: startedAt,
          updatedAt: startedAt,
        };
        state.warnings.push(warning);
        const episode = this.#createRepeatEpisode(state, {
          ruleId,
          startEventId,
          occurrenceId,
          startedAt,
          amountDollars,
          warningId: warning.id,
          stage: 1,
        });
        warning.warningEpisodeId = episode.id;
        warning.activeEpisodeId = episode.id;
        this.#markNoIdStarted(state, ruleId, occurrenceId, episode.id, startedAt);
        this.#rememberOccurrence(state, ruleId, occurrenceId, episode.id);
        return this.#episodeStartResult(state, "stage1", episode);
      }

      const pending = this.#pendingEpisodeForWarning(state, warning.id);
      if (pending) {
        this.#markNoIdStarted(state, ruleId, occurrenceId, pending.id, startedAt);
        this.#rememberOccurrence(state, ruleId, occurrenceId, pending.id);
        return this.#episodeStartResult(state, "pending", pending);
      }

      const active = this.#activeEpisodeForWarning(state, warning);
      if (!occurrenceId && !warning.startBoundaryReached) {
        return this.#episodeStartResult(state, "ignored", active || this.#latestEpisodeForWarning(state, warning.id));
      }

      if (active) this.#endEpisode(active, startedAt, "superseded");
      const episode = this.#createRepeatEpisode(state, {
        ruleId,
        startEventId,
        occurrenceId,
        startedAt,
        amountDollars,
        warningId: warning.id,
        stage: 2,
      });
      warning.activeEpisodeId = episode.id;
      warning.startBoundaryReached = false;
      warning.updatedAt = startedAt;
      this.#markNoIdStarted(state, ruleId, occurrenceId, episode.id, startedAt);
      this.#rememberOccurrence(state, ruleId, occurrenceId, episode.id);
      return this.#episodeStartResult(state, "stage2", episode);
    });
  }

  async getRepeatProgress(ruleId) {
    await this.init();
    const warning = this.#warningForRule(this.#state, ruleId);
    if (!warning) return null;
    const episode = this.#pendingEpisodeForWarning(this.#state, warning.id)
      || this.#activeEpisodeForWarning(this.#state, warning)
      || this.#latestEpisodeForWarning(this.#state, warning.id);
    return clone({
      episode: episode || null,
      warningArmed: true,
      kind: episode?.charge?.state === "pending" ? "pending" : "current",
    });
  }

  async reserveRepeatCharge({ episodeId, now }) {
    return this.#withWrite((state) => {
      const episode = state.episodes.find((item) => item.id === episodeId);
      if (!isRepeatEpisode(episode) || episode.stage !== 2) return { kind: "no_episode", episode: null, warningArmed: false };
      if (episode.charge?.state === "complete") return this.#chargeResult(state, "complete", episode);
      if (!episode.charge) {
        episode.charge = {
          state: "pending",
          status: "pending",
          idempotencyKey: "end-itt:" + episode.warningId + ":" + episode.id + ":stage-2",
          amountDollars: episode.amountDollars,
          paymentSnapshot: null,
          paymentId: null,
          message: null,
          reservedAt: now,
          lastAttemptAt: null,
          completedAt: null,
        };
      }
      return this.#chargeResult(state, "charge", episode);
    });
  }

  async setRepeatChargeSnapshot({ episodeId, idempotencyKey, paymentSnapshot }) {
    return this.#withWrite((state) => {
      const episode = state.episodes.find((item) => item.id === episodeId);
      if (!episode?.charge || episode.charge.idempotencyKey !== idempotencyKey) return null;
      if (!episode.charge.paymentSnapshot) {
        episode.charge.paymentSnapshot = {
          customerId: paymentSnapshot.customerId,
          paymentMethodId: paymentSnapshot.paymentMethodId,
        };
      }
      return episode;
    });
  }

  async completeRepeatCharge({ episodeId, idempotencyKey, outcome, completedAt }) {
    return this.#withWrite((state) => {
      const episode = state.episodes.find((item) => item.id === episodeId);
      if (!episode?.charge || episode.charge.idempotencyKey !== idempotencyKey) return null;

      if (outcome.status === "pending") {
        episode.charge = {
          ...episode.charge,
          state: "pending",
          status: "pending",
          paymentId: outcome.paymentId ?? episode.charge.paymentId ?? null,
          message: outcome.message ?? null,
          lastAttemptAt: completedAt,
        };
        return this.#chargeResult(state, "pending", episode);
      }

      episode.charge = {
        ...episode.charge,
        state: "complete",
        status: outcome.status,
        paymentId: outcome.paymentId ?? episode.charge.paymentId ?? null,
        message: outcome.message ?? null,
        completedAt,
      };
      if (episode.active) this.#endEpisode(episode, completedAt, isResetOutcome(outcome.status) ? "charged" : "charge_failed");

      const warning = this.#warningById(state, episode.warningId);
      if (warning?.activeEpisodeId === episode.id) warning.activeEpisodeId = null;
      if (warning) warning.updatedAt = completedAt;
      if (warning && isResetOutcome(outcome.status)) this.#removeWarningById(state, warning.id);
      return this.#chargeResult(state, "complete", episode);
    });
  }

  async stopRepeatEpisode({
    ruleId,
    episodeId = null,
    occurrenceId = null,
    reason = "stopped",
    endedAt,
  }) {
    return this.#withWrite((state) => {
      const supplied = episodeId
        ? state.episodes.find((episode) => episode.id === episodeId && episode.ruleId === ruleId && isRepeatEpisode(episode))
        : occurrenceId
          ? state.episodes.find((episode) => episode.ruleId === ruleId
            && episode.occurrenceId === occurrenceId && isRepeatEpisode(episode))
          : null;
      if ((episodeId || occurrenceId) && !supplied) {
        return { kind: "stale", episode: null, warningArmed: Boolean(this.#warningForRule(state, ruleId)) };
      }

      const warning = this.#warningForRule(state, ruleId);
      const active = warning ? this.#activeEpisodeForWarning(state, warning) : null;
      const episode = supplied || active || (!episodeId && !occurrenceId
        ? this.#latestRepeatEpisodeForRule(state, ruleId)
        : null);
      if (!episode) return { kind: "none", episode: null, warningArmed: Boolean(warning) };

      if (warning && episode.warningId !== warning.id) {
        return { kind: "stale", episode, warningArmed: true };
      }
      if (episodeId && active && active.id !== episodeId) {
        return { kind: "stale", episode, warningArmed: Boolean(warning) };
      }
      const latest = warning ? this.#latestEpisodeForWarning(state, warning.id) : null;
      if (episodeId && latest && latest.id !== episode.id) {
        return { kind: "stale", episode, warningArmed: Boolean(warning) };
      }

      if (reason === "false_alarm") {
        const hasStageTwo = warning && state.episodes.some((item) => item.warningId === warning.id && item.stage === 2);
        if (!warning || episode.stage !== 1 || warning.warningEpisodeId !== episode.id || hasStageTwo) {
          return { kind: "stale", episode, warningArmed: Boolean(warning) };
        }
        if (episode.active) this.#endEpisode(episode, endedAt, "false_alarm");
        if (!episode.occurrenceId) this.#markNoIdStopped(state, ruleId, episode.id, endedAt);
        this.#removeWarningById(state, warning.id);
        return { kind: "false_alarm", episode, warningArmed: false };
      }

      if (episode.active) this.#endEpisode(episode, endedAt, "stopped");
      if (warning?.activeEpisodeId === episode.id) {
        warning.activeEpisodeId = null;
        warning.startBoundaryReached = true;
        warning.updatedAt = endedAt;
      }
      if (!episode.occurrenceId) {
        this.#markNoIdStopped(state, ruleId, episode.id, endedAt);
        if (warning) {
          warning.startBoundaryReached = true;
          warning.updatedAt = endedAt;
        }
      }
      return { kind: "stopped", episode, warningArmed: Boolean(warning) };
    });
  }

  #createRepeatEpisode(state, {
    ruleId,
    startEventId,
    occurrenceId,
    startedAt,
    amountDollars,
    warningId,
    stage,
  }) {
    const id = "episode_" + randomUUID();
    const episode = {
      id,
      ruleId,
      startEventId,
      occurrenceId: occurrenceId || null,
      repeatPolicyVersion: REPEAT_POLICY_VERSION,
      stage,
      warningId,
      startedAt,
      active: true,
      endedAt: null,
      endedReason: null,
      amountDollars,
      // Stage two is persisted as a reservation in the same write as the
      // distinct occurrence. A crash before the receipt write can therefore
      // only ever resume this exact key, never create a fresh charge.
      charge: stage === 2
        ? {
          state: "pending",
          status: "pending",
          idempotencyKey: "end-itt:" + warningId + ":" + id + ":stage-2",
          amountDollars,
          paymentSnapshot: null,
          paymentId: null,
          message: null,
          reservedAt: startedAt,
          lastAttemptAt: null,
          completedAt: null,
        }
        : null,
    };
    state.episodes.push(episode);
    return episode;
  }

  #episodeStartResult(state, kind, episode) {
    const warning = episode ? this.#warningById(state, episode.warningId) : null;
    return { kind, episode: episode || null, warningArmed: Boolean(warning) };
  }

  #chargeResult(state, kind, episode) {
    return {
      kind,
      episode,
      warningArmed: Boolean(this.#warningById(state, episode.warningId)),
    };
  }

  #rememberOccurrence(state, ruleId, occurrenceId, episodeId) {
    if (!occurrenceId) return;
    const prior = state.occurrenceReceipts.find((receipt) => receipt.ruleId === ruleId
      && receipt.occurrenceId === occurrenceId);
    if (!prior) state.occurrenceReceipts.push({ ruleId, occurrenceId, episodeId });
  }

  #warningForRule(state, ruleId) {
    return state.warnings.find((warning) => warning.ruleId === ruleId) || null;
  }

  #warningById(state, warningId) {
    return state.warnings.find((warning) => warning.id === warningId) || null;
  }

  #pendingWarning(state, ruleId) {
    const warning = this.#warningForRule(state, ruleId);
    return warning ? this.#pendingEpisodeForWarning(state, warning.id) : null;
  }

  #pendingEpisodeForWarning(state, warningId) {
    return state.episodes.find((episode) => isRepeatEpisode(episode)
      && episode.warningId === warningId && episode.charge?.state === "pending") || null;
  }

  #activeEpisodeForWarning(state, warning) {
    if (!warning?.activeEpisodeId) return null;
    const episode = state.episodes.find((item) => item.id === warning.activeEpisodeId);
    return episode?.active ? episode : null;
  }

  #latestEpisodeForWarning(state, warningId) {
    for (let index = state.episodes.length - 1; index >= 0; index -= 1) {
      const episode = state.episodes[index];
      if (isRepeatEpisode(episode) && episode.warningId === warningId) return episode;
    }
    return null;
  }

  #latestRepeatEpisodeForRule(state, ruleId) {
    for (let index = state.episodes.length - 1; index >= 0; index -= 1) {
      const episode = state.episodes[index];
      if (isRepeatEpisode(episode) && episode.ruleId === ruleId) return episode;
    }
    return null;
  }

  #noIdBoundaryForRule(state, ruleId) {
    return state.noIdBoundaries.find((boundary) => boundary.ruleId === ruleId) || null;
  }

  #markNoIdStarted(state, ruleId, occurrenceId, episodeId, updatedAt) {
    if (occurrenceId) return;
    const boundary = this.#noIdBoundaryForRule(state, ruleId);
    if (boundary) Object.assign(boundary, { episodeId, stopped: false, updatedAt });
    else state.noIdBoundaries.push({ ruleId, episodeId, stopped: false, updatedAt });
  }

  #markNoIdStopped(state, ruleId, episodeId, updatedAt) {
    const boundary = this.#noIdBoundaryForRule(state, ruleId);
    if (boundary) Object.assign(boundary, { episodeId, stopped: true, updatedAt });
    else state.noIdBoundaries.push({ ruleId, episodeId, stopped: true, updatedAt });
  }

  #clearNoIdBoundary(state, ruleId) {
    state.noIdBoundaries = state.noIdBoundaries.filter((boundary) => boundary.ruleId !== ruleId);
  }

  #endEpisode(episode, endedAt, reason) {
    episode.active = false;
    episode.endedAt = endedAt;
    episode.endedReason = reason;
  }

  #endActiveEpisodes(state, ruleId, endedAt, reason) {
    for (const episode of state.episodes) {
      if (episode.ruleId === ruleId && episode.active) this.#endEpisode(episode, endedAt, reason);
    }
    const warning = this.#warningForRule(state, ruleId);
    if (warning?.activeEpisodeId) {
      warning.activeEpisodeId = null;
      warning.startBoundaryReached = true;
      warning.updatedAt = endedAt;
    }
  }

  #removeWarning(state, ruleId, { removeOccurrenceReceipts = false } = {}) {
    const warning = this.#warningForRule(state, ruleId);
    if (warning) this.#removeWarningById(state, warning.id);
    if (removeOccurrenceReceipts) {
      state.occurrenceReceipts = state.occurrenceReceipts.filter((receipt) => receipt.ruleId !== ruleId);
    }
  }

  #removeWarningById(state, warningId) {
    const index = state.warnings.findIndex((warning) => warning.id === warningId);
    if (index !== -1) state.warnings.splice(index, 1);
  }

  async #withWrite(change) {
    const run = this.#queue.then(async () => {
      await this.init();
      const draft = clone(this.#state);
      const result = change(draft);
      await this.#write(draft);
      this.#state = draft;
      return clone(result);
    });
    this.#queue = run.catch(() => {});
    return run;
  }

  async #write(state) {
    const temporaryPath = this.#filePath + "." + process.pid + "." + Date.now() + ".tmp";
    await writeFile(temporaryPath, JSON.stringify(state, null, 2) + "\n", {
      encoding: "utf8",
      mode: 0o600,
    });
    await rename(temporaryPath, this.#filePath);
  }
}
