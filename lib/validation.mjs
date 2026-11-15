import { HttpError } from "./errors.mjs";
import { behaviorById, isBehaviorId } from "./behavior-catalog.mjs";

export const MAX_TEXT_LENGTH = 4_000;
export const STEP_KINDS = new Set(["notification", "check_in", "contact", "commitment"]);
export const PENALTY_AMOUNTS = Object.freeze([1, 5, 10]);
export const GRACE_SECONDS = 60;

export function requiredText(value, field, maxLength = MAX_TEXT_LENGTH) {
  if (typeof value !== "string") throw new HttpError(400, `${field} must be text.`);
  const text = value.trim();
  if (!text) throw new HttpError(400, `${field} is required.`);
  if (text.length > maxLength) throw new HttpError(400, `${field} is too long.`);
  return text;
}

export function optionalText(value, field, maxLength = MAX_TEXT_LENGTH) {
  if (value === null || value === undefined || value === "") return null;
  return requiredText(value, field, maxLength);
}

function own(object, key) {
  return Object.prototype.hasOwnProperty.call(object, key);
}

export function requireObject(value, message = "Request body must be a JSON object.") {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new HttpError(400, message);
  }
  return value;
}

export function validateStep(value, index) {
  const step = requireObject(value, `Step ${index + 1} must be an object.`);
  if (!STEP_KINDS.has(step.kind)) {
    throw new HttpError(400, `Step ${index + 1} has an unsupported kind.`);
  }
  if (!Number.isInteger(step.afterMinutes) || step.afterMinutes < 0 || step.afterMinutes > 10_080) {
    throw new HttpError(400, `Step ${index + 1} needs a delay from 0 to 10080 minutes.`);
  }
  const amount = step.amount === null || step.amount === undefined ? null : step.amount;
  if (amount !== null && (!Number.isFinite(amount) || amount < 0 || amount > 1_000_000)) {
    throw new HttpError(400, `Step ${index + 1} has an invalid amount.`);
  }
  const contact = optionalText(step.contact, `Step ${index + 1} contact`, 240);
  if (step.kind !== "commitment" && amount !== null) {
    throw new HttpError(400, "Only a commitment step can include an amount.");
  }
  if (step.kind !== "contact" && contact !== null) {
    throw new HttpError(400, "Only a contact step can include a contact.");
  }
  return {
    kind: step.kind,
    afterMinutes: step.afterMinutes,
    description: requiredText(step.description, `Step ${index + 1} description`, 600),
    amount,
    contact,
  };
}

export function validateRuleDraft(value) {
  const rule = requireObject(value, "Rule must be a JSON object.");
  const steps = rule.steps;
  if (!Array.isArray(steps) || steps.length < 1 || steps.length > 4) {
    throw new HttpError(400, "A rule needs between 1 and 4 response steps.");
  }
  const checkedSteps = steps.map(validateStep);
  if (checkedSteps[0].kind !== "notification" || checkedSteps[0].afterMinutes !== 0) {
    throw new HttpError(400, "The first response must be a notification at 0 minutes.");
  }
  for (let index = 1; index < checkedSteps.length; index += 1) {
    if (checkedSteps[index].afterMinutes <= checkedSteps[index - 1].afterMinutes) {
      throw new HttpError(400, "Response step delays must increase.");
    }
  }
  return {
    title: requiredText(rule.title, "title", 160),
    behavior: requiredText(rule.behavior, "behavior"),
    trigger: requiredText(rule.trigger, "trigger"),
    responsePlan: requiredText(rule.responsePlan, "responsePlan"),
    steps: checkedSteps,
  };
}

export function isCompactRulePayload(value) {
  return Boolean(value && typeof value === "object" && !Array.isArray(value)
    && ["description", "behaviorId", "penaltyAmount"].some((key) => own(value, key)));
}

export function validateCompactRuleDraft(value) {
  const rule = requireObject(value, "Rule must be a JSON object.");
  const description = requiredText(rule.description, "description");
  if (!isBehaviorId(rule.behaviorId)) {
    throw new HttpError(400, "behaviorId must be one of the supported habits.");
  }
  if (!Number.isInteger(rule.penaltyAmount) || !PENALTY_AMOUNTS.includes(rule.penaltyAmount)) {
    throw new HttpError(400, "penaltyAmount must be $1, $5, or $10.");
  }
  return { description, behaviorId: rule.behaviorId, penaltyAmount: rule.penaltyAmount };
}

export function validateCompactRulePatch(value) {
  const patch = requireObject(value);
  const allowed = new Set(["enabled", "description", "behaviorId", "penaltyAmount"]);
  const keys = Object.keys(patch);
  if (!keys.length || keys.some((key) => !allowed.has(key))) {
    throw new HttpError(400, "Only enabled or compact rule content can be updated.");
  }
  const hasCompactContent = ["description", "behaviorId", "penaltyAmount"].some((key) => own(patch, key));
  if (!hasCompactContent) {
    if (typeof patch.enabled !== "boolean") throw new HttpError(400, "enabled must be true or false.");
    return { enabled: patch.enabled, draft: null };
  }
  if (!["description", "behaviorId", "penaltyAmount"].every((key) => own(patch, key))) {
    throw new HttpError(400, "description, behaviorId, and penaltyAmount must be updated together.");
  }
  const draft = validateCompactRuleDraft(patch);
  if (own(patch, "enabled") && typeof patch.enabled !== "boolean") {
    throw new HttpError(400, "enabled must be true or false.");
  }
  return { enabled: own(patch, "enabled") ? patch.enabled : undefined, draft };
}

export function buildCompactRule(draft, identity = {}) {
  const compact = validateCompactRuleDraft(draft);
  const behavior = behaviorById(compact.behaviorId);
  const amount = compact.penaltyAmount;
  return {
    ...identity,
    schemaVersion: 2,
    description: compact.description,
    behaviorId: compact.behaviorId,
    penaltyAmount: amount,
    currency: "usd",
    graceSeconds: GRACE_SECONDS,
    // Keep legacy readers working while the compact fields are the source of truth.
    title: behavior.label,
    behavior: behavior.label,
    trigger: `Friend detector reports ${behavior.ongoingLabel.toLowerCase()}.`,
    responsePlan: `First time, a nudge. Next distinct occurrence, a $${amount} test penalty.`,
    steps: [
      {
        kind: "notification",
        afterMinutes: 0,
        description: "A friendly nudge",
        amount: null,
        contact: null,
      },
      {
        kind: "commitment",
        afterMinutes: 1,
        description: "Put your money on a repeat",
        amount,
        contact: null,
      },
    ],
  };
}

export function isCompactRule(rule) {
  return Boolean(rule && rule.schemaVersion === 2
    && typeof rule.description === "string"
    && isBehaviorId(rule.behaviorId)
    && Number.isInteger(rule.penaltyAmount)
    && PENALTY_AMOUNTS.includes(rule.penaltyAmount)
    && rule.currency === "usd"
    && rule.graceSeconds === GRACE_SECONDS
    && Array.isArray(rule.steps)
    && rule.steps.length === 2
    && rule.steps[0]?.kind === "notification"
    && rule.steps[0]?.afterMinutes === 0
    && rule.steps[1]?.kind === "commitment"
    && rule.steps[1]?.afterMinutes === 1
    && rule.steps[1]?.amount === rule.penaltyAmount);
}

export function validateRulePatch(value) {
  const patch = requireObject(value);
  const allowed = new Set(["enabled", "title", "behavior", "trigger", "responsePlan", "steps"]);
  const keys = Object.keys(patch);
  if (!keys.length || keys.some((key) => !allowed.has(key))) {
    throw new HttpError(400, "Only enabled or reviewed rule content can be updated.");
  }
  const checked = {};
  if (own(patch, "enabled")) {
    if (typeof patch.enabled !== "boolean") throw new HttpError(400, "enabled must be true or false.");
    checked.enabled = patch.enabled;
  }
  for (const field of ["title", "behavior", "trigger", "responsePlan"]) {
    if (own(patch, field)) checked[field] = requiredText(patch[field], field, field === "title" ? 160 : MAX_TEXT_LENGTH);
  }
  if (own(patch, "steps")) {
    if (!Array.isArray(patch.steps)) throw new HttpError(400, "steps must be an array.");
    checked.steps = validateRuleDraft({
      title: "Review",
      behavior: "Review",
      trigger: "Review",
      responsePlan: "Review",
      steps: patch.steps,
    }).steps;
  }
  return checked;
}

export function validateDetectorEvent(value, bandNumber) {
  const event = requireObject(value);
  if (event.bandNumber !== bandNumber) {
    throw new HttpError(400, `This server only accepts events for band ${bandNumber}.`);
  }
  const phase = requiredText(event.phase, "phase", 20);
  if (!["started", "continued", "stopped"].includes(phase)) {
    throw new HttpError(400, "phase must be started, continued, or stopped.");
  }
  const occurredAt = event.occurredAt === undefined
    ? new Date().toISOString()
    : validTimestamp(event.occurredAt);
  const occurrenceId = own(event, "occurrenceId")
    ? requiredText(event.occurrenceId, "occurrenceId", 160)
    : null;
  return {
    bandNumber,
    ruleId: requiredText(event.ruleId, "ruleId", 160),
    eventId: requiredText(event.eventId, "eventId", 160),
    phase,
    occurrenceId,
    occurredAt,
    source: "detector",
  };
}

export function validateDetectorStop(value) {
  const body = requireObject(value);
  const allowed = new Set(["episodeId", "reason"]);
  const keys = Object.keys(body);
  if (keys.some((key) => !allowed.has(key))) {
    throw new HttpError(400, "Only episodeId and reason can end a detector occurrence.");
  }
  const reason = own(body, "reason") ? body.reason : "stopped";
  if (reason !== "stopped" && reason !== "false_alarm") {
    throw new HttpError(400, "reason must be stopped or false_alarm.");
  }
  return {
    episodeId: own(body, "episodeId") ? requiredText(body.episodeId, "episodeId", 160) : null,
    reason,
  };
}

function validTimestamp(value) {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}T/.test(value) || Number.isNaN(Date.parse(value))) {
    throw new HttpError(400, "occurredAt must be an ISO timestamp.");
  }
  return new Date(value).toISOString();
}
