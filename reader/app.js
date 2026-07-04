// reader — glue between the DOM chrome (composer, engine/dtype/voice pickers,
// model-load UI, debug panel) and the ReadAlong player. The player + its synth
// sources hold all playback/synthesis logic; this file is reader-specific and
// single-instance by design (there is one reader page).

import { chunkText } from "./chunker.js";
import { buildDocument } from "./mdrender.js";
import { ReadAlong } from "./readalong.js";
import { KokoroWorkerSource, CloudUnrealSource } from "./sources.js";

const $ = s => document.querySelector(s);

/* ---- engines: on-device kokoro (wasm/webgpu) vs cloud (Unreal Speech) ---- */
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

/* ---- debug log + composer status line ---- */
const logEl = $("#log");
const log = m => { logEl.textContent += m + "\n"; logEl.scrollTop = logEl.scrollHeight; };
const status0 = m => { $("#status0").textContent = m; };

/* ---- sources + player ---- */
const kokoroSource = new KokoroWorkerSource({
  workerUrl: "./worker.bundle.js",
  getVoice: () => $("#voice").value || "af_heart",
});
const cloudSource = new CloudUnrealSource({
  endpoint: "tts",
  getVoice: () => $("#voice").value || "Scarlett",
  getPassword: () => ($("#cloudkey") ? $("#cloudkey").value : ""),
});

function showReader() {
  $("#composer").classList.add("hidden");
  $("#reader").classList.remove("hidden");
  window.scrollTo(0, 0);
}
function showComposer() {
  $("#reader").classList.add("hidden");
  $("#composer").classList.remove("hidden");
}

const player = new ReadAlong($("#reader"), cloudSource, {
  prepare: (text, md) => md
    ? buildDocument(text)
    : { html: null, chunks: chunkText(text).map(c => c.split(/\s+/)) },
  getMd: () => $("#md").checked,
  defaultSpeed: 1.5,
  speedKey: "reader.speed",
  onStatus: status0,
  onLog: log,
  onNewText: showComposer,
});

/* ---- model load (kokoro): drives the download bar + composer status, resolves
   on "ready", then flushes any speak queued behind the load ---- */
let loadRequested = false;
let pendingSpeak = null;
function requestLoad() {
  if (loadRequested) return;
  loadRequested = true;
  status0("loading model…");
  kokoroSource.load($("#device").value, $("#dtype").value, m => {
    const bar = $("#dlbar");
    bar.style.display = "";
    const mb = b => (b / 1048576).toFixed(1);
    if (m.total) {
      bar.value = m.loaded / m.total;
      status0(`downloading model — ${mb(m.loaded)}/${mb(m.total)} MB`);
    } else {
      bar.removeAttribute("value");
      status0(`downloading model — ${mb(m.loaded)} MB so far`);
    }
  }).then(m => {
    $("#dlbar").style.display = "none";
    localStorage.setItem("reader.warm", `${m.device}/${m.dtype}`);
    status0(`model ready (${m.device}/${m.dtype})`);
    if (m.voices?.length) {
      kokoroVoices = m.voices;
      if (!isCloud()) populateVoices(kokoroVoices, localStorage.getItem("reader.voice") || "af_heart");
    }
    if (pendingSpeak != null) { const t = pendingSpeak; pendingSpeak = null; doSpeak(t); }
  });
}

/* ---- speak: pick the engine, load kokoro on demand, hand off to the player ---- */
function doSpeak(text) {
  text = (text || "").trim();
  if (!text) { status0("nothing to speak"); return; }
  const cloud = isCloud();
  if (!cloud && !kokoroSource.ready) {
    pendingSpeak = text;
    requestLoad();
    return;
  }
  player.setSource(cloud ? cloudSource : kokoroSource);
  showReader();
  player.speak(text);
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
        // WebGPU garbles on Firefox even at fp32, and quantized dtypes garble
        // on WebGPU everywhere (hexgrad/kokoro#98).
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

/* ---- device/dtype pairing (wasm→q8, webgpu→fp16; see reportEnv note) ---- */
const RECOMMENDED = { wasm: "q8", webgpu: "fp16" };
function pairDtype(force) {
  if (force) $("#dtype").value = RECOMMENDED[$("#device").value] || "q8";
  const mismatch = $("#device").value === "webgpu" && /^q/.test($("#dtype").value);
  if (mismatch) status0("⚠ quantized dtypes garble on WebGPU — use fp16 or fp32");
  kokoroSource.ready = false; loadRequested = false;   // changed engine → needs reload
}

function onEngineChange() {
  const cloud = isCloud();
  $("#dtypeCtl").classList.toggle("hidden", cloud);
  $("#dtypeHint").classList.toggle("hidden", cloud);   // "downloads once" is a kokoro-only note
  $("#cloudKeyCtl").classList.toggle("hidden", !cloud);
  if (cloud) {
    populateVoices(UNREAL_VOICES, localStorage.getItem("reader.cloudVoice") || "Scarlett");
    status0("cloud engine (Unreal Speech) — no download");
  } else {
    populateVoices(kokoroVoices.length ? kokoroVoices : DEFAULT_KOKORO_VOICES, localStorage.getItem("reader.voice") || "af_heart");
    pairDtype(true);
  }
}

/* ---- wiring ---- */
$("#speak").onclick = () => doSpeak($("#text").value);
$("#clip").onclick = async () => {
  try { const t = await navigator.clipboard.readText(); $("#text").value = t; doSpeak(t); }
  catch (e) { status0("clipboard blocked — paste manually, then Speak"); }
};
$("#device").onchange = onEngineChange;
$("#dtype").onchange = () => pairDtype(false);
$("#voice").onchange = () => localStorage.setItem(isCloud() ? "reader.cloudVoice" : "reader.voice", $("#voice").value);
// Cloud access password: persisted same-origin so it survives reloads (it only
// gates a TTS proxy, not a high-value secret). Sent as a Bearer header by the
// cloud source.
$("#cloudkey").value = localStorage.getItem("reader.cloudPass") || "";
$("#cloudkey").oninput = () => localStorage.setItem("reader.cloudPass", $("#cloudkey").value);

// keyboard: space=play/pause, arrows=skip (only while the reader view is up)
document.addEventListener("keydown", e => {
  if ($("#reader").classList.contains("hidden")) return;
  if (e.target.tagName === "TEXTAREA") return;
  if (e.code === "Space") { e.preventDefault(); player.togglePlay(); }
  else if (e.code === "ArrowLeft") { e.preventDefault(); player.skip(-10); }
  else if (e.code === "ArrowRight") { e.preventDefault(); player.skip(10); }
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
// *Thoughts of an Eaten Sun* (Ch.1, his original prose).
const STOCK = `From the shoreline, Hantle raised a hand to the crew aboard the three-masted ship departing Founsel's small port. The captain returned the gesture as the vessel, laden with its cargo of logs, unfurled its sails and moved into the deeper waters of Trasach Cove. Hantle lowered his arm to wipe away the sweat on his forehead. As the sunset faded in color, the heat of the day began to abate.

His coworker and friend, Rounfil, shut a barn door close by. "I'll lock up the crane tower, Hantle. You can head on home."

"Thank you, sir. I'll see you in the morning." He walked around a pile of freshly hewn logs and made for the village. When he approached a group of children playing in a meadow that bordered the street, he called out, "Hultier, Dolcium, come on. Dinner time." Beyond the meadow, the forest rustled and groaned.`;
if (!$("#text").value.trim()) $("#text").value = STOCK;

await reportEnv();   // module script: top-level await keeps warm-start ordered

// Default the engine: cloud on Apple mobile (on-device kokoro can't synthesize
// cleanly there), on-device kokoro everywhere else. A saved choice wins.
const savedEngine = localStorage.getItem("reader.engine");
if (savedEngine && [...$("#device").options].some(o => o.value === savedEngine)) {
  $("#device").value = savedEngine;
} else if (APPLE_MOBILE) {
  $("#device").value = "cloud";
}
$("#device").addEventListener("change", () => localStorage.setItem("reader.engine", $("#device").value));
onEngineChange();   // sync voice list + dtype visibility to the chosen engine

// Warm the kokoro model if this browser cached it before (skip for cloud).
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
