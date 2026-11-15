# Nope

Nope is a local, mobile-friendly habit-support app. Describe a habit, let Gemini classify it, choose a $1, $5, or $10 test consequence, and get a two-stage response: a nudge on the first distinct occurrence, then one Stripe test-charge attempt on the next distinct occurrence.

## Run locally

Requires Node 24 or newer. There are no package dependencies. The app is available at <http://127.0.0.1:3000/> and binds only to `127.0.0.1`.

For a new laptop with band 58, use Node 24+ and Chrome, then run:

```sh
git clone https://github.com/serialjoy/nope.git
cd nope
git clone https://github.com/VexoAI-Org/vexo-open-kit.git vexo-open-kit
git -C vexo-open-kit checkout 1e4291e
[ -f .env ] || cp .env.example .env
npm run setup:detector
npm start
```

`npm start` loads `.env` from the project root. Your clone does not include secrets, rules, or card data: each coworker must enter their own test keys manually and set up their own local test rule and card. `.env` is ignored by Git; never paste API keys into chat, a browser, or source code.

## Keys and classification

Set `GEMINI_API_KEY` and a Stripe test-only `STRIPE_SECRET_KEY` (`sk_test_` or `rk_test_` only). `GEMINI_DECISION_MODEL=gemini-decision-1` is optional.

Gemini decisions use the fixed endpoint `https://generativelanguage.googleapis.com/v1beta/decisions` and exactly six categories: Doom-scroll (`scrolling`), Nail biting (`nail_biting`), Vaping (`vaping`), Smoking (`smoking`), Porn (`porn`), and Snacks (`snacking`). Unsupported or low-confidence descriptions open a recording-request handoff instead of creating a rule or penalty; the person can still choose an existing habit if that is a better fit. The former `drinking` category is unsupported and is never reinterpreted as `porn`. With no Gemini key, built-in matching provides suggestions; a configured-key failure returns `502`.

## Recording-request handoff

An unknown habit can be saved as a request for the separate recorder and detector. Creating a request is **not** a recording, capture permission, trained model, active rule, detector event, or payment. One short sample may help the teammate build a detector, but it does not establish reliable detection; the detector still needs training and checking.

- `GET /api/recordings` returns `{ "recordings": [...] }`; `GET /api/recordings/:id` returns one request.
- `POST /api/recordings` accepts `{ "description", "behaviorId"? }`, where `behaviorId` is a supported catalog id or `null`. It returns a `requested` request for the configured band with a requested `durationSeconds` of `10`.
- The recorder reports `recording` and `recorded`; either the app or recorder can report `cancelled`. Every update must include the configured `bandNumber` and follows `requested → recording → recorded`, or `requested`/`recording → cancelled`.
- A `recorded` acknowledgment also needs a nonempty opaque `recordingRef` (at most 240 characters) and an integer `sampleCount` from 1 through 1,000,000. Nope never fetches or renders that reference as a URL; raw recordings stay with the recorder.
- Retries with the same status and completion metadata are idempotent. Completed and cancelled requests cannot be reopened. Up to 100 saved requests are retained; the server returns a clear conflict rather than silently removing older requests.

For the configured band, the recorder can copy these updates (the current `BAND_NUMBER` is 58):

```json
{ "bandNumber": 58, "status": "recording" }
```

```json
{
  "bandNumber": 58,
  "status": "recorded",
  "recordingRef": "recorder-owned-capture-id",
  "sampleCount": 240
}
```

Recording APIs do not create rules, post detector events, train anything, activate penalties, or call Stripe. A known classification is likewise not proof that a detector is available; detection remains the separate process's responsibility.

## Rules and test payments

- Start a rule: `POST /api/rules` with `{ "description", "behaviorId", "penaltyAmount" }`.
- Update it: `PATCH /api/rules/:id` with those same fields or `{ "enabled" }`; list rules with `GET /api/rules`.
- Old rules stay read-only and cannot charge until explicitly updated.
- Preview is always local and never calls Stripe. **Connect test card** opens Stripe's hosted setup flow; callbacks are verified server-side and the draft is restored.
- Real-money payments are disabled. Only test setup and one-time test charges are supported.

## Detector handoff

Band 58 connects through the separate browser detector described below, or your own detector process can send observations. Notifications appear inside the open main app; native/background phone push is not implemented.

Run the detector alongside this app on the same computer and post to `http://127.0.0.1:3000/api/events`. The server is local-only; another computer cannot reach it at that address. This repository runs independently of the Vexo SDK; keep hardware detection in your separate process and send the events below.

Send detector observations to `POST /api/events`:

```json
{
  "bandNumber": 58,
  "ruleId": "an-id-from-GET-/api/rules",
  "eventId": "unique-observation-id",
  "phase": "started",
  "occurrenceId": "gesture-2026-11-14T12:00:00.000Z"
}
```

`phase` is `started`, `continued`, or `stopped`; optional `occurredAt` is display-only. `occurrenceId` is optional but recommended: reuse it for packets from one detected gesture and use a new value only for a genuinely distinct occurrence. The first accepted occurrence returns a nudge and arms the rule. The next distinct occurrence reserves and attempts the configured test penalty immediately. `continued` never advances a nudge by elapsed time. Without `occurrenceId`, the detector must send `stopped` (or the app must call the stop endpoint) before another `started` can count as distinct.

The app can close or invalidate the active nudge with:

```json
POST /api/rules/:id/stop
{ "episodeId": "episode_from_correction", "reason": "stopped" }
```

`reason: "stopped"` closes that occurrence but retains the armed warning. `reason: "false_alarm"` clears only that active stage-one warning. A stale `episodeId` returns `409` and cannot affect a newer occurrence. Empty `{}` remains compatible as `stopped`.

Use a fresh `eventId` for every transport observation and reuse that same ID only to retry it. Reusing an `occurrenceId` never creates another occurrence or charge. A successful test charge (or demo penalty) resets the rule to its next nudge. Pending outcomes remain armed and reuse their original key and amount; after a confirmed failure, a later distinct occurrence may make a new attempt.

`GET /api/events` is an SSE stream with named `detection` events. When applicable, an event includes `correction` with `stage`, `status`, `episodeId`, `warningArmed`, and optional `amountDollars`, `paymentId`, or safe `message`. Stage one is `preview`; stage two is authoritative `demo`, `succeeded`, `pending`, `failed`, or `not_connected`.

## Persistence and safeguards

`.data/rules.json` stores rules, armed warnings, episodes, durable occurrence identities, and the last 1,000 event receipts. Durable charge keys, frozen payment inputs, and outcomes prevent duplicate charges across restarts. Do not delete `.data` or reset state while a charge is pending.

`.data/stripe-payments.json` stores only this app's Stripe customer/card state, never API keys.

`.data/recordings.json` stores only durable recording-request metadata and detector acknowledgments, never raw audio, motion samples, or trained models.

## Validation

```sh
npm run check
npm test
```

Verified coverage includes live Gemini smoking/vaping/porn/unsupported paths, the hosted Stripe test-card callback, repeat-occurrence charge deduplication, stop/pause behavior, and recording-request persistence, validation, cancellation, and idempotent acknowledgments. See [the simplified flow](tasks/simplify-flow.md) and [Teach Nope](tasks/teach-nope.md).

## Band detector in the browser

`public/detector.html` watches band 58's wrist movement and reports to this app. It needs Chrome or Edge on the same computer as this server. The microphone is off and no sound model loads in this mode.

```sh
npm run setup:detector   # once: downloads about 90 MB (model, runtime) and copies the Vexo kit's JavaScript
npm start
```

After setup, first open <http://127.0.0.1:3000/band-check.html> in Chrome to check the band 58 connection only; it loads no model and cannot create a charge. **Disconnect and close that check tab before connecting the detector:** the band supports one Bluetooth connection at a time. Set up your rule in the main app at <http://127.0.0.1:3000/>, then connect at <http://127.0.0.1:3000/detector.html> and keep both app and detector tabs open.

1. Make a fresh **Smoking** rule in the app for a clean test. Wrist movement is the trigger in this mode; it does not identify smoking.
2. Open <http://127.0.0.1:3000/detector.html>, double-tap the band, press **Connect band** and pick it. Keep this tab open.
   If Bluetooth keeps dropping, plug band 58 into the laptop with a USB data cable and choose **Connect via USB** instead. Pick the band's USB serial port; the kit verifies its band number before starting the detector.
3. Move once for the warning. Lower your hand and hold still, then move again at least 5 seconds after the first hit for the test-card charge. Each hit posts `started` with a unique occurrence ID; the server handles the rule and payment.

Movement uses a 0.6-second window with at least 20 fresh gyro samples and magnitude standard deviation above 25°/s. After a hit, two fresh stillness checks at least 250 ms apart (gyro RMS below 12.5°/s) rearm it. A 5-second minimum separates hits. Continuous movement and missing packets cannot rearm it. The core's original audio mode remains available to other callers; this page explicitly selects movement only.

If the movement signal stays latched, use **Clear movement** on the detector page. Responding to the first warning with **I stopped** or **False alarm** also schedules a detector clear three seconds after the response succeeds. These clears preserve the connection, event IDs, and five-second cooldown; only a fresh movement can create the next event. **I stopped** keeps the next charge armed, while **False alarm** cancels that warning as before.

The live diagnostics show gyro X/Y/Z, packet age, movement strength, stillness rearming, and the remaining cooldown. Historical audio evaluation does not validate this movement-only trigger.

Test pages (no band): `detector.html?pretend=1` uses the kit's simulated band; `detector.html?replay=/detector/test/x.wav&motion=/detector/test/x.json` plays a recording (files in `public/detector/test/`, not in git). `test/detector-core.test.mjs` covers the detection and episode logic.
