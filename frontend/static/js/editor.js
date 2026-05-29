/**
 * R4TEditor -- CodeMirror 6 Integration  v4
 * Fine-grained SkriptLang syntax highlighting + theme system
 */

import { EditorState, Compartment, RangeSetBuilder, Prec } from "https://esm.sh/@codemirror/state@6";
import {
  EditorView, lineNumbers, highlightActiveLine,
  highlightActiveLineGutter, drawSelection, keymap,
  ViewPlugin, Decoration, hoverTooltip,
} from "https://esm.sh/@codemirror/view@6";
import { defaultKeymap, historyKeymap, history, indentWithTab } from "https://esm.sh/@codemirror/commands@6";
import {
  indentUnit, syntaxHighlighting, HighlightStyle,
  StreamLanguage, indentOnInput,
} from "https://esm.sh/@codemirror/language@6";
import { tags as t } from "https://esm.sh/@lezer/highlight@1";
import { autocompletion, closeBrackets } from "https://esm.sh/@codemirror/autocomplete@6";
import { lintGutter, diagnosticCount, forEachDiagnostic } from "https://esm.sh/@codemirror/lint@6";

const _lintMod = { forEachDiagnostic };
import { search, searchKeymap } from "https://esm.sh/@codemirror/search@6";
import { syntaxDB, initSyntaxDB } from "/static/js/syntaxdb.js";
import { buildAnalyzer } from "/static/js/analyzer.js";

// ============================================================
// Token tag map
// ============================================================
const TOKEN_TAG = {
  keyword:     t.keyword,
  event:       t.special(t.keyword),
  eventName:   t.labelName,
  effect:      t.definitionKeyword,
  condition:   t.operatorKeyword,
  expression:  t.special(t.variableName),
  variable:    t.variableName,
  comment:     t.comment,
  commentBang: t.special(t.comment),
  string:      t.string,
  number:      t.number,
  type:        t.typeName,
  operator:    t.operator,
  formatCode:  t.special(t.string),
  funcKeyword: t.moduleKeyword,
  funcName:    t.function(t.definition(t.variableName)),
  paramName:   t.attributeName,
  paramColon:  t.punctuation,
  paramType:   t.className,
  punctuation: t.punctuation,
  property:    t.propertyName,
};

// ============================================================
// Build HighlightStyle from a theme object
// ============================================================
export function buildHighlightStyleFromTheme(theme) {
  const syn = theme.syntax || {};
  const specs = [];
  for (const [tokenName, lezerTag] of Object.entries(TOKEN_TAG)) {
    const rule = syn[tokenName];
    if (!rule) continue;
    const spec = { tag: lezerTag };
    if (rule.color)      spec.color          = rule.color;
    if (rule.bold)       spec.fontWeight      = "bold";
    if (rule.italic)     spec.fontStyle       = "italic";
    if (rule.underline)  spec.textDecoration  = "underline";
    specs.push(spec);
  }
  return HighlightStyle.define(specs);
}

// ============================================================
// Apply theme CSS variables to :root
// ============================================================
export function applyThemeToDOM(theme) {
  const r = document.documentElement;
  const e = theme.editor || {};
  const s = theme.syntax  || {};

  r.setAttribute("data-theme", theme.base || "dark");
  if (e.background)  r.style.setProperty("--bg-base",       e.background);
  if (e.border)      r.style.setProperty("--border",        e.border);
  if (e.foreground)  r.style.setProperty("--text-primary",  e.foreground);
  if (e.lineNumbers) r.style.setProperty("--text-muted",    e.lineNumbers);
  if (e.selection)   r.style.setProperty("--bg-selection",  e.selection);
  if (e.cursor)      r.style.setProperty("--accent",        e.cursor);
  if (theme.accent) {
    r.style.setProperty("--accent",     theme.accent);
    r.style.setProperty("--accent-dim", theme.accent + "22");
    r.style.setProperty("--accent-mid", theme.accent + "55");
  }
  for (const [name, rule] of Object.entries(s)) {
    if (rule && rule.color) r.style.setProperty(`--syn-${name}`, rule.color);
  }

  // Expose skript_colors as CSS vars for format code rendering
  const sc = theme.skript_colors || {};
  for (const [code, val] of Object.entries(sc)) {
    const key = code.replace('&', '--skc-');
    if (val && val.startsWith('#')) {
      r.style.setProperty(key, val);
    } else {
      // null/undefined, remove so the plugin knows it's a format modifier, not a color
      r.style.removeProperty(key);
    }
  }
}

// ============================================================
// Static word sets
// ============================================================

const KEYWORDS = new Set([
  "if","else","loop","while","stop","continue","return",
  "and","or","not","is","are","isn't","aren't","was","were",
  "set","add","remove","delete","clear","reset",
  "wait","exit","cancel","apply",
  "true","false","yes","no",
  "all","every","any","some","first","last","random",
  "in","of","to","from","with","without","for","by","at",
  "on","off","then","where","when","that",
  "option","options","local","global",
  "the","a","an",
]);

const EFFECTS_STATIC = new Set([
  "broadcast","send","message","execute","make","give","take",
  "teleport","kill","heal","damage","push","pull","drop",
  "spawn","create","play","open","close","show","hide",
  "kick","ban","unban","op","deop","log","print",
  "apply","cancel","prevent","enable","disable",
  "load","unload","reload",
]);

const CONDITIONS_STATIC = new Set([
  "contains","contain","has","have","equals","equal",
  "greater","less","above","below","between",
  "starts","ends","matches",
  "exists","exist","set","loaded","enabled","online","offline",
  "banned","whitelisted","flying","sneaking","sprinting",
  "empty","full","alive","dead","valid",
]);

const TYPES_STATIC = new Set([
  "player","players","entity","entities","block","blocks",
  "item","items","world","location","vector",
  "text","string","number","integer","boolean","object","objects",
  "list","map","inventory","slot","color","sound","potion",
  "biome","chunk","region","gamemode","difficulty","effect",
  "damage","source","chunk","nbt","uuid","date","timespan",
  "direction","weather","firework","arrow","projectile",
  "experience","enchantment","attribute","material",
]);

const SECTIONS = new Set([
  "command","function","options","variables","aliases","local","on","every",
]);

const FORMAT_CODE_RE = /^&[0-9a-fk-orA-FK-OR]/;

// ============================================================
// Tokenizer sub-states
// ============================================================
const S_NORMAL       = 0;
const S_IN_STRING    = 1;
const S_FUNC_NAME    = 2;
const S_FUNC_PARAMS  = 3;
const S_PARAM_COLON  = 4;
const S_PARAM_TYPE   = 5;
const S_EVENT_NAME   = 6;

// ============================================================
// SkriptLang StreamLanguage
// ============================================================
const skriptLanguage = StreamLanguage.define({
  name: "skriptlang",
  tokenTable: TOKEN_TAG,

  startState: () => ({
    sub: S_NORMAL,
    stringChar: null,
    lineIndented: false,
    inFormatCode: false,
    formatColor: null,
    _stringInterp: false,
  }),

  token(stream, state) {
    if (stream.sol()) {
      state.lineIndented = /^\s/.test(stream.string);
      state.inFormatCode = false;
      if (state.sub !== S_IN_STRING) state.sub = S_NORMAL;
    }

    if (stream.eatSpace()) return null;

    if (state.sub === S_IN_STRING) {
      if (stream.match(FORMAT_CODE_RE)) {
        state.inFormatCode = true;
        return "formatCode";
      }
      if (state.inFormatCode && (stream.peek() === state.stringChar || stream.peek() === '<')) {
        state.inFormatCode = false;
      }
      if (stream.peek() === state.stringChar) {
        const nextTwo = stream.string.slice(stream.pos, stream.pos + 2);
        if (nextTwo.length === 2 && nextTwo[0] === state.stringChar && nextTwo[1] === state.stringChar) {
          stream.next(); stream.next();
          state.inFormatCode = false;
          return "string";
        }
        stream.next();
        state.sub = S_NORMAL;
        state.inFormatCode = false;
        return "string";
      }
      if (stream.peek() === '%') {
        stream.next();
        while (!stream.eol() && stream.peek() !== '%') stream.next();
        if (stream.peek() === '%') stream.next();
        return "string";
      }
      if (stream.peek() === '{') {
        state.sub = S_NORMAL;
        state._stringInterp = true;
        return null;
      }
      if (state.inFormatCode) {
        while (!stream.eol()
          && stream.peek() !== state.stringChar
          && stream.peek() !== '<'
          && !FORMAT_CODE_RE.test(stream.string.slice(stream.pos, stream.pos + 2))) {
          stream.next();
        }
        return null;
      }
      stream.next();
      return "string";
    }

    if (stream.peek() === '#') {
      if (stream.string.slice(stream.pos, stream.pos + 2) === '#!') {
        stream.match(/^#!.*/);
        return "commentBang";
      }
      stream.match(/^#.*/);
      return "comment";
    }

    if (stream.peek() === '"' || stream.peek() === "'") {
      state.stringChar = stream.next();
      state.sub = S_IN_STRING;
      state.inFormatCode = false;
      return "string";
    }

    if (stream.peek() === '{') {
      const wasInString = state._stringInterp || false;
      state._stringInterp = false;
      stream.next();
      while (!stream.eol() && stream.peek() !== '}') stream.next();
      if (stream.peek() === '}') stream.next();
      if (wasInString) state.sub = S_IN_STRING;
      return "variable";
    }

    if (stream.match(/^-?\d+(\.\d+)?/)) return "number";

    if (stream.peek() === '(') {
      stream.next();
      if (state.sub === S_FUNC_NAME) state.sub = S_FUNC_PARAMS;
      return "punctuation";
    }
    if (stream.peek() === ')') {
      stream.next();
      if (state.sub === S_FUNC_PARAMS || state.sub === S_PARAM_TYPE || state.sub === S_PARAM_COLON)
        state.sub = S_NORMAL;
      return "punctuation";
    }
    if (stream.peek() === ',') {
      stream.next();
      if (state.sub === S_FUNC_PARAMS || state.sub === S_PARAM_TYPE) state.sub = S_FUNC_PARAMS;
      return "punctuation";
    }
    if (stream.peek() === ':') {
      stream.next();
      if (state.sub === S_PARAM_COLON) { state.sub = S_PARAM_TYPE; return "paramColon"; }
      return "punctuation";
    }

    if (stream.match(/^'s\b/)) return "property";

    const word = stream.match(/^[a-zA-Z_][a-zA-Z0-9_'-]*/);
    if (word) {
      const raw = word[0];
      const w   = raw.toLowerCase().replace(/'s$/, '');

      if (state.sub === S_FUNC_PARAMS) { state.sub = S_PARAM_COLON; return "paramName"; }
      if (state.sub === S_PARAM_TYPE)  { state.sub = S_FUNC_PARAMS; return "paramType"; }
      if (state.sub === S_EVENT_NAME) { state.sub = S_NORMAL; return "eventName"; }
      if (state.sub === S_FUNC_NAME)  return "funcName";

      if (!state.lineIndented) {
        if (w === "function") { state.sub = S_FUNC_NAME; return "funcKeyword"; }
        if (w === "local" && !state.lineIndented) return "keyword";
        if (w === "on" || w === "every") { state.sub = S_EVENT_NAME; return "event"; }
        if (SECTIONS.has(w)) return "keyword";
      }

      if (syntaxDB.ready) {
        const rest = stream.string.slice(stream.pos - raw.length).trimStart();
        const hit  = syntaxDB.classify(rest);
        if (hit) {
          switch (hit.category) {
            case 'effect':     return "effect";
            case 'condition':  return "condition";
            case 'expression': return "expression";
            case 'type':       return "type";
            case 'event':      return "eventName";
            case 'section':    return "keyword";
            case 'function':   return "funcKeyword";
          }
        }
      }

      if (w === "function") { state.sub = S_FUNC_NAME; return "funcKeyword"; }
      if (KEYWORDS.has(w))         return "keyword";
      if (EFFECTS_STATIC.has(w))   return "effect";
      if (CONDITIONS_STATIC.has(w)) return "condition";
      if (TYPES_STATIC.has(w))     return "type";

      return null;
    }

    if (stream.match(/^[+\-*\/=<>!&|%^~]+/)) return "operator";
    if (stream.match(FORMAT_CODE_RE)) return "formatCode";

    stream.next();
    return null;
  },

  blankLine(state) {
    if (state.sub !== S_IN_STRING) {
      state.sub = S_NORMAL;
      state.inFormatCode = false;
    }
  },

  languageData: {
    commentTokens: { line: "#" },
  },
});

// ============================================================
// Compartments
// ============================================================
export const tabSizeCompartment      = new Compartment();
export const autocompleteCompartment = new Compartment();
export const highlightCompartment    = new Compartment();
export const colorCodeCompartment    = new Compartment();
export const analyzerCompartment     = new Compartment();
export const hoverCompartment        = new Compartment();
export const indentGuidesCompartment = new Compartment();
export const minimapCompartment      = new Compartment();

// ============================================================
// Indent guides ViewPlugin
// Draws vertical lines at each indent level using the editor's CSS vars.
// ============================================================
const indentGuideDeco = Decoration.mark({ class: "cm-indent-guide" });

export function buildIndentGuidesPlugin() {
  return ViewPlugin.fromClass(class {
    constructor(view) { this.decorations = this._build(view); }
    update(u) { if (u.docChanged || u.viewportChanged) this.decorations = this._build(u.view); }
    _build(view) {
      const builder  = new RangeSetBuilder();
      const tabWidth = view.state.tabSize || 4;
      for (const { from, to } of view.visibleRanges) {
        let pos = from;
        while (pos <= to) {
          const line   = view.state.doc.lineAt(pos);
          const text   = line.text;
          let col = 0, i = 0;
          // Count leading spaces/tabs
          while (i < text.length && (text[i] === " " || text[i] === "\t")) {
            col += text[i] === "\t" ? tabWidth : 1;
            i++;
          }
          const indentLevels = Math.floor(col / tabWidth);
          for (let lvl = 0; lvl < indentLevels; lvl++) {
            const charPos = line.from + lvl * tabWidth;
            if (charPos < line.to) {
              try { builder.add(charPos, charPos + 1, indentGuideDeco); } catch { /* overlap */ }
            }
          }
          pos = line.to + 1;
        }
      }
      return builder.finish();
    }
  }, { decorations: v => v.decorations });
}

// ============================================================
// Minimap panel
// Renders a scaled-down live snapshot of the document in a right-side panel.
// ============================================================
export function buildMinimapPlugin() {
  return ViewPlugin.fromClass(class {
    constructor(view) {
      this.dom = document.createElement("div");
      this.dom.className = "cm-minimap";
      this.canvas = document.createElement("canvas");
      this.canvas.className = "cm-minimap-canvas";
      this.dom.appendChild(this.canvas);
      this._render(view);
      // Click/drag to scroll
      this.dom.addEventListener("mousedown", (e) => this._seek(e, view));
    }

    update(u) {
      if (u.docChanged || u.viewportChanged || u.geometryChanged) {
        this._render(u.view);
      }
    }

    _render(view) {
      const lines    = view.state.doc.toString().split("\n");
      const maxLines = Math.min(lines.length, 400);
      const W = 120, H = Math.max(60, Math.min(maxLines * 2, 600));
      this.canvas.width  = W;
      this.canvas.height = H;
      this.dom.style.height = H + "px";
      const ctx = this.canvas.getContext("2d");
      const bg  = getComputedStyle(document.documentElement).getPropertyValue("--bg-panel").trim() || "#1e1e2e";
      ctx.fillStyle = bg;
      ctx.fillRect(0, 0, W, H);
      ctx.fillStyle = getComputedStyle(document.documentElement).getPropertyValue("--text-muted").trim() || "#555";
      const lineH = H / maxLines;
      lines.slice(0, maxLines).forEach((line, idx) => {
        if (!line.trim()) return;
        const indent = line.match(/^(\s*)/)[1].length;
        const len    = Math.min((line.trim().length / 120) * W, W - indent * 2);
        ctx.fillRect(indent * 2, idx * lineH, len, Math.max(1, lineH - 0.5));
      });
      // Viewport indicator
      const totalLines = view.state.doc.lines;
      const vpFrom     = view.state.doc.lineAt(view.viewport.from).number;
      const vpTo       = view.state.doc.lineAt(view.viewport.to).number;
      ctx.fillStyle    = "rgba(255,255,255,0.07)";
      ctx.fillRect(0, (vpFrom / totalLines) * H, W, ((vpTo - vpFrom) / totalLines) * H);
    }

    _seek(e, view) {
      const rect  = this.canvas.getBoundingClientRect();
      const ratio = (e.clientY - rect.top) / rect.height;
      const line  = Math.floor(ratio * view.state.doc.lines) + 1;
      const pos   = view.state.doc.line(Math.max(1, Math.min(line, view.state.doc.lines))).from;
      view.dispatch({ effects: EditorView.scrollIntoView(pos, { y: "center" }) });
    }

    destroy() { this.dom.remove(); }
  });
}

// ============================================================
// Format modifier map, &l bold, &o italic, &n underline, &m strikethrough,
// &k obfuscated, &r reset. These are parsed from the theme's skript_colors
// but also hardcoded as fallback since themes may set them to null.
// ============================================================
const FORMAT_MODIFIER_STYLES = {
  '&l': 'font-weight:bold',
  '&o': 'font-style:italic',
  '&n': 'text-decoration:underline',
  '&m': 'text-decoration:line-through',
  '&k': 'opacity:0.4;letter-spacing:2px', // obfuscated approximation
  '&r': '',  // reset, handled by stopping current run
};

// ============================================================
// Minecraft color-code decoration plugin
// Handles &0-&f colors, &l &o &n &m &k &r format modifiers,
// <#RRGGBB> inline hex codes (colors following text until &r / next tag),
// and MiniMessage tags: <color>, <rainbow>, <b>, <i>, <u>, <st>, <obf>, </reset>
// ============================================================
const AMP_CODE_RE  = /&([0-9a-fk-orA-FK-OR])/g;
const HEX_OPEN_RE  = /<(#[0-9a-fA-F]{6})>/g;
const HEX_CLOSE_RE = /<\/#[0-9a-fA-F]{6}>/g;

// MiniMessage named colors (Adventure API standard palette)
const MINIMESSAGE_COLORS = {
  black: '#000000', dark_blue: '#0000AA', dark_green: '#00AA00',
  dark_aqua: '#00AAAA', dark_red: '#AA0000', dark_purple: '#AA00AA',
  gold: '#FFAA00', gray: '#AAAAAA', grey: '#AAAAAA', dark_gray: '#555555',
  dark_grey: '#555555', blue: '#5555FF', green: '#55FF55', aqua: '#55FFFF',
  red: '#FF5555', light_purple: '#FF55FF', yellow: '#FFFF55', white: '#FFFFFF',
};

// MiniMessage format tags
const MINIMESSAGE_FORMAT = {
  b: 'font-weight:bold', bold: 'font-weight:bold',
  i: 'font-style:italic', italic: 'font-style:italic',
  u: 'text-decoration:underline', underlined: 'text-decoration:underline',
  st: 'text-decoration:line-through', strikethrough: 'text-decoration:line-through',
  obf: 'opacity:0.4;letter-spacing:2px', obfuscated: 'opacity:0.4;letter-spacing:2px',
};

// Rainbow colors for <rainbow> tag approximation
const RAINBOW_COLORS = ['#FF5555','#FFAA00','#FFFF55','#55FF55','#55FFFF','#5555FF','#FF55FF'];

/**
 * Parse MiniMessage tags in a line of text and return an array of decoration spans.
 * Each entry: { from, to, style }, indices are within `text`.
 */
function parseMiniMessageDecorations(text) {
  const decos = [];
  const tagRe = /<(\/?)([a-zA-Z_][a-zA-Z0-9_]*|#[0-9a-fA-F]{6})(?::([^>]*))?>/g;
  let tagMatch;
  const opens = [];

  while ((tagMatch = tagRe.exec(text)) !== null) {
    const isClose = tagMatch[1] === '/';
    const name    = tagMatch[2].toLowerCase();
    const arg     = tagMatch[3] || '';
    const tagStart = tagMatch.index;
    const tagEnd   = tagMatch.index + tagMatch[0].length;
    if (isClose) {
      // Closing tag: find the matching open, apply color/style span, remove from stack
      const matchName = name === 'reset' ? null : name;
      // Find the last matching open tag
      let openIdx = -1;
      for (let i = opens.length - 1; i >= 0; i--) {
        if (matchName === null || opens[i].name === matchName) {
          openIdx = i;
          break;
        }
      }
      if (openIdx !== -1) {
        const open = opens[openIdx];
        // Emit the tag styling
        decos.push({ from: open.tagStart, to: open.tagEnd, style: 'color:var(--syn-formatCode);opacity:0.75;font-weight:bold' });
        // Emit the content between open and close
        const contentStart = open.tagEnd;
        const contentEnd   = tagStart;
        if (contentEnd > contentStart) {
          const parts = [];
          if (open.color) parts.push(`color:${open.color}`);
          if (open.style) parts.push(open.style);
          if (parts.length) decos.push({ from: contentStart, to: contentEnd, style: parts.join(';') });
        }
        // Emit the close tag styling
        decos.push({ from: tagStart, to: tagEnd, style: 'color:var(--syn-formatCode);opacity:0.6;font-weight:bold' });
        opens.splice(openIdx, 1);
      } else {
        // Unknown close, just dim the tag
        decos.push({ from: tagStart, to: tagEnd, style: 'color:var(--syn-formatCode);opacity:0.5' });
      }
      continue;
    }

    // Opening tag
    let color = null;
    let fmtStyle = null;

    if (name === 'rainbow') {
      // Special: color each char after this tag differently. We track it but handle inline.
      color = RAINBOW_COLORS[0]; // placeholder; special handling below
      opens.push({ tagStart, tagEnd, color: null, style: null, name: 'rainbow', rainbow: true });
      decos.push({ from: tagStart, to: tagEnd, style: 'color:var(--syn-formatCode);opacity:0.75;font-weight:bold' });
      continue;
    }

    if (name === 'reset') {
      // Close all active opens, just mark the tag
      opens.length = 0;
      decos.push({ from: tagStart, to: tagEnd, style: 'color:var(--syn-formatCode);opacity:0.75' });
      continue;
    }

    // click:, hover:, key:, font:, etc. structural/non-visual tags, just dim them
    if (['click','hover','insertion','font','lang','translate','selector','score','nbt','keybind'].includes(name)) {
      decos.push({ from: tagStart, to: tagEnd, style: 'color:var(--syn-formatCode);opacity:0.5;font-style:italic' });
      continue;
    }

    // Named color
    if (MINIMESSAGE_COLORS[name]) {
      color = MINIMESSAGE_COLORS[name];
    }
    // color:#rrggbb argument
    if (name === 'color' && /^#[0-9a-fA-F]{6}$/.test(arg)) {
      color = arg;
    }
    // Format modifier
    if (MINIMESSAGE_FORMAT[name]) {
      fmtStyle = MINIMESSAGE_FORMAT[name];
    }

    if (color || fmtStyle) {
      opens.push({ tagStart, tagEnd, color, style: fmtStyle, name });
    } else {
      // Unknown tag, dim it
      decos.push({ from: tagStart, to: tagEnd, style: 'color:var(--syn-formatCode);opacity:0.4' });
    }
  }

  // Any unclosed opens: apply their style to end of line
  for (const open of opens) {
    decos.push({ from: open.tagStart, to: open.tagEnd, style: 'color:var(--syn-formatCode);opacity:0.75;font-weight:bold' });
    if (open.tagEnd < text.length) {
      const parts = [];
      if (open.color) parts.push(`color:${open.color}`);
      if (open.style) parts.push(open.style);
      if (parts.length) decos.push({ from: open.tagEnd, to: text.length, style: parts.join(';') });
    }
  }

  return decos;
}

/**
 * Parse inline <#RRGGBB> hex codes (without closing tag), colors text after the tag
 * until &r, another color code, or end of line.
 * Returns array of { from, to, style }.
 */
function findSkriptStringClose(text, insideIdx) {
  // Walk backward to find the opening quote
  let quoteChar = null;
  for (let i = insideIdx - 1; i >= 0; i--) {
    const ch = text[i];
    if (ch === '"' || ch === "'") {
      // Skip doubled (escaped) quotes
      if (i > 0 && text[i - 1] === ch) { i--; continue; }
      quoteChar = ch;
      break;
    }
  }
  if (!quoteChar) return text.length; // not inside a string

  // Walk forward from insideIdx to find the matching lone closing quote
  let i = insideIdx;
  while (i < text.length) {
    const ch = text[i];
    if (ch === '%') {
      // Skip %expression%, these don't close the string
      i++;
      while (i < text.length && text[i] !== '%') i++;
      if (i < text.length) i++; // skip closing %
      continue;
    }
    if (ch === quoteChar) {
      // Doubled quote = escaped, not a close
      if (i + 1 < text.length && text[i + 1] === quoteChar) { i += 2; continue; }
      return i; // lone quote = string close
    }
    i++;
  }
  return text.length; // string runs to end of line
}

function parseInlineHexDecorations(text) {
  const decos = [];
  const inlineRe = /<(#[0-9a-fA-F]{6})>/g;
  let m;
  while ((m = inlineRe.exec(text)) !== null) {
    const color    = m[1];
    const tagStart = m.index;
    const tagEnd   = m.index + m[0].length;

    // Find where the enclosing Skript string closes, hex must not bleed past it
    const strClose = findSkriptStringClose(text, tagStart);

    // Check for a matching explicit closing tag within the string
    const closeRe = new RegExp(`<\\/${color}>`, 'g');
    closeRe.lastIndex = tagEnd;
    const closeMatch = closeRe.exec(text);
    const closeInStr = closeMatch && closeMatch.index < strClose ? closeMatch : null;

    if (closeInStr) {
      // Paired <#hex>…</#hex>, style tag, content, close tag
      decos.push({ from: tagStart, to: tagEnd,   style: `color:${color};font-weight:bold;opacity:0.75` });
      if (closeInStr.index > tagEnd)
        decos.push({ from: tagEnd, to: closeInStr.index, style: `color:${color}` });
      decos.push({ from: closeInStr.index, to: closeInStr.index + closeInStr[0].length, style: `color:${color};opacity:0.6` });
      inlineRe.lastIndex = closeInStr.index + closeInStr[0].length;
    } else {
      // Unpaired: color flows until &r / next color tag / string close / end of line
      decos.push({ from: tagStart, to: tagEnd, style: `color:${color};font-weight:bold;opacity:0.75` });

      let runEnd = strClose; // never bleed past the string boundary

      // Also stop at next amp color code
      const nextAmpRe = /&[0-9a-fk-orA-FK-OR]/g;
      nextAmpRe.lastIndex = tagEnd;
      const nextAmpM = nextAmpRe.exec(text);
      if (nextAmpM && nextAmpM.index < runEnd) runEnd = nextAmpM.index;

      // Also stop at next hex tag
      const nextHexRe = /<#[0-9a-fA-F]{6}>/g;
      nextHexRe.lastIndex = tagEnd;
      const nextHexM = nextHexRe.exec(text);
      if (nextHexM && nextHexM.index < runEnd) runEnd = nextHexM.index;

      if (runEnd > tagEnd)
        decos.push({ from: tagEnd, to: runEnd, style: `color:${color}` });

      inlineRe.lastIndex = runEnd;
    }
  }
  return decos;
}

export function buildColorCodePlugin(skriptColors = {}) {
  // Normalise keys to lowercase
  const colorMap = {};
  for (const [k, v] of Object.entries(skriptColors)) {
    if (v && v.startsWith('#')) colorMap[k.toLowerCase()] = v;
  }
  // Always ensure &e is yellow
  if (!colorMap['&e']) colorMap['&e'] = '#FFFF55';

  return ViewPlugin.fromClass(
    class {
      constructor(view) { this.decorations = this._build(view); }
      update(update) {
        if (update.docChanged || update.viewportChanged)
          this.decorations = this._build(update.view);
      }

      _build(view) {
        const builder = new RangeSetBuilder();
        const doc     = view.state.doc;

        for (const { from, to } of view.visibleRanges) {
          const startLine = doc.lineAt(from).number;
          const endLine   = doc.lineAt(to).number;

          for (let ln = startLine; ln <= endLine; ln++) {
            const line    = doc.line(ln);
            const text    = line.text;
            const lineOff = line.from;
            const raw = []; // { from, to, style }, all in line-local coords

            // ── Pass 1: &X amp codes ──────────────────────────────────────
            AMP_CODE_RE.lastIndex = 0;
            let ampMatch;
            while ((ampMatch = AMP_CODE_RE.exec(text)) !== null) {
              const codeKey  = '&' + ampMatch[1].toLowerCase();
              const color    = colorMap[codeKey];
              const modifier = FORMAT_MODIFIER_STYLES[codeKey];

              if (!color && modifier === undefined) continue;

              const codeStart = ampMatch.index;
              const codeEnd   = codeStart + 2;

              // Style the &X token itself
              const codeStyle = color
                ? `color:${color};font-weight:bold;opacity:0.75`
                : 'color:var(--syn-formatCode);opacity:0.75';
              raw.push({ from: codeStart, to: codeEnd, style: codeStyle });

              // &r: just the token, no run
              if (codeKey === '&r') {
                AMP_CODE_RE.lastIndex = codeEnd;
                continue;
              }

              const searchFrom = ampMatch.index + 2;
              let runColor    = color    || null;
              let runModifier = (modifier !== undefined ? modifier : null);
              let runStart    = searchFrom;

              // Peek ahead for stacked codes (e.g. &c&l)
              {
                const peekRe = /&([0-9a-fk-orA-FK-OR])/g;
                peekRe.lastIndex = runStart;
                let peek;
                while ((peek = peekRe.exec(text)) !== null) {
                  if (peek.index !== runStart) break;
                  const pk = '&' + peek[1].toLowerCase();
                  const pc = colorMap[pk];
                  const pm = FORMAT_MODIFIER_STYLES[pk];
                  if (!pc && pm === undefined) break;
                  const pkStyle = pc
                    ? `color:${pc};font-weight:bold;opacity:0.75`
                    : 'color:var(--syn-formatCode);opacity:0.75';
                  raw.push({ from: peek.index, to: peek.index + 2, style: pkStyle });
                  if (pk === '&r') { runStart = peek.index + 2; runColor = null; runModifier = null; break; }
                  if (pc) runColor = pc;
                  if (pm !== undefined) runModifier = pm;
                  runStart = peek.index + 2;
                  peekRe.lastIndex = runStart;
                }
              }

              // Find enclosing string boundary
              let stringClose = text.length;
              let quoteChar   = null;
              for (let i = ampMatch.index - 1; i >= 0; i--) {
                const ch = text[i];
                if (ch === '"' || ch === "'") {
                  if (i > 0 && text[i - 1] === ch) continue;
                  quoteChar = ch;
                  break;
                }
              }
              if (quoteChar) {
                let i = runStart;
                while (i < text.length) {
                  if (text[i] === quoteChar) {
                    if (i + 1 < text.length && text[i + 1] === quoteChar) { i += 2; continue; }
                    stringClose = i;
                    break;
                  }
                  i++;
                }
              }

              // Run ends at next amp code, next hex tag, or string close
              const nextAmpIdx = text.indexOf('&', runStart);
              const nextHexIdx = text.indexOf('<#', runStart);
              let runEnd = stringClose;
              if (nextAmpIdx !== -1 && nextAmpIdx < runEnd) runEnd = nextAmpIdx;
              if (nextHexIdx !== -1 && nextHexIdx < runEnd) runEnd = nextHexIdx;

              if (runEnd > runStart) {
                const parts = [];
                if (runColor)    parts.push(`color:${runColor}`);
                if (runModifier) parts.push(runModifier);
                if (parts.length) raw.push({ from: runStart, to: runEnd, style: parts.join(';') });
              }

              AMP_CODE_RE.lastIndex = runEnd;
            }

            // Pass 2: <#RRGGBB> inline hex codes 
            for (const d of parseInlineHexDecorations(text)) raw.push(d);

            // Pass 3: MiniMessage tags 
            for (const d of parseMiniMessageDecorations(text)) raw.push(d);

            // Emit: sort by from asc, then to desc (wider spans first),
            raw.sort((a, b) => a.from !== b.from ? a.from - b.from : b.to - a.to);
            let watermark = -1; // furthest absolute position emitted
            for (const d of raw) {
              const absFrom = lineOff + Math.max(d.from, 0);
              const absTo   = lineOff + Math.min(d.to, text.length);
              if (absTo <= absFrom) continue;
              // Clip start if it overlaps something already emitted
              const clippedFrom = Math.max(absFrom, watermark);
              if (clippedFrom >= absTo) continue;
              try {
                builder.add(clippedFrom, absTo, Decoration.mark({ attributes: { style: d.style } }));
                if (absTo > watermark) watermark = absTo;
              } catch { /* safety net, should not be needed after clipping */ }
            }
          }
        }

        return builder.finish();
      }
    },
    { decorations: v => v.decorations }
  );
}

// ============================================================
// Hover documentation tooltip
// Shows description + patterns + doc link for syntax entries under cursor
// ============================================================

function buildHoverTooltip() {
  return hoverTooltip((view, pos) => {
    if (!syntaxDB.ready) return null;

    const line    = view.state.doc.lineAt(pos);
    const lineText = line.text.trimStart();
    const firstWord = (lineText.split(/\s+/)[0] || '').toLowerCase().replace(/[^a-z'-]/g, '');

    // Look up the entry
    const candidates = [
      ...(syntaxDB._byWord.get(firstWord) || []),
      ...syntaxDB._general,
    ];

    let hit = null;
    for (const entry of candidates) {
      if (entry.regex && entry.regex.test(lineText)) {
        hit = entry;
        break;
      }
    }

    if (!hit) return null;

    // Build the tooltip DOM
    return {
      pos: line.from,
      end: line.to,
      above: true,
      create() {
        const dom = document.createElement("div");
        dom.className = "sk-hover-tooltip";

        // Category badge
        const badge = document.createElement("span");
        badge.className = `hover-badge hover-badge--${hit.category}`;
        badge.textContent = hit.category;
        dom.appendChild(badge);

        // Name
        const name = document.createElement("strong");
        name.className = "hover-name";
        name.textContent = hit.name || hit.id;
        dom.appendChild(name);

        // Patterns
        if (hit.pat) {
          const pat = document.createElement("code");
          pat.className = "hover-pattern";
          pat.textContent = hit.pat;
          dom.appendChild(pat);
        }

        // Doc link, anchor is just the id (e.g. docs.html#ExprFunction, docs.html#Function)
        const docBase = "https://docs.skriptlang.org/docs.html";
        if (hit.id) {
          const link = document.createElement("a");
          link.className = "hover-doclink";
          link.href = `${docBase}#${encodeURIComponent(hit.id)}`;
          link.target = "_blank";
          link.rel = "noopener";
          link.textContent = "Open in docs →";
          dom.appendChild(link);
        }

        return { dom };
      },
    };
  }, { hoverTime: 400 });
}

// ============================================================
// Editor factory
// ============================================================
let editorView = null;

export function createEditor(container, {
  doc = "",
  tabWidth = 4,
  autocomplete = true,
  indentGuides = true,
  minimap = false,
  fontSize = 14,
  theme = null,
  onChange = null,
  onCursorMove = null,
  onDiagnostics = null,
} = {}) {
  const activeTheme    = theme || DEFAULT_THEME;
  const highlightStyle = buildHighlightStyleFromTheme(activeTheme);

  const extensions = [
    lineNumbers(),
    highlightActiveLineGutter(),
    highlightActiveLine(),
    drawSelection(),
    history(),
    search({ top: false }),
    indentUnit.of(" ".repeat(tabWidth)),
    tabSizeCompartment.of(EditorState.tabSize.of(tabWidth)),
    closeBrackets(),
    indentOnInput(),
    skriptLanguage,
    highlightCompartment.of(syntaxHighlighting(highlightStyle)),
    colorCodeCompartment.of(Prec.highest(buildColorCodePlugin(activeTheme.skript_colors || {}))),
    analyzerCompartment.of(buildAnalyzer()),
    lintGutter(),
    hoverCompartment.of(buildHoverTooltip()),
    indentGuidesCompartment.of(indentGuides ? buildIndentGuidesPlugin() : []),
    minimapCompartment.of(minimap ? buildMinimapPlugin() : []),
    keymap.of([indentWithTab, ...defaultKeymap, ...historyKeymap, ...searchKeymap]),
    EditorView.theme({
      "&": { height: "100%", fontFamily: "var(--font-editor)", fontSize: `${fontSize}px` },
      ".cm-scroller": { overflow: "auto", lineHeight: "1.6" },
      // Tooltip styling
      ".sk-hover-tooltip": {
        background: "var(--bg-panel,#1e1e2e)",
        border: "1px solid var(--border,#2a2a30)",
        borderRadius: "6px",
        padding: "8px 12px",
        maxWidth: "420px",
        fontSize: "12px",
        lineHeight: "1.5",
        display: "flex",
        flexDirection: "column",
        gap: "4px",
        boxShadow: "0 4px 20px #00000060",
      },
      ".hover-badge": {
        fontSize: "10px",
        fontWeight: "700",
        textTransform: "uppercase",
        letterSpacing: "0.06em",
        borderRadius: "3px",
        padding: "1px 5px",
        alignSelf: "flex-start",
      },
      ".hover-badge--effect":     { background: "#16a34a22", color: "#86efac" },
      ".hover-badge--condition":  { background: "#7c3aed22", color: "#c4b5fd" },
      ".hover-badge--expression": { background: "#92400e22", color: "#fde68a" },
      ".hover-badge--event":      { background: "#1e40af22", color: "#7dd3fc" },
      ".hover-badge--type":       { background: "#1e3a8a22", color: "#818cf8" },
      ".hover-badge--function":   { background: "#7c3aed22", color: "#c084f5" },
      ".hover-name": {
        color: "var(--text-primary,#e8e8ec)",
        fontSize: "13px",
      },
      ".hover-pattern": {
        color: "var(--text-muted,#888)",
        fontSize: "11px",
        background: "var(--bg-base,#0f0f10)",
        borderRadius: "3px",
        padding: "2px 5px",
        wordBreak: "break-all",
        display: "block",
      },
      ".hover-doclink": {
        color: "var(--accent,#6B2FA0)",
        fontSize: "11px",
        textDecoration: "none",
        marginTop: "2px",
      },
      ".hover-doclink:hover": { textDecoration: "underline" },
    }),
    EditorView.updateListener.of((update) => {
      if (update.docChanged && onChange) onChange(update.state.doc.toString());
      if (update.selectionSet && onCursorMove) {
        const pos  = update.state.selection.main.head;
        const line = update.state.doc.lineAt(pos);
        onCursorMove(line.number, pos - line.from + 1);
      }
      if (onDiagnostics && (update.docChanged || update.transactions.some(tr => tr.effects.length))) {
        clearTimeout(update.view._diagTimer);
        update.view._diagTimer = setTimeout(() => {
          const diags = [];
          const { forEachDiagnostic } = _lintMod;
          if (forEachDiagnostic) {
            forEachDiagnostic(update.view.state, (d) => diags.push(d));
          }
          onDiagnostics(diags, update.view);
        }, 700);
      }
    }),
  ];

  if (autocomplete) {
    extensions.push(autocompleteCompartment.of(
      autocompletion({ activateOnTyping: true, override: [skriptAutocomplete] })
    ));
  } else {
    extensions.push(autocompleteCompartment.of([]));
  }

  const state = EditorState.create({ doc, extensions });
  editorView = new EditorView({ state, parent: container });

  initSyntaxDB({
    onProgress: (msg) => {
      if (msg) console.log('[SyntaxDB]', msg);
      if (msg === null && editorView) {
        editorView.dispatch({ changes: { from: 0, to: 0, insert: '' } });
      }
    },
  });

  return editorView;
}

export const getEditorView    = () => editorView;
export const setEditorContent = (v, c) => v.dispatch({ changes: { from: 0, to: v.state.doc.length, insert: c } });
export const getEditorContent = (v) => v.state.doc.toString();

export function reconfigureTabWidth(view, tw) {
  view.dispatch({ effects: tabSizeCompartment.reconfigure(EditorState.tabSize.of(tw)) });
}
export function reconfigureAutocomplete(view, enabled) {
  view.dispatch({
    effects: autocompleteCompartment.reconfigure(
      enabled ? autocompletion({ activateOnTyping: true, override: [skriptAutocomplete] }) : []
    ),
  });
}
export function reconfigureIndentGuides(view, enabled) {
  view.dispatch({
    effects: indentGuidesCompartment.reconfigure(enabled ? buildIndentGuidesPlugin() : []),
  });
}
export function reconfigureMinimap(view, enabled) {
  view.dispatch({
    effects: minimapCompartment.reconfigure(enabled ? buildMinimapPlugin() : []),
  });
}
export function reconfigureTheme(view, theme) {
  applyThemeToDOM(theme);
  view.dispatch({
    effects: [
      highlightCompartment.reconfigure(syntaxHighlighting(buildHighlightStyleFromTheme(theme))),
      colorCodeCompartment.reconfigure(Prec.highest(buildColorCodePlugin(theme.skript_colors || {}))),
    ],
  });
}

// ============================================================
// Autocomplete
// ============================================================

const STATIC_COMPLETIONS = [
  ...["on join:","on quit:","on death:","on respawn:","on chat:","on command:",
      "on move:","on block break:","on block place:","on damage:",
      "on right click:","on left click:","on first join:",
      "on enable:","on disable:","on load:","on unload:"].map(label => ({ label, type: "keyword", detail: "event" })),
  ...["send %text% to %player%","broadcast %text%","set {_var} to %object%",
      "add %number% to {_var}","remove %number% from {_var}","delete {_var}",
      "teleport %entity% to %location%","give %item% to %player%",
      "kill %entity%","wait %timespan%",
      "execute console command %text%"].map(label => ({ label, type: "function", detail: "effect" })),
  ...["player","event-player","all players","target entity",
      "player's location","player's health","player's name",
      "player's game mode","{_}","{@option}"].map(label => ({ label, type: "variable", detail: "expression" })),
];

function skriptAutocomplete(context) {
  const word = context.matchBefore(/[\w{@_-]*/);
  if (!word || (word.from === word.to && !context.explicit)) return null;

  const options = [...STATIC_COMPLETIONS];

  if (syntaxDB.ready) {
    const prefix = word.text.toLowerCase();
    for (const [w, entries] of syntaxDB._byWord) {
      if (w.startsWith(prefix)) {
        for (const e of entries) {
          options.push({ label: e.pat, type: "keyword", detail: e.category + (e.deprecated ? ' (deprecated)' : '') });
        }
      }
    }
  }

  const seen = new Set();
  const deduped = options.filter(o => { if (seen.has(o.label)) return false; seen.add(o.label); return true; });

  return { from: word.from, options: deduped.slice(0, 200) };
}

// ============================================================
// Default theme (Royal Purple, used before settings load)
// ============================================================
const DEFAULT_THEME = {
  syntax: {
    keyword:     { color: "#c084f5", bold: true },
    event:       { color: "#c084f5", bold: true },
    eventName:   { color: "#7dd3fc", bold: true },
    effect:      { color: "#86efac" },
    condition:   { color: "#c4b5fd" },
    expression:  { color: "#fde68a" },
    variable:    { color: "#f9a8d4" },
    comment:     { color: "#555568", italic: true },
    commentBang: { color: "#f87171", bold: true },
    string:      { color: "#a5f3fc" },
    number:      { color: "#fb923c" },
    type:        { color: "#818cf8" },
    operator:    { color: "#cbd5e1" },
    formatCode:  { color: "#a78bfa", bold: true },
    funcKeyword: { color: "#c084f5", bold: true },
    funcName:    { color: "#fde68a", bold: true },
    paramName:   { color: "#7dd3fc" },
    paramColon:  { color: "#cbd5e1" },
    paramType:   { color: "#a5f3fc" },
    punctuation: { color: "#cbd5e1" },
    property:    { color: "#94a3b8" },
  },
  skript_colors: {
    "&0": "#000000", "&1": "#0000AA", "&2": "#00AA00", "&3": "#00AAAA",
    "&4": "#AA0000", "&5": "#AA00AA", "&6": "#FFAA00", "&7": "#AAAAAA",
    "&8": "#555555", "&9": "#5555FF", "&a": "#55FF55", "&b": "#55FFFF",
    "&c": "#FF5555", "&d": "#FF55FF", "&e": "#FFFF55", "&f": "#FFFFFF",
    "&l": null, "&o": null, "&n": null, "&m": null, "&k": null, "&r": null,
  },
};
