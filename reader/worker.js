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

import { KokoroTTS } from "https://cdn.jsdelivr.net/npm/kokoro-js@1.2.1/+esm";

let tts = null;

// Inspect what generate() actually returns, hunting for anything
// timestamp/alignment-shaped. Reported once so we can settle the
// estimated-vs-exact highlight question with evidence.
function probeAudioObject(audio) {
  const keys = [];
  let o = audio;
  while (o && o !== Object.prototype) {
    keys.push(...Object.getOwnPropertyNames(o));
    o = Object.getPrototypeOf(o);
  }
  const suspicious = keys.filter(k =>
    /time|stamp|align|duration|token|phoneme|frame/i.test(k));
  return { keys: [...new Set(keys)], suspicious };
}

self.onmessage = async e => {
  const msg = e.data;
  try {
    if (msg.type === "load") {
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
      });

    } else if (msg.type === "synth") {
      for (let i = 0; i < msg.chunks.length; i++) {
        const t0 = performance.now();
        const audio = await tts.generate(msg.chunks[i], {
          voice: msg.voice || "af_heart",
          speed: msg.speed || 1.0,
        });
        const synthMs = performance.now() - t0;
        const data = audio.audio;           // Float32Array PCM
        const sampleRate = audio.sampling_rate;
        const audioSec = data.length / sampleRate;
        const probe = i === 0 ? probeAudioObject(audio) : undefined;
        self.postMessage(
          {
            type: "chunk",
            id: msg.id, i, n: msg.chunks.length,
            audio: data, sampleRate, synthMs, audioSec, probe,
          },
          [data.buffer],
        );
      }
      self.postMessage({ type: "synth-done", id: msg.id });
    }
  } catch (err) {
    self.postMessage({ type: "error", where: msg.type, message: String(err?.stack || err) });
  }
};

self.postMessage({ type: "boot" });
