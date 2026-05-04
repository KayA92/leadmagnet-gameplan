// programmes-csv-to-json.js — Accountex programme data pipeline
//
// Converts programme.csv → data/programme.json with optional two-layer Haiku
// pain scoring.  Mirrors the exhibitor pipeline exactly; see scripts/README.md.
//
// Run modes:
//   node scripts/programmes-csv-to-json.js
//       Phase 1 only: rebuild JSON from CSV, preserve any existing pain_scores.
//       No API calls. Runs in under a second.
//
//   node scripts/programmes-csv-to-json.js --score
//       Full scoring run: ~384 sessions × 37 tags, ~$0.70–$1.20, ~6–8 min.
//       Writes data/programme.json + data/programmes-pain-scores.csv.
//
//   node scripts/programmes-csv-to-json.js --score --tag mtd-volume
//       Re-score one tag across all sessions (compact prompt, ~1/37th tokens).
//       Estimated cost: ~$0.03–$0.05.
//
//   node scripts/programmes-csv-to-json.js --score --programme "MTD"
//       Re-score all sessions whose title contains "MTD" (case-insensitive).
//
//   node scripts/programmes-csv-to-json.js --score --programme "MTD" --tag mtd-volume
//       Pre-flight test: one session × one tag, ~$0.00.
//
//   node scripts/programmes-csv-to-json.js --csv
//       Write data/programmes-pain-scores.csv from current programme.json (no API call).
//       Can be combined with --score: node ... --score --csv
//
// API key: store in scripts/.env as ANTHROPIC_API_KEY=sk-ant-...
//
// Valid tag IDs: ai-start, ai-data-mess, mtd-volume, mtd-clients, margin,
//   hiring, retention, burnout, docs, chasing, defensible-files, aml,
//   disconnected, ai-roi, advisory, advisory-charge, winning, ai-team,
//   cyber, penalties, frs102, portal, ai-govern, ai-skills, onboarding,
//   month-end, bankfeeds, cpd, career, leadership, cashflow,
//   pe, exit, outsource, niche, cross-border, rd

'use strict';
const fs    = require('fs');
const path  = require('path');
const https = require('https');

const { PAIN_TAGS } = require('./pain-tags');

// ── Category map: raw CSV strings → filter keys ───────────────────────────────

const CAT_MAP = {
  'AI':                                                                          ['ai-automation'],
  'AI & Automation':                                                             ['ai-automation'],
  'AI / Bookkeeping':                                                            ['ai-automation', 'bookkeeping'],
  'AI / Practice Management':                                                    ['ai-automation', 'practice-management'],
  'AML - Anti Money Laundering':                                                 ['aml-kyc'],
  'AML/KYC':                                                                     ['aml-kyc'],
  'Auto Enrolment / Pensions':                                                   ['payroll'],
  'Banking & Payments':                                                          ['banking-payments'],
  'Banking Services':                                                            ['banking-payments'],
  'Bookkeeping':                                                                 ['bookkeeping'],
  'Bookkeeping / AI':                                                            ['bookkeeping', 'ai-automation'],
  'CRM & Comms':                                                                 ['crm-comms'],
  'Change Management':                                                           ['practice-management'],
  'Client Relationships / Customer Service':                                     ['practice-management'],
  'Communication':                                                               ['practice-management'],
  'Cyber Security':                                                              ['cyber-security'],
  'Data & Analytics':                                                            ['data-analytics'],
  'Data Analytics':                                                              ['data-analytics'],
  'Diversity':                                                                   ['hr-people'],
  'Doc Automation':                                                              ['doc-automation'],
  'Document Management':                                                         ['doc-management'],
  'E Invoicing':                                                                 ['banking-payments'],
  'Education & Qualifications':                                                  ['practice-management'],
  'Engagement / Recruitment / Training / Development / Upskilling / Retention / HR': ['hr-people'],
  'Equality & Inclusion':                                                        ['hr-people'],
  'Exit Strategies':                                                             ['practice-management'],
  'Expenses':                                                                    ['expenses'],
  'Fractional CFO - Training / Systems / Advice':                                ['practice-management'],
  'HR & Leadership':                                                             ['hr-people'],
  'HR & People':                                                                 ['hr-people'],
  'How To Influence Up / How To Sell Yourself':                                  ['practice-management'],
  'Market Overview & Insight':                                                   ['marketing-growth'],
  'Market Trends':                                                               ['marketing-growth'],
  'Marketing & Growth':                                                          ['marketing-growth'],
  'Mental Health & Wellbeing':                                                   ['hr-people'],
  'Motivation / Leadership / Mindset':                                           ['practice-management'],
  'Neurodiversity':                                                              ['hr-people'],
  'Open Banking':                                                                ['banking-payments'],
  'Outsourcing':                                                                 ['outsourcing'],
  'Payment / FX':                                                                ['banking-payments'],
  'Payroll':                                                                     ['payroll'],
  'Practice Management':                                                         ['practice-management'],
  'Practice Management / Progressive Practice':                                  ['practice-management'],
  'Practice Management / Scaling':                                               ['practice-management'],
  'Pricing':                                                                     ['practice-management', 'marketing-growth'],
  'Regulation & Legislation':                                                    ['tax-mtd'],
  'Sales & Marketing / Branding':                                                ['marketing-growth'],
  'Sales & Marketing / Branding / Social Media':                                 ['marketing-growth'],
  'Sales & Marketing / Networking':                                              ['marketing-growth'],
  'Sales & Marketing / Scaling':                                                 ['marketing-growth', 'practice-management'],
  'Sales & Marketing / Social Media':                                            ['marketing-growth'],
  'Scaling / Practice Growth':                                                   ['practice-management', 'marketing-growth'],
  'Tax & MTD':                                                                   ['tax-mtd'],
  'Tax / VAT / MTD':                                                             ['tax-mtd'],
  'Time Management / Productivity':                                              ['practice-management'],
  'eSign':                                                                       ['esign'],
  // Unmapped
  'Advisory':                                                     [],
  'Carbon accounting / Sustainability / ESG':                     [],
  'CFO':                                                          [],
  'Client Communication':                                         [],
  'Corp Responsibility':                                          [],
  'Digital Assets / Blockchain / Crypto Currency':               [],
  'Insolvency':                                                   [],
  'Legal':                                                        [],
  'Other':                                                        [],
  'Research & Development':                                       [],
  'Technology & Software':                                        [],
};

// ── CSV helpers ───────────────────────────────────────────────────────────────

function fixEncoding(s) {
  return (s || '')
    .replace(/â€™/g, "'").replace(/â€œ/g, '“').replace(/â€\x9d/g, '”')
    .replace(/â€"/g, '–').replace(/â€"/g, '—')
    .replace(/â/g, '–')
    .replace(/Ã©/g, 'é').replace(/Ã¨/g, 'è').replace(/Ã /g, 'à')
    .trim();
}

function parseCSV(text) {
  const rows = [];
  let row = [], field = '', inQuote = false;
  const chars = text.replace(/\r/g, '');
  for (let i = 0; i < chars.length; i++) {
    const c = chars[i];
    if (inQuote) {
      if (c === '"' && chars[i + 1] === '"') { field += '"'; i++; }
      else if (c === '"') inQuote = false;
      else field += c;
    } else {
      if (c === '"') inQuote = true;
      else if (c === ',') { row.push(field); field = ''; }
      else if (c === '\n') { row.push(field); rows.push(row); row = []; field = ''; }
      else field += c;
    }
  }
  if (field || row.length) { row.push(field); rows.push(row); }
  return rows;
}

// ── Phase 2: scoring infrastructure ──────────────────────────────────────────

function loadEnv() {
  const envPath = path.join(__dirname, '.env');
  if (!fs.existsSync(envPath)) return;
  fs.readFileSync(envPath, 'utf8').split('\n').forEach(line => {
    const m = line.match(/^([^=]+)=(.*)$/);
    if (m) process.env[m[1].trim()] = m[2].trim();
  });
}

function findMatchedSignals(programme) {
  const corpus = [
    programme.theatre,
    programme.old_categories,
    programme.categories,
    programme.description,
  ].join(' ').toLowerCase();

  const hits = {};
  for (const tag of PAIN_TAGS) {
    const matched = tag.signals.filter(sig =>
      corpus.includes(sig.toLowerCase())
    );
    if (matched.length) hits[tag.id] = matched;
  }
  return hits;
}

function buildSystemPrompt() {
  const tagBlock = PAIN_TAGS.map(t =>
    `  "${t.id}" — ${t.label} [band: ${t.band}]\n  ${t.context}`
  ).join('\n\n');

  return `You are a conference-session pain-score analyst for Accountex 2026. Your job is to
score conference sessions (talks, panels, workshops, keynotes) against 37 pain tags that
represent the real-world problems of UK accounting practitioners.

OUTPUT FORMAT — respond with ONLY a raw JSON object, no markdown, no prose:
{
  "pain_scores": {
    "<tag-id>": { "score": <0.00–1.00>, "reason": "<one short sentence>" },
    ...all 37 tags...
  }
}

SCORING RUBRIC:
  1.00 — Session is entirely about this pain; a practitioner with this problem would attend solely for this
  0.75 — Session substantially addresses this pain alongside 1–2 other topics
  0.50 — Session mentions or touches on this pain; relevant but not a primary focus
  0.25 — Tangential relevance; a practitioner with this pain might find partial value
  0.00 — No meaningful relevance; scoring higher would mislead the recommendation engine

RULES:
- Score ALL 37 tags; omit none
- Scores must be to 2 decimal places (e.g. 0.75, not 0.8)
- Do not inflate scores to seem helpful — a 0.00 is correct and expected for most tags per session
- The reason must explain WHY this session score is what it is — not just echo the tag label
- Base scores primarily on the session description and title
- Speaker names and companies are context only; do not score by brand association alone

THEATRE CONTEXT — use this to identify which pain tag families are plausible for this session:
  "Theatre 11 - AI"                        → candidate tags: ai-start, ai-roi, ai-team, ai-govern, ai-skills
  "Theatre 13 - Tax & Compliance"          → candidate tags: mtd-volume, mtd-clients, penalties, frs102, aml
  "Theatre 6 - Bookkeepers"                → candidate tags: chasing, bankfeeds, docs, portal, mtd-clients
  "Theatre 7 - Leadership"                 → candidate tags: leadership, retention, burnout, hiring
  "Theatre 12 - Talent"                    → candidate tags: hiring, retention, burnout, ai-skills, career
  "Theatre 10 - App Advisory"              → candidate tags: disconnected, ai-start, advisory
  "Theatre 3 - Practice Excellence"        → candidate tags: advisory, margin, winning, advisory-charge, onboarding
  "Theatre 4 - ACCA Thinkers"              → candidate tags: cpd, career, leadership
  "Theatre 1 - FD Show" / "Theatre 2"     → candidate tags: month-end, cashflow, ai-roi, advisory
  "Bookkeepers' Circle"                    → candidate tags: chasing, bankfeeds, docs, portal
  "Masterclasses"                          → varies — rely on description and categories
  Sponsor theatres (Sage, FreeAgent, etc.) → infer from title and description

Theatre tells you the broad domain — use it to narrow which pain tag families are plausible.
The description and title are the primary evidence for the precise score within that domain.
A session in an AI theatre about AI usage policies should score high on ai-govern but low
on ai-start — theatre does not grant blanket scores across all tags in a family.
Do not let theatre override what the description actually says.

THE 37 PAIN TAGS:
${tagBlock}`;
}

function buildSingleTagSystemPrompt(tag) {
  return `You are a conference-session pain-score analyst for Accountex 2026.

Score ONE pain tag for a conference session and return ONLY this JSON:
{
  "pain_scores": {
    "${tag.id}": { "score": <0.00–1.00>, "reason": "<one short sentence>" }
  }
}

SCORING RUBRIC:
  1.00 — Session is entirely about this pain
  0.75 — Session substantially addresses this pain alongside 1–2 other topics
  0.50 — Session mentions or touches on this pain
  0.25 — Tangential relevance
  0.00 — No meaningful relevance

TAG TO SCORE:
  id:      ${tag.id}
  label:   ${tag.label}
  band:    ${tag.band}
  context: ${tag.context}

Score to 2 decimal places. Base score on description and title first; theatre narrows plausibility.`;
}

function buildUserPrompt(p, matchedSignals) {
  const speakerLines = (p.speakers || [])
    .map(s => `  ${s.name} (${s.job_title}, ${s.company})`)
    .join('\n') || '  (none listed)';

  const signalLines = Object.keys(matchedSignals).length
    ? Object.entries(matchedSignals)
        .map(([tid, sigs]) => `  ${tid}: ${sigs.join(' | ')}`)
        .join('\n')
    : '  (none found)';

  return `Session ID:     ${p.session_id}
Title:          ${p.title}
Theatre:        ${p.theatre}
Day / Time:     ${p.day}  ${p.start_time}–${p.end_time}
Old categories: ${p.old_categories || '(none)'}
Categories:     ${p.categories || '(none)'}
Speakers:
${speakerLines}
Description:
${p.description || '(none)'}

Pre-matched keyword signals found in session data:
${signalLines}

Score this conference session against all 37 pain tags.`;
}

function callHaiku(systemPrompt, userPrompt) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 4096,
      system: [{ type: 'text', text: systemPrompt, cache_control: { type: 'ephemeral' } }],
      messages: [{ role: 'user', content: userPrompt }],
    });

    const req = https.request({
      hostname: 'api.anthropic.com',
      path: '/v1/messages',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': process.env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
        'anthropic-beta': 'prompt-caching-2024-07-31',
        'Content-Length': Buffer.byteLength(body),
      },
    }, res => {
      let raw = '';
      res.on('data', d => raw += d);
      res.on('end', () => {
        if (res.statusCode === 200) {
          resolve(JSON.parse(raw));
        } else {
          reject(Object.assign(new Error(`HTTP ${res.statusCode}`), { status: res.statusCode, body: raw }));
        }
      });
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

function parseScores(apiResponse) {
  const raw = apiResponse.content[0].text.trim();
  const cleaned = raw.replace(/^```json\s*/i, '').replace(/```\s*$/, '').trim();
  // Try direct parse first; fall back to extracting the first {...} block
  const tryParse = s => { try { const p = JSON.parse(s); return p.pain_scores || p; } catch { return null; } };
  const result = tryParse(cleaned);
  if (result) return result;
  const m = cleaned.match(/\{[\s\S]*\}/);
  return m ? tryParse(m[0]) : null;
}

function writePainScoresCsv(programmes) {
  const tagIds = PAIN_TAGS.map(t => t.id);
  const headers = ['session_id', 'title', 'theatre', ...tagIds, 'top_tags'];
  const rows = programmes.map(p => {
    const scores = p.pain_scores || {};
    const tagCols = tagIds.map(id => (scores[id] ? scores[id].score.toFixed(2) : '0.00'));
    const topTags = tagIds
      .filter(id => scores[id] && scores[id].score >= 0.5)
      .sort((a, b) => scores[b].score - scores[a].score)
      .slice(0, 5)
      .join('; ');
    return [p.session_id, `"${(p.title || '').replace(/"/g, '""')}"`, `"${(p.theatre || '').replace(/"/g, '""')}"`, ...tagCols, `"${topTags}"`].join(',');
  });
  const csv = [headers.join(','), ...rows].join('\n');
  const outPath = path.join(__dirname, '..', 'data', 'programmes-pain-scores.csv');
  fs.writeFileSync(outPath, csv, 'utf8');
  console.log(`Written pain scores CSV → ${outPath}`);
}

async function runScoring(programmes, { tagFilter, programmeFilter }) {
  loadEnv();

  if (!process.env.ANTHROPIC_API_KEY) {
    console.error('ERROR: ANTHROPIC_API_KEY not set. Add it to scripts/.env or export it.');
    process.exit(1);
  }

  const singleTag = tagFilter ? PAIN_TAGS.find(t => t.id === tagFilter) : null;
  if (tagFilter && !singleTag) {
    console.error(`ERROR: Unknown tag "${tagFilter}". Valid IDs: ${PAIN_TAGS.map(t => t.id).join(', ')}`);
    process.exit(1);
  }

  const targets = programmeFilter
    ? programmes.filter(p => p.title.toLowerCase().includes(programmeFilter.toLowerCase()))
    : programmes;

  if (!targets.length) {
    console.error(`No sessions matched --programme "${programmeFilter}"`);
    process.exit(1);
  }

  console.log(`Scoring ${targets.length} session(s)${tagFilter ? ` — tag: ${tagFilter}` : ' — all 37 tags'}`);

  const systemPrompt = singleTag ? buildSingleTagSystemPrompt(singleTag) : buildSystemPrompt();
  let done = 0;

  for (const programme of targets) {
    const matchedSignals = findMatchedSignals(programme);
    const userPrompt = buildUserPrompt(programme, matchedSignals);

    let attempt = 0;
    while (attempt < 3) {
      try {
        const response = await callHaiku(systemPrompt, userPrompt);
        const newScores = parseScores(response);

        if (!newScores) {
          throw new Error(`Unparseable JSON from Haiku: ${response.content[0].text.slice(0, 100)}`);
        }

        if (singleTag) {
          if (!programme.pain_scores) programme.pain_scores = {};
          Object.assign(programme.pain_scores, newScores);
        } else {
          programme.pain_scores = newScores;
        }

        done++;
        const topTag = Object.entries(programme.pain_scores || {})
          .sort((a, b) => b[1].score - a[1].score)[0];
        console.log(
          `[${done}/${targets.length}] ${programme.session_id} — ${programme.title.slice(0, 50)}` +
          (topTag ? `  ⟶ ${topTag[0]}:${topTag[1].score}` : '')
        );
        break;
      } catch (err) {
        attempt++;
        if (attempt >= 3) {
          console.error(`FAILED after 3 attempts: ${programme.session_id} — ${err.message}`);
          break;
        }
        const delay = err.status === 529 || err.status === 500 ? 3000 : 1000;
        console.warn(`  Retry ${attempt}/3 for ${programme.session_id} (${err.message}) — waiting ${delay}ms`);
        await new Promise(r => setTimeout(r, delay));
      }
    }

    await new Promise(r => setTimeout(r, 1000));
  }

  console.log(`Scoring complete: ${done}/${targets.length} sessions scored.`);
}

// ── Main ──────────────────────────────────────────────────────────────────────

const root      = path.join(__dirname, '..');
const csvText   = fs.readFileSync(path.join(root, 'programme.csv'), 'utf8').replace(/^﻿/, '');
const rows      = parseCSV(csvText);
const headers   = rows[0].map(h => h.trim());

const idx = k => headers.indexOf(k);
const H = {
  id:       idx('Session ID'),
  title:    idx('Title'),
  day:      idx('Day'),
  date:     idx('Date'),
  theatre:  idx('Theatre'),
  start:    idx('Start Time'),
  end:      idx('End Time'),
  oldCats:  idx('OLDCategories'),
  cats:     idx('Categories'),
  desc:     idx('Description'),
  url:      idx('Session URL'),
};

const SPEAKERS = 5;

function slugId(str) {
  return 'auto-' + str.toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 60);
}

// Load existing pain_scores keyed by session_id so plain runs preserve them
const outPath = path.join(root, 'data', 'programme.json');
const preservedScores = {};
if (fs.existsSync(outPath)) {
  try {
    const existing = JSON.parse(fs.readFileSync(outPath, 'utf8'));
    existing
      .filter(p => p.session_id && p.pain_scores)
      .forEach(p => { preservedScores[p.session_id] = p.pain_scores; });
    console.log(`Preserved scores for ${Object.keys(preservedScores).length} existing sessions.`);
  } catch (_) { /* first run — no existing JSON */ }
}

const programmes = rows.slice(1)
  .filter(r => r[H.title] && r[H.title].trim())
  .map(r => {
    const get = i => fixEncoding(r[i] || '');

    const rawCats = get(H.cats).split(',').map(c => c.trim()).filter(Boolean);
    const canonicalSet = new Set();
    rawCats.forEach(c => (CAT_MAP[c] || []).forEach(k => canonicalSet.add(k)));

    const speakers = [];
    for (let i = 1; i <= SPEAKERS; i++) {
      const base     = `Speaker ${i} `;
      const nameIdx  = idx(base + 'Name');
      const titleIdx = idx(base + 'Job Title');
      const coIdx    = idx(base + 'Company');
      const urlIdx   = idx(base + 'Profile URL');
      if (nameIdx < 0) break;
      const name = get(nameIdx);
      if (!name) continue;
      speakers.push({
        name,
        job_title:   get(titleIdx),
        company:     get(coIdx),
        profile_url: get(urlIdx),
      });
    }

    const rawId = get(H.id);
    const session_id = rawId || slugId(get(H.title) + '-' + get(H.day) + '-' + get(H.start));

    return {
      session_id,
      title:                get(H.title),
      day:                  get(H.day),
      date:                 get(H.date),
      theatre:              get(H.theatre),
      start_time:           get(H.start),
      end_time:             get(H.end),
      old_categories:       get(H.oldCats),
      categories:           get(H.cats),
      canonical_categories: [...canonicalSet],
      description:          get(H.desc),
      speakers,
      session_url:          get(H.url),
      ...(preservedScores[session_id] ? { pain_scores: preservedScores[session_id] } : {}),
    };
  });

async function main() {
  const args = process.argv.slice(2);
  const doScore      = args.includes('--score');
  const doCsv        = args.includes('--csv');
  const tagIdx       = args.indexOf('--tag');
  const progIdx      = args.indexOf('--programme');
  const tagFilter    = tagIdx  >= 0 ? args[tagIdx  + 1] : null;
  const progFilter   = progIdx >= 0 ? args[progIdx + 1] : null;

  if (doScore) {
    await runScoring(programmes, { tagFilter, programmeFilter: progFilter });
  }
  if (doCsv) {
    writePainScoresCsv(programmes);
  }

  fs.writeFileSync(outPath, JSON.stringify(programmes, null, 2), 'utf8');
  console.log(`Written ${programmes.length} programmes → ${outPath}`);
}

main().catch(err => { console.error(err); process.exit(1); });
