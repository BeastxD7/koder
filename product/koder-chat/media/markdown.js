// LakshX markdown renderer. No frameworks, no deps — small, fast, ours.
//
// Public API (single global, plain <script> tag):
//   window.lakshxMarkdown.render(text) -> { html, codes }
//     html  — XSS-safe HTML string wrapped in <div class="md">…</div>
//     codes — { [id: number]: rawCode } side map; each fenced block's
//             Copy button carries data-code-id="<id>" pointing into it.
//
// Design notes:
// - All input is HTML-escaped before any tag we emit; there is no raw
//   HTML passthrough, ever.
// - Streaming-safe: unterminated fences, inline code and bold are
//   auto-closed instead of breaking layout mid-stream.
// - Links render as <a data-href> (no real href) — panel.js intercepts
//   clicks and routes them through the extension host.
(function () {
  "use strict";

  // ---------- escaping ----------

  const ESC = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" };
  function esc(s) {
    return s.replace(/[&<>"]/g, (c) => ESC[c]);
  }

  // ---------- lightweight syntax highlighting ----------
  // One alternation regex per language with named groups; tokens are
  // escaped individually so highlighting runs on raw code, never HTML.

  function tokenRe(com, str, kw, num) {
    const parts = [];
    if (com) parts.push("(?<com>" + com.source + ")");
    if (str) parts.push("(?<str>" + str.source + ")");
    if (kw) parts.push("(?<kw>" + kw.source + ")");
    if (num) parts.push("(?<num>" + num.source + ")");
    return new RegExp(parts.join("|"), "g");
  }

  const C_NUM = /\b0[xXbBoO][\da-fA-F_]+n?\b|\b\d[\d_]*(?:\.\d[\d_]*)?(?:[eE][+-]?\d+)?n?\b/;

  const JS_RE = tokenRe(
    /\/\/[^\n]*|\/\*[\s\S]*?(?:\*\/|$)/,
    /`(?:\\[\s\S]|[^\\`])*(?:`|$)|"(?:\\.|[^\\"\n])*"|'(?:\\.|[^\\'\n])*'/,
    /\b(?:abstract|any|as|async|await|boolean|break|case|catch|class|const|continue|debugger|declare|default|delete|do|else|enum|export|extends|false|finally|for|from|function|get|if|implements|import|in|infer|instanceof|interface|keyof|let|namespace|never|new|null|number|of|private|protected|public|readonly|return|satisfies|set|static|string|super|switch|symbol|this|throw|true|try|type|typeof|undefined|unknown|var|void|while|with|yield)\b/,
    C_NUM,
  );

  const HILITE = {
    js: JS_RE,
    ts: JS_RE,
    python: tokenRe(
      /#[^\n]*/,
      /"""[\s\S]*?(?:"""|$)|'''[\s\S]*?(?:'''|$)|[rbfu]{0,2}"(?:\\.|[^\\"\n])*"|[rbfu]{0,2}'(?:\\.|[^\\'\n])*'/,
      /\b(?:False|None|True|and|as|assert|async|await|break|class|continue|def|del|elif|else|except|finally|for|from|global|if|import|in|is|lambda|match|nonlocal|not|or|pass|raise|return|self|try|while|with|yield)\b/,
      /\b0[xXbBoO][\da-fA-F_]+\b|\b\d[\d_]*(?:\.\d[\d_]*)?(?:[eE][+-]?\d+)?[jJ]?\b/,
    ),
    json: tokenRe(
      null,
      /"(?:\\.|[^\\"])*"/,
      /\b(?:true|false|null)\b/,
      /-?\b\d+(?:\.\d+)?(?:[eE][+-]?\d+)?\b/,
    ),
    bash: tokenRe(
      /(?:^|(?<=\s))#[^\n]*/,
      /"(?:\\.|[^\\"])*(?:"|$)|'[^']*(?:'|$)/,
      /\b(?:alias|break|case|cd|continue|declare|do|done|echo|elif|else|esac|exit|export|false|fi|for|function|if|in|local|printf|read|readonly|return|set|shift|source|then|trap|true|until|unset|while)\b/,
      /\b\d+\b/,
    ),
    html: tokenRe(
      /<!--[\s\S]*?(?:-->|$)/,
      /"[^"\n]*"|'[^'\n]*'/,
      /<\/?[a-zA-Z][\w:-]*|\/?>|<!(?:DOCTYPE|doctype)\b/,
      /\b\d+(?:\.\d+)?\b/,
    ),
    css: tokenRe(
      /\/\*[\s\S]*?(?:\*\/|$)/,
      /"[^"\n]*"|'[^'\n]*'/,
      /@[a-zA-Z-]+|!important\b|\b(?:absolute|auto|block|fixed|flex|grid|inherit|initial|inline|none|relative|sticky|unset)\b/,
      /#[0-9a-fA-F]{3,8}\b|\b\d+(?:\.\d+)?(?:px|em|rem|vh|vw|vmin|vmax|ch|ex|fr|deg|ms|s|%)?/,
    ),
  };

  const ALIAS = {
    javascript: "js", jsx: "js", mjs: "js", cjs: "js", node: "js",
    typescript: "ts", tsx: "ts",
    py: "python", python3: "python",
    sh: "bash", shell: "bash", zsh: "bash",
    xml: "html", svg: "html",
    jsonc: "json",
  };

  function highlight(code, lang) {
    const re = HILITE[ALIAS[lang] || lang];
    if (!re) return esc(code);
    re.lastIndex = 0;
    let out = "";
    let last = 0;
    let m;
    while ((m = re.exec(code))) {
      out += esc(code.slice(last, m.index));
      const g = m.groups;
      const cls =
        g.com !== undefined ? "tok-com" :
        g.str !== undefined ? "tok-str" :
        g.kw !== undefined ? "tok-kw" : "tok-num";
      out += '<span class="' + cls + '">' + esc(m[0]) + "</span>";
      last = m.index + m[0].length;
      if (m[0].length === 0) re.lastIndex++; // never stall
    }
    return out + esc(code.slice(last));
  }

  // ---------- inline formatting ----------
  // Runs on already-escaped text. Generated tags are stashed behind
  // \u0001N\u0002 placeholders so later passes can't touch them.

  const SAFE_URL = /^(?:https?:|mailto:|vscode:|file:|command:|#|\/|\.)/i;

  function inline(raw) {
    const stash = [];
    const hold = (html) => "\u0001" + (stash.push(html) - 1) + "\u0002";
    // strip sentinel bytes from input so user text can never recall a stash slot
    let s = esc(raw.replace(/[\u0001\u0002]/g, ""));

    // inline code — auto-closes at end of block while streaming
    s = s.replace(/`([^`\n]+?)(?:`|$)/g, (_, c) => hold("<code>" + c + "</code>"));

    // links: [text](url) → <a data-href> (panel intercepts clicks)
    s = s.replace(/\[([^\[\]\n]*)\]\(([^()\s]+)\)/g, (_, t, url) => {
      const probe = url.replace(/&amp;/g, "&").replace(/[\u0000-\u0020]/g, "");
      if (!SAFE_URL.test(probe)) return t; // javascript:, data:, etc. → plain text
      return hold('<a class="md-link" data-href="' + url + '">') + t + hold("</a>");
    });

    // bold — auto-closes at end of block while streaming
    s = s.replace(/\*\*(?=\S)([\s\S]+?)(?:\*\*|$)/g, "<strong>$1</strong>");
    s = s.replace(/__(?=\S)([\s\S]*?\S)__/g, "<strong>$1</strong>");

    // italic
    s = s.replace(/(^|[^*\w])\*(?=[^\s*])([^*\n]+)\*/g, "$1<em>$2</em>");
    s = s.replace(/(^|[\s(])_(?=\S)([^_\n]+)_(?=$|[\s).,;:!?])/g, "$1<em>$2</em>");

    s = s.replace(/\n/g, "<br>");
    return s.replace(/\u0001(\d+)\u0002/g, (_, i) => stash[+i]);
  }

  // ---------- block-level parsing ----------

  const FENCE_OPEN = /^\s{0,3}(```+|~~~+)\s*([^\s`]*)/;
  const HEADING = /^\s{0,3}(#{1,6})\s+(.*)$/;
  const HR = /^\s{0,3}(?:-{3,}|\*{3,}|_{3,})\s*$/;
  const QUOTE = /^\s{0,3}>\s?/;
  const LIST_ITEM = /^(\s*)(?:([-*+])|(\d{1,9})[.)])\s+(.*)$/;
  const TABLE_SEP = /^\s*\|?\s*:?-+:?\s*(?:\|\s*:?-+:?\s*)+\|?\s*$/;

  function isTableStart(lines, i) {
    return (
      i + 1 < lines.length &&
      lines[i].includes("|") &&
      lines[i + 1].includes("|") &&
      TABLE_SEP.test(lines[i + 1])
    );
  }

  function isBlockStart(line) {
    return (
      FENCE_OPEN.test(line) ||
      HEADING.test(line) ||
      HR.test(line) ||
      QUOTE.test(line) ||
      LIST_ITEM.test(line) ||
      /^\s*\|/.test(line)
    );
  }

  function splitRow(line) {
    let s = line.trim();
    if (s.startsWith("|")) s = s.slice(1);
    if (s.endsWith("|")) s = s.slice(0, -1);
    return s.split("|").map((c) => c.trim());
  }

  function codeBlock(code, lang, ctx) {
    const id = ctx.n++;
    ctx.codes[id] = code;
    return (
      '<div class="codeblock"><div class="codeblock-head"><span class="lang">' +
      esc(lang) +
      '</span><button class="copy" data-code-id="' + id + '">Copy</button></div><pre><code>' +
      highlight(code, lang.toLowerCase()) +
      "</code></pre></div>"
    );
  }

  function renderList(items) {
    const ordered = items[0].ordered;
    let h = ordered
      ? '<ol class="md-list"' + (items[0].start > 1 ? ' start="' + items[0].start + '"' : "") + ">"
      : '<ul class="md-list">';
    for (const it of items) {
      h += "<li>" + inline(it.text);
      if (it.children.length) h += renderList(it.children);
      h += "</li>";
    }
    return h + (ordered ? "</ol>" : "</ul>");
  }

  function parseBlocks(src, ctx, depth) {
    const lines = src.split("\n");
    const n = lines.length;
    const out = [];
    let i = 0;
    let m;

    while (i < n) {
      const line = lines[i];
      if (!line.trim()) { i++; continue; }

      // fenced code — auto-closes at EOF while streaming
      if ((m = line.match(FENCE_OPEN))) {
        const close = new RegExp("^\\s{0,3}" + (m[1][0] === "`" ? "`{3,}" : "~{3,}") + "\\s*$");
        const buf = [];
        i++;
        while (i < n && !close.test(lines[i])) { buf.push(lines[i]); i++; }
        if (i < n) i++; // consume closing fence
        out.push(codeBlock(buf.join("\n"), m[2] || "", ctx));
        continue;
      }

      // horizontal rule (before list: "---" is never a list item)
      if (HR.test(line)) { out.push("<hr>"); i++; continue; }

      // heading (#..#### rendered as h1..h4; deeper clamps to h4)
      if ((m = line.match(HEADING))) {
        const lvl = Math.min(m[1].length, 4);
        out.push("<h" + lvl + ">" + inline(m[2].replace(/\s+#+\s*$/, "")) + "</h" + lvl + ">");
        i++;
        continue;
      }

      // blockquote (nested content re-parsed, bounded depth)
      if (QUOTE.test(line)) {
        const buf = [];
        while (i < n && QUOTE.test(lines[i])) { buf.push(lines[i].replace(QUOTE, "")); i++; }
        const body = depth < 3
          ? parseBlocks(buf.join("\n"), ctx, depth + 1)
          : "<p>" + inline(buf.join("\n")) + "</p>";
        out.push("<blockquote>" + body + "</blockquote>");
        continue;
      }

      // pipe table
      if (isTableStart(lines, i)) {
        const head = splitRow(lines[i]);
        const aligns = splitRow(lines[i + 1]).map((c) =>
          c.endsWith(":") ? (c.startsWith(":") ? "center" : "right") : "",
        );
        i += 2;
        const alignAttr = (j) => (aligns[j] ? ' style="text-align:' + aligns[j] + '"' : "");
        let h = '<div class="md-table-wrap"><table><thead><tr>';
        head.forEach((c, j) => { h += "<th" + alignAttr(j) + ">" + inline(c) + "</th>"; });
        h += "</tr></thead><tbody>";
        while (i < n && lines[i].trim() && lines[i].includes("|")) {
          const cells = splitRow(lines[i]);
          h += "<tr>";
          for (let j = 0; j < head.length; j++) {
            h += "<td" + alignAttr(j) + ">" + inline(cells[j] || "") + "</td>";
          }
          h += "</tr>";
          i++;
        }
        out.push(h + "</tbody></table></div>");
        continue;
      }

      // lists (one nesting level via 2+ space indent)
      if (LIST_ITEM.test(line)) {
        const items = [];
        while (i < n) {
          const lm = lines[i].match(LIST_ITEM);
          if (lm) {
            const it = { ordered: lm[3] != null, start: lm[3] ? +lm[3] : 0, text: lm[4], children: [] };
            if (lm[1].length >= 2 && items.length) items[items.length - 1].children.push(it);
            else items.push(it);
            i++;
          } else if (lines[i].trim() && /^\s{2,}/.test(lines[i]) && !isBlockStart(lines[i])) {
            // lazy continuation of the previous item
            const top = items[items.length - 1];
            const tgt = top.children.length ? top.children[top.children.length - 1] : top;
            tgt.text += "\n" + lines[i].trim();
            i++;
          } else break;
        }
        out.push(renderList(items));
        continue;
      }

      // paragraph
      const buf = [line];
      i++;
      while (i < n && lines[i].trim() && !isBlockStart(lines[i]) && !isTableStart(lines, i)) {
        buf.push(lines[i]);
        i++;
      }
      out.push("<p>" + inline(buf.join("\n")) + "</p>");
    }

    return out.join("");
  }

  // ---------- public API ----------

  function render(text) {
    const ctx = { n: 0, codes: {} };
    const html = parseBlocks(String(text ?? ""), ctx, 0);
    return { html: '<div class="md">' + html + "</div>", codes: ctx.codes };
  }

  window.lakshxMarkdown = { render };
})();
