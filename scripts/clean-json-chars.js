// Cleans corrupted special characters from programme.json and exhibitors.json.
//
// Root cause: UTF-8 three-byte sequences (0xE2 0x80 0xXX) for typographic
// characters had their leading 0xE2 byte stripped during CSV processing,
// leaving the two continuation bytes stored as raw Unicode code points
// U+0080 + U+00XX. Additionally some chars were double-encoded via a
// Latin-1 round-trip (e.g. Ã¶ for o-umlaut, Ã¢¢ for trademark).
//
// Run: node scripts/clean-json-chars.js

const fs = require('fs');
const path = require('path');

const c = String.fromCharCode;

// ── Pair replacements: U+0080 + continuation byte → correct char ─────────────
// All originate from UTF-8 sequences 0xE2 0x80 0xXX with 0xE2 stripped.
const PAIR_MAP = [
  [c(128, 147), '–'], // en dash
  [c(128, 148), '—'], // em dash
  [c(128, 145), '-'],      // non-breaking hyphen → hyphen
  [c(128, 153), '’'], // right single quote / apostrophe
  [c(128, 152), '‘'], // left single quote
  [c(128, 156), '“'], // left double quote
  [c(128, 157), '”'], // right double quote
  [c(128, 162), '•'], // bullet
  [c(128, 166), '…'], // ellipsis
  [c(128, 158), '„'], // double low-9 quotation mark
  [c(128, 147), '–'], // en dash (duplicate guard)
];

// ── Double-encoded Latin-1 sequences → correct char ──────────────────────────
// Must be applied before standalone maps (longest match first).
const DOUBLE_ENCODED = [
  [c(195, 162, 128, 158, 162), '™'], // 5-char corrupted ™ (triple-encoded)
  ['Ã¢¢', '™'],                      // 3-char corrupted ™ (double-encoded)
  ['Ã¶', 'ö'],       // Ã¶  → ö
  ['Ã¼', 'ü'],       // Ã¼  → ü
  ['Ã¤', 'ä'],       // Ã¤  → ä
  ['Ã©', 'é'],       // Ã©  → é
  ['Ã¨', 'è'],       // Ã¨  → è
  ['Ã ', 'à'],       // Ã   → à
];

// ── Orphaned continuation chars that survived after pair cleanup ──────────────
const STANDALONE_MAP = [
  [c(153), '’'], // orphaned right-quote byte → apostrophe
  [c(145), '‘'], // orphaned left-quote byte → left single quote
  [c(149), '•'], // orphaned bullet byte → bullet
  [c(147), '“'], // orphaned left double-quote byte
  [c(148), '”'], // orphaned right double-quote byte
  [c(152), '‘'], // orphaned tilde/left-quote byte
  [c(158), ''],       // orphaned z-caron byte → drop
  [c(128), '-'],      // bare 0x80 → hyphen (last resort)
  ['¢', '•'], // ¢ (cent sign) used as bullet separator
  ['¦', '—'], // ¦ (broken bar) used as em dash
  ['¶', ''],       // ¶ (pilcrow) leftover from double-encoding → drop
];

function cleanString(str) {
  if (!str || typeof str !== 'string') return str;
  let s = str;
  for (const [from, to] of DOUBLE_ENCODED) s = s.split(from).join(to);
  for (const [from, to] of PAIR_MAP) s = s.split(from).join(to);
  for (const [from, to] of STANDALONE_MAP) s = s.split(from).join(to);
  // Collapse double spaces left after removals, trim whitespace
  s = s.replace(/  +/g, ' ').trim();
  return s;
}

function cleanObject(obj) {
  if (typeof obj === 'string') return cleanString(obj);
  if (Array.isArray(obj)) return obj.map(cleanObject);
  if (obj && typeof obj === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(obj)) out[k] = cleanObject(v);
    return out;
  }
  return obj;
}

const files = [
  path.join(__dirname, '../data/programme.json'),
  path.join(__dirname, '../data/exhibitors.json'),
];

for (const file of files) {
  const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  const cleaned = cleanObject(raw);
  fs.writeFileSync(file, JSON.stringify(cleaned, null, 2), 'utf8');

  // Count changed positions
  const before = JSON.stringify(raw);
  const after = JSON.stringify(cleaned);
  let diffs = 0;
  for (let i = 0; i < Math.max(before.length, after.length); i++) {
    if (before[i] !== after[i]) diffs++;
  }
  console.log(`${path.basename(file)}: ~${diffs} character positions changed`);
}
console.log('Done.');
