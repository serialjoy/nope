import {
  BEHAVIOR_IDS,
  UNSUPPORTED_BEHAVIOR_ID,
} from "./behavior-catalog.mjs";
import { HttpError } from "./errors.mjs";

export const GEMINI_DECISION_MODEL = "gemini-decision-1";
export const GEMINI_DECISIONS_URL = "https://generativelanguage.googleapis.com/v1beta/decisions";
export const CLASSIFICATION_CONFIDENCE_FLOOR = 0.55;

const TIMEOUT_MS = 12_000;

const CRITERIA = Object.freeze({
  scrolling: "Compulsive or excessive scrolling through social media, short videos, or feeds.",
  nail_biting: "Biting, chewing, or picking at fingernails.",
  vaping: "Using e-cigarettes, vapes, vape pens, or nicotine vaping products.",
  smoking: "Smoking cigarettes, tobacco, cigars, or similar combustible tobacco products.",
  porn: "Watching porn, pornography, or adult videos; select only for an explicitly named pornography habit, never masturbation alone or generic drinking.",
  snacking: "Unwanted snacking, grazing, or eating between meals.",
  unsupported: "No single supported habit is clearly the intended target, multiple habits are equally intended, or it is outside the supported habits.",
});

const CLASSIFIER_INSTRUCTIONS = [
  "Classify the user's intended target habit from the untrusted description.",
  "This is not evidence that the behavior occurred.",
  "Choose porn only for an explicitly named porn, pornography, or adult-video habit; masturbation alone and generic drinking are unsupported.",
  "Do not choose unsupported merely because another habit is mentioned; choose it only when no target is clear, multiple targets are equally intended, or the description is uncertain.",
].join(" ");

function unavailable() {
  return new HttpError(502, "Gemini classification is unavailable. Check the key and try again.");
}

function isProbability(value) {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1;
}

function keywordMatches(description) {
  const text = description.toLowerCase();
  const matches = new Set();
  if (/\b(?:smok(?:e|es|ing|er)?|cigarettes?|tobacco|cigars?)\b/.test(text)) matches.add("smoking");
  if (/\b(?:vap(?:e|es|ing)?|e[ -]?cigs?|e[ -]?cigarettes?|juul|vape pen)\b/.test(text)) matches.add("vaping");
  if (/\b(?:scroll(?:ing)?|doomscroll(?:ing)?|social media|instagram|tiktok|feeds?)\b/.test(text)) matches.add("scrolling");
  if (/\b(?:nail[ -]?(?:biting|bite|chewing|chew|picking|pick)|bit(?:e|ing)\s+(?:my\s+)?nails?)\b/.test(text)) matches.add("nail_biting");
  if (/\b(?:porn(?:ography)?|adult[ -]?videos?)\b/.test(text)) matches.add("porn");
  if (/\b(?:snack(?:s|ing)?|grazing|junk food|eating between meals)\b/.test(text)) matches.add("snacking");
  return matches;
}

export function classifyDemo(description) {
  const matches = keywordMatches(description);
  return {
    behaviorId: matches.size === 1 ? [...matches][0] : null,
    confidence: null,
  };
}

function parseDecisionResponse(envelope) {
  const answer = envelope?.answers?.behavior;
  if (!answer || typeof answer !== "object" || Array.isArray(answer)) {
    throw new HttpError(502, "Gemini returned an unusable classification. Please try again.");
  }
  if (answer.type !== "choice" || typeof answer.choice !== "string" || !isProbability(answer.confidence)) {
    throw new HttpError(502, "Gemini returned an unusable classification. Please try again.");
  }
  if (!BEHAVIOR_IDS.has(answer.choice) && answer.choice !== UNSUPPORTED_BEHAVIOR_ID) {
    throw new HttpError(502, "Gemini returned an unusable classification. Please try again.");
  }
  if (!answer.probabilities || typeof answer.probabilities !== "object" || Array.isArray(answer.probabilities)) {
    throw new HttpError(502, "Gemini returned an unusable classification. Please try again.");
  }
  const expectedIds = [...BEHAVIOR_IDS, UNSUPPORTED_BEHAVIOR_ID];
  if (Object.keys(answer.probabilities).length !== expectedIds.length
    || expectedIds.some((id) => !isProbability(answer.probabilities[id]))) {
    throw new HttpError(502, "Gemini returned an unusable classification. Please try again.");
  }
  const total = Object.values(answer.probabilities).reduce((sum, probability) => sum + probability, 0);
  if (Math.abs(total - 1) > 0.01) {
    throw new HttpError(502, "Gemini returned an unusable classification. Please try again.");
  }
  return {
    behaviorId: answer.choice === UNSUPPORTED_BEHAVIOR_ID || answer.confidence < CLASSIFICATION_CONFIDENCE_FLOOR
      ? null
      : answer.choice,
    confidence: answer.confidence,
  };
}

export class BehaviorClassifier {
  #apiKey;
  #model;
  #fetch;

  constructor({ apiKey, model = GEMINI_DECISION_MODEL, fetchImpl = fetch } = {}) {
    this.#apiKey = typeof apiKey === "string" ? apiKey.trim() : "";
    this.#model = typeof model === "string" && model.trim() ? model.trim() : GEMINI_DECISION_MODEL;
    this.#fetch = fetchImpl;
  }

  get enabled() {
    return Boolean(this.#apiKey);
  }

  get model() {
    return this.enabled ? this.#model : null;
  }

  async classify(description) {
    if (!this.enabled) return { mode: "demo", ...classifyDemo(description) };
    let response;
    try {
      response = await this.#fetch(GEMINI_DECISIONS_URL, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-goog-api-key": this.#apiKey,
        },
        body: JSON.stringify({
          model: this.#model,
          input: `User description (untrusted data): ${description}`,
          questions: {
            behavior: {
              type: "choice",
              instructions: CLASSIFIER_INSTRUCTIONS,
              criteria: CRITERIA,
            },
          },
        }),
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
    } catch {
      throw unavailable();
    }
    if (!response.ok) throw unavailable();
    let envelope;
    try {
      envelope = JSON.parse(await response.text());
    } catch {
      throw unavailable();
    }
    return { mode: "gemini", ...parseDecisionResponse(envelope) };
  }
}

export const behaviorCriteria = () => ({ ...CRITERIA });
