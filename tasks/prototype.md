# End Itt mobile prototype

## Agreed outcome
User wears Vexo band 58. Their friend implements detection. We implement the mobile experience: describe a behavior in natural language, clarify its rule, describe escalating responses, review and activate, preview phone nudges and later consequences. User's attached image is design inspiration, not document-app content. Do not implement behavior classification or connect any band. Do not send messages, call contacts, or move money.

## Architecture and ownership
- Separate app at `/Users/cristian/Sites/Test_repos/pause`. Existing kit is unchanged, linked as nested `vexo-open-kit` for reference. Never edit through this link.
- Dependency-free Node 24 HTTP server, vanilla HTML/CSS/ES modules. Start `npm start` on 127.0.0.1:3000. Serve only public files; never expose root, env, or kit.
- `config.mjs` coordinator-owned: single BAND_NUMBER = 58 and default port.
- Backend executor owns server.mjs, lib/**, package.json, test/**, README.md, .env.example, .gitignore.
- Frontend executor owns public/** exclusively.
- No concurrent edits to another executor's files. No secrets in frontend. No generated build dependency required.

## Design contract
Name: End Itt (latest explicit user correction, capital E, capital I, double t, no exclamation; replaces provisional names). Friendly, precise, self-directed habit support. Never call a person an addict or claim a diagnosis. Directory stays `pause` while implementation is in flight. All references below to an older name mean End Itt.
Reference: white rounded mobile surfaces, enormous bold black sans-serif heading, pastel tiles, line icons in white circles, black pill navigation and round black action controls.
Palette: ink #101112; white #ffffff; canvas #e9ecef; muted #6f7378; lilac #ece3f6; cyan #ddf4f8; green #e4f5df; yellow #fff5bd. Fine border #e3e4e6. No gradients or colored shadows.
Type: Arial/Helvetica Neue bold for display (tight -0.055em, line-height 0.98); system sans for body (16px, 1.45). Display 48-56px mobile. All icons custom lightweight inline SVG, consistent 1.6-2 stroke, no emoji.
Layout: real responsive mobile app, max-width about 480px centered with white surface and rounded corners on gray desktop canvas; fill viewport on mobile, no fake iOS statusbar. Minimum tappable size 44px. Keep comfortable 24-28px gutters. Desktop presentation may have a quiet small brand/description beside phone but app itself is the focus. Prefer no extra surrounding content.
Signature: pastel escalation steps flow from a quiet cyan notification to lilac check-in to yellow stronger consequence, with clear waiting times. Huge headline and calm spacious UI. Do not clutter with implementation vocabulary. Demo/live capability appears truthfully as a small status label or help drawer.

## Screens and behavior
1. Home / describe. Header End Itt mark (small outlined stop icon) + small accessible help button. Heading `What would you like to change?` split intentionally. Supporting `Start with a habit. Make a plan that feels like you.` Large multiline natural-language input, proper visible label, placeholder `When I start scrolling at night, help me put my phone down.` Black round arrow submit. Four optional pastel starter tiles with line icons: `Less scrolling`, `Stop nail biting`, `Cut back on vaping`, `Something else`. Tiles populate editable prompt, never silently activate. Small caption `Your words. Your rules.` Black pill bottom nav for Home, My rules, Activity and a separate add-rule circle. No fake populated history.
2. Clarify. Back control and progress `1 Describe · 2 Clarify · 3 Respond` (or accessible visual equivalent). Show original user sentence in subtle lilac bubble. Big heading `Let's make it clear.` Ask one relevant plain-language question returned by /api/clarify. Editable answer with suggestion chips. No detector/sensor choices; friend handles those. Next button.
3. Responses. Heading `A nudge first. Then what?` First action always phone notification. Natural-language input for subsequent responses, e.g. `If I keep going for 5 minutes, ask me to check in. After 10 minutes, remind me to call my accountability partner.` Show subtle help with options (check-in, contact someone, commitment). User free text preserved. Submit generates plan using /api/plan; loading and error state with retry. `Demo rules` label if no Gemini backend; never imply AI answered when fallback did.
4. Review. `Your habit. Your rules.` Show behavior and trigger. Editable fields / back link, natural original responses, 2-3 pastel timeline cards with timing and exact response wording. First notification always. Distinguish a contact or financial commitment as preview only. `Activate rule` persists to backend and opens detail. Avoid modals stacked on modals.
5. My rules / detail. Saved cards with enabled toggle, edit, delete (confirmation), and `Try a preview`. Explain `Ready for detection` (not falsely connected) and show band number from config. Preview is visible and contained. Screen can receive friend events via SSE. Show first phone-like notification card inside app, buttons `I stopped`, `Not this time`/dismiss or `Still happening`. Continue explicitly moves to next step, countdown labels no forced wait in preview. Contact/payment steps indicate no call/charge made. Reset preview available. Activity chronological only for actual user previews or received events, marked Preview vs Detector. Pausing rule must prevent handling incoming detector events.
6. Help accessible sheet/modal explains natural-language setup, detection integration pending, preview consequences, Gemini config availability without secrets. Escape/back closes; focus sensible.

## Backend contract (frontend and backend must implement exactly)
All API JSON, errors `{error: string}` with appropriate status. Max body 32KiB.
GET /api/config => {bandNumber:58, aiMode:"gemini"|"demo", model:string|null}
POST /api/clarify {description:string} => {mode:"gemini"|"demo", question:string, suggestions:string[]}. Gemini actual call when key configured; otherwise template question appropriate to input; no fabricated Gemini usage.
POST /api/plan {description:string, clarification:string, responsePlan:string} => {mode, rule:{title:string,behavior:string,trigger:string,responsePlan:string,steps:Step[]}}. Preserve source descriptions. Step shape {kind:"notification"|"check_in"|"contact"|"commitment",afterMinutes:number,description:string,amount:number|null,contact:string|null}. first step notification at 0; steps sorted by increasing delay. 1-4 steps. Responses and timing reflect input; fallback should preserve ambiguous input in responsePlan and label draft for user review instead of inventing high-stakes specifics. Never add money or contact absent from input.
GET /api/rules => {rules:Rule[]}
POST /api/rules with draft rule => {rule:Rule}; creates id, enabled true, createdAt ISO. Validate fields, timing, kind. Rule adds {id,enabled,createdAt}.
PATCH /api/rules/:id with partial rule (enabled or reviewed content) => {rule}
DELETE /api/rules/:id => {ok:true}
GET /api/events => server-sent events, named event `detection`, data payload below. Send periodic keepalive.
POST /api/events {bandNumber:58,ruleId:string,eventId:string,phase:"started"|"continued"|"stopped",occurredAt?:ISO timestamp} => {ok:true,event:...}; validate correct band, known/enabled rule, deduplicate eventId. Emits detection SSE with {bandNumber,ruleId,eventId,phase,occurredAt,source:"detector"}. Do not trigger external side effects. Frontend starts preview panel as detector mode, starts at notification, continuation progresses only when elapsed since started reaches next step's afterMinutes (use occurredAt); stopped ends session. Reset on a new started event. Do not automatically progress simply from wall-clock time with no continued evidence. Backend returns 409 for paused rule. Rule remains independent of sensor implementation.
Keep rules in local untracked .data/rules.json with atomic writes. No raw audio stored. Frontend may keep preview activity locally, do not claim server notification was sent. No browser push permission required; preview is an in-app phone notification.

## Gemini implementation
Backend executor verify current official Gemini REST generateContent structured JSON docs before implementation. Use env GEMINI_API_KEY, optional GEMINI_MODEL (choose documented stable fast text model). Native fetch, timeout, plain-string bounded inputs; controlled JSON schema and validation. User text is data, cannot execute tools. No key in logs/browser or API responses. Missing key uses explicit demo; API error while configured returns safe actionable error, never silently pretends success. Use 2 short separate calls for clarify/plan. No need to install SDK for the REST endpoint. `.env.example` blank key; Node --env-file-if-exists=.env support. Server bind only loopback, reject cross-origin mutation, no arbitrary path traversal or APIs. Never dump upstream raw errors that could contain secret context.

## Acceptance
- App loads and full typed setup/clarify/respond/review/activate flow works without key, clearly Demo.
- Can edit/back without losing input; examples are only suggestions.
- Rule survives reload, pause/delete work, empty states are meaningful.
- Preview notification, subsequent response, stop/reset work; no contacts called or money moved.
- Friend can send documented localhost event using their detector and see SSE effect; no BLE needed.
- Responsive 390px and desktop, no horizontal overflow, keyboard focus, labels, reduced motion.
- Meaningful backend tests: wrong band rejected, paused rule rejected, event duplicate not emitted twice, bad schema refused, no secrets served; plan parser should not invent charges or contacts and respect common timing.
- Coordinator reviews rendered UI and integration before handoff.
