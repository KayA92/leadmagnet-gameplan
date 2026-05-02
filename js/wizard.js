import { preFilterSessions, preFilterExhibitors } from './filter.js';
import { matchSessions } from './api.js';
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
const STATUS_STEPS = [
  { t: 200,  text: 'Scanning every session…' },
  { t: 1400, text: 'Matching theatres to your mission…' },
  { t: 2600, text: 'Scoring exhibitors by your categories…' },
  { t: 3800, text: 'Auto-selecting your best picks…' },
];
let _statusTimers = [];

function startTicker() {
  const el = $('reveal-ticker');
  if (!el) return;
  const sessions = shuffleArray([...state.allSessions, ...state.allSessions]).slice(0, 16);
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
  _statusTimers.forEach(t => clearTimeout(t));
  _statusTimers = [];
}

async function animateProgress() {
  const bar = $('reveal-progress-fill');
  if (!bar) return;
  // Ease to 90% over 4s, then jump to 100% when done
  let pct = 0;
  const step = () => {
    pct = Math.min(pct + (90 - pct) * 0.025, 90);
    bar.style.width = pct + '%';
  };
  const id = setInterval(step, 80);
  await wait(4200);
  clearInterval(id);
  bar.style.width = '100%';
}

// Sessions guaranteed to appear when their trigger fires AND their time slot matches.
// Injected after AI ranking so they cannot be dropped by the model.
const PINNED_SESSIONS = [
  {
    sessionId: '36304',
    reason: 'Essential for your MTD priorities — covers the impact on un-represented clients.',
    detect: (a) => /\bmtd\b|making tax digital/i.test(a.problem) || a.categories.includes('tax-mtd'),
  },
  {
    sessionId: '36370',
    reason: 'A must-see MTD session covering the real-world IT challenges firms face right now.',
    detect: (a) => /\bmtd\b|making tax digital/i.test(a.problem) || a.categories.includes('tax-mtd'),
  },
  {
    titleMatch: 'MTD Therapy',
    reason: 'Matched to your MTD priorities — a frank, practitioner-led discussion on what\'s working.',
    detect: (a) => /\bmtd\b|making tax digital/i.test(a.problem) || a.categories.includes('tax-mtd'),
  },
  {
    sessionId: '36375',
    reason: 'Directly relevant to your margin and pricing challenges — a commercial thinking masterclass.',
    detect: (a) => /margin|pricing|\bprofitab/i.test(a.problem),
  },
];

const _TIME_FILTERS = {
  'wed-am':   { days: ['Day 1'], startBefore: '13:00', startFrom: null },
  'wed-pm':   { days: ['Day 1'], startBefore: null,    startFrom: '13:00' },
  'wed-full': { days: ['Day 1'], startBefore: null,    startFrom: null },
  'thu-am':   { days: ['Day 2'], startBefore: '13:00', startFrom: null },
  'thu-pm':   { days: ['Day 2'], startBefore: null,    startFrom: '13:00' },
  'thu-full': { days: ['Day 2'], startBefore: null,    startFrom: null },
};

function sessionMatchesTime(session, times) {
  const slots = (Array.isArray(times) ? times : [times]).map(t => _TIME_FILTERS[t]).filter(Boolean);
  if (slots.length === 0) return true;
  return slots.some(tf => {
    if (!tf.days.includes(session.day)) return false;
    if (tf.startBefore && session.start_time >= tf.startBefore) return false;
    if (tf.startFrom && session.start_time < tf.startFrom) return false;
    return true;
  });
}

function injectPinnedSessions(rankedItems, allSessions, answers) {
  const result = [...rankedItems];
  for (const pin of PINNED_SESSIONS) {
    if (!pin.detect(answers)) continue;
    const session = pin.sessionId
      ? allSessions.find(s => s.session_id === pin.sessionId)
      : allSessions.find(s => s.title && s.title.includes(pin.titleMatch));
    if (!session) continue;
    if (!sessionMatchesTime(session, answers.time)) continue;
    const alreadyIn = result.some(r => r.session_id === session.session_id);
    if (!alreadyIn) result.unshift({ session_id: session.session_id, rank: 0, reason: pin.reason });
  }
  return result;
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

function buildFallbackPlan() {
  const candidates = state.filteredSessions.slice(0, 20).map((s, i) => ({
    session_id: s.session_id,
    rank: i + 1,
    reason: 'Matched to your event priorities.',
  }));
  const withPinned = injectPinnedSessions(candidates, state.allSessions, state.answers);
  return {
    fallback: true,
    sessions: deconflictSessions(withPinned, state.allSessions).slice(0, 12),
    booths: state.filteredExhibitors.slice(0, 8).map((e, i) => ({
      company_name: e.company_name,
      stand_number: e.stand_number,
      rank: i + 1,
      reason: 'Aligned with your selected categories.',
    })),
    themes: [],
  };
}

async function startReveal() {
  state.filteredSessions = preFilterSessions(state.answers, state.allSessions);
  state.filteredExhibitors = preFilterExhibitors(state.answers, state.allExhibitors);

  startTicker();
  _statusTimers = STATUS_STEPS.map(({ t, text }) =>
    setTimeout(() => { const el = $('revealStatusText'); if (el) el.textContent = text; }, t),
  );

  const [apiResult] = await Promise.all([
    matchSessions(
      {
        attend_mode: state.answers.attendMode,
        problem: state.answers.problem,
        categories: state.answers.categories,
        time_window: state.answers.time,
        role: state.answers.role,
        first_name: '', // not collected yet at this point
      },
      state.filteredSessions,
      state.filteredExhibitors,
    ),
    animateProgress(),
  ]);

  stopTicker();

  if (!apiResult || apiResult.fallback || !Array.isArray(apiResult.sessions)) {
    state.plan = buildFallbackPlan();
  } else {
    const withPinned = injectPinnedSessions(apiResult.sessions, state.allSessions, state.answers);
    const deconflicted = deconflictSessions(withPinned, state.allSessions);
    const booths = apiResult.booths || [];
    const workiroEx = state.allExhibitors.find(e => e.company_name === 'Workiro');
    if (workiroEx && !booths.some(b => b.company_name === 'Workiro')) {
      booths.push({
        company_name: 'Workiro',
        stand_number: workiroEx.stand_number || '1144',
        rank: booths.length + 1,
        reason: 'The team behind this game plan — visit Stand 1144 to see how Workiro supports your practice.',
      });
    }
    state.plan = { ...apiResult, sessions: deconflicted, booths };
  }

  await wait(300); // brief pause for bar to reach 100%
  goToStage(7);
}

// ── Plan preview rendering (stage 7) ─────────────────────────────────────────
function renderPlanPreview() {
  const container = $('plan-preview-content');
  if (!container || !state.plan) return;

  const { sessions: rankedSessions = [], booths: rankedBooths = [] } = state.plan;
  const cpdHours = (rankedSessions.length * 40 / 60).toFixed(1);

  const problemPreview = state.answers.problem.length > 45
    ? state.answers.problem.substring(0, 43).trim() + '…'
    : state.answers.problem;

  const catLabels = {
    'practice-management': 'practice management',
    'ai-automation': 'AI & automation',
    'bookkeeping': 'bookkeeping',
    'tax-mtd': 'tax & MTD',
    'doc-management': 'document workflows',
    'payroll': 'payroll',
    'data-analytics': 'data analytics',
    'cyber-security': 'cyber security',
    'aml-kyc': 'AML / KYC',
    'hr-people': 'HR & leadership',
    'banking-payments': 'banking & payments',
    'outsourcing': 'outsourcing',
    'marketing-growth': 'marketing & growth',
    'just-looking': 'general inspiration',
  };
  const pickedCats = (state.answers.categories || []).map(c => catLabels[c] || c);
  const catStr = pickedCats.length === 0 ? 'general interest'
    : pickedCats.length === 1 ? pickedCats[0]
    : pickedCats.length === 2 ? pickedCats.join(' and ')
    : pickedCats.slice(0, -1).join(', ') + ' and ' + pickedCats.slice(-1);

  const whyExplanation = `Matched to &ldquo;<strong>${escHtml(problemPreview)}</strong>&rdquo; · prioritising <strong>${catStr}</strong>.`;

  const items = [];
  rankedSessions.forEach(item => {
    const s = state.allSessions.find(x => x.session_id === item.session_id);
    if (s) items.push({ type: 'session', data: s });
  });
  rankedBooths.forEach(item => {
    const b = state.allExhibitors.find(
      x => x.stand_number === item.stand_number || x.company_name === item.company_name,
    );
    if (b) items.push({ type: 'booth', data: b });
  });

  const miniListHtml = items.map((entry, i) => {
    const delay = i * 80;
    if (entry.type === 'session') {
      const s = entry.data;
      const dayNum = s.day === 'Day 1' ? 1 : 2;
      const timeStr = s.start_time ? `Day ${dayNum} · ${s.start_time} · ${escHtml(s.theatre || '')}` : escHtml(s.theatre || '');
      return `<div class="mini-item" style="animation-delay:${delay}ms;">
        <div class="mini-tick"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg></div>
        <div class="mini-body">
          <div class="mini-title">${escHtml(s.title)}</div>
          <div class="mini-meta"><span class="type-pill session">Session</span>${timeStr}</div>
        </div>
      </div>`;
    } else {
      const b = entry.data;
      const desc = (b.normalised_products || []).slice(0, 2).join(', ');
      const hostMark = b.is_host ? ` · <span style="color:var(--purple);font-size:11px;font-family:'JetBrains Mono',monospace;letter-spacing:0.1em;text-transform:uppercase;">Host partner</span>` : '';
      return `<div class="mini-item" style="animation-delay:${delay}ms;">
        <div class="mini-tick"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg></div>
        <div class="mini-body">
          <div class="mini-title">${escHtml(b.company_name)}${hostMark}</div>
          <div class="mini-meta"><span class="type-pill booth">Booth</span>Stand ${escHtml(b.stand_number || '')} · ${escHtml(desc)}</div>
        </div>
      </div>`;
    }
  }).join('');

  container.innerHTML = `
    <div class="confirm-header">
      <div class="confirm-eyebrow">
        <span style="width:6px;height:6px;border-radius:50%;background:var(--mint);box-shadow:0 0 8px var(--mint);"></span>
        Our AI ran the room · ${rankedSessions.length + rankedBooths.length} picks
      </div>
      <h2 class="confirm-title">250+ sessions read.<br>Your <em>shortlist of ${rankedSessions.length}</em>,<br>ready to go.</h2>
      <p class="confirm-sub">${whyExplanation}</p>
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
      <div style="font-size:12px;color:var(--text-muted);line-height:1.55;margin-bottom:16px;padding:10px 14px;background:rgba(255,255,255,0.02);border:1px solid var(--ink-3);border-radius:8px;font-family:'JetBrains Mono',monospace;letter-spacing:0.01em;">
        <span style="display:inline-block;background:var(--ink-3);color:var(--text);padding:2px 8px;border-radius:4px;font-size:10px;letter-spacing:0.12em;text-transform:uppercase;margin-right:8px;">Preview</span>
        Save your plan to unlock live rating, team notes, and your CPD log.
      </div>
      <div class="mini-item-list">
        ${miniListHtml}
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
  // Update button state
  document.querySelectorAll('[data-cat]').forEach(btn => {
    const active = state.answers.categories.includes(btn.dataset.cat);
    btn.classList.toggle('selected', active);
  });
  $('cat-next').disabled = state.answers.categories.length === 0;
}

// ── Save form (stage 75) ──────────────────────────────────────────────────────
async function handleSaveSubmit(e) {
  e.preventDefault();
  const btn = $('save-btn');
  btn.disabled = true;
  btn.textContent = 'Saving…';

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
// Synthesises state.answers.problem from selected pain labels so the existing
// matcher payload still receives semantic context without changing the API.
const PAIN_LABELS = {
  // SCORCHING (7)
  'mtd-volume':'MTD volume problem','mtd-clients':'Clients not MTD-ready',
  'hiring':"Can't find good staff",'retention':'Losing staff to other firms',
  'margin':'Margin squeeze','burnout':'Workload & burnout',
  'ai-start':'AI — where to even start',
  // HOT (12)
  'ai-roi':'AI — proving the ROI','ai-team':'AI — getting team to use it',
  'chasing':'Chasing clients for records','advisory':'Stuck in compliance, want advisory',
  'advisory-charge':"Can't get clients to pay for advice",'disconnected':'Disconnected tech stack',
  'aml':'AML / KYC pressure','winning':'Winning new clients',
  'cyber':'Cyber threats / phishing','frs102':'FRS 102 transition',
  'docs':'Document chaos','penalties':'New MTD penalty regime',
  // WARM (10)
  'ai-govern':'AI governance & risk','ai-skills':'AI skills gap on the team',
  'onboarding':'Client onboarding too slow','month-end':'Month-end close is brutal',
  'bankfeeds':'Bank feeds keep breaking','portal':'Portal adoption / clients hate it',
  'cpd':'CPD & team development','career':'My own career path is murky',
  'leadership':'Leadership skills gap','cashflow':'Late payments / debtor days',
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
  $('problem-next') && ($('problem-next').disabled = state.answers.pains.length === 0);
  updatePrecisionBars();
}

// Score model: pains 0..40, role bucket +25, firm size +20, mode +10. Capped 95.
function computePrecisionScore() {
  const a = state.answers;
  let s = 0;
  const n = a.pains.length;
  if (n >= 1) s += 12;
  if (n >= 2) s += 10;
  if (n >= 3) s += 8;
  if (n >= 4) s += 6;
  if (n >= 5) s += 4;
  if (a.roleBucket) s += 25;
  if (a.firmSize) s += 20;
  if (a.mode) s += 10;
  return Math.min(95, s);
}

function precisionStateLabel(score, stage) {
  if (stage === '2' && state.answers.pains.length === 0) return 'Pick 1+ to begin';
  if (score < 25) return 'Warming up';
  if (score < 50) return 'Tuning in';
  if (score < 75) return 'Locked on';
  return 'Razor-sharp';
}

// Bucket → context strip copy + smart firm-size suggestion
const BUCKET_CONTEXT = {
  owner:        { text: "Practice owner — we'll surface revenue, hiring and scaling tracks.", suggest: 'micro' },
  professional: { text: "Practice professional — we'll prioritise skill-building + workflow sessions.", suggest: 'small' },
  finance:      { text: "In-house finance — we'll surface CFO, reporting and FP&A tracks.", suggest: 'mid' },
  other:        { text: "We'll match you with broad-coverage sessions across the show.", suggest: 'micro' },
};

function prepareStage5b() {
  const bucket = state.answers.roleBucket || 'other';
  const cfg = BUCKET_CONTEXT[bucket] || BUCKET_CONTEXT.other;
  const strip = $('firm-context-strip');
  const txt = $('firm-context-text');
  if (strip) strip.dataset.bucket = bucket;
  if (txt) txt.textContent = cfg.text;
  // Smart-suggest badge — only shown if user hasn't already picked a firm size
  document.querySelectorAll('.firm-pill').forEach(b => b.classList.remove('smart-suggest-active'));
  if (!state.answers.firmSize) {
    const target = document.querySelector(`.firm-pill[data-firm="${cfg.suggest}"]`);
    if (target) target.classList.add('smart-suggest-active');
  }
  // Mode section: only "unlocked" (full opacity) for owners. Others still see it
  // but it stays subdued — a softer reveal once they pick a firm size.
  const modeEl = $('firm-mode-section');
  if (modeEl) {
    modeEl.classList.toggle('locked', !state.answers.firmSize);
    modeEl.style.display = bucket === 'owner' ? '' : 'none';
  }
  // Re-apply visual selection state on revisits
  document.querySelectorAll('.firm-pill').forEach(b => {
    b.classList.toggle('selected', b.dataset.firm === state.answers.firmSize);
  });
  document.querySelectorAll('.mode-pill').forEach(b => {
    b.classList.toggle('selected', b.dataset.mode === state.answers.mode);
  });
  const nextBtn = $('firm-next');
  if (nextBtn) nextBtn.disabled = !state.answers.firmSize;
}

function updatePrecisionBars() {
  const score = computePrecisionScore();
  state.answers.precisionScore = score;
  const bars = document.querySelectorAll('.precision-bar');
  bars.forEach(bar => {
    const fill = bar.querySelector('.precision-bar-fill');
    const stateEl = bar.querySelector('.precision-bar-state');
    if (fill) fill.style.width = score + '%';
    if (stateEl) {
      const stage = bar.id.includes('stage1') ? '2' : bar.id.includes('stage4') ? '5' : '5b';
      stateEl.textContent = score > 0 ? `${score}% · ${precisionStateLabel(score, stage)}` : precisionStateLabel(score, stage);
    }
    bar.classList.toggle('active', score > 0);
  });
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

  // Stage 3 options: tier styling only (the existing option-icon already
  // visualises the category — adding a flame would clutter)
  decorate('#stage-3 .option[data-cat]', false);
}

// ── Init ──────────────────────────────────────────────────────────────────────
export async function initWizard() {
  // Clear any stale hash from a previous session so we always start at stage 0
  if (window.location.hash) history.replaceState(null, '', location.pathname);

  // If arriving via a team invite link, store the token for later use on save
  const pendingTeamToken = new URLSearchParams(window.location.search).get('team');
  if (pendingTeamToken) state.teamInviteToken = pendingTeamToken;

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
    if (state.answers.pains.length > 0) goToStage(3);
  });
  updatePrecisionBars();

  // ── Stage 3: categories
  document.querySelectorAll('.option[data-cat]').forEach(btn => {
    btn.addEventListener('click', () => toggleCategory(btn.dataset.cat));
  });
  $('cat-back')?.addEventListener('click', () => history.back());
  $('cat-next')?.addEventListener('click', () => {
    if (state.answers.categories.length > 0) goToStage(4);
  });
  $('cat-next') && ($('cat-next').disabled = true);

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
      updatePrecisionBars();
    });
  });
  $('role-back')?.addEventListener('click', () => history.back());
  $('role-next')?.addEventListener('click', () => {
    if (state.answers.role) {
      prepareStage5b();
      goToStage('5b');
    }
  });
  $('role-next') && ($('role-next').disabled = true);

  // ── Stage 5b: firm size + (conditional) mode
  document.querySelectorAll('[data-firm]').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('[data-firm]').forEach(b => b.classList.remove('selected'));
      btn.classList.add('selected');
      state.answers.firmSize = btn.dataset.firm;
      // Smart-suggest badge only matters until first interaction; clear it everywhere.
      document.querySelectorAll('.firm-pill').forEach(b => b.classList.remove('smart-suggest-active'));
      // Unlock mode section (owners only see mode prompt visually but logic is uniform)
      const modeEl = $('firm-mode-section');
      if (modeEl) modeEl.classList.remove('locked');
      $('firm-next').disabled = false;
      updatePrecisionBars();
    });
  });
  document.querySelectorAll('[data-mode]').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('[data-mode]').forEach(b => b.classList.remove('selected'));
      btn.classList.add('selected');
      state.answers.mode = btn.dataset.mode;
      updatePrecisionBars();
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
