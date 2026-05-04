import { supabase } from './supabase.js';
import { getUser, onAuthChange, sendMagicLink } from './auth.js';

// ── Helpers ───────────────────────────────────────────────────────────────────
function $(id) { return document.getElementById(id); }
function escHtml(s) {
  return String(s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;')
    .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

// ── Module-level state ────────────────────────────────────────────────────────
let _plan        = null;
let _allSessions = [];
let _allExhibitors = [];
let _teamData    = null;
let _authUser    = null;
let _currentTab  = 'checklist';

let _planEditorMode      = null;
let _planEditorDay       = 'all';
let _planEditorTime      = 'all';
let _planEditorCategories = new Set();
let _planEditorQuery     = '';
let _planEditorShowMore  = false;

let _userProfile  = null;

let _dismissedAlternatives = new Set();
let _resolvedSlots = new Set();
let _pendingJoinToken     = null;
let _pendingJoinCompany   = null;

// One-time invite-team nudge — appears at the top of Checklist / CPD /
// Debrief tabs when the user is solo (no team yet). Copy is tailored
// per tab so the value prop fits the context the user is already in.
// Persisted via localStorage so dismissing in one session sticks.
let _inviteNudgeDismissed = false;
try { _inviteNudgeDismissed = localStorage.getItem('inviteNudgeDismissed') === '1'; } catch (_) {}

const INVITE_NUDGE_COPY = {
  checklist: 'Going with colleagues? <strong>Add your team</strong> — see their pains, share live notes and ratings, get an AI debrief PDF at the end.',
  cpd:       'Bringing colleagues? <strong>Their CPD logs roll up here too</strong> — one report, whole team.',
  debrief:   'Going alone, this writes from your notes only. <strong>Add a teammate</strong> and the debrief synthesises everyone\'s.',
};

function inviteNudgeHtml(tabKey, _isTeam) {
  // Note: shown to ALL users (not just solo). Even people who've already
  // joined a team should see the prompt — they're the next ring of the
  // viral loop. Dismissal-via-X still applies once per user.
  if (_inviteNudgeDismissed) return '';
  const copy = INVITE_NUDGE_COPY[tabKey] || INVITE_NUDGE_COPY.checklist;
  return `
    <div class="solo-nudge-chip">
      <button class="solo-nudge-chip-body" onclick="planSwitchTab('team');window.scrollTo(0,0);" type="button">
        <span class="solo-nudge-dot"></span>
        <span class="solo-nudge-text">${copy}</span>
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><line x1="5" y1="12" x2="19" y2="12"/><polyline points="12 5 19 12 12 19"/></svg>
      </button>
      <button class="solo-nudge-chip-dismiss" onclick="dismissInviteNudge(event)" type="button" aria-label="Dismiss" title="Hide this prompt">
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
      </button>
    </div>`;
}

window.dismissInviteNudge = function(ev) {
  if (ev) ev.stopPropagation();
  _inviteNudgeDismissed = true;
  try { localStorage.setItem('inviteNudgeDismissed', '1'); } catch (_) {}
  renderApp();
};

// ── Supabase data access ──────────────────────────────────────────────────────

async function loadLatestPlan(userId) {
  const { data: plan, error: planErr } = await supabase
    .from('plans')
    .select('*')
    .eq('user_id', userId)
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();

  if (planErr) throw planErr;
  if (!plan) return null;

  const { data: notes } = await supabase
    .from('notes')
    .select('*')
    .eq('plan_id', plan.id);

  return { ...plan, notes: notes || [] };
}

async function loadTeamData(teamId) {
  // NOTE: firm_size / firm_mode / pains are intentionally NOT in this select
  // until migration 20260504000000 lands. Once it does, add them back here so
  // the team card can render firm size in the identity row.
  const [{ data: members }, { data: teamPlans }, { data: teamRow }] = await Promise.all([
    supabase
      .from('team_members')
      .select('role, joined_at, users(id, first_name, last_name, company)')
      .eq('team_id', teamId),
    supabase
      .from('plans')
      .select('id, user_id, problem, categories, role, sessions, booths, ai_themes')
      .eq('team_id', teamId),
    supabase
      .from('teams')
      .select('invite_token, company')
      .eq('id', teamId)
      .single(),
  ]);

  const planIds = (teamPlans || []).map(p => p.id);
  const { data: allNotes } = planIds.length
    ? await supabase.from('notes').select('*').in('plan_id', planIds)
    : { data: [] };

  return {
    members:     members     || [],
    teamPlans:   teamPlans   || [],
    allNotes:    allNotes    || [],
    inviteToken: teamRow?.invite_token || null,
    company:     teamRow?.company      || null,
    teamId,
  };
}

// Firm-size + firm-mode labels used by the team card identity row.
// (ROLE_LABELS and CATEGORY_LABELS are declared further down — the
// originals from before the team-card work, with broader legacy-slug
// coverage. Don't redeclare them here.)
const FIRM_SIZE_LABELS = {
  'solo':     'Solo',
  '2-10':     '2–10 firm',
  '11-50':    '11–50 firm',
  '50+':      '50+ firm',
  'industry': 'In-house team',
};

const FIRM_MODE_LABELS = {
  grow: 'Growing fast', optimise: 'Optimising', niche: 'Niching',
  exit: 'Exit / succession', explore: 'Exploring',
};

// ── Match bucket + ranking display model ─────────────────────────────────
// Replaces raw "% AI Match Confidence" everywhere. Two-part display:
//   1. Bucket tier label (top / high / medium / neutral) — coloured pill
//   2. Ranking — "#3 of 240"
//
// Tier colour palette mirrors the Stage 1 onboarding heat bands so users
// decode it without a legend (pink → coral → amber → cool-blue).
//
// TODO: Replace dummy bucket label and ranking with real values from matcher.
//   match.bucket: "top" | "high" | "medium" | "neutral"
//   match.rank:   number  (global rank in matcher output)
//   match.total:  number  (total session/booth pool count)
const SESSION_PLAN_DUMMY = [
  { bucket: 'top',    rank: 3  },
  { bucket: 'top',    rank: 7  },
  { bucket: 'high',   rank: 11 },
  { bucket: 'high',   rank: 18 },
  { bucket: 'high',   rank: 24 },
  { bucket: 'high',   rank: 31 },
  { bucket: 'medium', rank: 42 },
  { bucket: 'medium', rank: 58 },
  { bucket: 'medium', rank: 71 },
  { bucket: 'medium', rank: 84 },
  { bucket: 'medium', rank: 97 },
];
const BOOTH_PLAN_DUMMY = [
  { bucket: 'top',    rank: 1  },
  { bucket: 'high',   rank: 4  },
  { bucket: 'high',   rank: 8  },
  { bucket: 'high',   rank: 12 },
  { bucket: 'medium', rank: 18 },
  { bucket: 'medium', rank: 24 },
  { bucket: 'medium', rank: 31 },
  { bucket: 'medium', rank: 38 },
];
const FALLBACK_MATCH_TOTAL = { session: 240, booth: 90 };
const BUCKET_RANK_FLOOR    = { top: 1, high: 8, medium: 30, neutral: 100 };

// In-plan items: by rank-in-plan (1-indexed). Sessions+booths that the
// matcher put in the user's plan get top/high/medium per the spec.
function dummyMatchByPlanRank(rankInPlan, type) {
  const arr = type === 'booth' ? BOOTH_PLAN_DUMMY : SESSION_PLAN_DUMMY;
  if (!Number.isFinite(rankInPlan) || rankInPlan < 1) return arr[arr.length - 1];
  return arr[Math.min(rankInPlan - 1, arr.length - 1)];
}

// Browse contexts (Edit modals, Swap alternatives): hash by id so each
// session/booth has a stable bucket+rank across renders. Distribution
// roughly mirrors a real matcher: top 4%, high 14%, medium 27%, neutral rest.
function dummyMatchByHash(idStr, type) {
  const s = String(idStr || '');
  let h = 0;
  for (let i = 0; i < s.length; i++) {
    h = ((h << 5) - h) + s.charCodeAt(i);
    h |= 0;
  }
  const total = FALLBACK_MATCH_TOTAL[type === 'booth' ? 'booth' : 'session'];
  const norm  = (Math.abs(h) % 1000) / 1000;
  let bucket, rank;
  if (norm < 0.04) {
    bucket = 'top';
    rank   = Math.max(1, Math.round(norm / 0.04 * (BUCKET_RANK_FLOOR.high - 1)));
  } else if (norm < 0.18) {
    bucket = 'high';
    rank   = Math.round(BUCKET_RANK_FLOOR.high + ((norm - 0.04) / 0.14) * (BUCKET_RANK_FLOOR.medium - BUCKET_RANK_FLOOR.high));
  } else if (norm < 0.45) {
    bucket = 'medium';
    rank   = Math.round(BUCKET_RANK_FLOOR.medium + ((norm - 0.18) / 0.27) * (BUCKET_RANK_FLOOR.neutral - BUCKET_RANK_FLOOR.medium));
  } else {
    bucket = 'neutral';
    rank   = Math.round(BUCKET_RANK_FLOOR.neutral + ((norm - 0.45) / 0.55) * (total - BUCKET_RANK_FLOOR.neutral));
  }
  return { bucket, rank: Math.min(Math.max(rank, 1), total) };
}

function matchTotal(type) {
  if (type === 'booth') return (typeof _allExhibitors !== 'undefined' && _allExhibitors?.length) || FALLBACK_MATCH_TOTAL.booth;
  return (typeof _allSessions !== 'undefined' && _allSessions?.length) || FALLBACK_MATCH_TOTAL.session;
}

function bucketLabel(bucket) {
  switch (bucket) {
    case 'top':     return 'Top match';
    case 'high':    return 'High match';
    case 'medium':  return 'Medium match';
    case 'neutral': return 'Neutral match';
    default:        return 'Match';
  }
}

// Compact two-line badge — used everywhere a card needs to show its match.
// Pass { bucket, rank, type } where type is 'session' | 'booth' (used to
// pick the total). Optional `compact` for tight contexts (alts row, swap modal).
function renderMatchBadge({ bucket, rank, type, compact = false }) {
  const total   = matchTotal(type);
  const sparkle = bucket === 'top'
    ? '<svg class="match-bucket-icon" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M12 0 L13.5 10.5 L24 12 L13.5 13.5 L12 24 L10.5 13.5 L0 12 L10.5 10.5 Z"/></svg>'
    : '';
  return `<div class="match-badge tier-${bucket}${compact ? ' compact' : ''}">
    <span class="match-bucket">${sparkle}<span class="match-bucket-text">${bucketLabel(bucket)}</span></span>
    <span class="match-rank">AI ranked #${rank} of ${total}</span>
  </div>`;
}

// Resolves a match for ANY session/booth — uses real matcher data if
// present, otherwise picks the right dummy strategy.
function matchForSession(s, planRankIndex) {
  if (s?.match?.bucket && Number.isFinite(s?.match?.rank)) return s.match;
  if (Number.isFinite(planRankIndex)) return dummyMatchByPlanRank(planRankIndex, 'session');
  return dummyMatchByHash(s?.session_id, 'session');
}
function matchForBooth(b, planRankIndex) {
  if (b?.match?.bucket && Number.isFinite(b?.match?.rank)) return b.match;
  if (Number.isFinite(planRankIndex)) return dummyMatchByPlanRank(planRankIndex, 'booth');
  return dummyMatchByHash(b?.stand_number || b?.company_name, 'booth');
}

// Human-readable labels for the user's selected categories. Includes both the
// new 16-category slugs (cloud-accounting, practice-mgmt, etc.) and the
// legacy 13-category slugs in case any older plan rows still use them.
const CATEGORY_LABELS = {
  // Current
  'cloud-accounting': 'Cloud accounting',
  'practice-mgmt':    'Practice management',
  'tax-mtd':          'Tax & MTD',
  'audit':            'Audit & assurance',
  'bookkeeping':      'Bookkeeping',
  'payroll':          'Payroll',
  'doc-mgmt':         'Document management',
  'portals-esign':    'Portals & e-sign',
  'aml-onboarding':   'AML / KYC',
  'forecasting':      'Forecasting',
  'reporting':        'Reporting & analytics',
  'proposals':        'Proposals',
  'payments':         'Payments',
  'lending':          'Lending',
  'outsourcing':      'Outsourcing',
  'cyber':            'Cyber security',
  // Legacy
  'practice-management': 'Practice management',
  'ai-automation':       'AI & automation',
  'doc-management':      'Document management',
  'data-analytics':      'Data analytics',
  'cyber-security':      'Cyber security',
  'aml-kyc':             'AML / KYC',
  'hr-people':           'HR & leadership',
  'banking-payments':    'Banking & payments',
  'marketing-growth':    'Marketing & growth',
};

// Human-readable role labels — used as a tag on every >=80% match
// since role drives matcher weighting site-wide.
const ROLE_LABELS = {
  'founder':         'Founder',
  'partner':         'Partner',
  'director':        'Director',
  'senior':          'Senior accountant / manager',
  'accountant':      'Accountant',
  'ops-admin':       'Practice manager / ops',
  'bookkeeper':      'Bookkeeper',
  'advisor':         'Tax advisor',
  'industry':        'CFO / Finance Director',
  'finance-manager': 'Finance manager',
  'controller':      'Controller',
  'other':           'Other',
};

// Tag rules:
// - Only TOP and HIGH bucket matches get "why matched" tags. Medium and
//   neutral cards stay clean — the bucket label alone is honest enough.
// - Caller passes the resolved bucket so we don't double-compute. If
//   omitted, fall back to dummyMatchByHash (browse contexts).
// - Surface every onboarding answer the matcher would have weighted, using
//   the user's full labels (never extracted fragments). Sources:
//     · Selected categories that overlap session.canonical_categories
//     · Pains whose label keywords land in session title/description
//     · Role (always shown — it shapes every match)
//     · TODO: firm_size / mode / role_bucket once persisted in plans table
//       (currently only `role` is stored alongside categories + problem)
// - Cap at 6 tags so cards stay legible on mobile.
function whyMatched(session, plan, bucket) {
  const resolved = bucket || dummyMatchByHash(session.session_id, 'session').bucket;
  if (resolved !== 'top' && resolved !== 'high') return [];

  const tags = [];
  const sessionCats = session.canonical_categories || [];
  const userCats    = plan.categories || [];

  // Category matches — every user-picked category that overlaps this session.
  for (const cat of userCats) {
    const wanted = PLAN_CATEGORY_MATCH[cat] || [cat];
    if (wanted.some(w => sessionCats.includes(w))) {
      tags.push({ text: CATEGORY_LABELS[cat] || cat });
    }
  }

  // Pain matches — heuristic keyword check (4+ char) against title/desc.
  // Tags every pain that genuinely appears related, not just the first.
  const haystack = `${session.title || ''} ${session.description || ''}`.toLowerCase();
  const painLabels = (plan.problem || '').split(/\s*,\s*/).filter(Boolean);
  for (const painLabel of painLabels) {
    const sigWords = painLabel.toLowerCase().split(/\W+/).filter(w => w.length >= 4);
    if (sigWords.some(w => haystack.includes(w))) {
      tags.push({ text: painLabel });
    }
  }

  // Role tag — always include for 80%+ matches. Role is a per-user
  // dimension the matcher weights on every session.
  if (plan.role && ROLE_LABELS[plan.role]) {
    tags.push({ text: ROLE_LABELS[plan.role] });
  }

  return tags.slice(0, 6);
}

const PLAN_CATEGORY_MATCH = {
  'practice-management': ['practice-management'],
  'ai-automation':       ['ai-automation'],
  'bookkeeping':         ['bookkeeping'],
  'tax-mtd':             ['tax-mtd'],
  'doc-management':      ['doc-management'],
  'payroll':             ['payroll'],
  'data-analytics':      ['data-analytics'],
  'cyber-security':      ['cyber-security'],
  'aml-kyc':             ['aml-kyc'],
  'hr-people':           ['hr-people'],
  'banking-payments':    ['banking-payments'],
  'outsourcing':         ['outsourcing'],
  'marketing-growth':    ['marketing-growth'],
  'other':               [],
};

function bestAlternativeScore(item) {
  if (!item.day || !item.start_time) return 0;
  if (_resolvedSlots.has(`${item.day}-${item.start_time}`)) return 0;
  const cats = _plan?.categories || [];
  const wantedCanonicals = new Set(cats.flatMap(c => PLAN_CATEGORY_MATCH[c] || []));
  if (!wantedCanonicals.size) return 0;
  const planKeys = new Set((_plan?.sessions || []).map(s => `${s.session_id}|${s.day || ''}|${s.start_time || ''}`));
  let best = 0;
  for (const s of (_allSessions || [])) {
    if (s.session_id === item.session_id && s.day === item.day && s.start_time === item.start_time) continue;
    if (s.day !== item.day || s.start_time !== item.start_time) continue;
    if (planKeys.has(`${s.session_id}|${s.day || ''}|${s.start_time || ''}`)) continue;
    const matches = (s.canonical_categories || []).filter(c => wantedCanonicals.has(c)).length;
    if (matches > best) best = matches;
  }
  return best;
}

// Count of alternatives at the same time slot that fall in the SAME
// bucket as the user's current pick (e.g. show "4 other HIGH MATCH
// alternatives" only when there really are 4 same-bucket alts).
// Excludes the current session and anything else already in the user's
// plan. Click on the count line opens the same swap modal as the SWAP
// button — the user picks for themselves from the full list.
function sameBucketAlternativeCount(item, bucket) {
  if (!item.day || !item.start_time || !bucket) return 0;
  const planKeys = new Set((_plan?.sessions || []).map(s => `${s.session_id}|${s.day || ''}|${s.start_time || ''}`));
  let count = 0;
  for (const s of (_allSessions || [])) {
    if (s.day !== item.day || s.start_time !== item.start_time) continue;
    if (s.session_id === item.session_id) continue;
    if (planKeys.has(`${s.session_id}|${s.day || ''}|${s.start_time || ''}`)) continue;
    if (matchForSession(s).bucket === bucket) count++;
  }
  return count;
}

// ── Render helpers ────────────────────────────────────────────────────────────

const TICK_SVG = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>`;
const STAR_SVG = `<svg width="11" height="11" viewBox="0 0 24 24" fill="currentColor"><path d="M12 2l3.09 6.26L22 9.27l-5 4.87 1.18 6.88L12 17.77l-6.18 3.25L7 14.14 2 9.27l6.91-1.01L12 2z"/></svg>`;
const ALT_SVG  = `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg>`;
const SWAP_SVG = `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="17 1 21 5 17 9"/><path d="M3 11V9a4 4 0 0 1 4-4h14"/><polyline points="7 23 3 19 7 15"/><path d="M21 13v2a4 4 0 0 1-4 4H3"/></svg>`;


function flameSvg() {
  return `<svg class="flame-icon" width="16" height="16" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true"><path d="M12 2C12 2 13 5 16 8C19 11 20 13.5 20 16C20 20.4 16.4 24 12 24C7.6 24 4 20.4 4 16C4 13 6 10 8 8C8 10 9 11 10 11C11 11 11 9.5 11 7.5C11 5.5 12 3 12 2Z" fill="currentColor" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round"/></svg>`;
}

function rowFlames(rating) {
  return [1, 2, 3].map(n =>
    `<button class="row-fire-btn flame-btn ${(rating || 0) >= n ? 'lit' : ''}" data-rating="${n}" aria-label="${n} flame">${flameSvg()}</button>`
  ).join('');
}

// ── Tab nav ───────────────────────────────────────────────────────────────────

function renderTabNav() {
  const isTeam     = !!(_plan?.team_id);
  const teamCount  = _teamData?.members?.length ?? 0;
  const sessions   = _plan?.sessions || [];

  const tabs = [
    {
      id: 'checklist', label: 'Checklist', badge: sessions.length,
      icon: 'M9 11l3 3L22 4M21 12v7a2 2 0 01-2 2H5a2 2 0 01-2-2V5a2 2 0 012-2h11',
    },
    ...(isTeam ? [{
      id: 'team', label: 'Team', badge: teamCount,
      icon: 'M17 21V19C17 16.7909 15.2091 15 13 15H5C2.79086 15 1 16.7909 1 19V21M23 21V19C22.9986 17.1771 21.765 15.5857 20 15.13M16 3.13C17.7699 3.58317 19.0078 5.17799 19.0078 7.005C19.0078 8.83201 17.7699 10.4268 16 10.88M13 7C13 9.20914 11.2091 11 9 11C6.79086 11 5 9.20914 5 7C5 4.79086 6.79086 3 9 3C11.2091 3 13 4.79086 13 7Z',
    }] : []),
    {
      id: 'cpd', label: 'CPD', badge: null,
      icon: 'M22 11.08V12C21.9988 14.1564 21.3005 16.2547 20.0093 17.9818C18.7182 19.7088 16.9033 20.9725 14.8354 21.5839C12.7674 22.1953 10.5573 22.1219 8.53447 21.3746C6.51168 20.6273 4.78465 19.2461 3.61096 17.4371C2.43727 15.628 1.87979 13.4881 2.02168 11.3363C2.16356 9.18455 2.99721 7.13631 4.39828 5.49706C5.79935 3.85781 7.69279 2.71537 9.79619 2.24013C11.8996 1.7649 14.1003 1.98232 16.07 2.85999M22 4L12 14.01L9 11.01',
    },
    {
      id: 'debrief', label: 'Debrief', badge: null,
      icon: 'M14 2H6C5.46957 2 4.96086 2.21071 4.58579 2.58579C4.21071 2.96086 4 3.46957 4 4V20C4 20.5304 4.21071 21.0391 4.58579 21.4142C4.96086 21.7893 5.46957 22 6 22H18C18.5304 22 19.0391 21.7893 19.4142 21.4142C19.7893 21.0391 20 20.5304 20 20V8L14 2ZM14 2V8H20M16 13H8M16 17H8M10 9H8',
    },
  ];

  return `<nav class="app-tabs">
    <div class="app-tabs-inner">
      <div class="app-tabs-brand-row">
        <a class="app-tabs-brand" href="/">
          <img src="/images/AutoEvent.svg" alt="AutoEvent" class="brand-logo">
          <span class="brand-divider"></span>
          <span class="brand-event">Accountex 2026</span>
        </a>
        <div class="app-tabs-credits" aria-label="Made by">
          <span class="app-tabs-credits-label">Made by</span>
          <a href="https://workiro.com" target="_blank" rel="noopener" aria-label="Workiro">
            <img src="/images/workiro-logo.svg" alt="Workiro">
          </a>
          <a href="https://xumagazine.com" target="_blank" rel="noopener" aria-label="XU Magazine">
            <img src="/images/XU%20Magazine.webp" alt="XU Magazine">
          </a>
        </div>
      </div>
      <div class="app-tabs-row">
        ${tabs.map(t => `
          <button class="app-tab ${_currentTab === t.id ? 'active' : ''}" onclick="planSwitchTab('${t.id}')">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="${t.icon}"/></svg>
            ${t.label}
            ${t.badge !== null && t.badge !== undefined ? `<span class="tab-badge">${t.badge}</span>` : ''}
          </button>
        `).join('')}
      </div>
    </div>
  </nav>`;
}

// ── Checklist tab ─────────────────────────────────────────────────────────────

function parseTimeToMinutes(hhmm) {
  if (!hhmm) return 0;
  const [h, m] = hhmm.split(':').map(Number);
  return h * 60 + (m || 0);
}

// Truncate a booth description to a 1–2 line summary. Prefers the first
// full sentence if it fits within ~30 words, else word-cap at 25 + ellipsis.
// Trade-show users want quick "what is this, why care" — not full B2B
// sales copy.
function truncateBoothDesc(desc) {
  if (!desc) return '';
  const trimmed = desc.trim();
  // Tighter caps — short and punchy reads better on mobile (~2 lines).
  // First sentence if ≤22 words, else hard cap at 18 words + ellipsis.
  const firstSentence = trimmed.match(/^[^.!?]+[.!?]/);
  if (firstSentence && firstSentence[0].split(/\s+/).length <= 22) {
    return firstSentence[0].trim();
  }
  const words = trimmed.split(/\s+/);
  if (words.length <= 18) return trimmed;
  return words.slice(0, 18).join(' ') + '…';
}

function renderGapCard(day, startTime, endTime, _gapIndex) {
  const diffMin = parseTimeToMinutes(endTime) - parseTimeToMinutes(startTime);
  if (diffMin < 20) return '';
  const hours    = Math.floor(diffMin / 60);
  const mins     = diffMin % 60;
  const duration = hours > 0 ? `${hours}h${mins > 0 ? ` ${mins}m` : ''}` : `${mins} min`;
  const kind = diffMin >= 60 ? 'Lunch break' : diffMin >= 45 ? 'Long break' : 'Break';
  return `
    <div class="checklist-gap-card">
      <div class="checklist-gap-main">
        <div class="checklist-gap-time">
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>
          <span><strong>${kind}</strong> · ${escHtml(startTime)}–${escHtml(endTime)} · ${duration}</span>
        </div>
        <div class="checklist-gap-body">Free time — visit booths or pick a session for this slot.</div>
      </div>
      <button class="checklist-gap-cta" onclick="planFillSlot('${escHtml(day)}','${escHtml(startTime)}','${escHtml(endTime)}', event)" type="button">
        + Pick a session
      </button>
    </div>`;
}

// Note chips — emoji + label pairs that stamp into the textarea on tap.
// Same data model both ways: chips insert "${emoji} ${label}: " then the
// user types context. Saved note is just text — no parallel chip array,
// no schema change. AI debrief later groups by emoji prefix.
const NOTE_CHIPS_SESSION = [
  { emoji: '❤️', label: 'Loved it' },
  { emoji: '🔥', label: 'Game-changer' },
  { emoji: '💡', label: 'Idea' },
  { emoji: '🧠', label: 'Made me think' },
  { emoji: '👎', label: 'Skip it' },
  { emoji: '📝', label: 'To do' },
];
const NOTE_CHIPS_BOOTH = [
  { emoji: '❤️', label: 'Love it' },
  { emoji: '🔍', label: 'Look into' },
  { emoji: '🔥', label: 'Best in show' },
  { emoji: '🤔', label: 'Maybe' },
  { emoji: '👎', label: 'Skip' },
  { emoji: '⏱', label: 'Not now' },
];
const NOTE_HINT = 'Notes & ratings visible across your team';

function _renderNotePanel(panel, noteId, savedText) {
  if (savedText) {
    panel.className = 'checklist-note-panel saved';
    panel.innerHTML = `
      <div class="note-saved-body">
        <div class="note-saved-label">
          <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>
          Your note
        </div>
        <div class="note-saved-text">${escHtml(savedText)}</div>
      </div>
      <button class="note-saved-edit-btn" onclick="planOpenNote('${escHtml(noteId)}')" type="button" aria-label="Edit note">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 20h9"/><path d="M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4L16.5 3.5z"/></svg>
        Edit
      </button>`;
  } else {
    panel.className = 'checklist-note-panel idle';
    panel.innerHTML = `
      <button class="note-add-btn" onclick="planOpenNote('${escHtml(noteId)}')" type="button">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>
        Add a note
      </button>
      <div class="note-add-hint">${escHtml(NOTE_HINT)}</div>`;
  }
}

function renderChecklistTab() {
  const plan        = _plan;
  if (!plan) return '';

  const isTeam      = !!(_plan?.team_id);
  const sessions    = plan.sessions   || [];
  const booths      = plan.booths     || [];
  const notes       = plan.notes      || [];

  const notesByItem = {};
  for (const n of notes) {
    const key = `${n.item_type}:${n.item_id}`;
    if (_teamData && n.created_by && n.created_by !== _authUser?.id) {
      if (!notesByItem[key]) notesByItem[key] = [];
      if (Array.isArray(notesByItem[key])) notesByItem[key].push(n);
    } else if (!_teamData || n.created_by === _authUser?.id || !n.created_by) {
      notesByItem[key] = n.note_text || '';
    }
  }

  let teamNotesByItem = {};
  if (_teamData) {
    for (const n of _teamData.allNotes) {
      if (n.created_by && n.created_by !== _authUser?.id) {
        const key = `${n.item_type}:${n.item_id}`;
        if (!teamNotesByItem[key]) teamNotesByItem[key] = [];
        teamNotesByItem[key].push(n);
      }
    }
  }

  // Determine which sessions to show (always show all — team filtering is on the Team tab)
  const visibleSessions = sessions;

  // Sort chronologically
  const sortedSessions = [...visibleSessions].sort((a, b) => {
    const da = a.day === 'Day 1' ? 1 : 2;
    const db = b.day === 'Day 1' ? 1 : 2;
    return da - db || (a.start_time || '').localeCompare(b.start_time || '');
  });

  // Inline team-notes block on a card. Caps at 4 notes; if more exist,
  // shows a "+N more · View all" link that opens a modal listing every
  // teammate note for the item. Stops a single chatty teammate from
  // pushing the card off-screen. Tone follows the card colour identity:
  // mint on sessions, purple on booths.
  const TEAM_NOTES_INLINE_CAP = 4;
  function renderTeamNotesBlock(teamNotes, noteKey, itemTitle) {
    if (!teamNotes.length) return '';
    const tone = noteKey.startsWith('booth:') ? 'purple' : 'mint';
    const sorted = [...teamNotes].sort((a, b) =>
      new Date(b.created_at || 0) - new Date(a.created_at || 0));
    const visible = sorted.slice(0, TEAM_NOTES_INLINE_CAP);
    const overflow = Math.max(0, sorted.length - TEAM_NOTES_INLINE_CAP);
    const noteRow = (n) => {
      const author = _teamData?.members.find(m => m.users?.id === n.created_by);
      const name = author ? author.users.first_name : 'Teammate';
      return `<p class="team-note-row"><span class="team-note-name">${escHtml(name)}:</span> ${escHtml(n.note_text || '')}</p>`;
    };
    const total = sorted.length;
    const moreLink = overflow > 0
      ? `<button class="team-notes-more" type="button" data-title="${escHtml(itemTitle || '')}" onclick="planShowTeamNotes('${escHtml(noteKey)}', this.dataset.title)">See all ${total} →</button>`
      : '';
    return `<div class="team-notes-block tone-${tone}">${visible.map(noteRow).join('')}${moreLink}</div>`;
  }

  // Build a per-item lookup of team ratings — surfaces Sarah/James-style
  // flame ratings on each card so the user sees what their team thought
  // without flipping to Debrief.
  const teamRatingsByKey = {};
  for (const tp of (_teamData?.teamPlans || [])) {
    if (tp.user_id === _authUser?.id) continue;
    const author = _teamData?.members.find(m => m.users?.id === tp.user_id);
    const name = author ? author.users.first_name : 'Teammate';
    for (const s of (tp.sessions || [])) {
      if (!s.rating) continue;
      const key = `session:${s.session_id}`;
      (teamRatingsByKey[key] = teamRatingsByKey[key] || []).push({ name, rating: s.rating });
    }
    for (const b of (tp.booths || [])) {
      if (!b.rating) continue;
      const key = `booth:${b.stand_number}`;
      (teamRatingsByKey[key] = teamRatingsByKey[key] || []).push({ name, rating: b.rating });
    }
  }
  function renderTeamRatedRow(noteKey) {
    const raters = teamRatingsByKey[noteKey];
    if (!raters || !raters.length) return '';
    const tone = noteKey.startsWith('booth:') ? 'purple' : 'mint';
    const flame = `<svg class="team-rated-flame-icon" width="10" height="10" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M12 2C12 2 13 5 16 8C19 11 20 13.5 20 16C20 20.4 16.4 24 12 24C7.6 24 4 20.4 4 16C4 13 6 10 8 8C8 10 9 11 10 11C11 11 11 9.5 11 7.5C11 5.5 12 3 12 2Z"/></svg>`;
    return `<div class="team-rated-row tone-${tone}">
      <span class="team-rated-caption">Team rated</span>
      ${raters.map(r => `<span class="team-rated-pill">
        <span class="team-rated-name">${escHtml(r.name)}</span>
        <span class="team-rated-flames">${flame.repeat(Math.max(1, Math.min(3, r.rating)))}</span>
      </span>`).join('')}
    </div>`;
  }

  function renderSessionRow(item, i) {
    const noteKey      = `session:${item.session_id}`;
    const existingNote = typeof notesByItem[noteKey] === 'string' ? notesByItem[noteKey] : '';
    const planRankIdx  = (item.rank && Number.isFinite(item.rank)) ? item.rank : (i + 1);
    const match        = matchForSession(item, planRankIdx);
    const whyTags      = whyMatched(item, plan, match.bucket);
    const altCount     = sameBucketAlternativeCount(item, match.bucket);
    const teamNotes    = teamNotesByItem[noteKey] || [];

    // Universal SWAP badge — shown under the time block on EVERY session.
    // Tapping opens the slot-swap modal which now also handles the
    // "make this slot free time" path (replaces the dropped REMOVE link).
    const swapLink = `<button class="checklist-time-swap" onclick="planOpenSlotSwap('${escHtml(item.session_id)}', event)" type="button">
           <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="17 1 21 5 17 9"/><path d="M3 11V9a4 4 0 0 1 4-4h14"/><polyline points="7 23 3 19 7 15"/><path d="M21 13v2a4 4 0 0 1-4 4H3"/></svg>
           Swap
         </button>`;

    // Two-part match display: bucket pill + ranking line. Tags only
    // render for top/high tiers — medium and neutral cards stay clean.
    const whyHtml = `
      ${renderMatchBadge({ bucket: match.bucket, rank: match.rank, type: 'session' })}
      ${whyTags.length ? `<div class="checklist-why-tags">
        ${whyTags.map(t => `<span class="checklist-why-tag">${escHtml(t.text)}</span>`).join('')}
      </div>` : ''}`;

    // Single-line alts teaser: "↔ 4 other HIGH MATCH alternatives at this
    // time". Only shown if same-bucket alternatives exist for this slot.
    // Click opens the same swap modal as the inline SWAP button so the
    // user sees ALL options in that slot and picks for themselves.
    const altsHtml = altCount > 0 ? `
      <button class="checklist-alternatives-link tier-${match.bucket}" type="button"
        onclick="planOpenSlotSwap('${escHtml(item.session_id)}', event)">
        ${SWAP_SVG}
        <span>${altCount} other <strong>${escHtml(bucketLabel(match.bucket).toUpperCase())}</strong> alternative${altCount === 1 ? '' : 's'} at this time</span>
      </button>` : '';

    const teamNotesHtml = renderTeamNotesBlock(teamNotes, noteKey, item.title || '');

    const noteItemId  = `session:${escHtml(item.session_id)}`;
    const notePanel   = existingNote
      ? `<div class="checklist-note-panel saved" data-note-id="${noteItemId}" data-saved-text="${escHtml(existingNote)}">
           <div class="note-saved-body">
             <div class="note-saved-label">
               <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>
               Your note
             </div>
             <div class="note-saved-text">${escHtml(existingNote)}</div>
           </div>
           <button class="note-saved-edit-btn" onclick="planOpenNote('${noteItemId}')" type="button" aria-label="Edit note">
             <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 20h9"/><path d="M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4L16.5 3.5z"/></svg>
             Edit
           </button>
         </div>`
      : `<div class="checklist-note-panel idle" data-note-id="${noteItemId}" data-saved-text="">
           <button class="note-add-btn" onclick="planOpenNote('${noteItemId}')" type="button">
             <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>
             Add a note
           </button>
           <div class="note-add-hint">${escHtml(NOTE_HINT)}</div>
         </div>`;

    const userInitial = (_userProfile?.first_name || _authUser?.email || 'Y')[0].toUpperCase();
    const ratingLabel = (item.rating || 0) > 0 ? 'You rated' : 'Rate this';

    const avatarColors = ['t1', 't2', 't4'];
    let avatarColorIdx = 0;
    const teamAvatarHtml = _teamData
      ? _teamData.teamPlans
          .filter(tp => tp.user_id !== _authUser?.id)
          .filter(tp => (tp.sessions || []).some(s => String(s.session_id) === String(item.session_id)))
          .map(tp => {
            const member  = _teamData.members.find(m => m.users?.id === tp.user_id);
            const initial = member?.users?.first_name?.[0]?.toUpperCase()
                          || member?.users?.last_name?.[0]?.toUpperCase() || '?';
            const name    = [member?.users?.first_name, member?.users?.last_name].filter(Boolean).join(' ') || 'Teammate';
            return `<div class="mini-av ${avatarColors[avatarColorIdx++ % avatarColors.length]}" title="${escHtml(name)}">${escHtml(initial)}</div>`;
          })
          .join('')
      : '';

    return `
      <div class="checklist-row${item.attended ? ' attended' : ''} is-session" data-item-type="session" data-item-id="${escHtml(item.session_id)}" data-rating="${item.rating || 0}" style="animation-delay:${i * 40}ms">
        <div class="checklist-row-main">
          <div class="checklist-row-leftcol">
            <button class="checklist-box" aria-label="Mark as attended">${TICK_SVG}</button>
            <div class="checklist-time-block">
              <div class="checklist-time-main">${escHtml(item.start_time || '')}</div>
              <div class="checklist-time-sub">${escHtml(item.end_time || '')}</div>
              ${swapLink}
            </div>
          </div>
          <div class="checklist-main">
            <div class="checklist-main-title">${escHtml(item.title || item.session_id)}</div>
            <div class="checklist-main-meta">${item.theatre ? escHtml(item.theatre) + ' · ' : ''}<span class="type-pill session">Session</span></div>
            ${whyHtml}
            ${(() => {
              const blurb = item.description ? truncateBoothDesc(item.description).trim() : '';
              return blurb ? `<div class="checklist-blurb-divider"></div><p class="checklist-blurb">${escHtml(blurb)}</p>` : '';
            })()}
            ${altsHtml}
            <div class="checklist-row-actions">
              <div class="row-rate-wrap">
                <div class="row-rate-caption">${ratingLabel}</div>
                <div class="row-rate-inline">${rowFlames(item.rating)}</div>
              </div>
              <div class="row-team-wrap">
                <div class="row-rate-caption">Going</div>
                <div class="checklist-avatars">
                  <div class="mini-av t3" title="You">${userInitial}</div>
                  ${teamAvatarHtml}
                  ${(_teamData?.members?.length ?? 0) < 2 ? `<button class="invite-pip" onclick="planSwitchTab('team');window.scrollTo(0,0);" type="button" aria-label="Invite a teammate" title="Invite a teammate">
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><line x1="19" x2="19" y1="8" y2="14"/><line x1="22" x2="16" y1="11" y2="11"/></svg>
                  </button>` : ''}
                </div>
              </div>
            </div>
            ${renderTeamRatedRow(noteKey)}
          </div>
        </div>
        ${notePanel}
        ${teamNotesHtml}
      </div>`;
  }

  function renderBoothRow(item, i, displayRank) {
    const noteKey      = `booth:${item.stand_number}`;
    const existingNote = typeof notesByItem[noteKey] === 'string' ? notesByItem[noteKey] : '';
    const teamNotes    = teamNotesByItem[noteKey] || [];
    const desc         = item.company_description || '';
    const reason       = item.reason || '';
    const isWorkiro    = item.company_name === 'Workiro';

    const hostStrip = isWorkiro ? `
      <div class="checklist-row-host-strip">
        <span class="checklist-row-host-badge">
          <svg class="checklist-row-host-star" viewBox="0 0 24 24" fill="currentColor"><path d="M12 2L14.09 8.26L20.45 8.27L15.27 11.97L17.18 18.24L12 14.53L6.82 18.24L8.73 11.97L3.55 8.27L9.91 8.26L12 2Z"/></svg>
          We built this app
        </span>
        <a class="checklist-row-host-link" href="https://www.workiro.com" target="_blank" rel="noopener">workiro.com</a>
      </div>` : '';

    const noteItemId  = `booth:${escHtml(item.stand_number)}`;
    const notePanel   = existingNote
      ? `<div class="checklist-note-panel saved" data-note-id="${noteItemId}" data-saved-text="${escHtml(existingNote)}">
           <div class="note-saved-body">
             <div class="note-saved-label">
               <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>
               Your note
             </div>
             <div class="note-saved-text">${escHtml(existingNote)}</div>
           </div>
           <button class="note-saved-edit-btn" onclick="planOpenNote('${noteItemId}')" type="button" aria-label="Edit note">
             <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 20h9"/><path d="M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4L16.5 3.5z"/></svg>
             Edit
           </button>
         </div>`
      : `<div class="checklist-note-panel idle" data-note-id="${noteItemId}" data-saved-text="">
           <button class="note-add-btn" onclick="planOpenNote('${noteItemId}')" type="button">
             <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>
             Add a note
           </button>
           <div class="note-add-hint">${escHtml(NOTE_HINT)}</div>
         </div>`;

    const ratingLabel = (item.rating || 0) > 0 ? 'You rated' : 'Rate this';
    const boothPlanRank = displayRank || item.rank || (i + 1);
    const boothMatch    = matchForBooth(item, boothPlanRank);
    const truncatedDesc = truncateBoothDesc(desc);
    const userInitial = (_userProfile?.first_name || _authUser?.email || 'Y')[0].toUpperCase();

    // Team avatars — teammates with this booth in their plan. Mirrors
    // the session-row "Going" treatment so booths and sessions feel
    // structurally identical on the live plan.
    const avatarColors = ['t1', 't2', 't4'];
    let avatarColorIdx = 0;
    const teamAvatarHtml = _teamData
      ? _teamData.teamPlans
          .filter(tp => tp.user_id !== _authUser?.id)
          .filter(tp => (tp.booths || []).some(b => String(b.stand_number) === String(item.stand_number)))
          .map(tp => {
            const member  = _teamData.members.find(m => m.users?.id === tp.user_id);
            const initial = member?.users?.first_name?.[0]?.toUpperCase()
                          || member?.users?.last_name?.[0]?.toUpperCase() || '?';
            const name    = [member?.users?.first_name, member?.users?.last_name].filter(Boolean).join(' ') || 'Teammate';
            return `<div class="mini-av ${avatarColors[avatarColorIdx++ % avatarColors.length]}" title="${escHtml(name)}">${escHtml(initial)}</div>`;
          })
          .join('')
      : '';

    return `
      <div class="checklist-row is-booth${isWorkiro ? ' is-host' : ''}${item.attended ? ' attended' : ''}" data-item-type="booth" data-item-id="${escHtml(item.stand_number)}" data-rating="${item.rating || 0}" style="animation-delay:${(sessions.length + i) * 40}ms">
        ${hostStrip}
        <button class="booth-quiet-remove" onclick="planConfirmRemoveBooth('${escHtml(String(item.stand_number))}','${escHtml(item.company_name || '')}')" type="button" aria-label="Remove from plan" title="Remove from plan">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
        </button>
        <div class="checklist-row-main">
          <div class="checklist-row-leftcol booth-leftcol">
            <button class="checklist-box" aria-label="Mark as visited">${TICK_SVG}</button>
            <button class="checklist-time-swap variant-booth" onclick="openPlanEditor('booths')" type="button" aria-label="Edit booths">
              <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="17 1 21 5 17 9"/><path d="M3 11V9a4 4 0 0 1 4-4h14"/><polyline points="7 23 3 19 7 15"/><path d="M21 13v2a4 4 0 0 1-4 4H3"/></svg>
              Swap
            </button>
          </div>
          <div class="checklist-main">
            <div class="checklist-main-title">${escHtml(item.company_name)}</div>
            <div class="checklist-main-meta booth-meta">Booth · Stand ${escHtml(item.stand_number || '')}</div>
            ${renderMatchBadge({ bucket: boothMatch.bucket, rank: boothMatch.rank, type: 'booth' })}
            ${(truncatedDesc && truncatedDesc.trim()) ? `<div class="checklist-blurb-divider tone-purple"></div><p class="checklist-blurb">${escHtml(truncatedDesc)}</p>` : ''}
            <div class="checklist-row-actions">
              <div class="row-rate-wrap">
                <div class="row-rate-caption">${ratingLabel}</div>
                <div class="row-rate-inline">${rowFlames(item.rating)}</div>
              </div>
              <div class="row-team-wrap">
                <div class="row-rate-caption">Visiting</div>
                <div class="checklist-avatars">
                  <div class="mini-av t3" title="You">${userInitial}</div>
                  ${teamAvatarHtml}
                  ${(_teamData?.members?.length ?? 0) < 2 ? `<button class="invite-pip" onclick="planSwitchTab('team');window.scrollTo(0,0);" type="button" aria-label="Invite a teammate" title="Invite a teammate">
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><line x1="19" x2="19" y1="8" y2="14"/><line x1="22" x2="16" y1="11" y2="11"/></svg>
                  </button>` : ''}
                </div>
              </div>
            </div>
            ${renderTeamRatedRow(noteKey)}
            ${renderTeamNotesBlock(teamNotes, noteKey, item.company_name || '')}
          </div>
        </div>
        ${notePanel}
      </div>`;
  }

  // Build session HTML with day group labels and gap cards
  let currentDay = null;
  let gapIndex = 0;
  const sessionParts = [];
  sortedSessions.forEach((item, i) => {
    if (item.day !== currentDay) {
      currentDay = item.day;
      const dayLabel = item.day === 'Day 1' ? 'Day 1 · Wednesday 13 May'
                     : item.day === 'Day 2' ? 'Day 2 · Thursday 14 May' : '';
      if (dayLabel) sessionParts.push(`<div class="checklist-day-label">${dayLabel}</div>`);
    }
    sessionParts.push(renderSessionRow(item, i));
    const next = sortedSessions[i + 1];
    if (next && next.day === item.day && item.end_time && next.start_time) {
      const gap = parseTimeToMinutes(next.start_time) - parseTimeToMinutes(item.end_time);
      if (gap >= 20) sessionParts.push(renderGapCard(item.day, item.end_time, next.start_time, gapIndex++));
    }
  });
  const sessionItems = sessionParts.join('');

  // Booths display in matcher rank order (rank=1 first). When real
  // match_confidence ships, sort by that desc; until then the matcher's
  // existing rank order is the truthful "highest match first" — the
  // dummy values just need to follow that order, not redefine it.
  const sortedBooths = [...booths].sort((a, b) => {
    const ca = a.match_confidence;
    const cb = b.match_confidence;
    if (ca != null && cb != null) return cb - ca;
    if (ca != null) return -1;
    if (cb != null) return 1;
    return (a.rank || 999) - (b.rank || 999);
  });
  const boothItems = sortedBooths.map((item, i) => renderBoothRow(item, i, i + 1)).join('');


  return `
    <div class="app-header">
      <div class="app-header-top">
        <div>
          <h2 class="app-title">Your <em>Accountex</em> plan.</h2>
          <p class="app-sub" style="margin-top:8px;">Rate sessions as you go and add notes — they roll into your debrief.</p>
          ${inviteNudgeHtml('checklist', isTeam)}
        </div>
      </div>
    </div>


    <div id="sessions-anchor" class="checklist-anchor-section">
      <div class="checklist-section-head">
        <h2 class="checklist-section-title">
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 2v4M12 18v4M4.93 4.93l2.83 2.83M16.24 16.24l2.83 2.83M2 12h4M18 12h4M4.93 19.07l2.83-2.83M16.24 7.76l2.83-2.83"/></svg>
          Must-watch sessions
        </h2>
        <div class="checklist-section-meta">
          <span class="checklist-section-count">${visibleSessions.length} ${visibleSessions.length === 1 ? 'session' : 'sessions'}</span>
          <button class="checklist-section-edit variant-sessions" onclick="openPlanEditor('sessions')" type="button">
            <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 20h9"/><path d="M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4L16.5 3.5z"/></svg>
            Edit sessions
          </button>
        </div>
      </div>
      <div class="checklist">
        ${sessionItems || '<div class="plan-empty">No sessions in your plan yet.</div>'}
      </div>
    </div>

    ${booths.length ? `
      <div id="booths-anchor" class="checklist-anchor-section" style="margin-top:48px">
        <div class="checklist-section-head">
          <h2 class="checklist-section-title">
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 9l9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/><polyline points="9 22 9 12 15 12 15 22"/></svg>
            Must-visit booths
          </h2>
          <div class="checklist-section-meta">
            <span class="checklist-section-count">${booths.length} ${booths.length === 1 ? 'booth' : 'booths'}</span>
            <button class="checklist-section-edit variant-booths" onclick="openPlanEditor('booths')" type="button">
              <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 20h9"/><path d="M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4L16.5 3.5z"/></svg>
              Edit booths
            </button>
          </div>
        </div>
        <p class="checklist-intro">Rate each vendor after a conversation — your notes and scores feed into your debrief.</p>
        <div class="checklist">${boothItems}</div>
      </div>
    ` : ''}

    <div class="plan-editor-entry">
      <div class="plan-editor-entry-label">Change your plan</div>
      <div class="plan-editor-entry-actions">
        <button class="plan-editor-entry-btn variant-sessions" onclick="openPlanEditor('sessions')" type="button">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="4" width="18" height="18" rx="2" ry="2"/><line x1="16" y1="2" x2="16" y2="6"/><line x1="8" y1="2" x2="8" y2="6"/><line x1="3" y1="10" x2="21" y2="10"/></svg>
          Edit sessions
          <span class="plan-editor-entry-count">${sessions.length}</span>
        </button>
        <button class="plan-editor-entry-btn variant-booths" onclick="openPlanEditor('booths')" type="button">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 9l9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/><polyline points="9 22 9 12 15 12 15 22"/></svg>
          Edit booths
          <span class="plan-editor-entry-count">${booths.length}</span>
        </button>
      </div>
    </div>
  `;
}

// ── Team tab ──────────────────────────────────────────────────────────────────

function buildIntelBlocks() {
  if (!_teamData || _teamData.members.length < 2) {
    return `
      <div class="intel-block tone-purple">
        <div class="intel-block-label">Waiting for your team</div>
        <div class="intel-block-headline">Your team intel will appear here.</div>
        <div class="intel-block-body">Once teammates join, we'll surface patterns across everyone's stated problems and priorities.</div>
      </div>
    `;
  }

  const allPlans = _teamData.teamPlans;
  const catLabels = {
    'practice-management': 'Practice management', 'ai-automation': 'AI & automation',
    'bookkeeping': 'Bookkeeping', 'tax-mtd': 'Tax & MTD',
    'doc-management': 'Document management', 'payroll': 'Payroll',
  };
  const allCats = Object.keys(catLabels);

  // Count category frequency across all plans
  const catCounts = {};
  for (const p of allPlans) {
    for (const c of (p.categories || [])) {
      catCounts[c] = (catCounts[c] || 0) + 1;
    }
  }
  const topCat = Object.entries(catCounts).sort((a, b) => b[1] - a[1])[0];
  const multiCat = Object.entries(catCounts).filter(([, n]) => n >= 2)[0];
  const blindSpot = allCats.find(c => !catCounts[c]);
  const topAiTheme = allPlans.flatMap(p => p.ai_themes || []).slice(0, 1)[0];

  return `
    <div class="intel-block tone-pink">
      <div class="intel-block-label">Top problem</div>
      <div class="intel-block-headline">${topCat ? escHtml(catLabels[topCat[0]] || topCat[0]) : 'Multiple areas'}</div>
      <div class="intel-block-body">${topCat ? `${topCat[1]} of ${allPlans.length} team members are scouting this area.` : 'Your team covers a wide range of priorities.'}</div>
    </div>
    <div class="intel-block tone-purple">
      <div class="intel-block-label">Emerging pattern</div>
      <div class="intel-block-headline">${multiCat ? escHtml(catLabels[multiCat[0]] || multiCat[0]) : 'Broad coverage'}</div>
      <div class="intel-block-body">${multiCat ? `${multiCat[1]} people are evaluating this — worth a dedicated debrief session.` : 'Your team has spread coverage well across categories.'}</div>
    </div>
    <div class="intel-block tone-amber">
      <div class="intel-block-label">Blind spot</div>
      <div class="intel-block-headline">${blindSpot ? escHtml(catLabels[blindSpot]) : 'None found'}</div>
      <div class="intel-block-body">${blindSpot ? `Nobody on your team is scouting ${catLabels[blindSpot].toLowerCase()} — worth a quick look if it's relevant.` : 'Your team has solid coverage across all major categories.'}</div>
    </div>
    <div class="intel-block tone-mint">
      <div class="intel-block-label">This quarter's focus</div>
      <div class="intel-block-headline">${topAiTheme ? escHtml(topAiTheme.length > 50 ? topAiTheme.slice(0, 48) + '…' : topAiTheme) : 'Review after the show'}</div>
      <div class="intel-block-body">Drawn from your team's top AI-matched sessions and stated priorities.</div>
    </div>
  `;
}

function renderTeammateCard(m, index) {
  const u         = m.users;
  const isMe      = u.id === _authUser?.id;
  const initials  = `${u.first_name?.[0] || ''}${u.last_name?.[0] || ''}`.toUpperCase();
  const avatarClass  = `t${(index % 4) + 1}`;
  const memberPlan   = _teamData.teamPlans.find(p => p.user_id === u.id);
  const sessionCount = (memberPlan?.sessions || []).length;
  const noteCount    = _teamData.allNotes.filter(n => n.plan_id === memberPlan?.id).length;

  const roleLabel     = memberPlan?.role ? (ROLE_LABELS[memberPlan.role] || memberPlan.role) : '';
  const firmSizeLabel = memberPlan?.firm_size ? (FIRM_SIZE_LABELS[memberPlan.firm_size] || memberPlan.firm_size) : '';
  const rawFirm  = (u.company || '').trim();
  const firmName = (!rawFirm || /^company$/i.test(rawFirm) || /^your[-\s]?firm$/i.test(rawFirm)) ? '' : rawFirm;
  const identityParts = [roleLabel, firmSizeLabel, firmName].filter(Boolean).map(escHtml);

  let painLabels = [];
  if (Array.isArray(memberPlan?.pains) && memberPlan.pains.length) {
    painLabels = memberPlan.pains.map(s => s);
  } else if (memberPlan?.problem) {
    painLabels = String(memberPlan.problem).split(/,\s*/).map(s => s.trim()).filter(Boolean);
  }

  const stackGapLabels = (memberPlan?.categories || [])
    .map(c => CATEGORY_LABELS[c] || c)
    .filter(Boolean);

  const joinedDate = new Date(m.joined_at);
  const joinedStr = isNaN(joinedDate) ? '' : `Joined · ${joinedDate.toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })}`;

  const fullName = `${u.first_name || ''} ${u.last_name || ''}`.trim() || 'this teammate';
  return `
    <div class="teammate ${isMe ? 'me' : ''}">
      ${!isMe ? `<button class="teammate-quiet-remove" type="button"
        onclick="planConfirmRemoveTeamMember('${escHtml(u.id)}', '${escHtml(fullName)}')"
        aria-label="Remove from team" title="Remove from team">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
      </button>` : ''}
      <div class="teammate-top">
        <div class="teammate-avatar ${avatarClass}">${escHtml(initials)}</div>
        <div class="teammate-info">
          <div class="teammate-name-row">
            <span class="teammate-name">${escHtml(u.first_name)} ${escHtml(u.last_name)}</span>
            ${isMe ? '<span class="teammate-you-tag">You</span>' : ''}
          </div>
          ${identityParts.length ? `<div class="teammate-identity">${identityParts.join(' <span class="teammate-identity-sep">·</span> ')}</div>` : ''}
        </div>
      </div>
      ${painLabels.length ? `
        <div class="teammate-meta-block">
          <div class="teammate-meta-label tone-pink">Their pains</div>
          <div class="teammate-meta-pills">
            ${painLabels.map(p => `<span class="teammate-meta-pill pain">${escHtml(p)}</span>`).join('')}
          </div>
        </div>
      ` : ''}
      ${stackGapLabels.length ? `
        <div class="teammate-meta-block">
          <div class="teammate-meta-label tone-purple">Stack gaps</div>
          <div class="teammate-meta-pills">
            ${stackGapLabels.map(c => `<span class="teammate-meta-pill cat">${escHtml(c)}</span>`).join('')}
          </div>
        </div>
      ` : ''}
      <div class="teammate-footer">
        <div class="teammate-footer-stats">
          <span><strong>${sessionCount}</strong> sessions</span>
          <span><strong>${noteCount}</strong> notes</span>
        </div>
        <div class="teammate-footer-joined">${escHtml(joinedStr)}</div>
      </div>
    </div>
  `;
}

// Pending team invites — UX-only memory of recently-sent emails. Lives
// in localStorage so it survives reloads but doesn't require any DB
// schema changes. Auto-expires entries older than 7 days. The user can
// resend (re-fires the magic link) or cancel (just removes from the
// list — once sent, the email is sent; "cancel" is a memory clean-up).
const PENDING_INVITES_KEY = 'pendingTeamInvites';
const PENDING_INVITE_TTL_MS = 7 * 24 * 3600 * 1000;

function _readPendingInvites() {
  try {
    const raw = localStorage.getItem(PENDING_INVITES_KEY);
    if (!raw) return [];
    const arr = JSON.parse(raw);
    if (!Array.isArray(arr)) return [];
    const now = Date.now();
    const fresh = arr.filter(e => e?.email && e?.sentAt && (now - e.sentAt) < PENDING_INVITE_TTL_MS);
    if (fresh.length !== arr.length) {
      try { localStorage.setItem(PENDING_INVITES_KEY, JSON.stringify(fresh)); } catch {}
    }
    return fresh;
  } catch { return []; }
}
function _writePendingInvites(arr) {
  try { localStorage.setItem(PENDING_INVITES_KEY, JSON.stringify(arr)); } catch {}
}
function rememberPendingInvite(email) {
  const list = _readPendingInvites().filter(e => e.email !== email);
  list.unshift({ email, sentAt: Date.now() });
  _writePendingInvites(list);
}
function forgetPendingInvite(email) {
  _writePendingInvites(_readPendingInvites().filter(e => e.email !== email));
}
function _formatRelativeTime(ms) {
  const diff = Math.max(0, Date.now() - ms);
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins} min${mins === 1 ? '' : 's'} ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

function renderPendingInvitesBlock() {
  const list = _readPendingInvites();
  if (!list.length) return '';
  return `
    <div class="team-invite-pending">
      <div class="team-invite-pending-label">Pending invites</div>
      ${list.map(e => `
        <div class="team-invite-pending-row" data-email="${escHtml(e.email)}">
          <div class="team-invite-pending-meta">
            <span class="team-invite-pending-email">${escHtml(e.email)}</span>
            <span class="team-invite-pending-time">Sent ${escHtml(_formatRelativeTime(e.sentAt))}</span>
          </div>
          <div class="team-invite-pending-actions">
            <button class="team-invite-pending-btn resend" type="button" data-email="${escHtml(e.email)}" onclick="planResendInvite(this.dataset.email)">Resend</button>
            <button class="team-invite-pending-btn cancel" type="button" aria-label="Remove from list" data-email="${escHtml(e.email)}" onclick="planCancelPendingInvite(this.dataset.email)">
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
            </button>
          </div>
        </div>
      `).join('')}
    </div>
  `;
}

// "Show, don't tell" team-mode preview — surfaces what a real session
// card looks like once teammates have rated, taken notes, and joined.
// Shown only in the solo state since teammates with their own active
// view see the real thing on the Checklist already. Pure markup demo,
// not interactive — uses real card classes so styling stays in sync.
function renderTeamPreview() {
  return `
    <section class="team-preview">
      <div class="team-preview-eyebrow">
        <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M12 0 L13.5 10.5 L24 12 L13.5 13.5 L12 24 L10.5 13.5 L0 12 L10.5 10.5 Z"/></svg>
        With your team in
      </div>
      <h3 class="team-preview-headline">Your Planner is <em>10× more useful</em> with the team in.</h3>
      <p class="team-preview-sub">Live notes, ratings, and team intel flowing in side-by-side. Every session — every booth — through your whole team's eyes. Here's what one card looks like when team mode is on:</p>

      <!-- Mockup session card — uses real class names so it inherits
           every styling change made elsewhere on the Checklist. -->
      <div class="team-preview-card-wrap">
        <span class="team-preview-card-tag">Preview</span>
        <div class="checklist-row is-session" style="animation: none;">
          <div class="checklist-row-main">
            <div class="checklist-row-leftcol">
              <button class="checklist-box" type="button" aria-hidden="true" tabindex="-1">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>
              </button>
              <div class="checklist-time-block">
                <div class="checklist-time-main">10:30</div>
                <div class="checklist-time-sub">11:15</div>
              </div>
            </div>
            <div class="checklist-main">
              <div class="checklist-main-title">AI for accountants: practical use cases that actually drive results</div>
              <div class="checklist-main-meta">Main Stage · <span class="type-pill session">Session</span></div>
              <div class="match-badge tier-top">
                <span class="match-bucket">
                  <svg class="match-bucket-icon" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M12 0 L13.5 10.5 L24 12 L13.5 13.5 L12 24 L10.5 13.5 L0 12 L10.5 10.5 Z"/></svg>
                  <span class="match-bucket-text">Top match</span>
                </span>
                <span class="match-rank">AI ranked #3 of 240</span>
              </div>
              <div class="checklist-blurb-divider"></div>
              <p class="checklist-blurb">Speakers walk through three live AI rollouts at top-50 firms, including the workflow framework most firms get wrong.</p>

              <div class="checklist-row-actions">
                <div class="row-rate-wrap">
                  <div class="row-rate-caption">You rated</div>
                  <div class="row-rate-inline">
                    <button class="row-fire-btn flame-btn lit" tabindex="-1"><svg class="flame-icon" viewBox="0 0 24 24" fill="none"><path d="M12 2C12 2 13 5 16 8C19 11 20 13.5 20 16C20 20.4 16.4 24 12 24C7.6 24 4 20.4 4 16C4 13 6 10 8 8C8 10 9 11 10 11C11 11 11 9.5 11 7.5C11 5.5 12 3 12 2Z" fill="currentColor" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round"/></svg></button>
                    <button class="row-fire-btn flame-btn lit" tabindex="-1"><svg class="flame-icon" viewBox="0 0 24 24" fill="none"><path d="M12 2C12 2 13 5 16 8C19 11 20 13.5 20 16C20 20.4 16.4 24 12 24C7.6 24 4 20.4 4 16C4 13 6 10 8 8C8 10 9 11 10 11C11 11 11 9.5 11 7.5C11 5.5 12 3 12 2Z" fill="currentColor" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round"/></svg></button>
                    <button class="row-fire-btn flame-btn lit" tabindex="-1"><svg class="flame-icon" viewBox="0 0 24 24" fill="none"><path d="M12 2C12 2 13 5 16 8C19 11 20 13.5 20 16C20 20.4 16.4 24 12 24C7.6 24 4 20.4 4 16C4 13 6 10 8 8C8 10 9 11 10 11C11 11 11 9.5 11 7.5C11 5.5 12 3 12 2Z" fill="currentColor" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round"/></svg></button>
                  </div>
                </div>
                <div class="row-team-wrap">
                  <div class="row-rate-caption">Going</div>
                  <div class="checklist-avatars">
                    <div class="mini-av t3" title="You">Y</div>
                    <div class="mini-av t1" title="Sarah">S</div>
                    <div class="mini-av t2" title="James">J</div>
                  </div>
                </div>
              </div>

              <div class="team-rated-row tone-mint">
                <span class="team-rated-caption">Team rated</span>
                <span class="team-rated-pill">
                  <span class="team-rated-name">Sarah</span>
                  <span class="team-rated-flames">
                    <svg class="team-rated-flame-icon" width="10" height="10" viewBox="0 0 24 24" fill="currentColor"><path d="M12 2C12 2 13 5 16 8C19 11 20 13.5 20 16C20 20.4 16.4 24 12 24C7.6 24 4 20.4 4 16C4 13 6 10 8 8C8 10 9 11 10 11C11 11 11 9.5 11 7.5C11 5.5 12 3 12 2Z"/></svg>
                    <svg class="team-rated-flame-icon" width="10" height="10" viewBox="0 0 24 24" fill="currentColor"><path d="M12 2C12 2 13 5 16 8C19 11 20 13.5 20 16C20 20.4 16.4 24 12 24C7.6 24 4 20.4 4 16C4 13 6 10 8 8C8 10 9 11 10 11C11 11 11 9.5 11 7.5C11 5.5 12 3 12 2Z"/></svg>
                    <svg class="team-rated-flame-icon" width="10" height="10" viewBox="0 0 24 24" fill="currentColor"><path d="M12 2C12 2 13 5 16 8C19 11 20 13.5 20 16C20 20.4 16.4 24 12 24C7.6 24 4 20.4 4 16C4 13 6 10 8 8C8 10 9 11 10 11C11 11 11 9.5 11 7.5C11 5.5 12 3 12 2Z"/></svg>
                  </span>
                </span>
                <span class="team-rated-pill">
                  <span class="team-rated-name">James</span>
                  <span class="team-rated-flames">
                    <svg class="team-rated-flame-icon" width="10" height="10" viewBox="0 0 24 24" fill="currentColor"><path d="M12 2C12 2 13 5 16 8C19 11 20 13.5 20 16C20 20.4 16.4 24 12 24C7.6 24 4 20.4 4 16C4 13 6 10 8 8C8 10 9 11 10 11C11 11 11 9.5 11 7.5C11 5.5 12 3 12 2Z"/></svg>
                    <svg class="team-rated-flame-icon" width="10" height="10" viewBox="0 0 24 24" fill="currentColor"><path d="M12 2C12 2 13 5 16 8C19 11 20 13.5 20 16C20 20.4 16.4 24 12 24C7.6 24 4 20.4 4 16C4 13 6 10 8 8C8 10 9 11 10 11C11 11 11 9.5 11 7.5C11 5.5 12 3 12 2Z"/></svg>
                    <svg class="team-rated-flame-icon" width="10" height="10" viewBox="0 0 24 24" fill="currentColor"><path d="M12 2C12 2 13 5 16 8C19 11 20 13.5 20 16C20 20.4 16.4 24 12 24C7.6 24 4 20.4 4 16C4 13 6 10 8 8C8 10 9 11 10 11C11 11 11 9.5 11 7.5C11 5.5 12 3 12 2Z"/></svg>
                  </span>
                </span>
              </div>

              <div class="team-notes-block tone-mint">
                <p class="team-note-row"><span class="team-note-name">Sarah:</span> 🔥 Game-changer: speakers nailed the AML angle — exactly what we've been wrestling with for our top-50 clients.</p>
                <p class="team-note-row"><span class="team-note-name">James:</span> 📝 To do: pull the workflow automation slide, share with the partner group on Friday.</p>
                <p class="team-note-row"><span class="team-note-name">Sarah:</span> 💡 Idea: run a 30-min internal lunch-and-learn from this — could replace our Q3 training.</p>
                <p class="team-note-row"><span class="team-note-name">James:</span> 🧠 Made me think: we're probably 6 months behind where the speaker said the leading firms are.</p>
                <span class="team-notes-more" style="cursor: default;">See all 8 →</span>
              </div>
            </div>
          </div>
        </div>
      </div>

      <p class="team-preview-foot">Multiply this across every session and every booth in your plan. <strong>That's team mode.</strong></p>
    </section>
  `;
}

function renderTeamTab() {
  if (!_teamData) return '<p style="color:var(--text-muted);padding:32px 0;">Team data not available.</p>';

  const MAX_TEAM_MEMBERS = 12;
  const memberCount = _teamData.members.length;
  const isSolo      = memberCount < 2;
  const remaining   = Math.max(0, MAX_TEAM_MEMBERS - memberCount);
  const isFull      = memberCount >= MAX_TEAM_MEMBERS;
  const pillTone    = isFull ? 'full' : (memberCount > 1 ? 'team' : 'solo');

  const spotsLeftLine = isFull
    ? 'Team full'
    : `${remaining} of ${MAX_TEAM_MEMBERS} spots left`;
  const capacityPill = `
    <div class="team-capacity-pill ${pillTone}">
      <span class="team-capacity-count">${memberCount}/${MAX_TEAM_MEMBERS}</span>
      <span class="team-capacity-scarce">${escHtml(spotsLeftLine)}</span>
    </div>
  `;

  const inviteForm = `
    <div class="team-invite-form" id="team-invite-form">
      <div class="team-invite-input-shell">
        <input type="email" class="team-invite-email-input" id="team-invite-email"
          placeholder="colleague@firm.com" autocomplete="email"
          onkeydown="if(event.key==='Enter'){event.preventDefault();planSendInvite();}">
        <button class="team-invite-send-btn" onclick="planSendInvite()" type="button">
          <svg class="team-invite-send-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
            <rect x="2" y="4" width="20" height="16" rx="2"/>
            <path d="M22 6 12 13 2 6"/>
          </svg>
          <span class="team-invite-send-label">Send invite</span>
        </button>
      </div>
      <div class="team-invite-status" id="team-invite-status"></div>
      ${renderPendingInvitesBlock()}
    </div>
  `;

  const focusInviteEmail = "document.getElementById('team-invite-email')?.focus();";

  const placeholderCard = !isFull ? `
    <div class="teammate teammate-placeholder" onclick="${focusInviteEmail}">
      <div class="teammate-placeholder-inner">
        <div class="teammate-placeholder-icon">
          <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M16 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="8.5" cy="7" r="4"/><line x1="20" y1="8" x2="20" y2="14"/><line x1="23" y1="11" x2="17" y2="11"/></svg>
        </div>
        <div class="teammate-placeholder-text">
          See your team's top pains and tool wants all in one place. Invite them in to see.<br>
          <strong>Tap here to invite by email.</strong>
        </div>
      </div>
    </div>
  ` : '';

  const heroTitle = isFull
    ? `Your <em>${MAX_TEAM_MEMBERS}-strong</em> team is locked in.`
    : `Invite up to <em>${MAX_TEAM_MEMBERS} teammates.</em>`;

  const heroSub = isFull
    ? `You've reached the <strong>${MAX_TEAM_MEMBERS}-teammate</strong> limit per workspace — kept tight on purpose so everyone's notes, ratings, and synthesis stay useful.`
    : (isSolo
        ? `Send each colleague an email invite. They get their own AI-matched plan in this workspace — with their notes, ratings, and CPD hours flowing into a shared debrief.`
        : `Each colleague who joins unlocks <strong>their sessions on your plan</strong>, <strong>their notes attributed in real time</strong>, <strong>their booth ratings</strong>, and a <strong>shared debrief</strong>.`);

  const eyebrowLabel = isFull ? 'Workspace at capacity' : 'Workspace invite';

  const inviteHero = `
    <div class="team-invite-hero">
      <div class="team-invite-hero-inner">
        <div class="team-capacity-row">
          <div class="team-section-eyebrow tone-pink">${eyebrowLabel}</div>
          ${capacityPill}
        </div>
        <div class="team-invite-hero-title">${heroTitle}</div>
        <div class="team-invite-hero-sub">${heroSub}</div>
        ${isFull ? '' : inviteForm}
      </div>
    </div>
  `;

  // Single H1 across both states — "Bring your team to Accountex." is
  // the right framing whether they have teammates yet or not.
  const pageTitle = `Bring your team to <em>Accountex.</em>`;

  const pageSub = isSolo
    ? ``
    : `Who's covering what, whose notes are flowing in live, and what the team has actually decided.`;

  // AI synthesis section + TaxReady promo deliberately cut from the
  // Team tab. AI synthesis on pre-event onboarding answers is theatre
  // (the data is already visible on the cards above); TaxReady is
  // off-topic here and lands better in Debrief. Three sections only:
  // header, workspace invite, who's-going-and-why.

  return `
    <div class="app-header">
      <div class="app-header-top">
        <div>
          <h2 class="app-title">${pageTitle}</h2>
          ${pageSub ? `<p class="app-sub" style="margin-top:6px;">${pageSub}</p>` : ''}
        </div>
      </div>
    </div>

    ${inviteHero}

    ${renderTeamPreview()}

    <div class="app-section team-pre-show">
      <div class="team-section-eyebrow tone-purple">Team intel</div>
      <h3 class="team-section-title team-section-title-xl">Your team's onboarding answers.</h3>
      <p class="team-section-lede">What each teammate said about their pains and software.</p>
      <p class="team-section-benefit">Most firms learn this in the cab home. <em>You'll have it before you arrive.</em></p>
      <div class="team-section-count-row">
        <span class="team-section-count-label">${memberCount} of ${MAX_TEAM_MEMBERS} members</span>
      </div>
      <div class="teammate-grid">
        ${_teamData.members.map((m, i) => renderTeammateCard(m, i)).join('')}
        ${placeholderCard}
      </div>
    </div>
  `;
}

// ── CPD stub ──────────────────────────────────────────────────────────────────

function renderCpdTab() {
  const sessions = _plan?.sessions || [];
  // CPD shows the full hours from the user's plan from the start —
  // they shouldn't have to "earn" their own CPD by ticking sessions
  // off; that's not our call to police.
  const cpdHours = (sessions.length * 40 / 60).toFixed(1);
  const isTeam   = !!(_plan?.team_id);
  return `
    <div class="app-header">
      <h2 class="app-title">CPD <em>log.</em></h2>
      <p class="app-sub">Your continuing professional development hours, tracked as you go.</p>
      ${inviteNudgeHtml('cpd', isTeam)}
    </div>
    <div style="padding:32px 0;text-align:center;color:var(--text-muted);">
      <div style="font-family:'Fraunces',serif;font-size:56px;font-weight:500;color:var(--mint);">${cpdHours}</div>
      <div style="font-family:'JetBrains Mono',monospace;font-size:11px;letter-spacing:.14em;text-transform:uppercase;margin-top:4px;">CPD hours logged</div>
      <p style="margin-top:20px;font-size:14px;">Mark sessions as attended on the Checklist tab to add hours here.</p>
    </div>
  `;
}

// ── Debrief helpers ───────────────────────────────────────────────────────────

function _allNotesNow() {
  return _teamData ? (_teamData.allNotes || []) : (_plan?.notes || []);
}

function buildHeatRanked() {
  const teamPlans = _teamData?.teamPlans || [];
  const allPlans  = teamPlans.length ? teamPlans : [_plan].filter(Boolean);

  const scoreMap      = {};
  const sessionMetaMap = {};

  // Current user's plan takes priority for session metadata
  for (const s of (_plan?.sessions || [])) {
    sessionMetaMap[String(s.session_id)] = s;
  }

  for (const p of allPlans) {
    for (const s of (p.sessions || [])) {
      const key = String(s.session_id);
      if (!sessionMetaMap[key]) sessionMetaMap[key] = s;
      if (!s.rating) continue;
      if (!scoreMap[key]) scoreMap[key] = { total: 0, count: 0 };
      scoreMap[key].total += s.rating;
      scoreMap[key].count += 1;
    }
  }

  return Object.keys(scoreMap)
    .map(key => ({
      session:    sessionMetaMap[key],
      avgRating:  scoreMap[key].total / scoreMap[key].count,
      raterCount: scoreMap[key].count,
    }))
    .sort((a, b) => b.avgRating - a.avgRating);
}

function buildBoothHeatRanked() {
  const teamPlans = _teamData?.teamPlans || [];
  const allPlans  = teamPlans.length ? teamPlans : [_plan].filter(Boolean);

  const scoreMap    = {};
  const boothMetaMap = {};

  // Current user's plan takes priority for booth metadata
  for (const b of (_plan?.booths || [])) {
    boothMetaMap[String(b.stand_number)] = b;
  }

  for (const p of allPlans) {
    for (const b of (p.booths || [])) {
      const key = String(b.stand_number);
      if (!boothMetaMap[key]) boothMetaMap[key] = b;
      if (!b.rating) continue;
      if (!scoreMap[key]) scoreMap[key] = { total: 0, count: 0 };
      scoreMap[key].total += b.rating;
      scoreMap[key].count += 1;
    }
  }

  return Object.keys(scoreMap)
    .map(key => ({
      booth:      boothMetaMap[key],
      avgRating:  scoreMap[key].total / scoreMap[key].count,
      raterCount: scoreMap[key].count,
    }))
    .sort((a, b) => b.avgRating - a.avgRating);
}

function buildSummaryText() {
  const firstName = _userProfile?.first_name || '';
  const lastName  = _userProfile?.last_name  || '';
  const company   = _userProfile?.company    || '';
  const name      = [firstName, lastName].filter(Boolean).join(' ');

  const allNotes = _allNotesNow();
  const members  = _teamData?.members || [];

  function authorName(createdBy) {
    if (!createdBy) return null;
    const m = members.find(m => m.users?.id === createdBy);
    return m ? m.users.first_name : null;
  }

  const heatRanked      = buildHeatRanked();
  const boothHeatRanked = buildBoothHeatRanked();

  // Build note maps so we can include sessions/booths that have notes even if
  // they aren't in the rated hot list — summary covers all activity
  const sessionNoteMap = {}; // session_id → notes[]
  const boothNoteMap   = {}; // stand_number → notes[]
  for (const n of allNotes) {
    if (!n.note_text?.trim()) continue;
    if (n.item_type === 'session') {
      const k = String(n.item_id);
      if (!sessionNoteMap[k]) sessionNoteMap[k] = [];
      sessionNoteMap[k].push(n);
    } else if (n.item_type === 'booth') {
      const k = String(n.item_id);
      if (!boothNoteMap[k]) boothNoteMap[k] = [];
      boothNoteMap[k].push(n);
    }
  }

  const lines = [];
  lines.push(`ACCOUNTEX 2026 — DEBRIEF`);
  if (name || company) lines.push(`From: ${[name, company].filter(Boolean).join(' · ')}`);
  lines.push('');

  if (_plan?.problem) {
    lines.push('YOUR MISSION');
    lines.push(_plan.problem);
    lines.push('');
  }

  // Sessions: rated ones first (from heatRanked, covers all team plans),
  // then any noted-but-unrated sessions from any team plan
  const teamPlansForSummary = _teamData?.teamPlans?.length ? _teamData.teamPlans : [_plan].filter(Boolean);
  const allTeamSessionsMap  = {};
  for (const p of teamPlansForSummary) {
    for (const s of (p.sessions || [])) {
      if (!allTeamSessionsMap[String(s.session_id)]) allTeamSessionsMap[String(s.session_id)] = s;
    }
  }
  // Current user's versions take priority for metadata
  for (const s of (_plan?.sessions || [])) {
    allTeamSessionsMap[String(s.session_id)] = s;
  }
  const ratedSessionIds = new Set(heatRanked.map(h => String(h.session.session_id)));
  const allSessionItems = [
    ...heatRanked.map(h => ({ session: h.session, avgRating: h.avgRating })),
    ...Object.values(allTeamSessionsMap)
      .filter(s => !ratedSessionIds.has(String(s.session_id)) && sessionNoteMap[String(s.session_id)])
      .map(s => ({ session: s, avgRating: 0 })),
  ];

  if (allSessionItems.length) {
    lines.push('TOP SESSIONS');
    lines.push('');
    for (const { session: s, avgRating } of allSessionItems) {
      const flames = avgRating > 0 ? '🔥'.repeat(Math.round(avgRating)) : '';
      lines.push(`${flames ? flames + ' ' : ''}${s.title}`);
      lines.push(`   ${s.theatre ? s.theatre + ' · ' : ''}${s.day || '?'}${s.start_time ? ' · ' + s.start_time : ''}`);
      for (const n of (sessionNoteMap[String(s.session_id)] || [])) {
        const who = authorName(n.created_by);
        lines.push(`   "${n.note_text}"${who ? ' — ' + who : ''}`);
      }
      lines.push('');
    }
  }

  // Booths: rated ones first (already covers all team plans via buildBoothHeatRanked),
  // then noted-but-unrated booths from any team plan
  const ratedBoothIds = new Set(boothHeatRanked.map(h => String(h.booth.stand_number)));
  const allTeamPlans  = (_teamData?.teamPlans?.length ? _teamData.teamPlans : [_plan].filter(Boolean));
  const seenBoothIds  = new Set(ratedBoothIds);
  const notedUnratedBooths = [];
  for (const p of allTeamPlans) {
    for (const b of (p.booths || [])) {
      const key = String(b.stand_number);
      if (!seenBoothIds.has(key) && boothNoteMap[key]) {
        seenBoothIds.add(key);
        notedUnratedBooths.push(b);
      }
    }
  }
  const allBoothItems = [
    ...boothHeatRanked.map(h => ({ booth: h.booth, avgRating: h.avgRating })),
    ...notedUnratedBooths.map(b => ({ booth: b, avgRating: 0 })),
  ];

  if (allBoothItems.length) {
    lines.push('VENDORS TO FOLLOW UP');
    lines.push('');
    for (const { booth: b, avgRating } of allBoothItems) {
      const flames = avgRating > 0 ? '🔥'.repeat(Math.round(avgRating)) : '';
      lines.push(`${flames ? flames + ' ' : ''}${b.company_name} (Stand ${b.stand_number})`);
      for (const n of (boothNoteMap[String(b.stand_number)] || [])) {
        const who = authorName(n.created_by);
        lines.push(`   "${n.note_text}"${who ? ' — ' + who : ''}`);
      }
      lines.push('');
    }
  }

  if (!allSessionItems.length && !allBoothItems.length) {
    lines.push('Rate sessions and vendors on the Checklist tab — your summary will build up here.');
    lines.push('');
  }

  return lines.join('\n');
}

// ── Debrief tab ───────────────────────────────────────────────────────────────

function renderDebriefTab() {
  const firstName   = _userProfile?.first_name || '';
  const lastName    = _userProfile?.last_name  || '';
  const company     = _userProfile?.company    || '';
  const displayName = [firstName, lastName].filter(Boolean).join(' ') || (_authUser?.email || 'You');
  const fromLine    = [displayName, company].filter(Boolean).join(' · ');

  const summaryText     = buildSummaryText();
  const heatRanked      = buildHeatRanked();
  const boothHeatRanked = buildBoothHeatRanked();

  const allNotes = _allNotesNow();
  const members  = _teamData?.members || [];

  function memberFor(createdBy) {
    return members.find(m => m.users?.id === createdBy);
  }

  function notesFor(itemType, itemId) {
    const id = String(itemId);
    return allNotes.filter(n => n.item_type === itemType && String(n.item_id) === id && n.note_text?.trim());
  }

  function initials(u) {
    return `${u?.first_name?.[0] || ''}${u?.last_name?.[0] || ''}`.toUpperCase() || '?';
  }

  function renderDebriefFlames(avg) {
    const rounded = Math.round(avg);
    return [1, 2, 3].map(n =>
      `<span class="flame-btn ${n <= rounded ? 'lit' : ''}" style="pointer-events:none;">${flameSvg()}</span>`
    ).join('');
  }

  function renderHotCard(rank, title, meta, avgRating, raterCount, itemType, itemId) {
    const notes = notesFor(itemType, itemId);
    const noteHtml = notes.length ? `
      <div class="debrief-hot-notes">
        ${notes.map(n => {
          const m    = memberFor(n.created_by);
          const u    = m?.users;
          const name = u?.first_name ? `${u.first_name} ${u.last_name || ''}`.trim() : 'Teammate';
          const ini  = initials(u);
          return `
            <div class="debrief-hot-note">
              <div class="mini-av" style="flex-shrink:0;">${escHtml(ini)}</div>
              <div class="debrief-hot-note-body">
                <div class="debrief-hot-note-head"><strong>${escHtml(name)}</strong></div>
                <div class="debrief-hot-note-text">${escHtml(n.note_text)}</div>
              </div>
            </div>`;
        }).join('')}
      </div>` : '';
    return `
      <div class="debrief-hot-card">
        <div class="debrief-hot-card-head">
          <div class="debrief-hot-rank">#${rank}</div>
          <div class="debrief-hot-main">
            <div class="debrief-hot-title">${escHtml(title)}</div>
            <div class="debrief-hot-meta">${escHtml(meta)}</div>
          </div>
          <div class="debrief-hot-rating">
            ${raterCount > 0 ? renderDebriefFlames(avgRating) : ''}
            <div class="debrief-hot-count">${raterCount > 0 ? `${raterCount} rated` : `${notes.length} note${notes.length !== 1 ? 's' : ''}`}</div>
          </div>
        </div>
        ${noteHtml}
      </div>`;
  }

  const sessionCards = heatRanked.map(({ session: s, avgRating, raterCount }, i) => {
    const meta = [
      s.day || '',
      s.theatre || '',
      s.start_time || '',
    ].filter(Boolean).join(' · ');
    return renderHotCard(i + 1, s.title, meta, avgRating, raterCount, 'session', s.session_id);
  }).join('');

  const boothCards = boothHeatRanked.map(({ booth: b, avgRating, raterCount }, i) => {
    const meta = `Stand ${b.stand_number}`;
    return renderHotCard(i + 1, b.company_name, meta, avgRating, raterCount, 'booth', b.stand_number);
  }).join('');

  const isTeam = !!(_plan?.team_id);
  return `
    ${inviteNudgeHtml('debrief', isTeam)}
    <div class="app-section">
      <div class="team-section-eyebrow tone-pink">The summary</div>
      <h3 class="team-section-title">Your Accountex, <em>distilled.</em></h3>
      <p class="team-section-lede">Action items first. Copy, email, or save as PDF.</p>
      <div class="email-draft">
        <div class="email-draft-header">
          <div class="email-draft-row">
            <div class="email-draft-label">From</div>
            <div class="email-draft-value">${escHtml(fromLine)}</div>
          </div>
          <div class="email-draft-row">
            <div class="email-draft-label">For</div>
            <div class="email-draft-value">Share with partners, the team, or keep for yourself</div>
          </div>
        </div>
        <textarea class="email-draft-body" id="debrief-textarea" spellcheck="false">${escHtml(summaryText)}</textarea>
      </div>
      <div class="debrief-actions">
        <button class="debrief-btn secondary" onclick="planCopyDebrief(this)">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>
          Copy to clipboard
        </button>
        <button class="debrief-btn secondary" onclick="planEmailDebrief()">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M22 2 11 13M22 2l-7 20-4-9-9-4 20-7z"/></svg>
          Email this
        </button>
        <button class="debrief-btn primary" onclick="planDownloadDebrief()">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>
          Download as PDF
        </button>
      </div>
    </div>

    <div class="app-section">
      <div class="team-section-eyebrow tone-pink">
        ${flameSvg()}
        Hot sessions
      </div>
      <h3 class="team-section-title">Top-rated <em>by you and your team.</em></h3>
      ${heatRanked.length
        ? `<div class="debrief-hot-list">${sessionCards}</div>`
        : `<div class="debrief-empty">Sessions appear here once you rate them during the show.</div>`}
    </div>

    <div class="app-section">
      <div class="team-section-eyebrow tone-pink">
        ${flameSvg()}
        Hot booths
      </div>
      <h3 class="team-section-title">Vendors <em>worth a follow-up.</em></h3>
      ${boothHeatRanked.length
        ? `<div class="debrief-hot-list">${boothCards}</div>`
        : `<div class="debrief-empty">Booths appear here once you rate them during the show.</div>`}
    </div>

  `;
}

// ── Plan editor overlay ───────────────────────────────────────────────────────

function _ensurePlanEditorOverlay() {
  if (document.getElementById('planEditorOverlay')) return;
  const wrap = document.createElement('div');
  wrap.innerHTML = `
    <div class="search-overlay plan-editor-overlay" id="planEditorOverlay">
      <div class="search-overlay-inner" style="max-width:980px;">
        <div class="search-overlay-header">
          <div>
            <h2 class="search-overlay-title" id="planEditorTitle">Edit <em>your schedule</em></h2>
            <div class="plan-editor-sub" id="planEditorSub"></div>
          </div>
          <button class="search-close" onclick="closePlanEditor()" aria-label="Close editor">
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
          </button>
        </div>
        <div class="plan-editor-filters" id="planEditorFilters"></div>
        <div class="search-input-wrap" style="margin-top:14px;">
          <svg class="search-input-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg>
          <input type="text" class="search-input" id="planEditorSearch" maxlength="100"
            placeholder="Search by title, speaker, stand…" oninput="planEditorOnSearch(this.value)">
        </div>
        <div class="plan-editor-results" id="planEditorResults"></div>
      </div>
    </div>`;
  const overlay = wrap.firstElementChild;
  document.body.appendChild(overlay);

  // The floating bar must live OUTSIDE the overlay — the overlay has
  // backdrop-filter, which creates a new containing block and breaks
  // position: fixed for descendants. Sibling-of-body keeps it pinned
  // to the viewport.
  const bar = document.createElement('div');
  bar.id = 'planEditorFloatingBar';
  bar.className = 'plan-editor-floating-bar';
  bar.innerHTML = `
    <button class="plan-editor-floating-btn" onclick="planEditorScrollTop()" type="button">
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><line x1="12" y1="19" x2="12" y2="5"/><polyline points="5 12 12 5 19 12"/></svg>
      Back to top
    </button>
    <button class="plan-editor-floating-btn" onclick="closePlanEditor()" type="button">
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
      Close
    </button>`;
  document.body.appendChild(bar);

  // Show the bar once the editor has scrolled past 480px. The overlay is
  // the scroll container (overflow-y: auto). Reveal class lives on the
  // bar itself so closePlanEditor can hide it cleanly without coupling
  // to overlay state.
  overlay.addEventListener('scroll', () => {
    if (overlay.classList.contains('open')) {
      bar.classList.toggle('visible', overlay.scrollTop > 480);
    }
  }, { passive: true });
}

window.planEditorScrollTop = function() {
  const overlay = document.getElementById('planEditorOverlay');
  if (overlay) overlay.scrollTo({ top: 0, behavior: 'smooth' });
};

let _planEditorEscHandler = null;

window.openPlanEditor = function(mode) {
  _ensurePlanEditorOverlay();
  _planEditorMode       = mode;
  _planEditorQuery      = '';
  _planEditorDay        = 'all';
  _planEditorTime       = 'all';
  _planEditorCategories = new Set(_plan?.categories || []);
  _planEditorShowMore   = false;

  const overlay = document.getElementById('planEditorOverlay');
  const title   = document.getElementById('planEditorTitle');
  const sub     = document.getElementById('planEditorSub');
  const search  = document.getElementById('planEditorSearch');

  if (mode === 'sessions') {
    title.innerHTML = 'Edit <em>your sessions</em>';
    sub.textContent = `${(_plan?.sessions || []).length} in your plan · ${(_allSessions || []).length} available`;
  } else {
    title.innerHTML = 'Edit <em>your booths</em>';
    sub.textContent = `${(_plan?.booths || []).length} in your plan · ${(_allExhibitors || []).length} available`;
  }
  if (search) search.value = '';

  // Drives the booth-purple theme (vs the default mint for sessions) via
  // CSS .plan-editor-overlay[data-mode="booths"] selectors.
  overlay.dataset.mode = mode;
  overlay.classList.add('open');
  // Reset scroll on reopen so the floating bar doesn't flash visible
  // from a previous session, and the user starts at the filters again.
  overlay.scrollTop = 0;
  const bar = document.getElementById('planEditorFloatingBar');
  if (bar) bar.classList.remove('visible');
  document.documentElement.style.overflow = 'hidden';
  document.body.style.overflow = 'hidden';

  renderPlanEditorFilters();
  renderPlanEditorResults();

  _planEditorEscHandler = e => { if (e.key === 'Escape') closePlanEditor(); };
  document.addEventListener('keydown', _planEditorEscHandler);
};

window.openPlanEditorWithProblem = function(cat) {
  _ensurePlanEditorOverlay();
  _planEditorMode       = 'sessions';
  _planEditorQuery      = '';
  _planEditorDay        = 'all';
  _planEditorTime       = 'all';
  _planEditorCategories = new Set([cat]);
  _planEditorShowMore   = false;

  const overlay = document.getElementById('planEditorOverlay');
  const title   = document.getElementById('planEditorTitle');
  const sub     = document.getElementById('planEditorSub');
  const search  = document.getElementById('planEditorSearch');

  title.innerHTML = 'Edit <em>your sessions</em>';
  sub.textContent = `${(_plan?.sessions || []).length} in your plan · ${(_allSessions || []).length} available`;
  if (search) search.value = '';

  overlay.dataset.mode = 'sessions';
  overlay.classList.add('open');
  document.documentElement.style.overflow = 'hidden';
  document.body.style.overflow = 'hidden';

  renderPlanEditorFilters();
  renderPlanEditorResults();

  _planEditorEscHandler = e => { if (e.key === 'Escape') closePlanEditor(); };
  document.addEventListener('keydown', _planEditorEscHandler);
};

window.closePlanEditor = function() {
  const overlay = document.getElementById('planEditorOverlay');
  if (overlay) overlay.classList.remove('open');
  const bar = document.getElementById('planEditorFloatingBar');
  if (bar) bar.classList.remove('visible');
  document.documentElement.style.overflow = '';
  document.body.style.overflow = '';
  window.scrollTo({ top: 0, behavior: 'instant' });
  _planEditorMode = null;
  if (_planEditorEscHandler) {
    document.removeEventListener('keydown', _planEditorEscHandler);
    _planEditorEscHandler = null;
  }
  renderApp();
};

window.planEditorOnSearch = function(value) {
  _planEditorQuery = value;
  renderPlanEditorResults();
};

window.setPlanEditorFilter = function(type, value) {
  if (type === 'day')  _planEditorDay  = value;
  if (type === 'time') _planEditorTime = value;
  if (type === 'category') {
    if (_planEditorCategories.has(value)) _planEditorCategories.delete(value);
    else _planEditorCategories.add(value);
  }
  renderPlanEditorFilters();
  renderPlanEditorResults();
};

window.clearPlanEditorCategories = function() {
  _planEditorCategories.clear();
  renderPlanEditorFilters();
  renderPlanEditorResults();
};

const _EDITOR_CATEGORY_LABELS = {
  'practice-management': 'Practice Management',
  'ai-automation':       'AI & Automation',
  'bookkeeping':         'Bookkeeping',
  'tax-mtd':             'Tax & MTD',
  'doc-management':      'Document Management',
  'payroll':             'Payroll',
  'data-analytics':      'Data & Analytics',
  'cyber-security':      'Cyber Security',
  'aml-kyc':             'AML / KYC',
  'hr-people':           'HR & Leadership',
  'banking-payments':    'Banking & Payments',
  'outsourcing':         'Outsourcing',
  'marketing-growth':    'Marketing & Growth',
  'other':               'Other / Uncategorised',
};

function renderPlanEditorFilters() {
  const el = document.getElementById('planEditorFilters');
  if (!el) return;

  const userCats   = _plan?.categories || [];
  const unpicked   = Object.keys(_EDITOR_CATEGORY_LABELS).filter(c => !userCats.includes(c));
  const userPains  = (_plan?.problem || '').split(/\s*,\s*/).filter(Boolean);

  // Locked context — readonly mint chips of the user's pains AND tools
  // they picked at onboarding. Shows what's filtering this list without
  // making it editable on this surface (clear single-purpose UI).
  const contextChips = [
    ...userPains.map(label => `<span class="editor-context-chip">${escHtml(label)}</span>`),
    ...userCats.map(c => `<span class="editor-context-chip">${escHtml(_EDITOR_CATEGORY_LABELS[c] || c)}</span>`),
  ].join('');

  let html = '';

  if (contextChips) {
    html += `<div class="editor-filter-row">
      <span class="editor-filter-label">Filtered to your context</span>
      <div class="editor-context-chips">${contextChips}</div>
    </div>`;
  }

  if (_planEditorMode === 'sessions') {
    html += `
    <div class="editor-filter-row">
      <span class="editor-filter-label">Day</span>
      <div class="editor-filter-pills">
        ${[['all','All days'],['Day 1','Day 1'],['Day 2','Day 2']].map(([v,l]) => `
          <button class="editor-filter-pill${_planEditorDay === v ? ' active' : ''}"
            onclick="setPlanEditorFilter('day','${v}')" type="button">${l}</button>`).join('')}
      </div>
    </div>
    <div class="editor-filter-row">
      <span class="editor-filter-label">Time</span>
      <div class="editor-filter-pills">
        ${[['all','All day'],['morning','Morning'],['afternoon','Afternoon']].map(([v,l]) => `
          <button class="editor-filter-pill${_planEditorTime === v ? ' active' : ''}"
            onclick="setPlanEditorFilter('time','${v}')" type="button">${l}</button>`).join('')}
      </div>
    </div>`;
  }

  // Refine link — opens the deeper category filter panel. Only render
  // when there are unpicked categories to surface (always true unless
  // user picked every one at onboarding).
  if (unpicked.length) {
    const activeAdditional = [..._planEditorCategories].filter(c => !userCats.includes(c));
    const refineLabel = _planEditorShowMore
      ? 'Hide category filters ↑'
      : `Refine with category filters →${activeAdditional.length ? ` <span class="editor-filter-refine-count">${activeAdditional.length}</span>` : ''}`;
    html += `<button class="editor-filter-refine" onclick="togglePlanEditorMoreFilters()" type="button">${refineLabel}</button>`;
    if (_planEditorShowMore) {
      const moreChips = unpicked.map(c => {
        const on = _planEditorCategories.has(c);
        return `<button class="editor-filter-pill${on ? ' active' : ''}"
          onclick="setPlanEditorFilter('category','${escHtml(c)}')" type="button">${escHtml(_EDITOR_CATEGORY_LABELS[c] || c)}</button>`;
      }).join('');
      html += `<div class="editor-filter-row editor-filter-refine-panel">
        <div class="editor-filter-pills">${moreChips}</div>
        ${activeAdditional.length ? `<button class="editor-filter-clear" onclick="clearPlanEditorCategories()" type="button">Clear</button>` : ''}
      </div>`;
    }
  }

  el.innerHTML = html;
}

window.togglePlanEditorMoreFilters = function() {
  _planEditorShowMore = !_planEditorShowMore;
  renderPlanEditorFilters();
};

function renderPlanEditorResults() {
  const el = document.getElementById('planEditorResults');
  if (!el) return;
  if (_planEditorMode === 'sessions') renderPlanEditorSessions(el);
  else if (_planEditorMode === 'booths') renderPlanEditorBooths(el);
}

function _updateEditorSub(filteredCount, total) {
  const sub = document.getElementById('planEditorSub');
  if (!sub) return;
  const planCount = _planEditorMode === 'sessions'
    ? (_plan?.sessions || []).length
    : (_plan?.booths || []).length;
  const countText = filteredCount < total
    ? `${filteredCount} of ${total} shown`
    : `${total} available`;
  sub.textContent = `${planCount} in your plan · ${countText}`;
}

function renderPlanEditorSessions(container) {
  const q         = (_planEditorQuery || '').toLowerCase();
  const planIds   = new Set((_plan?.sessions || []).map(s => `${s.session_id}|${s.day || ''}|${s.start_time || ''}`));
  const wantOther  = _planEditorCategories.has('other');
  const wantedCats = [..._planEditorCategories].filter(c => c !== 'other').length > 0
    ? new Set([..._planEditorCategories].filter(c => c !== 'other').flatMap(c => PLAN_CATEGORY_MATCH[c] || []))
    : null;

  const filtered = (_allSessions || []).filter(s => {
    if (_planEditorDay !== 'all' && s.day !== _planEditorDay) return false;
    if (_planEditorTime !== 'all') {
      const mins = parseTimeToMinutes(s.start_time);
      if (_planEditorTime === 'morning'   && mins >= 13 * 60) return false;
      if (_planEditorTime === 'afternoon' && mins <  13 * 60) return false;
    }
    if (wantedCats || wantOther) {
      const hasCats    = (s.canonical_categories || []).length > 0;
      const matchesCat = wantedCats && (s.canonical_categories || []).some(c => wantedCats.has(c));
      const matchesOther = wantOther && !hasCats;
      if (!matchesCat && !matchesOther) return false;
    }
    if (q) {
      const speakers = (s.speakers || []).map(sp => `${sp.name || ''} ${sp.company || ''}`).join(' ');
      const hay = `${s.title || ''} ${s.theatre || ''} ${s.description || ''} ${speakers}`.toLowerCase();
      if (!hay.includes(q)) return false;
    }
    return true;
  });

  _updateEditorSub(filtered.length, (_allSessions || []).length);

  const slots = new Map();
  for (const s of filtered) {
    const key = `${s.day}||${s.start_time}`;
    if (!slots.has(key)) slots.set(key, []);
    slots.get(key).push(s);
  }

  if (!slots.size) {
    container.innerHTML = '<div class="search-empty">No sessions match your filters.</div>';
    return;
  }

  const sortedKeys = [...slots.keys()].sort((a, b) => {
    const [da, ta] = a.split('||');
    const [db, tb] = b.split('||');
    return (da === 'Day 1' ? 1 : 2) - (db === 'Day 1' ? 1 : 2) || (ta || '').localeCompare(tb || '');
  });

  let html = '';
  let lastDay = null;
  // TODO: investigate duplicate sessions appearing in the editor list
  // (e.g. "AI for bookkeepers", "Surviving Hospitality") — could be
  // upstream data dupes in _allSessions or a render edge case.
  for (const key of sortedKeys) {
    const sessions = slots.get(key);
    const [day, time] = key.split('||');
    if (day !== lastDay) {
      lastDay = day;
      const dayName = day === 'Day 1' ? 'Wednesday 13 May' : 'Thursday 14 May';
      html += `<div class="editor-day-divider">
        <span class="editor-day-divider-num">${day}</span>
        <span class="editor-day-divider-name">${dayName}</span>
        <span class="editor-day-divider-line"></span>
      </div>`;
    }
    // Sort sessions within a start-time group by ranking ascending —
    // top match shows first. Compute match once per session, reuse below.
    const enriched = sessions.map(s => ({ s, m: matchForSession(s) }));
    enriched.sort((a, b) => a.m.rank - b.m.rank);
    const slotPlanCount = enriched.filter(({ s }) => planIds.has(`${s.session_id}|${s.day || ''}|${s.start_time || ''}`)).length;
    const hasClash = slotPlanCount >= 2;
    html += `<div class="editor-slot${hasClash ? ' has-clash' : ''}">
      <div class="editor-slot-head">
        <div class="editor-slot-time">${escHtml(time || '')}</div>
        ${hasClash ? `<div class="editor-clash-warning">${slotPlanCount} sessions selected at this time</div>` : ''}
      </div>
      <div class="editor-slot-rows">`;
    for (const { s, m } of enriched) {
      const inPlan  = planIds.has(`${s.session_id}|${s.day || ''}|${s.start_time || ''}`);
      const speaker = (s.speakers || [])[0];
      const metaParts = [
        s.theatre ? `<span>${escHtml(s.theatre)}</span>` : '',
        speaker ? `<span class="editor-row-speaker">${escHtml(speaker.name || '')}${speaker.company ? ' · ' + escHtml(speaker.company) : ''}</span>` : '',
      ].filter(Boolean).join('');
      const blurb = s.description ? truncateBoothDesc(s.description) : '';
      html += `
        <div class="editor-row${inPlan ? ' in-plan' : ''}">
          <div class="editor-row-main">
            <div class="editor-row-title">${escHtml(s.title || s.session_id)}</div>
            <div class="editor-row-meta">${metaParts}</div>
            ${blurb ? `<div class="editor-row-blurb">${escHtml(blurb)}</div>` : ''}
            ${renderMatchBadge({ bucket: m.bucket, rank: m.rank, type: 'session', compact: true })}
          </div>
          <button class="editor-row-toggle ${inPlan ? 'in' : 'out'}"
            onclick="togglePlanSession('${escHtml(String(s.session_id))}','${escHtml(s.day||'')}','${escHtml(s.start_time||'')}')" type="button">
            ${inPlan
              ? `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg> In your plan`
              : `+ Add`}
          </button>
        </div>`;
    }
    html += '</div></div>';
  }
  container.innerHTML = html;
}

function renderPlanEditorBooths(container) {
  const q        = (_planEditorQuery || '').toLowerCase();
  const planNums = new Set((_plan?.booths || []).map(b => b.stand_number));
  const planCats = _plan?.categories || [];

  const wantOther  = _planEditorCategories.has('other');
  const wantedCats = [..._planEditorCategories].filter(c => c !== 'other').length > 0
    ? new Set([..._planEditorCategories].filter(c => c !== 'other').flatMap(c => PLAN_CATEGORY_MATCH[c] || []))
    : null;

  const filtered = (_allExhibitors || []).filter(e => {
    if (wantedCats || wantOther) {
      const hasCats      = (e.canonical_categories || []).length > 0;
      const matchesCat   = wantedCats && (e.canonical_categories || []).some(c => wantedCats.has(c));
      const matchesOther = wantOther && !hasCats;
      if (!matchesCat && !matchesOther) return false;
    }
    if (q) {
      const hay = [
        e.company_name || '',
        e.company_description || '',
        (e.canonical_categories || []).map(c => _EDITOR_CATEGORY_LABELS[c] || c).join(' '),
        e.stand_number || '',
      ].join(' ').toLowerCase();
      if (!hay.includes(q)) return false;
    }
    return true;
  }).sort((a, b) => (a.company_name || '').localeCompare(b.company_name || ''));

  _updateEditorSub(filtered.length, (_allExhibitors || []).length);

  if (!filtered.length) {
    container.innerHTML = '<div class="search-empty">No exhibitors match those filters. Try clearing one.</div>';
    return;
  }

  // In-plan booths pin to top; out-of-plan sort by rank ascending.
  const planBoothRankIndex = new Map();
  (_plan?.booths || []).forEach((b, idx) => planBoothRankIndex.set(b.stand_number, idx + 1));

  const enriched = filtered.map(e => {
    const inPlan = planNums.has(e.stand_number);
    const m = matchForBooth(e, inPlan ? planBoothRankIndex.get(e.stand_number) : null);
    return { e, inPlan, m };
  });
  enriched.sort((a, b) => {
    if (a.inPlan !== b.inPlan) return a.inPlan ? -1 : 1;
    return a.m.rank - b.m.rank;
  });

  const rows = enriched.map(({ e, inPlan, m }) => {
    const blurb = e.company_description ? truncateBoothDesc(e.company_description) : '';
    return `
      <div class="editor-row${inPlan ? ' in-plan' : ''}">
        <div class="editor-row-main">
          <div class="editor-row-title">${escHtml(e.company_name || '')}</div>
          <div class="editor-row-meta">Booth · Stand ${escHtml(String(e.stand_number || ''))}</div>
          ${blurb ? `<div class="editor-row-blurb">${escHtml(blurb)}</div>` : ''}
          ${renderMatchBadge({ bucket: m.bucket, rank: m.rank, type: 'booth', compact: true })}
        </div>
        <button class="editor-row-toggle ${inPlan ? 'in' : 'out'}"
          onclick="togglePlanBooth('${escHtml(String(e.stand_number))}')" type="button">
          ${inPlan
            ? `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg> In your plan`
            : `+ Add`}
        </button>
      </div>`;
  }).join('');

  container.innerHTML = `<div class="editor-booth-list">${rows}</div>`;
}

window.togglePlanSession = async function(sessionId, day, startTime) {
  const match = s => String(s.session_id) === String(sessionId) && s.day === day && s.start_time === startTime;
  const inPlan = (_plan.sessions || []).some(match);
  if (inPlan) {
    _plan.sessions = (_plan.sessions || []).filter(s => !match(s));
  } else {
    const full = (_allSessions || []).find(match);
    if (full) _plan.sessions = [...(_plan.sessions || []), full];
  }
  renderPlanEditorResults();
  await supabase.from('plans').update({ sessions: _plan.sessions }).eq('id', _plan.id);
  renderApp();
};

window.togglePlanBooth = async function(standNumber) {
  const inPlan = (_plan.booths || []).some(b => String(b.stand_number) === String(standNumber));
  if (inPlan) {
    _plan.booths = (_plan.booths || []).filter(b => String(b.stand_number) !== String(standNumber));
  } else {
    const full = (_allExhibitors || []).find(e => String(e.stand_number) === String(standNumber));
    if (full) _plan.booths = [...(_plan.booths || []), full];
  }
  renderPlanEditorResults();
  await supabase.from('plans').update({ booths: _plan.booths }).eq('id', _plan.id);
  renderApp();
};

// ── Sponsors footer ───────────────────────────────────────────────────────────

// Per-sponsor "pains we solve" mapping. Pain labels match the
// humanised strings stored in plan.problem (PAIN_LABELS in wizard.js).
// Category slugs match plan.categories. If a user's onboarding has
// nothing in common with a sponsor, the pains-we-solve block is hidden
// for that card — we don't fake relevance.
const SPONSOR_SOLVES = {
  workiro: {
    name: 'Workiro',
    painLabels: [
      'Document chaos', 'Audit-ready client files', 'Portal adoption / clients hate it',
      'AML / KYC pressure', 'Chasing clients for records', 'Cyber threats / phishing',
      'FRS 102 transition', 'Disconnected tech stack',
    ],
    categories: [
      'doc-mgmt', 'doc-management', 'portals-esign', 'aml-onboarding', 'practice-mgmt',
      'practice-management', 'cyber', 'cyber-security',
    ],
  },
  xu: {
    name: 'XU Magazine',
    painLabels: [
      'AI — where to even start', 'Data mess blocking AI', 'AI — proving the ROI',
      'AI — team adoption', 'AI skills gap', 'AI governance & risk',
      'Disconnected tech stack', 'Stuck in compliance',
    ],
    categories: [
      'cloud-accounting', 'ai-automation', 'practice-mgmt', 'practice-management',
      'tax-mtd', 'forecasting', 'reporting', 'data-analytics',
    ],
  },
};
function _matchSponsorRelevance(sponsorKey, plan) {
  const sp = SPONSOR_SOLVES[sponsorKey];
  if (!sp || !plan) return { pains: [], cats: [] };
  const userPains = (plan.problem || '').split(/,\s*/).map(s => s.trim()).filter(Boolean);
  const userCats  = plan.categories || [];
  const lc = (s) => s.toLowerCase();
  const matchedPains = userPains.filter(p =>
    sp.painLabels.some(want => lc(want) === lc(p))
  );
  const matchedCats = userCats.filter(c => sp.categories.includes(c));
  return { pains: matchedPains, cats: matchedCats };
}

// "Also felt by" — for a given sponsor, lists OTHER teammates whose
// onboarding answers also overlap with the sponsor's solve list.
// Only computed when the team has 2+ members. Returns user objects
// from _teamData.members so we can render avatar + first name.
function _sponsorFeltBy(sponsorKey) {
  if (!_teamData) return [];
  if ((_teamData.members?.length ?? 0) < 2) return [];
  const sp = SPONSOR_SOLVES[sponsorKey];
  if (!sp) return [];
  const lc = (s) => (s || '').toLowerCase();
  const wantPains = new Set(sp.painLabels.map(lc));
  const wantCats  = new Set(sp.categories);
  const out = [];
  for (const tp of (_teamData.teamPlans || [])) {
    if (tp.user_id === _authUser?.id) continue;
    const member = _teamData.members.find(m => m.users?.id === tp.user_id);
    if (!member?.users) continue;
    const tpPains = (tp.problem || '').split(/,\s*/).map(s => s.trim()).filter(Boolean);
    const overlap = tpPains.some(p => wantPains.has(lc(p)))
                 || (tp.categories || []).some(c => wantCats.has(c));
    if (overlap) out.push(member.users);
  }
  return out;
}

function _renderSponsorPainsBlock(sponsorKey, plan) {
  const { pains, cats } = _matchSponsorRelevance(sponsorKey, plan);
  if (!pains.length && !cats.length) return '';
  const painPills = pains.map(p =>
    `<span class="sponsor-help-pill pain">${escHtml(p)}</span>`).join('');
  const catPills = cats.map(c =>
    `<span class="sponsor-help-pill cat">${escHtml(CATEGORY_LABELS[c] || c)}</span>`).join('');
  const feltBy = _sponsorFeltBy(sponsorKey);
  const feltByHtml = feltBy.length ? `
    <div class="sponsor-card-felt-by">
      <span class="sponsor-felt-label">Also felt by</span>
      <div class="sponsor-felt-list">
        ${feltBy.map((u, i) => `
          <span class="sponsor-felt-pill">
            <span class="mini-av t${(i % 4) + 1}">${escHtml((u.first_name?.[0] || '?').toUpperCase())}</span>
            <span class="sponsor-felt-name">${escHtml(u.first_name || 'Teammate')}</span>
          </span>
        `).join('')}
      </div>
    </div>
  ` : '';
  return `
    <div class="sponsor-card-relevance">
      <div class="sponsor-card-relevance-label">What we can help with</div>
      <div class="sponsor-card-relevance-pills">${painPills}${catPills}</div>
      ${feltByHtml}
    </div>
  `;
}

function sponsorsFooterHtml(plan = _plan) {
  return `
    <section class="sponsors-footer" style="max-width:760px;">
      <h2 class="sponsors-footer-heading">This free Accountex 2026 Planner <em>is brought to you by:</em></h2>
      <div class="sponsors-grid">
        <div class="sponsor-card">
          <div class="sponsor-card-logo">
            <img src="/images/workiro-logo.svg" alt="Workiro">
          </div>
          <p class="sponsor-card-desc">
            Cloud document management for UK accountants — trusted by 65,000+ professionals.
            <span class="sponsor-card-booth">Come visit us at booth <strong>1144</strong>.</span>
          </p>
          ${_renderSponsorPainsBlock('workiro', plan)}
          <a class="sponsor-card-link" href="https://workiro.com" target="_blank" rel="noopener">
            Visit workiro.com
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><line x1="5" y1="12" x2="19" y2="12"/><polyline points="12 5 19 12 12 19"/></svg>
          </a>
        </div>
        <div class="sponsor-card">
          <div class="sponsor-card-logo">
            <img src="/images/XU%20Magazine.webp" alt="XU Magazine">
          </div>
          <p class="sponsor-card-desc">
            The independent news source for accounting app users.
            <span class="sponsor-card-booth">Come visit us at booth <strong>510</strong>.</span>
          </p>
          ${_renderSponsorPainsBlock('xu', plan)}
          <a class="sponsor-card-link" href="https://xumagazine.com" target="_blank" rel="noopener">
            Visit xumagazine.com
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><line x1="5" y1="12" x2="19" y2="12"/><polyline points="12 5 19 12 12 19"/></svg>
          </a>
        </div>
      </div>
    </section>

    <div class="autoevent-foot">
      <div class="autoevent-foot-line">
        <span class="autoevent-foot-label">Powered by</span>
        <img class="autoevent-foot-logo" src="/images/AutoEvent.svg" alt="AutoEvent">
        <span class="autoevent-foot-built">— a free tool by <a href="https://workiro.com" target="_blank" rel="noopener">Workiro</a></span>
      </div>
      <div class="autoevent-foot-cta">
        Want one of these for your next event? <a href="/" target="_blank" rel="noopener">About AutoEvent →</a>
      </div>
    </div>

    <div class="hero-page-footer">
      Free · <a href="https://www.workiro.com/terms-and-policies/autoevent" target="_blank" rel="noopener">Privacy &amp; terms</a>
    </div>
  `;
}

// ── Main render ───────────────────────────────────────────────────────────────

// "Install as app" promo strip — sits above the top-bar on mobile only.
// Detects iOS vs Android and shows the right Add-to-Home-Screen path.
// Dismisses for life via localStorage; if the page is loaded standalone
// (already installed) we never show it.
function renderInstallStrip() {
  if (typeof navigator === 'undefined') return '';
  if (localStorage.getItem('installStripDismissed') === '1') return '';
  // If already running as an installed PWA, don't re-pitch the install.
  const isStandalone = (window.matchMedia && window.matchMedia('(display-mode: standalone)').matches)
                       || window.navigator.standalone === true;
  if (isStandalone) return '';
  const ua        = navigator.userAgent || '';
  const isIOS     = /iPhone|iPad|iPod/.test(ua);
  const isAndroid = /Android/.test(ua);
  if (!isIOS && !isAndroid) return '';
  const steps = isIOS
    ? 'Tap <strong>Share</strong> → <strong>Add to Home Screen</strong>'
    : 'Tap menu <strong>⋮</strong> → <strong>Install app</strong>';
  return `
    <div class="install-strip" id="installStrip">
      <div class="install-strip-icon" aria-hidden="true">
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="5" y="2" width="14" height="20" rx="2" ry="2"/><line x1="12" y1="18" x2="12.01" y2="18"/></svg>
      </div>
      <div class="install-strip-body">
        <strong>Install this as an app for the show:</strong> ${steps}. Opens full-screen, always logged in.
      </div>
      <button class="install-strip-dismiss" onclick="dismissInstallStrip()" aria-label="Dismiss" type="button">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
      </button>
    </div>
  `;
}
window.dismissInstallStrip = function() {
  localStorage.setItem('installStripDismissed', '1');
  document.getElementById('installStrip')?.remove();
};

function renderApp() {
  const root = $('plan-root');
  if (!root) return;

  root.innerHTML = renderInstallStrip() + renderTabNav() + `<div class="plan-tab-content">${renderCurrentTab()}</div>`;

  if (_currentTab === 'checklist') {
    attachPlanListeners(_plan.id, _plan.sessions, _plan.booths);
  }

  if (_pendingJoinToken) {
    const banner = document.createElement('div');
    banner.className = 'team-join-prompt';
    banner.innerHTML = `
      <div class="team-join-prompt-inner">
        <div class="team-join-prompt-text">
          <strong>You've been invited to join${_pendingJoinCompany ? ` <em>${escHtml(_pendingJoinCompany)}</em>'s` : ' a'} team.</strong>
          Your existing plan stays unchanged.
        </div>
        <div class="team-join-prompt-actions">
          <button class="team-join-accept-btn" type="button">Join team</button>
          <button class="team-join-decline-btn" type="button">Not now</button>
        </div>
      </div>`;
    const acceptBtn = banner.querySelector('.team-join-accept-btn');
    const declineBtn = banner.querySelector('.team-join-decline-btn');
    acceptBtn.addEventListener('click', async () => {
      acceptBtn.disabled = true; acceptBtn.textContent = 'Joining…';
      const { data, error } = await supabase.rpc('accept_team_invite', { p_invite_token: _pendingJoinToken });
      if (error || data?.error) {
        console.error('accept_team_invite error:', error || data?.error);
        acceptBtn.disabled = false; acceptBtn.textContent = 'Join team';
        showError('Could not join team. Please try again.');
        return;
      }
      _pendingJoinToken   = null;
      _pendingJoinCompany = null;
      window.location.reload();
    });
    declineBtn.addEventListener('click', () => {
      _pendingJoinToken   = null;
      _pendingJoinCompany = null;
      renderApp();
    });
    root.prepend(banner);
  }
}

function renderCurrentTab() {
  const footer = sponsorsFooterHtml(_plan);
  switch (_currentTab) {
    case 'checklist': return renderChecklistTab() + footer;
    case 'team':      return renderTeamTab()      + footer;
    case 'cpd':       return renderCpdTab()       + footer;
    case 'debrief':   return renderDebriefTab()   + footer;
    default:          return renderChecklistTab() + footer;
  }
}

// ── Event listeners ───────────────────────────────────────────────────────────

function attachPlanListeners(planId, sessions, booths) {
  document.querySelectorAll('.checklist-box').forEach(btn => {
    btn.addEventListener('click', async () => {
      const row      = btn.closest('[data-item-type]');
      const itemType = row.dataset.itemType;
      const itemId   = row.dataset.itemId;
      row.classList.toggle('attended');
      if (itemType === 'booth') {
        await toggleBoothAttended(planId, itemId, booths);
      } else {
        await toggleAttended(planId, itemId, sessions);
      }
    });
  });

  document.querySelectorAll('.flame-btn').forEach(btn => {
    btn.addEventListener('click', async () => {
      const card     = btn.closest('[data-item-type]');
      const itemType = card.dataset.itemType;
      const itemId   = card.dataset.itemId;
      const rating   = parseInt(btn.dataset.rating);
      const currentRating = parseInt(card.dataset.rating || '0');
      const newRating     = currentRating === rating ? 0 : rating;
      card.dataset.rating = newRating;
      card.querySelectorAll('.flame-btn').forEach((b, i) => {
        b.classList.toggle('lit', i < newRating);
      });
      await updateRating(planId, itemId, itemType, newRating);
      // Auto-open the note panel after rating — but only when the user
      // is setting a new rating (not clearing one) and there's no saved
      // note yet. Pulls the note moment forward to where the user is
      // already in "reflect" mode.
      if (newRating > 0 && currentRating === 0) {
        const noteId = `${itemType}:${itemId}`;
        const panel = card.querySelector(`.checklist-note-panel[data-note-id="${CSS.escape(noteId)}"]`);
        if (panel && panel.classList.contains('idle')) {
          window.planOpenNote(noteId);
        }
      }
    });
  });

}

async function toggleAttended(planId, itemId, sessions) {
  const updated = sessions.map(s =>
    s.session_id === itemId ? { ...s, attended: !s.attended } : s,
  );
  _plan.sessions = updated;
  await supabase.from('plans').update({ sessions: updated }).eq('id', planId);
}

async function toggleBoothAttended(planId, itemId, booths) {
  const updated = booths.map(b =>
    b.stand_number === itemId ? { ...b, attended: !b.attended } : b,
  );
  _plan.booths = updated;
  await supabase.from('plans').update({ booths: updated }).eq('id', planId);
}

async function savePlanSessions() {
  if (!_plan?.id) return;
  await supabase.from('plans').update({ sessions: _plan.sessions }).eq('id', _plan.id);
}

async function updateRating(planId, itemId, itemType, rating) {
  const field = itemType === 'session' ? 'sessions' : 'booths';
  const list  = itemType === 'session' ? (_plan.sessions || []) : (_plan.booths || []);
  const updated = list.map(item => {
    const id = itemType === 'session' ? item.session_id : item.stand_number;
    return id === itemId ? { ...item, rating } : item;
  });
  if (itemType === 'session') _plan.sessions = updated;
  else _plan.booths = updated;
  await supabase.from('plans').update({ [field]: updated }).eq('id', planId);
}

async function saveNote(planId, itemId, itemType, noteText, createdBy) {
  await supabase.from('notes').upsert(
    { plan_id: planId, item_id: itemId, item_type: itemType, note_text: noteText, created_by: createdBy || null },
    { onConflict: 'plan_id,item_id,item_type' },
  );
}

// ── Auth flow ─────────────────────────────────────────────────────────────────

async function handleSignIn(authUser, teamToken) {
  const log = (step, detail) => console.log(`[plan/signin] ${step}` + (detail ? ` — ${detail}` : ''));
  log('start', `userId=${authUser?.id} anon=${authUser?.is_anonymous} teamToken=${teamToken || 'none'}`);
  try {
    if (!authUser.is_anonymous) {
      // Recover pending plan from localStorage only if no plan already exists in DB.
      // The wizard saves under the anonymous user ID; after magic-link sign-in the
      // anonymous session is upgraded (same user ID), so the plan is already there.
      // We only need this path when the DB save failed in the wizard.
      const pending = localStorage.getItem('pendingPlan');
      const planData = pending ? JSON.parse(pending) : null;

      // Always ensure user exists in public.users before any team operations.
      // When the magic link is opened in a different browser than the wizard,
      // pendingPlan is absent and the users upsert would otherwise be skipped,
      // causing join_team to fail with a foreign key violation on team_members.
      const { error: upsertErr } = await supabase.from('users').upsert(
        {
          id:    authUser.id,
          email: authUser.email || '',
          // Only overwrite name/company when we have fresh data from this browser session.
          // Omitting these fields on conflict leaves existing DB values intact.
          ...(planData?.user ? {
            first_name: planData.user.firstName || '',
            last_name:  planData.user.lastName  || '',
            company:    planData.user.company   || null,
          } : {}),
        },
        { onConflict: 'id' },
      );
      if (upsertErr) throw upsertErr;

      const { data: profileRow } = await supabase
        .from('users')
        .select('first_name, last_name, company')
        .eq('id', authUser.id)
        .single();
      _userProfile = profileRow;

      if (planData) {
        const pendingPlanId = localStorage.getItem('pendingPlanId');
        let claimed = false;

        if (pendingPlanId) {
          const { error: claimErr } = await supabase.rpc('claim_anonymous_plan', { p_plan_id: pendingPlanId });
          if (!claimErr) {
            claimed = true;
          } else {
            console.warn('claim_anonymous_plan failed:', claimErr);
          }
          localStorage.removeItem('pendingPlanId');
        }

        if (!claimed) {
          const { count } = await supabase
            .from('plans')
            .select('id', { count: 'exact', head: true })
            .eq('user_id', authUser.id);

          if (!count) {
            const { error: insertErr } = await supabase.from('plans').insert({
              user_id:     authUser.id,
              attend_mode: planData.answers.attendMode,
              problem:     planData.answers.problem,
              categories:  planData.answers.categories,
              time_window: planData.answers.time,
              role:        planData.answers.role,
              sessions:    planData.sessions,
              booths:      planData.booths,
              ai_themes:   planData.themes || [],
            });
            if (insertErr) throw insertErr;
          }
        }
        localStorage.removeItem('pendingPlan');
      } else {
        // No localStorage data — magic link opened on a different device.
        // Try to claim any orphaned anonymous plan that shares this email.
        await supabase.rpc('claim_anonymous_plan_by_email');
      }

      // Join team if invite token present
      if (teamToken) {
        const isNewUser = !!planData;
        if (isNewUser) {
          // New user arriving via wizard → auto-join immediately via the new RPC
          // which handles plan.team_id update and old-team cleanup atomically.
          const { data: joinResult, error: joinErr } = await supabase.rpc('accept_team_invite', { p_invite_token: teamToken });
          localStorage.removeItem('pendingTeamToken');
          if (joinErr) throw joinErr;
          if (joinResult?.error) { showError(`Could not join team: ${joinResult.error}`); return; }
        } else {
          // Existing user → show join prompt after plan renders
          _pendingJoinToken = teamToken;
          localStorage.removeItem('pendingTeamToken');
          // Remove ?team= from URL now so a reload after joining doesn't re-trigger the prompt
          const cleanUrl = new URL(window.location.href);
          cleanUrl.searchParams.delete('team');
          history.replaceState(null, '', cleanUrl.toString());
          // Fetch team company name for the banner (best-effort display only)
          const { data: inviteInfo } = await supabase.rpc('get_invite_info', { p_invite_token: teamToken });
          if (inviteInfo?.company) _pendingJoinCompany = inviteInfo.company;
        }
      }
    }

    log('loadPlan', 'fetching plan + programme + exhibitors');
    const [full, allSessions, allExhibitors] = await Promise.all([
      loadLatestPlan(authUser.id),
      fetch('/data/programme.json').then(r => r.json()).catch(() => []),
      fetch('/data/exhibitors.json').then(r => r.json()).catch(() => []),
    ]);
    log('loadPlan', `plan=${full ? full.id : 'none'} sessions=${allSessions.length} booths=${allExhibitors.length}`);

    if (!full) {
      if (teamToken) {
        window.location.href = `/?team=${teamToken}`;
        return;
      }
      showNoPlanState();
      return;
    }

    // Auto-create team for team leads whose plan doesn't yet have a team_id.
    // This defers team creation to the first authenticated load, since the teams
    // table requires a non-anonymous session (RLS blocks wizard-time creation).
    // Skip for users who just joined an existing team via invite.
    if (!full.team_id && !authUser.is_anonymous) {
      if (_pendingJoinToken) {
        // Existing user who will be shown the join prompt — do NOT create a solo team.
        // plan.team_id will be set when they accept the prompt.
      } else {
        const { data: userRow } = await supabase
          .from('users')
          .select('company')
          .eq('id', authUser.id)
          .single();

        const { data: team, error: teamErr } = await supabase
          .from('teams')
          .insert({
            lead_user_id: authUser.id,
            company:      userRow?.company || null,
            invite_token: crypto.randomUUID(),
            max_members:  12,
          })
          .select('id, invite_token')
          .single();
        if (teamErr) throw teamErr;

        const { error: planUpdateErr } = await supabase
          .from('plans')
          .update({ team_id: team.id })
          .eq('id', full.id);
        if (planUpdateErr) throw planUpdateErr;

        const { error: memberErr } = await supabase
          .from('team_members')
          .insert({ team_id: team.id, user_id: authUser.id, role: 'lead' });
        if (memberErr) throw memberErr;

        full.team_id = team.id;
      }
    }

    let teamData = null;
    if (full.team_id) {
      log('loadTeamData', `team=${full.team_id}`);
      teamData = await loadTeamData(full.team_id);
      log('loadTeamData', `members=${teamData?.members?.length ?? 0}`);
    }

    // Re-hydrate booth metadata from current exhibitors data so name/description
    // changes in the CSV are reflected without needing a plan rebuild
    const exhibitorsByStand = Object.fromEntries(
      allExhibitors.map(e => [String(e.stand_number), e])
    );
    full.booths = (full.booths || []).map(b => {
      const fresh = exhibitorsByStand[String(b.stand_number)];
      return fresh ? { ...fresh, rating: b.rating, attended: b.attended, reason: b.reason } : b;
    });

    _plan          = full;
    _allSessions   = allSessions;
    _allExhibitors = allExhibitors;
    _teamData    = teamData;
    _authUser    = authUser;

    // Guarantee Workiro always appears in the booths list
    if (!(_plan.booths || []).some(b => b.company_name === 'Workiro')) {
      const workiro = allExhibitors.find(e => e.company_name === 'Workiro');
      if (workiro) {
        _plan.booths = [
          ...(_plan.booths || []),
          { ...workiro, reason: 'The team behind this Game Plan — come see us at Stand 1144.' },
        ];
        await supabase.from('plans').update({ booths: _plan.booths }).eq('id', _plan.id);
      }
    }

    log('renderApp', 'all data ready');
    showLoading(false);
    renderApp();
    log('done');
  } catch (err) {
    const detail = err?.message || err?.details || String(err);
    console.error('[plan/signin] error:', err);
    showLoading(false);
    showError(`Could not load your plan: ${detail} — <a href="/" style="color:var(--mint)">Start again →</a> · <a href="/plan/?reset=1" style="color:var(--mint)">Reset session</a>`);
  }
}

function showNoPlanState() {
  const root = $('plan-root');
  if (root) root.innerHTML = `
    <div class="empty-plan">
      <p>No plan found. <a href="/">Create yours →</a></p>
    </div>`;
}

function showError(msg) {
  const el = $('plan-error');
  if (el) { el.innerHTML = msg; el.style.display = 'block'; }
}

function showReauthForm(headlineMsg = '') {
  showLoading(false);
  const root = $('plan-root');
  if (!root) return;
  root.innerHTML = `
    <div class="empty-plan">
      ${headlineMsg ? `<p style="margin-bottom:18px;color:var(--text-muted);">${headlineMsg}</p>` : ''}
      <p style="margin-bottom:20px;font-size:15px;">Enter your email and we'll send you a link to your saved game plan.</p>
      <form id="reauth-form" style="display:flex;flex-direction:column;gap:12px;max-width:300px;margin:0 auto;">
        <input type="email" id="reauth-email" placeholder="your@email.com" required
          style="background:var(--ink-3);border:1px solid var(--ink-4);border-radius:8px;padding:12px 14px;color:var(--text);font-family:inherit;font-size:14px;width:100%;outline:none;">
        <button type="submit" id="reauth-btn"
          style="background:var(--grad);border:none;border-radius:8px;padding:12px 20px;color:#fff;font-family:inherit;font-size:14px;font-weight:600;cursor:pointer;">
          Send me my plan →
        </button>
        <p id="reauth-msg" style="display:none;font-size:13px;text-align:center;margin:0;"></p>
      </form>
      <p style="margin-top:20px;font-size:13px;color:var(--text-faint);">No plan yet? <a href="/" style="color:var(--mint);">Create one →</a></p>
    </div>`;

  $('reauth-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const email = $('reauth-email').value.trim();
    const btn   = $('reauth-btn');
    btn.textContent = 'Sending…';
    btn.disabled    = true;
    const { error } = await sendMagicLink(email);
    const msg = $('reauth-msg');
    if (error) {
      btn.disabled    = false;
      btn.textContent = 'Send me my plan →';
      if (msg) { msg.textContent = error.message || 'Something went wrong. Please try again.'; msg.style.color = '#ef4444'; msg.style.display = 'block'; }
    } else {
      if (msg) { msg.textContent = `Check your inbox — link sent to ${email}`; msg.style.color = 'var(--mint)'; msg.style.display = 'block'; }
      btn.textContent = 'Sent ✓';
    }
  });
}

function showLoading(show) {
  const el = $('plan-loading');
  if (el) el.style.display = show ? 'flex' : 'none';
}

// ── Debrief PDF helper ────────────────────────────────────────────────────────

function buildPrintHtml(text, name, company) {
  const header = [name, company].filter(Boolean).join(' · ') || 'Accountex 2026';
  const escaped = text
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>Accountex 2026 Debrief</title>
<style>
  body { font-family: Georgia, serif; font-size: 13pt; line-height: 1.7; margin: 2cm 2.5cm; color: #111; }
  h1 { font-size: 18pt; margin: 0 0 4px; }
  .meta { font-size: 10pt; color: #666; margin-bottom: 28px; border-bottom: 1px solid #ddd; padding-bottom: 12px; }
  pre { font-family: inherit; white-space: pre-wrap; word-break: break-word; margin: 0; }
  @media print { body { margin: 1.5cm 2cm; } }
</style>
</head>
<body>
<h1>Accountex 2026 — Debrief</h1>
<div class="meta">${header}</div>
<pre>${escaped}</pre>
<script>window.onload = function() { window.print(); };<\/script>
</body>
</html>`;
}

// ── Global helpers (called from inline onclick in rendered HTML) ───────────────

window.planSwitchTab = function(tabId) {
  _currentTab = tabId;
  renderApp();
  window.scrollTo({ top: 0, behavior: 'smooth' });
  if (tabId === 'debrief') refreshDebriefNotes();
  setTimeout(() => {
    document.querySelector('.app-tab.active')?.scrollIntoView({ behavior: 'smooth', block: 'nearest', inline: 'center' });
  }, 0);
};

async function refreshDebriefNotes() {
  if (!_plan?.id) return;

  const { data: freshNotes } = await supabase.from('notes').select('*').eq('plan_id', _plan.id);
  if (freshNotes) _plan.notes = freshNotes;

  if (_teamData && _plan.team_id) {
    const [{ data: freshTeamPlans }, { data: freshMembers }] = await Promise.all([
      supabase.from('plans').select('id, user_id, problem, categories, role, sessions, booths, ai_themes').eq('team_id', _plan.team_id),
      supabase.from('team_members').select('role, joined_at, users(id, first_name, last_name, company)').eq('team_id', _plan.team_id),
    ]);

    if (freshTeamPlans) {
      _teamData.teamPlans = freshTeamPlans;
      const planIds = freshTeamPlans.map(p => p.id);
      if (planIds.length) {
        const { data: freshTeamNotes } = await supabase.from('notes').select('*').in('plan_id', planIds);
        if (freshTeamNotes) _teamData.allNotes = freshTeamNotes;
      }
    }
    if (freshMembers) _teamData.members = freshMembers;
  }

  if (_currentTab === 'debrief') renderApp();
}


window.planSwapSession = function(currentId, newId) {
  if (!_plan) return;
  const newSession = (_allSessions || []).find(s => s.session_id === newId);
  if (!newSession) return;
  _plan.sessions = _plan.sessions.filter(s => s.session_id !== currentId);
  _plan.sessions.push({ session_id: newId, rank: _plan.sessions.length + 1, reason: '', ...newSession });
  if (newSession.day && newSession.start_time) {
    _resolvedSlots.add(`${newSession.day}-${newSession.start_time}`);
  }
  savePlanSessions();
  renderApp();
};

// Add a session into a previously-empty time block (a gap card "Pick a
// session here"). No swap-out — just appends to the plan; the next render
// sorts it chronologically into place.
window.planAddSession = function(newId) {
  if (!_plan) return;
  if ((_plan.sessions || []).some(s => s.session_id === newId)) return;
  const newSession = (_allSessions || []).find(s => s.session_id === newId);
  if (!newSession) return;
  _plan.sessions.push({ session_id: newId, rank: _plan.sessions.length + 1, reason: '', ...newSession });
  if (newSession.day && newSession.start_time) {
    _resolvedSlots.add(`${newSession.day}-${newSession.start_time}`);
  }
  savePlanSessions();
  renderApp();
};

window.planRemoveSession = function(sessionId, day, startTime) {
  if (!_plan) return;
  _plan.sessions = _plan.sessions.filter(s =>
    !(s.session_id === sessionId && s.day === day && s.start_time === startTime),
  );
  savePlanSessions();
  renderApp();
};

window.planRemoveBooth = function(standNumber) {
  if (!_plan) return;
  _plan.booths = (_plan.booths || []).filter(b => String(b.stand_number) !== String(standNumber));
  supabase.from('plans').update({ booths: _plan.booths }).eq('id', _plan.id);
  renderApp();
};

// In-app confirm modal — replaces native window.confirm() so the
// experience reads as part of the app, not the browser. Reusable:
// pass a body string + onConfirm callback. Tone "danger" turns the
// confirm button pink to signal a destructive action.
function planShowConfirm({ title, body, confirmLabel, confirmTone, onConfirm }) {
  // If a previous confirm is still open (rapid re-invocation), clean
  // up its keydown listener before stomping the DOM — otherwise stale
  // Esc/Enter handlers leak onto document.
  if (planShowConfirm._cleanup) planShowConfirm._cleanup();
  document.getElementById('planConfirmModal')?.remove();
  const modal = document.createElement('div');
  modal.id = 'planConfirmModal';
  modal.className = 'plan-confirm-modal open';
  modal.innerHTML = `
    <div class="plan-confirm-backdrop" data-action="cancel"></div>
    <div class="plan-confirm-panel">
      <h2 class="plan-confirm-title">${escHtml(title)}</h2>
      <p class="plan-confirm-body">${body}</p>
      <div class="plan-confirm-actions">
        <button class="plan-confirm-btn cancel" type="button" data-action="cancel">Cancel</button>
        <button class="plan-confirm-btn confirm tone-${confirmTone || 'mint'}" type="button" data-action="confirm">${escHtml(confirmLabel || 'Confirm')}</button>
      </div>
    </div>`;
  document.body.appendChild(modal);
  const close = () => {
    document.removeEventListener('keydown', onKey);
    modal.remove();
    if (planShowConfirm._cleanup === close) planShowConfirm._cleanup = null;
  };
  const onKey = (e) => {
    if (e.key === 'Escape') close();
    else if (e.key === 'Enter') { onConfirm?.(); close(); }
  };
  document.addEventListener('keydown', onKey);
  planShowConfirm._cleanup = close;
  modal.addEventListener('click', (e) => {
    const action = e.target.closest('[data-action]')?.dataset?.action;
    if (action === 'cancel') close();
    else if (action === 'confirm') { onConfirm?.(); close(); }
  });
  // Auto-focus the confirm button so Enter works straight away.
  modal.querySelector('.plan-confirm-btn.confirm')?.focus();
}

// Modal listing every teammate note for a single item. Triggered from
// the "+N more" link in the inline team-notes block when an item has
// more notes than the inline cap.
window.planShowTeamNotes = function(noteKey, itemTitle) {
  const allNotes = (_teamData?.allNotes || []).filter(n => {
    if (!n.created_by || n.created_by === _authUser?.id) return false;
    const colon = noteKey.indexOf(':');
    return n.item_type === noteKey.slice(0, colon) && String(n.item_id) === noteKey.slice(colon + 1);
  });
  const sorted = [...allNotes].sort((a, b) =>
    new Date(b.created_at || 0) - new Date(a.created_at || 0));
  const fmtDate = (d) => {
    if (!d) return '';
    try { return new Date(d).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }); }
    catch { return ''; }
  };
  document.getElementById('planTeamNotesModal')?.remove();
  const modal = document.createElement('div');
  modal.id = 'planTeamNotesModal';
  modal.className = 'plan-confirm-modal open';
  modal.innerHTML = `
    <div class="plan-confirm-backdrop" data-action="close"></div>
    <div class="plan-confirm-panel team-notes-panel">
      <div class="team-notes-modal-eyebrow">Team notes</div>
      <h2 class="plan-confirm-title">${escHtml(itemTitle)}</h2>
      <div class="team-notes-modal-list">
        ${sorted.map(n => {
          const author = _teamData?.members.find(m => m.users?.id === n.created_by);
          const name = author ? `${author.users.first_name || ''} ${author.users.last_name || ''}`.trim() : 'Teammate';
          return `
            <div class="team-notes-modal-row">
              <div class="team-notes-modal-row-head">
                <span class="team-notes-modal-name">${escHtml(name)}</span>
                ${n.created_at ? `<span class="team-notes-modal-time">${escHtml(fmtDate(n.created_at))}</span>` : ''}
              </div>
              <p class="team-notes-modal-text">${escHtml(n.note_text || '')}</p>
            </div>`;
        }).join('') || '<p class="team-notes-modal-empty">No team notes yet.</p>'}
      </div>
      <div class="plan-confirm-actions">
        <button class="plan-confirm-btn cancel" type="button" data-action="close">Close</button>
      </div>
    </div>`;
  document.body.appendChild(modal);
  const close = () => { document.removeEventListener('keydown', onKey); modal.remove(); };
  const onKey = (e) => { if (e.key === 'Escape') close(); };
  document.addEventListener('keydown', onKey);
  modal.addEventListener('click', (e) => {
    if (e.target.closest('[data-action="close"]')) close();
  });
};

window.planConfirmRemoveBooth = function(standNumber, companyName) {
  const label = companyName
    ? `Remove <strong>${escHtml(companyName)}</strong> from your plan?`
    : 'Remove this booth from your plan?';
  planShowConfirm({
    title: 'Remove booth',
    body: `${label} You can re-add it any time from <strong>Edit booths</strong>.`,
    confirmLabel: 'Remove',
    confirmTone: 'danger',
    onConfirm: () => window.planRemoveBooth(standNumber),
  });
};

// Toggle a booth's visited state from the in-card Visited button. Mirrors
// the existing checkbox in the row's leftcol — same data path, just a
// more discoverable affordance now sitting in the action row.
window.planToggleBoothVisited = function(standNumber) {
  if (!_plan) return;
  const updated = (_plan.booths || []).map(b =>
    String(b.stand_number) === String(standNumber)
      ? { ...b, attended: !b.attended }
      : b,
  );
  _plan.booths = updated;
  supabase.from('plans').update({ booths: updated }).eq('id', _plan.id);
  renderApp();
};



window.planCopyDebrief = function(btn) {
  const ta = document.getElementById('debrief-textarea');
  if (!ta) return;
  navigator.clipboard.writeText(ta.value).then(() => {
    const orig = btn.textContent.trim();
    btn.textContent = 'Copied!';
    setTimeout(() => { btn.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg> ${orig}`; }, 2000);
  });
};

window.planEmailDebrief = function() {
  const ta      = document.getElementById('debrief-textarea');
  const subject = encodeURIComponent('Accountex 2026 — My Debrief');
  const body    = encodeURIComponent(ta ? ta.value : '');
  window.location.href = `mailto:?subject=${subject}&body=${body}`;
};

window.planDownloadDebrief = function() {
  const ta      = document.getElementById('debrief-textarea');
  const name    = [_userProfile?.first_name, _userProfile?.last_name].filter(Boolean).join(' ');
  const company = _userProfile?.company || '';
  const html = buildPrintHtml(ta ? ta.value : '', name, company);
  const blob = new Blob([html], { type: 'text/html' });
  const url  = URL.createObjectURL(blob);
  const win  = window.open(url, '_blank');
  if (win) win.addEventListener('load', () => URL.revokeObjectURL(url), { once: true });
};

window.planOpenNote = function(noteId) {
  const panel = document.querySelector(`.checklist-note-panel[data-note-id="${CSS.escape(noteId)}"]`);
  if (!panel) return;
  const savedText = panel.dataset.savedText || '';
  const chips = noteId.startsWith('booth:') ? NOTE_CHIPS_BOOTH : NOTE_CHIPS_SESSION;
  const chipsHtml = chips.map((c, i) => `
    <button class="note-chip" type="button" data-chip-idx="${i}"
      onclick="planInsertChip('${escHtml(noteId)}', ${i}, this)">
      <span class="note-chip-emoji">${c.emoji}</span><span class="note-chip-label">${escHtml(c.label)}</span>
    </button>`).join('');
  panel.className = 'checklist-note-panel editing';
  panel.innerHTML = `
    <div class="note-edit-head"><span class="note-edit-label">Your note</span></div>
    <div class="note-chip-row">${chipsHtml}</div>
    <textarea class="rate-panel-note" id="noteDraft-${escHtml(noteId)}"
      maxlength="280">${escHtml(savedText)}</textarea>
    <div class="note-edit-actions">
      <div class="note-edit-count"><span id="noteCount-${escHtml(noteId)}">${savedText.length}</span> / 280</div>
      <div class="note-edit-buttons">
        <button class="note-edit-btn cancel" onclick="planCancelNote('${escHtml(noteId)}')" type="button">Cancel</button>
        <button class="note-edit-btn save" onclick="planSaveNote('${escHtml(noteId)}')" type="button">Save note</button>
      </div>
    </div>`;
  const ta = document.getElementById(`noteDraft-${noteId}`);
  if (ta) {
    ta.addEventListener('input', () => {
      const counter = document.getElementById(`noteCount-${noteId}`);
      if (counter) counter.textContent = ta.value.length;
    });
    ta.focus();
  }
};

// Chip insertion — stamps "${emoji} ${label}: " into the textarea per
// the rules: prepend if empty, append on a new line if not, no-op if
// the chip's label is already present, soft-block at the 280 cap.
// Brief mint flash on the chip confirms the action.
window.planInsertChip = function(noteId, chipIdx, btn) {
  const ta = document.getElementById(`noteDraft-${noteId}`);
  if (!ta) return;
  const list = noteId.startsWith('booth:') ? NOTE_CHIPS_BOOTH : NOTE_CHIPS_SESSION;
  const c = list[chipIdx];
  if (!c) return;
  const stamp = `${c.emoji} ${c.label}: `;
  const flash = (cls) => {
    if (!btn) return;
    btn.classList.add(cls);
    setTimeout(() => btn.classList.remove(cls), 500);
  };
  // Already used in this note? No-op + subtle "already there" flash.
  if (ta.value.includes(`${c.emoji} ${c.label}:`)) {
    flash('already');
    return;
  }
  const current   = ta.value;
  const insertion = current.length === 0 ? stamp : current.endsWith('\n') ? stamp : `\n${stamp}`;
  // Soft-block when the insertion would push past 280 chars.
  if (current.length + insertion.length > 280) {
    flash('full');
    return;
  }
  ta.value = current + insertion;
  flash('used');
  // Move cursor to the end (right after the newly inserted colon-space)
  const pos = ta.value.length;
  ta.focus();
  ta.setSelectionRange(pos, pos);
  // Update counter manually since programmatic .value changes don't fire
  // an 'input' event automatically across all browsers.
  const counter = document.getElementById(`noteCount-${noteId}`);
  if (counter) counter.textContent = ta.value.length;
};

window.planCancelNote = function(noteId) {
  const panel = document.querySelector(`.checklist-note-panel[data-note-id="${CSS.escape(noteId)}"]`);
  if (!panel) return;
  _renderNotePanel(panel, noteId, panel.dataset.savedText || '');
};

window.planSaveNote = async function(noteId) {
  if (!_plan?.id) return;
  const ta = document.getElementById(`noteDraft-${noteId}`);
  const text = ta?.value?.trim() || '';
  const panel = document.querySelector(`.checklist-note-panel[data-note-id="${CSS.escape(noteId)}"]`);
  if (!panel) return;
  const colonIdx = noteId.indexOf(':');
  const itemType = noteId.slice(0, colonIdx);
  const itemId   = noteId.slice(colonIdx + 1);
  await saveNote(_plan.id, itemId, itemType, text, _authUser?.id);
  panel.dataset.savedText = text;
  _renderNotePanel(panel, noteId, text);

  // Keep in-memory note arrays current so debrief reflects changes immediately
  const noteObj = { plan_id: _plan.id, item_type: itemType, item_id: itemId, note_text: text, created_by: _authUser?.id || null };
  const notes = _plan.notes || [];
  const idx = notes.findIndex(n => n.item_type === itemType && n.item_id === itemId && n.plan_id === _plan.id);
  if (idx >= 0) notes[idx] = noteObj; else notes.push(noteObj);
  _plan.notes = notes;

  if (_teamData) {
    const teamIdx = _teamData.allNotes.findIndex(n => n.item_type === itemType && n.item_id === itemId && n.plan_id === _plan.id);
    if (teamIdx >= 0) _teamData.allNotes[teamIdx] = noteObj; else _teamData.allNotes.push(noteObj);
  }

  if (_currentTab === 'debrief') renderApp();
};

window.planDismissAlternative = function(currentId, altId, ev) {
  if (ev) ev.stopPropagation();
  _dismissedAlternatives.add(`${currentId}|${altId}`);
  const current = (_plan?.sessions || []).find(s => s.session_id === currentId);
  if (current?.day && current?.start_time) {
    _resolvedSlots.add(`${current.day}-${current.start_time}`);
  }
  renderApp();
};

// Open the slot-picker modal for a previously-EMPTY time window (a gap
// card). Lists sessions whose start_time falls within the gap window
// and that fit chronologically. User taps "Add to plan" to slot a
// session into that time. Mirrors planOpenSlotSwap but with no current
// session to swap out.
window.planFillSlot = function(day, slotStart, slotEnd, ev) {
  if (ev) ev.stopPropagation();
  const slotStartMin = parseTimeToMinutes(slotStart);
  const slotEndMin   = parseTimeToMinutes(slotEnd);
  const candidates = (_allSessions || []).filter(s => {
    if (s.day !== day || !s.start_time) return false;
    const sStart = parseTimeToMinutes(s.start_time);
    if (sStart < slotStartMin || sStart >= slotEndMin) return false;
    if (s.end_time) {
      const sEnd = parseTimeToMinutes(s.end_time);
      if (sEnd > slotEndMin) return false;
    }
    return true;
  });
  const cats = _plan?.categories || [];
  const wantedCanonicals = new Set(cats.flatMap(c => PLAN_CATEGORY_MATCH[c] || []));
  const scored = candidates.map(s => ({
    session: s,
    score:   (s.canonical_categories || []).filter(c => wantedCanonicals.has(c)).length,
    match:   matchForSession(s),
  }));
  // Sort by ranking ascending (top match first), then category overlap.
  scored.sort((a, b) =>
    a.match.rank - b.match.rank ||
    b.score - a.score ||
    (a.session.title || '').localeCompare(b.session.title || ''),
  );
  const dayLabel = day === 'Day 1' ? 'Wed 13 May' : 'Thu 14 May';
  const planIds = new Set((_plan?.sessions || []).map(s => s.session_id));
  const candidatesHtml = scored.length === 0
    ? '<div style="color:var(--text-muted);font-size:14px;padding:12px 0">No sessions in this time window.</div>'
    : scored.map(({ session: s, match: m }) => {
        const inPlan = planIds.has(s.session_id);
        const swapTags = whyMatched(s, _plan || {}, m.bucket);
        const tagsHtml = swapTags.length
          ? `<div class="checklist-why-tags">${swapTags.map(t => `<span class="checklist-why-tag">${escHtml(t.text)}</span>`).join('')}</div>`
          : '';
        return `
          <div class="slot-swap-row${inPlan ? ' already-in-plan' : ''}">
            <div class="slot-swap-row-main">
              <div class="slot-swap-row-title">${escHtml(s.title || '')}</div>
              <div class="slot-swap-row-meta">${escHtml(s.theatre || '')}${s.start_time ? ' · ' + escHtml(s.start_time) : ''}</div>
              ${renderMatchBadge({ bucket: m.bucket, rank: m.rank, type: 'session', compact: true })}
              ${tagsHtml}
              ${inPlan ? '<span class="slot-swap-already-tag">Already in your plan</span>' : ''}
            </div>
            ${inPlan
              ? '<button class="slot-swap-row-btn disabled" disabled>In plan</button>'
              : `<button class="slot-swap-row-btn outlined" onclick="planAddSession('${escHtml(s.session_id)}');document.getElementById('planSlotSwapModal')?.remove()" type="button">Add →</button>`
            }
          </div>`;
      }).join('');
  let modal = document.getElementById('planSlotSwapModal');
  if (modal) modal.remove();
  modal = document.createElement('div');
  modal.id = 'planSlotSwapModal';
  modal.className = 'login-modal slot-swap-modal open';
  modal.innerHTML = `
    <div class="login-modal-backdrop" onclick="document.getElementById('planSlotSwapModal')?.remove()"></div>
    <div class="login-modal-panel slot-swap-panel">
      <button class="login-modal-close" onclick="document.getElementById('planSlotSwapModal')?.remove()" aria-label="Close" type="button">
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
      </button>
      <div class="login-modal-eyebrow">${escHtml(dayLabel)} · ${escHtml(slotStart)}–${escHtml(slotEnd)}</div>
      <h2 class="login-modal-title">Pick a session <em>for this slot.</em></h2>
      <p class="login-modal-sub">Free time — perfect for booth visits, or pick something below to fill it. Sessions ranked by AI match.</p>
      <div class="slot-swap-list">${candidatesHtml}</div>
    </div>`;
  document.body.appendChild(modal);
};

window.planOpenSlotSwap = function(currentId, ev) {
  if (ev) ev.stopPropagation();
  const current = (_allSessions || []).find(s => s.session_id === currentId)
    || (_plan?.sessions || []).find(s => s.session_id === currentId);
  if (!current) return;
  const candidates = (_allSessions || []).filter(s =>
    s.session_id !== currentId &&
    s.day === current.day &&
    s.start_time === current.start_time,
  );
  const cats = _plan?.categories || [];
  const wantedCanonicals = new Set(cats.flatMap(c => PLAN_CATEGORY_MATCH[c] || []));
  const scored = candidates.map(s => ({
    session: s,
    score:   (s.canonical_categories || []).filter(c => wantedCanonicals.has(c)).length,
    match:   matchForSession(s),
  }));
  // Sort by ranking ascending — closest swaps appear first.
  scored.sort((a, b) =>
    a.match.rank - b.match.rank ||
    b.score - a.score ||
    (a.session.title || '').localeCompare(b.session.title || ''),
  );
  const dayLabel = current.day === 'Day 1' ? 'Wed 13 May' : 'Thu 14 May';
  const planIds = new Set((_plan?.sessions || []).map(s => s.session_id));
  // Free-time row sits at the top of the list — distinct purple tint
  // matches the gap-card / break treatment, signalling "this becomes
  // a break". Tap removes the current session; the next render auto-
  // detects the now-bigger gap and shows the booth-recommendation card.
  const freeTimeRow = `
    <div class="slot-swap-row slot-swap-free-time">
      <div class="slot-swap-row-main">
        <div class="slot-swap-row-title">Make this slot free time</div>
        <div class="slot-swap-row-meta">Skip a session — visit the floor, see booth recommendations instead</div>
      </div>
      <button class="slot-swap-row-btn outlined" onclick="planMakeSlotFreeTime('${escHtml(currentId)}');document.getElementById('planSlotSwapModal')?.remove()" type="button"><svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M17 8h1a4 4 0 0 1 0 8h-1"/><path d="M3 8h14v9a4 4 0 0 1-4 4H7a4 4 0 0 1-4-4V8z"/><line x1="6" y1="2" x2="6" y2="4"/><line x1="10" y1="2" x2="10" y2="4"/><line x1="14" y1="2" x2="14" y2="4"/></svg> Free up slot</button>
    </div>`;

  const candidatesHtml = scored.length === 0
    ? '<div style="color:var(--text-muted);font-size:14px;padding:12px 0">No other sessions at this time slot.</div>'
    : scored.map(({ session: s, match: m }) => {
        const inPlan = planIds.has(s.session_id);
        const swapTags = whyMatched(s, _plan || {}, m.bucket);
        const tagsHtml = swapTags.length
          ? `<div class="checklist-why-tags">${swapTags.map(t => `<span class="checklist-why-tag">${escHtml(t.text)}</span>`).join('')}</div>`
          : '';
        return `
          <div class="slot-swap-row${inPlan ? ' already-in-plan' : ''}">
            <div class="slot-swap-row-main">
              <div class="slot-swap-row-title">${escHtml(s.title || '')}</div>
              <div class="slot-swap-row-meta">${escHtml(s.theatre || '')}${s.start_time ? ' · ' + escHtml(s.start_time) : ''}</div>
              ${renderMatchBadge({ bucket: m.bucket, rank: m.rank, type: 'session', compact: true })}
              ${tagsHtml}
              ${inPlan ? '<span class="slot-swap-already-tag">Already in your plan</span>' : ''}
            </div>
            ${inPlan
              ? '<button class="slot-swap-row-btn disabled" disabled>In plan</button>'
              : `<button class="slot-swap-row-btn outlined" onclick="planSwapSession('${escHtml(currentId)}','${escHtml(s.session_id)}');document.getElementById('planSlotSwapModal')?.remove()" type="button"><svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="17 1 21 5 17 9"/><path d="M3 11V9a4 4 0 0 1 4-4h14"/><polyline points="7 23 3 19 7 15"/><path d="M21 13v2a4 4 0 0 1-4 4H3"/></svg> Swap</button>`
            }
          </div>`;
      }).join('');
  let modal = document.getElementById('planSlotSwapModal');
  if (modal) modal.remove();
  modal = document.createElement('div');
  modal.id = 'planSlotSwapModal';
  modal.className = 'login-modal slot-swap-modal open';
  modal.innerHTML = `
    <div class="login-modal-backdrop" onclick="document.getElementById('planSlotSwapModal')?.remove()"></div>
    <div class="login-modal-panel slot-swap-panel">
      <button class="login-modal-close" onclick="document.getElementById('planSlotSwapModal')?.remove()" aria-label="Close" type="button">
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
      </button>
      <div class="login-modal-eyebrow">${escHtml(dayLabel)} · ${escHtml(current.start_time || '')}–${escHtml(current.end_time || '')}</div>
      <h2 class="login-modal-title">Edit this <em>slot.</em></h2>
      <p class="login-modal-sub">Currently: <strong style="color:var(--text);">${escHtml(current.title || '')}</strong>. Swap for another session, or free the slot for booth visits.</p>
      <div class="slot-swap-list">${freeTimeRow}${candidatesHtml}</div>
    </div>`;
  document.body.appendChild(modal);
};

// Free up a session slot — removes it from plan. The next render's gap
// detection will auto-show a break card with booth recommendations.
window.planMakeSlotFreeTime = function(sessionId) {
  if (!_plan) return;
  const s = (_plan.sessions || []).find(x => x.session_id === sessionId);
  if (!s) return;
  _plan.sessions = (_plan.sessions || []).filter(x => x.session_id !== sessionId);
  savePlanSessions();
  renderApp();
};

// Routes the in-card × through the in-app confirm modal so the user
// gets a clear "are you sure?" before the RPC fires. Note: any team
// member can remove any other (including the lead) — that's how the
// remove_team_member SECURITY DEFINER function is written.
window.planConfirmRemoveTeamMember = function(userId, name) {
  planShowConfirm({
    title: 'Remove from team',
    body: `Remove <strong>${escHtml(name || 'this teammate')}</strong> from your team workspace? They'll lose access to the team's plan, notes, and ratings. They can rejoin if you re-invite them.`,
    confirmLabel: 'Remove',
    confirmTone: 'danger',
    onConfirm: () => window.planRemoveTeamMember(userId),
  });
};

window.planRemoveTeamMember = async function(userId) {
  const { data, error } = await supabase.rpc('remove_team_member', { p_user_id: userId });
  if (error || data?.error) {
    console.error('remove_team_member error:', error || data?.error);
    showError('Could not remove team member. Please try again.');
    return;
  }
  if (_teamData) {
    _teamData.members   = _teamData.members.filter(m => m.users?.id !== userId);
    _teamData.teamPlans = _teamData.teamPlans.filter(p => p.user_id !== userId);
  }
  renderApp();
};

// Shared markup for the send button — body of innerHTML reused after
// resetting the .sending state. Keep in sync with the inline render.
const _SEND_INVITE_BTN_HTML = `<svg class="team-invite-send-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="2" y="4" width="20" height="16" rx="2"/><path d="M22 6 12 13 2 6"/></svg><span class="team-invite-send-label">Send invite</span>`;

// Core send routine — runs both the initial Send and the Resend path.
// Resend skips reading the input (email comes from the pending list),
// so we don't disturb whatever the user has typed for the next invite.
async function _sendTeamInvite(email, opts = {}) {
  const status = document.getElementById('team-invite-status');
  const btn    = document.querySelector('.team-invite-send-btn');

  if (!email || !email.includes('@') || !email.includes('.')) {
    if (status) { status.textContent = 'Please enter a valid email address.'; status.className = 'team-invite-status error'; }
    return false;
  }
  if (email === _authUser?.email) {
    if (status) { status.textContent = 'That\'s your own email address.'; status.className = 'team-invite-status error'; }
    return false;
  }
  if (!_teamData?.inviteToken) {
    if (status) { status.textContent = 'Team not ready yet — please try again.'; status.className = 'team-invite-status error'; }
    return false;
  }

  if (opts.fromInputBtn && btn) {
    btn.disabled = true;
    btn.classList.add('sending');
    btn.innerHTML = `<span class="team-invite-send-label">Sending…</span>`;
  }

  const redirectTo = `${window.location.origin}/magic-link-confirm/?team=${_teamData.inviteToken}&`;
  const { error } = await sendMagicLink(email, redirectTo);

  if (opts.fromInputBtn && btn) {
    btn.disabled = false;
    btn.classList.remove('sending');
    btn.innerHTML = _SEND_INVITE_BTN_HTML;
  }

  if (error) {
    if (status) { status.textContent = `Could not send invite: ${error.message}`; status.className = 'team-invite-status error'; }
    return false;
  }

  rememberPendingInvite(email);
  if (status) { status.textContent = `${opts.resend ? 'Resent' : 'Invite sent'} to ${email}`; status.className = 'team-invite-status success'; }
  setTimeout(() => { if (status) status.textContent = ''; }, 5000);
  return true;
}

window.planSendInvite = async function() {
  const input = document.getElementById('team-invite-email');
  const email = (input?.value || '').trim().toLowerCase();
  const ok = await _sendTeamInvite(email, { fromInputBtn: true });
  if (ok && input) input.value = '';
  if (ok) renderApp(); // refresh so the new pending row appears
};

window.planResendInvite = async function(email) {
  const ok = await _sendTeamInvite(email, { resend: true });
  if (ok) renderApp(); // bumps the "sent X ago" timestamp + reorders
};

window.planCancelPendingInvite = function(email) {
  forgetPendingInvite(email);
  renderApp();
};

// ── Demo mode (no auth, no DB) ────────────────────────────────────────────────
async function initDemoMode() {
  const log = (step, detail) => console.log(`[plan/demo] ${step}` + (detail ? ` — ${detail}` : ''));
  try {
    log('start');
    showLoading(true);
    const [allSessions, allExhibitors] = await Promise.all([
      fetch('/data/programme.json').then(r => r.json()).catch(e => { log('programme.json fetch failed', e.message); return []; }),
      fetch('/data/exhibitors.json').then(r => r.json()).catch(e => { log('exhibitors.json fetch failed', e.message); return []; }),
    ]);
    log('fetched', `sessions=${allSessions.length} booths=${allExhibitors.length}`);

    // Pick the first 11 sessions across both days (chronological), and the
    // first 8 booths. Matches the dummy ranking arrays so the bucket badges
    // line up with the SESSION_PLAN_DUMMY / BOOTH_PLAN_DUMMY positions.
    const sessions = [...(allSessions || [])]
      .filter(s => s.title && s.day && s.start_time)
      .sort((a, b) => {
        const da = a.day === 'Day 1' ? 1 : 2;
        const db = b.day === 'Day 1' ? 1 : 2;
        return da - db || (a.start_time || '').localeCompare(b.start_time || '');
      })
      .slice(0, 11)
      .map((s, i) => ({ ...s, rank: i + 1 }));
    const booths = [...(allExhibitors || [])]
      .filter(e => e.company_name)
      .slice(0, 8)
      .map((b, i) => ({ ...b, rank: i + 1 }));

    _authUser    = { id: 'demo-user', email: 'demo@autoevent.io', is_anonymous: false };
    _userProfile = { first_name: 'Demo', last_name: 'User', company: 'Demo Firm Ltd' };
    _allSessions = allSessions || [];
    _allExhibitors = allExhibitors || [];
    _plan = {
      id: 'demo-plan',
      user_id: 'demo-user',
      team_id: 'demo-team',
      attend_mode: 'team-lead',
      problem: 'AI — where to even start, Margin squeeze, MTD volume problem',
      categories: ['practice-mgmt', 'tax-mtd', 'ai-automation'],
      role: 'founder',
      sessions,
      booths,
      ai_themes: [],
      notes: [],
    };

    // Stub team with the demo user + 2 fake teammates so the Team tab
    // shows its full populated state (AI synthesis, who's-going-and-why,
    // etc.). Real users get a team auto-created on first sign-in; demo
    // skips auth, so we fake one here.
    //
    // Critical for the Checklist team-rated-row to show: each teammate's
    // plan must contain sessions/booths whose IDs MATCH items in the
    // user's plan (renderTeamRatedRow keys by session_id / stand_number).
    // Both Sarah's and James's plans now overlap with the user's plan.
    const planSess = sessions;
    const planBooths = booths;
    const planSessIds = planSess.map(s => s.session_id);
    const planBoothNums = planBooths.map(b => String(b.stand_number));
    const teamPlanFor = (uid, problem, categories, role, sessIds, boothNums, sessRatings = {}, boothRatings = {}) => ({
      id: `demo-plan-${uid}`,
      user_id: uid,
      problem,
      categories,
      role,
      sessions: (allSessions || [])
        .filter(s => sessIds.includes(s.session_id))
        .map(s => ({ ...s, rating: sessRatings[s.session_id] || 0 })),
      booths: (allExhibitors || [])
        .filter(e => boothNums.includes(String(e.stand_number)))
        .map(e => ({ ...e, rating: boothRatings[String(e.stand_number)] || 0 })),
      ai_themes: [],
    });
    const hoursAgo = (h) => new Date(Date.now() - h * 3600000).toISOString();
    // Sarah's session ratings — overlap with the user's plan so the
    // team-rated row surfaces. Uses planSessIds[0..5] — i.e. her plan
    // contains the user's first 6 sessions, with ratings on 4 of them.
    const sarahSessIds = planSessIds.slice(0, 6);
    const sarahSessRatings = {
      [planSessIds[0]]: 3, // 🔥🔥🔥
      [planSessIds[1]]: 2, // 🔥🔥
      [planSessIds[3]]: 3,
      [planSessIds[5]]: 1, // 🔥
    };
    // James — overlaps differently, rates a different mix
    const jamesSessIds = planSessIds.slice(0, 7);
    const jamesSessRatings = {
      [planSessIds[0]]: 3, // also rated by Sarah → row shows BOTH
      [planSessIds[2]]: 2,
      [planSessIds[4]]: 3,
      [planSessIds[6]]: 2,
    };
    // Booth ratings — Sarah on 3, James on 2. planBooths[0] gets rated
    // by both so the user sees a multi-rater row on it.
    const sarahBoothNums = planBoothNums.slice(0, 4);
    const sarahBoothRatings = {
      [planBoothNums[0]]: 3,
      [planBoothNums[2]]: 2,
      [planBoothNums[3]]: 3,
    };
    const jamesBoothNums = planBoothNums.slice(0, 3);
    const jamesBoothRatings = {
      [planBoothNums[0]]: 2,
      [planBoothNums[1]]: 1,
    };
    _teamData = {
      teamId: 'demo-team',
      company: 'Demo Firm Ltd',
      inviteToken: 'demo-invite-token',
      members: [
        { role: 'lead',   joined_at: new Date(Date.now() - 86400000 * 3).toISOString(),
          users: { id: 'demo-user', first_name: 'Demo', last_name: 'User', company: 'Demo Firm Ltd' } },
        { role: 'member', joined_at: new Date(Date.now() - 86400000 * 2).toISOString(),
          users: { id: 'demo-sarah', first_name: 'Sarah', last_name: 'Reid', company: 'Demo Firm Ltd' } },
        { role: 'member', joined_at: new Date(Date.now() - 86400000 * 1).toISOString(),
          users: { id: 'demo-james', first_name: 'James', last_name: 'O’Connor', company: 'Demo Firm Ltd' } },
      ],
      teamPlans: [
        _plan,
        teamPlanFor('demo-sarah',
          'Slow client onboarding, AML / KYC pressure, Document chaos',
          ['aml-onboarding', 'doc-mgmt', 'practice-mgmt'],
          'senior',
          sarahSessIds, sarahBoothNums,
          sarahSessRatings, sarahBoothRatings),
        teamPlanFor('demo-james',
          'Margin squeeze, Charging for advice, Stuck in compliance',
          ['proposals', 'forecasting', 'practice-mgmt'],
          'partner',
          jamesSessIds, jamesBoothNums,
          jamesSessRatings, jamesBoothRatings),
      ],
      // Variety of team notes — chip-prefixed and free-form, on both
      // sessions and booths. Several items deliberately carry 5+ notes
      // so the "See all N →" overflow link is visible immediately.
      allNotes: [
        // ── Session 0 (6 notes from both teammates → overflow) ──────
        planSess[0] && {
          plan_id: `demo-plan-demo-sarah`, item_type: 'session', item_id: planSess[0].session_id,
          note_text: '🔥 Game-changer: speakers nailed the AML angle — exactly what we\'ve been wrestling with for our top-50 clients.',
          created_by: 'demo-sarah', created_at: hoursAgo(28),
        },
        planSess[0] && {
          plan_id: `demo-plan-demo-james`, item_type: 'session', item_id: planSess[0].session_id,
          note_text: '📝 To do: pull the slide on workflow automation, share with the partner group on Friday.',
          created_by: 'demo-james', created_at: hoursAgo(20),
        },
        planSess[0] && {
          plan_id: `demo-plan-demo-sarah`, item_type: 'session', item_id: planSess[0].session_id,
          note_text: '💡 Idea: run a 30-min internal lunch-and-learn from this — could replace our Q3 training session entirely.',
          created_by: 'demo-sarah', created_at: hoursAgo(14),
        },
        planSess[0] && {
          plan_id: `demo-plan-demo-james`, item_type: 'session', item_id: planSess[0].session_id,
          note_text: '🧠 Made me think: we\'re probably 6 months behind where the speaker said the leading firms are.',
          created_by: 'demo-james', created_at: hoursAgo(10),
        },
        planSess[0] && {
          plan_id: `demo-plan-demo-sarah`, item_type: 'session', item_id: planSess[0].session_id,
          note_text: '❤️ Loved it: speaker is on LinkedIn, dropped them a connect — would be great to bring in for our December offsite.',
          created_by: 'demo-sarah', created_at: hoursAgo(6),
        },
        planSess[0] && {
          plan_id: `demo-plan-demo-james`, item_type: 'session', item_id: planSess[0].session_id,
          note_text: '📝 To do: cross-check their compliance framework against ours, bring deltas to next leadership meeting.',
          created_by: 'demo-james', created_at: hoursAgo(2),
        },
        // ── Session 1 (1 note inline only) ─────────────────────────
        planSess[1] && {
          plan_id: `demo-plan-demo-james`, item_type: 'session', item_id: planSess[1].session_id,
          note_text: '🧠 Made me think: are we overcomplicating our pricing model? Worth a partner conversation.',
          created_by: 'demo-james', created_at: hoursAgo(4),
        },
        // ── Session 2 (5 notes → overflow) ─────────────────────────
        planSess[2] && {
          plan_id: `demo-plan-demo-sarah`, item_type: 'session', item_id: planSess[2].session_id,
          note_text: '💡 Idea: that anecdote about the rollout failure → we should pre-empt the same pattern with our 2026 plan.',
          created_by: 'demo-sarah', created_at: hoursAgo(22),
        },
        planSess[2] && {
          plan_id: `demo-plan-demo-james`, item_type: 'session', item_id: planSess[2].session_id,
          note_text: '🔥 Game-changer: clearest articulation of advisory pricing I\'ve seen at any conference.',
          created_by: 'demo-james', created_at: hoursAgo(15),
        },
        planSess[2] && {
          plan_id: `demo-plan-demo-sarah`, item_type: 'session', item_id: planSess[2].session_id,
          note_text: 'Liked the framing of "outcomes vs deliverables" — we\'ve been pricing the wrong thing.',
          created_by: 'demo-sarah', created_at: hoursAgo(11),
        },
        planSess[2] && {
          plan_id: `demo-plan-demo-james`, item_type: 'session', item_id: planSess[2].session_id,
          note_text: '📝 To do: redraft our top 3 engagement letters using the framework before quarter-end.',
          created_by: 'demo-james', created_at: hoursAgo(7),
        },
        planSess[2] && {
          plan_id: `demo-plan-demo-sarah`, item_type: 'session', item_id: planSess[2].session_id,
          note_text: '👎 Skip it: their case study client felt cherry-picked. Skip if you\'re tight on time.',
          created_by: 'demo-sarah', created_at: hoursAgo(3),
        },
        // ── Session 3 (free-form, single note) ─────────────────────
        planSess[3] && {
          plan_id: `demo-plan-demo-sarah`, item_type: 'session', item_id: planSess[3].session_id,
          note_text: 'Wasn\'t expecting this to land but the practical examples on data migration were spot on. Will recommend to the implementation team.',
          created_by: 'demo-sarah', created_at: hoursAgo(2),
        },
        // ── Session 5 (3 notes — under cap, all visible inline) ────
        planSess[5] && {
          plan_id: `demo-plan-demo-james`, item_type: 'session', item_id: planSess[5].session_id,
          note_text: '🔍 Look into: their AI sandbox demo — feels relevant for our Q1 internal pilot.',
          created_by: 'demo-james', created_at: hoursAgo(26),
        },
        planSess[5] && {
          plan_id: `demo-plan-demo-sarah`, item_type: 'session', item_id: planSess[5].session_id,
          note_text: '💡 Idea: book a follow-up call with the speaker — they\'re open to small-firm consulting.',
          created_by: 'demo-sarah', created_at: hoursAgo(9),
        },
        planSess[5] && {
          plan_id: `demo-plan-demo-james`, item_type: 'session', item_id: planSess[5].session_id,
          note_text: '🧠 Made me think: do our junior team actually need a separate AI literacy programme?',
          created_by: 'demo-james', created_at: hoursAgo(1),
        },
        // ── Booth 0 (5 notes → overflow) ───────────────────────────
        planBooths[0] && {
          plan_id: `demo-plan-demo-sarah`, item_type: 'booth', item_id: String(planBooths[0].stand_number),
          note_text: '🔥 Best in show: easily the slickest demo we saw. Their integration story with our practice mgmt stack is exactly what we need.',
          created_by: 'demo-sarah', created_at: hoursAgo(30),
        },
        planBooths[0] && {
          plan_id: `demo-plan-demo-james`, item_type: 'booth', item_id: String(planBooths[0].stand_number),
          note_text: '🔍 Look into: pricing tier 3 + bulk client onboarding — they hinted at a partner programme worth exploring.',
          created_by: 'demo-james', created_at: hoursAgo(22),
        },
        planBooths[0] && {
          plan_id: `demo-plan-demo-sarah`, item_type: 'booth', item_id: String(planBooths[0].stand_number),
          note_text: '❤️ Love it: their CEO walked us through the roadmap — Q3 release lines up with our migration window.',
          created_by: 'demo-sarah', created_at: hoursAgo(13),
        },
        planBooths[0] && {
          plan_id: `demo-plan-demo-james`, item_type: 'booth', item_id: String(planBooths[0].stand_number),
          note_text: '📅 Demo booked for next Tuesday with their solution architect — Sarah, James, and ops on the call.',
          created_by: 'demo-james', created_at: hoursAgo(8),
        },
        planBooths[0] && {
          plan_id: `demo-plan-demo-sarah`, item_type: 'booth', item_id: String(planBooths[0].stand_number),
          note_text: '🔍 Look into: ask about migration support during pilot — would be a deal-breaker if we have to fund it.',
          created_by: 'demo-sarah', created_at: hoursAgo(3),
        },
        // ── Booth 1 — single skip note ─────────────────────────────
        planBooths[1] && {
          plan_id: `demo-plan-demo-james`, item_type: 'booth', item_id: String(planBooths[1].stand_number),
          note_text: '👎 Skip: same playbook as last year. No real differentiation from incumbents.',
          created_by: 'demo-james', created_at: hoursAgo(5),
        },
        // ── Booth 2 (4 notes — exactly at cap, no overflow) ────────
        planBooths[2] && {
          plan_id: `demo-plan-demo-sarah`, item_type: 'booth', item_id: String(planBooths[2].stand_number),
          note_text: '🤔 Maybe: tech is interesting but their UK support story isn\'t there yet. Re-evaluate next year.',
          created_by: 'demo-sarah', created_at: hoursAgo(24),
        },
        planBooths[2] && {
          plan_id: `demo-plan-demo-james`, item_type: 'booth', item_id: String(planBooths[2].stand_number),
          note_text: '⏱ Not now: pricing is right but onboarding effort doesn\'t fit our 2026 roadmap. Keep on watchlist.',
          created_by: 'demo-james', created_at: hoursAgo(16),
        },
        planBooths[2] && {
          plan_id: `demo-plan-demo-sarah`, item_type: 'booth', item_id: String(planBooths[2].stand_number),
          note_text: 'Liked the founder. Worth a coffee even if we don\'t use the product right now.',
          created_by: 'demo-sarah', created_at: hoursAgo(11),
        },
        planBooths[2] && {
          plan_id: `demo-plan-demo-james`, item_type: 'booth', item_id: String(planBooths[2].stand_number),
          note_text: '🤔 Maybe: their analytics module is genuinely better than ours, but the rest is a downgrade.',
          created_by: 'demo-james', created_at: hoursAgo(4),
        },
        // ── Booth 3 (single short note) ────────────────────────────
        planBooths[3] && {
          plan_id: `demo-plan-demo-sarah`, item_type: 'booth', item_id: String(planBooths[3].stand_number),
          note_text: '❤️ Love it: by far our favourite team to talk to. Genuine, knowledgeable, no sales pitch.',
          created_by: 'demo-sarah', created_at: hoursAgo(2),
        },
      ].filter(Boolean),
    };

    // Demo ratings on the user's own plan items so the Debrief tab has
    // hot sessions/booths to surface (rating the user gave plus team
    // ratings inferred from teamPlans above).
    if (planSess[0]) planSess[0].rating = 3;
    if (planSess[2]) planSess[2].rating = 2;
    if (planSess[5]) planSess[5].rating = 3;
    if (planBooths[0]) planBooths[0].rating = 3;
    if (planBooths[2]) planBooths[2].rating = 2;

    log('renderApp');
    showLoading(false);
    renderApp();
    log('done');
  } catch (err) {
    console.error('[plan/demo] error:', err);
    showLoading(false);
    showError(`Demo mode failed: ${err?.message || err}`);
  }
}

// ── Entry point ───────────────────────────────────────────────────────────────

export async function initPlan() {
  const hashParams = new URLSearchParams(window.location.hash.slice(1));
  const qpParams   = new URLSearchParams(window.location.search);
  const errCode    = hashParams.get('error_code') || qpParams.get('error_code');
  const errDesc    = hashParams.get('error_description') || qpParams.get('error_description');
  const teamToken  = qpParams.get('team') || localStorage.getItem('pendingTeamToken') || null;

  // Visible step trace in the console — open DevTools to see where load
  // hangs if something goes wrong. Each step logs as `[plan] STEP — detail`.
  const log = (step, detail) => console.log(`[plan] ${step}` + (detail ? ` — ${detail}` : ''));
  log('init', `pathname=${window.location.pathname} search=${window.location.search}`);

  // Reset escape hatch: /plan/?reset=1 clears local state + signs out so a
  // user can recover from a borked session. Useful when a stale anon
  // session or pending-plan blob is messing with the auth flow.
  if (qpParams.has('reset')) {
    log('reset', 'clearing localStorage + signing out');
    try { await supabase.auth.signOut(); } catch (e) { /* ignore */ }
    localStorage.removeItem('pendingPlan');
    localStorage.removeItem('pendingPlanId');
    localStorage.removeItem('pendingTeamToken');
    window.location.replace('/plan/');
    return;
  }

  // Demo mode: /plan/?demo (any value, or no value) — bypasses auth + DB
  // and renders the live app with a stubbed plan built from the static
  // programme + exhibitor data. Lets devs (and Matty) eyeball UI changes
  // without going through wizard + magic-link auth on every browser session.
  if (qpParams.has('demo')) {
    log('demo', 'entering initDemoMode');
    await initDemoMode();
    return;
  }

  if (errCode) {
    const headline = errCode === 'otp_expired'
      ? 'Your magic link has expired or was already used.'
      : (errDesc ? decodeURIComponent(errDesc.replace(/\+/g, ' ')) : 'Authentication failed.');
    showReauthForm(headline);
    return;
  }

  showLoading(true);

  // Belt-and-braces: any time the page is still empty + spinner-only after
  // 12s, fall back to the re-auth form. Catches verifyOtp hangs, network
  // stalls, and silent auth failures without leaving the user staring at
  // a spinner forever. The callback itself checks whether plan-root has
  // already rendered — if it has, this is a no-op. So we never need to
  // explicitly clear the timer; it self-cancels on success.
  setTimeout(() => {
    const root = $('plan-root');
    if (root && root.innerHTML.trim() === '') {
      showLoading(false);
      showReauthForm('Taking too long. Enter your email below to get a fresh link.');
    }
  }, 12000);

  const tokenHash = qpParams.get('token_hash');
  if (tokenHash) {
    log('token_hash', 'calling verifyOtp');
    let verifyResult;
    try {
      verifyResult = await Promise.race([
        supabase.auth.verifyOtp({
          token_hash: tokenHash,
          type: qpParams.get('type') || 'magiclink',
        }),
        new Promise((_, reject) => setTimeout(() => reject(new Error('verify_timeout')), 8000)),
      ]);
      log('verifyOtp', verifyResult?.error ? `error=${verifyResult.error.message}` : 'ok');
    } catch (e) {
      console.warn('[plan] verifyOtp failed/timeout:', e?.message);
      verifyResult = { data: null, error: e };
    }

    let resolvedUser = verifyResult?.data?.user || null;
    if (!resolvedUser) {
      log('fallback', 'verifyOtp empty → checking existing session');
      const existing = await getUser();
      if (existing && !existing.is_anonymous) resolvedUser = existing;
    }

    if (!resolvedUser) {
      log('reauth', 'no user resolved');
      showReauthForm('Your link has expired or was already used. Enter your email below to get a fresh one.');
      return;
    }

    const cleanUrl = new URL(window.location.href);
    cleanUrl.searchParams.delete('token_hash');
    cleanUrl.searchParams.delete('type');
    history.replaceState(null, '', cleanUrl.toString());
    showLoading(false);
    log('handleSignIn', `userId=${resolvedUser.id} anon=${resolvedUser.is_anonymous}`);
    await handleSignIn(resolvedUser, teamToken);
    return;
  }

  log('getUser', 'no token_hash, checking existing session');
  const user = await getUser();
  log('getUser', user ? `id=${user.id} anon=${user.is_anonymous}` : 'no user');

  if (user && !user.is_anonymous) {
    showLoading(false);
    log('handleSignIn', 'authenticated user');
    await handleSignIn(user, teamToken);
    return;
  }

  // For anonymous users or no session: keep the auth listener alive.
  // When a magic link is clicked the anonymous session is upgraded to an
  // authenticated one, firing SIGNED_IN — we must be listening for that.
  const unsubscribe = onAuthChange(async (event, authUser) => {
    if ((event === 'SIGNED_IN' || event === 'USER_UPDATED') && authUser) {
      unsubscribe();
      showLoading(false);
      await handleSignIn(authUser, teamToken);
    }
  });

  if (user && user.is_anonymous) {
    // Show the anonymous user's plan right away (team tab won't show until
    // they authenticate, but the checklist is visible immediately).
    showLoading(false);
    await handleSignIn(user, teamToken);
  }
}
