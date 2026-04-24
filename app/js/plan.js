import { supabase } from './supabase.js';
import { getUser, onAuthChange, sendMagicLink } from './auth.js';

// ── Helpers ───────────────────────────────────────────────────────────────────
function $(id) { return document.getElementById(id); }
function escHtml(s) {
  return String(s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;')
    .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

// ── Supabase data access ──────────────────────────────────────────────────────

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

const TICK_SVG = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>`;

function flames(rating) {
  return [1, 2, 3].map(n =>
    `<button class="flame-btn ${(rating || 0) >= n ? 'lit' : ''}" data-rating="${n}" aria-label="${n} flame">🔥</button>`
  ).join('');
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

  const sessionItems = sessions.map((item, i) => {
    const noteKey = `session:${item.session_id}`;
    const existingNote = notesByItem[noteKey] || '';
    const dayLabel = item.day === 'Day 1' ? 'Wed 13 May' : item.day === 'Day 2' ? 'Thu 14 May' : '';
    const timeMeta = [item.start_time, dayLabel, item.theatre].filter(Boolean).map(escHtml).join(' · ');
    return `
      <div class="mini-item plan-mini-item" data-item-type="session" data-item-id="${escHtml(item.session_id)}" data-rating="${item.rating || 0}" style="animation-delay:${i * 40}ms">
        <div class="mini-tick">${TICK_SVG}</div>
        <div class="mini-body">
          <div class="mini-title">${escHtml(item.title || item.session_id)}</div>
          <div class="mini-meta"><span class="type-pill session">Session</span>${timeMeta}</div>
          ${item.reason ? `<p class="plan-item-reason"><span class="plan-item-reason-label">Why you</span>${escHtml(item.reason)}</p>` : ''}
          <div class="plan-item-actions">
            <div class="rating-wrap">${flames(item.rating)}</div>
            <div class="note-wrap">
              ${existingNote ? `<p class="note-text">${escHtml(existingNote)}</p>` : ''}
              <textarea class="note-input" placeholder="Add a note…" rows="2">${escHtml(existingNote)}</textarea>
              <button class="save-note-btn btn-sm">Save note</button>
            </div>
          </div>
        </div>
      </div>`;
  }).join('');

  const boothItems = booths.map((item, i) => {
    const noteKey = `booth:${item.stand_number}`;
    const existingNote = notesByItem[noteKey] || '';
    const products = (item.normalised_products || []).slice(0, 2).join(', ');
    const boothMeta = [`Stand ${escHtml(item.stand_number || '')}`, products ? escHtml(products) : ''].filter(Boolean).join(' · ');
    return `
      <div class="mini-item plan-mini-item" data-item-type="booth" data-item-id="${escHtml(item.stand_number)}" data-rating="${item.rating || 0}" style="animation-delay:${(sessions.length + i) * 40}ms">
        <div class="mini-tick">${TICK_SVG}</div>
        <div class="mini-body">
          <div class="mini-title">${escHtml(item.company_name)}</div>
          <div class="mini-meta"><span class="type-pill booth">Booth</span>${boothMeta}</div>
          ${item.reason ? `<p class="plan-item-reason"><span class="plan-item-reason-label">Why visit</span>${escHtml(item.reason)}</p>` : ''}
          <div class="plan-item-actions">
            <div class="rating-wrap">${flames(item.rating)}</div>
            <div class="note-wrap">
              ${existingNote ? `<p class="note-text">${escHtml(existingNote)}</p>` : ''}
              <textarea class="note-input" placeholder="Add a note…" rows="2">${escHtml(existingNote)}</textarea>
              <button class="save-note-btn btn-sm">Save note</button>
            </div>
          </div>
        </div>
      </div>`;
  }).join('');

  root.innerHTML = `
    <header class="plan-header">
      <a href="/app/" class="brand">
        <span class="brand-mark"></span>
        <span class="brand-text">Game <em>Plan</em></span>
      </a>
      <p class="plan-header-sub">Accountex London 2026 · 13–14 May · ExCeL</p>
    </header>

    ${themes.length ? `<section class="plan-themes-section"><div class="plan-themes">${themePills}</div></section>` : ''}

    <section class="plan-section">
      <h2 class="plan-section-title">Your sessions <span class="count-badge">${sessions.length}</span></h2>
      <div class="mini-item-list">${sessionItems || '<p class="empty-state">No sessions in your plan yet.</p>'}</div>
    </section>

    ${booths.length ? `
      <section class="plan-section">
        <h2 class="plan-section-title">Priority stands <span class="count-badge">${booths.length}</span></h2>
        <div class="mini-item-list">${boothItems}</div>
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
  try {
    const pending = localStorage.getItem('pendingPlan');
    if (pending) {
      const planData = JSON.parse(pending);
      await supabase.from('users').upsert(
        {
          id:         authUser.id,
          email:      authUser.email,
          first_name: planData.user?.firstName || '',
          last_name:  planData.user?.lastName  || '',
          company:    planData.user?.company   || null,
        },
        { onConflict: 'id' },
      );
      await supabase.from('plans').insert({
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
      localStorage.removeItem('pendingPlan');
    }
    const full = await loadLatestPlan(authUser.id);
    if (full) renderPlan(full);
    else showNoPlanState();
  } catch (err) {
    const detail = err?.message || err?.details || String(err);
    showError(`Could not save your plan: ${detail} — <a href="/app/" style="color:var(--mint)">Start again →</a>`);
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
      <p style="margin-top:20px;font-size:13px;color:var(--text-faint);">No plan yet? <a href="/app/" style="color:var(--mint);">Create one →</a></p>
    </div>`;

  $('reauth-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const email = $('reauth-email').value.trim();
    const btn   = $('reauth-btn');
    btn.textContent = 'Sending…';
    btn.disabled = true;
    const { error } = await sendMagicLink(email);
    const msg = $('reauth-msg');
    if (error) {
      btn.disabled = false;
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

// ── Entry point ───────────────────────────────────────────────────────────────
export async function initPlan() {
  // Detect Supabase auth errors returned in the redirect URL (both implicit #hash and PKCE ?query formats)
  const hashParams = new URLSearchParams(window.location.hash.slice(1));
  const qpParams   = new URLSearchParams(window.location.search);
  const errCode = hashParams.get('error_code') || qpParams.get('error_code');
  const errDesc = hashParams.get('error_description') || qpParams.get('error_description');
  if (errCode) {
    const headline = errCode === 'otp_expired'
      ? 'Your magic link has expired or was already used.'
      : (errDesc ? decodeURIComponent(errDesc.replace(/\+/g, ' ')) : 'Authentication failed.');
    showReauthForm(headline);
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
    if ((event === 'SIGNED_IN' || event === 'USER_UPDATED') && authUser) {
      unsubscribe();
      showLoading(false);
      await handleSignIn(authUser);
    }
  });

  // If nothing happens in 8s, show the re-auth form for returning users
  setTimeout(() => {
    const root = $('plan-root');
    if (root && root.innerHTML.trim() === '') {
      showReauthForm();
    }
  }, 8000);
}
