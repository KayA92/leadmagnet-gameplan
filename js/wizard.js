import { selectSessions, selectBooths } from './selection.js';
import { signInAnon, getUser, sendMagicLink } from './auth.js';
import { supabase } from './supabase.js';

// ── State ─────────────────────────────────────────────────────────────────────
const state = {
  stage: '0',
  answers: {
    attendMode: 'team-lead',
    problem: '',
    pains: [],
    categories: [],
    time: [],
    role: null,
    roleBucket: null,
    firmSize: null,
    mode: null,
    precisionScore: 0,
  },
  user: { firstName: '', lastName: '', email: '', company: '' },
  plan: null,
  teamInviteToken: null,
  filteredSessions: [],
  filteredExhibitors: [],
  allSessions: [],
  allExhibitors: [],
};
window._state = state;

const FLOW_STAGES = new Set(['0', '2', '5b', '7']);
const Q_STAGES    = ['1', '2', '3', '4', '5', '5b']; // for progress dots
const STAGE_HASH  = { '1':'q1','2':'q2','3':'q3','4':'q4','5':'q5','5b':'q5b','7':'preview','75':'save' };
const HASH_STAGE  = Object.fromEntries(Object.entries(STAGE_HASH).map(([k,v]) => [v, k]));

// ── Helpers ───────────────────────────────────────────────────────────────────
function $(id) { return document.getElementById(id); }
function wait(ms) { return new Promise(r => setTimeout(r, ms)); }
function escHtml(s) {
  return String(s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;')
    .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
function shuffleArray(arr) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

// ── Stage transitions ─────────────────────────────────────────────────────────
function goToStage(n, fromHistory = false) {
  const id = String(n);

  // Deactivate current
  const cur = $(`stage-${state.stage}`);
  if (cur) cur.classList.remove('active');

  // Activate next
  const next = $(`stage-${id}`);
  if (next) next.classList.add('active');

  state.stage = id;

  // Body classes
  document.body.classList.remove('flow-active', 'hero-active', 'app-active');
  if (id === '0') document.body.classList.add('hero-active', 'flow-active');
  if (FLOW_STAGES.has(id)) document.body.classList.add('flow-active');

  // Reset scroll on both window and the stage element itself (covers fixed + absolute stages,
  // and works around iOS Safari ignoring synchronous window.scrollTo during layout changes).
  if (next) next.scrollTop = 0;
  document.body.scrollTop = 0;
  document.documentElement.scrollTop = 0;
  window.scrollTo(0, 0);
  setTimeout(() => { window.scrollTo(0, 0); document.body.scrollTop = 0; }, 0);
  updateProgress();

  // Push/replace URL hash so browser back works (stages 6 and email-sent are excluded)
  if (!fromHistory) {
    const hash = STAGE_HASH[id];
    if (hash) {
      history.pushState({ stage: id }, '', `#${hash}`);
    } else if (id === '0') {
      history.replaceState({ stage: '0' }, '', location.pathname + location.search);
    }
  }

  if (id === '5b') prepareStage5b();
  if (id === '6') startReveal();
  if (id === '7') renderPlanPreview();
}

function updateProgress() {
  const dots = document.querySelectorAll('.progress-dot');
  const stageIndex = Q_STAGES.indexOf(state.stage);
  dots.forEach((dot, i) => {
    dot.classList.remove('done', 'current');
    if (i < stageIndex) dot.classList.add('done');
    else if (i === stageIndex) dot.classList.add('current');
  });
}

// ── Reveal animation (stage 6) ────────────────────────────────────────────────
// Cycling list of thinking-style status updates. The previous 4-step fixed
// schedule stuck on "Auto-selecting your best picks…" after 3.8s — for the
// remainder of the API call (often 5–10s) the user saw a frozen line and
// thought the page was hanging. Cycling through varied messages every ~1.6s
// makes the wait feel like the AI is actively reasoning, not stalled.
const STATUS_MESSAGES = [
  'Scanning every session…',
  'Reading speaker bios so you don\'t have to…',
  'Matching theatres to your mission…',
  'Cross-referencing your pain points…',
  'Hmm — interesting candidates emerging…',
  'Scoring exhibitors by your categories…',
  'Asking: which booth actually solves this?',
  'Weighing AI hype against AI ROI…',
  'Sifting compliance theatre from substance…',
  'Pulling in role-specific tracks…',
  'Calibrating to your firm size…',
  'Ruling out time-slot clashes…',
  'Catching the pinned must-see sessions…',
  'Promoting booths worth queuing for…',
  'Asking: is this signal or noise?',
  'Stitching your CPD hours together…',
  'Deciding what to drop, what to keep…',
  'Double-checking against your top priorities…',
  'Mapping booths to your tech stack…',
  'Sorting growth sessions from compliance ones…',
  'Distilling 240+ down to your shortlist…',
  'Auto-selecting your best picks…',
  'Locking in the final order…',
  'Almost ready — finishing up…',
];
let _statusCycleId = null;

function startStatusCycle() {
  const el = $('revealStatusText');
  if (!el) return;
  let i = 0;
  el.textContent = STATUS_MESSAGES[0];
  _statusCycleId = setInterval(() => {
    i = (i + 1) % STATUS_MESSAGES.length;
    el.textContent = STATUS_MESSAGES[i];
  }, 1600);
}

function stopStatusCycle() {
  if (_statusCycleId) { clearInterval(_statusCycleId); _statusCycleId = null; }
}

function startTicker() {
  const el = $('reveal-ticker');
  if (!el) return;
  // Pick 16 unique sessions then duplicate the list. The CSS scrolls
  // translateY(0 → -50%) so when it loops back, items 16–31 are
  // identical to 0–15 → no visible "jump" at the wrap point even when
  // the API takes longer than one scroll cycle.
  const unique = shuffleArray([...state.allSessions]).slice(0, 16);
  const sessions = [...unique, ...unique];
  el.innerHTML = sessions.map(s => {
    const score = Math.random();
    const scoreClass = score > 0.75 ? '' : score > 0.45 ? 'mid' : 'low';
    const scoreLabel = score > 0.75 ? 'HIGH' : score > 0.45 ? 'MED' : 'LOW';
    const speaker = s.speakers && s.speakers[0] ? s.speakers[0].name : '';
    return `<div class="ticker-item"><span class="ticker-theatre">${escHtml(s.theatre || '')}</span><span class="ticker-title">${escHtml(s.title)}</span><span class="ticker-speaker">${escHtml(speaker)}</span><span class="ticker-score ${scoreClass}">${scoreLabel}</span></div>`;
  }).join('');
}

function stopTicker() {
  const el = $('reveal-ticker');
  if (el) el.innerHTML = '';
}

// Asymptote-style progress: bar creeps toward 95% indefinitely so it
// never appears done before scoring finishes. Avoids the "bar's done but
// I'm still waiting — is this broken?" feel.
let _progressId = null;
function startProgress() {
  const bar = $('reveal-progress-fill');
  if (!bar) return;
  let pct = 0;
  bar.style.width = '0%';
  _progressId = setInterval(() => {
    pct = pct + (95 - pct) * 0.015;
    bar.style.width = pct + '%';
  }, 100);
}
function stopProgress() {
  if (_progressId) { clearInterval(_progressId); _progressId = null; }
  const bar = $('reveal-progress-fill');
  if (bar) bar.style.width = '100%';
}


// Builds the 11-session preview array:
//   • Ranks 1–3 always shown (top matches)
//   • 4 randomly chosen from high-bucket sessions (full pool)
//   • 4 randomly chosen from medium-bucket sessions (full pool, excluding high picks)
//   • Sorted by AI rank, then deconflicted by wizard caller
function buildPreviewSessions(allRanked) {
  const ranked = allRanked
    .filter(s => typeof s._rank === 'number')
    .sort((a, b) => a._rank - b._rank);

  // Explicitly draw from each bucket so the preview always shows 3+4+4
  const topPicks    = ranked.filter(s => s._bucket === 'top').slice(0, 3);
  const usedIds     = new Set(topPicks.map(s => s.session_id));

  const highPool    = shuffleArray(ranked.filter(s => s._bucket === 'high' && !usedIds.has(s.session_id)));
  const highPicks   = highPool.slice(0, 4);
  highPicks.forEach(s => usedIds.add(s.session_id));

  const mediumPool  = shuffleArray(ranked.filter(s => s._bucket === 'medium' && !usedIds.has(s.session_id)));
  const mediumPicks = mediumPool.slice(0, 4);

  return [...topPicks, ...highPicks, ...mediumPicks]
    .sort((a, b) => a._rank - b._rank)
    .map((s, i) => ({ ...s, rank: i + 1, match: { bucket: s._bucket || 'neutral', rank: s._rank } }));
}

function deconflictSessions(rankedItems, allSessions) {
  const placed = [];
  for (const item of rankedItems) {
    const s = allSessions.find(x => x.session_id === item.session_id);
    if (!s || !s.start_time || !s.end_time) { placed.push(item); continue; }
    const clashes = placed.some(p => {
      const ps = allSessions.find(x => x.session_id === p.session_id);
      if (!ps || ps.day !== s.day) return false;
      return ps.start_time < s.end_time && ps.end_time > s.start_time;
    });
    if (!clashes) placed.push(item);
  }
  return placed;
}

// Builds the preview booth array. Two paths:
//
// Path A — Workiro is top/high/medium:
//   Exclude Workiro from the general pool, take one fewer from their bucket,
//   insert Workiro, sort by rank → 11 total.
//
// Path B — Workiro is neutral:
//   Full 3/4/4 from all non-Workiro exhibitors, append Workiro as 12th → 12 total.
function buildPreviewBooths(allRanked) {
  const ranked = allRanked
    .filter(e => typeof e._rank === 'number')
    .sort((a, b) => a._rank - b._rank);

  const workiro = allRanked.find(e => e.is_host);
  const bucket  = workiro?._bucket || 'neutral';

  // General pool always excludes Workiro — their slot is handled per path
  const general = ranked.filter(e => !e.is_host);

  function pick3_4_4(pool, topN, highN, mediumN) {
    const topPicks  = pool.filter(e => e._bucket === 'top').slice(0, topN);
    const usedNames = new Set(topPicks.map(e => e.company_name));

    // Draw high and medium from shuffled remainder — top-ranked exhibitors often
    // cluster in 'high', so restricting by rank leaves no medium candidates.
    const rest        = shuffleArray(pool.filter(e => !usedNames.has(e.company_name)));
    const highPicks   = rest.filter(e => e._bucket === 'high').slice(0, highN);
    highPicks.forEach(e => usedNames.add(e.company_name));
    const mediumPicks = rest.filter(e => e._bucket === 'medium' && !usedNames.has(e.company_name)).slice(0, mediumN);

    return [...topPicks, ...highPicks, ...mediumPicks];
  }

  let display;

  if (bucket === 'neutral') {
    // Path B: full 3/4/4, Workiro bolted on as 12th
    display = pick3_4_4(general, 3, 4, 4);
    if (workiro) display.push(workiro);
  } else {
    // Path A: one fewer slot in Workiro's bucket, insert Workiro, sort by rank
    const topN    = bucket === 'top'    ? 2 : 3;
    const highN   = bucket === 'high'   ? 3 : 4;
    const mediumN = bucket === 'medium' ? 3 : 4;
    display = pick3_4_4(general, topN, highN, mediumN);
    if (workiro) display.push(workiro);
    display.sort((a, b) => a._rank - b._rank);
  }

  return display.map((e, i) => ({ ...e, rank: i + 1, match: { bucket: e._bucket || 'neutral', rank: i + 1 } }));
}


async function startReveal() {
  state.filteredSessions   = selectSessions(state.answers, state.allSessions);
  state.filteredExhibitors = selectBooths(state.answers, state.allExhibitors);

  startTicker();
  startProgress();
  startStatusCycle();

  const sessions = buildPreviewSessions(state.filteredSessions);
  const booths   = buildPreviewBooths(state.filteredExhibitors);
  state.plan = { sessions, booths, themes: [] };

  await wait(5000);

  stopProgress();
  stopStatusCycle();
  stopTicker();

  await wait(300);
  goToStage(7);
}

// ── Plan preview rendering (stage 7) ─────────────────────────────────────────
const TICK_SVG = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>';

// ── Match bucket + ranking display model ─────────────────────────────────
// 4-tier bucket replaces raw % everywhere (top / high / medium / neutral).
// Display: bucket label pill + "#3 of 240". Tier palette mirrors Stage 1
// heat bands (pink → coral → amber → cool-blue) so users decode without
// a legend. NEUTRAL is browse-only; the user's plan only contains
// top / high / medium picks per the spec.
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
const HIDDEN_ALT_DUMMY = { bucket: 'high', count: 3, ranks: [14, 17, 21] };

function dummyMatchByPlanRank(rankInPlan, type) {
  const arr = type === 'booth' ? BOOTH_PLAN_DUMMY : SESSION_PLAN_DUMMY;
  if (!Number.isFinite(rankInPlan) || rankInPlan < 1) return arr[arr.length - 1];
  return arr[Math.min(rankInPlan - 1, arr.length - 1)];
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

function matchTotal(type) {
  if (type === 'booth') return (state.allExhibitors?.length) || FALLBACK_MATCH_TOTAL.booth;
  return (state.allSessions?.length) || FALLBACK_MATCH_TOTAL.session;
}

function renderMatchBadge({ bucket, rank, type, compact = false, hostStar = false }) {
  const total   = matchTotal(type);
  const sparkle = bucket === 'top'
    ? '<svg class="match-bucket-icon" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M12 0 L13.5 10.5 L24 12 L13.5 13.5 L12 24 L10.5 13.5 L0 12 L10.5 10.5 Z"/></svg>'
    : '';
  const labelText = hostStar ? 'Host Platform' : bucketLabel(bucket);
  const rankLine  = hostStar
    ? `<span class="match-rank">Ranked ★ of ${total}</span>`
    : `<span class="match-rank">Ranked #${rank} of ${total}</span>`;
  return `<div class="match-badge tier-${bucket}${compact ? ' compact' : ''}">
    <span class="match-bucket">${sparkle}<span class="match-bucket-text">${labelText}</span></span>
    ${rankLine}
  </div>`;
}

function renderPlanPreview() {
  const container = $('plan-preview-content');
  if (!container || !state.plan) return;

  const { sessions: rankedSessions = [], booths: rankedBooths = [] } = state.plan;
  const cpdHours = (rankedSessions.length * 40 / 60).toFixed(1);

  // Quiet tuned-to-you line — single sentence acknowledging what the user
  // gave us, without recapping it back chip-by-chip. Numbers do the
  // trust-building work; firm context is a catch-all for role + firm
  // size + (owner) mode so we don't enumerate every dimension.
  const painCount = (state.answers.pains || []).length;
  const toolCount = (state.answers.categories || []).length;
  const painLabel = painCount === 1 ? '1 pain' : `${painCount} pains`;
  const toolLabel = toolCount === 1 ? '1 tool' : `${toolCount} tools`;
  const tunedLine = toolCount > 0
    ? `Tuned to your ${painLabel}, ${toolLabel}, and firm context.`
    : `Tuned to your ${painLabel} and firm context.`;

  // Resolve sessions + booths separately so we can drop the
  // HIDDEN ALTERNATIVES teaser between them.
  const sessionItems = [];
  rankedSessions.forEach(item => {
    const s = state.allSessions.find(x => x.session_id === item.session_id);
    if (s) sessionItems.push({ ...s, ...item });
  });
  const boothItems = [];
  rankedBooths.forEach(item => {
    const b = state.allExhibitors.find(
      x => x.stand_number === item.stand_number || x.company_name === item.company_name,
    );
    // Merge ranked data (rank, _rank, _score, _problemNorm etc.) onto the full exhibitor object
    if (b) boothItems.push({ ...b, ...item });
  });

  const renderSession = (s, i) => {
    const dayNum = s.day === 'Day 1' ? 1 : 2;
    const timeStr = s.start_time ? `Day ${dayNum} · ${s.start_time} · ${escHtml(s.theatre || '')}` : escHtml(s.theatre || '');
    const bucket = s._bucket || (s.match && s.match.bucket) || 'neutral';
    const rank   = typeof s._rank === 'number' ? s._rank : (i + 1);
    const m = { bucket, rank };
    return `<div class="mini-item" style="animation-delay:${i * 80}ms;">
      <div class="mini-tick">${TICK_SVG}</div>
      <div class="mini-body">
        <div class="mini-title">${escHtml(s.title)}</div>
        <div class="mini-meta"><span class="type-pill session">Session</span>${timeStr}</div>
      </div>
      ${renderMatchBadge({ bucket: m.bucket, rank: m.rank, type: 'session' })}
    </div>`;
  };

  const renderBooth = (b, i, animIndex) => {
    const displayRank = typeof b._rank === 'number' ? b._rank : (i + 1);
    const bucket = b._bucket || 'neutral';
    const standNum = (b.stand_number || '').toString().replace(/\.$/, '').trim();
    const hostNote = b.is_host
      ? `<div class="mini-meta mini-host-line"><span class="type-pill booth">We created this app</span></div>`
      : '';
    return `<div class="mini-item booth-card${b.is_host ? ' host-booth' : ''}" style="animation-delay:${animIndex * 80}ms;">
      <div class="mini-tick">${TICK_SVG}</div>
      <div class="mini-body">
        <div class="mini-title">${escHtml(b.company_name)}</div>
        <div class="mini-meta"><span class="type-pill booth">Booth</span>Stand ${escHtml(standNum)}</div>
        ${hostNote}
      </div>
      ${renderMatchBadge({ bucket, rank: displayRank, type: 'booth' })}
    </div>`;
  };

  const sessionsListHtml = sessionItems.map(renderSession).join('');
  const boothsListHtml = boothItems
    .map((b, i) => renderBooth(b, i, sessionItems.length + i))
    .join('');

  const topPickCount      = rankedSessions.length;
  const sessionsTotal     = state.allSessions?.length    || 240;
  const boothsTotal       = state.allExhibitors?.length  || 90;
  const highRankedCount   = (state.filteredSessions || []).filter(s => s._bucket !== 'neutral').length;
  const hiddenAlternativesHtml = `
    <div class="hidden-alternatives">
      <div class="hidden-alt-eyebrow">
        <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M12 0 L13.5 10.5 L24 12 L13.5 13.5 L12 24 L10.5 13.5 L0 12 L10.5 10.5 Z"/></svg>
        All ${sessionsTotal} sessions are ranked for you — activate your plan for full access
      </div>
      <p class="hidden-alt-body">
        You're seeing <strong>${topPickCount}</strong> of the <strong>${highRankedCount} sessions</strong> AI ranked highly for your practice. Every session and booth is scored and ranked — all waiting in your active plan, ready to explore and share with your team.
      </p>
      <button class="hidden-alt-cta" type="button" onclick="document.getElementById('preview-save')?.click()">
        Activate my plan
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><line x1="5" y1="12" x2="19" y2="12"/><polyline points="12 5 19 12 12 19"/></svg>
      </button>
    </div>
  `;

  container.innerHTML = `
    <div class="confirm-header">
      <div class="confirm-eyebrow">
        <span style="width:6px;height:6px;border-radius:50%;background:var(--mint);box-shadow:0 0 8px var(--mint);"></span>
        Our AI ran the room · ${rankedSessions.length + rankedBooths.length} picks
      </div>
      <h2 class="confirm-title">240+ sessions read.<br>Your <em>shortlist of ${rankedSessions.length}</em>,<br>ready to go.</h2>
      <p class="confirm-tuned">${escHtml(tunedLine)}</p>
      <div class="confirm-summary-pills">
        <div class="confirm-pill mint"><strong>${rankedSessions.length}</strong> sessions</div>
        <div class="confirm-pill pink"><strong>${cpdHours}</strong> CPD hours</div>
        <div class="confirm-pill"><strong>${rankedBooths.length}</strong> priority booths</div>
      </div>
    </div>

    <div class="confirm-preview-section">
      <div class="confirm-preview-header">
        <div class="confirm-preview-title">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>
          The sessions &amp; booths our AI picked for you
        </div>
      </div>
      <div class="confirm-preview-banner">
        <span class="confirm-preview-tag">Preview</span>
        To change anything, tap 'Activate my plan' below. That's where you untick, swap, search for more, or invite teammates.
      </div>
      <div class="mini-item-list">
        ${sessionsListHtml}
        ${hiddenAlternativesHtml}
        ${boothsListHtml}
      </div>
    </div>

    <div style="height:20px;"></div>
  `;
}


// ── Stage 3: category toggle ──────────────────────────────────────────────────
function toggleCategory(cat) {
  const idx = state.answers.categories.indexOf(cat);
  if (idx >= 0) {
    state.answers.categories.splice(idx, 1);
  } else {
    state.answers.categories.push(cat);
  }
  // Update button state. Stage 3 is optional — Next stays clickable
  // even with zero picks (some attendees aren't booth-shopping at all).
  document.querySelectorAll('[data-cat]').forEach(btn => {
    const active = state.answers.categories.includes(btn.dataset.cat);
    btn.classList.toggle('selected', active);
  });
}

// ── Save form (stage 75) ──────────────────────────────────────────────────────
async function handleSaveSubmit(e) {
  e.preventDefault();
  const btn = $('save-btn');
  btn.disabled = true;
  btn.textContent = 'Activating…';

  const firstName     = $('inp-first').value.trim();
  const lastName      = $('inp-last').value.trim();
  const email         = $('inp-email').value.trim();
  const company       = $('inp-company').value.trim();
  const marketingOptIn = $('inp-marketing')?.checked ?? false;

  state.user = { firstName, lastName, email, company, marketingOptIn };

  const enrichedSessions = (state.plan?.sessions || []).map(ranked => {
    const full = state.allSessions.find(s => s.session_id === ranked.session_id);
    return full ? { ...full, ...ranked } : ranked;
  });
  const enrichedBooths = (state.plan?.booths || []).map(ranked => {
    const full = state.allExhibitors.find(
      ex => ex.stand_number === ranked.stand_number || ex.company_name === ranked.company_name,
    );
    return full ? { ...full, ...ranked } : ranked;
  });

  // localStorage safety net — plan.js picks this up when the link is clicked on the same device
  localStorage.setItem('pendingPlan', JSON.stringify({
    answers: state.answers,
    user: state.user,
    sessions: enrichedSessions,
    booths: enrichedBooths,
    themes: state.plan?.themes || [],
  }));

  // Persist the invite token separately so plan.js can call join_team even if
  // Supabase strips the ?team= query param from the magic link redirect URL.
  if (state.teamInviteToken) {
    localStorage.setItem('pendingTeamToken', state.teamInviteToken);
  }

  try {
    // Sign in anonymously and write to DB immediately (data safe even if link expires)
    let userId;
    const existing = await getUser();
    if (existing?.is_anonymous) {
      // Reuse existing anon session — user went back mid-wizard without completing
      userId = existing.id;
    } else {
      // If an authenticated user is present (e.g. a different user on the same browser),
      // sign them out first so this wizard run gets a clean anonymous session and
      // doesn't overwrite their profile or create a duplicate plan under their account.
      if (existing) await supabase.auth.signOut();
      const { data, error } = await signInAnon();
      if (error) throw error;
      userId = data.user.id;
    }

    const { error: userErr } = await supabase.from('users').upsert(
      {
        id: userId,
        email,
        first_name: firstName,
        last_name: lastName,
        company: company || null,
        // GDPR: only set when user actively ticks the opt-in card. Schema needs a
        // `marketing_opt_in BOOLEAN DEFAULT FALSE` column on public.users — dev to add.
        marketing_opt_in: marketingOptIn,
      },
      { onConflict: 'id' },
    );
    if (userErr) throw userErr;

    const { data: savedPlan, error: planErr } = await supabase.from('plans').insert({
      user_id:     userId,
      attend_mode: state.answers.attendMode,
      problem:     state.answers.problem,
      categories:  state.answers.categories,
      time_window: state.answers.time,
      role:        state.answers.role,
      pains:       state.answers.pains     || [],
      firm_size:   state.answers.firmSize  || null,
      firm_mode:   state.answers.mode      || null,
      sessions:    enrichedSessions,
      booths:      enrichedBooths,
      ai_themes:   state.plan?.themes || [],
    }).select('id').single();
    if (planErr) throw planErr;
    localStorage.setItem('pendingPlanId', savedPlan.id);
    // Team creation happens on the plan page after the user authenticates via magic link,
    // because the teams table requires an authenticated (non-anonymous) session.
  } catch (dbErr) {
    const errEl = $('save-error');
    if (errEl) {
      errEl.textContent = `Save failed: ${dbErr?.message || dbErr?.details || String(dbErr)}`;
      errEl.style.display = 'block';
    }
    console.error('DB save error:', dbErr);
    btn.disabled = false;
    btn.textContent = 'Unlock my game plan';
    return;
  }

  // Always forward the invite token if present — even if the member mistakenly selected
  // "team-lead" in the wizard, the ?team= param ensures join_team runs on the plan page
  // and attaches them to the correct team rather than creating a new one.
  const redirectTo = state.teamInviteToken
    ? `${window.location.origin}/magic-link-confirm/?team=${state.teamInviteToken}&`
    : undefined;
  const { error: emailErr } = await sendMagicLink(email, redirectTo);
  if (emailErr) {
    btn.disabled = false;
    btn.textContent = 'Unlock my game plan';
    const errEl = $('save-error');
    if (errEl) {
      errEl.textContent = emailErr.message || 'Something went wrong. Please try again.';
      errEl.style.display = 'block';
    }
    return;
  }

  goToStage('email-sent');
  const sentEmail = $('sent-email');
  if (sentEmail) sentEmail.textContent = email;

}

// ── Pain tags + precision bar (Stage 1) ────────────────────────────────────────
// Synthesises state.answers.problem from selected pain labels into a readable string.
const PAIN_LABELS = {
  // SCORCHING (8)
  'ai-start':'AI — where to even start','ai-data-mess':'Data mess blocking AI',
  'mtd-volume':'MTD volume problem','mtd-clients':'Clients not MTD-ready',
  'margin':'Margin squeeze','hiring':"Can't find good staff",
  'retention':'Losing staff to other firms','burnout':'Workload & burnout',
  // HOT (14)
  'docs':'Document chaos','chasing':'Chasing clients for records',
  'defensible-files':'Audit-ready client files','aml':'AML / KYC pressure',
  'disconnected':'Disconnected tech stack','ai-roi':'AI — proving the ROI',
  'advisory':'Stuck in compliance','advisory-charge':'Charging for advice',
  'winning':'Winning new clients','ai-team':'AI — team adoption',
  'cyber':'Cyber threats / phishing','penalties':'MTD penalty regime',
  'frs102':'FRS 102 transition','portal':'Portal adoption / clients hate it',
  // WARM (9)
  'ai-govern':'AI governance & risk','ai-skills':'AI skills gap',
  'onboarding':'Slow client onboarding','month-end':'Month-end close is brutal',
  'bankfeeds':'Unreliable bank feeds','cpd':'CPD & team development',
  'career':'Murky career path','leadership':'Leadership skills gap',
  'cashflow':'Late payments / debtor days',
  // SPECIALIST (6)
  'pe':'PE consolidation closing in','exit':'Exit / succession planning',
  'outsource':'Outsourcing & offshore','niche':'Should I niche?',
  'cross-border':'Cross-border clients','rd':'R&D claims / specialist tax',
};

function togglePain(slug) {
  const idx = state.answers.pains.indexOf(slug);
  if (idx >= 0) state.answers.pains.splice(idx, 1);
  else state.answers.pains.push(slug);
  document.querySelectorAll('.pain-tag').forEach(btn => {
    btn.classList.toggle('selected', state.answers.pains.includes(btn.dataset.pain));
  });
  // Synthesise problem string for backwards-compatible matcher input
  state.answers.problem = state.answers.pains.map(p => PAIN_LABELS[p] || p).join(', ');
  $('problem-next') && ($('problem-next').disabled = state.answers.pains.length < PAIN_UNLOCK);
  updatePrecisionBars();
}

// Stage-1 pain progress model — coaching bar with zones:
//   0    → empty       (tap your problems · 3+ to unlock)
//   1-2  → pre-unlock  (tap N more to unlock)
//   3    → unlock crossing — markers flash
//   3-5  → unlocked    (matches unlocked · tap more for sharper picks)
//   6    → sharp crossing — full bar pulse + sparkle
//   6-12 → sharp zone  (✦ Sharp zone · the AI's read is at its best)
//  13-15 → post-sharp  (Strong list · the AI's still focused)
//  16    → too-many crossing — bar shifts amber
//  16+   → too-many    (Picking a lot — try focusing on real top problems)
//
// Bar scale runs 0-16 pains = 0-100%. Past 16 the fill caps so it doesn't
// keep growing and never feel punishing.
const PAIN_BAR_MAX  = 16;
const PAIN_UNLOCK   = 3;
const PAIN_SHARP_LO = 6;
const PAIN_SHARP_HI = 12;
function computePainProgress() {
  const n = state.answers.pains.length;
  const percent = Math.min(100, (n / PAIN_BAR_MAX) * 100);
  let label, zone;
  if (n === 0) {
    label = 'Tap 3+ to start matching';
    zone  = 'empty';
  } else if (n < PAIN_UNLOCK) {
    label = `${PAIN_UNLOCK - n} more to start matching`;
    zone  = 'pre-unlock';
  } else if (n < PAIN_SHARP_LO) {
    label = 'Unlocked · keep tapping to hit the sweet spot';
    zone  = 'unlocked';
  } else if (n <= PAIN_SHARP_HI) {
    label = '✦ You’re in the sweet spot';
    zone  = 'sharp';
  } else if (n < PAIN_BAR_MAX) {
    label = 'Still in the sweet spot';
    zone  = 'post-sharp';
  } else {
    label = 'Too many — stick to your real top problems';
    zone  = 'too-many';
  }
  return { percent, label, zone, n };
}

// Track the previous zone across calls so we can fire one-time crossing
// animations (unlock flash, sharp pulse, too-many warning).
let _previousPainZone = 'empty';

function prepareStage5b() {
  // Re-apply visual selection state on revisits
  document.querySelectorAll('.firm-pill').forEach(b => {
    b.classList.toggle('selected', b.dataset.firm === state.answers.firmSize);
  });
  document.querySelectorAll('.mode-pill').forEach(b => {
    b.classList.toggle('selected', b.dataset.mode === state.answers.mode);
  });
  // Mode section: only owners see it. Locked until firm size is picked.
  const modeEl = $('firm-mode-section');
  if (modeEl) {
    const isOwner = state.answers.roleBucket === 'owner';
    modeEl.hidden = !isOwner;
    modeEl.classList.toggle('locked', !state.answers.firmSize);
  }
  const nextBtn = $('firm-next');
  if (nextBtn) nextBtn.disabled = !state.answers.firmSize;
}

function updatePrecisionBars() {
  const { percent, label, zone, n } = computePainProgress();
  state.answers.precisionScore = percent;
  const bar = $('precision-bar-stage1');
  if (!bar) return;
  const fill = bar.querySelector('.precision-bar-fill');
  const stateEl = bar.querySelector('.precision-bar-state');
  if (fill) fill.style.width = percent + '%';
  if (stateEl) stateEl.textContent = label;
  bar.classList.toggle('active', n > 0);
  bar.dataset.zone = zone;
  // One-time crossing animations — only fire when we cross INTO a zone
  // from below (not when untapping back through it).
  const prev = _previousPainZone;
  const order = ['empty', 'pre-unlock', 'unlocked', 'sharp', 'post-sharp', 'too-many'];
  const movedForward = order.indexOf(zone) > order.indexOf(prev);
  if (movedForward) {
    if (zone === 'unlocked') {
      bar.classList.add('flash-unlock');
      setTimeout(() => bar.classList.remove('flash-unlock'), 500);
    } else if (zone === 'sharp') {
      bar.classList.add('flash-sharp');
      setTimeout(() => bar.classList.remove('flash-sharp'), 700);
    } else if (zone === 'too-many') {
      bar.classList.add('flash-toomany');
      setTimeout(() => bar.classList.remove('flash-toomany'), 500);
    }
  }
  _previousPainZone = zone;
}

// ── Popularity ranking ────────────────────────────────────────────────────────
// Counts canonical_categories across loaded sessions + exhibitors, then injects
// a count badge into every chip / option that has a matching data-cat, and
// reorders the elements within their parent so the most-covered categories
// appear first. Top 3 get a "hot" highlight. No-op if data isn't loaded.
function decorateAndRankByCategory() {
  if (!state.allSessions?.length && !state.allExhibitors?.length) return;
  const counts = {};
  const bump = (slug, key) => {
    if (!counts[slug]) counts[slug] = { sessions: 0, exhibitors: 0, total: 0 };
    counts[slug][key] += 1;
    counts[slug].total += 1;
  };
  for (const s of state.allSessions || []) {
    for (const cat of s.canonical_categories || []) bump(cat, 'sessions');
  }
  for (const e of state.allExhibitors || []) {
    for (const cat of e.canonical_categories || []) bump(cat, 'exhibitors');
  }

  // Lucide-style flame SVG, used as the "hot" prefix marker on top-tier chips.
  const FLAME_SVG = '<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M8.5 14.5A2.5 2.5 0 0 0 11 12c0-1.38-.5-2-1-3-1.072-2.143-.224-4.054 2-6 .5 2.5 2 4.9 4 6.5 2 1.6 3 3.5 3 5.5a7 7 0 1 1-14 0c0-1.153.433-2.294 1-3a2.5 2.5 0 0 0 2.5 2.5z"/></svg>';

  const decorate = (selector, useFlamePrefix) => {
    const els = Array.from(document.querySelectorAll(selector));
    if (els.length === 0) return;
    for (const el of els) {
      const cat = el.dataset.cat;
      el.dataset.count = counts[cat]?.total || 0;
    }
    // Sort descending by count, then re-attach in order.
    const sorted = [...els].sort((a, b) =>
      (Number(b.dataset.count) || 0) - (Number(a.dataset.count) || 0),
    );
    const parent = els[0].parentNode;
    for (const el of sorted) parent.appendChild(el);

    // Three rank-based tiers — hot top 3, then 50/50 warm/cool below.
    // The chip/option itself carries the heat (border, glow, opacity);
    // hot chips also get an inline flame icon as the "go here first" marker.
    const len = sorted.length;
    const warmCutoff = Math.max(3, Math.ceil(len / 2));
    sorted.forEach((el, i) => {
      el.classList.remove('cat-tier-hot', 'cat-tier-warm', 'cat-tier-cool');
      const tier = i < 3 ? 'hot' : i < warmCutoff ? 'warm' : 'cool';
      el.classList.add(`cat-tier-${tier}`);

      // Strip any previously-injected flame so re-renders don't stack
      const oldFlame = el.querySelector('.cat-flame');
      if (oldFlame) oldFlame.remove();
      // Hot chips get a flame prefix — universal "this is hot" symbol,
      // no caption needed.
      if (useFlamePrefix && tier === 'hot') {
        const flame = document.createElement('span');
        flame.className = 'cat-flame';
        flame.innerHTML = FLAME_SVG;
        el.insertBefore(flame, el.firstChild);
      }
    });
  };

  // No stage-3 popularity sort — categories are now grouped into 3 sections
  // (CORE PLATFORMS / CLIENT WORK / GROWTH & STRATEGY) with curated order.
  // The new slugs also don't yet exist in canonical_categories.
}

// ── Init ──────────────────────────────────────────────────────────────────────
export async function initWizard() {
  // Clear any stale hash from a previous session so we always start at stage 0
  if (window.location.hash) history.replaceState(null, '', location.pathname + location.search);

  // If arriving via a team invite link, store the token for later use on save
  const _urlParams = new URLSearchParams(window.location.search);
  const pendingTeamToken = _urlParams.get('team');
  if (pendingTeamToken) state.teamInviteToken = pendingTeamToken;

  // Pre-populate save-form email when the invite link includes ?email=ENCODED
  const _emailParam = _urlParams.get('email');
  if (_emailParam) {
    state.user.email = decodeURIComponent(_emailParam);
    const _emailInput = document.getElementById('inp-email');
    if (_emailInput) _emailInput.value = state.user.email;
  }

  // Load data files
  try {
    const [progRes, exhRes] = await Promise.all([
      fetch('/data/programme.json'),
      fetch('/data/exhibitors.json'),
    ]);
    state.allSessions = await progRes.json();
    state.allExhibitors = await exhRes.json();
  } catch (err) {
    console.error('Failed to load data files:', err);
  }

  // ── Decorate Stage 2 chips + Stage 3 categories with live popularity counts
  // (sessions + exhibitors per canonical category) and reorder by descending
  // count so the most-covered topics are surfaced first. Gives users immediate
  // signal about what the show is heaviest on, before they invest in answers.
  decorateAndRankByCategory();

  // ── Stage 0: hero CTA
  $('hero-start')?.addEventListener('click', () => goToStage(2));

  // ── Stage 2: pain points (heat-banded tag selection)
  document.querySelectorAll('.pain-tag').forEach(btn => {
    btn.addEventListener('click', () => togglePain(btn.dataset.pain));
  });
  $('problem-back')?.addEventListener('click', () => history.back());
  $('problem-next')?.addEventListener('click', () => {
    if (state.answers.pains.length >= PAIN_UNLOCK) goToStage(3);
  });
  updatePrecisionBars();

  // ── Stage 3: categories
  document.querySelectorAll('#stage-3 .tag-pill[data-cat]').forEach(btn => {
    btn.addEventListener('click', () => toggleCategory(btn.dataset.cat));
  });
  $('cat-back')?.addEventListener('click', () => history.back());
  // Stage 3 is optional — Next always advances. Zero picks is a valid
  // signal (attendee not booth-shopping at all).
  $('cat-next')?.addEventListener('click', () => goToStage(4));

  // ── Stage 4: availability (radio-per-day — one slot per day, both days independent)
  document.querySelectorAll('[data-time]').forEach(btn => {
    btn.addEventListener('click', () => {
      const val    = btn.dataset.time;
      const prefix = val.startsWith('wed') ? 'wed' : 'thu';
      const wasSelected = btn.classList.contains('selected');
      // Deselect all slots for the same day
      state.answers.time = state.answers.time.filter(t => !t.startsWith(prefix));
      document.querySelectorAll(`[data-time^="${prefix}"]`).forEach(b => b.classList.remove('selected'));
      // If it wasn't already selected, select it now (clicking same slot again deselects)
      if (!wasSelected) {
        state.answers.time.push(val);
        btn.classList.add('selected');
      }
      $('time-next').disabled = state.answers.time.length === 0;
    });
  });
  $('time-back')?.addEventListener('click', () => history.back());
  $('time-next')?.addEventListener('click', () => {
    if (state.answers.time.length > 0) goToStage(5);
  });
  $('time-next') && ($('time-next').disabled = true);

  // ── Stage 5: role (single-select with bucket capture)
  document.querySelectorAll('[data-role]').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('[data-role]').forEach(b => b.classList.remove('selected'));
      btn.classList.add('selected');
      state.answers.role = btn.dataset.role;
      state.answers.roleBucket = btn.dataset.bucket || null;
      $('role-next').disabled = false;
    });
  });
  $('role-back')?.addEventListener('click', () => history.back());
  $('role-next')?.addEventListener('click', () => {
    if (state.answers.role) goToStage('5b');
  });
  $('role-next') && ($('role-next').disabled = true);

  // ── Stage 5b: firm size + (owners-only) mode
  document.querySelectorAll('[data-firm]').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('[data-firm]').forEach(b => b.classList.remove('selected'));
      btn.classList.add('selected');
      state.answers.firmSize = btn.dataset.firm;
      // Unlock the mode section (only matters for owners — for others it stays hidden)
      $('firm-mode-section')?.classList.remove('locked');
      $('firm-next').disabled = false;
    });
  });
  document.querySelectorAll('[data-mode]').forEach(btn => {
    btn.addEventListener('click', () => {
      const wasSelected = btn.classList.contains('selected');
      document.querySelectorAll('[data-mode]').forEach(b => b.classList.remove('selected'));
      // Toggle off if user clicks the already-selected pill — mode is
      // optional, so unclicking should clear the answer.
      if (wasSelected) {
        state.answers.mode = null;
      } else {
        btn.classList.add('selected');
        state.answers.mode = btn.dataset.mode;
      }
    });
  });
  $('firm-back')?.addEventListener('click', () => history.back());
  $('firm-next')?.addEventListener('click', () => {
    if (state.answers.firmSize) goToStage(6);
  });

  // ── Stage 7: save CTA
  $('preview-save')?.addEventListener('click', () => goToStage(75));
  $('preview-back')?.addEventListener('click', () => history.back());

  // ── Stage 75: save form
  $('save-form')?.addEventListener('submit', handleSaveSubmit);
  // Unlock-chips ('Rate sessions', 'CPD log', etc.) sit above the
  // form looking interactive — users do tap them. Make those taps
  // feel useful: focus the first name field so the form takes over
  // and the user is one keystroke from completing the unlock.
  document.querySelectorAll('.save-unlock-chip').forEach(chip => {
    chip.addEventListener('click', () => {
      const first = $('inp-first');
      if (!first) return;
      first.focus();
      // Smooth scroll the form into view on mobile in case the chip
      // tap happened above the fold and the input is below it.
      first.scrollIntoView({ behavior: 'smooth', block: 'center' });
    });
  });

  // Handle browser back/forward
  window.addEventListener('popstate', () => {
    const hash    = window.location.hash.slice(1);
    const stageId = HASH_STAGE[hash] || '0';
    // If preview is requested but plan isn't in memory (e.g. after reload), reset to start
    if (stageId === '7' && !state.plan) {
      history.replaceState(null, '', location.pathname);
      goToStage('0', true);
      return;
    }
    goToStage(stageId, true);
  });

  // Show stage 0
  goToStage('0');
}
