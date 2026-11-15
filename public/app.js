const root = document.querySelector("#app");
const helpDialog = document.querySelector("#help-dialog");
const helpClose = document.querySelector("#help-close");
const helpDone = document.querySelector("#help-done");

const activityStorageKey = "end-itt-activity";
const redirectDraftKey = "end-itt-stripe-draft";
const teachHashPrefix = "#teach=";
const recordingPollIntervalMs = 5000;
let lastRenderedRoute = null;
let recordingPollTimer = null;
let recordingPollInFlight = false;
let recordingRequestVersion = 0;

const fallbackBehaviors = [
  { id: "scrolling", label: "Doom-scroll", ongoingLabel: "Still doom-scrolling" },
  { id: "nail_biting", label: "Nail biting", ongoingLabel: "Still biting your nails" },
  { id: "vaping", label: "Vaping", ongoingLabel: "Still vaping" },
  { id: "smoking", label: "Smoking", ongoingLabel: "Still smoking" },
  { id: "porn", label: "Porn", ongoingLabel: "Still watching porn" },
  { id: "snacking", label: "Snacks", ongoingLabel: "Still snacking" },
];

const starters = [
  { id: "scrolling", label: "Doom-scroll", tone: "cyan", icon: "scroll", text: "I want to stop doom-scrolling at night." },
  { id: "nail_biting", label: "Nail biting", tone: "lilac", icon: "hand", text: "I want to stop biting my nails." },
  { id: "vaping", label: "Vaping", tone: "green", icon: "cloud", text: "I want to stop vaping." },
  { id: "smoking", label: "Smoking", tone: "yellow", icon: "smoke", text: "I want to stop smoking." },
  { id: "porn", label: "Porn", tone: "lilac", icon: "screen", text: "I want to stop watching porn." },
  { id: "snacking", label: "Snacks", tone: "green", icon: "apple", text: "I want to stop snacking." },
];

const state = {
  route: "home",
  config: null,
  configError: "",
  rules: [],
  rulesError: "",
  recordings: [],
  recordingsError: "",
  recordingsLoaded: false,
  selectedRecordingId: null,
  activity: readActivity(),
  draft: emptyDraft(),
  showCategoryPicker: false,
  editingRuleId: null,
  selectedRuleId: null,
  preview: null,
  deleteRuleId: null,
  inboundRuleId: null,
  busy: "",
  error: null,
  flash: "",
  sseStatus: "checking",
  eventSource: null,
  seenEvents: new Set(),
  acknowledgedDetectorEpisodes: new Set(),
};

restoreRedirectDraftIfNeeded();
restoreTeachRequestIfNeeded();

function emptyDraft() {
  return {
    description: "",
    behaviorId: null,
    penaltyAmount: 5,
    matchMode: null,
    confidence: null,
    legacy: false,
  };
}

function icon(name) {
  const shapes = {
    arrow: '<path d="M5 12h14"/><path d="m13 6 6 6-6 6"/>',
    back: '<path d="M19 12H5"/><path d="m11 18-6-6 6-6"/>',
    close: '<path d="m6 6 12 12M18 6 6 18"/>',
    plus: '<path d="M12 5v14M5 12h14"/>',
    help: '<circle cx="12" cy="12" r="8.5"/><path d="M9.7 9.3a2.6 2.6 0 0 1 5 1.1c0 1.9-2.7 2-2.7 3.7"/><path d="M12 17.1h.01"/>',
    home: '<path d="m4 11 8-6 8 6v8a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1z"/><path d="M9 20v-5h6v5"/>',
    rules: '<path d="M7 4h11a2 2 0 0 1 2 2v13a1 1 0 0 1-1.5.86L15 18l-3.5 1.86A1 1 0 0 1 10 19V6a2 2 0 0 0-2-2Z"/><path d="M6 5H5a2 2 0 0 0-2 2v12a1 1 0 0 0 1.5.86L8 18"/>',
    activity: '<path d="M4 12h3l2-6 4 12 2-6h5"/>',
    scroll: '<rect x="7" y="3" width="10" height="18" rx="2"/><path d="M10 7h4M10 17h4M12 10v4"/>',
    hand: '<path d="M8.5 12V7.5a1.5 1.5 0 0 1 3 0V11"/><path d="M11.5 10V5.5a1.5 1.5 0 0 1 3 0V11"/><path d="M14.5 10V7a1.5 1.5 0 0 1 3 0v6.2c0 4.1-2.5 6.8-6.2 6.8-2.3 0-4.1-1.2-5.1-3.2L4.7 14a1.5 1.5 0 0 1 2.5-1.6Z"/>',
    cloud: '<path d="M7.5 18h8.2a4.3 4.3 0 0 0 .7-8.5 5.4 5.4 0 0 0-10.2 1.7A3.5 3.5 0 0 0 7.5 18Z"/><path d="M10 9.5c.7.6 1 1.3 1 2.2M13 8.5c1.1.9 1.6 2 1.6 3.4"/>',
    smoke: '<path d="M6 19c0-2.8 3-2.8 3-5.6S6 10.6 6 8"/><path d="M12 19c0-2.8 3-2.8 3-5.6S12 10.6 12 8"/><path d="M18 17c0-1.8 1.5-1.8 1.5-3.6S18 11.6 18 10"/>',
    screen: '<rect x="3.5" y="5" width="17" height="13" rx="2"/><path d="m10 8.5 5 3.1-5 3.1Z"/><path d="M9 21h6"/>',
    apple: '<path d="M12 7.2c-1.7-1.6-4.7-1.1-6 1.4-1.6 3.2.5 9.3 6 11.4 5.5-2.1 7.6-8.2 6-11.4-1.3-2.5-4.3-3-6-1.4Z"/><path d="M12 7.2c0-2 .9-3.4 2.7-4.3"/><path d="M12.8 4c1.4-1.1 3.1-1.1 4.2-.4"/>',
    bell: '<path d="M18 9a6 6 0 0 0-12 0c0 7-3 7-3 9h18c0-2-3-2-3-9"/><path d="M10 21h4"/>',
    card: '<rect x="3.5" y="6" width="17" height="12" rx="2"/><path d="M3.5 10h17M7 15h3"/>',
    check: '<path d="M5 12.5 9.5 17 19 7"/>',
    person: '<circle cx="12" cy="8" r="3.2"/><path d="M5.5 20c.7-3.3 3-5 6.5-5s5.8 1.7 6.5 5"/>',
    edit: '<path d="m4 20 4.1-.9L19 8.2a2.1 2.1 0 0 0-3-3L5.1 16.1z"/><path d="m14.5 6.5 3 3"/>',
    trash: '<path d="M4 7h16M9 7V4h6v3M7 7l1 13h8l1-13"/>',
    phone: '<rect x="7" y="3" width="10" height="18" rx="2"/><path d="M10 6h4M11 18h2"/>',
    pause: '<path d="M8 5v14M16 5v14"/>',
    stop: '<rect x="5" y="5" width="14" height="14" rx="2"/>',
  };
  return `<svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">${shapes[name] || shapes.stop}</svg>`;
}

function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>'"]/g, (character) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;",
  })[character]);
}

function draftText(value) { return escapeHtml(value).replace(/\n/g, "<br>"); }
function nonEmpty(value) { return typeof value === "string" && value.trim() ? value.trim() : ""; }
function safeArray(value) { return Array.isArray(value) ? value : []; }
function messageFor(error) { return error instanceof Error && nonEmpty(error.message) ? error.message : "Something went wrong. Please try again."; }

function behaviors() {
  const source = safeArray(state.config?.behaviors);
  const valid = source.filter((behavior) => behavior && typeof behavior.id === "string" && typeof behavior.label === "string");
  return valid.length === 6 ? valid : fallbackBehaviors;
}

function behaviorById(id) { return behaviors().find((behavior) => behavior.id === id) || null; }
function labelForBehavior(id) { return behaviorById(id)?.label || "Choose the closest habit"; }
function ongoingLabel(id) { return behaviorById(id)?.ongoingLabel || "Still doing it"; }
function amounts() {
  const configured = safeArray(state.config?.penaltyAmounts).filter((amount) => [1, 5, 10].includes(amount));
  return configured.length ? configured : [1, 5, 10];
}
function selectedAmount() { return amounts().includes(state.draft.penaltyAmount) ? state.draft.penaltyAmount : (amounts().includes(5) ? 5 : amounts()[0]); }
function stripeStatus() {
  const stripe = state.config?.stripe;
  return {
    mode: stripe?.mode === "test" ? "test" : "demo",
    connected: Boolean(stripe?.connected),
    cardLabel: nonEmpty(stripe?.cardLabel) || null,
    message: nonEmpty(stripe?.message),
  };
}
function isVersionTwo(rule) { return Number(rule?.schemaVersion) === 2 && typeof rule?.description === "string"; }
function descriptionForRule(rule) { return nonEmpty(rule?.description) || nonEmpty(rule?.behavior) || "No description saved."; }
function titleForRule(rule) {
  if (isVersionTwo(rule)) return labelForBehavior(rule.behaviorId);
  return nonEmpty(rule?.title) || nonEmpty(rule?.behavior) || "Older rule";
}
function ruleAmount(rule) { return [1, 5, 10].includes(rule?.penaltyAmount) ? rule.penaltyAmount : null; }
function ruleMascotTone(rule) {
  const tones = { scrolling: "butter", nail_biting: "bubblegum", vaping: "forest", smoking: "tomato", porn: "bubblegum", snacking: "butter" };
  return tones[rule?.behaviorId] || "tomato";
}
function ruleById(id) { return state.rules.find((rule) => rule?.id === id) || null; }
function recordingById(id) { return state.recordings.find((recording) => recording?.id === id) || null; }
function recordingStatus(recording) { return ["requested", "recording", "recorded", "cancelled"].includes(recording?.status) ? recording.status : "requested"; }
function canCancelRecording(recording) { return ["requested", "recording"].includes(recordingStatus(recording)); }

function logoMarkup() {
  return '<span class="brand-lockup"><img class="brand-wordmark" src="/assets/nope-wordmark.svg" alt="Nope" width="132" height="48"></span>';
}

function bandStatusMarkup() {
  if (Number.isInteger(state.config?.bandNumber)) return `<span class="band-status">Band ${state.config.bandNumber} · Ready</span>`;
  return '<span class="band-status waiting">Band context checking</span>';
}

function screenTop(backAction) {
  return `<div class="screen-topbar">
    <button class="back-button quiet" type="button" data-action="${backAction}" aria-label="Go back">${icon("back")}</button>
    ${logoMarkup()}
    <button class="icon-button quiet" type="button" data-action="help" aria-label="Open help" data-testid="help-open">${icon("help")}</button>
  </div>`;
}

function shell(content) {
  const focusedSetup = state.route === "penalty";
  return `<div class="app-shell ${focusedSetup ? "setup-shell" : ""}">${renderInboundBanner()}${content}${focusedSetup ? "" : renderBottomNav()}</div>`;
}

function renderBottomNav() {
  const active = state.route === "teach" ? (state.selectedRecordingId ? "rules" : "home") : state.route === "home" || state.route === "penalty" ? "home" : state.route === "activity" ? "activity" : "rules";
  return `<nav class="bottom-nav" aria-label="Main navigation">
    <div class="nav-group">
      <button class="nav-link ${active === "home" ? "active" : ""}" type="button" data-action="home" aria-current="${active === "home" ? "page" : "false"}" aria-label="Home" data-testid="nav-home">${icon("home")}<span>Home</span></button>
      <button class="nav-link ${active === "rules" ? "active" : ""}" type="button" data-action="rules" aria-current="${active === "rules" ? "page" : "false"}" aria-label="My rules" data-testid="nav-rules">${icon("rules")}<span>Rules</span></button>
      <button class="nav-link ${active === "activity" ? "active" : ""}" type="button" data-action="activity" aria-current="${active === "activity" ? "page" : "false"}" aria-label="Activity" data-testid="nav-activity">${icon("activity")}<span>Activity</span></button>
    </div>
    <button class="nav-add" type="button" data-action="new-rule" aria-label="Add a new rule" data-testid="add-rule">${icon("plus")}</button>
  </nav>`;
}

function renderInboundBanner() {
  const rule = ruleById(state.inboundRuleId);
  if (!rule || state.route === "detail" && state.selectedRuleId === rule.id) return "";
  return `<aside class="inbound-banner" aria-label="New detector update"><span><strong>Detector update</strong> for ${escapeHtml(titleForRule(rule))}</span><button class="text-button" type="button" data-action="view-inbound">View</button></aside>`;
}

function renderHome() {
  return shell(`<section class="home-page" aria-labelledby="home-title">
    <div class="topbar">
      ${logoMarkup()}
      <div class="inline-row" style="gap:8px">${bandStatusMarkup()}<button class="icon-button quiet" type="button" data-action="help" aria-label="Open help" data-testid="help-open">${icon("help")}</button></div>
    </div>
    <div class="home-intro">
      <h1 class="display-title" id="home-title"><span class="home-headline-line">Not on</span><br><span class="home-headline-line">my watch.</span></h1>
      <p class="intro-copy">Pick a habit. We’ll keep an eye on it.</p>
    </div>
    <div class="input-wrap">
      <label class="field-label" for="description">What do you want to stop?</label>
      <textarea class="rule-input" id="description" data-field="description" rows="4" placeholder="I want to stop doom-scrolling at night." aria-describedby="description-caption">${escapeHtml(state.draft.description)}</textarea>
      <button class="round-button input-send" type="button" data-action="classify" aria-label="Choose a penalty for this rule" data-testid="describe-submit" ${state.busy ? "disabled" : ""}>${state.busy === "classify" ? '<span class="spinner" aria-hidden="true"></span>' : icon("arrow")}</button>
    </div>
    <p class="caption-line" id="description-caption">Your words. Your rule.</p>
    ${renderError("classify")}
    <section class="starter-section" aria-labelledby="starter-title">
      <h2 class="section-heading" id="starter-title">Or start with an idea</h2>
      <div class="starter-grid">${starters.map((starter) => `<button class="starter-card ${starter.tone}" type="button" data-action="starter" data-starter="${starter.id}" aria-label="Use ${escapeHtml(starter.label)} as an editable example" data-testid="starter-${starter.id}"><img class="starter-art" src="/assets/tiles/${starter.id}.png" alt="" width="88" height="88" loading="lazy" decoding="async"><span class="starter-label">${escapeHtml(starter.label)}</span></button>`).join("")}</div>
    </section>
  </section>`);
}

function matchTag() {
  if (!state.draft.behaviorId) return '<span class="mode-tag waiting">Choose the closest habit</span>';
  if (state.draft.matchMode === "demo") return '<span class="mode-tag demo">Suggested match</span>';
  if (state.draft.matchMode === "gemini") return '<span class="mode-tag ready">Suggested match</span>';
  return '<span class="mode-tag waiting">Your choice</span>';
}

function renderPenalty() {
  const amount = selectedAmount();
  const behavior = behaviorById(state.draft.behaviorId);
  const editing = Boolean(state.editingRuleId);
  const showCategoryPicker = !behavior || state.showCategoryPicker;
  return shell(`<section class="stake-page" aria-labelledby="penalty-title">
    ${screenTop("home")}
    <h1 class="screen-title stake-heading" id="penalty-title">Set your<br>stake.</h1>
    ${state.draft.legacy ? '<div class="legacy-banner"><strong>Older rule</strong><span>Update it to use this two-step test-card rule. Nothing can be charged until you do.</span></div>' : ""}
    <div class="draft-bubble penalty-description"><span>${draftText(state.draft.description)}</span><button class="text-button" type="button" data-action="edit-description">Change</button></div>
    <div class="stake-context" aria-label="Habit for this rule"><div><span class="kind-label">Habit</span><strong>${escapeHtml(behavior?.label || "Choose the closest habit")}</strong></div>${behavior ? '<button class="text-button" type="button" data-action="change-category">Change</button>' : ""}</div>
    ${showCategoryPicker ? `<div class="category-choice">
        <label class="category-inline-label" for="behavior-id">Habit</label>
        <select id="behavior-id" class="category-select" data-field="behaviorId" aria-label="Choose the closest habit">
          <option value="">Choose the closest habit</option>
          ${behaviors().map((item) => `<option value="${escapeHtml(item.id)}" ${item.id === state.draft.behaviorId ? "selected" : ""}>${escapeHtml(item.label)}</option>`).join("")}
        </select>
      </div>` : ""}
    <button class="text-button teach-different-action" type="button" data-action="teach-habit">Teach Nope a different habit</button>
    <section class="amount-section" aria-labelledby="amount-title">
      <div class="amount-heading"><h2 id="amount-title">Choose an amount</h2></div>
      <div class="amount-grid stake-options" role="group" aria-label="Choose a test-card amount">${amounts().map((value) => `<button class="amount-chip stake-option ${value === amount ? "selected" : ""}" type="button" data-action="choose-amount" data-amount="${value}" aria-pressed="${value === amount}" data-testid="amount-${value}">$${value}</button>`).join("")}</div>
    </section>
    ${renderPaymentStatus()}
    <aside class="stake-promise"><p>First time, a nudge. Next time, your stake.</p></aside>
    ${state.flash ? `<div class="success-box"><p>${escapeHtml(state.flash)}</p></div>` : ""}
    ${renderError("save")}
    <div class="stake-actions page-action setup-action"><button class="wide-action" type="button" data-action="save-rule" data-testid="start-rule" ${state.busy || !behavior ? "disabled" : ""}>${editing ? "Save changes" : "Start my rule"} · $${amount} ${state.busy === "save" ? '<span class="spinner" aria-hidden="true"></span>' : icon("arrow")}</button></div>
  </section>`);
}

function renderStageCards(amount) {
  return `<article class="stage-card cyan"><span class="timeline-icon">${icon("bell")}</span><div><span class="kind-label">1. First time</span><h2>A friendly nudge</h2><p>A quick check-in to help you pause.</p></div></article>
    <article class="stage-card yellow"><span class="timeline-icon">${icon("card")}</span><div><span class="kind-label">2. Next time</span><h2>Your stake</h2><p>$${amount} test-card stake the next time it happens.</p></div></article>`;
}

function renderPaymentStatus() {
  const stripe = stripeStatus();
  if (stripe.mode === "demo") {
    return '<section class="payment-status demo-payment"><div><strong>Card not connected</strong><p>Choose a stake and connect a test card.</p></div></section>';
  }
  if (stripe.connected) {
    return `<section class="payment-status connected-payment"><div><strong>Stripe test card connected</strong><p>${escapeHtml(stripe.cardLabel || "Your test card is ready for this stake.")}</p></div></section>`;
  }
  return `<section class="payment-status"><div><strong>Card not connected</strong><p>Choose a stake and connect a test card.</p></div><button class="small-button" type="button" data-action="setup-stripe" data-testid="connect-test-card" ${state.busy ? "disabled" : ""}>Connect test card</button></section>`;
}

function renderRules() {
  return shell(`<section class="rules-page" aria-labelledby="rules-title">
    ${screenTop("home")}
    <div class="rules-header"><h1 class="screen-title" id="rules-title">My rules.</h1><p class="screen-copy">The rules you chose to keep close.</p></div>
    ${state.flash ? `<div class="success-box"><p>${escapeHtml(state.flash)}</p></div>` : ""}
    ${state.rulesError ? `<div class="error-box"><p>${escapeHtml(state.rulesError)}</p><button class="text-button" type="button" data-action="reload-rules">Try again</button></div>` : ""}
    ${state.rules.length ? `<div class="rule-list compact-rules">${state.rules.map(renderRuleCard).join("")}</div>` : renderEmptyRules()}
    ${renderLearningHabits()}
  </section>`);
}

function renderLearningHabits() {
  const recordings = state.recordings.filter((recording) => recordingStatus(recording) !== "cancelled");
  if (!recordings.length && !state.recordingsError) return "";
  return `<section class="learning-section" aria-labelledby="learning-title">
    <div class="learning-heading"><div><span class="eyebrow">New habits</span><h2 id="learning-title">Learning new habits</h2><p>Examples to help Nope recognize something new. These aren’t active rules yet.</p></div></div>
    ${state.recordingsError ? `<div class="error-box"><p>${escapeHtml(state.recordingsError)}</p><button class="text-button" type="button" data-action="reload-recordings">Try again</button></div>` : ""}
    ${recordings.length ? `<div class="learning-list">${recordings.map(renderLearningCard).join("")}</div>` : ""}
  </section>`;
}

function renderLearningCard(recording) {
  const details = recordingStatusDetails(recording);
  return `<article class="learning-card">
    <div class="rule-card-top"><div><span class="mode-tag ${escapeHtml(details.tone)}">${escapeHtml(details.label)}</span><h3>${escapeHtml(recording.description)}</h3></div><span class="learning-duration">About ${escapeHtml(recording.durationSeconds)} sec</span></div>
    <p>${escapeHtml(details.listCopy)}</p>
    <div class="action-row"><span class="learning-date">Requested ${escapeHtml(formatDate(recording.createdAt))}</span><button class="small-button" type="button" data-action="open-recording" data-id="${escapeHtml(recording.id)}" data-testid="open-recording-${escapeHtml(recording.id)}">Open</button></div>
  </article>`;
}

function renderTeach() {
  const recording = recordingById(state.selectedRecordingId);
  if (state.selectedRecordingId && !recording && !state.recordingsLoaded) {
    return shell(`<section class="teach-page" aria-labelledby="teach-title">
      ${screenTop("rules")}
      <div class="screen-lead teach-lead"><span class="mode-tag waiting">New habit</span><h1 class="screen-title" id="teach-title" style="margin-top:16px">Show Nope what you mean.</h1><p class="screen-copy">Loading your saved recording request…</p></div>
    </section>`);
  }
  if (state.selectedRecordingId && !recording) {
    return shell(`<section class="teach-page" aria-labelledby="missing-recording-title">
      ${screenTop("rules")}
      <div class="empty-state teach-missing"><span class="empty-icon">${icon("activity")}</span><h1 id="missing-recording-title">That request is not available</h1><p>It may have been removed elsewhere. Your other requests and rules are still here.</p>${state.recordingsError ? `<div class="error-box"><p>${escapeHtml(state.recordingsError)}</p><button class="text-button" type="button" data-action="reload-recordings">Try again</button></div>` : ""}<button class="wide-action" type="button" data-action="rules">Back to my rules</button></div>
    </section>`);
  }

  const description = recording ? recording.description : nonEmpty(state.draft.description);
  return shell(`<section class="teach-page" aria-labelledby="teach-title">
    ${screenTop(recording ? "rules" : "home")}
    <div class="screen-lead teach-lead"><span class="mode-tag waiting">New habit</span><h1 class="screen-title" id="teach-title" style="margin-top:16px">Show Nope what you mean.</h1><p class="screen-copy">No match yet. Show Nope a short example so we can work on recognizing it.</p></div>
    <div class="draft-bubble teach-description"><span>${draftText(description || "Your new habit description")}</span><button class="text-button" type="button" data-action="edit-description">Change</button></div>
    ${state.flash ? `<div class="success-box"><p>${escapeHtml(state.flash)}</p></div>` : ""}
    ${recording ? renderRecordingRequest(recording) : renderTeachSetup()}
    ${renderError("recording")}
  </section>`);
}

function renderTeachSetup() {
  const settingUp = state.busy === "recording-create";
  return `<section class="teach-guide" aria-labelledby="teach-guide-title">
    <h2 id="teach-guide-title">Teach it your way</h2>
    <ol class="teach-steps">
      <li><strong>Wear the band normally.</strong></li>
      <li><strong>Capture about 10 seconds</strong> when it happens naturally.</li>
      <li><strong>Wait for a check</strong> before it can become an active rule.</li>
    </ol>
    <p class="teach-note">Don’t repeat a harmful habit just to make a sample. Your recorder needs to be connected before the example can start.</p>
    <div class="page-action"><button class="wide-action" type="button" data-action="create-recording" data-testid="setup-recording" ${settingUp || !nonEmpty(state.draft.description) ? "disabled" : ""}>${settingUp ? '<span class="spinner" aria-hidden="true"></span>' : ""}Set up recording</button><button class="text-button choose-existing-action" type="button" data-action="choose-existing-habit">Choose an existing habit</button></div>
  </section>`;
}

function renderRecordingRequest(recording) {
  const details = recordingStatusDetails(recording);
  const cancelling = state.busy === "recording-cancel";
  return `<section class="recording-request ${escapeHtml(details.tone)}" aria-labelledby="recording-status-title" data-testid="recording-status">
    <div class="recording-status-top"><span class="icon-disc">${icon(details.icon)}</span><div><span class="mode-tag ${escapeHtml(details.tone)}">${escapeHtml(details.label)}</span><h2 id="recording-status-title">${escapeHtml(details.title)}</h2><p>${escapeHtml(details.copy)}</p></div></div>
    <div class="recording-facts"><span>Requested example: about ${escapeHtml(recording.durationSeconds)} seconds</span><span>Requested ${escapeHtml(formatDate(recording.createdAt))}</span></div>
    ${canCancelRecording(recording) ? `<div class="recording-actions"><button class="wide-action secondary" type="button" data-action="cancel-recording" data-testid="cancel-recording" ${cancelling ? "disabled" : ""}>${cancelling ? '<span class="spinner" aria-hidden="true"></span>' : ""}Cancel request</button><button class="text-button choose-existing-action" type="button" data-action="choose-existing-habit">Choose an existing habit</button></div>` : `<div class="recording-actions"><button class="text-button choose-existing-action" type="button" data-action="choose-existing-habit">Choose an existing habit</button></div>`}
  </section>`;
}

function recordingStatusDetails(recording) {
  switch (recordingStatus(recording)) {
    case "recording": return {
      label: "Recording", title: "Recording example", tone: "recording", icon: "activity",
      copy: "Your recorder is capturing this example. You can cancel at any time.",
      listCopy: "Your recorder is capturing this example.",
    };
    case "recorded": return {
      label: "Recorded", title: "Example recorded", tone: "recorded", icon: "check",
      copy: "Your example is recorded. The detector still needs to be trained and checked before this habit can become an active rule.",
      listCopy: "Example recorded. Training and checking are still needed.",
    };
    case "cancelled": return {
      label: "Cancelled", title: "Recording request cancelled", tone: "cancelled", icon: "close",
      copy: "This request is closed. Start a new request to try again.",
      listCopy: "This request was cancelled.",
    };
    default: return {
      label: "Requested", title: "Waiting for your recorder", tone: "waiting", icon: "activity",
      copy: "Your request is saved. Nothing is recording yet.",
      listCopy: "Your request is saved. Nothing is recording yet.",
    };
  }
}

function renderRuleCard(rule) {
  const modern = isVersionTwo(rule);
  const enabled = Boolean(rule.enabled);
  const amount = ruleAmount(rule);
  const status = enabled ? rule.warningArmed ? "Warned" : "Ready" : "Paused";
  return `<article class="rule-card compact-rule-card ${modern ? "" : "legacy-rule"}">
    <div class="rule-card-main"><span class="rule-mascot ${ruleMascotTone(rule)}" aria-hidden="true"><img src="/assets/nope-eyes.svg" alt="" width="72" height="42"></span><div><h2 class="compact-rule-title">${escapeHtml(titleForRule(rule))}</h2>${modern ? `<strong>$${amount} stake</strong>` : "<span>Update to activate</span>"}</div></div>
    <div class="rule-card-footer"><span class="mode-tag ${modern ? status === "Warned" ? "warned" : enabled ? "ready" : "waiting" : "demo"}">${modern ? status : "Older rule"}</span><div class="rule-card-actions"><button class="small-button secondary" type="button" data-action="open-rule" data-id="${escapeHtml(rule.id)}">Open</button><button class="small-button" type="button" data-action="${modern ? "try-preview" : "edit-rule"}" data-id="${escapeHtml(rule.id)}" data-testid="${modern ? "preview" : "update"}-${escapeHtml(rule.id)}">${modern ? "Try it" : "Update"}</button></div></div>
  </article>`;
}

function renderToggle(rule) {
  const label = rule.enabled ? "Pause rule" : "Resume rule";
  return `<label class="switch-wrap" aria-label="${label}"><span class="visually-hidden">${label}</span><span class="switch"><input type="checkbox" data-action="toggle-rule" data-id="${escapeHtml(rule.id)}" ${rule.enabled ? "checked" : ""} aria-label="${label}" /><span class="switch-track"></span></span></label>`;
}

function renderEmptyRules() {
  return `<div class="empty-state"><span class="empty-icon">${icon("rules")}</span><h2>No rules yet</h2><p>Your first rule starts with a friendly nudge, then uses its chosen test-card stake on the next occurrence.</p><button class="wide-action" type="button" data-action="new-rule" data-testid="empty-add-rule">Make my first rule ${icon("plus")}</button></div>`;
}

function renderDetail() {
  const rule = ruleById(state.selectedRuleId);
  if (!rule) return shell(`<section aria-labelledby="missing-title">${screenTop("rules")}<div class="empty-state" style="margin-top:38px"><span class="empty-icon">${icon("rules")}</span><h1 id="missing-title">That rule is gone</h1><p>It may have been deleted in another tab. Your other rules are still here.</p><button class="wide-action" type="button" data-action="rules">Back to my rules</button></div></section>`);
  return isVersionTwo(rule) ? renderModernDetail(rule) : renderLegacyDetail(rule);
}

function renderModernDetail(rule) {
  const enabled = Boolean(rule.enabled);
  const amount = ruleAmount(rule);
  const status = enabled ? rule.warningArmed ? "Warned" : "Ready" : "Paused";
  return shell(`<section aria-labelledby="detail-title">
    ${screenTop("rules")}
    <div class="detail-header"><h1 class="screen-title" id="detail-title">${escapeHtml(titleForRule(rule))}</h1><div class="status-row"><span class="mode-tag ${status === "Warned" ? "warned" : enabled ? "ready" : "waiting"}">${status}</span><span class="kind-label">$${amount} stake</span>${renderToggle(rule)}</div></div>
    ${state.flash ? `<div class="success-box"><p>${escapeHtml(state.flash)}</p></div>` : ""}
    <div class="detail-summary"><p><strong>What you want to end</strong><br>${draftText(descriptionForRule(rule))}</p></div>
    <div class="detector-status"><span class="icon-disc">${icon(enabled ? "activity" : "pause")}</span><div><h2>${enabled ? status === "Warned" ? "Next time, your stake." : "Ready for updates" : "Paused for now"}</h2><p>${escapeHtml(enabled ? status === "Warned" ? `Your next ${titleForRule(rule).toLowerCase()} will use the $${amount} stake.` : "First time, Nope sends a nudge. Next time, it uses your stake." : "Detector updates are ignored until you resume this rule.")}</p></div></div>
    <p class="caption-line">${escapeHtml(detailPaymentLine())}</p>
    <div class="fixed-stages compact-stages">${renderStageCards(amount)}</div>
    <div class="detail-actions"><button class="wide-action secondary" type="button" data-action="try-preview" data-id="${escapeHtml(rule.id)}" data-testid="try-preview">${icon("phone")}Try it</button><button class="wide-action secondary" type="button" data-action="edit-rule" data-id="${escapeHtml(rule.id)}">${icon("edit")}Edit</button><button class="wide-action secondary" type="button" data-action="ask-delete" data-id="${escapeHtml(rule.id)}">${icon("trash")}Delete</button></div>
    ${state.deleteRuleId === rule.id ? renderDeleteConfirm(rule) : ""}
    ${renderError("rule")}
  </section>`);
}

function detailPaymentLine() {
  const stripe = stripeStatus();
  if (stripe.mode === "demo") return "Card not connected. Connect a test card to put this stake into action.";
  if (stripe.connected) return "Stripe test card connected.";
  return "Card not connected. Connect a test card to put this stake into action.";
}

function renderLegacyDetail(rule) {
  return shell(`<section aria-labelledby="legacy-title">
    ${screenTop("rules")}
    <div class="detail-header"><span class="mode-tag demo">Older rule</span><h1 class="screen-title" id="legacy-title" style="margin-top:16px">${escapeHtml(titleForRule(rule))}</h1></div>
    <div class="detail-summary"><p><strong>Saved description</strong><br>${draftText(descriptionForRule(rule))}</p></div>
    <div class="legacy-banner"><strong>Update this rule</strong><span>Older rules stay readable, but can never charge a test card until you choose a category and update them.</span></div>
    <div class="detail-actions"><button class="wide-action" type="button" data-action="edit-rule" data-id="${escapeHtml(rule.id)}" data-testid="update-legacy">Update this rule ${icon("arrow")}</button><button class="wide-action secondary" type="button" data-action="ask-delete" data-id="${escapeHtml(rule.id)}">${icon("trash")}Delete</button></div>
    ${state.deleteRuleId === rule.id ? renderDeleteConfirm(rule) : ""}
    ${renderError("rule")}
  </section>`);
}

function renderDeleteConfirm(rule) {
  return `<section class="confirm-panel" aria-labelledby="delete-title"><h2 id="delete-title">Delete this rule?</h2><p>This removes “${escapeHtml(titleForRule(rule))}”. It does not reverse anything outside this app.</p><div class="confirm-actions"><button class="wide-action secondary" type="button" data-action="cancel-delete">Keep rule</button><button class="wide-action danger" type="button" data-action="confirm-delete" data-id="${escapeHtml(rule.id)}" data-testid="confirm-delete">Delete rule</button></div></section>`;
}

function interventionEyesMarkup() {
  return '<img class="intervention-eyes" src="/assets/nope-eyes.svg" alt="" aria-hidden="true" width="272" height="128">';
}

function chargeResult(correction, amount, detector) {
  const value = [1, 5, 10].includes(correction?.amountDollars) ? correction.amountDollars : amount;
  const detail = nonEmpty(correction?.message);
  if (!detector) return { title: `That’s $${value}.`, copy: "Your stake, set by you. A repeat detection puts it into action.", status: "Your commitment" };
  if (correction?.status === "succeeded") return { title: `That’s $${value}.`, copy: "You set the rule. We kept our word.", status: "Payment confirmed", detail: "Test card charged · Next time starts with a nudge." };
  if (correction?.status === "demo") return { title: `Your stake: $${value}.`, copy: "Connect a card to put this stake into action.", status: "Card not connected" };
  if (correction?.status === "pending") return { title: "Payment pending.", copy: detail || "We are still waiting to confirm this payment. No charge is confirmed yet.", status: "Not confirmed" };
  if (correction?.status === "not_connected") return { title: `Your stake: $${value}.`, copy: detail || "Connect a card to put this stake into action.", status: "Card not connected" };
  if (correction?.status === "failed") return { title: "No charge.", copy: detail || "The test-card payment did not go through.", status: "Not confirmed" };
  return { title: "Payment pending.", copy: detail || "We are waiting to confirm a payment result. No charge is confirmed yet.", status: "Not confirmed" };
}

function renderIntervention() {
  const preview = state.preview;
  const rule = preview ? ruleById(preview.ruleId) : null;
  if (!preview || !rule || !isVersionTwo(rule)) return `<section class="intervention-shell result-shell" aria-labelledby="intervention-title"><div class="intervention-page"><h1 class="intervention-title" id="intervention-title" tabindex="-1">Nothing to resolve.</h1><p class="intervention-copy">This rule is no longer available.</p><div class="intervention-actions"><button class="wide-action" type="button" data-action="rules">Back to my rules</button></div></div></section>`;
  if (preview.stage === 2) return renderChargeIntervention(rule, preview);
  if (preview.status !== "active") return renderInterventionClosure(preview);
  const detector = preview.mode === "detector";
  const busy = state.busy === "detector-stop";
  return `<section class="intervention-shell nudge-shell" aria-labelledby="intervention-title" data-testid="preview-panel"><div class="intervention-page">
    ${interventionEyesMarkup()}
    <p class="intervention-kicker">Quick check-in</p>
    <h1 class="intervention-title" id="intervention-title" tabindex="-1">Caught a loop?</h1>
    <p class="intervention-copy">Take a breath. You can choose again.</p>
    <p class="intervention-status">${escapeHtml(titleForRule(rule))} · $${ruleAmount(rule)} stake</p>
    <div class="intervention-actions"><button class="wide-action" type="button" data-action="preview-stopped" data-testid="preview-stopped" ${busy ? "disabled" : ""}>${busy ? '<span class="spinner" aria-hidden="true"></span>' : ""}I stopped</button>${detector ? "" : '<button class="wide-action secondary" type="button" data-action="preview-next" data-testid="preview-next">Still doing it</button>'}<button class="wide-action secondary" type="button" data-action="preview-dismiss" data-testid="preview-dismiss" ${busy ? "disabled" : ""}>False alarm</button></div>
    ${renderError("preview")}
  </div></section>`;
}

function renderChargeIntervention(rule, preview) {
  const detector = preview.mode === "detector";
  const amount = ruleAmount(rule);
  const result = chargeResult(preview.correction, amount, detector);
  return `<section class="intervention-shell charge-shell result-shell" aria-labelledby="intervention-title" data-testid="preview-panel"><div class="intervention-page">
    ${interventionEyesMarkup()}
    <p class="intervention-kicker">Nope</p>
    <h1 class="intervention-title" id="intervention-title" tabindex="-1">${escapeHtml(result.title)}</h1>
    <p class="intervention-copy">${escapeHtml(result.copy)}</p>
    <p class="intervention-status">${escapeHtml(result.status)}</p>${result.detail ? `<p class="intervention-status">${escapeHtml(result.detail)}</p>` : ""}
    <div class="intervention-actions"><button class="wide-action" type="button" data-action="close-intervention">Back to my rules</button></div>
    ${renderError("preview")}
  </div></section>`;
}

function renderInterventionClosure(preview) {
  const detector = preview.mode === "detector";
  const falseAlarm = preview.status === "dismissed";
  const title = falseAlarm ? "False alarm cleared." : "Good call.";
  const copy = detector ? falseAlarm ? "This alert is cleared. No stake was applied." : "This one is closed. Next time, your stake." : falseAlarm ? "This practice check-in is cleared. Your commitment stays with you." : "This practice check-in is complete. Your commitment stays with you.";
  return `<section class="intervention-shell result-shell" aria-labelledby="intervention-title" data-testid="preview-panel"><div class="intervention-page">
    ${interventionEyesMarkup()}
    <p class="intervention-kicker">Nope</p>
    <h1 class="intervention-title" id="intervention-title" tabindex="-1">${title}</h1>
    <p class="intervention-copy">${copy}</p>
    <div class="intervention-actions"><button class="wide-action" type="button" data-action="close-intervention">Back to my rules</button></div>
    ${renderError("preview")}
  </div></section>`;
}

function renderActivity() {
  return shell(`<section aria-labelledby="activity-title">${screenTop("home")}<div class="activity-header"><h1 class="screen-title" id="activity-title">Your check-ins and commitments.</h1><p class="screen-copy">Practice check-ins and updates from your band live here.</p></div>${state.activity.length ? `<div class="activity-list">${state.activity.map(renderActivityItem).join("")}</div>` : `<div class="empty-state"><span class="empty-icon">${icon("activity")}</span><h2>No check-ins yet</h2><p>Try a practice check-in or wait for an update from your band.</p></div>`}</section>`);
}

function activityTextForDisplay(item) {
  const text = nonEmpty(item?.text);
  const normalized = text.toLowerCase();
  if (item?.source === "preview") {
    if (/simulat|penalty|stake screen|charge screen/.test(normalized)) return "Viewed the stake screen";
    if (/demo|local preview|preview started|started (?:a )?preview/.test(normalized)) return "Tried a check-in";
  }
  if (item?.source === "detector" && /demo|simulat|local preview/.test(normalized)) return "Received an update from your band";
  return text || "Check-in";
}

function renderActivityItem(item) {
  const source = item.source === "detector" ? "Band" : "Practice";
  const rule = ruleById(item.ruleId);
  return `<article class="activity-item"><span class="icon-disc">${icon(item.source === "detector" ? "activity" : "phone")}</span><div><div class="activity-top"><h2>${escapeHtml(activityTextForDisplay(item))}</h2><span class="activity-source ${item.source === "detector" ? "detector" : "preview"}">${source}</span></div><p>${escapeHtml(rule ? titleForRule(rule) : "A saved rule")} · ${escapeHtml(formatDate(item.at))}</p></div></article>`;
}

function renderError(context) {
  if (!state.error || state.error.context !== context) return "";
  const retry = state.error.retry ? `<button class="text-button" type="button" data-action="${state.error.retry}">Try again</button>` : "";
  return `<div class="error-box" role="alert"><p>${escapeHtml(state.error.message)}</p>${retry}</div>`;
}

function render() {
  const routeChanged = state.route !== lastRenderedRoute;
  root.setAttribute("aria-busy", state.busy ? "true" : "false");
  const pages = { home: renderHome, penalty: renderPenalty, rules: renderRules, detail: renderDetail, activity: renderActivity, teach: renderTeach, intervention: renderIntervention };
  root.innerHTML = (pages[state.route] || renderHome)();
  lastRenderedRoute = state.route;
  updateHelpCopy();
  syncTeachLocation();
  syncTeachPolling();
  if (routeChanged) window.requestAnimationFrame(() => { window.scrollTo(0, 0); if (state.route === "intervention") document.querySelector("#intervention-title")?.focus(); });
}

function updateHelpCopy() {
  const band = document.querySelector("#help-band-status");
  const payment = document.querySelector("#help-ai-mode");
  if (band) {
    band.textContent = Number.isInteger(state.config?.bandNumber)
      ? `Band ${state.config.bandNumber} is the rule context. “Ready” means you can set a rule; it does not verify a hardware connection.`
      : "Band context is still loading. Nope does not connect to hardware here.";
  }
  if (payment) {
    const stripe = stripeStatus();
    const match = "A suggested match picks a rule category. The first band check-in opens a nudge; the next one can put your stake into action.";
    payment.textContent = stripe.mode === "test"
      ? `${match} Stripe is in test mode${stripe.connected ? " with a connected test card" : "; connect a test card before a stake can be used"}.`
      : `${match} Connect a test card to put your stake into action.`;
  }
}

function readActivity() {
  try {
    const value = JSON.parse(localStorage.getItem(activityStorageKey) || "[]");
    return Array.isArray(value) ? value.filter((item) => item && typeof item === "object").slice(0, 80) : [];
  } catch { return []; }
}

function addActivity(entry) {
  const item = { id: entry.id || `${Date.now()}-${Math.random().toString(16).slice(2)}`, source: entry.source === "detector" ? "detector" : "preview", ruleId: entry.ruleId || "", text: nonEmpty(entry.text) || "Check-in", at: entry.at || new Date().toISOString() };
  state.activity = [item, ...state.activity].slice(0, 80);
  try { localStorage.setItem(activityStorageKey, JSON.stringify(state.activity)); } catch { /* local activity is optional */ }
}

function formatDate(value) {
  const date = new Date(value || Date.now());
  if (Number.isNaN(date.getTime())) return "just now";
  return new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }).format(date);
}

async function api(path, options = {}) {
  const request = { ...options, headers: { Accept: "application/json", ...(options.headers || {}) } };
  if (options.body) request.headers["Content-Type"] = "application/json";
  let response;
  try { response = await fetch(path, request); } catch { throw new Error("Couldn’t reach the local app. Check that it is running, then try again."); }
  let data = null;
  try { data = await response.json(); } catch { /* keep safe local error below */ }
  if (!response.ok) {
    const error = new Error(nonEmpty(data?.error) || `That request could not be completed (${response.status}).`);
    error.status = response.status;
    throw error;
  }
  return data || {};
}

function normalizeRecording(value) {
  if (!value || typeof value !== "object") return null;
  const id = nonEmpty(value.id);
  const description = nonEmpty(value.description);
  const status = typeof value.status === "string" ? value.status : "";
  if (!id || !description || !["requested", "recording", "recorded", "cancelled"].includes(status)) return null;
  return {
    id,
    description,
    status,
    bandNumber: Number.isInteger(value.bandNumber) ? value.bandNumber : null,
    durationSeconds: Number.isInteger(value.durationSeconds) && value.durationSeconds > 0 ? value.durationSeconds : 10,
    createdAt: validDate(value.createdAt) || new Date().toISOString(),
    updatedAt: validDate(value.updatedAt) || "",
    sampleCount: Number.isInteger(value.sampleCount) && value.sampleCount > 0 ? value.sampleCount : null,
  };
}

function recordingSignature(recording) {
  return [recording.id, recording.description, recording.status, recording.bandNumber, recording.durationSeconds, recording.createdAt, recording.updatedAt, recording.sampleCount].join("|");
}

function upsertRecording(value) {
  const recording = normalizeRecording(value);
  if (!recording) return false;
  const index = state.recordings.findIndex((item) => item.id === recording.id);
  if (index >= 0) {
    if (recordingSignature(state.recordings[index]) === recordingSignature(recording)) return false;
    state.recordings.splice(index, 1, recording);
  } else {
    state.recordings.unshift(recording);
  }
  return true;
}

function selectRecording(id) {
  const nextId = nonEmpty(id) || null;
  if (state.selectedRecordingId === nextId) return;
  state.selectedRecordingId = nextId;
  recordingRequestVersion += 1;
}

function clearSelectedRecording() {
  state.selectedRecordingId = null;
  recordingRequestVersion += 1;
}

async function loadRecordings() {
  const requestVersion = recordingRequestVersion;
  state.recordingsLoaded = false;
  try {
    const data = await api("/api/recordings");
    if (requestVersion !== recordingRequestVersion) return;
    const records = safeArray(data.recordings).map(normalizeRecording).filter(Boolean);
    state.recordings = records;
    state.recordingsError = "";
  } catch (error) {
    if (requestVersion === recordingRequestVersion) state.recordingsError = `Couldn’t load learning requests: ${messageFor(error)}`;
  } finally {
    if (requestVersion === recordingRequestVersion) state.recordingsLoaded = true;
  }
}

function currentRecordingIs(id, requestVersion) {
  return state.selectedRecordingId === id && recordingRequestVersion === requestVersion;
}

async function refreshSelectedRecording() {
  const id = nonEmpty(state.selectedRecordingId);
  if (!id || recordingPollInFlight || state.busy) return false;
  const requestVersion = recordingRequestVersion;
  recordingPollInFlight = true;
  try {
    const data = await api(`/api/recordings/${encodeURIComponent(id)}`);
    if (!currentRecordingIs(id, requestVersion)) return false;
    const changed = upsertRecording(data.recording);
    if (!recordingById(id)) throw new Error("The recorder returned an incomplete request.");
    const hadError = state.error?.context === "recording";
    if (hadError) state.error = null;
    if (state.route === "teach" && (changed || hadError)) render();
    return changed;
  } catch (error) {
    if (!currentRecordingIs(id, requestVersion)) return false;
    const message = `Couldn’t refresh this recording request: ${messageFor(error)}`;
    const changed = state.error?.context !== "recording" || state.error.message !== message;
    state.error = { context: "recording", message, retry: "retry-recording" };
    if (state.route === "teach" && changed) render();
    return false;
  } finally {
    recordingPollInFlight = false;
  }
}

function stopTeachPolling() {
  if (!recordingPollTimer) return;
  window.clearInterval(recordingPollTimer);
  recordingPollTimer = null;
}

function syncTeachPolling() {
  const recording = recordingById(state.selectedRecordingId);
  const shouldPoll = state.route === "teach" && recording && canCancelRecording(recording);
  if (!shouldPoll) { stopTeachPolling(); return; }
  if (recordingPollTimer) return;
  recordingPollTimer = window.setInterval(() => { void refreshSelectedRecording(); }, recordingPollIntervalMs);
  void refreshSelectedRecording();
}

function normalizeConfig(config) {
  const list = safeArray(config?.behaviors).filter((item) => item && typeof item.id === "string" && typeof item.label === "string");
  const allowedAmounts = safeArray(config?.penaltyAmounts).filter((amount) => [1, 5, 10].includes(amount));
  return {
    bandNumber: Number.isInteger(config?.bandNumber) ? config.bandNumber : null,
    aiMode: config?.aiMode === "gemini" ? "gemini" : "demo",
    behaviors: list.length === 6 ? list : fallbackBehaviors,
    penaltyAmounts: allowedAmounts.length ? allowedAmounts : [1, 5, 10],
    graceSeconds: Number.isInteger(config?.graceSeconds) ? config.graceSeconds : 60,
    decisionModel: typeof config?.decisionModel === "string" ? config.decisionModel : null,
    stripe: { mode: config?.stripe?.mode === "test" ? "test" : "demo", connected: Boolean(config?.stripe?.connected), cardLabel: nonEmpty(config?.stripe?.cardLabel) || null, message: nonEmpty(config?.stripe?.message) },
  };
}

async function loadConfig() {
  try {
    state.config = normalizeConfig(await api("/api/config"));
    if (!amounts().includes(state.draft.penaltyAmount)) state.draft.penaltyAmount = selectedAmount();
    state.configError = "";
  } catch (error) { state.configError = messageFor(error); }
}

async function loadRules() {
  try {
    const data = await api("/api/rules");
    state.rules = safeArray(data.rules);
    state.rulesError = "";
    if (state.selectedRuleId && !ruleById(state.selectedRuleId)) { state.selectedRuleId = null; if (state.route === "detail") state.route = "rules"; }
  } catch (error) { state.rulesError = messageFor(error); }
}

async function createRecordingRequest() {
  const description = nonEmpty(state.draft.description);
  if (description.length < 4) {
    state.error = { context: "recording", message: "Add a little more about the new habit before setting up a recording request." };
    render();
    return;
  }
  const actionVersion = ++recordingRequestVersion;
  state.busy = "recording-create";
  state.error = null;
  state.flash = "";
  render();
  try {
    const data = await api("/api/recordings", { method: "POST", body: JSON.stringify({ description, behaviorId: null }) });
    if (actionVersion !== recordingRequestVersion) return;
    const recording = normalizeRecording(data.recording);
    if (!recording) throw new Error("The recorder returned an incomplete request. Please try again.");
    upsertRecording(recording);
    state.recordingsLoaded = true;
    selectRecording(recording.id);
    state.route = "teach";
  } catch (error) {
    if (actionVersion === recordingRequestVersion) {
      state.error = { context: "recording", message: `Couldn’t set up the recording request: ${messageFor(error)}`, retry: "retry-create-recording" };
    }
  } finally {
    if (state.busy === "recording-create") state.busy = "";
    render();
  }
}

async function cancelRecordingRequest() {
  const recording = recordingById(state.selectedRecordingId);
  if (!recording || !canCancelRecording(recording)) return;
  const bandNumber = state.config?.bandNumber;
  if (!Number.isInteger(bandNumber)) {
    state.error = { context: "recording", message: "Band context is still loading, so this request cannot be cancelled yet.", retry: "retry-cancel-recording" };
    render();
    return;
  }
  const id = recording.id;
  const actionVersion = ++recordingRequestVersion;
  state.busy = "recording-cancel";
  state.error = null;
  state.flash = "";
  render();
  try {
    const data = await api(`/api/recordings/${encodeURIComponent(id)}`, { method: "PATCH", body: JSON.stringify({ bandNumber, status: "cancelled" }) });
    if (!currentRecordingIs(id, actionVersion)) return;
    upsertRecording(data.recording);
    if (recordingStatus(recordingById(id)) !== "cancelled") throw new Error("The recorder returned an incomplete cancellation.");
    state.flash = "The recording request was cancelled.";
  } catch (error) {
    if (!currentRecordingIs(id, actionVersion)) return;
    if (Number(error?.status) === 409) {
      state.busy = "";
      state.error = null;
      await refreshSelectedRecording();
      if (currentRecordingIs(id, actionVersion) && state.error?.context !== "recording") {
        state.flash = "The recorder updated this request before it could be cancelled. Showing its latest status.";
      }
      return;
    }
    state.error = { context: "recording", message: `Couldn’t cancel this recording request: ${messageFor(error)}`, retry: "retry-cancel-recording" };
  } finally {
    if (state.busy === "recording-cancel") state.busy = "";
    if (state.route === "teach") render();
  }
}

function openRecording(id) {
  const recording = recordingById(id);
  if (!recording) return;
  state.draft = emptyDraft();
  state.editingRuleId = null;
  state.draft.description = recording.description;
  state.draft.behaviorId = null;
  state.draft.matchMode = null;
  selectRecording(recording.id);
  state.route = "teach";
  state.error = null;
  state.flash = "";
  render();
}

function chooseExistingHabit() {
  const recording = recordingById(state.selectedRecordingId);
  if (recording) state.draft.description = recording.description;
  clearSelectedRecording();
  state.draft.behaviorId = null;
  state.draft.matchMode = null;
  state.showCategoryPicker = true;
  state.route = "penalty";
  state.error = null;
  state.flash = "";
  render();
}

function enterTeachForDifferentHabit() {
  clearSelectedRecording();
  state.draft.behaviorId = null;
  state.draft.matchMode = null;
  state.showCategoryPicker = false;
  state.route = "teach";
  state.error = null;
  state.flash = "";
  render();
}

async function classifyDescription() {
  const description = nonEmpty(state.draft.description);
  if (description.length < 4) {
    state.error = { context: "classify", message: "Add a little more about what you want to end." };
    render(); focusElement("#description"); return;
  }
  state.busy = "classify"; state.error = null; render();
  try {
    const data = await api("/api/classify", { method: "POST", body: JSON.stringify({ description }) });
    state.draft.behaviorId = behaviorById(data.behaviorId)?.id || null;
    state.draft.matchMode = data.mode === "gemini" ? "gemini" : "demo";
    state.draft.confidence = typeof data.confidence === "number" ? data.confidence : null;
    state.showCategoryPicker = false;
    clearSelectedRecording();
    state.route = state.draft.behaviorId ? "penalty" : "teach";
  } catch (error) { state.error = { context: "classify", message: messageFor(error), retry: "retry-classify" }; }
  finally { state.busy = ""; render(); }
}

function compactPayload() {
  return { description: nonEmpty(state.draft.description), behaviorId: state.draft.behaviorId, penaltyAmount: selectedAmount() };
}

async function saveRule() {
  const payload = compactPayload();
  if (!payload.description || !behaviorById(payload.behaviorId)) {
    state.error = { context: "save", message: "Choose the closest habit before starting this rule." }; render(); return;
  }
  state.busy = "save"; state.error = null; render();
  try {
    const data = state.editingRuleId
      ? await api(`/api/rules/${encodeURIComponent(state.editingRuleId)}`, { method: "PATCH", body: JSON.stringify(payload) })
      : await api("/api/rules", { method: "POST", body: JSON.stringify(payload) });
    if (!data.rule || typeof data.rule !== "object") throw new Error("The saved rule was incomplete. Try again.");
    const existing = state.rules.findIndex((rule) => rule.id === data.rule.id);
    if (existing >= 0) state.rules.splice(existing, 1, data.rule); else state.rules.unshift(data.rule);
    state.selectedRuleId = null; state.route = "rules"; state.editingRuleId = null; state.draft.legacy = false; state.showCategoryPicker = false;
    state.flash = existing >= 0 ? "Your rule is updated." : "Your rule is ready.";
  } catch (error) { state.error = { context: "save", message: messageFor(error), retry: "retry-save" }; }
  finally { state.busy = ""; render(); }
}

async function toggleRule(id, enabled) {
  try {
    const data = await api(`/api/rules/${encodeURIComponent(id)}`, { method: "PATCH", body: JSON.stringify({ enabled }) });
    if (!data.rule) throw new Error("The rule update was incomplete.");
    const index = state.rules.findIndex((rule) => rule.id === id);
    if (index >= 0) state.rules.splice(index, 1, data.rule);
    if (!enabled && state.preview?.ruleId === id && state.preview.mode === "detector") state.preview = null;
    state.flash = enabled ? "This rule is ready for updates." : "This rule is paused. Detector updates will be ignored.";
  } catch (error) { state.rulesError = messageFor(error); state.error = { context: "rule", message: messageFor(error) }; }
  render();
}

function beginPreview(id) {
  const rule = ruleById(id);
  if (!rule || !isVersionTwo(rule)) return;
  state.selectedRuleId = rule.id; state.route = "intervention"; state.deleteRuleId = null;
  state.preview = { ruleId: rule.id, mode: "preview", status: "active", stage: 1, correction: { stage: 1, status: "preview" }, warningArmed: false };
  state.flash = "";
  addActivity({ source: "preview", ruleId: rule.id, text: "Tried a check-in" });
  render();
}

function advancePreview() {
  const preview = state.preview;
  if (!preview || preview.mode !== "preview" || preview.stage !== 1) return;
  preview.stage = 2; preview.correction = { stage: 2, status: "preview" };
  addActivity({ source: "preview", ruleId: preview.ruleId, text: "Viewed the stake screen" });
  render();
}

async function stopPreview() {
  const preview = state.preview;
  if (!preview) return;
  if (preview.mode !== "detector") {
    preview.status = "stopped";
    addActivity({ source: "preview", ruleId: preview.ruleId, text: "Finished a practice check-in" });
    render();
    return;
  }
  await endDetectorPreview("Finished a band check-in", "stopped");
}

async function dismissPreview() {
  const preview = state.preview;
  if (!preview) return;
  if (preview.mode !== "detector") {
    preview.status = "dismissed";
    addActivity({ source: "preview", ruleId: preview.ruleId, text: "Cleared a practice check-in" });
    render();
    return;
  }
  await endDetectorPreview("Cleared a band check-in", "false_alarm");
}

async function endDetectorPreview(activityText, reason) {
  const preview = state.preview;
  if (!preview || preview.mode !== "detector") return;
  state.busy = "detector-stop";
  state.error = null;
  render();
  try {
    const stopPayload = { reason };
    if (nonEmpty(preview.episodeId)) stopPayload.episodeId = preview.episodeId;
    let data;
    try {
      data = await api(`/api/rules/${encodeURIComponent(preview.ruleId)}/stop`, { method: "POST", body: JSON.stringify(stopPayload) });
    } catch (error) {
      if (nonEmpty(preview.episodeId) || Number(error?.status) !== 400) throw error;
      data = await api(`/api/rules/${encodeURIComponent(preview.ruleId)}/stop`, { method: "POST", body: JSON.stringify({}) });
    }
    preview.status = reason === "false_alarm" ? "dismissed" : "stopped";
    preview.warningArmed = typeof data.warningArmed === "boolean" ? data.warningArmed : reason !== "false_alarm";
    const rule = ruleById(preview.ruleId);
    if (rule) rule.warningArmed = preview.warningArmed;
    if (nonEmpty(preview.episodeId)) {
      state.acknowledgedDetectorEpisodes.add(`${preview.ruleId}:${preview.episodeId}`);
      if (state.acknowledgedDetectorEpisodes.size > 250) state.acknowledgedDetectorEpisodes = new Set([...state.acknowledgedDetectorEpisodes].slice(-120));
    }
    addActivity({ source: "detector", ruleId: preview.ruleId, text: activityText });
    state.route = "rules";
    state.inboundRuleId = null;
    state.flash = reason === "false_alarm" ? "False alarm cleared." : "This one is closed. Next time, your stake.";
  } catch (error) {
    state.error = { context: "preview", message: `Couldn’t update this detector session: ${messageFor(error)}`, retry: reason === "false_alarm" ? "preview-dismiss" : "preview-stopped" };
  } finally {
    state.busy = "";
    render();
  }
}

function closeIntervention() {
  if (state.preview?.mode === "preview") state.preview = null;
  state.route = "rules";
  state.error = null;
  state.flash = "";
  render();
}

async function deleteRule(id) {
  try {
    await api(`/api/rules/${encodeURIComponent(id)}`, { method: "DELETE" });
    state.rules = state.rules.filter((rule) => rule.id !== id);
    if (state.preview?.ruleId === id) state.preview = null;
    state.selectedRuleId = null; state.deleteRuleId = null; state.route = "rules"; state.flash = "The rule was deleted.";
  } catch (error) { state.error = { context: "rule", message: messageFor(error) }; }
  render();
}

function editRule(id) {
  const rule = ruleById(id);
  if (!rule) return;
  state.draft = emptyDraft();
  state.draft.description = descriptionForRule(rule);
  state.draft.behaviorId = isVersionTwo(rule) ? behaviorById(rule.behaviorId)?.id || null : null;
  state.draft.penaltyAmount = ruleAmount(rule) || selectedAmount();
  state.draft.legacy = !isVersionTwo(rule);
  state.showCategoryPicker = false;
  state.editingRuleId = rule.id; state.route = "penalty"; state.error = null; state.flash = "";
  render();
}

async function setupStripe() {
  try {
    sessionStorage.setItem(redirectDraftKey, JSON.stringify({ draft: state.draft, editingRuleId: state.editingRuleId }));
    state.busy = "stripe-setup"; state.error = null; render();
    const data = await api("/api/payments/setup", { method: "POST", body: JSON.stringify({}) });
    if (!nonEmpty(data.url)) throw new Error("The test-card setup link was unavailable. Try again.");
    window.location.assign(data.url);
  } catch (error) { state.busy = ""; state.error = { context: "save", message: messageFor(error) }; render(); }
}

async function completeStripeSetup(sessionId) {
  state.busy = "stripe-complete"; render();
  try {
    const data = await api("/api/payments/complete", { method: "POST", body: JSON.stringify({ sessionId }) });
    const nextStripe = data.stripe || data;
    if (state.config) state.config.stripe = { ...stripeStatus(), ...nextStripe, mode: nextStripe.mode === "test" ? "test" : "demo", connected: Boolean(nextStripe.connected), cardLabel: nonEmpty(nextStripe.cardLabel) || null, message: nonEmpty(nextStripe.message) };
    state.flash = nextStripe.connected ? "Your test card is connected." : nonEmpty(nextStripe.message) || "The test card could not be confirmed.";
  } catch (error) { state.flash = `Test-card setup was not confirmed: ${messageFor(error)}`; }
  finally { state.busy = ""; sessionStorage.removeItem(redirectDraftKey); clearPaymentQuery(); render(); }
}

function restoreRedirectDraftIfNeeded() {
  const query = new URLSearchParams(window.location.search);
  if (!query.has("stripe_setup_session") && query.get("stripe_setup") !== "cancelled") return;
  try {
    const saved = JSON.parse(sessionStorage.getItem(redirectDraftKey) || "null");
    if (saved?.draft && typeof saved.draft === "object") {
      state.draft = { ...emptyDraft(), ...saved.draft, description: nonEmpty(saved.draft.description), behaviorId: typeof saved.draft.behaviorId === "string" ? saved.draft.behaviorId : null, penaltyAmount: [1, 5, 10].includes(saved.draft.penaltyAmount) ? saved.draft.penaltyAmount : 5 };
      state.editingRuleId = typeof saved.editingRuleId === "string" ? saved.editingRuleId : null;
      state.route = "penalty";
    }
  } catch { /* a malformed local restore is ignored safely */ }
}

function restoreTeachRequestIfNeeded() {
  const query = new URLSearchParams(window.location.search);
  if (query.has("stripe_setup_session") || query.get("stripe_setup") === "cancelled") return;
  if (!window.location.hash.startsWith(teachHashPrefix)) return;
  try {
    const id = nonEmpty(decodeURIComponent(window.location.hash.slice(teachHashPrefix.length)));
    if (id) {
      state.selectedRecordingId = id;
      state.route = "teach";
    }
  } catch { /* malformed local navigation is ignored safely */ }
}

function syncTeachLocation() {
  const id = state.route === "teach" ? nonEmpty(state.selectedRecordingId) : "";
  const hash = id ? `${teachHashPrefix}${encodeURIComponent(id)}` : "";
  if (window.location.hash === hash) return;
  const url = new URL(window.location.href);
  window.history.replaceState({}, "", `${url.pathname}${url.search}${hash}`);
}

function clearPaymentQuery() {
  const url = new URL(window.location.href);
  url.searchParams.delete("stripe_setup_session");
  url.searchParams.delete("stripe_setup");
  window.history.replaceState({}, "", `${url.pathname}${url.search}${url.hash}`);
}

async function processPaymentCallback() {
  const query = new URLSearchParams(window.location.search);
  const sessionId = nonEmpty(query.get("stripe_setup_session"));
  if (sessionId) { await completeStripeSetup(sessionId); return; }
  if (query.get("stripe_setup") === "cancelled") {
    sessionStorage.removeItem(redirectDraftKey); clearPaymentQuery(); state.flash = "Test-card setup was cancelled. Your draft is still here."; render();
  }
}

function handleDetection(event) {
  if (!event || typeof event !== "object") return;
  const marker = `${event.eventId || "unknown"}:${event.phase || "unknown"}`;
  if (state.seenEvents.has(marker)) return;
  state.seenEvents.add(marker);
  if (state.seenEvents.size > 250) state.seenEvents = new Set([...state.seenEvents].slice(-120));
  const rule = ruleById(event.ruleId);
  if (!rule || !rule.enabled || !isVersionTwo(rule)) return;
  const occurredAt = validDate(event.occurredAt) || new Date().toISOString();
  const correction = event.correction && typeof event.correction === "object" ? event.correction : null;
  const episodeId = nonEmpty(correction?.episodeId);
  const stage = Number(correction?.stage) === 2 ? 2 : 1;
  const current = state.preview;
  const sameEpisode = Boolean(current?.mode === "detector" && current.ruleId === rule.id && (!episodeId || !current.episodeId || current.episodeId === episodeId));
  const acknowledgedEpisode = episodeId ? state.acknowledgedDetectorEpisodes.has(`${rule.id}:${episodeId}`) : false;
  if (typeof correction?.warningArmed === "boolean") rule.warningArmed = correction.warningArmed;
  if (event.phase === "started") {
    if (stage === 1 && episodeId && (acknowledgedEpisode || sameEpisode && current.status !== "active")) return;
    state.preview = { ruleId: rule.id, mode: "detector", status: "active", stage, correction: correction || { stage: 1, status: "preview" }, episodeId, warningArmed: Boolean(correction?.warningArmed) };
    state.route = "intervention";
    addActivity({ source: "detector", ruleId: rule.id, text: stage === 2 ? "Your stake result arrived" : "Band sent a check-in", at: occurredAt });
  } else if (event.phase === "continued") {
    if (stage !== 2) {
      if (!sameEpisode || current.status !== "active" || current.stage === 2) return;
      current.correction = correction || current.correction;
      current.warningArmed = typeof correction?.warningArmed === "boolean" ? correction.warningArmed : current.warningArmed;
      addActivity({ source: "detector", ruleId: rule.id, text: "Band noticed the pattern again", at: occurredAt });
    } else {
      const changedResult = !sameEpisode || current.stage !== 2 || current.correction?.status !== correction?.status;
      state.preview = { ...(sameEpisode ? current : {}), ruleId: rule.id, mode: "detector", status: "active", stage: 2, correction: correction || { stage: 2, status: "pending" }, episodeId: episodeId || current?.episodeId || "", warningArmed: Boolean(correction?.warningArmed) };
      if (changedResult || state.route === "intervention") state.route = "intervention";
      addActivity({ source: "detector", ruleId: rule.id, text: "Your stake result arrived", at: occurredAt });
    }
  } else if (event.phase === "stopped") {
    if (sameEpisode) {
      current.status = "stopped";
      current.warningArmed = typeof correction?.warningArmed === "boolean" ? correction.warningArmed : current.warningArmed;
    }
    addActivity({ source: "detector", ruleId: rule.id, text: "Band closed the check-in", at: occurredAt });
  } else return;
  state.inboundRuleId = state.route === "intervention" ? null : rule.id;
  state.flash = state.route === "intervention" ? "" : "A band check-in arrived.";
  render();
}

function validDate(value) { return typeof value === "string" && !Number.isNaN(Date.parse(value)) ? value : ""; }

function openEvents() {
  if (!("EventSource" in window)) { state.sseStatus = "unavailable"; return; }
  try {
    const source = new EventSource("/api/events"); state.eventSource = source;
    source.addEventListener("open", () => { state.sseStatus = "open"; render(); });
    source.addEventListener("detection", (message) => { try { handleDetection(JSON.parse(message.data)); } catch { /* backend owns malformed payload rejection */ } });
    source.addEventListener("error", () => { if (state.sseStatus !== "waiting") { state.sseStatus = "waiting"; render(); } });
  } catch { state.sseStatus = "unavailable"; }
}

function focusElement(selector) { window.requestAnimationFrame(() => document.querySelector(selector)?.focus()); }
function closeHelp() { if (helpDialog.open) helpDialog.close(); }
function openHelp() { updateHelpCopy(); if (typeof helpDialog.showModal === "function" && !helpDialog.open) helpDialog.showModal(); else helpDialog.setAttribute("open", ""); window.requestAnimationFrame(() => helpClose.focus()); }

async function handleAction(action, element) {
  if (state.busy && !["home", "rules", "activity", "help"].includes(action)) return;
  switch (action) {
    case "home": clearSelectedRecording(); state.showCategoryPicker = false; state.route = "home"; state.error = null; state.flash = ""; render(); break;
    case "rules": clearSelectedRecording(); state.route = "rules"; state.error = null; state.flash = ""; await Promise.all([loadRules(), loadRecordings()]); render(); break;
    case "activity": clearSelectedRecording(); state.route = "activity"; state.error = null; state.flash = ""; render(); break;
    case "new-rule": clearSelectedRecording(); state.draft = emptyDraft(); state.showCategoryPicker = false; state.editingRuleId = null; state.route = "home"; state.error = null; state.flash = ""; render(); focusElement("#description"); break;
    case "starter": { const starter = starters.find((item) => item.id === element.dataset.starter); if (!starter) break; clearSelectedRecording(); state.editingRuleId = null; state.draft.description = starter.text; state.draft.behaviorId = starter.id; state.draft.matchMode = null; state.showCategoryPicker = false; state.route = "penalty"; state.error = null; state.flash = ""; render(); break; }
    case "classify": case "retry-classify": await classifyDescription(); break;
    case "edit-description": { const recording = recordingById(state.selectedRecordingId); if (recording) state.draft.description = recording.description; clearSelectedRecording(); state.route = "home"; state.error = null; state.flash = ""; render(); focusElement("#description"); break; }
    case "teach-habit": enterTeachForDifferentHabit(); break;
    case "change-category": state.showCategoryPicker = true; render(); break;
    case "choose-existing-habit": chooseExistingHabit(); break;
    case "create-recording": case "retry-create-recording": await createRecordingRequest(); break;
    case "cancel-recording": case "retry-cancel-recording": await cancelRecordingRequest(); break;
    case "retry-recording": await refreshSelectedRecording(); break;
    case "open-recording": openRecording(element.dataset.id); break;
    case "choose-amount": { const amount = Number(element.dataset.amount); if (amounts().includes(amount)) state.draft.penaltyAmount = amount; render(); break; }
    case "save-rule": case "retry-save": await saveRule(); break;
    case "open-rule": clearSelectedRecording(); state.selectedRuleId = element.dataset.id || null; state.route = "detail"; state.error = null; state.flash = ""; render(); break;
    case "view-inbound": state.selectedRuleId = state.inboundRuleId; state.route = "detail"; state.inboundRuleId = null; render(); break;
    case "try-preview": beginPreview(element.dataset.id); break;
    case "preview-next": advancePreview(); break;
    case "preview-stopped": await stopPreview(); break;
    case "preview-dismiss": await dismissPreview(); break;
    case "preview-reset": state.preview = null; state.inboundRuleId = null; render(); break;
    case "close-intervention": closeIntervention(); break;
    case "edit-rule": editRule(element.dataset.id); break;
    case "ask-delete": state.deleteRuleId = element.dataset.id || null; render(); break;
    case "cancel-delete": state.deleteRuleId = null; render(); break;
    case "confirm-delete": await deleteRule(element.dataset.id); break;
    case "reload-rules": await Promise.all([loadRules(), loadRecordings()]); render(); break;
    case "reload-recordings": await loadRecordings(); render(); break;
    case "setup-stripe": await setupStripe(); break;
    case "help": openHelp(); break;
    default: break;
  }
}

root.addEventListener("click", (event) => {
  const control = event.target.closest("[data-action]");
  if (!control || control.disabled) return;
  if (control.matches("input[type='checkbox']")) return;
  event.preventDefault(); handleAction(control.dataset.action, control);
});

root.addEventListener("input", (event) => {
  const field = event.target.dataset.field;
  if (!field || !(field in state.draft)) return;
  state.draft[field] = event.target.value;
});

root.addEventListener("change", (event) => {
  const toggle = event.target.closest("[data-action='toggle-rule']");
  if (toggle) { toggleRule(toggle.dataset.id, toggle.checked); return; }
  if (event.target.dataset.field === "behaviorId") {
    state.draft.behaviorId = behaviorById(event.target.value)?.id || null;
    state.draft.matchMode = null;
    state.showCategoryPicker = false;
    render();
  }
});

helpClose.addEventListener("click", closeHelp);
helpDone.addEventListener("click", closeHelp);
document.querySelectorAll("[data-icon]").forEach((element) => { element.innerHTML = icon(element.dataset.icon); });
window.addEventListener("beforeunload", () => { state.eventSource?.close(); stopTeachPolling(); });

render();
Promise.all([loadConfig(), loadRules(), loadRecordings()]).then(processPaymentCallback).finally(render);
openEvents();
