// ============================================================================
// exhibitors-csv-to-json.js
//
// THE single converter: exhibitors.csv  →  data/exhibitors.json
//
// Usage:
//   node scripts/exhibitors-csv-to-json.js           — rebuild JSON only
//   node scripts/exhibitors-csv-to-json.js --score   — rebuild + run Haiku
//                                                       scoring for all 37
//                                                       pain tags per exhibitor
//
// --score requires ANTHROPIC_API_KEY in scripts/.env
// Estimated cost: ~$0.70–$1.50 for ~300 exhibitors (prompt caching enabled)
// ============================================================================

'use strict';
const fs    = require('fs');
const path  = require('path');
const https = require('https');

// ── Canonical category mapping ───────────────────────────────────────────────
// Maps raw CSV "Categories" display strings → kebab-case keys used by
// filter.js (exhibitor pre-filter) and plan.js (tab display and filtering).
//
// This is the ONLY place this mapping is defined for exhibitors. If you add a
// new category to the CSV, add it here and it will flow through automatically.
// Keys with an empty array ([]) intentionally produce no canonical category —
// those categories have no matching concept in the frontend filter system.
const CAT_MAP = {
  'AI & Automation':                                          ['ai-automation'],
  'AML - Anti Money Laundering':                             ['aml-kyc'],
  'AML/KYC':                                                 ['aml-kyc'],
  'Accounts Payable / Accounts Receivable':                  ['banking-payments'],
  'Analytics & Reporting':                                   ['data-analytics'],
  'Audit':                                                   ['tax-mtd'],
  'Auto Enrolment & Pensions':                               ['payroll'],
  'Banking & Payments':                                      ['banking-payments'],
  'Banking Services / Open Banking / Payment / FX Budgeting':['banking-payments'],
  'Bookkeeping':                                             ['bookkeeping'],
  'Capital Allowances':                                      ['tax-mtd'],
  'Cash Flow Forecasting':                                   ['banking-payments'],
  'Charity / Not for Profit':                                [],
  'Consulting & Business Services':                          ['practice-management'],
  'Corporate Finance / Mergers & Acquisitions':              ['practice-management'],
  'CRM':                                                     ['crm-comms'],
  'Cyber Security':                                          ['cyber-security'],
  'Data & Analytics':                                        ['data-analytics'],
  'Data Entry / OCR (Optical Character Recognition)':        ['doc-automation'],
  'Document Management':                                     ['doc-management'],
  'Education & Qualifications':                              ['practice-management'],
  'Employee Benefits / Incentives / Salary Sacrifice':       ['hr-people'],
  'ERP':                                                     ['practice-management'],
  'Expenses':                                                ['expenses'],
  'Foreign Exchange and Multi-Currency Services':            ['banking-payments'],
  'HR':                                                      ['hr-people'],
  'HR & Leadership':                                         ['hr-people'],
  'HR & People':                                             ['hr-people'],
  'IT Solutions':                                            [],
  'Insolvency':                                              [],
  'Insurance':                                               [],
  'MTD':                                                     ['tax-mtd'],
  'Magazines & Publishing':                                  [],
  'Marketing & Growth':                                      ['marketing-growth'],
  'O2C – Order-To-Cash':                                     ['banking-payments'],
  'Outsourcing':                                             ['outsourcing'],
  'Outsourcing / Offshoring':                                ['outsourcing'],
  'Payment Process Services':                                ['banking-payments'],
  'Payroll':                                                 ['payroll'],
  'Practice & Project Management':                           ['practice-management'],
  'Practice Management':                                     ['practice-management'],
  'Recruitment & Training':                                  ['hr-people'],
  'Research & Development':                                  [],
  'Restructuring & Business Recovery':                       ['practice-management'],
  'Sales & Marketing':                                       ['marketing-growth'],
  'Spend Management':                                        ['expenses'],
  'Tax':                                                     ['tax-mtd'],
  'Tax & MTD':                                               ['tax-mtd'],
  'Association / Professional Body':                         [],
  'Other':                                                   [],
};

// ── Pain tags ────────────────────────────────────────────────────────────────
// 37 structured pain tags sourced verbatim from AutoEvent-matcher-spec-v5.docx
// Appendix A. These are the problems UK accounting firms bring to Accountex.
//
// Each tag has:
//   id       — kebab-case identifier. Matched against state.answers.pains in
//              the wizard and used as the key in exhibitor pain_scores JSON.
//   label    — Human-readable display name shown in the wizard chip UI.
//   band     — Urgency tier that drives score weighting at runtime:
//                scorching = 3.0  (8 tags  — top urgency, affects most firms)
//                hot       = 2.5  (14 tags — widespread, significant pain)
//                warm      = 2.0  (9 tags  — meaningful but lower urgency)
//                specialist= 1.5  (6 tags  — niche but high value when relevant)
//              Band weights are applied in filter.js when computing the overall
//              booth match score from a user's selected pains.
//   signals  — Keyword phrases to scan in exhibitor data columns (Layer 1 of
//              Phase 2 scoring). These are deterministic — if a signal phrase
//              appears in the exhibitor's data, it's hard evidence for that tag.
//              Signals are also passed to Haiku as pre-matched evidence (Layer 2).
//   context  — ~80-word paragraph describing this pain in detail. Sent to Haiku
//              in the system prompt so it understands what each tag means beyond
//              the short label. Allows semantic matching beyond keyword hits.

const PAIN_TAGS = [

  // ── Scorching ──────────────────────────────────────────────────────────────

  {
    id:      'ai-start',
    label:   'AI — where to even start',
    band:    'scorching',
    signals: [
      'AI copilots in accounting software',
      'ChatGPT-style assistants',
      'AI bookkeeping',
      'AI tax prep',
      'embedded AI',
      'AI use cases',
      'AI demos',
    ],
    context: `Practitioner at the very beginning of AI adoption — overwhelmed by the
noise, unsure which tools to trust, no in-house AI literacy. Solo practitioners
(44%) and large firms (38%) both heavily affected. Wants: practical 'what to try
first' frameworks, beginner AI demos, embedded AI inside existing tools
(Xero/Sage/QuickBooks copilots), low-risk use cases. Does NOT want: enterprise
AI strategy or deep technical sessions.`,
  },

  {
    id:      'ai-data-mess',
    label:   'Data mess blocking AI',
    band:    'scorching',
    signals: [
      'Workiro',
      'structured document management',
      'DMS with AI',
      'data classification',
      'AI-assisted filing',
      'single source of truth',
    ],
    context: `Firm has bought AI tools but realising they only work as well as the data
fed in. Messy folder hierarchies, emails scattered across inboxes, unstructured
documents, no consistent classification. AI bookkeeping mis-categorises, AI
search returns nothing useful. The blocker isn't AI — it's the foundation.
Wants: structured document management, consistent classification systems,
AI-assisted filing and tagging, single source of truth across files/emails/approvals.`,
  },

  {
    id:      'mtd-volume',
    label:   'MTD volume problem',
    band:    'scorching',
    signals: [
      'MTD-recognised software',
      'tax automation',
      'outsourcing providers',
      'AI bookkeeping',
      'bridging software',
      'data extraction',
    ],
    context: `UK accounting firm bracing for the labour-intensive volume of quarterly
Making Tax Digital for Income Tax submissions starting April 2026. Affects
roughly 864,000 sole traders and landlords in tranche one, scaling to nearly
3 million by April 2028. Concern is not the software itself — bridging tools
and HMRC-recognised software are mature — but the operational capacity to
process quarterly updates at near-zero marginal cost without burning out staff
or breaking pricing models.`,
  },

  {
    id:      'mtd-clients',
    label:   'Clients not MTD-ready',
    band:    'scorching',
    signals: [
      'client portals',
      'receipt capture apps',
      'Dext',
      'Hubdoc',
      'bridging software',
      'client onboarding tools',
    ],
    context: `Practitioner facing a digital readiness gap among MTD-mandated clients.
Roughly 30–40% of affected sole traders and landlords still keep paper records,
shoebox receipts, or once-a-year spreadsheets. The pain is the cultural lift,
not the technology — getting clients onto digital record-keeping, training them
on quarterly habits, and absorbing the unpaid extra work of digital chasing.`,
  },

  {
    id:      'margin',
    label:   'Margin squeeze',
    band:    'scorching',
    signals: [
      'proposal software',
      'Ignition',
      'GoProposal',
      'pricing intelligence',
      'advisory platforms',
      'fee collection',
    ],
    context: `Profitability under pressure from rising staff costs, fee compression, and
inflation eroding real income. 71% of firms expect pricing pressure to impact
them. Wants: value-based pricing frameworks (Mark Wickersham, Reza Hooda style),
advisory upsell techniques, service-tier productisation, fixed-fee model design,
fee-collection automation, niching to escape commodity pricing.`,
  },

  {
    id:      'hiring',
    label:   'Can\'t find good staff',
    band:    'scorching',
    signals: [
      'recruitment agencies',
      'outsourcing providers',
      'AAT/ACCA partners',
      'HR software',
      'salary benchmarking tools',
    ],
    context: `Firm struggling with talent acquisition in a market where 68% of finance
employers predict applicant shortages and 49% report moderate-to-severe
AI-specific skills shortages. Smaller firms hit hardest. Wants: recruiter case
studies, salary benchmark data, alternative sourcing strategies (apprenticeships,
returners, offshore), employer-brand sessions, AI to do the work nobody can be
hired for.`,
  },

  {
    id:      'retention',
    label:   'Losing staff to other firms',
    band:    'scorching',
    signals: [
      'HR software',
      'performance management',
      'engagement tools',
      'L&D platforms',
      'wellbeing services',
    ],
    context: `Firm losing experienced staff to competitors, contractors, or other
industries. 61% of accountants are considering job moves in 2026; the trigger
is rarely salary — work-life balance, career path clarity, hybrid flexibility,
and culture matter more. Wants: retention frameworks, culture-building sessions,
career-pathing tools, performance-based pay design, leadership-development for
line managers.`,
  },

  {
    id:      'burnout',
    label:   'Workload & burnout',
    band:    'scorching',
    signals: [
      'workflow automation',
      'OCR',
      'AI bookkeeping',
      'outsourcing',
      'wellbeing services',
    ],
    context: `Team operating beyond healthy capacity. UK accountants 36% more likely to
report stress/burnout than other professions. Symptom-pain (signals
workload-driven decisions across software, hiring, and pricing) more than a
primary topic-pain. Use this signal to weight automation/outsourcing/wellbeing
content across other matched theatres rather than as a standalone driver.`,
  },

  // ── Hot ────────────────────────────────────────────────────────────────────

  {
    id:      'docs',
    label:   'Document chaos',
    band:    'hot',
    signals: [
      'Workiro',
      'DocuWare',
      'Virtual Cabinet',
      'SmartVault',
      'Suralink',
      'document management',
    ],
    context: `Documents scattered across email, shared drives, desktop folders. Version
control breaks, audit trail unclear, GDPR risk elevated. Wants: document
management with proper indexing, auto-filing, OCR, integration with practice
management.`,
  },

  {
    id:      'chasing',
    label:   'Chasing clients for records',
    band:    'hot',
    signals: [
      'client portals',
      'Dext',
      'Hubdoc',
      'receipt apps',
      'e-signature',
      'automated chase tools',
      'Ignition',
      'Karbon',
    ],
    context: `Universal practitioner pain — staff time wasted chasing receipts, bank
statements, signed engagement letters. UK SMEs collectively waste 133 million
hours/year on chasing. Wants: client-portal adoption strategies, automated
reminders, e-signature/approval workflows, receipt-capture apps, gamified client
engagement.`,
  },

  {
    id:      'defensible-files',
    label:   'Audit-ready client files',
    band:    'hot',
    signals: [
      'Workiro',
      'DMS with audit trail',
      'compliance platforms',
      'Caseware',
      'audit-ready systems',
      'evidence management',
    ],
    context: `Firm needs every client file ready for scrutiny — partner accountability is
personal, AML inspections are tightening, complaints procedures demand evidence
in seconds. Wants: immutable audit trails, version control across teams,
evidence-linked approvals and signatures, defensible client files that withstand
regulator/court/auditor scrutiny.`,
  },

  {
    id:      'aml',
    label:   'AML / KYC pressure',
    band:    'hot',
    signals: [
      'AML software',
      'KYC tools',
      'client verification',
      'compliance platforms',
      'ID verification',
    ],
    context: `AML compliance burden growing — supervisor expectations rising, client
verification more rigorous, partner accountability personal. Wants: AML policy
templates, risk-based-approach frameworks, automated client verification (KYC),
supervisor-update sessions, policy/training templates.`,
  },

  {
    id:      'disconnected',
    label:   'Disconnected tech stack',
    band:    'hot',
    signals: [
      'integration platforms',
      'practice management suites',
      'Karbon',
      'TaxDome',
      'iFirm',
      'Zoho',
      'no-code tools',
    ],
    context: `Firm running a fragmented tech stack — 41% of mid-size firms attribute losses
to fragmentation. 2026 trend is consolidation. Wants: integration platforms,
embedded ambient AI, suite consolidation case studies, no-code automation,
tech-stack audit frameworks.`,
  },

  {
    id:      'ai-roi',
    label:   'AI — proving the ROI',
    band:    'hot',
    signals: [
      'enterprise AI platforms',
      'AI workflow tools',
      'agentic AI',
      'audit AI',
      'tax AI',
    ],
    context: `Firm or finance leader past experimentation, now needing to justify AI spend
with hard numbers — capacity gain, realisation rate, time saved per fee earner.
Heavily relevant to Practice Owners and FD Show audiences. Wants: case studies
with measurable outcomes, ROI calculation frameworks, vendor demos with proof
points, sessions that contrast AI hype vs reality.`,
  },

  {
    id:      'advisory',
    label:   'Stuck in compliance',
    band:    'hot',
    signals: [
      'advisory platforms',
      'Spotlight Reporting',
      'Fathom',
      'Float',
      'forecasting tools',
      'advisory frameworks',
    ],
    context: `Firm trapped in compliance-heavy work mix (audit/accounts/tax = 94% of
typical UK firm output, advisory only 6%). Knows the destination, can't make
the transition. Wants: positioning frameworks, productised advisory offers,
pricing for advisory, hiring advisors vs upskilling, examples of firms that have
done it.`,
  },

  {
    id:      'advisory-charge',
    label:   'Charging for advice',
    band:    'hot',
    signals: [
      'pricing tools',
      'Ignition',
      'GoProposal',
      'proposal software',
      'CRM',
    ],
    context: `Firm offering advisory but failing to monetise — clients see it as
'included,' partners give it away. The block is positioning, packaging, and
pricing conversation skill. Wants: value-pricing frameworks, sales/discovery
training, productised offers with clear deliverables.`,
  },

  {
    id:      'winning',
    label:   'Winning new clients',
    band:    'hot',
    signals: [
      'marketing services',
      'website builders',
      'CRM',
      'LinkedIn tools',
      'content platforms',
      'SEO services',
    ],
    context: `54% of accounting firms expect client acquisition to be a major 2026
challenge. Lead generation through traditional channels is plateauing. Wants:
content marketing for accountants, LinkedIn strategies, website conversion,
niching to attract better-fit clients.`,
  },

  {
    id:      'ai-team',
    label:   'AI — team adoption',
    band:    'hot',
    signals: [
      'L&D platforms',
      'AI training providers',
      'internal communication tools',
    ],
    context: `Firm has bought AI tools but adoption is patchy. The blocker is change
management, training, cultural permission — not tech. Wants: rollout playbooks,
internal champion frameworks, AI-policy templates, team training programs.`,
  },

  {
    id:      'cyber',
    label:   'Cyber threats / phishing',
    band:    'hot',
    signals: [
      'cybersecurity software',
      'MFA tools',
      'endpoint protection',
      'cyber insurance',
      'security awareness training',
    ],
    context: `Increasingly sophisticated phishing, BEC, and ransomware attacks targeting
accountants — peak risk during tax season. A single breach exposes client tax
data, bank details, financial confidentials. Wants: MFA, zero-trust frameworks,
incident-response playbooks, staff training, cyber-insurance guidance.`,
  },

  {
    id:      'penalties',
    label:   'MTD penalty regime',
    band:    'hot',
    signals: [
      'practice management with deadline tracking',
      'tax software with penalty alerts',
      'compliance dashboards',
    ],
    context: `From April 2026 MTD IT introduces points-based late-filing penalties (£200
at threshold) and earlier late-payment charges. Wants: penalty-regime briefings,
agent-side process changes, soft-landing exploitation strategies, automated
deadline tracking.`,
  },

  {
    id:      'frs102',
    label:   'FRS 102 transition',
    band:    'hot',
    signals: [
      'lease accounting software',
      'audit software',
      'Caseware',
      'MyWorkpapers',
    ],
    context: `From 1 January 2026, amendments to Section 20 of FRS 102 align with IFRS 16,
ending operating-lease treatment for lessees. Mid-tier firms hit hardest. Wants:
technical update sessions, transition guidance, audit-firm best practice,
software with automatic lease accounting.`,
  },

  {
    id:      'portal',
    label:   'Portal adoption / clients hate it',
    band:    'hot',
    signals: [
      'client portal software',
      'Workiro',
      'Karbon',
      'TaxDome',
      'Suralink',
      'engagement tools',
    ],
    context: `Firm has a client portal but clients won't use it — they email instead, miss
notifications, share login details. Pain accelerates with MTD. Wants: portal UX
comparisons, client-engagement gamification, mobile-first portals, integration
into client workflows.`,
  },

  // ── Warm ───────────────────────────────────────────────────────────────────

  {
    id:      'ai-govern',
    label:   'AI governance & risk',
    band:    'warm',
    signals: [
      'enterprise AI platforms',
      'AI governance tools',
      'audit AI',
    ],
    context: `Firm has AI in production but lacks governance — what data goes into prompts,
who can use what tools, how outputs are reviewed. Heavy concern at mid-tier and
FD level. Wants: AI policy templates, governance frameworks, audit-grade AI
deployment, explainability and approval workflows.`,
  },

  {
    id:      'ai-skills',
    label:   'AI skills gap',
    band:    'warm',
    signals: [
      'L&D platforms',
      'AI training providers',
      'ACCA/ICAEW courses',
    ],
    context: `Firm-level skills shortage — 49% of finance employers report moderate-to-severe
AI skills gaps. Distinct from 'where to start' (firm-level vs personal) and
'team adoption'. Wants: training programs, AI certification routes, hiring
guides, internal AI learning paths.`,
  },

  {
    id:      'onboarding',
    label:   'Slow client onboarding',
    band:    'warm',
    signals: [
      'Ignition',
      'Practice Ignition',
      'engagement letter software',
      'onboarding tools',
      'workflow automation',
    ],
    context: `New-client onboarding takes weeks instead of days — engagement letters, AML
checks, software access, data extraction from prior accountants. Wants:
onboarding workflow automation, AML+e-sign integrations, templated engagement
letters, prior-accountant handover frameworks.`,
  },

  {
    id:      'month-end',
    label:   'Month-end close is brutal',
    band:    'warm',
    signals: [
      'BlackLine',
      'FloQast',
      'close automation',
      'ERP',
      'reporting tools',
      'Workday',
      'NetSuite',
    ],
    context: `In-house finance team or industry FD wrestling with multi-week month-end
close — manual journals, reconciliation chaos, late accruals, fragmented data.
FD Show core pain. Wants: close automation, continuous accounting, real-time
reporting, AI-assisted variance analysis.`,
  },

  {
    id:      'bankfeeds',
    label:   'Unreliable bank feeds',
    band:    'warm',
    signals: [
      'bank feed providers',
      'Open Banking tools',
      'AutoEntry',
      'Dext',
      'reconciliation tools',
    ],
    context: `Recurring bookkeeping pain — Open Banking feeds break, duplicate transactions
appear. Hours of weekly cleanup. Wants: feed-resilience tools, alternative data
extraction, reconciliation automation, vendor reliability comparisons.`,
  },

  {
    id:      'cpd',
    label:   'CPD & team development',
    band:    'warm',
    signals: [
      'ACCA',
      'ICAEW',
      'AAT',
      'CPDStore',
      'L&D platforms',
      'professional bodies',
    ],
    context: `Firm wants to invest in team development. Wants: CPD-accredited content
roadmaps, learning platforms, ACCA/ICAEW pathway sessions, internal training
program design.`,
  },

  {
    id:      'career',
    label:   'Murky career path',
    band:    'warm',
    signals: [
      'recruitment agencies',
      'ACCA',
      'ICAEW',
      'career coaching',
      'Hays salary guide',
    ],
    context: `Individual contributor seeking clarity on next career step. 84% of
accountants rate clear career path as important. Wants: networking, mentorship,
ACCA Thinkers career sessions, partnership-track content, salary benchmarking.`,
  },

  {
    id:      'leadership',
    label:   'Leadership skills gap',
    band:    'warm',
    signals: [
      'leadership coaching',
      'L&D platforms',
      'executive education',
    ],
    context: `Recently promoted managers/partners lacking soft skills — feedback, difficult
conversations, team coaching. Wants: leadership frameworks, soft-skills sessions,
coaching, executive presence.`,
  },

  {
    id:      'cashflow',
    label:   'Late payments / debtor days',
    band:    'warm',
    signals: [
      'GoCardless',
      'Stripe',
      'Crezco',
      'payment automation',
      'credit control',
      'fee collection tools',
    ],
    context: `Firm or in-house FD wrestling with late-paying clients. 90% of UK companies
experienced late payments in 2025. Wants: payment automation, fee-collection
tools, credit-control frameworks.`,
  },

  // ── Specialist ─────────────────────────────────────────────────────────────

  {
    id:      'pe',
    label:   'PE consolidation closing in',
    band:    'specialist',
    signals: [
      'M&A advisors',
      'valuation specialists',
      'PE-backed buyers',
      'succession consultants',
    ],
    context: `Mid-tier partner watching private-equity-backed roll-ups acquire competitors.
Wants: PE-buyer panel sessions, valuation frameworks, succession-vs-sale
comparisons, anti-PE niche strategies.`,
  },

  {
    id:      'exit',
    label:   'Exit / succession planning',
    band:    'specialist',
    signals: [
      'succession consultants',
      'M&A advisors',
      'valuation specialists',
      'buyout funders',
    ],
    context: `Owner planning departure — retirement, sale, internal succession, merger.
Wants: exit-route comparisons, valuation methods, partner-buyout frameworks,
succession-planning timelines.`,
  },

  {
    id:      'outsource',
    label:   'Outsourcing & offshore',
    band:    'specialist',
    signals: [
      'TOA Global',
      'Outbooks',
      'Advancetrack',
      'outsourcing providers',
      'offshore teams',
    ],
    context: `Firm exploring outsourcing/offshoring as capacity solution. Wants: provider
comparisons, integration playbooks, quality-control frameworks, client-disclosure
best practice.`,
  },

  {
    id:      'niche',
    label:   'Should I niche?',
    band:    'specialist',
    signals: [
      'industry-specific software',
      'vertical tools',
      'niche associations',
    ],
    context: `Firm questioning whether to specialise — sector niche, service niche, or stay
general. Wants: niching frameworks, case studies of successful niche firms,
pricing power of niching.`,
  },

  {
    id:      'cross-border',
    label:   'Cross-border clients',
    band:    'specialist',
    signals: [
      'international tax software',
      'currency tools',
      'global payroll',
      'expat advisory',
    ],
    context: `Firm serving clients with international components. Wants: international tax
updates, currency tools, cross-border compliance frameworks, expat-tax software.`,
  },

  {
    id:      'rd',
    label:   'R&D claims / specialist tax',
    band:    'specialist',
    signals: [
      'R&D claim software',
      'tax credit specialists',
      'capital allowances tools',
      'specialist tax advisors',
    ],
    context: `Firm handling R&D tax credit claims, capital allowances, EIS/SEIS, theatre
tax relief. Post-2024 R&D scheme tightening has heightened scrutiny. Wants:
R&D scheme update sessions, claim-defence frameworks, niche tax software.`,
  },

];

// ── CSV helpers ───────────────────────────────────────────────────────────────
// Hand-rolled CSV parser — no npm dependency needed. Handles quoted fields,
// escaped double-quotes, and Windows/Unix line endings. fixEncoding() patches
// common UTF-8-as-Windows-1252 mojibake that appears in the exported CSV.

function fixEncoding(s) {
  return (s || '')
    .replace(/â€™/g, "'").replace(/â€œ/g, '“').replace(/â€/g, '”')
    .replace(/â€"/g, '–').replace(/â€"/g, '—')
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

// ── Phase 2: Claude Haiku pain scoring ───────────────────────────────────────
//
// Scoring uses a two-layer approach:
//
//   Layer 1 — Keyword matching (deterministic, done in Node before calling Haiku)
//     For each pain tag, the script scans all 5 exhibitor data columns for the
//     tag's `signals` array entries. Any matches are compiled into a
//     matched_signals list and passed to Haiku as grounding evidence.
//
//   Layer 2 — Semantic scoring (Haiku)
//     Haiku reads all exhibitor data plus the pre-matched signals and assigns a
//     0.0–1.0 score + short reason for every tag. Keyword matches raise the floor
//     for a tag's score; Haiku can also find semantic relevance where no keyword
//     matched (e.g. "document management" → high score on "defensible-files"
//     even if that phrase never appears in the exhibitor's copy).
//
// Output stored per exhibitor: pain_scores[tag_id] = { score, reason, matched_signals }
//   matched_signals is omitted when empty (no keyword hits for that tag).
//
// The system prompt is sent with cache_control: ephemeral — Anthropic caches it
// after the first call (5-min TTL) so the ~4,000-token tag block is only billed
// at full rate once. Subsequent calls for the same run pay ~1/10th for that part.

// Read ANTHROPIC_API_KEY from scripts/.env if present.
// Falls back to process.env — useful if key is exported in the shell instead.
function loadEnv() {
  const envPath = path.join(__dirname, '.env');
  if (!fs.existsSync(envPath)) return;
  fs.readFileSync(envPath, 'utf8').split('\n').forEach(line => {
    const eq = line.indexOf('=');
    if (eq > 0 && !line.startsWith('#')) {
      process.env[line.slice(0, eq).trim()] = line.slice(eq + 1).trim();
    }
  });
}

// Layer 1: scan all 5 data columns for each tag's keyword signals.
// Returns a map of { tag_id: [matched_signal_strings] } for any tag that had
// at least one hit. Tags with zero matches are omitted from the result.
// This is cheap pure-JS work — runs before any API call.
function findMatchedSignals(exhibitor) {
  const corpus = [
    exhibitor.products_services,
    exhibitor.old_categories,
    exhibitor.categories,
    exhibitor.target_audience,
    exhibitor.company_description,
  ].join(' ').toLowerCase();

  const matches = {};
  for (const tag of PAIN_TAGS) {
    const found = tag.signals.filter(sig => corpus.includes(sig.toLowerCase()));
    if (found.length > 0) matches[tag.id] = found;
  }
  return matches;
}

// Build the system prompt sent to Haiku (cached — identical for every exhibitor).
// Contains: scoring rubric, rules, and all 37 pain tags serialised as JSON.
// The tags are sent with id + label + context only (signals are omitted here —
// they're presented per-exhibitor in the user prompt instead).
function buildSystemPrompt() {
  const tagsJson = JSON.stringify(
    PAIN_TAGS.map(({ id, label, context }) => ({ id, label, context })),
    null, 1
  );
  return `You are scoring software exhibitors at Accountex London 2026 — a major UK accounting conference — against 37 pain tags that describe specific problems accounting firms face.

SCORING RUBRIC
1.0  Core offering — this pain is exactly what they sell. Named in their pitch.
0.8  Strong fit — a primary feature directly addresses this pain.
0.6  Moderate fit — product overlaps with this pain as a secondary use case.
0.3  Peripheral — tangential connection, they touch this but do not focus on it.
0.0  No relevance.

RULES
- Pre-matched keyword signals are provided for each exhibitor (see user prompt). These are deterministic hits from the exhibitor's own data — treat them as hard evidence. A keyword match should push a tag's score above 0.0; multiple strong matches justify 0.6+. But keyword presence alone is not enough for 0.8+ — the product must genuinely address the pain.
- Use semantic understanding beyond the keywords. A document management platform scores 1.0 on "defensible-files" even if that exact phrase never appears.
- Read all five data fields. Products & Services is more factual than the description. Company Description is marketing copy — treat as supporting evidence only.
- Score each tag independently. A high score on one tag must not inflate adjacent ones.
- Use the full 0.0–1.0 range. Most tags for any exhibitor should be 0.0–0.2. Reserve 0.7+ for genuine product relevance. Do not cluster scores around 0.5.
- Reason: 4–8 words, present tense, no subject pronoun, factual.
  Good:  "Automates VAT return filing at scale"
  Bad:   "This company helps with VAT" / "Relevant to MTD compliance needs"

THE 37 PAIN TAGS:
${tagsJson}

RETURN FORMAT — CRITICAL:
Return ONLY valid JSON. No markdown, no code fences, no preamble.
All 37 keys must be present, even if score is 0.0.
{
  "ai-start":     { "score": 0.0, "reason": "No AI onboarding product" },
  "ai-data-mess": { "score": 0.0, "reason": "..." }
}`;
}

// Build the per-exhibitor user prompt.
// matchedSignals is the output of findMatchedSignals() — pre-computed by the
// caller so we don't scan the corpus twice. The matched signals are laid out
// clearly so Haiku treats them as concrete evidence rather than discovering
// them independently from the raw description text.
function buildUserPrompt(e, matchedSignals) {
  const signalLines = Object.keys(matchedSignals).length > 0
    ? Object.entries(matchedSignals)
        .map(([id, sigs]) => `  ${id}: ${sigs.join(' | ')}`)
        .join('\n')
    : '  (none found)';

  return `Company: ${e.company_name}
Stand: ${e.stand_number}
Products & Services: ${e.products_services || '(none listed)'}
Old categories: ${e.old_categories || '(none listed)'}
Categories: ${e.categories || '(none listed)'}
Target audience: ${e.target_audience || '(none listed)'}
Description: ${e.company_description || '(none listed)'}

Pre-matched keyword signals found in exhibitor data:
${signalLines}
(Keyword matches above are hard evidence for those tags. Also use semantic understanding to score all 37 — not just those with keyword hits.)

Score this exhibitor against all 37 pain tags.`;
}

// Make a single POST request to the Anthropic Messages API using Node's built-in
// https module — no npm dependency needed. The system prompt is sent with
// cache_control: ephemeral so Anthropic caches it on their side after the first
// call (saves ~90% cost on the 4,000-token system block for the remaining calls).
function callHaiku(apiKey, systemPrompt, userPrompt) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({
      model:      'claude-haiku-4-5-20251001',
      max_tokens: 1800,
      system: [{
        type:          'text',
        text:          systemPrompt,
        cache_control: { type: 'ephemeral' },
      }],
      messages: [{ role: 'user', content: userPrompt }],
    });
    const req = https.request({
      hostname: 'api.anthropic.com',
      path:     '/v1/messages',
      method:   'POST',
      headers:  {
        'x-api-key':         apiKey,
        'anthropic-version': '2023-06-01',
        'anthropic-beta':    'prompt-caching-2024-07-31',
        'content-type':      'application/json',
        'content-length':    Buffer.byteLength(body),
      },
    }, res => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        let parsed;
        try { parsed = JSON.parse(text); } catch {
          return reject(new Error(`Non-JSON response (${res.statusCode}): ${text.slice(0, 300)}`));
        }
        if (res.statusCode >= 400) {
          return reject(new Error(`API ${res.statusCode}: ${parsed.error?.message || text.slice(0, 200)}`));
        }
        resolve(parsed);
      });
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

// Defensively parse Haiku's response text as JSON.
// First tries a direct parse; if Haiku wrapped the JSON in prose or backticks,
// falls back to extracting the first {...} block. Returns null if both fail.
function parseScores(text) {
  try { return JSON.parse(text); } catch {}
  const m = text.match(/\{[\s\S]*\}/);
  if (m) try { return JSON.parse(m[0]); } catch {}
  return null;
}

// Write a human-readable CSV score matrix to data/exhibitors-pain-scores.csv.
// Columns: company_name, stand_number, one column per pain tag (score as 0.00),
// top_tags (top 3 tags by score formatted as "tag-id(score)|..." for quick review).
// Open in Excel to sort by any tag column and see which exhibitors own each pain.
function writePainScoresCsv(exhibitors) {
  const tagIds = PAIN_TAGS.map(t => t.id);
  const esc    = v => /[,"]/.test(String(v)) ? `"${String(v).replace(/"/g, '""')}"` : String(v);

  const header = ['company_name', 'stand_number', ...tagIds, 'top_tags'].join(',');
  const rows = exhibitors.map(e => {
    const s       = e.pain_scores || {};
    const tagCols = tagIds.map(id => (s[id] ? s[id].score.toFixed(2) : '0.00'));
    const top3    = tagIds
      .map(id => ({ id, score: s[id] ? s[id].score : 0 }))
      .sort((a, b) => b.score - a.score)
      .slice(0, 3)
      .filter(t => t.score > 0)
      .map(t => `${t.id}(${t.score.toFixed(2)})`)
      .join('|');
    return [esc(e.company_name), esc(e.stand_number), ...tagCols, esc(top3)].join(',');
  });

  const csvPath = path.join(root, 'data', 'exhibitors-pain-scores.csv');
  fs.writeFileSync(csvPath, [header, ...rows].join('\n'), 'utf8');
  console.log(`Written pain scores CSV → ${csvPath}`);
}

// Compact system prompt for --tag mode: only describes one tag.
// Much cheaper than the full 37-tag prompt — Haiku only needs to return one key.
function buildSingleTagSystemPrompt(tag) {
  return `You are scoring software exhibitors at Accountex London 2026 against a single accounting pain tag.

Tag: ${tag.id} — ${tag.label}
Context: ${tag.context}

SCORING RUBRIC
1.0  Core offering — this pain is what they primarily sell
0.8  Strong fit — a primary feature directly addresses this pain
0.6  Moderate fit — secondary use case, meaningful overlap
0.3  Peripheral — tangential connection, not a focus
0.0  No relevance

RULES
- Pre-matched keyword signals (provided in user prompt) are hard evidence
- Use semantic understanding beyond the keywords
- Reason: 4–8 words, present tense, no subject pronoun, factual
  Good:  "Automates VAT return filing at scale"
  Bad:   "This company helps with VAT"

Return ONLY valid JSON with this single key (no markdown, no preamble):
{ "${tag.id}": { "score": 0.0, "reason": "..." } }`;
}

// Main scoring loop. Processes exhibitors sequentially (not in parallel) to stay
// well within Anthropic's rate limits. 1-second delay between calls is intentional.
// Retry logic handles transient 500/529 overload errors with a 3-second backoff.
//
// Options:
//   tagFilter      — if set, score only that tag using a compact prompt and merge
//                    just that key back into existing pain_scores
//   exhibitorFilter — if set, score only exhibitors whose name matches this string
//                    (case-insensitive substring); all other scores are preserved
async function runScoring(exhibitors, { tagFilter = null, exhibitorFilter = null } = {}) {
  loadEnv();
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    console.error('Error: ANTHROPIC_API_KEY not set — add it to scripts/.env');
    process.exit(1);
  }

  // Validate --tag value if provided
  const singleTag = tagFilter ? PAIN_TAGS.find(t => t.id === tagFilter) : null;
  if (tagFilter && !singleTag) {
    console.error(`Unknown tag: "${tagFilter}"`);
    console.error(`Valid IDs: ${PAIN_TAGS.map(t => t.id).join(', ')}`);
    process.exit(1);
  }

  // Filter to matching exhibitors if --exhibitor was provided
  let targets = exhibitors;
  if (exhibitorFilter) {
    const needle = exhibitorFilter.toLowerCase();
    targets = exhibitors.filter(e => e.company_name.toLowerCase().includes(needle));
    if (targets.length === 0) {
      console.error(`No exhibitor found matching "${exhibitorFilter}"`);
      process.exit(1);
    }
  }

  // Choose prompt — single-tag is ~1/37th the output tokens of the full prompt
  const systemPrompt = singleTag ? buildSingleTagSystemPrompt(singleTag) : buildSystemPrompt();

  if (singleTag) {
    console.log(`\nRe-scoring tag "${singleTag.id}" for ${targets.length} exhibitor(s)...`);
    console.log('Single-tag mode: only this tag will be updated in existing pain_scores.\n');
  } else if (exhibitorFilter) {
    console.log(`\nRe-scoring ${targets.length} exhibitor(s) matching "${exhibitorFilter}" × ${PAIN_TAGS.length} tags...`);
    console.log('Two-layer scoring: keyword signals + Haiku semantic scoring.\n');
  } else {
    console.log(`\nScoring ${targets.length} exhibitors × ${PAIN_TAGS.length} pain tags via Claude Haiku...`);
    console.log('Two-layer scoring: keyword signals (deterministic) + Haiku semantic scoring.');
    console.log('Prompt caching enabled — system prompt cached after first call.\n');
  }

  let ok = 0, fail = 0;

  for (let i = 0; i < targets.length; i++) {
    const e     = targets[i];
    const label = `[${String(i + 1).padStart(3)}/${targets.length}] ${e.company_name} (${e.stand_number})`;

    try {
      // Layer 1: keyword matching — run before the API call
      const matchedSignals = findMatchedSignals(e);

      let response;
      for (let attempt = 0; attempt < 2; attempt++) {
        try {
          response = await callHaiku(apiKey, systemPrompt, buildUserPrompt(e, matchedSignals));
          break;
        } catch (err) {
          const retryable = /529|500|overloaded/.test(err.message);
          if (attempt === 0 && retryable) {
            await new Promise(r => setTimeout(r, 3000));
          } else {
            throw err;
          }
        }
      }

      const text   = response.content?.[0]?.text || '';
      const scores = parseScores(text);

      if (!scores) {
        console.error(`  ✗ ${label} — unparseable JSON`);
        fail++;
      } else {
        if (!e.pain_scores) e.pain_scores = {};

        if (singleTag) {
          // --tag mode: merge only the targeted tag back into existing scores
          const entry = scores[singleTag.id];
          if (entry) {
            e.pain_scores[singleTag.id] = {
              score:  entry.score,
              reason: entry.reason,
              ...(matchedSignals[singleTag.id] ? { matched_signals: matchedSignals[singleTag.id] } : {}),
            };
            console.log(`  ✓ ${label} — ${singleTag.id}: ${entry.score.toFixed(2)} "${entry.reason}"`);
          }
        } else {
          // Full re-score: replace all tags. matched_signals only written where hits found.
          for (const [id, entry] of Object.entries(scores)) {
            e.pain_scores[id] = {
              score:  entry.score,
              reason: entry.reason,
              ...(matchedSignals[id] ? { matched_signals: matchedSignals[id] } : {}),
            };
          }
          const top = Object.entries(e.pain_scores)
            .sort((a, b) => b[1].score - a[1].score)
            .slice(0, 3)
            .map(([id, v]) => `${id}(${v.score.toFixed(2)})`)
            .join(' ');
          console.log(`  ✓ ${label} — top: ${top}`);
        }
        ok++;
      }
    } catch (err) {
      console.error(`  ✗ ${label} — ${err.message}`);
      fail++;
    }

    if (i < targets.length - 1) await new Promise(r => setTimeout(r, 1000));
  }

  console.log(`\n${ok} scored, ${fail} failed`);
}

// ── Main ──────────────────────────────────────────────────────────────────────
// Phase 1 (always runs): read exhibitors.csv → build exhibitors array → write JSON.
// Phase 2 (--score flag only): score each exhibitor against all 37 pain tags via
//   keyword matching + Claude Haiku, then write JSON with pain_scores + CSV matrix.
//
// Partial re-run flags (used with --score):
//   --exhibitor "name"  Re-score only exhibitors whose name contains this string
//                       (case-insensitive). All other scores are preserved.
//   --tag <tag-id>      Re-score all exhibitors for a single pain tag only.
//                       Uses a compact single-tag prompt (~1/37th the output cost).
//                       All other tag scores are preserved.
//
// Score preservation: pain_scores from the current exhibitors.json are always
// carried forward on plain Phase 1 runs (no --score). This means you can add a
// new CSV column and re-run without losing any previously computed scores.

const root    = path.join(__dirname, '..');
const csvText = fs.readFileSync(path.join(root, 'exhibitors.csv'), 'utf8').replace(/^﻿/, '');
const rows    = parseCSV(csvText);
const headers = rows[0].map(h => h.trim());

const idx = k => headers.indexOf(k);
const H = {
  show:        idx('Show'),
  name:        idx('Company Name'),
  stand:       idx('Stand Number'),
  standType:   idx('Stand Type'),
  showCat:     idx('Show Category'),
  country:     idx('Country'),
  website:     idx('Website'),
  products:    idx('Products & Services'),
  oldCats:     idx('OLDCategories'),
  cats:        idx('Categories'),
  target:      idx('Products & Services Target'),
  desc:        idx('Company Description'),
  profileUrl:  idx('Profile URL'),
  logoUrl:     idx('Logo URL'),
};

// Load any existing pain_scores from the current exhibitors.json.
// These are merged back into the array below so a plain Phase 1 run (no --score)
// never silently discards scores that were computed in a previous --score run.
const existingJson = (() => {
  const p = path.join(root, 'data', 'exhibitors.json');
  if (!fs.existsSync(p)) return [];
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return []; }
})();
const preservedScores = Object.fromEntries(
  existingJson
    .filter(e => e.company_name && e.pain_scores)
    .map(e => [e.company_name, e.pain_scores])
);

const exhibitors = rows.slice(1)
  .filter(r => r[H.name] && r[H.name].trim())
  .map(r => {
    const get = i => fixEncoding(r[i] || '');

    // canonical_categories: map raw display strings → kebab-case keys
    const rawCats = get(H.cats).split(',').map(c => c.trim()).filter(Boolean);
    const canonicalSet = new Set();
    rawCats.forEach(c => (CAT_MAP[c] || []).forEach(k => canonicalSet.add(k)));

    const name = get(H.name);
    return {
      show:                  get(H.show),
      company_name:          name,
      stand_number:          get(H.stand),
      stand_type:            get(H.standType),
      show_category:         get(H.showCat),
      country:               get(H.country),
      website:               get(H.website),
      products_services:     get(H.products),
      old_categories:        get(H.oldCats),
      categories:            get(H.cats),
      target_audience:       get(H.target),
      canonical_categories:  [...canonicalSet],
      company_description:   get(H.desc),
      profile_url:           get(H.profileUrl),
      logo_url:              get(H.logoUrl),
      is_host:               name.toLowerCase().includes('workiro'),
      // pain_scores: { [tag_id]: { score, reason, matched_signals? } }
      // Restored from existing JSON here; written/updated by --score runs.
      ...(preservedScores[name] ? { pain_scores: preservedScores[name] } : {}),
    };
  });

async function main() {
  const useScore = process.argv.includes('--score');

  // Parse optional partial-run filters
  const tagIdx        = process.argv.indexOf('--tag');
  const tagFilter     = tagIdx  !== -1 ? process.argv[tagIdx  + 1] : null;
  const exhIdx        = process.argv.indexOf('--exhibitor');
  const exhibitorFilter = exhIdx !== -1 ? process.argv[exhIdx + 1] : null;

  if (useScore) {
    await runScoring(exhibitors, { tagFilter, exhibitorFilter });
    writePainScoresCsv(exhibitors);
  }

  const outPath = path.join(root, 'data', 'exhibitors.json');
  fs.writeFileSync(outPath, JSON.stringify(exhibitors, null, 2), 'utf8');

  if (useScore) {
    const scored = exhibitors.filter(e => e.pain_scores).length;
    console.log(`\nWritten ${exhibitors.length} exhibitors (${scored} with pain_scores) → ${outPath}`);
  } else {
    const preserved = Object.keys(preservedScores).length;
    console.log(`Written ${exhibitors.length} exhibitors → ${outPath}`);
    if (preserved > 0) {
      console.log(`Preserved existing pain_scores for ${preserved} exhibitors.`);
    } else {
      console.log(`Run with --score to add Claude Haiku pain_scores (${PAIN_TAGS.length} tags)`);
    }
  }
}

main().catch(err => { console.error(err); process.exit(1); });
