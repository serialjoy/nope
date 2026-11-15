// One-time setup for the in-browser detector (public/detector.html). Downloads about 90 MB of files that are
// not kept in git: the transformers.js bundle, the ONNX WebAssembly runtime, the quantized CLAP audio encoder,
// and a copy of the Vexo kit's JavaScript (MIT licence). Safe to run again: existing files are skipped.
//
//   npm run setup:detector
import { copyFile, mkdir, readdir, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const TRANSFORMERS = "4.3.2";
const ORT = "1.31.0-dev.20260914-8d85527a0";           // the onnxruntime-web build that transformers.js 4.3.2 ships with
const jsdelivr = (pkg, file) => `https://cdn.jsdelivr.net/npm/${pkg}/${file}`;
const hf = (file) => `https://huggingface.co/Xenova/clap-htsat-unfused/resolve/main/${file}`;

const DOWNLOADS = [
  [jsdelivr(`@huggingface/transformers@${TRANSFORMERS}`, "dist/transformers.min.js"), "public/vendor/transformers.min.js"],
  ...["ort-wasm-simd-threaded.asyncify.mjs", "ort-wasm-simd-threaded.asyncify.wasm", "ort-wasm-simd-threaded.mjs", "ort-wasm-simd-threaded.wasm"]
    .map((f) => [jsdelivr(`onnxruntime-web@${ORT}`, `dist/${f}`), `public/vendor/ort/${f}`]),
  [hf("config.json"), "public/models/Xenova/clap-htsat-unfused/config.json"],
  [hf("preprocessor_config.json"), "public/models/Xenova/clap-htsat-unfused/preprocessor_config.json"],
  [hf("onnx/audio_model_quantized.onnx"), "public/models/Xenova/clap-htsat-unfused/onnx/audio_model_quantized.onnx"],
];

async function exists(file) {
  try { return (await stat(file)).size > 0; } catch { return false; }
}

for (const [url, target] of DOWNLOADS) {
  const file = path.join(root, target);
  if (await exists(file)) { console.log(`have  ${target}`); continue; }
  await mkdir(path.dirname(file), { recursive: true });
  const response = await fetch(url);
  if (!response.ok) throw new Error(`${url} -> HTTP ${response.status}`);
  const bytes = Buffer.from(await response.arrayBuffer());
  await writeFile(file, bytes);
  console.log(`got   ${target}  (${(bytes.length / 1e6).toFixed(1)} MB)`);
}

// The Vexo kit's browser library, from the sibling folder (git clone of vexo-open-kit next to this app).
const kit = path.resolve(root, "..", "vexo-open-kit", "js", "src");
if (!(await exists(path.join(kit, "index.js")))) {
  throw new Error(`Cannot find the Vexo kit at ${kit}. Put the vexo-open-kit folder next to this one.`);
}
async function copyDir(from, to) {
  await mkdir(to, { recursive: true });
  for (const entry of await readdir(from, { withFileTypes: true })) {
    if (entry.isDirectory()) await copyDir(path.join(from, entry.name), path.join(to, entry.name));
    else if (entry.name.endsWith(".js")) await copyFile(path.join(from, entry.name), path.join(to, entry.name));
  }
}
await copyDir(kit, path.join(root, "public/vendor/vexo"));
console.log("copied public/vendor/vexo  (Vexo kit JavaScript)");
console.log("\nDone. Start the app with `npm start` and open http://127.0.0.1:3000/detector.html in Chrome.");
