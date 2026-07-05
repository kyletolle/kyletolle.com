// espeak-ng npm build as a phonemize backend for server_phonemize.mjs's
// pluggable pipeline (setPhonemizeBackend). Exists because Apple WebKit stalls
// forever loading the `phonemizer` package's espeak WASM (separate .data
// package via emscripten's XHR path) — this build embeds all data in one
// ~18.5 MB wasm fetched with plain fetch(), which Safari handles fine
// (proven on-device 2026-07-05, /espeak-test/ probe).
//
// The build is CLI-shaped: each call instantiates the module and runs main()
// with argv. Compilation is the expensive part, so the WebAssembly.Module is
// fetched + compiled ONCE and reused — per-call cost is instantiate + run
// (~0.2-0.4s on Apple hardware).
import ESpeakNg from "espeak-ng";

let wasmModule = null;   // Promise<WebAssembly.Module>
function compiled() {
  if (!wasmModule) {
    // Same-origin next to the bundles — served by both the stage server
    // (/reader/) and the prod Worker (root); copied from
    // node_modules/espeak-ng/dist by `npm run build`.
    const url = new URL("espeak-ng.wasm", self.location.href);
    wasmModule = WebAssembly.compileStreaming(fetch(url));
  }
  return wasmModule;
}

// Optional warmup so callers can surface "downloading espeak…" before the
// first phonemize rather than during it.
export function espeakWarm() { return compiled(); }

// backend contract (see server_phonemize.mjs): (text, espeakLang) -> string[]
// of IPA lines. espeakLang is "en-us" | "en" — same values the pipeline hands
// the phonemizer package.
export async function espeakPhonemize(text, espeakLang) {
  const mod = await compiled();
  // argv-passed text: a leading "-" would parse as a flag; a leading space
  // defuses that and espeak ignores it as text.
  const arg = text.startsWith("-") ? ` ${text}` : text;
  const espeak = await ESpeakNg({
    instantiateWasm: (imports, done) => {
      WebAssembly.instantiate(mod, imports).then(inst => done(inst));
      return {};
    },
    arguments: ["--phonout", "generated", "-q", "--ipa", "-v", espeakLang, arg],
  });
  const out = espeak.FS.readFile("generated", { encoding: "utf8" });
  return out.split("\n").map(s => s.trim()).filter(Boolean);
}
