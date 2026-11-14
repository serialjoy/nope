import { HttpError } from "./errors.mjs";
import { requiredText, validateRuleDraft } from "./validation.mjs";

const WORD_NUMBERS = new Map([
  ["zero", 0], ["one", 1], ["two", 2], ["three", 3], ["four", 4], ["five", 5],
  ["six", 6], ["seven", 7], ["eight", 8], ["nine", 9], ["ten", 10], ["eleven", 11],
  ["twelve", 12], ["thirteen", 13], ["fourteen", 14], ["fifteen", 15], ["sixteen", 16],
  ["seventeen", 17], ["eighteen", 18], ["nineteen", 19], ["twenty", 20], ["thirty", 30],
  ["forty", 40], ["fifty", 50], ["sixty", 60], ["half", 0.5],
]);

const TIME_PATTERN = /\b(?:after|in|for)\s+((?:\d+(?:\.\d+)?)|(?:[a-z]+(?:[-\s][a-z]+)?))\s*(seconds?|secs?|minutes?|mins?|hours?|hrs?)\b/gi;
const CONTACT_PATTERN = /\b(call|text|message|contact|accountability partner|my partner|my friend|a friend|someone)\b/i;
const MONEY_PATTERN = /(?:[$£€]\s*\d|\b(?:pay|charge|donate|money|dollars?|bucks?|financial)\b)/i;
const COMMITMENT_PATTERN = /\b(?:commitment|commit|pay|charge|donate|money|dollars?|bucks?|financial)\b/i;
const CHECK_IN_PATTERN = /\bcheck[\s-]?in\b/i;

function compact(text) {
  return text.replace(/\s+/g, " ").trim();
}

function durationValue(text) {
  if (/^\d+(?:\.\d+)?$/.test(text)) return Number(text);
  return text.toLowerCase().split(/[\s-]+/).reduce((total, word) => {
    const value = WORD_NUMBERS.get(word);
    return value === undefined ? Number.NaN : total + value;
  }, 0);
}

function durationMinutes(value, unit) {
  if (!Number.isFinite(value) || value < 0) return null;
  const normalized = unit.toLowerCase();
  if (normalized.startsWith("hour") || normalized.startsWith("hr")) return Math.ceil(value * 60);
  if (normalized.startsWith("second") || normalized.startsWith("sec")) return Math.ceil(value / 60);
  return Math.ceil(value);
}

function clauseAround(text, index, nextIndex) {
  const beginning = Math.max(
    text.lastIndexOf(".", index - 1),
    text.lastIndexOf("!", index - 1),
    text.lastIndexOf("?", index - 1),
    text.lastIndexOf(";", index - 1),
  );
  const endingCandidates = [
    text.indexOf(".", index),
    text.indexOf("!", index),
    text.indexOf("?", index),
    text.indexOf(";", index),
  ].filter((position) => position !== -1);
  const sentenceEnd = endingCandidates.length ? Math.min(...endingCandidates) + 1 : text.length;
  const ending = nextIndex === undefined ? sentenceEnd : Math.min(nextIndex, sentenceEnd);
  return compact(text.slice(beginning + 1, ending).replace(/,?\s*(?:then|and)?\s*$/, ""));
}

function findAmount(text) {
  const symbol = text.match(/[$£€]\s*(\d+(?:\.\d+)?)/);
  if (symbol) return Number(symbol[1]);
  const words = text.match(/\b(\d+(?:\.\d+)?)\s*(?:dollars?|bucks?)\b/i);
  return words ? Number(words[1]) : null;
}

function findContact(text) {
  if (/\baccountability partner\b/i.test(text)) return "accountability partner";
  const match = text.match(/\b(?:call|text|message|contact)\s+(?:my\s+)?([^.,;!?]{1,120})/i);
  return match ? compact(match[1]).replace(/\b(?:please|again)$/i, "").trim() || null : null;
}

function actionKind(text) {
  if (CONTACT_PATTERN.test(text)) return "contact";
  if (COMMITMENT_PATTERN.test(text)) return "commitment";
  if (CHECK_IN_PATTERN.test(text)) return "check_in";
  return "notification";
}

export function containsContactLanguage(text) {
  return CONTACT_PATTERN.test(text);
}

export function containsMoneyLanguage(text) {
  return MONEY_PATTERN.test(text);
}

export function extractTimedActions(responsePlan) {
  const text = requiredText(responsePlan, "responsePlan");
  const actions = [];
  const seenDelays = new Set();
  TIME_PATTERN.lastIndex = 0;
  const matches = [];
  let match;
  while ((match = TIME_PATTERN.exec(text))) {
    matches.push({ index: match.index, value: match[1], unit: match[2] });
  }
  for (let index = 0; index < matches.length; index += 1) {
    const current = matches[index];
    const afterMinutes = durationMinutes(durationValue(current.value), current.unit);
    if (!Number.isInteger(afterMinutes) || afterMinutes <= 0 || afterMinutes > 10_080 || seenDelays.has(afterMinutes)) {
      continue;
    }
    const description = clauseAround(text, current.index, matches[index + 1]?.index);
    if (!description) continue;
    const kind = actionKind(description);
    actions.push({
      kind,
      afterMinutes,
      description,
      amount: kind === "commitment" ? findAmount(description) : null,
      contact: kind === "contact" ? findContact(description) : null,
    });
    seenDelays.add(afterMinutes);
  }
  return actions.sort((left, right) => left.afterMinutes - right.afterMinutes);
}

function draftTitle(description) {
  const words = compact(description).replace(/[.!?].*$/, "").slice(0, 80);
  return `Draft: ${words || "your habit"}`;
}

function initialNotification() {
  return {
    kind: "notification",
    afterMinutes: 0,
    description: "A quiet phone notification: pause and choose what you want to do next.",
    amount: null,
    contact: null,
  };
}

export function buildDemoPlan({ description, clarification, responsePlan }) {
  const behavior = requiredText(description, "description");
  const trigger = requiredText(clarification, "clarification");
  const sourcePlan = requiredText(responsePlan, "responsePlan");
  const steps = [initialNotification(), ...extractTimedActions(sourcePlan).slice(0, 3)];
  return validateRuleDraft({
    title: draftTitle(behavior),
    behavior,
    trigger,
    responsePlan: sourcePlan,
    steps,
  });
}

export function buildDemoClarification(description) {
  const text = requiredText(description, "description");
  const lower = text.toLowerCase();
  if (lower.includes("night") || lower.includes("bed")) {
    return {
      question: "What would make this feel like a good stopping point at night?",
      suggestions: ["When I get into bed", "After 10 minutes", "When I need sleep"],
    };
  }
  if (lower.includes("vaping") || lower.includes("smok")) {
    return {
      question: "When would you most want a pause before this habit starts?",
      suggestions: ["When I feel stressed", "Before I reach for it", "During a break"],
    };
  }
  return {
    question: "What usually happens right before you want support?",
    suggestions: ["When I feel stressed", "When I am bored", "At a certain time"],
  };
}

function validModelTitle(value) {
  return typeof value === "string" && value.trim() && value.trim().length <= 160
    ? value.trim()
    : null;
}

export function planFromGemini(output, input) {
  if (!output || typeof output !== "object" || Array.isArray(output)) {
    throw new HttpError(502, "Gemini returned an unusable plan. Please try again.");
  }
  const title = validModelTitle(output.title);
  if (!title || !Array.isArray(output.steps)) {
    throw new HttpError(502, "Gemini returned an unusable plan. Please try again.");
  }
  const sourceText = `${input.description}\n${input.clarification}\n${input.responsePlan}`;
  let rule;
  try {
    rule = validateRuleDraft({
      title,
      behavior: input.description,
      trigger: input.clarification,
      responsePlan: input.responsePlan,
      steps: output.steps,
    });
  } catch {
    throw new HttpError(502, "Gemini returned an unusable plan. Please try again.");
  }
  for (const step of rule.steps) {
    if ((step.kind === "contact" || step.contact !== null) && !containsContactLanguage(sourceText)) {
      throw new HttpError(502, "Gemini returned a contact step that was not in your plan. Please try again.");
    }
    if ((step.kind === "commitment" || step.amount !== null) && !containsMoneyLanguage(sourceText)) {
      throw new HttpError(502, "Gemini returned a financial step that was not in your plan. Please try again.");
    }
  }
  return rule;
}

export function clarificationFromGemini(output) {
  if (!output || typeof output !== "object" || Array.isArray(output)) {
    throw new HttpError(502, "Gemini returned an unusable question. Please try again.");
  }
  const question = typeof output.question === "string" ? output.question.trim() : "";
  const suggestions = Array.isArray(output.suggestions)
    ? output.suggestions.filter((item) => typeof item === "string").map((item) => item.trim()).filter(Boolean).slice(0, 4)
    : [];
  if (!question || question.length > 600 || !suggestions.length) {
    throw new HttpError(502, "Gemini returned an unusable question. Please try again.");
  }
  return { question, suggestions };
}
