import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";

const MAX_EVENT_RECEIPTS = 1_000;
const EMPTY_STATE = { rules: [], episodes: [], eventReceipts: [] };

function clone(value) {
  return JSON.parse(JSON.stringify(value));
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
            // Older saved projects only had rules. Keep them readable without changing them.
            episodes: Array.isArray(parsed.episodes) ? parsed.episodes : [],
            eventReceipts: Array.isArray(parsed.eventReceipts) ? parsed.eventReceipts : [],
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
      if (this.#state || this.#initializing) {
        this.#initializing = null;
      }
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

  async create(rule) {
    return this.#withWrite(() => {
      this.#state.rules.push(rule);
      return rule;
    });
  }

  async update(id, change, { endActiveEpisodesAt = null, endReason = null } = {}) {
    return this.#withWrite(() => {
      const index = this.#state.rules.findIndex((rule) => rule.id === id);
      if (index === -1) return null;
      this.#state.rules[index] = { ...this.#state.rules[index], ...change };
      if (endActiveEpisodesAt) this.#endActiveEpisodes(id, endActiveEpisodesAt, endReason || "rule_changed");
      return this.#state.rules[index];
    });
  }

  async remove(id) {
    return this.#withWrite(() => {
      const index = this.#state.rules.findIndex((rule) => rule.id === id);
      if (index === -1) return false;
      this.#state.rules.splice(index, 1);
      this.#endActiveEpisodes(id, new Date().toISOString(), "rule_deleted");
      return true;
    });
  }

  async getEventReceipt(eventId) {
    await this.init();
    const receipt = this.#state.eventReceipts.find((item) => item.eventId === eventId);
    return receipt ? clone(receipt.event) : null;
  }

  async recordEventReceipt(eventId, event) {
    return this.#withWrite(() => {
      const prior = this.#state.eventReceipts.find((item) => item.eventId === eventId);
      if (prior) return prior.event;
      this.#state.eventReceipts.push({ eventId, event });
      if (this.#state.eventReceipts.length > MAX_EVENT_RECEIPTS) this.#state.eventReceipts.shift();
      return event;
    });
  }

  async beginEpisode({ ruleId, startEventId, startedAt, amountDollars, graceSeconds }) {
    return this.#withWrite(() => {
      const existing = this.#state.episodes.find((episode) => episode.startEventId === startEventId);
      if (existing) return existing;
      this.#endActiveEpisodes(ruleId, startedAt, "superseded");
      const episode = {
        id: `episode_${randomUUID()}`,
        ruleId,
        startEventId,
        startedAt,
        active: true,
        endedAt: null,
        endedReason: null,
        // Freeze billing inputs at receipt time. Retries must use the same Stripe parameters.
        amountDollars,
        graceSeconds,
        charge: null,
      };
      this.#state.episodes.push(episode);
      return episode;
    });
  }

  async stopActiveEpisode(ruleId, endedAt) {
    return this.#withWrite(() => {
      const episode = this.#activeEpisode(ruleId);
      if (!episode) return null;
      episode.active = false;
      episode.endedAt = endedAt;
      episode.endedReason = "stopped";
      return episode;
    });
  }

  async reserveEpisodeCharge({ ruleId, now, graceSeconds, amountDollars }) {
    return this.#withWrite(() => {
      const episode = this.#activeEpisode(ruleId);
      if (!episode) return { kind: "no_episode", episode: null };
      const elapsedMs = Math.max(0, Date.parse(now) - Date.parse(episode.startedAt));
      // The stored snapshot, not caller-provided values, governs an existing episode.
      if (elapsedMs < episode.graceSeconds * 1_000) return { kind: "preview", episode };
      if (episode.charge?.state === "complete") return { kind: "complete", episode };
      if (!episode.charge) {
        episode.charge = {
          state: "pending",
          idempotencyKey: `end-itt:${episode.id}:stage-2`,
          amountDollars: episode.amountDollars,
          reservedAt: now,
        };
      }
      // A pending reservation can only be resumed with exactly the same persisted key and amount.
      return { kind: "charge", episode };
    });
  }

  async completeEpisodeCharge({ episodeId, idempotencyKey, outcome, completedAt }) {
    return this.#withWrite(() => {
      const episode = this.#state.episodes.find((item) => item.id === episodeId);
      if (!episode || episode.charge?.idempotencyKey !== idempotencyKey) return null;
      episode.charge = {
        ...episode.charge,
        state: "complete",
        status: outcome.status,
        paymentId: outcome.paymentId ?? null,
        message: outcome.message ?? null,
        completedAt,
      };
      return episode;
    });
  }

  #activeEpisode(ruleId) {
    for (let index = this.#state.episodes.length - 1; index >= 0; index -= 1) {
      const episode = this.#state.episodes[index];
      if (episode.ruleId === ruleId && episode.active) return episode;
    }
    return null;
  }

  #endActiveEpisodes(ruleId, endedAt, reason) {
    for (const episode of this.#state.episodes) {
      if (episode.ruleId === ruleId && episode.active) {
        episode.active = false;
        episode.endedAt = endedAt;
        episode.endedReason = reason;
      }
    }
  }

  async #withWrite(change) {
    const run = this.#queue.then(async () => {
      await this.init();
      const result = change();
      await this.#write();
      return clone(result);
    });
    this.#queue = run.catch(() => {});
    return run;
  }

  async #write() {
    const temporaryPath = `${this.#filePath}.${process.pid}.${Date.now()}.tmp`;
    await writeFile(temporaryPath, `${JSON.stringify(this.#state, null, 2)}\n`, {
      encoding: "utf8",
      mode: 0o600,
    });
    await rename(temporaryPath, this.#filePath);
  }
}
