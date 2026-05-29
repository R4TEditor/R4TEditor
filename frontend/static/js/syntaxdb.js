const API = "http://127.0.0.1:7842";
const DOCS_URL = "https://docs.skriptlang.org/docs.json";
function flattenBrackets(pat) {
  let prev;
  do {
    prev = pat;
    pat = pat.replace(/\[([^\[\]]*)\[([^\[\]]*)\]([^\[\]]*)\]/g, '[$1$2$3]');
  } while (pat !== prev);
  return pat;
}
function expandBracketOptionals(s) {
  const out = [];
  let i = 0;
  while (i < s.length) {
    if (s[i] === '[') {
      let depthSq = 1, j = i + 1;
      while (j < s.length && depthSq > 0) {
        if (s[j] === '[') depthSq++;
        else if (s[j] === ']') depthSq--;
        j++;
      }
      const inner = s.slice(i + 1, j - 1);
      out.push(`(?:${inner})?`);
      i = j;
    } else {
      out.push(s[i++]);
    }
  }
  return out.join('');
}
function bundleSpaces(s) {
  let changed = true;
  while (changed) {
    changed = false;

    // Rule A — space BEFORE optional (anywhere in the string except start)
    const newA = s.replace(
      / (\(\?:([^()]*(?:\([^()]*\)[^()]*)*)\)\?)/g,
      (_, grp, inner) => {
        const wrapped = inner.includes('|') ? `(?:\\s+(?:${inner}))?` : `(?:\\s+${inner})?`;
        return wrapped;
      }
    );
    if (newA !== s) { s = newA; changed = true; continue; }

    // Rule B — space AFTER optional at start of string
    const newB = s.replace(
      /^(\(\?:([^()]*(?:\([^()]*\)[^()]*)*)\)\?) /,
      (_, grp, inner) => {
        return inner.includes('|') ? `(?:(?:${inner})\\s+)?` : `(?:${inner}\\s+)?`;
      }
    );
    if (newB !== s) { s = newB; changed = true; }
  }
  return s;
}

/**
 * Convert a Skript syntax pattern string into a JS RegExp.
 * Returns null if the pattern can't be compiled (silently discarded).
 */
function patternToRegex(pat) {
  try {
    // Step 1: flatten nested [] so the bracket scanner never sees [a[b]]
    let s = flattenBrackets(pat);
    // Step 2: escape regex metacharacters not used by Skript syntax
    s = s.replace(/[.+^${}|\\]/g, m => (m === '|' || m === '{' || m === '}') ? m : '\\' + m);
    // Step 3: %type% → lazy capture
    s = s.replace(/%[^%]+%/g, '(.+?)');
    // Step 4: [optional] → (?:...)? using balanced scanner
    s = expandBracketOptionals(s);
    // Step 5: bundle surrounding spaces into optional groups
    s = bundleSpaces(s);
    // Step 6: remaining literal spaces → \s+
    s = s.replace(/ /g, '\\s+');
    return new RegExp('^' + s + '$', 'i');
  } catch {
    return null;
  }
}

function leadingWords(pat) {
  const tokens = pat.split(/\s+/);
  const first  = tokens[0] || '';

  // Optional-first token: [x] or [x|y]
  if (first.startsWith('[') && !first.startsWith('[(')) {
    const words = [];
    // Extract alternatives from the optional
    const inner = first.replace(/^\[|\].*$/g, '');
    for (const alt of inner.split('|')) {
      const w = alt.replace(/[^a-z'-]/gi, '').toLowerCase();
      if (w) words.push(w);
    }
    // Also index the next mandatory token so the pattern is found even when
    // the optional is omitted (e.g. "teleport player …" for "[force] teleport …")
    if (tokens.length > 1) {
      const nxt = tokens[1];
      if (!nxt.startsWith('%') && !nxt.startsWith('[') && !nxt.startsWith('(')) {
        const w = nxt.replace(/[^a-z'-]/gi, '').toLowerCase();
        if (w) words.push(w);
      }
    }
    return words;
  }

  // Alternation group: (a|b|c) or ((a|b)|c|d)
  if (first.startsWith('(')) {
    // Bug 2 fix: strip ALL parens so nested groups are fully expanded
    const noParens = first.replace(/[()]/g, '');
    return noParens.split('|')
      .map(w => w.replace(/[^a-z'-]/gi, '').toLowerCase())
      .filter(Boolean);
  }

  // Plain word
  const word = first.replace(/[^a-z'-]/gi, '').toLowerCase();
  return word ? [word] : [];
}

// ─────────────────────────────────────────────────────────────────────────────
// The SyntaxIndex
// ─────────────────────────────────────────────────────────────────────────────

export class SyntaxIndex {
  constructor() {
    /**
     * word → array of { category, name, id, regex, deprecated }
     * category: "effect"|"condition"|"expression"|"event"|"type"|"function"
     */
    this._byWord = new Map();
    /** fallback list for patterns with no clear leading word */
    this._general = [];
    this.ready = false;
    this.version = null;
  }

  /** Add one syntax entry to the index */
  _add(category, id, name, patterns, deprecated = false) {
    for (const pat of patterns) {
      if (!pat || typeof pat !== 'string') continue;
      const regex = patternToRegex(pat);
      const words = leadingWords(pat);
      const entry = { category, name, id, regex, deprecated, pat };
      if (words.length) {
        for (const w of words) {
          if (!this._byWord.has(w)) this._byWord.set(w, []);
          this._byWord.get(w).push(entry);
        }
      } else {
        this._general.push(entry);
      }
    }
  }

  /**
   * Look up what category the first `wordCount` words of `line` belong to.
   * Returns { category, name, deprecated } or null.
   */
  classify(line) {
    const trimmed = line.trimStart();
    const firstWord = (trimmed.split(/\s+/)[0] || '').toLowerCase().replace(/[^a-z'-]/g, '');
    const candidates = [
      ...(this._byWord.get(firstWord) || []),
      ...this._general,
    ];
    for (const entry of candidates) {
      if (entry.regex && entry.regex.test(trimmed)) {
        return { category: entry.category, name: entry.name, deprecated: entry.deprecated };
      }
    }
    return null;
  }

  /** Quick check: is `word` a known leading keyword for a given category? */
  isLeadWord(word, category) {
    const entries = this._byWord.get(word.toLowerCase()) || [];
    return entries.some(e => e.category === category);
  }

  /** All known leading words for a category (for tokenizer sets) */
  leadWordsFor(category) {
    const out = new Set();
    for (const [word, entries] of this._byWord) {
      if (entries.some(e => e.category === category)) out.add(word);
    }
    return out;
  }

  /** Ingest a docs.json payload */
  ingestDocsJson(data) {
    const version = data?.source?.version || '?';
    this.version = version;
    const ingest = (arr, cat) => {
      if (!Array.isArray(arr)) return;
      for (const item of arr) {
        this._add(cat, item.id, item.name, item.patterns || [], item.deprecated === true);
      }
    };
    ingest(data.conditions,  'condition');
    ingest(data.effects,     'effect');
    ingest(data.expressions, 'expression');
    ingest(data.events,      'event');
    ingest(data.types,       'type');
    ingest(data.functions,   'function');
    ingest(data.sections,    'section');
  }

  /** Ingest a SkriptHub addonsyntaxlist payload */
  ingestSkriptHub(arr) {
    if (!Array.isArray(arr)) return;
    for (const item of arr) {
      if (item.mark_as_removed) continue;
      const cat = item.syntax_type || 'expression'; // effect|expression|condition|event
      const patterns = (item.syntax_pattern || '').split('\r\n').concat(
        (item.syntax_pattern || '').split('\n')
      ).map(p => p.trim()).filter(Boolean);
      this._add(cat, String(item.id), item.title, patterns, false);
    }
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Singleton + fetch logic
// ─────────────────────────────────────────────────────────────────────────────

const CACHE_KEY_DOCS    = 'r4t_syntaxcache_docs';
const CACHE_KEY_HUB     = 'r4t_syntaxcache_hub';
const CACHE_KEY_VER     = 'r4t_syntaxcache_version';
const CACHE_TTL_MS      = 24 * 60 * 60 * 1000; // 24h

export const syntaxDB = new SyntaxIndex();

let _initPromise = null;

/** Initialize the syntax DB. Safe to call multiple times deduplicates. */
export async function initSyntaxDB({ onProgress } = {}) {
  if (_initPromise) return _initPromise;
  _initPromise = _doInit({ onProgress });
  return _initPromise;
}

async function _doInit({ onProgress = () => {} } = {}) {
  onProgress('Loading syntax database…');

  // Try backend proxy first (avoids CORS, backend can cache to SQLite)
  let docsData = null;
  let hubData  = null;

  try {
    const res = await fetch(`${API}/api/syntax/docs`);
    if (res.ok) docsData = await res.json();
  } catch { /* backend offline */ }

  if (!docsData) {
    // Direct fetch (Phase 1 fallback, will hit CORS in prod) 
    try {
      const res = await fetch(DOCS_URL);
      if (res.ok) docsData = await res.json();
    } catch { /* network offline */ }
  }

  if (docsData) {
    syntaxDB.ingestDocsJson(docsData);
    onProgress(`Loaded Skript ${syntaxDB.version || ''} syntax`);
  } else {
    onProgress('Syntax DB offline — using built-in rules');
  }

  // SkriptHub addons (best-effort)
  try {
    const res = await fetch(`${API}/api/syntax/addons`);
    if (res.ok) hubData = await res.json();
    if (hubData) syntaxDB.ingestSkriptHub(hubData);
  } catch { /* addon data optional */ }

  syntaxDB.ready = true;
  onProgress(null);
}
