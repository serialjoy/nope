// The detector page: band motion -> Nope's /api/events.
import { Band, BandAudio, SimTransport } from "/vendor/vexo/index.js";
import { Detector, NopeReporter, SAMPLE_RATE } from "./core.mjs";

const $ = (id) => document.getElementById(id);
const params = new URLSearchParams(location.search);
const pretend = params.has("pretend");             // test only: a simulated band instead of Bluetooth
const replay = params.get("replay");               // test only: ?replay=/detector/test/x.wav&motion=/detector/test/x.json

let band = null;
let sound = null;
let classify = null;
let loop = null;
let ready = false;
let pendingReset = null;
const seenResets = new Set();
let bandNumber = 58;
let replayPlaying = false;
let connectionPending = false;
// Increment whenever input is removed so a finished detector step cannot report
// against a new connection.
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

function canConnectBluetooth() {
  return !replay && (pretend || Boolean(navigator.bluetooth));
}

function canConnectUsb() {
  return !pretend && !replay && Boolean(navigator.serial);
}

function syncConnectButtons() {
  $("clear-movement").disabled = !hasActiveInput();
  const available = ready;
  const unavailable = connectionPending || Boolean(band) || replayPlaying;
  $("connect").disabled = !available || unavailable || !canConnectBluetooth();
  $("connect-usb").disabled = !available || unavailable || !canConnectUsb();
}

function disableConnectButtons() {
  $("connect").disabled = true;
  $("connect-usb").disabled = true;
}

function clearDetectorInput() {
  detector.resetInput();
  audioDetector.resetInput();
  lastDecisionKey = "";
  recentChecks.length = 0;
  renderDecisionTrace();
  $("timing").textContent = "–";
  render();
}

const detector = new Detector({
  options: { motionOnly: true },
  onEvent: (event) => {
    if (!hasActiveInput() || stepGeneration !== inputGeneration) return;
    cancelMovementReset();
    log("Movement detected", "hit");
    reporter.report(event).catch((error) => log(`Nope: ${error.message}`));
  },
});

// The audio monitor never reports to Nope. Movement remains the only trigger.
const audioDetector = new Detector({
  classify: (audio) => classify(audio),
  options: { requireMotion: false },
});

function cancelMovementReset() {
  if (pendingReset) clearTimeout(pendingReset.timer);
  pendingReset = null;
}

function clearMovement(message = "Movement cleared. Ready for fresh movement; the cooldown still applies.") {
  cancelMovementReset();
  if (!hasActiveInput()) return;
  detector.clearMovement();
  audioDetector.resetInput();
  log(message);
  render();
}

$("clear-movement").addEventListener("click", () => clearMovement());

function openMovementResets() {
  if (!("EventSource" in window)) return;
  const source = new EventSource("/api/events");
  source.addEventListener("detector-reset", (message) => {
    let reset;
    try { reset = JSON.parse(message.data); } catch { return; }
    const episode = reporter.episodes.get("smoking");
    if (!reset || reset.bandNumber !== bandNumber || !hasActiveInput()
      || typeof reset.resetId !== "string" || seenResets.has(reset.resetId)
      || !episode || episode.rule !== reset.ruleId || episode.occurrenceId !== reset.occurrenceId) return;
    seenResets.add(reset.resetId);
    if (seenResets.size > 200) seenResets.delete(seenResets.values().next().value);
    cancelMovementReset();
    const generation = inputGeneration;
    const eventCount = detector.events.length;
    const token = { deadline: Date.now() + 3000, timer: null };
    pendingReset = token;
    token.timer = setTimeout(() => {
      if (pendingReset !== token) return;
      pendingReset = null;
      const current = reporter.episodes.get("smoking");
      if (!hasActiveInput() || generation !== inputGeneration || eventCount !== detector.events.length
        || !current || current.rule !== reset.ruleId || current.occurrenceId !== reset.occurrenceId) return;
      clearMovement("Movement automatically cleared after your response. Ready for fresh movement.");
    }, 3000);
    log("Response received. Clearing movement in 3 seconds.");
    render();
  });
  window.addEventListener("pagehide", () => { source.close(); cancelMovementReset(); }, { once: true });
}

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

function decisionCopy(decision, audio, gate) {
  switch (decision?.reason) {
    case "detected": return { title: "Movement detected", detail: "Sent to Nope. Lower your hand and hold still before the next movement." };
    case "awaiting_clear": return { title: "Lower your hand and hold still", detail: `Stillness checks ${gate?.clearCount || 0}/${gate?.clearRequired || 2}. One continuous movement counts once.` };
    case "cooldown": return { title: "Give it a moment", detail: `${cooldown(decision?.cooldownRemainingMs)} until another movement can count.` };
    case "waiting_for_motion": return { title: "Waiting for fresh movement data", detail: "Keep the band connected. Missing packets do not count as stillness." };
    default: return { title: "Ready for wrist movement", detail: "Move once for the warning. A separate second movement triggers the charge." };
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
  if (!gate?.armed) return `Hold still ${gate?.clearCount || 0}/${gate?.clearRequired || 2}`;
  if (finite(cooldownRemainingMs) && cooldownRemainingMs > 0) return `Wait ${cooldown(cooldownRemainingMs)}`;
  if (decision?.reason === "waiting_for_motion") return "Waiting for band data";
  return "Ready for next movement";
}

function renderDecisionTrace() {
  const list = $("decision-trace");
  list.replaceChildren();
  if (!recentChecks.length) {
    const empty = document.createElement("li");
    empty.className = "muted";
    empty.textContent = "Waiting for the first movement check.";
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
  const sound = "Movement only";
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
  $("clear-movement").disabled = !hasActiveInput();
  $("reset-note").textContent = pendingReset
    ? `Clearing movement in ${Math.max(0, (pendingReset.deadline - Date.now()) / 1000).toFixed(1)} s…`
    : "Clear movement resets the signal without disconnecting. The 5-second cooldown still applies.";
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
  $("lighter-state").textContent = lighterReadiness(lighterGate, decision, diagnostics?.cooldowns?.lighter, audio);
  drawGyroTrace(motion);
  rememberDecision(decision, audio, lighterGate);
}

function startTelemetry() {
  if (telemetryTimer) return;
  telemetryTimer = window.setInterval(renderDiagnostics, 100);
  renderDiagnostics();
}

function render() {
  const { scores, silent } = audioDetector.status;
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
    if (busy || !ready || !hasActiveInput()) return;
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
  }, 100);
}

function startAudioLoop() {
  let busy = false;
  setInterval(async () => {
    if (busy || !classify || !hasActiveInput()) return;
    busy = true;
    const generation = inputGeneration;
    try {
      await audioDetector.step();
      if (generation === inputGeneration) render();
    } catch (error) {
      if (generation === inputGeneration) log(`Audio monitor: ${error.message}`);
    } finally {
      busy = false;
    }
  }, 1000);
}

async function connect(mode) {
  if (mode !== "bluetooth" && mode !== "serial") return;
  if (connectionPending || hasActiveInput()) return;
  if (mode === "bluetooth" && !canConnectBluetooth()) return;
  if (mode === "serial" && !canConnectUsb()) return;
  const connectionLabel = mode === "serial" ? "USB" : pretend ? "simulated band" : "Bluetooth";
  connectionPending = true;
  disableConnectButtons();
  setState(`connecting via ${connectionLabel}…`);
  try {
    const transport = pretend ? { transport: new SimTransport(bandNumber) } : mode === "serial" ? { transport: "serial" } : {};
    band = await Band.connect(bandNumber, transport);   // must come from the click that called this
    const connectedBand = band;
    band.on("motion", (m) => detector.feedMotion(m.gx, m.gy, m.gz));
    const connectedSound = new BandAudio((samples) => {
      if (band === connectedBand && sound === connectedSound) audioDetector.feedAudio(samples);
    });
    sound = connectedSound;
    band.on("audio", (packet) => {
      if (band === connectedBand && sound === connectedSound) connectedSound.push(packet);
    });
    band.on("disconnect", ({ reason }) => {
      if (band !== connectedBand) return;
      if (reason !== "closed") { setState("band lost"); log(`The band disconnected (${reason}). Double-tap it and connect again.`); }
      cleanup();
    });
    await band.configure({ motion: 50, sensors: "both", audio: true });
    setState(`watching ${band.name} via ${connectionLabel}`);
    $("hint").textContent = "Movement controls Nope. The microphone is on for the separate sound monitor; audio is processed on this computer.";
    $("disconnect").disabled = false;
    syncConnectButtons();
    log(`Connected to ${band.name} via ${connectionLabel}.`);
  } catch (error) {
    const failedBand = band;
    await cleanup();
    if (failedBand) await failedBand.disconnect().catch(() => {});
    setState("not connected");
    log(`Could not connect: ${error.message}`);
    syncConnectButtons();
  } finally {
    connectionPending = false;
    syncConnectButtons();
  }
}

async function cleanup() {
  cancelMovementReset();
  inputGeneration += 1;
  replayPlaying = false;
  const oldSound = sound;
  sound = null;
  band = null;
  oldSound?.close?.();
  clearDetectorInput();
  await reporter.stopAll().catch(() => {});
  $("disconnect").disabled = true;
  syncConnectButtons();
}

$("connect").addEventListener("click", () => { void connect("bluetooth"); });
$("connect-usb").addEventListener("click", () => { void connect("serial"); });
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
    audioDetector.feedAudio(audio.subarray(i * chunk, (i + 1) * chunk));
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
  openMovementResets();
  ready = true;
  $("model").textContent = "Movement ready · loading audio monitor…";
  setState(replay ? "ready" : "ready: connect the band");
  startLoop();
  startAudioLoop();
  if (replay) playRecording();
  else syncConnectButtons();
  try {
    const { loadClap } = await import("./clap.mjs");
    classify = await loadClap((text) => { $("model").textContent = `Audio monitor: ${text}`; });
    $("model").textContent = "Audio monitor ready · movement still controls warnings and charges";
  } catch (error) {
    $("model").textContent = `Audio monitor unavailable: ${error.message}. Movement detection is still ready.`;
    log('Audio monitor could not load. Run npm run setup:detector if its files are missing.');
  }
})();
