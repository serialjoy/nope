# Teach Nope: unknown-habit recording handoff

User request: when Nope does not know how to detect a habit, instruct the user to record an example, then publish the change. The teammate owns the real detector. Band 58 remains the only band, from config.mjs. Preserve the six cards, existing rules, payments, and pastel mobile design.

## Product contract

- A successful classification with no supported behavior goes to a new `teach` screen instead of the penalty screen. A classifier outage stays an error, not an unknown habit.
- Heading: `Show Nope what you mean.` Tag: `New habit`. Show the original description, editable through the existing home screen. Explain that a short example helps build a detector; a sample does not establish reliable detection.
- Give three short instructions: wear the band normally; capture about 10 seconds when the behavior naturally happens; the example must be checked before the habit can become an active rule. Do not encourage repeating harmful habits for training.
- Primary action: `Set up recording`. This creates a recording request, NOT a fake recording. No microphone/camera permissions, browser timers that pretend to capture data, fake training, or model-ready claims.
- Pending screen: `Waiting for your recorder` and clear text that no data is being recorded until the detector acknowledges the request. Show `Recording example` only after the recorder supplies that state; `Example recorded` only after a valid recorded acknowledgment. Recorded state says the detector still needs training and checking; there is no automatic rule activation or payment.
- User can cancel a pending/recording request. Completed or cancelled requests cannot be reopened. Offer `Choose an existing habit` as a secondary escape into the old manual-select penalty path. On the penalty screen add a quiet `Teach Nope a different habit` action so a mistaken recognized match can enter this flow too.
- Save requests server-side. Show noncancelled requests in My rules in a separate `Learning new habits` section, with status and an Open button, never a ready toggle or penalty. Restore/open a saved request after reload. Poll its status while its teach screen is open; stop polling on navigation/unload and avoid needless full-page rerenders.
- Help explains the recording handoff and that capture/training comes from the separate detector.

## Backend contract

Separate `lib/recordings-store.mjs`, persisted atomically in ignored `.data/recordings.json`. Serialize writes, do not mutate committed memory before successful persistence. No changes to rules/Stripe engine needed.

`GET /api/recordings` -> `{recordings: [...]}`.
`POST /api/recordings` `{description, behaviorId?: supported id|null}` -> 201 `{recording}`. Validate description like existing app, behaviorId from catalog when present. Server assigns id, bandNumber from config, requested durationSeconds=10, status=requested, createdAt/updatedAt, recordingRef=null, sampleCount=null. Cap stored requests at 100 with a clear error (no silently deleting data).
`GET /api/recordings/:id` -> `{recording}` or 404.
`PATCH /api/recordings/:id` -> `{recording}`. Body `{bandNumber:58,status:"recording"|"recorded"|"cancelled",recordingRef?,sampleCount?}`. Band number must exactly match config, even on cancellation. Allowed transitions requested->recording|cancelled, recording->recorded|cancelled. Repeat same state is idempotent only with the same completion metadata. Recorded requires a nonempty opaque recordingRef (max240 characters, not fetched/rendered as a URL) and integer sampleCount in 1..1000000. Wrong band/invalid payload400; invalid state transition409; absent404. Reject completion fields outside recorded status. Retain timestamps. Persist metadata only; raw band recordings stay with the teammate's recorder, identified by recordingRef. Validate only approved fields, never spread raw payload.

No training request creates a rule or enters /api/events; no test payment can happen through these endpoints. This is a real request/status handoff, not implemented training. Known classification is not proof of detector availability; docs must distinguish them.

## Ownership and verification

Frontend executor: public/app.js, public/styles.css, public/index.html only. Backend executor: server.mjs, lib/recordings-store.mjs, test/recordings.test.mjs, README.md only. Coordinator owns this spec and integration review. Other agents edit concurrently; never overwrite/revert their changes. No .env, .data, kit, global settings, commits, or external publishing from executors.

Run syntax checks and appropriate existing/new tests. Backend tests cover persisted lifecycle, invalid/missing/wrong-band data, transition conflicts/cancel races, completion validation, idempotency, and that no rule/payment is created. Coordinator checks unknown and known flows, cancellation, recorded acknowledgment in isolated data, mobile layout, then commits and pushes only reviewed code/docs.
