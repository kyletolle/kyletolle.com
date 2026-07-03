// One-shot: extract kokoro-js's exact text->IPA pipeline into server_phonemize.mjs.
import { readFile, writeFile } from "node:fs/promises";

const src = await readFile("node_modules/kokoro-js/dist/kokoro.js", "utf8");
// Slice helpers o/c/g, the punctuation splitter regex (u/d), and the async
// normalize+phonemize fn m — verbatim, ending right before sentence-splitter p().
const start = src.indexOf("function o(e){if(e.includes");
const end = src.indexOf("function p(e,a=!0){return");
if (start < 0 || end < 0 || end <= start) { console.error("boundary not found", { start, end }); process.exit(1); }
const slice = src.slice(start, end);
if (!/async function m\(/.test(slice)) { console.error("m() not in slice"); process.exit(1); }

const header = [
  "// AUTO-EXTRACTED from kokoro-js@1.2.1 dist (verbatim) — do not hand-edit.",
  "// Exposes kokoro's exact text->IPA pipeline for server-side phonemization, so",
  "// Apple WebKit (which stalls loading espeak's WASM in-browser) can offload it",
  "// to faramir and still run the model on-device. Regenerate via",
  "// extract_phonemize.mjs if kokoro-js bumps.",
  'import { phonemize as l } from "phonemizer";',
  "",
].join("\n");

const tail = String.raw`
const MAX_PH = 440;   // phoneme-char budget per generate() call (mirror of worker.js)
async function phLen(t, lang) { return (await m(t, lang)).length; }
async function safePieces(text, lang) {
  if ((await phLen(text, lang)) <= MAX_PH) return [text];
  const mid = Math.floor(text.length / 2);
  let cut = -1; const re = /[.!?;:]["')\]]?\s+/g; let mm;
  while ((mm = re.exec(text))) { const e2 = mm.index + mm[0].length; if (cut < 0 || Math.abs(e2 - mid) < Math.abs(cut - mid)) cut = e2; }
  if (cut <= 0 || cut >= text.length) { cut = text.lastIndexOf(" ", mid); if (cut <= 0) cut = mid; }
  const a = text.slice(0, cut).trim(), b = text.slice(cut).trim();
  if (!a || !b) return [text];
  return [...(await safePieces(a, lang)), ...(await safePieces(b, lang))];
}
// text -> array of IPA phoneme strings, each within the token budget
export async function phonemizePieces(text, lang = "a") {
  const pieces = await safePieces(text, lang);
  return Promise.all(pieces.map(p => m(p, lang)));
}
`;

await writeFile("server_phonemize.mjs", header + slice + "\n" + tail);
console.log("wrote server_phonemize.mjs — slice length:", slice.length);
