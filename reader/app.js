// reader — client-side TTS player. Ported from local-tts index.html: the
// global timeline over N audio chunks, scrubbing, skips, replay-sentence,
// click-any-word-to-seek, pitch-preserved speed, and the estimated
// follow-along word highlight all transfer unchanged. What changed: chunks
// arrive from the synthesis Web Worker (kokoro-js) instead of a server's
// long-polled WAV endpoints, and durations are measured from the PCM itself.

import { chunkText } from "./chunker.js";
import { buildDocument } from "./mdrender.js";

const $ = s => document.querySelector(s);
const PRESETS = [1, 1.25, 1.5, 1.75, 2, 2.5, 3];
let speed = +(localStorage.getItem("reader.speed") || 1.5);

/* ---- engines: on-device kokoro (wasm/webgpu) vs cloud (Unreal Speech). Cloud
   runs off-device — no client compute, works where kokoro can't (all Apple
   WebKit), and returns real per-word timestamps for exact follow-along. ---- */
const UNREAL_VOICES = ["Scarlett", "Dan", "Liv", "Will", "Amy"];
const DEFAULT_KOKORO_VOICES = [...document.querySelectorAll("#voice option")].map(o => o.value);
const APPLE_MOBILE = /iP(hone|od|ad)/.test(navigator.userAgent) ||
  (/Macintosh/.test(navigator.userAgent) && navigator.maxTouchPoints > 1);
let kokoroVoices = [];
const isCloud = () => $("#device").value === "cloud";
function populateVoices(list, want) {
  const sel = $("#voice");
  sel.innerHTML = "";
  for (const v of list) {
    const o = document.createElement("option");
    o.value = o.textContent = v;
    o.selected = v === want;
    sel.appendChild(o);
  }
}
function b64ToUrl(b64, mime) {
  const bin = atob(b64);
  const a = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) a[i] = bin.charCodeAt(i);
  return URL.createObjectURL(new Blob([a], { type: mime }));
}

const audio = new Audio();
audio.preservesPitch = true;
if ("mozPreservesPitch" in audio) audio.mozPreservesPitch = true;
if ("webkitPreservesPitch" in audio) audio.webkitPreservesPitch = true;

let job = null;          // { id, n, chunks:[{i, words, _timings?}], durations:[], resolvers:[], blobs:[] }
let curIdx = 0;
let gen = 0;             // cancels superseded chunk loads
let srcGen = 0;          // gen when the current audio.src was installed
let scrubbing = false;
let modelReady = false;
let loadRequested = false;
let pendingSpeak = null; // text queued behind a model load
let speakT0 = 0;
let firstAudioReported = false;
let unlockPending = false;  // the 50ms unlock-silence is playing; swallow its "ended"

/* ---- synthesis heartbeat: a phone can take tens of seconds per chunk, so a
   silent "synthesizing…" reads as a hang. Tick a live elapsed + ready count so
   slow is visibly distinct from dead. ---- */
let synthIdx = -1, synthAt = 0, synthStage = "", synthTimer = null;
function synthHeartbeat() {
  if (!job || synthIdx < 0) return;
  const el = ((performance.now() - synthAt) / 1000).toFixed(0);
  const ready = job.durations.filter(d => d != null).length;
  status(`synthesizing ${synthIdx + 1}/${job.n}${synthStage} · ${el}s · ${ready}/${job.n} ready`);
}
function startHeartbeat() { synthHeartbeat(); if (!synthTimer) synthTimer = setInterval(synthHeartbeat, 500); }
function stopHeartbeat() { synthIdx = -1; if (synthTimer) { clearInterval(synthTimer); synthTimer = null; } }

const fmt = s => {
  s = Math.max(0, s | 0);
  return `${(s / 60) | 0}:${String(s % 60).padStart(2, "0")}`;
};
const status = m => { $("#status").textContent = m; $("#status0").textContent = m; };
const logEl = $("#log");
const log = m => {
  logEl.textContent += m + "\n";
  logEl.scrollTop = logEl.scrollHeight;
};

/* ---- WAV encoding (Float32 PCM → blob URL) ---- */
function encodeWav(f32, rate) {
  const len = f32.length;
  const buf = new ArrayBuffer(44 + len * 2);
  const v = new DataView(buf);
  const ws = (o, s) => { for (let i = 0; i < s.length; i++) v.setUint8(o + i, s.charCodeAt(i)); };
  ws(0, "RIFF"); v.setUint32(4, 36 + len * 2, true); ws(8, "WAVE");
  ws(12, "fmt "); v.setUint32(16, 16, true); v.setUint16(20, 1, true);
  v.setUint16(22, 1, true); v.setUint32(24, rate, true);
  v.setUint32(28, rate * 2, true); v.setUint16(32, 2, true); v.setUint16(34, 16, true);
  ws(36, "data"); v.setUint32(40, len * 2, true);
  for (let i = 0; i < len; i++) {
    const s = Math.max(-1, Math.min(1, f32[i]));
    v.setInt16(44 + i * 2, s < 0 ? s * 0x8000 : s * 0x7fff, true);
  }
  return URL.createObjectURL(new Blob([buf], { type: "audio/wav" }));
}

/* ---- timeline math (durations fill in as chunks synthesize, in order) ---- */
function offsets() {
  const o = [0];
  for (let i = 0; i < job.n; i++) o[i + 1] = o[i] + (job.durations[i] || 0);
  return o;
}
function totalKnown() {                 // duration of the contiguous ready prefix
  let t = 0;
  for (let i = 0; i < job.n; i++) {
    if (job.durations[i] == null) break;
    t += job.durations[i];
  }
  return t;
}
function globalTime() { return offsets()[curIdx] + (audio.currentTime || 0); }

/* per-word timing estimate within a chunk: distribute the chunk's real audio
   duration across its words by length + punctuation pause. Re-anchored every
   chunk, so error can't accumulate. (kokoro-js exposes no real timestamps —
   verified 2026-07-02; sample-accurate would need the -timestamped ONNX
   export and a custom generate path.) */
function wordTimings(i) {
  const c = job.chunks[i];
  if (c._timings) return c._timings;
  const dur = job.durations[i];
  if (dur == null) return null;
  const weights = c.words.map(w => {
    let base = Math.max(1, w.replace(/[^\w]/g, "").length || 1);
    if (/[.!?]["')\]]?$/.test(w)) base += 6;
    else if (/[,;:]$/.test(w)) base += 3;
    else if (/[—–-]$/.test(w)) base += 2;
    return base;
  });
  const sum = weights.reduce((a, b) => a + b, 0) || 1;
  let t = 0;
  c._timings = c.words.map((w, k) => {
    const d = dur * weights[k] / sum;
    const seg = { start: t, end: t + d };
    t += d;
    return seg;
  });
  return c._timings;
}

/* ---- chunk blobs: deferred promises resolved as the worker delivers ---- */
function chunkBlob(i) { return job.blobs[i]; }
const prefetch = () => {};  // synthesis is already eager; nothing to prefetch

/* ---- playback ---- */
async function gotoChunk(c, localT, autoplay) {
  const myGen = ++gen;
  curIdx = c;
  const starved = job.durations[c] == null;
  if (starved) {
    status(`buffering — synthesizing chunk ${c + 1}/${job.n}…`);
    // Waiting on the very first chunk is just startup (TTFA covers it), not
    // playback outrunning synthesis.
    if (totalKnown() > 0) log(`STARVED at chunk ${c + 1} — playback outran synthesis (RTF × speed > 1: lower the speed or try another dtype; on this machine check the debug RTF numbers per dtype)`);
  }
  let url;
  try { url = await chunkBlob(c); }
  catch (e) { status(String(e.message || e)); return; }
  if (starved && c + 1 < job.n) {
    // Consolidate stalls: once we've been caught out, buffer one chunk of
    // lookahead before resuming instead of stuttering at every boundary.
    await Promise.race([chunkBlob(c + 1), job.doneP]).catch(() => {});
  }
  if (myGen !== gen) return;                 // a newer seek superseded us
  unlockPending = false;                     // real audio replaces the unlock silence
  srcGen = myGen;
  audio.src = url;
  audio.playbackRate = speed;
  await new Promise(res => audio.addEventListener("loadedmetadata", res, { once: true }));
  if (myGen !== gen) return;
  audio.currentTime = Math.min(localT || 0, Math.max(0, (audio.duration || 0) - 0.03));
  if (autoplay) {
    try {
      await audio.play();
      if (!firstAudioReported) {
        firstAudioReported = true;
        const ms = performance.now() - speakT0;
        log(`>>> TIME-TO-FIRST-AUDIO: ${(ms / 1000).toFixed(2)}s`);
      }
    } catch (e) {
      status("playback blocked by browser — press ▶");
      log(`play failed: ${e.message}`);
    }
  }
}

function seek(T, forcePlay) {
  const resume = forcePlay || !audio.paused;
  T = Math.max(0, Math.min(T, totalKnown()));
  const o = offsets();
  let c = 0;
  while (c + 1 < job.n && o[c + 1] <= T) c++;
  gotoChunk(c, T - o[c], resume);
}
const skip = d => seek(globalTime() + d);

function stopPlayback() {
  gen++;
  stopHeartbeat();
  audio.pause();
  audio.removeAttribute("src");
  audio.load();
  curIdx = 0;
  $("#scrub").value = 0;
  $("#time").textContent = `0:00 / ${fmt(job ? totalKnown() : 0)}`;
  document.querySelectorAll(".w.cur").forEach(e => e.classList.remove("cur"));
}

/* ---- rendering ---- */
function renderReader(html) {
  const pane = $("#pane");
  if (html) { pane.innerHTML = html; return; }
  pane.innerHTML = "";
  for (const ch of job.chunks) {
    ch.words.forEach((w, wi) => {
      const s = document.createElement("span");
      s.className = "w";
      s.dataset.c = ch.i; s.dataset.w = wi;
      s.textContent = w;
      pane.appendChild(s);
      pane.appendChild(document.createTextNode(" "));
    });
  }
}
let _curWord = null;
function highlight(gt) {
  const t = wordTimings(curIdx);
  if (!t) return;
  const localT = gt - offsets()[curIdx];
  let idx = t.findIndex(s => localT < s.end);
  if (idx < 0) idx = t.length - 1;
  const el = document.querySelector(`.w[data-c="${curIdx}"][data-w="${idx}"]`);
  if (el && el !== _curWord) {
    if (_curWord) _curWord.classList.remove("cur");
    el.classList.add("cur");
    el.scrollIntoView({ block: "center", behavior: "smooth" });
    _curWord = el;
  }
}

audio.onplay = () => { $("#play").textContent = "⏸"; };
audio.onpause = () => { $("#play").textContent = "▶"; };
audio.onended = () => {
  // The unlock silence ending must not advance the player (or crash pre-job),
  // and neither may audio that a newer seek has already superseded (a jump to
  // a pending chunk leaves the old audio playing until its blob arrives).
  if (unlockPending || !job) { unlockPending = false; return; }
  if (srcGen !== gen) return;
  if (curIdx + 1 < job.n) gotoChunk(curIdx + 1, 0, true);
  else status("done");
};
audio.ontimeupdate = () => {
  if (!job) return;
  const gt = globalTime();
  if (!scrubbing) $("#scrub").value = gt;
  $("#time").textContent = `${fmt(gt)} / ${fmt(totalKnown())}`;
  highlight(gt);
};

/* ---- speeds ---- */
function renderSpeeds() {
  const box = $("#speeds");
  box.innerHTML = "";
  for (const v of PRESETS) {
    const b = document.createElement("button");
    b.textContent = v + "×";
    b.className = v === speed ? "active" : "";
    b.onclick = () => {
      speed = v; audio.playbackRate = v;
      localStorage.setItem("reader.speed", v);
      [...box.children].forEach(c => c.classList.toggle("active", c === b));
    };
    box.appendChild(b);
  }
}

/* ---- environment report (debug panel) ---- */
async function reportEnv() {
  const bits = [];
  bits.push(`UA: ${navigator.userAgent}`);
  bits.push(`crossOriginIsolated: <b>${self.crossOriginIsolated}</b>`);
  let gpu = "no navigator.gpu";
  if (navigator.gpu) {
    try {
      const a = await navigator.gpu.requestAdapter();
      gpu = a ? "adapter OK" : "present but no adapter";
      if (a) {
        // Available but NOT the default: wasm/q8 is the portable baseline.
        // WebGPU output is garbled on Firefox even at fp32 (observed 2026-07),
        // and quantized dtypes garble on WebGPU everywhere (hexgrad/kokoro#98).
        const opt = document.createElement("option");
        opt.value = "webgpu"; opt.textContent = "webgpu (experimental)";
        $("#device").appendChild(opt);
      }
    } catch (e) { gpu = `adapter error: ${e.message}`; }
  }
  bits.push(`WebGPU: <b>${gpu}</b>`);
  bits.push(`cores: ${navigator.hardwareConcurrency}`);
  $("#env").innerHTML = bits.join("<br>");
}

/* ---- worker ---- */
const worker = new Worker("./worker.bundle.js", { type: "module" });
worker.onerror = e => {
  status("worker failed to start");
  log(`WORKER ERROR: ${e.message || "(no message)"} @ ${e.filename || "?"}:${e.lineno || "?"}`);
};

worker.onmessage = e => {
  const m = e.data;
  if (m.type === "boot") log("worker booted");
  else if (m.type === "info") log(m.message);
  else if (m.type === "load-progress") {
    const bar = $("#dlbar");
    bar.style.display = "";
    const mb = b => (b / 1048576).toFixed(1);
    if (m.total) {
      bar.value = m.loaded / m.total;
      status(`downloading model — ${mb(m.loaded)}/${mb(m.total)} MB`);
    } else {
      bar.removeAttribute("value");
      status(`downloading model — ${mb(m.loaded)} MB so far`);
    }
  } else if (m.type === "ready") {
    modelReady = true;
    $("#dlbar").style.display = "none";
    localStorage.setItem("reader.warm", `${m.device}/${m.dtype}`);
    log(`model loaded in ${(m.loadMs / 1000).toFixed(1)}s  device=${m.device} dtype=${m.dtype} threads=${m.threads}/${m.cores} isolated=${m.isolated}${m.apple ? " apple=1(single-thread)" : ""}`);
    status(`model ready (${m.device}/${m.dtype})`);
    if (m.voices?.length) {
      kokoroVoices = m.voices;
      if (!isCloud()) populateVoices(kokoroVoices, localStorage.getItem("reader.voice") || "af_heart");
    }
    if (pendingSpeak != null) { const t = pendingSpeak; pendingSpeak = null; speak(t); }
  } else if (m.type === "synth-start") {
    if (job && m.id === job.id) { synthIdx = m.i; synthAt = performance.now(); synthStage = ""; startHeartbeat(); }
  } else if (m.type === "synth-progress") {
    if (job && m.id === job.id) {
      if (m.stage === "phonemize") synthStage = " (phonemizing)";
      else if (m.stage === "generate") synthStage = m.pieces > 1 ? ` (piece ${m.piece}/${m.pieces})` : " (generating)";
      synthHeartbeat();
    }
  } else if (m.type === "chunk") {
    if (!job || m.id !== job.id) return;     // stale job
    const rtf = (m.synthMs / 1000) / m.audioSec;
    const split = m.pieces > 1 ? `, ${m.pieces} pieces` : "";
    log(`chunk ${m.i + 1}/${m.n} (${m.chars} chars${split}): ${m.synthMs.toFixed(0)}ms for ${m.audioSec.toFixed(1)}s audio (RTF ${rtf.toFixed(2)})`);
    job.durations[m.i] = m.audioSec;
    job.resolvers[m.i](encodeWav(m.audio, m.sampleRate));
    $("#scrub").max = totalKnown() || 0;
    $("#time").textContent = `${fmt(globalTime())} / ${fmt(totalKnown())}`;
  } else if (m.type === "chunk-error") {
    if (!job || m.id !== job.id) return;
    // Skip the bad chunk with a beat of silence — one failure must not halt
    // the whole read (and it silently did, before 2026-07-03).
    log(`chunk ${m.i + 1} FAILED (skipping): ${m.message}`);
    job.durations[m.i] = 0.2;
    job.resolvers[m.i](encodeWav(new Float32Array(4800), 24000));
    $("#scrub").max = totalKnown() || 0;
  } else if (m.type === "synth-done") {
    if (job && m.id === job.id) { stopHeartbeat(); status(""); job.doneResolve(); }
  } else if (m.type === "error") {
    stopHeartbeat();
    status(`error in ${m.where} — see debug log`);
    log(`ERROR (${m.where}): ${m.message}`);
  }
};

function requestLoad() {
  if (loadRequested) return;
  loadRequested = true;
  status("loading model…");
  worker.postMessage({
    type: "load",
    device: $("#device").value,
    dtype: $("#dtype").value,
  });
}

/* ---- cloud engine (Unreal Speech): faramir proxies text -> mp3 + real
   per-word timestamps, so follow-along is exact rather than length-estimated.
   Fills the same job fields the worker does, so playback/seek are unchanged. ---- */
function realTimings(spanWords, apiWords) {
  // Unreal splits on whitespace like our chunker, so words line up 1:1. On any
  // mismatch, return null and let the length-weighted estimate take over.
  if (!apiWords.length || apiWords.length !== spanWords.length) return null;
  return apiWords.map(w => ({ start: w.start, end: w.end }));
}
const AUTH_MSG = "cloud password rejected — check the Password field";
async function cloudSynth(myJob) {
  const voice = $("#voice").value || "Scarlett";
  // The /tts proxy (Cloudflare Worker) holds the Unreal key and gates on a
  // password; empty pass → Worker returns 401, handled below.
  const pass = $("#cloudkey") ? $("#cloudkey").value : "";
  let authFailed = false;
  for (let i = 0; i < myJob.n; i++) {
    if (job !== myJob) return;                 // superseded by a newer speak
    status(`synthesizing ${i + 1}/${myJob.n}…`);
    const chunkText = myJob.chunks[i].words.join(" ");
    try {
      if (authFailed) throw new Error(AUTH_MSG);   // gate already rejected — stop hammering it
      const r = await fetch("tts", {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${pass}` },
        body: JSON.stringify({ text: chunkText, voice }),
      });
      if (r.status === 401 || r.status === 403) { authFailed = true; throw new Error(AUTH_MSG); }
      const data = await r.json();
      if (!r.ok || data.error) throw new Error(data.error || `HTTP ${r.status}`);
      if (job !== myJob) return;
      const words = data.words || [];
      myJob.durations[i] = words.length ? words[words.length - 1].end : 0.2;
      myJob.chunks[i]._timings = realTimings(myJob.chunks[i].words, words);
      myJob.resolvers[i](b64ToUrl(data.audio, data.mime));
      log(`chunk ${i + 1}/${myJob.n}: ${words.length} words, ${myJob.durations[i].toFixed(1)}s (cloud/${voice})`);
    } catch (e) {
      if (job !== myJob) return;
      log(`chunk ${i + 1} FAILED (skipping): ${e.message}`);
      if (authFailed) status(AUTH_MSG);
      myJob.durations[i] = 0.2;
      myJob.chunks[i]._timings = null;
      myJob.resolvers[i](encodeWav(new Float32Array(4800), 24000));   // resolve, so nothing downstream hangs
    }
    $("#scrub").max = totalKnown() || 0;
    $("#time").textContent = `${fmt(globalTime())} / ${fmt(totalKnown())}`;
  }
  if (job === myJob) { status(authFailed ? AUTH_MSG : ""); myJob.doneResolve(); }
}

/* ---- speak ---- */
function speak(text) {
  text = (text || "").trim();
  if (!text) { status("nothing to speak"); return; }

  // Unlock the audio element inside the tap gesture: synthesis finishes long
  // after the tap, and iOS Safari rejects play() calls that aren't
  // gesture-adjacent.
  unlockPending = true;
  audio.src = encodeWav(new Float32Array(1200), 24000);
  audio.play().catch(() => {});

  const cloud = isCloud();
  if (!cloud && !modelReady) {
    pendingSpeak = text;
    requestLoad();
    return;
  }

  gen++;
  _curWord = null;
  firstAudioReported = false;

  let html = null, words;
  if ($("#md").checked) {
    ({ html, chunks: words } = buildDocument(text));
  } else {
    words = chunkText(text).map(c => c.split(/\s+/));
  }
  if (!words.length) { status("no speakable text"); return; }
  const texts = words.map(w => w.join(" "));

  const id = Date.now();
  let doneResolve;
  job = {
    id,
    n: texts.length,
    chunks: words.map((w, i) => ({ i, words: w })),
    durations: new Array(texts.length).fill(null),
    resolvers: [], rejecters: [], blobs: [],
    doneP: new Promise(res => { doneResolve = res; }),
  };
  job.doneResolve = doneResolve;
  for (let i = 0; i < texts.length; i++) {
    job.blobs.push(new Promise((res, rej) => { job.resolvers.push(res); job.rejecters.push(rej); }));
  }

  log(`\nspeak: ${text.length} chars → ${texts.length} chunks (first=${texts[0].length} chars)`);
  $("#composer").classList.add("hidden");
  $("#reader").classList.remove("hidden");
  renderReader(html);
  window.scrollTo(0, 0);
  $("#scrub").max = 0;
  speakT0 = performance.now();
  if (cloud) {
    cloudSynth(job);
  } else {
    worker.postMessage({
      type: "synth", id, chunks: texts,
      voice: $("#voice").value || "af_heart",
      speed: 1.0,   // playback speed is applied by the player, pitch-preserved
    });
  }
  curIdx = 0;
  gotoChunk(0, 0, true);
}

/* ---- device/dtype pairing (wasm→q8, webgpu→fp32; see reportEnv note) ---- */
// fp16 for webgpu, not fp32: half the memory (fp32's 326 MB OOM-crashes iOS
// Safari tabs on download, observed 2026-07-03) and it isn't quantized, so it
// dodges the WebGPU quant-garble bug. fp32 stays selectable for desktop.
const RECOMMENDED = { wasm: "q8", webgpu: "fp16" };
function pairDtype(force) {
  if (force) $("#dtype").value = RECOMMENDED[$("#device").value] || "q8";
  const mismatch = $("#device").value === "webgpu" && /^q/.test($("#dtype").value);
  if (mismatch) status("⚠ quantized dtypes garble on WebGPU — use fp16 or fp32");
  modelReady = false; loadRequested = false;   // changed engine → needs reload
}

/* ---- wiring ---- */
$("#speak").onclick = () => speak($("#text").value);
$("#clip").onclick = async () => {
  try { const t = await navigator.clipboard.readText(); $("#text").value = t; speak(t); }
  catch (e) { status("clipboard blocked — paste manually, then Speak"); }
};
function onEngineChange() {
  const cloud = isCloud();
  $("#dtypeCtl").classList.toggle("hidden", cloud);
  $("#dtypeHint").classList.toggle("hidden", cloud);   // "downloads once" is a kokoro-only note
  $("#cloudKeyCtl").classList.toggle("hidden", !cloud);
  if (cloud) {
    populateVoices(UNREAL_VOICES, localStorage.getItem("reader.cloudVoice") || "Scarlett");
    status("cloud engine (Unreal Speech) — no download");
  } else {
    populateVoices(kokoroVoices.length ? kokoroVoices : DEFAULT_KOKORO_VOICES, localStorage.getItem("reader.voice") || "af_heart");
    pairDtype(true);
  }
}
$("#device").onchange = onEngineChange;
$("#dtype").onchange = () => pairDtype(false);
$("#voice").onchange = () => localStorage.setItem(isCloud() ? "reader.cloudVoice" : "reader.voice", $("#voice").value);
// Cloud access password: persisted same-origin so it survives reloads (it only
// gates a TTS proxy, not a high-value secret). Sent as a Bearer header in cloudSynth.
$("#cloudkey").value = localStorage.getItem("reader.cloudPass") || "";
$("#cloudkey").oninput = () => localStorage.setItem("reader.cloudPass", $("#cloudkey").value);
$("#pane").addEventListener("click", e => {           // click any word → jump & play
  const s = e.target.closest(".w");
  if (!s) return;
  const c = +s.dataset.c, w = +s.dataset.w;
  const t = wordTimings(c);
  if (t) seek(offsets()[c] + t[w].start, true);
  else gotoChunk(c, 0, true);   // chunk not synthesized yet — jump there and wait
});
$("#play").onclick = () => {
  if (!audio.src || !job) { if (job) gotoChunk(curIdx, 0, true); return; }
  audio.paused ? audio.play() : audio.pause();
};
$("#stop").onclick = stopPlayback;
$("#newText").onclick = () => {
  stopPlayback();
  $("#reader").classList.add("hidden");
  $("#composer").classList.remove("hidden");
};
$("#back15").onclick = () => skip(-15);
$("#back10").onclick = () => skip(-10);
$("#fwd10").onclick = () => skip(10);
$("#fwd30").onclick = () => skip(30);
$("#replay").onclick = () => seek(offsets()[curIdx], true);   // restart current sentence
$("#scrub").oninput = () => { scrubbing = true; $("#time").textContent = `${fmt(+$("#scrub").value)} / ${fmt(totalKnown())}`; };
$("#scrub").onchange = () => { scrubbing = false; seek(+$("#scrub").value); };

// keyboard: space=play/pause, arrows=skip
document.addEventListener("keydown", e => {
  if ($("#reader").classList.contains("hidden")) return;
  if (e.target.tagName === "TEXTAREA") return;
  if (e.code === "Space") { e.preventDefault(); $("#play").click(); }
  else if (e.code === "ArrowLeft") { e.preventDefault(); skip(-10); }
  else if (e.code === "ArrowRight") { e.preventDefault(); skip(10); }
});

$("#copyLog").onclick = async () => {
  const text = `${$("#env").innerText}\n\n${logEl.textContent}`;
  try {
    await navigator.clipboard.writeText(text);
    $("#copyStatus").textContent = "copied";
  } catch {
    $("#copyStatus").textContent = "clipboard blocked — select and copy manually";
  }
  setTimeout(() => { $("#copyStatus").textContent = ""; }, 2500);
};

// Stock text so testing needs zero pasting — the opening of Kyle's published
// *Thoughts of an Eaten Sun* (Ch.1, his original prose). Swap before any public
// deploy if you'd rather not lead with fiction.
const STOCK = `From the shoreline, Hantle raised a hand to the crew aboard the three-masted ship departing Founsel's small port. The captain returned the gesture as the vessel, laden with its cargo of logs, unfurled its sails and moved into the deeper waters of Trasach Cove. Hantle lowered his arm to wipe away the sweat on his forehead. As the sunset faded in color, the heat of the day began to abate.

His coworker and friend, Rounfil, shut a barn door close by. "I'll lock up the crane tower, Hantle. You can head on home."

"Thank you, sir. I'll see you in the morning." He walked around a pile of freshly hewn logs and made for the village. When he approached a group of children playing in a meadow that bordered the street, he called out, "Hultier, Dolcium, come on. Dinner time." Beyond the meadow, the forest rustled and groaned.`;
if (!$("#text").value.trim()) $("#text").value = STOCK;

renderSpeeds();
await reportEnv();   // module script: top-level await keeps warm-start ordered

// Default the engine: cloud on Apple mobile (on-device kokoro can't synthesize
// cleanly there — WebGPU garbles/crashes, WASM is only ever slow), on-device
// kokoro everywhere else (free, offline, private). A saved choice wins.
const savedEngine = localStorage.getItem("reader.engine");
if (savedEngine && [...$("#device").options].some(o => o.value === savedEngine)) {
  $("#device").value = savedEngine;
} else if (APPLE_MOBILE) {
  $("#device").value = "cloud";
}
$("#device").addEventListener("change", () => localStorage.setItem("reader.engine", $("#device").value));
onEngineChange();   // sync voice list + dtype visibility to the chosen engine

// Warm the kokoro model if this browser cached it before (skip for cloud —
// nothing to download).
if (!isCloud()) {
  const warm = localStorage.getItem("reader.warm");
  if (warm) {
    const [dev, dt] = warm.split("/");
    if (dev !== "cloud" && [...$("#device").options].some(o => o.value === dev)) {
      $("#device").value = dev;
      $("#dtype").value = dt;
      requestLoad();
    }
  }
}
