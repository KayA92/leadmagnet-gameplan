'use strict';
// ============================================================================
// pain-tags.js
//
// Single source of truth for the 37 pain tags used by both preprocessing
// pipelines (exhibitors-csv-to-json.js and programmes-csv-to-json.js).
//
// Edit signals or context here — the change applies to both pipelines.
// CAT_MAP is intentionally NOT shared: exhibitors.csv and programme.csv use
// different raw category strings that map to the same canonical keys.
// ============================================================================

// Each tag has:
//   id       — kebab-case identifier used as pain_scores key and wizard chip value
//   label    — Human-readable display name shown in the wizard chip UI
//   band     — Urgency tier driving score weighting at runtime:
//                scorching = 3.0  (8 tags  — top urgency, affects most firms)
//                hot       = 2.5  (14 tags — widespread, significant pain)
//                warm      = 2.0  (9 tags  — meaningful but lower urgency)
//                specialist= 1.5  (6 tags  — niche but high value when relevant)
//   signals  — Keyword phrases scanned deterministically in source data (Layer 1).
//              A hit is hard evidence for that tag and is passed to Haiku.
//   context  — ~80-word paragraph sent to Haiku in the system prompt so it
//              understands each tag beyond the short label.

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

module.exports = { PAIN_TAGS };
