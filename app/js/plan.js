import { supabase } from './supabase.js';
import { getUser, onAuthChange } from './auth.js';

// ── Helpers ───────────────────────────────────────────────────────────────────
function $(id) { return document.getElementById(id); }
function escHtml(s) {
  return String(s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;')
    .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

// ── Supabase data access ──────────────────────────────────────────────────────

// Upsert a users row keyed on the Supabase auth UID
async function upsertUser(authUser, userMeta) {
  const { error } = await supabase
    .from('users')
    .upsert(
      {
        id:         authUser.id,
        email:      authUser.email,
        first_name: userMeta?.firstName || '',
        last_name:  userMeta?.lastName  || '',
        company:    userMeta?.company   || null,
      },
      { onConflict: 'id' },
    );

  if (error) throw error;
  return authUser.id;
}

async function insertPlan(userId, planData) {
  const { data, error } = await supabase
    .from('plans')
    .insert({
      user_id:    userId,
      attend_mode: planData.answers.attendMode,
      problem:    planData.answers.problem,
      categories: planData.answers.categories,
      time_window: planData.answers.time,
      role:       planData.answers.role,
      sessions:   planData.sessions,
      booths:     planData.booths,
      ai_themes:  planData.themes,
    })
    .select('id')
    .single();

  if (error) throw error;
  return data;
}

async function loadLatestPlan(userId) {
  // 1. Get latest plan row
  const { data: plan, error: planErr } = await supabase
    .from('plans')
    .select('*')
    .eq('user_id', userId)
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();

  if (planErr) throw planErr;
  if (!plan) return null;

  // 2. Get notes for that plan
  const { data: notes } = await supabase
    .from('notes')
    .select('*')
    .eq('plan_id', plan.id);

  return { ...plan, notes: notes || [] };
}

// ── Render ────────────────────────────────────────────────────────────────────
function renderPlan(plan) {
  const root = $('plan-root');
  if (!root) return;

  const sessions = plan.sessions || [];
  const booths   = plan.booths   || [];
  const themes   = plan.ai_themes || [];
  const notes    = plan.notes    || [];

  const notesByItem = {};
  for (const n of notes) {
    notesByItem[`${n.item_type}:${n.item_id}`] = n.note_text;
  }

  const themePills = themes.map(t => `<span class="theme-pill">${escHtml(t)}</span>`).join('');

  const sessionCards = sessions.map(item => {
    const noteKey = `session:${item.session_id}`;
    const existingNote = notesByItem[noteKey] || '';
    return `
      <div class="plan-card" data-item-type="session" data-item-id="${escHtml(item.session_id)}">
        <div class="plan-card-header">
          <span class="plan-card-rank">${item.rank || ''}</span>
          <div class="plan-card-meta">
            ${item.day ? `<span class="plan-card-time">${escHtml(item.start_time || '')} — ${item.day === 'Day 1' ? 'Wed' : 'Thu'}</span>` : ''}
            ${item.theatre ? `<span class="plan-card-theatre">${escHtml(item.theatre)}</span>` : ''}
          </div>
        </div>
        <h3 class="plan-card-title">${escHtml(item.title || item.session_id)}</h3>
        ${item.reason ? `<p class="plan-card-reason"><span class="reason-label">Why you</span> ${escHtml(item.reason)}</p>` : ''}
        <div class="plan-card-actions">
          <div class="rating-wrap">
            ${[1,2,3].map(n => `
              <button class="flame-btn ${item.rating >= n ? 'lit' : ''}"
                data-rating="${n}" aria-label="${n} flame${n > 1 ? 's' : ''}">🔥</button>
            `).join('')}
          </div>
          <div class="note-wrap">
            ${existingNote
              ? `<p class="note-text">${escHtml(existingNote)}</p>`
              : ''}
            <textarea class="note-input" placeholder="Add a note…" rows="2">${escHtml(existingNote)}</textarea>
            <button class="save-note-btn btn-sm">Save note</button>
          </div>
        </div>
      </div>`;
  }).join('');

  const boothCards = booths.map(item => {
    const noteKey = `booth:${item.stand_number}`;
    const existingNote = notesByItem[noteKey] || '';
    return `
      <div class="plan-card booth-card" data-item-type="booth" data-item-id="${escHtml(item.stand_number)}">
        <div class="plan-card-header">
          <span class="plan-card-rank booth-rank">${item.rank || ''}</span>
          <span class="plan-card-stand">Stand ${escHtml(item.stand_number || '')}</span>
        </div>
        <h3 class="plan-card-title">${escHtml(item.company_name)}</h3>
        ${item.reason ? `<p class="plan-card-reason"><span class="reason-label">Why visit</span> ${escHtml(item.reason)}</p>` : ''}
        <div class="plan-card-actions">
          <div class="rating-wrap">
            ${[1,2,3].map(n => `
              <button class="flame-btn ${(item.rating || 0) >= n ? 'lit' : ''}"
                data-rating="${n}">🔥</button>
            `).join('')}
          </div>
          <div class="note-wrap">
            ${existingNote ? `<p class="note-text">${escHtml(existingNote)}</p>` : ''}
            <textarea class="note-input" placeholder="Add a note…" rows="2">${escHtml(existingNote)}</textarea>
            <button class="save-note-btn btn-sm">Save note</button>
          </div>
        </div>
      </div>`;
  }).join('');

  root.innerHTML = `
    <header class="plan-header">
      <a href="/" class="brand">
        <span class="brand-mark"></span>
        <span class="brand-text">Game <em>Plan</em></span>
      </a>
      <p class="plan-header-sub">Accountex London 2026 · 13–14 May · ExCeL</p>
    </header>

    ${themes.length ? `<section class="plan-themes-section"><div class="plan-themes">${themePills}</div></section>` : ''}

    <section class="plan-section">
      <h2 class="plan-section-title">Your sessions <span class="count-badge">${sessions.length}</span></h2>
      <div class="plan-cards">${sessionCards || '<p class="empty-state">No sessions in your plan yet.</p>'}</div>
    </section>

    ${booths.length ? `
      <section class="plan-section">
        <h2 class="plan-section-title">Priority stands <span class="count-badge">${booths.length}</span></h2>
        <div class="plan-cards booths-grid">${boothCards}</div>
      </section>
    ` : ''}
  `;

  attachPlanListeners(plan.id, plan.sessions, plan.booths);
}

// ── Event listeners for rating and notes ─────────────────────────────────────
function attachPlanListeners(planId, sessions, booths) {
  // Ratings
  document.querySelectorAll('.flame-btn').forEach(btn => {
    btn.addEventListener('click', async () => {
      const card = btn.closest('[data-item-type]');
      const itemType = card.dataset.itemType;
      const itemId   = card.dataset.itemId;
      const rating   = parseInt(btn.dataset.rating);

      // Toggle off if same rating clicked
      const currentRating = parseInt(card.dataset.rating || '0');
      const newRating = currentRating === rating ? 0 : rating;

      card.dataset.rating = newRating;
      card.querySelectorAll('.flame-btn').forEach((b, i) => {
        b.classList.toggle('lit', i < newRating);
      });

      await updateRating(planId, itemId, itemType, newRating, sessions, booths);
    });
  });

  // Notes
  document.querySelectorAll('.save-note-btn').forEach(btn => {
    btn.addEventListener('click', async () => {
      const card  = btn.closest('[data-item-type]');
      const itemType = card.dataset.itemType;
      const itemId   = card.dataset.itemId;
      const text  = card.querySelector('.note-input').value.trim();

      btn.textContent = 'Saving…';
      btn.disabled = true;
      await saveNote(planId, itemId, itemType, text);
      btn.textContent = 'Saved ✓';
      setTimeout(() => { btn.textContent = 'Save note'; btn.disabled = false; }, 1500);
    });
  });
}

async function updateRating(planId, itemId, itemType, rating, sessions, booths) {
  const field = itemType === 'session' ? 'sessions' : 'booths';
  const list  = itemType === 'session' ? sessions : booths;

  const updated = list.map(item => {
    const id = itemType === 'session' ? item.session_id : item.stand_number;
    return id === itemId ? { ...item, rating } : item;
  });

  await supabase.from('plans').update({ [field]: updated }).eq('id', planId);
}

async function saveNote(planId, itemId, itemType, noteText) {
  await supabase.from('notes').upsert(
    { plan_id: planId, item_id: itemId, item_type: itemType, note_text: noteText },
    { onConflict: 'plan_id,item_id,item_type' },
  );
}

// ── Auth flow ─────────────────────────────────────────────────────────────────
async function handleSignIn(authUser) {
  const pending = localStorage.getItem('pendingPlan');

  if (pending) {
    try {
      const planData = JSON.parse(pending);
      const userId = await upsertUser(authUser, planData.user);
      await insertPlan(userId, planData);
      localStorage.removeItem('pendingPlan');
      // Reload plan from DB (to include generated id)
      const full = await loadLatestPlan(userId);
      if (full) renderPlan(full);
    } catch (err) {
      console.error('Failed to save plan:', err);
      const detail = err?.message || err?.details || String(err);
      showError(`Could not save your plan: ${detail} — <a href="/app/" style="color:var(--mint)">Start again →</a>`);
    }
  } else {
    // Returning user — auth UID is the users table PK
    const full = await loadLatestPlan(authUser.id);
    if (full) renderPlan(full);
    else showNoPlanState();
  }
}

function showNoPlanState() {
  const root = $('plan-root');
  if (root) root.innerHTML = `
    <div class="empty-plan">
      <p>No plan found. <a href="/app/">Create yours →</a></p>
    </div>`;
}

function showError(msg) {
  const el = $('plan-error');
  if (el) { el.textContent = msg; el.style.display = 'block'; }
}

function showLoading(show) {
  const el = $('plan-loading');
  if (el) el.style.display = show ? 'flex' : 'none';
}

// ── Entry point ───────────────────────────────────────────────────────────────
export async function initPlan() {
  // Detect Supabase auth errors returned in the redirect URL (both implicit #hash and PKCE ?query formats)
  const hashParams = new URLSearchParams(window.location.hash.slice(1));
  const qpParams   = new URLSearchParams(window.location.search);
  const errCode = hashParams.get('error_code') || qpParams.get('error_code');
  const errDesc = hashParams.get('error_description') || qpParams.get('error_description');
  if (errCode) {
    showLoading(false);
    const msg = errCode === 'otp_expired'
      ? 'Your magic link has expired or was already used.'
      : (errDesc ? decodeURIComponent(errDesc.replace(/\+/g, ' ')) : 'Authentication failed.');
    showError(msg + ' <a href="/app/" style="color:var(--mint)">Start again →</a>');
    return;
  }

  showLoading(true);

  // Check for existing session first (returning user with localStorage session)
  const user = await getUser();
  if (user) {
    showLoading(false);
    await handleSignIn(user);
    return;
  }

  // Wait for auth state change (new user arriving via magic link)
  const unsubscribe = onAuthChange(async (event, authUser) => {
    if (event === 'SIGNED_IN' && authUser) {
      unsubscribe();
      showLoading(false);
      await handleSignIn(authUser);
    }
  });

  // If nothing happens in 8s, show sign-in prompt
  setTimeout(() => {
    showLoading(false);
    const root = $('plan-root');
    if (root && root.innerHTML.trim() === '') {
      root.innerHTML = `
        <div class="empty-plan">
          <p>Please check your email for the magic link, or <a href="/app/">start again →</a></p>
        </div>`;
    }
  }, 8000);
}
