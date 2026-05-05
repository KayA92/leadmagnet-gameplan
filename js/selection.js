// ============================================================================
// selection.js
//
// Client-side selection logic for booths and programme sessions.
//
// Exports:
//   selectBooths(answers, allExhibitors)  → 9 booths (8 ranked + Workiro at #9)
//   selectSessions(answers, allSessions)  → top ~45 sessions for AI ranking
// ============================================================================

// ── Band weights ──────────────────────────────────────────────────────────────
const BAND_WEIGHTS = {
  scorching:  3.0,
  hot:        2.5,
  warm:       2.0,
  specialist: 1.5,
};

// ── Pain tag → band ───────────────────────────────────────────────────────────
const PAIN_TAG_BANDS = {
  'ai-start':         'scorching',
  'ai-data-mess':     'scorching',
  'mtd-volume':       'scorching',
  'mtd-clients':      'scorching',
  'margin':           'scorching',
  'hiring':           'scorching',
  'retention':        'scorching',
  'burnout':          'scorching',
  'docs':             'hot',
  'chasing':          'hot',
  'defensible-files': 'hot',
  'aml':              'hot',
  'disconnected':     'hot',
  'ai-roi':           'hot',
  'advisory':         'hot',
  'advisory-charge':  'hot',
  'winning':          'hot',
  'ai-team':          'hot',
  'cyber':            'hot',
  'penalties':        'hot',
  'frs102':           'hot',
  'portal':           'hot',
  'ai-govern':        'warm',
  'ai-skills':        'warm',
  'onboarding':       'warm',
  'month-end':        'warm',
  'bankfeeds':        'warm',
  'cpd':              'warm',
  'career':           'warm',
  'leadership':       'warm',
  'cashflow':         'warm',
  'pe':               'specialist',
  'exit':             'specialist',
  'outsource':        'specialist',
  'niche':            'specialist',
  'cross-border':     'specialist',
  'rd':               'specialist',
};

// ── Wizard chip → canonical category translation ──────────────────────────────
// Wizard tool chips use their own slugs (data-cat on the buttons). Exhibitors
// use canonical_categories derived from their CSV Categories column via CAT_MAP.
// These two slug spaces are different — this table bridges them.
// One chip can map to multiple canonicals (e.g. portals-esign covers doc-management).
const WIZARD_CHIP_TO_CANONICAL = {
  'cloud-accounting': ['bookkeeping', 'practice-management'],
  'practice-mgmt':    ['practice-management'],
  'tax-mtd':          ['tax-mtd'],
  'audit':            ['tax-mtd'],
  'bookkeeping':      ['bookkeeping'],
  'payroll':          ['payroll'],
  'doc-mgmt':         ['doc-management'],
  'portals-esign':    ['doc-management'],
  'aml-onboarding':   ['aml-kyc'],
  'forecasting':      ['banking-payments', 'data-analytics'],
  'reporting':        ['data-analytics'],
  'proposals':        ['marketing-growth'],
  'payments':         ['banking-payments'],
  'lending':          ['banking-payments'],
  'outsourcing':      ['outsourcing'],
  'cyber':            ['cyber-security'],
};

// ── Session category matching ─────────────────────────────────────────────────

// Theatre name fragments matched via .includes() on the lowercased theatre string.
// Single-digit theatre numbers MUST have a trailing space ('theatre 3 ') to avoid
// 'theatre 3' matching 'Theatre 3x' — e.g. 'theatre 1' would hit Theatre 10/11/12/13.
const ROLE_THEATRE = {
  founder:     ['theatre 3 ', 'theatre 7 ', 'theatre 8 ', 'theatre 10 ', 'theatre 11 ', 'leadership', 'practice excellence'],
  partner:     ['theatre 3 ', 'theatre 7 ', 'theatre 8 ', 'theatre 10 ', 'theatre 11 ', 'leadership', 'practice excellence'],
  director:    ['theatre 3 ', 'theatre 7 ', 'theatre 8 ', 'theatre 10 ', 'theatre 11 ', 'leadership', 'practice excellence'],
  senior:      ['theatre 3 ', 'theatre 4 ', 'theatre 11 ', 'practice excellence', 'acca'],
  accountant:  ['theatre 3 ', 'theatre 4 ', 'theatre 11 ', 'practice excellence', 'acca'],
  bookkeeper:  ['theatre 6 ', 'bookkeepers'],
  industry:    ['theatre 1 ', 'theatre 2 ', 'fd show'],
  advisor:     ['theatre 1 ', 'theatre 2 ', 'theatre 10 ', 'fd show'],
  'ops-admin': ['theatre 3 ', 'theatre 6 ', 'practice excellence'],
  junior:      ['theatre 12 ', 'talent', 'masterclass'],
  student:     ['theatre 12 ', 'talent', 'masterclass'],
  vendor:      [],
  other:       [],
};

const TIME_FILTERS = {
  'wed-am':   { days: ['Day 1'], startBefore: '13:00', startFrom: null },
  'wed-pm':   { days: ['Day 1'], startBefore: null,    startFrom: '13:00' },
  'wed-full': { days: ['Day 1'], startBefore: null,    startFrom: null },
  'thu-am':   { days: ['Day 2'], startBefore: '13:00', startFrom: null },
  'thu-pm':   { days: ['Day 2'], startBefore: null,    startFrom: '13:00' },
  'thu-full': { days: ['Day 2'], startBefore: null,    startFrom: null },
};


// ── Booth scoring ─────────────────────────────────────────────────────────────
// Scores a single exhibitor against the user's answers.
// Formula: (0.65 × problem_norm) + (0.20 × tool_norm) + (0.15 × manual_boost)
// Returns { score, problemNorm, toolNorm, manualBoost } so callers can store
// the component breakdown alongside the final score for inspection/debugging.
function scoreExhibitor(exhibitor, answers) {
  const { pains = [], categories = [] } = answers;
  const painScores = exhibitor.pain_scores || {};

  // Component 1 — problem score (65%)
  // Two-component: 70% best single pain score + 30% weighted average.
  // Avoids penalising exhibitors that perfectly match one pain out of several selected.
  let raw = 0, max = 0, bestScore = 0;
  for (const tagId of pains) {
    const band = PAIN_TAG_BANDS[tagId];
    if (!band) continue;
    const weight = BAND_WEIGHTS[band];
    max += weight;
    const tagScore = painScores[tagId]?.score || 0;
    raw += tagScore * weight;
    if (tagScore > bestScore) bestScore = tagScore;
  }
  const problemNorm = max > 0 ? (0.60 * bestScore) + (0.40 * (raw / max)) : 0;

  // Component 2 — tool match (20%)
  // Translate each wizard chip slug to its canonical_categories equivalent(s),
  // then check if the exhibitor has any matching canonical. One chip = one match
  // maximum (the set expansion is just for aliasing, not to inflate the count).
  const exhibitorCanonicals = exhibitor.canonical_categories || [];
  let toolMatches = 0;
  for (const chip of categories) {
    const canonicals = WIZARD_CHIP_TO_CANONICAL[chip] || [chip];
    if (canonicals.some(c => exhibitorCanonicals.includes(c))) toolMatches++;
  }
  const TOOL_MATCH_BASE = 0.6;
  const toolNorm = toolMatches === 0 ? 0
    : TOOL_MATCH_BASE + (1 - TOOL_MATCH_BASE) * (toolMatches / categories.length);

  // Component 3 — manual boost (15%)
  const manualBoost = exhibitor.manual_boost || 0;

  return {
    score:       (0.65 * problemNorm) + (0.20 * toolNorm) + (0.15 * manualBoost),
    problemNorm,
    toolNorm,
    manualBoost,
  };
}

// ── Stable sort comparators ───────────────────────────────────────────────────
// Primary: score. Secondary: display name A→Z (company_name for exhibitors,
// title for sessions). This makes ties deterministic for both entity types.
const entityName = e => e.company_name || e.title || '';
const cmpDesc = (a, b) =>
  ((b._score || 0) - (a._score || 0)) || entityName(a).localeCompare(entityName(b));
const cmpAsc = (a, b) =>
  ((a._score || 0) - (b._score || 0)) || entityName(b).localeCompare(entityName(a));

// ── Bucket assignment ─────────────────────────────────────────────────────────
// Assigns _bucket ('top'|'high'|'medium'|'neutral') to every entity based on
// score thresholds, then enforces min/max counts per bucket.
// Accepts optional overrides so exhibitors and sessions can use different bands.
const EXHIBITOR_BUCKETS = {
  thresholds: { top: 0.75,  high: 0.625, medium: 0.50  },
  maximums:   { top: 5,     high: 20,    medium: 20    },
  minimums:   { top: 3,     high: 4,     medium: 4     },
};
const SESSION_BUCKETS = {
  thresholds: { top: 0.70,  high: 0.575, medium: 0.45  },
  maximums:   { top: 5,     high: 20,    medium: 20    },
  minimums:   { top: 3,     high: 7,     medium: 7     },
};
function assignBuckets(ranked, config = EXHIBITOR_BUCKETS) {
  const { thresholds: THRESHOLDS, maximums: MAXIMUMS, minimums: MINIMUMS } = config;

  // Initial assignment by score
  for (const e of ranked) {
    const s = e._score || 0;
    e._bucket = s > THRESHOLDS.top    ? 'top'
              : s > THRESHOLDS.high   ? 'high'
              : s > THRESHOLDS.medium ? 'medium'
              : 'neutral';
  }

  // Sort by score then _rank — _rank is the tiebreaker so that when scores are
  // equal, promotion/demotion always respects the pre-assigned rank order rather
  // than an alphabetical label (which would skip higher-ranked tied sessions).
  const byRankDesc = (a, b) => ((b._score || 0) - (a._score || 0)) || ((a._rank || 0) - (b._rank || 0));
  const byRankAsc  = (a, b) => ((a._score || 0) - (b._score || 0)) || ((b._rank || 0) - (a._rank || 0));

  const scorable = ranked.slice().sort(byRankDesc);

  // Cap maximums: demote lowest-scoring excess entries to the next bucket down.
  // Run top→high→medium so cascaded demotions are handled in one pass.
  const demoteExcess = (fromBucket, toBucket, max) => {
    const inBucket = scorable.filter(e => e._bucket === fromBucket);
    if (inBucket.length <= max) return;
    inBucket.sort(byRankAsc);
    inBucket.slice(0, inBucket.length - max).forEach(e => { e._bucket = toBucket; });
  };

  demoteExcess('top',    'high',    MAXIMUMS.top);
  demoteExcess('high',   'medium',  MAXIMUMS.high);
  demoteExcess('medium', 'neutral', MAXIMUMS.medium);

  // Promote highest-scoring exhibitors to meet minimums.
  // Order matters: fill 'top' first so those slots aren't double-counted for 'high'.
  const promoteToMeet = (toBucket, fromBuckets, min) => {
    const current = scorable.filter(e => e._bucket === toBucket).length;
    if (current >= min) return;
    let needed = min - current;
    for (const e of scorable) {
      if (needed <= 0) break;
      if (fromBuckets.includes(e._bucket)) { e._bucket = toBucket; needed--; }
    }
  };

  promoteToMeet('top',    ['high', 'medium', 'neutral'], MINIMUMS.top);
  promoteToMeet('high',   ['medium', 'neutral'],          MINIMUMS.high);
  promoteToMeet('medium', ['neutral'],                    MINIMUMS.medium);
}

// ── Booth selection ───────────────────────────────────────────────────────────
// Returns ALL exhibitors with _score and _rank assigned.
//
// Ranks 1–11:  size-constrained top picks (2 large + 4 mid + 5 small).
//              Fallback fills short tiers from next-best overall.
// Ranks 12–N:  remaining exhibitors sorted by score descending.
// Workiro:     appended last with _rank: 'host' — always shown in the plan
//              regardless of score.
//
// wizard.js builds the preview from the top 11 + host (Workiro = 12th pill).
// state.filteredExhibitors holds the full list for console inspection.
export function selectBooths(answers, allExhibitors) {
  const pool = allExhibitors.filter(e => {
    if (e.show_category === 'FD Show' && answers.role !== 'industry') return false;
    return true;
  });

  // Score every exhibitor — store final score + component breakdown
  const scored = pool.map(e => {
    const { score, problemNorm, toolNorm, manualBoost } = scoreExhibitor(e, answers);
    return { ...e, _score: score, _problemNorm: problemNorm, _toolNorm: toolNorm, _manualBoost: manualBoost };
  });

  // Split into size buckets sorted by score
  const buckets = { large: [], mid: [], small: [] };
  for (const e of scored) {
    buckets[e.company_size || 'small'].push(e);
  }
  for (const tier of Object.keys(buckets)) {
    buckets[tier].sort(cmpDesc);
  }

  // Pick top N from each tier for slots 1–11.
  // Minimums: 2 large, 4 mid. Remaining 5 filled by next-best score (any tier).
  const TARGETS = { large: 2, mid: 4, small: 5 };
  const selected = [];
  const used = new Set();

  for (const [tier, target] of Object.entries(TARGETS)) {
    let picked = 0;
    for (const e of buckets[tier]) {
      if (picked >= target) break;
      selected.push(e);
      used.add(e.company_name);
      picked++;
    }
  }

  // Fallback: fill remaining slots from best-scoring unpicked (any tier)
  if (selected.length < 11) {
    const overflow = scored
      .filter(e => !used.has(e.company_name))
      .sort(cmpDesc);
    for (const e of overflow) {
      if (selected.length >= 11) break;
      selected.push(e);
      used.add(e.company_name);
    }
  }

  // Sort the selected slots by score so rank 1 = highest scorer
  selected.sort(cmpDesc);

  // Remaining exhibitors ranked 13+ by score
  const rest = scored
    .filter(e => !used.has(e.company_name))
    .sort(cmpDesc);

  // Assign _rank to everyone
  const ranked = [
    ...selected.map((e, i) => ({ ...e, _rank: i + 1 })),
    ...rest.map((e, i) => ({ ...e, _rank: i + 12 })),
  ];

  assignBuckets(ranked);
  return ranked;
}

// ── Programme scoring ─────────────────────────────────────────────────────────
// Formula: (0.75 × problem_norm) + (0.05 × role_theatre_match) + (0.20 × manual_boost)
// problem_norm = (0.60 × best_single_pain_score) + (0.40 × weighted_average)
// role_theatre_match = 1 if session theatre matches user's role, else 0
function scoreProgramme(session, answers) {
  const { pains = [], role } = answers;
  const painScores = session.pain_scores || {};

  let raw = 0, max = 0, bestScore = 0;
  for (const tagId of pains) {
    const band = PAIN_TAG_BANDS[tagId];
    if (!band) continue;
    const weight = BAND_WEIGHTS[band];
    max += weight;
    const tagScore = painScores[tagId]?.score || 0;
    raw += tagScore * weight;
    if (tagScore > bestScore) bestScore = tagScore;
  }
  const problemNorm = max > 0 ? (0.60 * bestScore) + (0.40 * (raw / max)) : 0;

  const theatreLower = (session.theatre || '').toLowerCase();
  const roleTheatreMatch = (ROLE_THEATRE[role] || []).some(t => theatreLower.includes(t)) ? 1 : 0;

  const manualBoost = session.manual_boost || 0;

  return {
    score: (0.75 * problemNorm) + (0.05 * roleTheatreMatch) + (0.20 * manualBoost),
    problemNorm,
    roleTheatreMatch,
    manualBoost,
  };
}

// ── Session selection ─────────────────────────────────────────────────────────
// Scores all time-eligible sessions and returns them fully ranked and bucketed.
// Hard filter: time/day (user can only attend sessions they're there for).
// state.filteredSessions holds the full list for console inspection.
export function selectSessions(answers, allSessions) {
  const { time } = answers;

  const times = Array.isArray(time) ? time : (time ? [time] : []);
  const filters = times.map(t => TIME_FILTERS[t]).filter(Boolean);
  if (filters.length === 0) filters.push(TIME_FILTERS['wed-full']);

  function matchesAnySlot(session) {
    return filters.some(tf => {
      if (!tf.days.includes(session.day)) return false;
      if (tf.startBefore && session.start_time >= tf.startBefore) return false;
      if (tf.startFrom && session.start_time < tf.startFrom) return false;
      return true;
    });
  }

  const seenIds = new Set();
  const scored = [];

  for (const session of allSessions) {
    if (seenIds.has(session.session_id)) continue;
    seenIds.add(session.session_id);
    if (!matchesAnySlot(session)) continue;

    const { score, problemNorm, roleTheatreMatch, manualBoost } = scoreProgramme(session, answers);
    scored.push({ ...session, _score: score, _problemNorm: problemNorm, _roleTheatreMatch: roleTheatreMatch, _manualBoost: manualBoost });
  }

  scored.sort((a, b) => ((b._score || 0) - (a._score || 0)) || (a.session_id || '').localeCompare(b.session_id || ''));

  const ranked = scored.map((s, i) => ({ ...s, _rank: i + 1 }));
  assignBuckets(ranked, SESSION_BUCKETS);
  return ranked;
}
