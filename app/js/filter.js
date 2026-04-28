// Stage 1 pre-filter — deterministic client-side filtering before the AI call.
// Narrows 225 sessions → 35–50 and 307 exhibitors → 20–25.
// Must mirror the CATEGORY_MATCH logic in index.html exactly.

const CATEGORY_MATCH = {
  'practice-management': ['Practice Management', 'Leadership', 'Sales & Marketing', 'Talent', 'Wellbeing', 'Scaling'],
  'ai-automation':       ['AI'],
  'bookkeeping':         ['Bookkeeping', 'Practice Management', 'AI'],
  'tax-mtd':             ['Tax / VAT / MTD', 'Regulation', 'AML'],
  'doc-management':      ['Practice Management', 'AI'],
  'payroll':             ['Payroll'],
  'esign':               ['Practice Management'],
  'crm-comms':           ['Sales & Marketing'],
  'data-analytics':      ['AI'],
  'cyber-security':      ['Regulation'],
  'aml-kyc':             ['AML', 'Regulation'],
  'expenses':            ['Bookkeeping'],
  'hr-people':           ['Talent'],
  'banking-payments':    ['Bookkeeping'],
  'doc-automation':      ['Practice Management', 'AI'],
  'outsourcing':         ['Practice Management'],
  'marketing-growth':    ['Sales & Marketing'],
};

const ROLE_THEATRE = {
  founder:    ['leadership', 'practice excellence', 'theatre 3', 'theatre 7'],
  director:   ['leadership', 'practice excellence', 'theatre 3', 'theatre 7'],
  senior:     ['practice excellence', 'theatre 3', 'acca', 'theatre 4'],
  accountant: ['practice excellence', 'theatre 3', 'acca', 'theatre 4'],
  bookkeeper: ['bookkeeper', 'theatre 6'],
  industry:   ['fd show', 'theatre 1', 'theatre 2'],
  advisor:    ['fd show', 'theatre 1', 'theatre 2'],
  'ops-admin':['practice excellence', 'theatre 6'],
  junior:     ['talent', 'theatre 12', 'masterclass'],
  student:    ['talent', 'theatre 12', 'masterclass'],
  vendor:     [],
  other:      [],
};

// Keywords that trigger a +1 boost when found in both the problem text AND session content
const PROBLEM_KEYWORDS = [
  'mtd', 'ai', 'portal', 'onboarding', 'workflow', 'automation',
  'pricing', 'capacity', 'compliance', 'payroll', 'bookkeeping',
  'tax', 'document', 'audit', 'client', 'advisory', 'efficiency',
];

// Attendance window → which days and start-time cutoff to apply
const TIME_FILTERS = {
  'wed-am':   { days: ['Day 1'], startBefore: '13:00', startFrom: null },
  'wed-pm':   { days: ['Day 1'], startBefore: null,    startFrom: '13:00' },
  'wed-full': { days: ['Day 1'], startBefore: null,    startFrom: null },
  'thu-am':   { days: ['Day 2'], startBefore: '13:00', startFrom: null },
  'thu-pm':   { days: ['Day 2'], startBefore: null,    startFrom: '13:00' },
  'thu-full': { days: ['Day 2'], startBefore: null,    startFrom: null },
};

// ── Session pre-filter ────────────────────────────────────────────────────────
export function preFilterSessions(answers, allSessions) {
  const { categories = [], time, role, problem = '' } = answers;
  const tf = TIME_FILTERS[time] || TIME_FILTERS['wed-full'];
  const problemLower = problem.toLowerCase();
  const boostedTheatres = ROLE_THEATRE[role] || [];

  // Build set of canonical categories that match the user's selections
  const wantedCanonicals = new Set();
  for (const cat of categories) {
    for (const canonical of (CATEGORY_MATCH[cat] || [])) {
      wantedCanonicals.add(canonical);
    }
  }

  const scored = [];
  const seenIds = new Set();

  for (const session of allSessions) {
    if (seenIds.has(session.session_id)) continue;
    seenIds.add(session.session_id);

    // Day filter
    if (!tf.days.includes(session.day)) continue;

    // AM cutoff — exclude sessions starting at or after the AM/PM boundary
    if (tf.startBefore && session.start_time >= tf.startBefore) continue;
    // PM cutoff — exclude sessions starting before the afternoon boundary
    if (tf.startFrom && session.start_time < tf.startFrom) continue;

    let score = 0;

    // +2 per matching canonical category
    for (const canonical of (session.canonical_categories || [])) {
      if (wantedCanonicals.has(canonical)) {
        score += 2;
        break; // count only once per session even if multiple canonicals match
      }
    }

    // +1 if theatre matches the role boost list
    const theatreLower = (session.theatre || '').toLowerCase();
    if (boostedTheatres.some(t => theatreLower.includes(t))) score += 1;

    // +1 if a problem keyword appears in both the problem text and the session title/description
    const sessionText = `${session.title} ${session.description}`.toLowerCase();
    if (PROBLEM_KEYWORDS.some(kw => problemLower.includes(kw) && sessionText.includes(kw))) {
      score += 1;
    }

    scored.push({ ...session, stage1_score: score });
  }

  scored.sort((a, b) => b.stage1_score - a.stage1_score);

  // Take top 45
  const result = scored.slice(0, 45);

  // Back-fill: ensure ≥5 sessions per available day
  const resultIds = new Set(result.map(s => s.session_id));
  for (const day of tf.days) {
    const dayCount = result.filter(s => s.day === day).length;
    if (dayCount < 5) {
      const extras = scored
        .filter(s => s.day === day && !resultIds.has(s.session_id))
        .slice(0, 5 - dayCount);
      for (const e of extras) {
        result.push(e);
        resultIds.add(e.session_id);
      }
    }
  }

  return result;
}

// ── Exhibitor pre-filter ──────────────────────────────────────────────────────
const EXHIBITOR_PRODUCT_MATCH = {
  'practice-management': ['Practice & Project Management', 'Consulting & Business Services', 'CRM', 'ERP', 'Sales & Marketing', 'Document Management'],
  'ai-automation':       ['AI / Automation / Optimisation', 'Data Entry / OCR', 'Analytics & Reporting', 'Expense Management'],
  'bookkeeping':         ['Accounting Software', 'Cash Flow Forecasting', 'Bookkeeping', 'Accounts'],
  'tax-mtd':             ['MTD - Making Tax Digital', 'Tax', 'VAT', 'AML', 'Audit'],
  'doc-management':      ['Document Management', 'Data Entry / OCR'],
  'payroll':             ['Payroll', 'Auto Enrolment & Pensions', 'HR'],
  'esign':               ['Document Management', 'E-Signature'],
  'crm-comms':           ['CRM', 'Sales & Marketing'],
  'data-analytics':      ['Analytics & Reporting', 'AI / Automation / Optimisation'],
  'cyber-security':      ['Cyber Security'],
  'aml-kyc':             ['AML', 'Compliance'],
  'expenses':            ['Expense Management', 'Accounts'],
  'hr-people':           ['HR', 'Auto Enrolment & Pensions'],
  'banking-payments':    ['Banking', 'Cash Flow Forecasting', 'Accounting Software'],
  'doc-automation':      ['Data Entry / OCR', 'Document Management', 'AI / Automation / Optimisation'],
  'outsourcing':         ['Consulting & Business Services'],
  'marketing-growth':    ['Sales & Marketing'],
};

export function preFilterExhibitors(answers, allExhibitors) {
  const { categories = [], role, problem = '' } = answers;
  const problemLower = problem.toLowerCase();

  const wantedProducts = new Set();
  for (const cat of categories) {
    for (const product of (EXHIBITOR_PRODUCT_MATCH[cat] || [])) {
      wantedProducts.add(product.toLowerCase());
    }
  }

  const scored = [];

  for (const exhibitor of allExhibitors) {
    // Only include FD Show exhibitors for industry/FD role
    if (exhibitor.show_category === 'FD Show' && role !== 'industry') continue;

    let score = exhibitor.is_host ? 100 : 0; // Host always surfaces first

    const productsLower = (exhibitor.normalised_products || []).map(p => p.toLowerCase());
    const descLower = (exhibitor.company_description || '').toLowerCase();

    // +1 per matching product category
    for (const product of productsLower) {
      for (const wanted of wantedProducts) {
        if (product.includes(wanted) || wanted.includes(product)) {
          score += 1;
          break;
        }
      }
    }

    // +1 if problem keyword appears in the company description
    if (PROBLEM_KEYWORDS.some(kw => problemLower.includes(kw) && descLower.includes(kw))) {
      score += 1;
    }

    scored.push({ ...exhibitor, stage1_score: score });
  }

  scored.sort((a, b) => b.stage1_score - a.stage1_score);
  return scored.slice(0, 25);
}
