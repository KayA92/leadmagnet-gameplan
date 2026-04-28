import { preFilterSessions, preFilterExhibitors } from './filter.js';
import { matchSessions } from './api.js';
import { signInAnon, getUser, sendMagicLink } from './auth.js';
import { supabase } from './supabase.js';

// ── State ─────────────────────────────────────────────────────────────────────
const state = {
  stage: '0',
  answers: {
    attendMode: 'just-me',
    problem: '',
    categories: [],
    time: null,
    role: null,
  },
  user: { firstName: '', lastName: '', email: '', company: '' },
  plan: null,
  teamInviteToken: null,
  filteredSessions: [],
  filteredExhibitors: [],
  allSessions: [],
  allExhibitors: [],
};

const FLOW_STAGES = new Set(['0', '2', '7']);
const Q_STAGES    = ['1', '2', '3', '4', '5']; // for progress dots
const STAGE_HASH  = { '1':'q1','2':'q2','3':'q3','4':'q4','5':'q5','7':'preview','75':'save' };
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

  window.scrollTo(0, 0);
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

function buildFallbackPlan() {
  return {
    fallback: true,
    sessions: state.filteredSessions.slice(0, 12).map((s, i) => ({
      session_id: s.session_id,
      rank: i + 1,
      reason: 'Matched to your event priorities.',
    })),
    booths: state.filteredExhibitors.slice(0, 8).map((e, i) => ({
      company_name: e.company_name,
      stand_number: e.stand_number,
      rank: i + 1,
      reason: 'Aligned with your selected categories.',
    })),
    themes: ['Sessions matched to your priorities and availability'],
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

  state.plan = (!apiResult || apiResult.fallback || !Array.isArray(apiResult.sessions))
    ? buildFallbackPlan()
    : apiResult;

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
    'esign': 'e-signing',
    'crm-comms': 'CRM & comms',
    'data-analytics': 'data analytics',
    'cyber-security': 'cyber security',
    'aml-kyc': 'AML / KYC',
    'expenses': 'expense management',
    'hr-people': 'HR & people',
    'banking-payments': 'banking & payments',
    'doc-automation': 'document automation',
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

    <div style="height:120px;"></div>
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

  const firstName = $('inp-first').value.trim();
  const lastName  = $('inp-last').value.trim();
  const email     = $('inp-email').value.trim();
  const company   = $('inp-company').value.trim();

  state.user = { firstName, lastName, email, company };

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
    if (existing) {
      userId = existing.id;
    } else {
      const { data, error } = await signInAnon();
      if (error) throw error;
      userId = data.user.id;
    }

    const { error: userErr } = await supabase.from('users').upsert(
      { id: userId, email, first_name: firstName, last_name: lastName, company: company || null },
      { onConflict: 'id' },
    );
    if (userErr) throw userErr;

    const { error: planErr } = await supabase.from('plans').insert({
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
    // Team creation happens on the plan page after the user authenticates via magic link,
    // because the teams table requires an authenticated (non-anonymous) session.
  } catch (dbErr) {
    // Surface DB errors so they're visible during debugging
    const errEl = $('save-error');
    if (errEl) {
      errEl.textContent = `DB save failed: ${dbErr?.message || dbErr?.details || String(dbErr)}`;
      errEl.style.display = 'block';
    }
    console.error('DB save error:', dbErr);
  }

  // Always forward the invite token if present — even if the member mistakenly selected
  // "team-lead" in the wizard, the ?team= param ensures join_team runs on the plan page
  // and attaches them to the correct team rather than creating a new one.
  const redirectTo = state.teamInviteToken
    ? `${window.location.origin}/app/plan/?team=${state.teamInviteToken}`
    : undefined;
  const { error: emailErr } = await sendMagicLink(email, redirectTo);
  if (emailErr) {
    btn.disabled = false;
    btn.textContent = 'Get my plan →';
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

  if (state.answers.attendMode === 'team-lead') {
    const block = $('team-invite-block');
    if (block) block.removeAttribute('hidden');
  }
  // Both team leads and invited members must click the magic link to activate team features.
  if (state.answers.attendMode === 'team-lead' || state.teamInviteToken) {
    const ctaLink = $('magic-confirm-cta-link');
    if (ctaLink) ctaLink.style.display = 'none';
    const ctaNote = document.querySelector('.magic-confirm-cta-note');
    if (ctaNote) ctaNote.style.display = 'none';
  }
}

// ── Problem textarea helpers ──────────────────────────────────────────────────
function updateCharCount(val) {
  const len = val.length;
  const countEl = $('char-count');
  const fillEl = $('char-fill');
  const minNote = $('char-min');
  if (countEl) countEl.textContent = len + ' / 1000';
  if (fillEl) {
    fillEl.style.width = Math.min((len / 1000) * 100, 100) + '%';
    fillEl.className = 'char-progress-fill' + (len >= 20 ? ' ok' : '');
  }
  if (minNote) minNote.className = 'min-note' + (len >= 20 ? ' ok' : '');
  const btn = $('problem-next');
  if (btn) btn.disabled = len < 20;
}

function addPromptChip(text) {
  const ta = $('problem-input');
  if (!ta) return;
  const sep = ta.value.length > 0 && !ta.value.endsWith(' ') ? ' ' : '';
  ta.value += sep + text;
  ta.dispatchEvent(new Event('input'));
  ta.focus();
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

  // ── Stage 0: hero CTA
  $('hero-start')?.addEventListener('click', () => goToStage(state.teamInviteToken ? 2 : 1));

  // ── Stage 1: attend mode (just-me pre-selected)
  document.querySelectorAll('[data-attend]').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('[data-attend]').forEach(b => b.classList.remove('selected'));
      btn.classList.add('selected');
      state.answers.attendMode = btn.dataset.attend;
    });
  });
  $('attend-next')?.addEventListener('click', () => goToStage(2));

  // ── Stage 2: problem statement
  const ta = $('problem-input');
  if (ta) {
    ta.addEventListener('input', () => {
      state.answers.problem = ta.value;
      updateCharCount(ta.value);
    });
    updateCharCount('');
  }
  document.querySelectorAll('[data-chip]').forEach(btn => {
    btn.addEventListener('click', () => addPromptChip(btn.dataset.chip));
  });
  $('problem-back')?.addEventListener('click', () => history.back());
  $('problem-next')?.addEventListener('click', () => {
    if (state.answers.problem.length >= 20) goToStage(3);
  });

  // ── Stage 3: categories
  document.querySelectorAll('[data-cat]').forEach(btn => {
    btn.addEventListener('click', () => toggleCategory(btn.dataset.cat));
  });
  $('cat-back')?.addEventListener('click', () => history.back());
  $('cat-next')?.addEventListener('click', () => {
    if (state.answers.categories.length > 0) goToStage(4);
  });
  $('cat-next') && ($('cat-next').disabled = true);

  // ── Stage 4: availability
  document.querySelectorAll('[data-time]').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('[data-time]').forEach(b => b.classList.remove('selected'));
      btn.classList.add('selected');
      state.answers.time = btn.dataset.time;
      $('time-next').disabled = false;
    });
  });
  $('time-back')?.addEventListener('click', () => history.back());
  $('time-next')?.addEventListener('click', () => {
    if (state.answers.time) goToStage(5);
  });
  $('time-next') && ($('time-next').disabled = true);

  // ── Stage 5: role
  document.querySelectorAll('[data-role]').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('[data-role]').forEach(b => b.classList.remove('selected'));
      btn.classList.add('selected');
      state.answers.role = btn.dataset.role;
      $('role-next').disabled = false;
    });
  });
  $('role-back')?.addEventListener('click', () => history.back());
  $('role-next')?.addEventListener('click', () => {
    if (state.answers.role) goToStage(6);
  });
  $('role-next') && ($('role-next').disabled = true);

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
