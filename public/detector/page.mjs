// The detector page: band (Web Bluetooth) -> CLAP in the browser -> Nope's /api/events.
import { Band, BandAudio, SimTransport } from "/vendor/vexo/index.js";
import { Detector, NopeReporter, SAMPLE_RATE } from "./core.mjs";
import { loadClap } from "./clap.mjs";

const $ = (id) => document.getElementById(id);
const params = new URLSearchParams(location.search);
const pretend = params.has("pretend");             // test only: a simulated band instead of Bluetooth
const replay = params.get("replay");               // test only: ?replay=/detector/test/x.wav&motion=/detector/test/x.json

let band = null;
let sound = null;
let loop = null;
let classify = null;
let bandNumber = 58;
let replayPlaying = false;
// Increment whenever input is removed. A CLAP call can finish after a band
// disconnects, so its result must not be allowed to report against a new session.
let inputGeneration = 0;
let stepGeneration = null;
let telemetryTimer = null;
let lastDecisionKey = "";
const recentChecks = [];
const maxRecentChecks = 12;
const staleMotionAfterMs = 1500;

function setState(text) { $("state").textContent = text; }
function log(text, cls = "") {
  const list = $("log");
  if (list.firstElementChild?.classList.contains("muted")) list.innerHTML = "";
  const li = document.createElement("li");
  if (cls) li.className = cls;
  li.innerHTML = `<time>${new Date().toLocaleTimeString()}</time>`;
  li.append(text);
  list.prepend(li);
}

const reporter = new NopeReporter({ log: (m, extra) => log(extra ? `${m} → ${extra.status ?? ""} stage ${extra.stage ?? ""}` : m) });
function hasActiveInput() {
  return Boolean(band) || replayPlaying;
}

function clearDetectorInput() {
  detector.resetInput();
  lastDecisionKey = "";
  recentChecks.length = 0;
  renderDecisionTrace();
  $("timing").textContent = "–";
  render();
}

const detector = new Detector({
  classify: (audio) => classify(audio),
  onEvent: (event) => {
    if (!hasActiveInput() || stepGeneration !== inputGeneration) return;
    const label = event.kind === "lighter" ? "Lighter" : "Can opening";
    log(`${label} detected (${Math.round(event.confidence * 100)}%${event.motion_active ? ", wrist moving" : ""})`, "hit");
    reporter.report(event).catch((error) => log(`Nope: ${error.message}`));
  },
});
detector.options.requireMotion = $("require-motion").checked;
$("require-motion").addEventListener("change", (e) => { detector.options.requireMotion = e.target.checked; render(); });

function finite(value) { return typeof value === "number" && Number.isFinite(value); }
function friendlyLabel(value) { return String(value || "").replaceAll("_", " ").replace(/\b\w/g, (letter) => letter.toUpperCase()) || "Sound"; }
function percent(value) { return finite(value) ? `${Math.round(value * 100)}%` : "—"; }
function degrees(value) { return finite(value) ? `${value.toFixed(1)}°/s` : "—"; }
function age(value) {
  if (!finite(value)) return "—";
  if (value < 1000) return `${Math.max(0, Math.round(value))} ms ago`;
  return `${(value / 1000).toFixed(value < 10000 ? 1 : 0)} s ago`;
}
function cooldown(value) {
  if (!finite(value) || value <= 0) return "Ready";
  return `${(value / 1000).toFixed(value < 10000 ? 1 : 0)} s`;
}
function timeOf(value) {
  const stamp = finite(value) ? value : Date.parse(value);
  return Number.isFinite(stamp) ? new Date(stamp).toLocaleTimeString([], { hour: "numeric", minute: "2-digit", second: "2-digit" }) : "Just now";
}

function decisionCopy(decision, audio, lighterGate) {
  const top = decision?.topLabel ? `${friendlyLabel(decision.topLabel)} ${percent(decision.topScore)}` : "No sound score yet";
  const target = friendlyLabel(decision?.target || "lighter");
  const targetScore = percent(decision?.targetScore);
  const threshold = percent(decision?.threshold);
  switch (decision?.reason) {
    case "warming_up": return { title: "Collecting audio", detail: `${finite(audio?.bufferedSeconds) ? audio.bufferedSeconds.toFixed(1) : "0.0"} of ${finite(audio?.requiredSeconds) ? audio.requiredSeconds : "4"} seconds ready.` };
    case "quiet": return { title: "Waiting for sound", detail: `Audio is quiet (peak ${finite(decision?.audioPeak) ? decision.audioPeak.toFixed(3) : "—"}).` };
    case "other_sound": return { title: "Other sound won", detail: `${top}; ${target} was ${targetScore}.` };
    case "low_confidence": return { title: `${target} below confidence`, detail: `${target} was ${targetScore}; it needs ${threshold}.` };
    case "insufficient_motion": return { title: "Wrist motion too low", detail: `Movement strength was ${degrees(decision?.motionStd)}; it needs ${degrees(decision?.motionThreshold)}.` };
    case "cooldown": return { title: "Repeat cooldown", detail: `${cooldown(decision?.cooldownRemainingMs)} remains before another ${target.toLowerCase()} hit can be accepted.` };
    case "confirming": return { title: "Confirming lighter", detail: `${target} was ${targetScore}. Confirmation ${lighterGate?.confirmationCount || 0} of ${lighterGate?.confirmationRequired || 2}; another fresh qualifying check is needed.` };
    case "awaiting_clear": return { title: "Waiting for the signal to clear", detail: `Clear checks ${lighterGate?.clearCount || 0} of ${lighterGate?.clearRequired || 2} below ${percent(lighterGate?.resetThreshold ?? 0.4)} are needed before the next hit can be armed.` };
    case "waiting_for_audio": return { title: "Waiting for fresh audio", detail: "This window has not changed, so it cannot confirm or rearm a hit." };
    case "detected": return { title: "Accepted detection", detail: (decision?.motionRequired ?? detector.options.requireMotion) ? `${target} was ${targetScore}; movement passed the gate.` : `${target} was ${targetScore}; the motion filter was off.` };
    case "classifier_error": return { title: "Sound check failed", detail: "The model could not score this audio window. It was not accepted." };
    default: return { title: "Waiting for audio", detail: "The detector will explain the first blocker it sees." };
  }
}

function motionSummary(motion) {
  if (!detector.options.requireMotion) return { label: "Filter off", tone: "gate-waiting", note: "The sound check is not using wrist movement. Live motion is still shown." };
  if (!hasActiveInput()) return { label: "Disconnected", tone: "gate-waiting", note: "Not receiving motion. Connect a band or start a replay." };
  if (!motion?.latest) return { label: "Collecting", tone: "gate-waiting", note: "Waiting for the first gyroscope packet." };
  if (finite(motion.ageMs) && motion.ageMs > staleMotionAfterMs) return { label: "Stale", tone: "gate-waiting", note: `The latest gyroscope packet is ${age(motion.ageMs)}.` };
  if ((motion.sampleCount || 0) < (motion.minimumSamples || 20)) return { label: "Collecting", tone: "gate-waiting", note: `Collecting motion samples (${motion.sampleCount || 0} of ${motion.minimumSamples || 20}).` };
  if (motion.active) return { label: "On", tone: "gate-on", note: "Recent wrist movement is above the movement threshold." };
  return { label: "Off", tone: "gate-off", note: "Recent wrist movement is below the movement threshold." };
}

function lighterReadiness(gate, decision, cooldownRemainingMs) {
  if (!hasActiveInput()) return "Disconnected";
  if (decision?.reason === "warming_up") return "Collecting audio";
  if (!gate) return "Checking";
  if (!gate.armed) return `Waiting for signal clear ${gate.clearCount || 0}/${gate.clearRequired || 2}`;
  if (decision?.reason === "confirming") return `Confirming ${gate.confirmationCount || 0}/${gate.confirmationRequired || 2}`;
  if (decision?.reason === "waiting_for_audio") return "Waiting for fresh audio";
  if (finite(cooldownRemainingMs) && cooldownRemainingMs > 0) return "Armed · cooldown";
  return "Ready for next lighter";
}

function renderDecisionTrace() {
  const list = $("decision-trace");
  list.replaceChildren();
  if (!recentChecks.length) {
    const empty = document.createElement("li");
    empty.className = "muted";
    empty.textContent = "Waiting for the first sound check.";
    list.append(empty);
    return;
  }
  for (const item of recentChecks) {
    const row = document.createElement("li");
    const time = document.createElement("time");
    time.textContent = timeOf(item.at);
    const reason = document.createElement("span");
    reason.className = "trace-reason";
    reason.textContent = item.title;
    const detail = document.createElement("span");
    detail.className = "trace-detail";
    detail.textContent = item.detail;
    row.append(time, reason, detail);
    list.append(row);
  }
}

function rememberDecision(decision, audio, lighterGate) {
  if (!decision?.reason) return;
  const key = decision.checkId ? `check:${decision.checkId}` : finite(decision.at) ? `at:${decision.at}:${decision.reason}` : "";
  if (!key || key === lastDecisionKey) return;
  lastDecisionKey = key;
  const copy = decisionCopy(decision, audio, lighterGate);
  const sound = decision.topLabel ? `${friendlyLabel(decision.topLabel)} ${percent(decision.topScore)}` : "No sound score";
  const movement = finite(decision.motionStd) ? `movement ${degrees(decision.motionStd)}` : "movement unavailable";
  recentChecks.unshift({ at: decision.at, title: copy.title, detail: `${sound} · ${movement}` });
  if (recentChecks.length > maxRecentChecks) recentChecks.length = maxRecentChecks;
  renderDecisionTrace();
}

function drawGyroTrace(motion) {
  const canvas = $("gyro-trace");
  const bounds = canvas.getBoundingClientRect();
  const width = Math.max(1, Math.round(bounds.width));
  const height = Math.max(1, Math.round(bounds.height));
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  if (canvas.width !== width * dpr || canvas.height !== height * dpr) {
    canvas.width = width * dpr;
    canvas.height = height * dpr;
  }
  const context = canvas.getContext("2d");
  context.setTransform(dpr, 0, 0, dpr, 0, 0);
  const styles = getComputedStyle(document.documentElement);
  const background = styles.getPropertyValue("--bg").trim() || "#fff";
  const line = styles.getPropertyValue("--line").trim() || "rgba(22,22,22,.14)";
  context.clearRect(0, 0, width, height);
  context.fillStyle = background;
  context.fillRect(0, 0, width, height);

  const history = Array.isArray(motion?.history) ? motion.history.filter((point) => finite(point?.t)) : [];
  const latest = motion?.latest;
  const reference = finite(latest?.t) ? latest.t + Math.max(0, motion?.ageMs || 0) : Date.now();
  const start = reference - 10000;
  const points = history.filter((point) => point.t >= start && point.t <= reference);
  const values = points.flatMap((point) => [point.gx, point.gy, point.gz]).filter(finite);
  const extent = Math.max(25, ...values.map((value) => Math.abs(value)));
  const range = Math.ceil(extent / 25) * 25;
  $("gyro-range").textContent = `±${range}°/s scale`;
  const inset = 10;
  const graphHeight = Math.max(1, height - inset * 2);
  const xFor = (point) => inset + Math.max(0, Math.min(1, (point.t - start) / 10000)) * Math.max(1, width - inset * 2);
  const yFor = (value) => height / 2 - (value / range) * (graphHeight / 2);

  context.strokeStyle = line;
  context.lineWidth = 1;
  for (let step = 0; step <= 4; step += 1) {
    const y = inset + (graphHeight * step) / 4;
    context.beginPath(); context.moveTo(0, y); context.lineTo(width, y); context.stroke();
  }
  const stroke = (axis, color) => {
    let started = false;
    context.beginPath();
    for (const point of points) {
      if (!finite(point[axis])) continue;
      const x = xFor(point); const y = yFor(point[axis]);
      if (started) context.lineTo(x, y); else { context.moveTo(x, y); started = true; }
    }
    if (!started) return;
    context.strokeStyle = color;
    context.lineWidth = 1.7;
    context.stroke();
  };
  stroke("gx", styles.getPropertyValue("--blue").trim() || "#2775d8");
  stroke("gy", styles.getPropertyValue("--red").trim() || "#d24545");
  stroke("gz", styles.getPropertyValue("--violet").trim() || "#7653ce");
}

function renderDiagnostics() {
  const diagnostics = detector.diagnostics();
  const motion = diagnostics?.motion || {};
  const audio = diagnostics?.audio || {};
  const decision = diagnostics?.decision || {};
  const latest = motion.latest || {};
  $("gyro-x").textContent = degrees(latest.gx);
  $("gyro-y").textContent = degrees(latest.gy);
  $("gyro-z").textContent = degrees(latest.gz);
  $("motion-strength").textContent = `${degrees(motion.std)} / ${degrees(motion.threshold)}`;
  $("motion-samples").textContent = `${motion.sampleCount || 0} / ${motion.minimumSamples || 20} min`;
  $("motion-age").textContent = age(motion.ageMs);
  const summary = motionSummary(motion);
  const gate = $("motion-gate");
  gate.textContent = summary.label;
  gate.className = `pill ${summary.tone}`;
  $("motion-note").textContent = summary.note;
  const lighterGate = diagnostics?.gates?.lighter;
  const copy = decisionCopy(decision, audio, lighterGate);
  $("decision-reason").textContent = copy.title;
  $("decision-detail").textContent = copy.detail;
  $("cooldown-lighter").textContent = cooldown(diagnostics?.cooldowns?.lighter);
  $("cooldown-can_opening").textContent = cooldown(diagnostics?.cooldowns?.can_opening);
  $("lighter-state").textContent = lighterReadiness(lighterGate, decision, diagnostics?.cooldowns?.lighter);
  drawGyroTrace(motion);
  rememberDecision(decision, audio, lighterGate);
}

function startTelemetry() {
  if (telemetryTimer) return;
  telemetryTimer = window.setInterval(renderDiagnostics, 100);
  renderDiagnostics();
}

function render() {
  const { scores, silent } = detector.status;
  for (const kind of ["lighter", "can_opening"]) {
    const p = scores[kind] ?? 0;
    $(`p-${kind}`).textContent = silent || scores[kind] === undefined ? "–" : `${Math.round(p * 100)}%`;
    $(`b-${kind}`).style.width = `${Math.round(p * 100)}%`;
  }
  $("listening").textContent = silent ? "quiet" : "sound";
  renderDiagnostics();
}

function startLoop() {
  let busy = false;
  loop = setInterval(async () => {
    if (busy || !classify || !hasActiveInput()) return;
    busy = true;
    const generation = inputGeneration;
    stepGeneration = generation;
    const t = performance.now();
    try {
      await detector.step();
      if (generation !== inputGeneration) return;
      $("timing").textContent = `${Math.round(performance.now() - t)} ms`;
      render();
    } catch (error) {
      log(`Error: ${error.message}`);
    } finally {
      if (stepGeneration === generation) stepGeneration = null;
      busy = false;
    }
  }, 1000);
}

async function connect() {
  $("connect").disabled = true;
  setState("connecting…");
  try {
    band = await Band.connect(bandNumber, pretend ? { transport: new SimTransport(bandNumber) } : {});   // must come from the click that called this
    const connectedBand = band;
    band.on("motion", (m) => detector.feedMotion(m.gx, m.gy, m.gz));
    sound = new BandAudio((samples) => detector.feedAudio(samples));
    band.on("audio", (packet) => sound.push(packet));
    band.on("disconnect", ({ reason }) => {
      if (band !== connectedBand) return;
      if (reason !== "closed") { setState("band lost"); log(`The band disconnected (${reason}). Double-tap it and connect again.`); }
      cleanup();
    });
    await band.configure({ motion: 50, sensors: "both", audio: true });
    setState(`listening to ${band.name}`);
    $("hint").textContent = "The band's light is solid blue while the microphone is on.";
    $("disconnect").disabled = false;
    log(`Connected to ${band.name}.`);
  } catch (error) {
    const failedBand = band;
    await cleanup();
    if (failedBand) await failedBand.disconnect().catch(() => {});
    setState("not connected");
    log(`Could not connect: ${error.message}`);
    $("connect").disabled = !classify;
  }
}

async function cleanup() {
  inputGeneration += 1;
  replayPlaying = false;
  const oldSound = sound;
  sound = band = null;
  clearDetectorInput();
  oldSound?.close?.();
  await reporter.stopAll().catch(() => {});
  $("disconnect").disabled = true;
  $("connect").disabled = !classify;
}

$("connect").addEventListener("click", connect);
$("disconnect").addEventListener("click", async () => {
  try { await band.configure({ motion: 0, audio: false }); await band.disconnect(); } catch { /* already gone */ }
  setState("disconnected");
  cleanup();
});

// --- test mode: play a recording instead of a band -----------------------------------------------------
function parseWav(buffer) {                          // 16-bit PCM -> Float32 at 16 kHz
  const v = new DataView(buffer);
  let p = 12, rate = 16000, channels = 1, start = 0, length = 0;
  while (p + 8 <= v.byteLength) {
    const id = String.fromCharCode(v.getUint8(p), v.getUint8(p + 1), v.getUint8(p + 2), v.getUint8(p + 3));
    const n = v.getUint32(p + 4, true);
    if (id === "fmt ") { channels = v.getUint16(p + 10, true); rate = v.getUint32(p + 12, true); }
    if (id === "data") { start = p + 8; length = Math.min(n, v.byteLength - start); break; }
    p += 8 + n + (n & 1);
  }
  const frames = Math.floor(length / 2 / channels);
  const x = new Float32Array(frames);
  for (let i = 0; i < frames; i++) x[i] = v.getInt16(start + i * channels * 2, true) / 32768;
  if (rate === SAMPLE_RATE) return x;
  const out = new Float32Array(Math.round(frames * SAMPLE_RATE / rate));
  const k = (frames - 1) / (out.length - 1);
  for (let i = 0; i < out.length; i++) { const t = i * k, j = Math.floor(t); out[i] = x[j] * (1 - (t - j)) + x[Math.min(j + 1, frames - 1)] * (t - j); }
  return out;
}

async function playRecording() {
  const audio = parseWav(await (await fetch(replay)).arrayBuffer());
  const motion = params.get("motion") ? await (await fetch(params.get("motion"))).json() : [];
  replayPlaying = true;
  inputGeneration += 1;
  const generation = inputGeneration;
  setState("replaying a recording");
  log(`Replaying ${replay} (${(audio.length / SAMPLE_RATE).toFixed(0)} s)`);
  const chunk = SAMPLE_RATE / 10;                    // 100 ms at a time, in real time
  for (let i = 0, step = 0; i * chunk < audio.length; i++, step++) {
    if (!replayPlaying || generation !== inputGeneration) return;
    detector.feedAudio(audio.subarray(i * chunk, (i + 1) * chunk));
    for (const [gx, gy, gz] of motion.slice(step * 5, step * 5 + 5)) detector.feedMotion(gx, gy, gz);
    await new Promise((r) => setTimeout(r, 100));
  }
  if (generation !== inputGeneration) return;
  replayPlaying = false;
  inputGeneration += 1;
  clearDetectorInput();
  await reporter.stopAll().catch(() => {});
  setState("replay finished");
}

// --- start ---------------------------------------------------------------------------------------------
(async () => {
  try {
    const config = await (await fetch("/api/config")).json();
    bandNumber = config.bandNumber ?? bandNumber;
    reporter.bandNumber = bandNumber;
  } catch { /* keep the default */ }
  startTelemetry();
  if (!navigator.bluetooth && !replay && !pretend) {
    $("hint").textContent = "This browser has no Web Bluetooth. Open this page in Chrome or Edge on a computer.";
  }
  const started = performance.now();
  try {
    classify = await loadClap((text) => { $("model").textContent = `Sound model: ${text}`; });
    $("model").textContent = `Sound model: ready (loaded in ${((performance.now() - started) / 1000).toFixed(1)} s, runs on this computer)`;
    setState(replay ? "ready" : "ready: connect the band");
    startLoop();
    if (replay) playRecording();
    else $("connect").disabled = !navigator.bluetooth && !pretend;
  } catch (error) {
    $("model").textContent = `Sound model failed to load: ${error.message}. Run "npm run setup:detector" once.`;
    setState("model missing");
  }
})();
