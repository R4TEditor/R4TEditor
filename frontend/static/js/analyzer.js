/**
 * R4TEditor -- Skript Syntax Analyzer
 *
 * Uses CodeMirror's linter API to validate lines against the loaded syntaxDB.
 *
 * Rules:
 *  - Lines ending with  #! ignore  (case-insensitive) are skipped entirely.
 *  - Blank lines, pure comments (#), section headers (ending with :), and
 *    option/variable declarations are skipped we can't reliably validate them.
 *  - If syntaxDB isn't ready yet, the linter returns nothing (silent until ready).
 *  - A line is only flagged when we have high confidence it SHOULD match something
 *    but doesn't i.e. the first word is a known leading word in the DB for
 *    effects/conditions/events, but no pattern fully matches the line.
 *  - If the first word is completely unknown to the DB, we stay silent
 *    (could be an addon, could be user prose, we don't know).
 */

import { linter } from "https://esm.sh/@codemirror/lint@6";
import { syntaxDB } from "/static/js/syntaxdb.js";

// Helpers

/** Strip inline comments and trailing whitespace from a raw line. */
function stripComment(raw) {
  // A # not inside a string is a comment. Simple heuristic: find first bare #.
  let inStr = false;
  let strChar = null;
  for (let i = 0; i < raw.length; i++) {
    const ch = raw[i];
    if (!inStr && (ch === '"' || ch === "'")) { inStr = true; strChar = ch; continue; }
    if (inStr && ch === strChar) {
      // Skript escaped quote: "" stays in string
      if (raw[i + 1] === strChar) { i++; continue; }
      inStr = false; continue;
    }
    if (!inStr && ch === '#') return raw.slice(0, i).trimEnd();
  }
  return raw.trimEnd();
}

/** Return true if the line ends with  #! ignore  (after stripping trailing space). */
function hasIgnoreDirective(raw) {
  // Accept  #! ignore  anywhere at the end, case-insensitive, with optional spaces.
  return /\s*#!\s*ignore\s*$/i.test(raw);
}

/** Return true if the line is a section header (ends with : after stripping strings/comments). */
function isSectionHeader(stripped) {
  return stripped.endsWith(':');
}

/** Return true if the line is entirely a comment or blank. */
function isCommentOrBlank(raw) {
  const t = raw.trimStart();
  return t === '' || t.startsWith('#');
}

/** Return true if the line is an options/variables/aliases block member. */
function isDeclaration(stripped) {
  // "option-name: value"  or  "{variable}: value"
  return /^[\w-]+\s*:/.test(stripped) || stripped.startsWith('{');
}

/**
 * The first plain word of the stripped, de-indented line.
 * e.g. "    send %text% to player" → "send"
 */
function firstWord(stripped) {
  return (stripped.trimStart().split(/\s+/)[0] || '').toLowerCase().replace(/[^a-z'-]/g, '');
}

/**
 * Returns true if any entry in syntaxDB for `word` belongs to one of the
 * given categories, meaning we have pattern knowledge for this word.
 */
function knownLeadWord(word, ...categories) {
  const entries = syntaxDB._byWord.get(word) || [];
  return entries.some(e => categories.includes(e.category));
}

// Linter factory

/**
 * Build a CodeMirror linter extension.
 * Call this once; it captures syntaxDB by reference so it always sees the
 * latest loaded data.
 */
export function buildAnalyzer() {
  return linter((view) => {
    // Stay silent until the DB is loaded, no false positives during startup.
    if (!syntaxDB.ready) return [];

    const diagnostics = [];
    const doc = view.state.doc;

    for (let ln = 1; ln <= doc.lines; ln++) {
      const line   = doc.line(ln);
      const raw    = line.text;

      // Skip: ignore directive 
      if (hasIgnoreDirective(raw)) continue;

      // Skip: blank or comment 
      if (isCommentOrBlank(raw)) continue;

      const stripped = stripComment(raw).trimStart();

      // Skip: section headers (end with :)
      if (isSectionHeader(stripped)) continue;

      // Skip: option/variable declarations
      if (isDeclaration(stripped)) continue;

      // Skip: indented lines that look like plain values or sub-blocks
      // (e.g. "    options:" children, trigger bodies we can't fully parse)
      // We only validate lines whose first word we explicitly know about.
      const fw = firstWord(stripped);
      if (!fw) continue;

      // Only validate lines where the first word is a known lead word
      // for effects, conditions, or events in the DB.
      // Unknown first words → silent (could be addon syntax, prose, etc.)
      const isKnownLead = knownLeadWord(fw, 'effect', 'condition', 'event');
      if (!isKnownLead) continue;

      // Try to classify the full line
      const hit = syntaxDB.classify(stripped);
      if (hit) {
        // Line matched a known pattern.
        if (hit.deprecated) {
          // Warn about deprecated syntax, yellow underline.
          diagnostics.push({
            from:     line.from,
            to:       line.to,
            severity: 'warning',
            message:  `Deprecated syntax: "${hit.name}". Check the Skript docs for the current alternative.`,
          });
        }
        // Otherwise: valid, no diagnostic.
        continue;
      }

      //No pattern matched: flag as an error
      // We know the first word is a real Skript keyword, but nothing in the
      // DB matched the full line, likely a syntax mistake.
      diagnostics.push({
        from:     line.from,
        to:       line.to,
        severity: 'error',
        message:  `Unknown or invalid syntax. "${fw}" is a known Skript keyword but this line doesn't match any loaded pattern. Add  #! ignore  to suppress.`,
      });
    }

    return diagnostics;
  }, {
    // Debounce: don't hammer the DB on every keystroke.
    delay: 600,
  });
}
