import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";

export const MAX_RECORDINGS = 100;

const EMPTY_STATE = Object.freeze({ recordings: [] });
const TRANSITIONS = Object.freeze({
  requested: new Set(["recording", "cancelled"]),
  recording: new Set(["recorded", "cancelled"]),
  recorded: new Set(),
  cancelled: new Set(),
});

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function sameCompletionMetadata(recording, change) {
  return recording.recordingRef === change.recordingRef
    && recording.sampleCount === change.sampleCount;
}

/**
 * Stores request metadata only. The separate detector/recorder owns all raw
 * captures and training artifacts referenced by an opaque recordingRef.
 */
export class RecordingsStore {
  #dataDirectory;
  #filePath;
  #state = null;
  #initializing = null;
  #queue = Promise.resolve();

  constructor(dataDirectory) {
    this.#dataDirectory = dataDirectory;
    this.#filePath = path.join(dataDirectory, "recordings.json");
  }

  async init() {
    if (this.#state) return;
    if (!this.#initializing) {
      this.#initializing = (async () => {
        await mkdir(this.#dataDirectory, { recursive: true });
        try {
          const parsed = JSON.parse(await readFile(this.#filePath, "utf8"));
          if (!parsed || !Array.isArray(parsed.recordings)) throw new Error("invalid state");
          this.#state = { recordings: parsed.recordings };
        } catch (error) {
          if (error?.code === "ENOENT") {
            this.#state = clone(EMPTY_STATE);
            return;
          }
          throw new Error("Could not read saved recording requests.");
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
    return clone(this.#state.recordings);
  }

  async get(id) {
    await this.init();
    const recording = this.#state.recordings.find((item) => item.id === id);
    return recording ? clone(recording) : null;
  }

  async create(recording) {
    return this.#withWrite((state) => {
      if (state.recordings.length >= MAX_RECORDINGS) return null;
      const saved = clone(recording);
      state.recordings.push(saved);
      return saved;
    });
  }

  async transition(id, change) {
    return this.#withWrite((state) => {
      const index = state.recordings.findIndex((recording) => recording.id === id);
      if (index === -1) return { kind: "missing", recording: null };

      const current = state.recordings[index];
      if (current.status === change.status) {
        return sameCompletionMetadata(current, change)
          ? { kind: "idempotent", recording: current }
          : { kind: "conflict", recording: current };
      }
      if (!TRANSITIONS[current.status]?.has(change.status)) {
        return { kind: "conflict", recording: current };
      }

      const next = {
        id: current.id,
        description: current.description,
        behaviorId: current.behaviorId,
        bandNumber: current.bandNumber,
        durationSeconds: current.durationSeconds,
        status: change.status,
        createdAt: current.createdAt,
        updatedAt: change.updatedAt,
        recordingRef: change.recordingRef,
        sampleCount: change.sampleCount,
      };
      state.recordings[index] = next;
      return { kind: "updated", recording: next };
    });
  }

  async #withWrite(change) {
    const run = this.#queue.then(async () => {
      await this.init();
      // Draft first so a failed write leaves the committed in-memory snapshot unchanged.
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
    const temporaryPath = `${this.#filePath}.${process.pid}.${Date.now()}.tmp`;
    await writeFile(temporaryPath, `${JSON.stringify(state, null, 2)}\n`, {
      encoding: "utf8",
      mode: 0o600,
    });
    await rename(temporaryPath, this.#filePath);
  }
}
