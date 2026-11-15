# Detector motion monitoring

## Outcome
Show whether band 58's hand movement is arriving, how it compares with the movement threshold, and why a first or repeated detection did or did not reach Nope. The user selected a shorter repeat cooldown of 5 seconds; each hit still requires lighter sound plus movement.

## Frozen scope
- Preserve the current requirement: a target sound is top-ranked and >= its threshold, movement gate passes when enabled, and a 5-second per-target cooldown has elapsed.
- Shorten only the default cooldown from 15 to 5 seconds, as requested. Do not lower thresholds or make generic wrist movement trigger a payment.
- Keep the existing band connection, classifier, reporter, and disconnect/in-flight safeguards.
- Add bounded sensor history and readable, non-mutating diagnostics in `public/detector/core.mjs`.
- Add live motion traces and a compact decision panel in `public/detector.html` and `public/detector/page.mjs`. Graphs refresh independently of audio classification, including quiet input.
- Keep all processing local. No raw sensor upload, new dependencies, SDK edits, or another band number.

## Core contract
Expose `detector.diagnostics()` returning a fresh plain object:
```
{
  motion: { active, std, threshold, sampleCount, minimumSamples: 20,
    latest: { t, gx, gy, gz } | null, ageMs: number | null,
    history: [{ t, gx, gy, gz }] },
  audio: { bufferedSeconds, requiredSeconds, peak, silent },
  decision: { reason, at, target, topLabel, topScore, targetScore,
    threshold, cooldownRemainingMs, motionStd, motionActive,
    motionSampleCount, audioPeak, checkId },
  cooldowns: { lighter: number, can_opening: number }
}
```
Time values use the existing injected `now()` clock, and remaining cooldown is recalculated on each diagnostics read. Motion history retains at most 10 seconds and is bounded at 1,000 samples. The current movement calculation remains standard deviation of gyro magnitude over the most recent 4 seconds; threshold 25 degrees/second, at least 20 samples.

`decision.reason` is one of `warming_up`, `quiet`, `other_sound`, `low_confidence`, `insufficient_motion`, `cooldown`, `detected`, `classifier_error`. Publish each check's reason and actual input metrics. Empty or invalid classifier scores should not produce a hit. Errors may still propagate to the existing page error handler after the diagnostic reason is recorded. Diagnostics reads must not change cooldowns, decisions, or detection state.

Decision metrics are the snapshot used for that check, while `motion` is current live data. The UI uses the captured decision movement strength for historical check rows and a monotonic `checkId` to avoid duplicate rows.

Expose `detector.resetInput()` to clear buffered audio, motion/history and diagnostic input values without forgetting accepted-event cooldowns or IDs. Page cleanup/replay completion should use it instead of directly clearing the old three fields. New API must preserve existing `motionActive()` callers and existing status fields.

## UI
- Expand desktop layout to accommodate a 10-second gyro X/Y/Z trace, with legend and degrees/second labels; fit mobile without horizontal overflow.
- Show live X/Y/Z values, rolling movement strength versus threshold, sample count, latest packet age, and motion gate on/off. Distinguish disconnected/stale/collecting data from genuinely still.
- Show the last decision in plain English: collecting audio, waiting for sound, other sound won, lighter below confidence, wrist motion too low, cooldown with live seconds remaining, or accepted detection.
- Prominently explain: “Each hit currently needs a new lighter sound + wrist movement. Movement alone does not trigger Smoking.” Show the 5-second repeat cooldown with countdown.
- Refresh motion display at about 10 fps independently of the 1 Hz classifier loop. Do not aria-live announce every sensor sample.
- Keep a bounded recent-check trace with time, top sound/confidence, movement strength and reason; do not flood the existing detection log.
- Diagnostic display must never call reporter or create detector events.

## Ownership and validation
- Core executor owns `public/detector/core.mjs` and `test/detector-core.test.mjs`.
- UI executor owns `public/detector.html` and `public/detector/page.mjs`.
- Meaningful core tests cover quiet-input motion visibility, cooldown countdown before/after repeated hits, input reset, bounded history, and empty classifier output.
- Root reviews changes, tests layout and live band telemetry, runs full checks, commits and pushes after review.

## Follow-up: reduce random Smoking triggers
The user reports random hand-to-mouth detections and asks for a quick fix within 20 minutes. This section overrides the earlier preserve-threshold requirement for `lighter` only. Wrist activity remains a corroborating signal, never a mouth-position claim.
- Raise default lighter sound threshold from 0.50 to 0.75; leave can-opening at 0.50 and gyro threshold unchanged.
- Require two consecutive eligible lighter checks on fresh audio, at least 500 ms apart. Both must pass sound and enabled-motion gates. Any non-qualifying fresh check resets the streak. Publish `confirming` reason after the first.
- After an accepted lighter hit, disarm lighter until two fresh checks at least 500 ms apart have lighter score below 0.40 (or silent audio). Publish `awaiting_clear` while held. Qualifying signal must build a new two-check streak after clear; clearing itself never emits an event.
- The 5-second cooldown remains a minimum between accepted hits. Cooldown alone cannot rearm a continuous signal.
- Do not advance confirmation or rearm counts when audio has not advanced since the last check; publish `waiting_for_audio` and do not call the classifier on duplicate audio.
- Input reset clears streaks and audio freshness, but retains the post-hit latch and accepted cooldowns/IDs. After reconnect, genuinely fresh clear audio can rearm normally.
- Diagnostics expose confirmation/clear counts and required counts (2), armed state, and reset threshold so UI can explain the exact gate. Add `confirming`, `awaiting_clear`, and `waiting_for_audio` reasons.
- Test one marginal/transient hit rejected, two fresh sustained hits accepted, duplicate audio cannot confirm, sustained sound cannot create another event after 5 seconds, two clear windows rearm, next confirmed hit after cooldown accepted, and can-opening behavior unchanged.
- Explain in the UI: lighter score 75%, two confirming checks, signal must clear between hits, 5-second minimum cooldown. No generic motion-only trigger. The classifier windows overlap, so two checks establish persistence, not independent proof.
