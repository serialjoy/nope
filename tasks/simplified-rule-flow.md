# Nope: simple rules and full-screen interventions

## User outcome

Keep the restored character branding. A user chooses a habit, picks a stake, and saves directly to My rules. A detector event opens a focused “Caught a loop?” screen. A qualifying repeat leads to a separate payment-result screen. Demo previews use the same presentation and never charge a card.

Reference: `/var/folders/h8/_rldf3tx3jq_tzt3nkw4gnq00000gn/T/codex-clipboard-9b20aaea-8982-4696-8abf-c13d7bcae117.png`.

## Frozen visual and navigation contract

- Home and its six original character tiles retain their restored branding. Clicking a known tile proceeds directly to stake configuration for that category. Natural-language submissions continue through the existing classifier. Unknown behavior keeps the Teach Nope path.
- Stake screen: `stake-page`, `stake-heading`, `stake-context`, `stake-options`, `stake-option`, `stake-promise`, `stake-actions`. Title “Set your stake.” on two lines, concise selected-habit context with a way back to change it, three large $1/$5/$10 options, the existing payment connection control and truthful demo/test state, one yellow explanation card, and “Start my rule” (or save edits). Remove the duplicated detailed stage cards and technical match badges from this main view. Preserve a manual category chooser where the existing fallback/Teach path requires one.
- Successful save navigates to My rules. Keep editing, pausing and deleting available through the existing detail view.
- Rules screen: `rules-page`, `compact-rules`, `compact-rule-card`, `rule-card-main`, `rule-mascot`, `compact-rule-title`, `rule-card-footer`, `rule-card-actions`. Title “My rules.” Large simple cards with a colored mascot tile, plain category title, compact stake/status, and Open / Try it. Avoid repeating the full description and time-rule details in the list. Keep unknown-behavior recording entries accessible.
- Rule mascots use the shared eyes asset on tomato/bubblegum/forest/butter backgrounds (`rule-mascot` plus the color class). Home character artwork is unchanged.
- Full-screen presentation uses `.intervention-shell` with `.nudge-shell`, `.charge-shell`, or `.result-shell`; `.intervention-page`, `.intervention-eyes`, `.intervention-kicker`, `.intervention-title`, `.intervention-copy`, `.intervention-actions`, `.intervention-status`. Hide normal bottom navigation on these screens.
- Nudge: butter background, giant cream eyes with forest pupils, forest headline “Caught a loop?”, copy “Take a breath. You can choose again.”, small habit context, primary “I stopped”, secondary “Still doing it” where supported by safe preview/acknowledgment semantics, and “False alarm”. Do not invent a manual real-payment endpoint just to support a visual button.
- Charge result: bubblegum background, the same large eyes, a clear amount and truthful status. Success title “That’s $5.” (dynamic amount), copy “Your test card was charged. Next time starts with a nudge.” Demo results instead say “Demo only. No money moved.” Pending title “Payment pending.”; failure/not-connected title “No charge.” with a short safe explanation. Pending, failed, disabled, and requires-action outcomes must never say a payment succeeded. Primary action “Back to my rules”.
- Previews must be clearly marked “Demo preview · no charge”; they must never call the detector-charge endpoint. First preview shows nudge; advancing it shows the simulated charge screen.
- Retain the cream/forest/tomato/butter/bubblegum palette and existing Arial/Helvetica family. Responsive at 320px and 390px. Large readable controls, keyboard focus, correct accessible button names, reduced-motion support. No extra animation or new dependencies.
- New asset `public/assets/nope-eyes.svg`: reuse the geometry/color language of the existing icon, two cream eyes looking right with forest pupils, transparent background, no rounded-square backing. CSS may size it; do not regenerate imagery.

## Confirmed recurrence policy

The user explicitly chose **“Until the next charge, then reset.”** First distinct occurrence shows a nudge and arms a warning without an expiry. “I stopped” closes the current occurrence while retaining that warning. The next distinct occurrence triggers the configured stake; a successful Stripe test charge or explicit simulated demo penalty resets the cycle to a warning next time. Failed or pending payments do not count as successful charges. False alarm invalidates the warning for that mistaken occurrence. Persist the warning state across refresh/server restart. Deduplicate events and distinguish new occurrences from continued sensor packets; do not charge just because two packets arrived. Main setup copy: “First time, a nudge. Next time, your stake.” No one-minute condition in this flow.

## Engineering boundaries

### Backend transition contract

- Retain the existing `started` / `continued` / `stopped` phases and event-ID deduplication. Add optional `occurrenceId`: repeating the same ID never creates another occurrence; a new explicit ID identifies a genuinely separate occurrence. Without it, require a stopped/UI-stop boundary before accepting another start; repeated starts during an active occurrence are not chargeable repeats.
- First accepted start creates a stage-one episode and persists an armed warning. The next accepted distinct start creates a stage-two episode and immediately reserves the stake using the existing persisted Stripe idempotency-key pattern. `continued` never promotes stage one to a charge based on time. It may resume an already pending stage-two reservation safely.
- Successful `succeeded` or explicit `demo` outcomes clear the armed warning. Failed/not-connected outcomes keep it armed; repeated packets for the completed failed episode do not repeatedly retry. A genuinely new occurrence may attempt the stake again. Keep stage and amount snapshotted per episode.
- Pending/ambiguous charge reservations belong to the armed cycle: a new occurrence must not bypass an unresolved attempt using a new key. Reuse the original pending key and amount across occurrences/restarts. Only a known terminal failure permits a new attempt/key on a future distinct occurrence. Distinguish uncertain transport outcomes from confirmed payment failure where needed.
- Freeze customer/payment-method parameters for retries as well as amount. If a pending PaymentIntent ID is known, retrieve its current authoritative status. If an unknown-ID ambiguous attempt ages beyond a conservative Stripe idempotency retention cutoff, do not POST it again: retain an unresolved state instead of risking a second charge. References: [retrieve](https://docs.stripe.com/api/payment_intents/retrieve), [idempotency](https://docs.stripe.com/api/idempotent_requests).
- Extend `POST /api/rules/:id/stop` with `reason: "stopped" | "false_alarm"` and optional `episodeId`. Default omitted reason to stopped for old callers. A supplied stale episode ID must not affect a newer episode. Stopped closes the occurrence but retains the warning; false alarm clears only the warning originating from that erroneous stage-one episode. Never undo a completed payment or claim a refund.
- Include `episodeId` and `warningArmed` in `event.correction`; stage one retains the existing `status: "preview"`, stage two has the authoritative payment outcome. Expose `warningArmed` in rule read responses so My rules can show “Warned” between a warning and successful charge. Preserve existing response shapes/fields as far as possible. Update detector docs with the additive occurrence ID and changed repeat policy.
- Pause/resume must not silently clear the armed warning. Preserve it for ordinary edits to the same behavior; changing the behavior starts a fresh cycle. Deleting a rule removes its cycle state. Old time-based episodes must not unexpectedly turn into charges after upgrade; start their repeat-policy cycle safely.
- Preserve serialized mutation, event receipt replay, durable charge reservation, same-key recovery, and test-only payment restrictions. Do not make direct Stripe calls from the browser.

- Preserve band 58, existing classifier, recorder integration, saved rules and Stripe test-only limits. Do not touch `.env`, stored user data, or the Vexo SDK.
- Reuse current server-side state and deduplication where possible. Payment success is authoritative only from the server's payment result.
- Show actual detector interventions promptly, and avoid reopening dismissed/stale notifications. A later payment result for an already acknowledged nudge must still be allowed to show.
- Keep compatibility with the coworker's documented detector integration. Any required contract extension must be documented and tested.
- Do not force-reset/rewrite history. The restored branding baseline is commit `7a9dd69`.

## Ownership

- UI executor: `public/app.js` and `public/index.html` only, including state/navigation/rendering and existing help copy.
- Style executor: `public/styles.css` and `public/assets/nope-eyes.svg` only. Match the class contract above.
- Backend executor: server/library modules, appropriate tests and detector integration documentation, after recurrence decision is confirmed.
- Coordinator: this spec, design decisions, integration review, browser QA and publishing. Concurrent agents must preserve one another's changes.

## Verification

Run syntax checks and existing tests plus meaningful recurrence/payment tests for any changed transitions. Browser-check tile-to-stake, text classification, save-to-rules, full-screen preview stages, actual stubbed detector intervention and payment failure/success distinctions on an isolated test server. Keep real user rules and payment setup untouched during verification.
