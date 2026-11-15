// CLAP (laion/clap-htsat-unfused, 8-bit quantized audio encoder) running in the browser through transformers.js.
// The text side is precomputed: text_embeds.json holds the 12 sound descriptions already embedded,
// so only the 34 MB audio encoder is downloaded. Everything is loaded from this server (no internet needed).
// Regenerate text_embeds.json with sound-lab/export_text_embeds.py if the labels or prompts change.
import { AutoProcessor, ClapAudioModelWithProjection, env } from "/vendor/transformers.min.js";

const MODEL = "Xenova/clap-htsat-unfused";

function resample(x, outLength) {                 // linear interpolation, same as the evaluated Python code
  const y = new Float32Array(outLength);
  const k = (x.length - 1) / (outLength - 1);
  for (let i = 0; i < outLength; i++) {
    const t = i * k;
    const j = Math.floor(t);
    const f = t - j;
    y[i] = x[j] * (1 - f) + x[Math.min(j + 1, x.length - 1)] * f;
  }
  return y;
}

/** Loads the model once. Returns an async function: 16 kHz Float32Array -> { label: probability }. */
export async function loadClap(onStatus = () => {}) {
  env.allowRemoteModels = false;                  // never reach for the internet
  env.allowLocalModels = true;
  env.localModelPath = "/models/";
  env.backends.onnx.wasm.wasmPaths = "/vendor/ort/";
  env.backends.onnx.wasm.numThreads = 1;          // multi-threading needs special page headers; one thread is fast enough

  onStatus("Loading text embeddings…");
  const text = await (await fetch("/detector/text_embeds.json")).json();
  onStatus("Loading the sound model (34 MB)…");
  const processor = await AutoProcessor.from_pretrained(MODEL);
  const model = await ClapAudioModelWithProjection.from_pretrained(MODEL, { dtype: "q8", device: "wasm" });

  return async function classify(audio16k) {
    const features = await processor(resample(audio16k, audio16k.length * 3));   // the model wants 48 kHz
    const { audio_embeds: { data: e } } = await model(features);
    let norm = 0;
    for (const v of e) norm += v * v;
    norm = Math.sqrt(norm);
    const logits = text.embeds.map((t) => {
      let dot = 0;
      for (let i = 0; i < t.length; i++) dot += t[i] * e[i] / norm;
      return dot * text.scale;
    });
    const max = Math.max(...logits);
    const exp = logits.map((l) => Math.exp(l - max));
    const sum = exp.reduce((a, b) => a + b, 0);
    return Object.fromEntries(text.labels.map((label, i) => [label, exp[i] / sum]));
  };
}
