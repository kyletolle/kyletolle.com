// Synthesis worker — all kokoro-js / ONNX Runtime work happens here so the UI
// thread never janks. Protocol (postMessage):
//   in:  { type: "load", device, dtype, modelId }
//   out: { type: "load-progress", file, loaded, total }
//        { type: "ready", device, dtype, loadMs, probe }   probe = API surface notes
//   in:  { type: "synth", id, chunks: [string], voice, speed }
//   out: { type: "chunk", id, i, n, audio: Float32Array (transferred),
//          sampleRate, synthMs, audioSec, tokens? }
//        { type: "synth-done", id }
//   any: { type: "error", where, message }

// Bare specifier — this file is the *source* for worker.bundle.js (esbuild).
// Safari blocks cross-origin module imports in workers under COEP, so the
// worker must be fully same-origin: never ship it unbundled.
import { KokoroTTS } from "kokoro-js";
// Same physical module kokoro-js uses (hoisted): lets us tune ORT's wasm
// backend before the session is created.
import { env as hfEnv } from "@huggingface/transformers";
// Kokoro's model context is 512 tokens (≈510 phoneme chars); text past that is
// SILENTLY TRUNCATED mid-word (observed 2026-07-03 — dense technical prose
// blows the limit at ~370 chars while simple prose fits at 400+). We measure
// with the same phonemizer kokoro-js uses and sub-split oversized chunks.
import { phonemize } from "phonemizer";

const MAX_PH = 440;   // phoneme-char budget per generate() call, with margin

async function phLen(text) {
  const ph = await phonemize(text, "en-us");
  return (Array.isArray(ph) ? ph.join(" ") : ph).length;
}

// Split chunk text into pieces that each fit the model context. Cuts at the
// sentence boundary nearest the middle, falling back to a word boundary, so
// the seams land where speech naturally pauses.
async function safePieces(text) {
  if ((await phLen(text)) <= MAX_PH) return [text];
  const mid = Math.floor(text.length / 2);
  let cut = -1;
  const re = /[.!?;:]["')\]]?\s+/g;
  let m;
  while ((m = re.exec(text))) {
    const end = m.index + m[0].length;
    if (cut < 0 || Math.abs(end - mid) < Math.abs(cut - mid)) cut = end;
  }
  if (cut <= 0 || cut >= text.length) {
    cut = text.lastIndexOf(" ", mid);
    if (cut <= 0) cut = mid;
  }
  const a = text.slice(0, cut).trim();
  const b = text.slice(cut).trim();
  if (!a || !b) return [text];   // unsplittable; let the model do what it can
  return [...(await safePieces(a)), ...(await safePieces(b))];
}

// espeak-ng (phonemizer) initializes lazily on the first phonemize() call — it
// loads its WASM data package before resolving. On iOS Safari that load can
// never signal completion, hanging phonemize() forever (observed 2026-07-03;
// not reproducible on Linux WebKit). Bound it so a stall fails loudly instead
// of freezing the reader on "phonemizing…".
function withTimeout(p, ms, label) {
  return Promise.race([
    p,
    new Promise((_, rej) => setTimeout(() => rej(new Error(`${label} timed out after ${ms / 1000}s`)), ms)),
  ]);
}

let tts = null;
let currentJob = null;   // newest synth id wins; older loops exit at next await
let serverMode = false;  // true once local phonemization is known to stall (Apple WebKit)

// Offload phonemization to the staging server (faramir runs espeak fine) and
// return kokoro-IPA strings, one per token-budget piece. Same-origin POST.
async function serverPhonemize(text, voice) {
  const r = await fetch(new URL("phonemize", self.location.href), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ text, voice }),
  });
  if (!r.ok) throw new Error(`phonemize server HTTP ${r.status}`);
  const { pieces, error } = await r.json();
  if (error) throw new Error(`phonemize server: ${error}`);
  return pieces;
}

self.onmessage = async e => {
  const msg = e.data;
  try {
    if (msg.type === "load") {
      // Threaded WASM needs crossOriginIsolated (COOP/COEP — our hosting sets
      // them). ORT's default thread count is conservative; give it the cores,
      // minus one for the UI/decoder. Must be set BEFORE session creation.
      const ua = self.navigator?.userAgent || "";
      // iOS/iPadOS Safari deadlocks on ORT's nested WASM worker threads — the
      // synth loop stalls forever with no error (observed on iPhone 2026-07-03,
      // while Linux WebKit runs the same threaded path fine). Single-thread is
      // slower but actually completes. iPadOS 13+ masquerades as "Macintosh", so
      // fall back to the touch-points tell.
      const isApple = /iP(hone|od|ad)/.test(ua) ||
        (/Macintosh/.test(ua) && (self.navigator?.maxTouchPoints || 0) > 1);
      const cores = self.navigator?.hardwareConcurrency || 4;
      let threads = self.crossOriginIsolated ? Math.min(Math.max(cores - 1, 1), 8) : 1;
      if (isApple) threads = 1;
      // Detected Apple WebKit can't run espeak in-browser — go straight to the
      // server phonemizer so it skips the 20s local-stall wait. Undetected Apple
      // (iPadOS desktop UA) still gets caught by the timeout fallback below.
      if (isApple) serverMode = true;
      try { hfEnv.backends.onnx.wasm.numThreads = threads; } catch {}
      const t0 = performance.now();
      tts = await KokoroTTS.from_pretrained(
        msg.modelId || "onnx-community/Kokoro-82M-v1.0-ONNX",
        {
          dtype: msg.dtype,
          device: msg.device,
          progress_callback: p => {
            if (p.status === "progress") {
              self.postMessage({
                type: "load-progress",
                file: p.file, loaded: p.loaded, total: p.total,
              });
            }
          },
        },
      );
      const loadMs = performance.now() - t0;
      const voices = tts.voices ? Object.keys(tts.voices) : [];
      self.postMessage({
        type: "ready",
        device: msg.device, dtype: msg.dtype, loadMs, voices,
        threads, cores, isolated: !!self.crossOriginIsolated, apple: isApple,
      });

    } else if (msg.type === "synth") {
      currentJob = msg.id;
      for (let i = 0; i < msg.chunks.length; i++) {
        if (currentJob !== msg.id) break;   // superseded by a newer speak
        self.postMessage({ type: "synth-start", id: msg.id, i, n: msg.chunks.length });
        try {
          const t0 = performance.now();
          const voice = msg.voice || "af_heart";
          const speed = msg.speed || 1.0;
          self.postMessage({ type: "synth-progress", id: msg.id, i, stage: "phonemize" });

          // `pieces` is either raw text (local espeak works) or pre-phonemized
          // IPA strings (server fallback). `phonemed` says which, so the loop
          // below picks generate() vs tokenizer + generate_from_ids.
          let pieces, phonemed = false;
          if (!serverMode) {
            // 20s is generous for phonemization (it's espeak *init* that hangs,
            // not the work); a real device finishes in seconds. On stall, flip to
            // the server for the rest of the session.
            try {
              pieces = await withTimeout(safePieces(msg.chunks[i]), 20000, "phonemizer (espeak init)");
            } catch (err) {
              serverMode = true;
              self.postMessage({ type: "info", message: `local phonemizer stalled (${err.message}) — switching to server phonemization for this session` });
            }
          }
          if (serverMode) {
            pieces = await serverPhonemize(msg.chunks[i], voice);
            phonemed = true;
          }

          const parts = [];
          let sampleRate = 24000;
          for (let pi = 0; pi < pieces.length; pi++) {
            if (currentJob !== msg.id) break;
            self.postMessage({ type: "synth-progress", id: msg.id, i, stage: "generate", piece: pi + 1, pieces: pieces.length });
            let audio;
            if (phonemed) {
              const { input_ids } = tts.tokenizer(pieces[pi], { truncation: true });
              audio = await tts.generate_from_ids(input_ids, { voice, speed });
            } else {
              audio = await tts.generate(pieces[pi], { voice, speed });
            }
            parts.push(audio.audio);
            sampleRate = audio.sampling_rate;
          }
          if (currentJob !== msg.id) break;
          let data;
          if (parts.length === 1) data = parts[0];
          else {
            data = new Float32Array(parts.reduce((a, p) => a + p.length, 0));
            let off = 0;
            for (const p of parts) { data.set(p, off); off += p.length; }
          }
          const synthMs = performance.now() - t0;
          const audioSec = data.length / sampleRate;
          self.postMessage(
            {
              type: "chunk",
              id: msg.id, i, n: msg.chunks.length,
              chars: msg.chunks[i].length, pieces: pieces.length,
              audio: data, sampleRate, synthMs, audioSec,
            },
            [data.buffer],
          );
        } catch (err) {
          // Surface and keep going — one bad chunk shouldn't kill the read.
          self.postMessage({
            type: "chunk-error",
            id: msg.id, i, message: String(err?.message || err),
          });
        }
      }
      if (currentJob === msg.id) self.postMessage({ type: "synth-done", id: msg.id });
    }
  } catch (err) {
    self.postMessage({ type: "error", where: msg.type, message: String(err?.stack || err) });
  }
};

self.postMessage({ type: "boot" });
