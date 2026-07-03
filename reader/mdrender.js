// Port of local-tts mdrender.py — render markdown into (a) display HTML with
// per-word highlight spans and (b) speak-sized chunks of just the prose.
// Code blocks are shown but not spoken; markdown syntax (#, *, backticks) is
// never read aloud.
//
// Each spoken word becomes <span class="w" data-c=CHUNK data-w=WORD>…</span>,
// so the player's highlight/seek logic works unchanged. Chunk boundaries fall
// on block boundaries (and on a size target within long blocks), so every
// chunk maps to a contiguous run of displayed words.

import MarkdownIt from "markdown-it";
import { TARGET_RAMP, TARGET } from "./chunker.js";

const ALNUM = /[\p{L}\p{N}]/u;

function esc(s) {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

class Builder {
  constructor() {
    this.html = [];
    this.chunks = [];     // array of word arrays — spoken words per chunk
    this._cur = [];       // words in the chunk being built
    this._curLen = 0;
    this.c = 0;           // current chunk index
    this.w = 0;           // word index within current chunk
    this._ramp = 0;
  }

  get _targetNow() {
    return this._ramp < TARGET_RAMP.length ? TARGET_RAMP[this._ramp] : TARGET;
  }

  _flush() {
    if (this._cur.length) {
      this.chunks.push(this._cur);
      this._cur = [];
      this._curLen = 0;
      this.c++;
      this.w = 0;
      this._ramp++;
    }
  }

  _addWord(word, styles) {
    // Punctuation orphaned by an inline span (e.g. the "." after `code`.)
    // gets merged onto the previous word so it isn't its own highlight.
    if (this._cur.length && !ALNUM.test(word)) {
      this._cur[this._cur.length - 1] += word;
      const last = this.html[this.html.length - 1];
      const i = last.lastIndexOf("</span>");
      this.html[this.html.length - 1] = last.slice(0, i) + esc(word) + last.slice(i);
      this._curLen += word.length;
      return;
    }
    if (this._cur.length && this._curLen + 1 + word.length > this._targetNow) {
      this._flush();
    }
    let inner = esc(word);
    if (styles.includes("code")) inner = `<code>${inner}</code>`;
    if (styles.includes("strong")) inner = `<strong>${inner}</strong>`;
    if (styles.includes("em")) inner = `<em>${inner}</em>`;
    const cls = styles.includes("lnk") ? "w lnk" : "w";
    this.html.push(`<span class="${cls}" data-c="${this.c}" data-w="${this.w}">${inner}</span> `);
    this._cur.push(word);
    this.w++;
    this._curLen += 1 + word.length;
  }

  _inline(children) {
    const styles = [];
    for (const ch of children || []) {
      const t = ch.type;
      if (t === "text") {
        for (const word of ch.content.split(/\s+/)) {
          if (word) this._addWord(word, [...styles]);
        }
      } else if (t === "code_inline") {
        for (const word of ch.content.split(/\s+/)) {
          if (word) this._addWord(word, [...styles, "code"]);
        }
      } else if (t === "strong_open") styles.push("strong");
      else if (t === "strong_close") {
        const i = styles.indexOf("strong");
        if (i >= 0) styles.splice(i, 1);
      } else if (t === "em_open") styles.push("em");
      else if (t === "em_close") {
        const i = styles.indexOf("em");
        if (i >= 0) styles.splice(i, 1);
      } else if (t === "link_open") styles.push("lnk");
      else if (t === "link_close") {
        const i = styles.indexOf("lnk");
        if (i >= 0) styles.splice(i, 1);
      }
      // softbreak/hardbreak/image: nothing to speak
    }
  }

  build(mdText) {
    const tokens = new MarkdownIt("commonmark").parse(mdText, {});
    for (const tok of tokens) {
      const t = tok.type;
      if (t === "heading_open") {
        this._flush();
        this.html.push(`<${tok.tag}>`);
      } else if (t === "heading_close") {
        this.html.push(`</${tok.tag}>`);
        this._flush();
      } else if (t === "paragraph_open") {
        if (!tok.hidden) this.html.push("<p>");
      } else if (t === "paragraph_close") {
        if (!tok.hidden) this.html.push("</p>");
        this._flush();
      } else if (t === "bullet_list_open") this.html.push("<ul>");
      else if (t === "bullet_list_close") this.html.push("</ul>");
      else if (t === "ordered_list_open") this.html.push("<ol>");
      else if (t === "ordered_list_close") this.html.push("</ol>");
      else if (t === "list_item_open") this.html.push("<li>");
      else if (t === "list_item_close") {
        this.html.push("</li>");
        this._flush();
      } else if (t === "blockquote_open") this.html.push("<blockquote>");
      else if (t === "blockquote_close") {
        this.html.push("</blockquote>");
        this._flush();
      } else if (t === "fence" || t === "code_block") {
        this._flush();  // code is shown, not spoken
        this.html.push(`<pre class="code"><code>${esc(tok.content)}</code></pre>`);
      } else if (t === "hr") this.html.push("<hr>");
      else if (t === "inline") this._inline(tok.children);
    }
    this._flush();
    return { html: this.html.join(""), chunks: this.chunks };
  }
}

// Returns { html, chunks } where chunks is an array of word arrays.
export function buildDocument(mdText) {
  return new Builder().build(mdText);
}
