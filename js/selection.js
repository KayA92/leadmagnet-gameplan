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

const ROLE_THEATRE = {
  founder:     ['leadership', 'practice excellence', 'theatre 3', 'theatre 7'],
  partner:     ['leadership', 'practice excellence', 'theatre 3', 'theatre 7'],
  director:    ['leadership', 'practice excellence', 'theatre 3', 'theatre 7'],
  senior:      ['practice excellence', 'theatre 3', 'acca', 'theatre 4'],
  accountant:  ['practice excellence', 'theatre 3', 'acca', 'theatre 4'],
  bookkeeper:  ['bookkeeper', 'theatre 6'],
  industry:    ['fd show', 'theatre 1', 'theatre 2'],
  advisor:     ['fd show', 'theatre 1', 'theatre 2'],
  'ops-admin': ['practice excellence', 'theatre 6'],
  junior:      ['talent', 'theatre 12', 'masterclass'],
  student:     ['talent', 'theatre 12', 'masterclass'],
  vendor:      [],
  other:       [],
};

const PROBLEM_KEYWORDS = [
  'mtd', 'ai', 'portal', 'onboarding', 'workflow', 'automation',
  'pricing', 'capacity', 'compliance', 'payroll', 'bookkeeping',
  'tax', 'document', 'audit', 'client', 'advisory', 'efficiency',
];

const TIME_FILTERS = {
  'wed-am':   { days: ['Day 1'], startBefore: '13:00', startFrom: null },
  'wed-pm':   { days: ['Day 1'], startBefore: null,    startFrom: '13:00' },
  'wed-full': { days: ['Day 1'], startBefore: null,    startFrom: null },
  'thu-am':   { days: ['Day 2'], startBefore: '13:00', startFrom: null },
  'thu-pm':   { days: ['Day 2'], startBefore: null,    startFrom: '13:00' },
  'thu-full': { days: ['Day 2'], startBefore: null,    startFrom: null },
};

const PINNED_SESSIONS = [
  {
    sessionId: '36304',
    detect: (a) => /\bmtd\b|making tax digital/i.test(a.problem) || a.categories.includes('tax-mtd'),
  },
  {
    sessionId: '36370',
    detect: (a) => /\bmtd\b|making tax digital/i.test(a.problem) || a.categories.includes('tax-mtd'),
  },
  {
    titleMatch: 'MTD Therapy',
    detect: (a) => /\bmtd\b|making tax digital/i.test(a.problem) || a.categories.includes('tax-mtd'),
  },
  {
    sessionId: '36375',
    detect: (a) => /margin|pricing|\bprofit\b|commercial/i.test(a.problem),
  },
];

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
// Tiebreak by company name A→Z so rank and bucket assignments are deterministic.
const cmpDesc = (a, b) =>
  ((b._score || 0) - (a._score || 0)) || (a.company_name || '').localeCompare(b.company_name || '');
const cmpAsc = (a, b) =>
  ((a._score || 0) - (b._score || 0)) || (b.company_name || '').localeCompare(a.company_name || '');

// ── Bucket assignment ─────────────────────────────────────────────────────────
// Assigns _bucket ('top'|'high'|'medium'|'neutral') to every exhibitor based on
// score thresholds, then promotes the highest-scoring exhibitors to meet minimum
// counts so the displayed plan always has a meaningful distribution of labels.
function assignBuckets(ranked) {
  const THRESHOLDS = { top: 0.75, high: 0.625, medium: 0.50 };
  const MAXIMUMS   = { top: 5,    high: 20,    medium: 20   };
  const MINIMUMS   = { top: 3,    high: 4,     medium: 4    };

  // Initial assignment by score
  for (const e of ranked) {
    if (e._rank === 'host') { e._bucket = 'top'; continue; }
    const s = e._score || 0;
    e._bucket = s > THRESHOLDS.top    ? 'top'
              : s > THRESHOLDS.high   ? 'high'
              : s > THRESHOLDS.medium ? 'medium'
              : 'neutral';
  }

  const scorable = ranked
    .filter(e => e._rank !== 'host')
    .sort(cmpDesc);

  // Cap maximums: demote lowest-scoring excess entries to the next bucket down.
  // Run top→high→medium so cascaded demotions are handled in one pass.
  const demoteExcess = (fromBucket, toBucket, max) => {
    const inBucket = scorable.filter(e => e._bucket === fromBucket);
    if (inBucket.length <= max) return;
    inBucket.sort(cmpAsc);
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
  const workiro = allExhibitors.find(e => e.is_host);

  const pool = allExhibitors.filter(e => {
    if (e.is_host) return false;
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

  // Workiro last with a host marker
  if (workiro) {
    const { score, problemNorm, toolNorm, manualBoost } = scoreExhibitor(workiro, answers);
    ranked.push({ ...workiro, _score: score, _problemNorm: problemNorm, _toolNorm: toolNorm, _manualBoost: manualBoost, _rank: 'host' });
  }

  assignBuckets(ranked);
  return ranked;
}

// ── Session pre-filter ────────────────────────────────────────────────────────
// Narrows ~384 sessions to ~45 high-relevance candidates for the AI ranker.
// Filters by time window first, then scores by category match, role-theatre
// affinity, and problem keyword overlap.
export function selectSessions(answers, allSessions) {
  const { categories = [], time, role, problem = '' } = answers;

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

  const problemLower = problem.toLowerCase();
  const boostedTheatres = ROLE_THEATRE[role] || [];

  const wantedCanonicals = new Set();
  for (const chip of categories) {
    for (const canonical of (WIZARD_CHIP_TO_CANONICAL[chip] || [])) {
      wantedCanonicals.add(canonical);
    }
  }

  const scored = [];
  const seenIds = new Set();

  for (const session of allSessions) {
    if (seenIds.has(session.session_id)) continue;
    seenIds.add(session.session_id);

    if (!matchesAnySlot(session)) continue;

    let score = 0;

    for (const canonical of (session.canonical_categories || [])) {
      if (wantedCanonicals.has(canonical)) { score += 2; break; }
    }

    const theatreLower = (session.theatre || '').toLowerCase();
    if (boostedTheatres.some(t => theatreLower.includes(t))) score += 1;

    const sessionText = `${session.title} ${session.description}`.toLowerCase();
    if (PROBLEM_KEYWORDS.some(kw => problemLower.includes(kw) && sessionText.includes(kw))) {
      score += 1;
    }

    scored.push({ ...session, stage1_score: score });
  }

  scored.sort((a, b) => b.stage1_score - a.stage1_score);
  const result = scored.slice(0, 45);

  for (const pin of PINNED_SESSIONS) {
    if (!pin.detect(answers)) continue;
    const base = pin.sessionId
      ? allSessions.find(s => s.session_id === pin.sessionId)
      : allSessions.find(s => s.title && s.title.includes(pin.titleMatch));
    if (!base) continue;
    const alreadyIn = pin.sessionId
      ? result.some(s => s.session_id === pin.sessionId)
      : result.some(s => s.title && s.title.includes(pin.titleMatch));
    if (!alreadyIn) result.unshift({ ...base, stage1_score: 99, _pinned: true });
  }

  // Back-fill to ensure ≥5 sessions per available day
  const resultIds = new Set(result.map(s => s.session_id));
  const allDays = [...new Set(filters.flatMap(tf => tf.days))];
  for (const day of allDays) {
    const dayCount = result.filter(s => s.day === day).length;
    if (dayCount < 5) {
      const extras = scored
        .filter(s => s.day === day && !resultIds.has(s.session_id))
        .slice(0, 5 - dayCount);
      for (const e of extras) { result.push(e); resultIds.add(e.session_id); }
    }
  }

  return result;
}
