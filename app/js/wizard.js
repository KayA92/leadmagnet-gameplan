import { preFilterSessions, preFilterExhibitors } from './filter.js';
import { matchSessions } from './api.js';
import { sendMagicLink } from './auth.js';

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
  filteredSessions: [],
  filteredExhibitors: [],
  allSessions: [],
  allExhibitors: [],
};

const FLOW_STAGES = new Set(['0', '2', '7']);
const Q_STAGES = ['1', '2', '3', '4', '5']; // for progress dots

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
function goToStage(n) {
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
let _tickerInterval = null;

function startTicker() {
  const el = $('reveal-ticker');
  if (!el) return;
  const titles = shuffleArray(state.allSessions.map(s => s.title));
  let i = 0;
  _tickerInterval = setInterval(() => {
    el.textContent = titles[i % titles.length];
    i++;
  }, 90);
}

function stopTicker() {
  if (_tickerInterval) { clearInterval(_tickerInterval); _tickerInterval = null; }
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
function renderSessionCard(session, item) {
  const timeStr = session.start_time
    ? `${session.start_time} — ${session.day === 'Day 1' ? 'Wed' : 'Thu'}`
    : '';
  const speakers = (session.speakers || []).map(s => s.name).filter(Boolean).join(', ');

  return `
    <div class="plan-card">
      <div class="plan-card-header">
        <span class="plan-card-rank">${item.rank}</span>
        <div class="plan-card-meta">
          ${timeStr ? `<span class="plan-card-time">${escHtml(timeStr)}</span>` : ''}
          <span class="plan-card-theatre">${escHtml(session.theatre || '')}</span>
        </div>
      </div>
      <h3 class="plan-card-title">${escHtml(session.title)}</h3>
      ${speakers ? `<p class="plan-card-speakers">${escHtml(speakers)}</p>` : ''}
      ${item.reason ? `<p class="plan-card-reason"><span class="reason-label">Why you</span> ${escHtml(item.reason)}</p>` : ''}
    </div>`;
}

function renderBoothCard(exhibitor, item) {
  return `
    <div class="plan-card booth-card">
      <div class="plan-card-header">
        <span class="plan-card-rank booth-rank">${item.rank}</span>
        <span class="plan-card-stand">Stand ${escHtml(exhibitor.stand_number || '')}</span>
      </div>
      <h3 class="plan-card-title">${escHtml(exhibitor.company_name)}</h3>
      ${exhibitor.is_host ? '<span class="host-badge">Host partner</span>' : ''}
      ${item.reason ? `<p class="plan-card-reason"><span class="reason-label">Why visit</span> ${escHtml(item.reason)}</p>` : ''}
    </div>`;
}

function renderPlanPreview() {
  const container = $('plan-preview-content');
  if (!container || !state.plan) return;

  const { sessions: rankedSessions = [], booths: rankedBooths = [], themes = [] } = state.plan;

  // Resolve full session data
  const sessionCards = rankedSessions.map(item => {
    const full = state.allSessions.find(s => s.session_id === item.session_id);
    return full ? renderSessionCard(full, item) : '';
  }).join('');

  // Resolve full exhibitor data
  const boothCards = rankedBooths.map(item => {
    const full = state.allExhibitors.find(
      e => e.stand_number === item.stand_number || e.company_name === item.company_name,
    );
    return full ? renderBoothCard(full, item) : '';
  }).join('');

  const themePills = themes.map(t => `<span class="theme-pill">${escHtml(t)}</span>`).join('');

  container.innerHTML = `
    ${themes.length ? `<div class="plan-themes">${themePills}</div>` : ''}
    <h2 class="plan-section-title">Your ${rankedSessions.length} sessions</h2>
    <div class="plan-cards">${sessionCards}</div>
    ${rankedBooths.length ? `
      <h2 class="plan-section-title">Priority stands</h2>
      <div class="plan-cards booths-grid">${boothCards}</div>
    ` : ''}
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
  btn.textContent = 'Sending…';

  const firstName = $('inp-first').value.trim();
  const lastName  = $('inp-last').value.trim();
  const email     = $('inp-email').value.trim();
  const company   = $('inp-company').value.trim();

  state.user = { firstName, lastName, email, company };

  // Store pending plan for plan.js to pick up after auth
  sessionStorage.setItem('pendingPlan', JSON.stringify({
    answers: state.answers,
    user: state.user,
    sessions: state.plan?.sessions || [],
    booths: state.plan?.booths || [],
    themes: state.plan?.themes || [],
  }));

  const { error } = await sendMagicLink(email);

  if (error) {
    btn.disabled = false;
    btn.textContent = 'Get my plan →';
    const errEl = $('save-error');
    if (errEl) { errEl.textContent = error.message || 'Something went wrong. Please try again.'; errEl.style.display = 'block'; }
  } else {
    goToStage('email-sent');
    const sentEmail = $('sent-email');
    if (sentEmail) sentEmail.textContent = email;
  }
}

// ── Problem textarea helpers ──────────────────────────────────────────────────
function updateCharCount(val) {
  const len = val.length;
  const countEl = $('char-count');
  const fillEl = $('char-fill');
  const minNote = $('char-min');
  if (countEl) countEl.textContent = len;
  if (fillEl) {
    fillEl.style.width = Math.min((len / 500) * 100, 100) + '%';
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
  $('hero-start')?.addEventListener('click', () => goToStage(1));

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
  $('problem-back')?.addEventListener('click', () => goToStage(1));
  $('problem-next')?.addEventListener('click', () => {
    if (state.answers.problem.length >= 20) goToStage(3);
  });

  // ── Stage 3: categories
  document.querySelectorAll('[data-cat]').forEach(btn => {
    btn.addEventListener('click', () => toggleCategory(btn.dataset.cat));
  });
  $('cat-back')?.addEventListener('click', () => goToStage(2));
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
  $('time-back')?.addEventListener('click', () => goToStage(3));
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
  $('role-back')?.addEventListener('click', () => goToStage(4));
  $('role-next')?.addEventListener('click', () => {
    if (state.answers.role) goToStage(6);
  });
  $('role-next') && ($('role-next').disabled = true);

  // ── Stage 7: save CTA
  $('preview-save')?.addEventListener('click', () => goToStage(75));
  $('preview-back')?.addEventListener('click', () => goToStage(5));

  // ── Stage 75: save form
  $('save-form')?.addEventListener('submit', handleSaveSubmit);

  // Show stage 0
  goToStage('0');
}
