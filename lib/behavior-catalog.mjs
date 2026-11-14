export const BEHAVIORS = Object.freeze([
  Object.freeze({ id: "scrolling", label: "Doom-scroll", ongoingLabel: "Still doom-scrolling" }),
  Object.freeze({ id: "nail_biting", label: "Nail biting", ongoingLabel: "Still biting your nails" }),
  Object.freeze({ id: "vaping", label: "Vaping", ongoingLabel: "Still vaping" }),
  Object.freeze({ id: "smoking", label: "Smoking", ongoingLabel: "Still smoking" }),
  Object.freeze({ id: "porn", label: "Porn", ongoingLabel: "Still watching porn" }),
  Object.freeze({ id: "snacking", label: "Snacks", ongoingLabel: "Still snacking" }),
]);

export const BEHAVIOR_IDS = new Set(BEHAVIORS.map(({ id }) => id));

export const UNSUPPORTED_BEHAVIOR_ID = "unsupported";

export function isBehaviorId(value) {
  return typeof value === "string" && BEHAVIOR_IDS.has(value);
}

export function behaviorById(id) {
  return BEHAVIORS.find((behavior) => behavior.id === id) ?? null;
}
