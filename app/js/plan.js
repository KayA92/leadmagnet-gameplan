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
let _inviteNudgeDismissed = false;

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
  };
}

// ── AI match helpers ──────────────────────────────────────────────────────────

function whyMatched(session, plan) {
  const tags       = [];
  const categories = plan.categories || [];
  const problem    = plan.problem    || '';
  const role       = plan.role       || '';
  const haystack   = `${session.title || ''} ${session.description || ''}`.toLowerCase();

  for (const cat of categories) {
    if (session.category === cat || haystack.includes(cat.toLowerCase())) {
      tags.push({ type: 'category', text: cat });
    }
  }

  if (problem) {
    const words = problem.toLowerCase().split(/\W+/).filter(w => w.length > 4);
    for (const w of words) {
      if (haystack.includes(w)) {
        tags.push({ type: 'problem', text: `Your problem: "${w}"` });
        break;
      }
    }
  }

  if (role) tags.push({ type: 'role', text: `Fits: ${role}` });

  return tags.slice(0, 5);
}

const PLAN_CATEGORY_MATCH = {
  'practice-management': ['practice-management'],
  'ai-automation':       ['ai-automation'],
  'bookkeeping':         ['bookkeeping'],
  'tax-mtd':             ['tax-mtd'],
  'doc-management':      ['doc-management'],
  'payroll':             ['payroll'],
  'esign':               ['esign'],
  'crm-comms':           ['crm-comms'],
  'data-analytics':      ['data-analytics'],
  'cyber-security':      ['cyber-security'],
  'aml-kyc':             ['aml-kyc'],
  'expenses':            ['expenses'],
  'hr-people':           ['hr-people'],
  'banking-payments':    ['banking-payments'],
  'doc-automation':      ['doc-automation'],
  'outsourcing':         ['outsourcing'],
  'marketing-growth':    ['marketing-growth'],
  'other':               [],
};

function hasSameSlotAlternative(item) {
  if (!item.day || !item.start_time) return false;
  if (_resolvedSlots.has(`${item.day}-${item.start_time}`)) return false;
  const cats = _plan?.categories || [];
  const wantedCanonicals = new Set(cats.flatMap(c => PLAN_CATEGORY_MATCH[c] || []));
  if (!wantedCanonicals.size) return false;
  const planIds = new Set((_plan?.sessions || []).map(s => s.session_id));
  return (_allSessions || []).some(s =>
    s.session_id !== item.session_id &&
    s.day === item.day &&
    s.start_time === item.start_time &&
    !planIds.has(s.session_id) &&
    (s.canonical_categories || []).some(c => wantedCanonicals.has(c)),
  );
}

function findStrongAlternatives(item) {
  if (!item.day || !item.start_time) return [];
  if (_resolvedSlots.has(`${item.day}-${item.start_time}`)) return [];
  const cats = _plan?.categories || [];
  const wantedCanonicals = new Set(cats.flatMap(c => PLAN_CATEGORY_MATCH[c] || []));
  if (!wantedCanonicals.size) return [];
  const planIds = new Set((_plan?.sessions || []).map(s => s.session_id));
  const candidates = (_allSessions || []).filter(s =>
    s.session_id !== item.session_id &&
    s.day === item.day &&
    s.start_time === item.start_time &&
    !planIds.has(s.session_id) &&
    !_dismissedAlternatives.has(`${item.session_id}|${s.session_id}`) &&
    (s.canonical_categories || []).some(c => wantedCanonicals.has(c)),
  );
  candidates.sort((a, b) =>
    (b.canonical_categories || []).filter(c => wantedCanonicals.has(c)).length -
    (a.canonical_categories || []).filter(c => wantedCanonicals.has(c)).length,
  );
  return candidates.slice(0, 1);
}

// ── Render helpers ────────────────────────────────────────────────────────────

const TICK_SVG = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>`;
const STAR_SVG = `<svg width="11" height="11" viewBox="0 0 24 24" fill="currentColor"><path d="M12 2l3.09 6.26L22 9.27l-5 4.87 1.18 6.88L12 17.77l-6.18 3.25L7 14.14 2 9.27l6.91-1.01L12 2z"/></svg>`;
const ALT_SVG  = `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg>`;


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
        <a class="app-tabs-brand" href="/app/">
          <div class="brand-mark"></div>
          <div class="app-tabs-brand-text">The Accountex <em>Game Plan</em></div>
        </a>
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

function suggestBoothsForGap(gapIndex) {
  const booths = _plan?.booths || [];
  if (!booths.length) return [];
  const start = (gapIndex * 2) % booths.length;
  return [0, 1].map(i => ({ name: booths[(start + i) % booths.length].company_name }));
}

function renderGapCard(startTime, endTime, gapIndex) {
  const diffMin = parseTimeToMinutes(endTime) - parseTimeToMinutes(startTime);
  if (diffMin < 20) return '';
  const hours    = Math.floor(diffMin / 60);
  const mins     = diffMin % 60;
  const duration = hours > 0 ? `${hours}h${mins > 0 ? ` ${mins}m` : ''}` : `${mins} min`;
  const suggested = suggestBoothsForGap(gapIndex);
  const boothLine = suggested.length
    ? suggested.map(b => `<strong>${escHtml(b.name)}</strong>`).join(' · ')
    : 'your priority booths';
  const kind = diffMin >= 60 ? 'Lunch break' : diffMin >= 45 ? 'Long break' : 'Break';
  return `
    <div class="checklist-gap-card">
      <div class="checklist-gap-main">
        <div class="checklist-gap-time">
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>
          <span><strong>${kind}</strong> · ${escHtml(startTime)}–${escHtml(endTime)} · ${duration}</span>
        </div>
        <div class="checklist-gap-body">Good window to visit: ${boothLine}</div>
      </div>
      <button class="checklist-gap-cta" onclick="document.getElementById('booths-anchor')?.scrollIntoView({behavior:'smooth'})" type="button">
        View booths
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><line x1="5" y1="12" x2="19" y2="12"/><polyline points="12 5 19 12 12 19"/></svg>
      </button>
    </div>`;
}

function _renderNotePanel(panel, noteId, savedText) {
  const hintText = noteId.startsWith('booth:')
    ? 'Pricing · Demo scheduled · Decision blocker'
    : 'What stood out · Who to follow up with';
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
      <div class="note-add-hint">${escHtml(hintText)}</div>`;
  }
}

function renderChecklistTab() {
  const plan        = _plan;
  if (!plan) return '';

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

  function renderSessionRow(item, i) {
    const noteKey      = `session:${item.session_id}`;
    const existingNote = typeof notesByItem[noteKey] === 'string' ? notesByItem[noteKey] : '';
    const whyTags      = whyMatched(item, plan);
    const alts         = findStrongAlternatives(item);
    const showSwap     = hasSameSlotAlternative(item);
    const teamNotes    = teamNotesByItem[noteKey] || [];

    const swapLink = showSwap
      ? `<button class="checklist-time-swap" onclick="planOpenSlotSwap('${escHtml(item.session_id)}', event)" type="button">
           <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="17 1 21 5 17 9"/><path d="M3 11V9a4 4 0 0 1 4-4h14"/><polyline points="7 23 3 19 7 15"/><path d="M21 13v2a4 4 0 0 1-4 4H3"/></svg>
           Swap
         </button>`
      : '';

    const whyHtml = whyTags.length ? `
      <div class="checklist-why-header">${STAR_SVG} Why AI picked this</div>
      <div class="checklist-why-tags">
        ${whyTags.map(t => `<span class="checklist-why-tag why-${t.type}">${escHtml(t.text)}</span>`).join('')}
      </div>` : '';

    const altsHtml = alts.length ? `
      <div class="checklist-alternatives">
        <div class="checklist-alternatives-label">${ALT_SVG} Also strong at ${escHtml(item.start_time || '')}</div>
        ${alts.map(alt => `
          <div class="checklist-alternative-card">
            <div class="checklist-alternative-body">
              <div class="checklist-alternative-title">${escHtml(alt.title || '')}</div>
              <div class="checklist-alternative-meta">${escHtml(alt.theatre || '')}</div>
            </div>
            <div class="checklist-alternative-actions">
              <button class="checklist-alternative-btn swap" onclick="planSwapSession('${escHtml(item.session_id)}','${escHtml(alt.session_id)}')" type="button">
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="17 1 21 5 17 9"/><path d="M3 11V9a4 4 0 0 1 4-4h14"/><polyline points="7 23 3 19 7 15"/><path d="M21 13v2a4 4 0 0 1-4 4H3"/></svg>
                Swap
              </button>
              <button class="checklist-alternative-btn dismiss" onclick="planDismissAlternative('${escHtml(item.session_id)}','${escHtml(alt.session_id)}',event)" type="button">Not for me</button>
            </div>
          </div>`).join('')}
      </div>` : '';

    const teamNotesHtml = teamNotes.length ? `
      <div style="margin-top:8px;padding:8px 10px;background:rgba(168,85,247,0.06);border:1px solid rgba(168,85,247,0.2);border-radius:8px;">
        ${teamNotes.map(n => {
          const author = _teamData?.members.find(m => m.users?.id === n.created_by);
          const name = author ? author.users.first_name : 'Teammate';
          return `<p style="font-size:12px;color:var(--text-muted);margin:0 0 4px;"><span style="color:var(--purple);font-weight:600;">${escHtml(name)}:</span> ${escHtml(n.note_text || '')}</p>`;
        }).join('')}
      </div>` : '';

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
           <div class="note-add-hint">What stood out · Who to follow up with</div>
         </div>`;

    const userInitial = (_authUser?.email || 'Y')[0].toUpperCase();
    const ratingLabel = (item.rating || 0) > 0 ? 'You rated' : 'Rate this';

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
            ${altsHtml}
            ${notePanel}
            ${teamNotesHtml}
          </div>
          <div class="checklist-row-right">
            <div class="row-rate-wrap">
              <div class="row-rate-caption">${ratingLabel}</div>
              <div class="row-rate-inline">${rowFlames(item.rating)}</div>
            </div>
            <div class="row-team-wrap">
              <div class="row-rate-caption">Going</div>
              <div class="checklist-avatars">
                <div class="mini-av t3" title="You">${userInitial}</div>
              </div>
            </div>
          </div>
        </div>
      </div>`;
  }

  function renderBoothRow(item, i) {
    const noteKey      = `booth:${item.stand_number}`;
    const existingNote = typeof notesByItem[noteKey] === 'string' ? notesByItem[noteKey] : '';
    const products     = (item.normalised_products || []).slice(0, 3).join(', ');
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
           <div class="note-add-hint">Pricing · Demo scheduled · Decision blocker</div>
         </div>`;

    const ratingLabel = (item.rating || 0) > 0 ? 'You rated' : 'Rate this';

    return `
      <div class="checklist-row is-booth${isWorkiro ? ' is-host' : ''}" data-item-type="booth" data-item-id="${escHtml(item.stand_number)}" data-rating="${item.rating || 0}" style="animation-delay:${(sessions.length + i) * 40}ms">
        ${hostStrip}
        <div class="checklist-row-main">
          <div class="checklist-row-leftcol">
            <button class="checklist-box" aria-label="Mark as visited">${TICK_SVG}</button>
            <div class="checklist-time-block booth">
              <div class="checklist-time-top">STAND</div>
              <div class="checklist-time-main">${escHtml(item.stand_number || '')}</div>
            </div>
          </div>
          <div class="checklist-main">
            <div class="checklist-main-title">${escHtml(item.company_name)}</div>
            <div class="checklist-main-meta"><span class="type-pill booth">Booth</span>${products ? ' · ' + escHtml(products) : ''}</div>
            ${notePanel}
          </div>
          <div class="checklist-row-right">
            <div class="row-rate-wrap">
              <div class="row-rate-caption">${ratingLabel}</div>
              <div class="row-rate-inline">${rowFlames(item.rating)}</div>
            </div>
          </div>
        </div>
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
      if (gap >= 20) sessionParts.push(renderGapCard(item.end_time, next.start_time, gapIndex++));
    }
  });
  const sessionItems = sessionParts.join('');

  const boothItems = booths.map((item, i) => renderBoothRow(item, i)).join('');

  const nudgeChip = !_inviteNudgeDismissed ? `
    <div class="solo-nudge-chip">
      <button class="solo-nudge-chip-body" onclick="planSwitchTab('team');window.scrollTo(0,0);" type="button">
        <span class="solo-nudge-dot"></span>
        <span class="solo-nudge-text">Going with colleagues? <strong>Send them your invite link</strong> — see their sessions, ratings, notes, and get an AI team summary.</span>
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><line x1="5" y1="12" x2="19" y2="12"/><polyline points="12 5 19 12 12 19"/></svg>
      </button>
      <button class="solo-nudge-chip-dismiss" onclick="planDismissInviteNudge(event)" type="button" aria-label="Dismiss">
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
      </button>
    </div>` : '';

  return `
    <div class="app-header">
      <div class="app-header-top">
        <div>
          <h2 class="app-title">Your <em>Accountex</em> plan.</h2>
          <p class="app-sub" style="margin-top:8px;">Rate sessions as you go and add notes — they roll into your debrief.</p>
          ${nudgeChip}
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
            Edit
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
              Edit
            </button>
          </div>
        </div>
        <p class="checklist-intro">Rate each vendor after a conversation — your notes and scores feed into your debrief.</p>
        <div class="checklist">${boothItems}</div>
      </div>
    ` : ''}
  `;
}

// ── Team tab ──────────────────────────────────────────────────────────────────

function buildIntelBlocks() {
  if (!_teamData || _teamData.members.length < 2) {
    return `
      <div class="intel-block tone-purple">
        <div class="intel-block-label">Waiting for your team</div>
        <div class="intel-block-headline">Share the invite link.</div>
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
  const avatarClass = `t${(index % 4) + 1}`;
  const memberPlan  = _teamData.teamPlans.find(p => p.user_id === u.id);
  const sessionCount = (memberPlan?.sessions || []).length;
  const noteCount = _teamData.allNotes.filter(n => n.plan_id === memberPlan?.id).length;
  const cats = (memberPlan?.categories || []).map(c => ({
    'practice-management': 'Practice mgmt', 'ai-automation': 'AI & automation',
    'bookkeeping': 'Bookkeeping', 'tax-mtd': 'Tax / MTD',
    'doc-management': 'Docs / portals', 'payroll': 'Payroll',
  }[c] || c));
  const joinedDate = new Date(m.joined_at);
  const joinedStr = isNaN(joinedDate) ? '' : `Joined · ${joinedDate.toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })}`;

  return `
    <div class="teammate ${isMe ? 'me' : ''}">
      <div class="teammate-top">
        <div class="teammate-avatar ${avatarClass}">${escHtml(initials)}</div>
        <div class="teammate-info">
          <div class="teammate-name-row">
            <span class="teammate-name">${escHtml(u.first_name)} ${escHtml(u.last_name)}</span>
            ${isMe ? '<span class="teammate-you-tag">You</span>' : ''}
          </div>
          <div class="teammate-role">${escHtml(u.company || '')}</div>
        </div>
      </div>
      ${memberPlan?.problem ? `
        <div class="teammate-mission">
          <div class="teammate-mission-label">Their mission</div>
          <div class="teammate-mission-text">"${escHtml(memberPlan.problem)}"</div>
        </div>
      ` : ''}
      ${cats.length ? `
        <div class="teammate-meta-block">
          <div class="teammate-meta-label">Evaluating</div>
          <div class="teammate-meta-pills">
            ${cats.map(c => `<span class="teammate-meta-pill cat">${escHtml(c)}</span>`).join('')}
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

function renderTeamTab() {
  if (!_teamData) return '<p style="color:var(--text-muted);padding:32px 0;">Team data not available.</p>';

  const myMembership = _teamData.members.find(m => m.users?.id === _authUser?.id);
  const isLead = myMembership?.role === 'lead';

  // Derive invite URL display components
  const firmSlug = (_teamData.company || 'your-team')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '') || 'your-team';
  const shortToken = (_teamData.inviteToken || '').slice(0, 8);
  const fullInviteUrl = `${window.location.origin}/app/?team=${_teamData.inviteToken || ''}`;

  const inviteHeroHtml = isLead ? `
    <div class="team-invite-hero">
      <div class="team-invite-hero-inner">
        <div class="team-invite-hero-label">Invite your team</div>
        <div class="team-invite-hero-title">One link, <em>everyone in.</em></div>
        <div class="team-invite-hero-sub">Send this to each person you're bringing. They answer the same onboarding, get their own plan, and land in this workspace — where you'll see <strong>who's at which session</strong>, whose notes are flowing in live, and the <strong>team debrief</strong> writing itself. No passwords, no sign-up fuss.</div>
        <div class="team-invite-url-row">
          <div class="team-invite-url" title="${escHtml(fullInviteUrl)}">
            <strong>workiro-ai.com/app/?team=</strong>${escHtml(firmSlug)}-${escHtml(shortToken)}
          </div>
          <button class="team-invite-copy-btn" onclick="planCopyInvite('${escHtml(fullInviteUrl)}', this)">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>
            Copy link
          </button>
        </div>
        <div class="team-invite-secondary">
          <button class="team-invite-secondary-btn" onclick="planShareEmail('${escHtml(fullInviteUrl)}')">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 4h16c1.1 0 2 .9 2 2v12c0 1.1-.9 2-2 2H4c-1.1 0-2-.9-2-2V6c0-1.1.9-2 2-2z"/><polyline points="22,6 12,13 2,6"/></svg>
            Send via email
          </button>
          <button class="team-invite-secondary-btn" onclick="planShareSlack('${escHtml(fullInviteUrl)}', this)">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><path d="M14 2v6h6M16 13H8M16 17H8M10 9H8"/></svg>
            Share in Slack
          </button>
          <button class="team-invite-secondary-btn" onclick="planShowQr('${escHtml(fullInviteUrl)}', this)">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="7" height="7"/><rect x="14" y="3" width="7" height="7"/><rect x="14" y="14" width="7" height="7"/><rect x="3" y="14" width="7" height="7"/></svg>
            Show QR code
          </button>
        </div>
      </div>
    </div>
  ` : `
    <div class="team-invite-hero">
      <div class="team-invite-hero-inner">
        <div class="team-invite-hero-label">You're in</div>
        <div class="team-invite-hero-title">Joined <em>${escHtml(_teamData.company || 'the team')}</em> workspace.</div>
        <div class="team-invite-hero-sub">Your plan, your notes, your CPD hours — all attributed to you but visible to the team. Any teammate can see who's going to what.</div>
      </div>
    </div>
  `;

  const memberCount = _teamData.members.length;

  return `
    <div class="app-header">
      <div class="app-header-top">
        <div>
          <h2 class="app-title">Your team, <em>already aligned.</em></h2>
          <p class="app-sub">What everyone's scouting, who's covering what, and where the team's real problems are.</p>
        </div>
      </div>
    </div>

    ${inviteHeroHtml}

    <div class="team-synthesis">
      <div class="team-synthesis-label">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="3"/><path d="M12 1v6m0 6v6m11-7h-6m-6 0H1"/></svg>
        AI team intel
      </div>
      <div class="team-synthesis-title">The brief your team <em>hasn't written yet.</em></div>
      <p class="team-synthesis-lede">We read every teammate's stated problem and priority pick. Here's what jumps out — attributed, not averaged.</p>
      <div class="intel-grid">
        ${buildIntelBlocks()}
      </div>
    </div>

    <div class="app-section">
      <div class="app-section-header">
        <div class="app-section-title">Who's going &amp; why <span class="app-section-count">${memberCount} ${memberCount === 1 ? 'mission' : 'missions'}</span></div>
      </div>
      <div class="teammate-grid">
        ${_teamData.members.map((m, i) => renderTeammateCard(m, i)).join('')}
      </div>
    </div>

    <div class="taxready-cta-v2">
      <div class="taxready-cta-v2-eyebrow">
        <span class="taxready-cta-v2-dot"></span>
        Bonus · Stand 1144
      </div>
      <h2 class="taxready-cta-v2-headline">
        Outrank every accountant in your postcode. <em>Free.</em>
      </h2>
      <p class="taxready-cta-v2-body">
        TaxReady is the UK's AI-matched accountant directory. <strong>2,690+ firms already on it.</strong> The one rated highest in each city wins the inbound leads. We'll list you in 3 minutes at our booth — or claim it yourself below.
      </p>

      <div class="taxready-cta-v2-visual-row">
        <div class="taxready-cta-v2-map">
          <svg viewBox="0 0 300 280" xmlns="http://www.w3.org/2000/svg" preserveAspectRatio="xMidYMid meet">
            <path d="M110 30 L130 28 L135 42 L150 50 L155 65 L148 80 L160 90 L165 105 L175 118 L170 135 L180 148 L175 165 L185 180 L180 195 L190 215 L175 235 L155 245 L135 255 L115 250 L95 240 L80 220 L75 195 L65 180 L70 160 L65 140 L75 125 L70 105 L80 88 L75 70 L90 55 L100 42 Z"
                  fill="rgba(255,255,255,0.04)" stroke="rgba(255,255,255,0.12)" stroke-width="1"/>
            <path d="M40 155 L55 150 L60 165 L55 185 L45 195 L35 185 L32 170 Z"
                  fill="rgba(255,255,255,0.03)" stroke="rgba(255,255,255,0.1)" stroke-width="1"/>
            <circle cx="122" cy="138" r="30" fill="none" stroke="rgba(255,94,132,0.3)" stroke-width="1" stroke-dasharray="3 3">
              <animate attributeName="r" values="20;60;20" dur="3s" repeatCount="indefinite"/>
              <animate attributeName="opacity" values="0.6;0;0.6" dur="3s" repeatCount="indefinite"/>
            </circle>
            <circle cx="120" cy="95" r="3.5" fill="rgba(255,94,132,0.5)"/>
            <circle cx="135" cy="115" r="3.5" fill="rgba(255,94,132,0.5)"/>
            <circle cx="95" cy="130" r="3.5" fill="rgba(255,94,132,0.5)"/>
            <circle cx="150" cy="145" r="3.5" fill="rgba(255,94,132,0.5)"/>
            <circle cx="115" cy="155" r="3.5" fill="rgba(255,94,132,0.5)"/>
            <circle cx="140" cy="175" r="3.5" fill="rgba(255,94,132,0.5)"/>
            <circle cx="105" cy="190" r="3.5" fill="rgba(255,94,132,0.5)"/>
            <circle cx="155" cy="200" r="3.5" fill="rgba(255,94,132,0.5)"/>
            <circle cx="125" cy="215" r="3.5" fill="rgba(255,94,132,0.5)"/>
            <circle cx="110" cy="110" r="3.5" fill="rgba(255,94,132,0.5)"/>
            <circle cx="130" cy="170" r="3.5" fill="rgba(255,94,132,0.5)"/>
            <circle cx="150" cy="105" r="3.5" fill="rgba(255,94,132,0.5)"/>
            <circle cx="122" cy="138" r="12" fill="rgba(34,230,168,0.22)">
              <animate attributeName="r" values="9;16;9" dur="2.2s" repeatCount="indefinite"/>
              <animate attributeName="opacity" values="0.6;0.15;0.6" dur="2.2s" repeatCount="indefinite"/>
            </circle>
            <circle cx="122" cy="138" r="7" fill="#22e6a8" stroke="#fff" stroke-width="2.5"/>
            <g transform="translate(140, 50)">
              <rect x="0" y="0" width="150" height="92" rx="10" fill="#0a0a12" stroke="rgba(34,230,168,0.55)" stroke-width="1.5"/>
              <circle cx="12" cy="15" r="3.5" fill="#22e6a8">
                <animate attributeName="opacity" values="1;0.3;1" dur="1.5s" repeatCount="indefinite"/>
              </circle>
              <text x="22" y="19" fill="#22e6a8" font-family="JetBrains Mono,monospace" font-size="8" font-weight="700" letter-spacing="0.1em">AI TOP MATCH</text>
              <text x="12" y="43" fill="#fff" font-family="Fraunces,serif" font-size="15" font-weight="500">Your Firm Ltd</text>
              <text x="12" y="60" fill="#22e6a8" font-family="IBM Plex Sans,sans-serif" font-size="10" font-weight="600">★★★★★ · 47 reviews</text>
              <text x="12" y="77" fill="rgba(255,255,255,0.55)" font-family="IBM Plex Sans,sans-serif" font-size="9">M1 · Small business specialists</text>
              <line x1="0" y1="92" x2="-18" y2="96" stroke="rgba(34,230,168,0.55)" stroke-width="1.5" stroke-linecap="round"/>
            </g>
            <g transform="translate(15, 255)">
              <rect x="0" y="0" width="130" height="18" rx="9" fill="rgba(255,94,132,0.08)" stroke="rgba(255,94,132,0.25)" stroke-width="1"/>
              <circle cx="10" cy="9" r="2.5" fill="#ff5e84">
                <animate attributeName="opacity" values="1;0.2;1" dur="1.2s" repeatCount="indefinite"/>
              </circle>
              <text x="19" y="12" fill="rgba(255,255,255,0.65)" font-family="JetBrains Mono,monospace" font-size="7" letter-spacing="0.1em">AI SCANNING 12 RIVALS</text>
            </g>
          </svg>
        </div>

        <div class="taxready-cta-v2-booth">
          <div class="taxready-cta-v2-booth-top">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M3 9l9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/><polyline points="9 22 9 12 15 12 15 22"/></svg>
            <span>STAND 1144</span>
          </div>
          <div class="taxready-cta-v2-booth-bignum">3 mins</div>
          <div class="taxready-cta-v2-booth-desc">Fill in a quick form at our booth. We'll handle the rest.</div>
          <div class="taxready-cta-v2-booth-tick-list">
            <div class="taxready-cta-v2-booth-tick">
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="#22e6a8" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>
              Free to claim
            </div>
            <div class="taxready-cta-v2-booth-tick">
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="#22e6a8" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>
              10+ reviews to qualify
            </div>
            <div class="taxready-cta-v2-booth-tick">
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="#22e6a8" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>
              No setup fee, ever
            </div>
          </div>
        </div>
      </div>

      <a class="taxready-cta-v2-btn" href="https://taxready.me/accountants.html" target="_blank" rel="noopener">
        Claim your free profile
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><line x1="5" y1="12" x2="19" y2="12"/><polyline points="12 5 19 12 12 19"/></svg>
      </a>
      <div class="taxready-cta-v2-foot">
        Or drop by <strong>stand 1144</strong> for a hand · <a href="https://xumagazine.com" target="_blank" rel="noopener">As featured in XU Magazine</a>
      </div>
    </div>
  `;
}

// ── CPD stub ──────────────────────────────────────────────────────────────────

function renderCpdTab() {
  const sessions = _plan?.sessions || [];
  const attended = sessions.filter(s => s.attended).length;
  const cpdHours = (attended * 40 / 60).toFixed(1);
  return `
    <div class="app-header">
      <h2 class="app-title">CPD <em>log.</em></h2>
      <p class="app-sub">Your continuing professional development hours, tracked as you go.</p>
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
  const sessions  = _plan?.sessions || [];
  const teamPlans = _teamData?.teamPlans || [];

  const scoreMap = {};
  const allPlans = teamPlans.length ? teamPlans : [_plan].filter(Boolean);
  for (const p of allPlans) {
    for (const s of (p.sessions || [])) {
      if (!s.rating) continue;
      const key = String(s.session_id);
      if (!scoreMap[key]) scoreMap[key] = { total: 0, count: 0 };
      scoreMap[key].total += s.rating;
      scoreMap[key].count += 1;
    }
  }

  return sessions
    .filter(s => scoreMap[String(s.session_id)])
    .map(s => ({
      session:    s,
      avgRating:  scoreMap[String(s.session_id)].total / scoreMap[String(s.session_id)].count,
      raterCount: scoreMap[String(s.session_id)].count,
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

  // Sessions: rated ones first (from heatRanked), then any noted-but-unrated sessions
  const ratedSessionIds = new Set(heatRanked.map(h => String(h.session.session_id)));
  const allSessionItems = [
    ...heatRanked.map(h => ({ session: h.session, avgRating: h.avgRating })),
    ...(_plan?.sessions || [])
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

  return `
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
      <h3 class="team-section-title">Top-rated <em>by your team.</em></h3>
      ${heatRanked.length
        ? `<div class="debrief-hot-list">${sessionCards}</div>`
        : `<div class="debrief-empty">Sessions appear here as your team rates them.</div>`}
    </div>

    <div class="app-section">
      <div class="team-section-eyebrow tone-pink">
        ${flameSvg()}
        Hot booths
      </div>
      <h3 class="team-section-title">Vendors <em>worth a follow-up.</em></h3>
      ${boothHeatRanked.length
        ? `<div class="debrief-hot-list">${boothCards}</div>`
        : `<div class="debrief-empty">Booths appear here as your team rates them.</div>`}
    </div>

  `;
}

// ── Plan editor overlay ───────────────────────────────────────────────────────

function _ensurePlanEditorOverlay() {
  if (document.getElementById('planEditorOverlay')) return;
  const el = document.createElement('div');
  el.innerHTML = `
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
  document.body.appendChild(el.firstElementChild);
}

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

  overlay.classList.add('open');
  document.body.style.overflow = 'hidden';

  renderPlanEditorFilters();
  renderPlanEditorResults();

  _planEditorEscHandler = e => { if (e.key === 'Escape') closePlanEditor(); };
  document.addEventListener('keydown', _planEditorEscHandler);
};

window.closePlanEditor = function() {
  const overlay = document.getElementById('planEditorOverlay');
  if (overlay) overlay.classList.remove('open');
  document.body.style.overflow = '';
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
  'esign':               'eSign',
  'crm-comms':           'CRM & Comms',
  'data-analytics':      'Data & Analytics',
  'cyber-security':      'Cyber Security',
  'aml-kyc':             'AML / KYC',
  'expenses':            'Expenses',
  'hr-people':           'HR & People',
  'banking-payments':    'Banking & Payments',
  'doc-automation':      'Doc Automation',
  'outsourcing':         'Outsourcing',
  'marketing-growth':    'Marketing & Growth',
  'other':               'Other / Uncategorised',
};

function renderPlanEditorFilters() {
  const el = document.getElementById('planEditorFilters');
  if (!el) return;

  const userCats    = _plan?.categories || [];
  const unpicked    = Object.keys(_EDITOR_CATEGORY_LABELS).filter(c => !userCats.includes(c));
  const hasActive   = _planEditorCategories.size > 0;

  const problemChips = userCats.map(c => {
    const on = _planEditorCategories.has(c);
    return `<button class="editor-filter-chip${on ? ' active' : ''}"
      onclick="setPlanEditorFilter('category','${escHtml(c)}')" type="button">
      ${on ? '✓ ' : ''}${escHtml(_EDITOR_CATEGORY_LABELS[c] || c)}
    </button>`;
  }).join('');

  const moreChips = unpicked.map(c => {
    const on = _planEditorCategories.has(c);
    return `<button class="editor-filter-chip variant-more${on ? ' active' : ''}"
      onclick="setPlanEditorFilter('category','${escHtml(c)}')" type="button">
      ${on ? '✓ ' : '+ '}${escHtml(_EDITOR_CATEGORY_LABELS[c] || c)}
    </button>`;
  }).join('');

  let html = '';

  if (userCats.length) {
    html += `<div class="editor-filter-group">
      <span class="editor-filter-label editor-filter-label-ai">
        <svg width="11" height="11" viewBox="0 0 24 24" fill="currentColor"><path d="M12 2L14 10L22 12L14 14L12 22L10 14L2 12L10 10Z"/></svg>
        Your top problems
      </span>
      ${problemChips}
      ${hasActive ? `<button class="editor-filter-clear" onclick="clearPlanEditorCategories()" type="button">Clear</button>` : ''}
      ${unpicked.length && !_planEditorShowMore ? `<button class="editor-filter-more-btn" onclick="togglePlanEditorMoreFilters()" type="button">+ ${unpicked.length} more filter${unpicked.length === 1 ? '' : 's'}</button>` : ''}
    </div>
    ${_planEditorShowMore && unpicked.length ? `
      <div class="editor-filter-group editor-filter-more-row">
        <span class="editor-filter-label">Also filter by</span>
        ${moreChips}
        <button class="editor-filter-more-hide" onclick="togglePlanEditorMoreFilters()" type="button">Hide</button>
      </div>` : ''}`;
  }

  if (_planEditorMode === 'sessions') {
    html += `
    <div class="editor-filter-group">
      <span class="editor-filter-label">Day</span>
      ${[['all','All days'],['Day 1','Day 1'],['Day 2','Day 2']].map(([v,l]) => `
        <button class="editor-filter-chip${_planEditorDay === v ? ' active' : ''}"
          onclick="setPlanEditorFilter('day','${v}')" type="button">${l}</button>`).join('')}
    </div>
    <div class="editor-filter-group">
      <span class="editor-filter-label">Time</span>
      ${[['all','All day'],['morning','Morning'],['afternoon','Afternoon']].map(([v,l]) => `
        <button class="editor-filter-chip${_planEditorTime === v ? ' active' : ''}"
          onclick="setPlanEditorFilter('time','${v}')" type="button">${l}</button>`).join('')}
    </div>`;
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

function renderPlanEditorSessions(container) {
  const q         = (_planEditorQuery || '').toLowerCase();
  const planIds   = new Set((_plan?.sessions || []).map(s => s.session_id));
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
  for (const key of sortedKeys) {
    const sessions = slots.get(key);
    const [day, time] = key.split('||');
    if (day !== lastDay) {
      lastDay = day;
      const dayNum  = day;
      const dayName = day === 'Day 1' ? 'Wednesday 13 May' : 'Thursday 14 May';
      html += `<div class="editor-day-divider">
        <span class="editor-day-divider-num">${dayNum}</span>
        <span class="editor-day-divider-name">${dayName}</span>
        <span class="editor-day-divider-line"></span>
      </div>`;
    }
    const slotPlanCount = sessions.filter(s => planIds.has(s.session_id)).length;
    const hasClash = slotPlanCount >= 2;
    html += `<div class="editor-slot${hasClash ? ' has-clash' : ''}">
      <div class="editor-slot-head">
        <div class="editor-slot-time"><strong>${escHtml(time || '')}</strong></div>
        ${hasClash ? `<div class="editor-clash-warning">⚠ ${slotPlanCount} sessions selected at this time</div>` : ''}
      </div>
      <div class="editor-slot-rows">`;
    for (const s of sessions) {
      const inPlan     = planIds.has(s.session_id);
      const speaker    = (s.speakers || [])[0];
      const speakerLine = speaker
        ? `<span class="editor-row-speaker">${escHtml(speaker.name || '')}${speaker.company ? ' · ' + escHtml(speaker.company) : ''}</span>`
        : '';
      const planCats  = _plan?.categories || [];
      const whyTags   = planCats.flatMap(cat => {
        const canonicals = PLAN_CATEGORY_MATCH[cat] || [];
        return (s.canonical_categories || []).some(c => canonicals.includes(c))
          ? [_EDITOR_CATEGORY_LABELS[cat] || cat]
          : [];
      }).slice(0, 3);
      const filterTags = [..._planEditorCategories]
        .filter(c => c !== 'other' && !planCats.includes(c))
        .filter(c => {
          const canonicals = PLAN_CATEGORY_MATCH[c] || [];
          return (s.canonical_categories || []).some(cat => canonicals.includes(cat));
        })
        .map(c => _EDITOR_CATEGORY_LABELS[c] || c)
        .slice(0, 3);
      const isOther = _planEditorCategories.has('other') && !(s.canonical_categories || []).length;
      const allTagSpans = [
        ...whyTags.map(t => `<span class="checklist-why-tag why-category">Your problem: &ldquo;${escHtml(t)}&rdquo;</span>`),
        ...filterTags.map(t => `<span class="checklist-why-tag why-category">Filtered: ${escHtml(t)}</span>`),
        ...(isOther ? [`<span class="checklist-why-tag why-category">Uncategorised</span>`] : []),
      ];
      const whyHtml = allTagSpans.length
        ? `<div class="editor-row-tags">${allTagSpans.join('')}</div>`
        : '';
      html += `
        <div class="editor-row${inPlan ? ' in-plan' : ''}">
          <div class="editor-row-main">
            <div class="editor-row-title">${escHtml(s.title || s.session_id)}</div>
            <div class="editor-row-meta">
              ${s.theatre ? `<span>${escHtml(s.theatre)}</span>` : ''}
              ${speakerLine}
            </div>
            ${s.description ? `<div class="editor-row-blurb">${escHtml(s.description)}</div>` : ''}
            ${whyHtml}
          </div>
          <div class="editor-row-actions">
            <button class="editor-row-toggle ${inPlan ? 'in' : 'out'}"
              onclick="togglePlanSession('${escHtml(String(s.session_id))}')" type="button">
              ${inPlan
                ? `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg> In your plan`
                : `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg> Add to plan`}
            </button>
          </div>
        </div>`;
    }
    html += '</div></div>';
  }
  container.innerHTML = html;
}

function renderPlanEditorBooths(container) {
  const q        = (_planEditorQuery || '').toLowerCase();
  const planNums = new Set((_plan?.booths || []).map(b => b.stand_number));

  const filtered = (_allExhibitors || []).filter(e => {
    if (!q) return true;
    const hay = `${e.company_name || ''} ${(e.normalised_products || []).join(' ')} ${e.stand_number || ''}`.toLowerCase();
    return hay.includes(q);
  }).sort((a, b) => (a.company_name || '').localeCompare(b.company_name || ''));

  if (!filtered.length) {
    container.innerHTML = '<div class="search-empty">No exhibitors match your search.</div>';
    return;
  }

  const html = filtered.map(e => {
    const inPlan = planNums.has(e.stand_number);
    const products = (e.normalised_products || []).slice(0, 3).map(p => escHtml(p)).join(' · ');
    return `
      <div class="editor-row${inPlan ? ' in-plan' : ''}">
        <div class="editor-row-main">
          <div class="editor-row-title">${escHtml(e.company_name || '')}</div>
          <div class="editor-row-meta">Stand ${escHtml(String(e.stand_number || ''))}${products ? ' · ' + products : ''}</div>
        </div>
        <div class="editor-row-actions">
          <button class="editor-row-toggle ${inPlan ? 'in' : 'out'}"
            onclick="togglePlanBooth('${escHtml(String(e.stand_number))}')" type="button">
            ${inPlan
              ? `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg> In your plan`
              : `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg> Add`}
          </button>
        </div>
      </div>`;
  }).join('');
  container.innerHTML = html;
}

window.togglePlanSession = async function(sessionId) {
  const inPlan = (_plan.sessions || []).some(s => String(s.session_id) === String(sessionId));
  if (inPlan) {
    _plan.sessions = (_plan.sessions || []).filter(s => String(s.session_id) !== String(sessionId));
  } else {
    const full = (_allSessions || []).find(s => String(s.session_id) === String(sessionId));
    if (full) _plan.sessions = [...(_plan.sessions || []), full];
  }
  renderPlanEditorResults();
  const sub = document.getElementById('planEditorSub');
  if (sub) sub.textContent = `${(_plan.sessions || []).length} in your plan · ${(_allSessions || []).length} available`;
  await supabase.from('plans').update({ sessions: _plan.sessions }).eq('id', _plan.id);
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
  const sub = document.getElementById('planEditorSub');
  if (sub) sub.textContent = `${(_plan.booths || []).length} in your plan · ${(_allExhibitors || []).length} available`;
  await supabase.from('plans').update({ booths: _plan.booths }).eq('id', _plan.id);
};

// ── Sponsors footer ───────────────────────────────────────────────────────────

function sponsorsFooterHtml() {
  return `
    <div class="workiro-cta workiro-cta-simple">
      <div class="workiro-cta-visual">
        <svg viewBox="0 0 200 100" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
          <g transform="translate(8, 20)">
            <rect x="0" y="0" width="34" height="44" rx="4" fill="rgba(255,94,132,0.10)" stroke="rgba(255,94,132,0.55)" stroke-width="1.4"/>
            <line x1="6" y1="12" x2="26" y2="12" stroke="rgba(255,94,132,0.55)" stroke-width="1.2" stroke-linecap="round"/>
            <line x1="6" y1="20" x2="22" y2="20" stroke="rgba(255,94,132,0.4)" stroke-width="1.2" stroke-linecap="round"/>
            <line x1="6" y1="28" x2="26" y2="28" stroke="rgba(255,94,132,0.4)" stroke-width="1.2" stroke-linecap="round"/>
            <line x1="6" y1="36" x2="18" y2="36" stroke="rgba(255,94,132,0.3)" stroke-width="1.2" stroke-linecap="round"/>
          </g>
          <g transform="translate(48, 32)">
            <rect x="0" y="0" width="34" height="44" rx="4" fill="rgba(168,85,247,0.10)" stroke="rgba(168,85,247,0.55)" stroke-width="1.4"/>
            <line x1="6" y1="12" x2="26" y2="12" stroke="rgba(168,85,247,0.55)" stroke-width="1.2" stroke-linecap="round"/>
            <line x1="6" y1="20" x2="22" y2="20" stroke="rgba(168,85,247,0.4)" stroke-width="1.2" stroke-linecap="round"/>
            <line x1="6" y1="28" x2="26" y2="28" stroke="rgba(168,85,247,0.4)" stroke-width="1.2" stroke-linecap="round"/>
            <line x1="6" y1="36" x2="18" y2="36" stroke="rgba(168,85,247,0.3)" stroke-width="1.2" stroke-linecap="round"/>
          </g>
          <path d="M 88 40 Q 110 40 130 50" fill="none" stroke="rgba(34,230,168,0.5)" stroke-width="1.4" stroke-linecap="round" stroke-dasharray="3 3">
            <animate attributeName="stroke-dashoffset" from="0" to="-12" dur="2.4s" repeatCount="indefinite"/>
          </path>
          <path d="M 88 56 Q 110 60 130 60" fill="none" stroke="rgba(34,230,168,0.5)" stroke-width="1.4" stroke-linecap="round" stroke-dasharray="3 3">
            <animate attributeName="stroke-dashoffset" from="0" to="-12" dur="2.4s" begin="0.6s" repeatCount="indefinite"/>
          </path>
          <g transform="translate(130, 24)">
            <path d="M 0 8 Q 0 4 4 4 L 18 4 L 22 10 L 56 10 Q 60 10 60 14 L 60 50 Q 60 54 56 54 L 4 54 Q 0 54 0 50 Z"
                  fill="rgba(34,230,168,0.12)" stroke="rgba(34,230,168,0.7)" stroke-width="1.5" stroke-linejoin="round"/>
            <line x1="8" y1="22" x2="52" y2="22" stroke="rgba(34,230,168,0.7)" stroke-width="1.2" stroke-linecap="round"/>
            <line x1="8" y1="30" x2="44" y2="30" stroke="rgba(34,230,168,0.55)" stroke-width="1.2" stroke-linecap="round"/>
            <line x1="8" y1="38" x2="52" y2="38" stroke="rgba(34,230,168,0.55)" stroke-width="1.2" stroke-linecap="round"/>
            <line x1="8" y1="46" x2="38" y2="46" stroke="rgba(34,230,168,0.4)" stroke-width="1.2" stroke-linecap="round"/>
            <circle cx="56" cy="14" r="2.5" fill="rgba(34,230,168,1)">
              <animate attributeName="opacity" values="1;0.3;1" dur="2s" repeatCount="indefinite"/>
            </circle>
          </g>
        </svg>
      </div>
      <div class="workiro-cta-content">
        <div class="workiro-cta-eyebrow">
          <span class="workiro-cta-eyebrow-dot"></span>
          About Workiro
        </div>
        <div class="workiro-cta-headline">
          Document management <em>for UK accounting firms.</em>
        </div>
        <div class="workiro-cta-actions">
          <a class="workiro-cta-btn primary" href="https://workiro.com" target="_blank" rel="noopener">
            Visit workiro.com
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><line x1="5" y1="12" x2="19" y2="12"/><polyline points="12 5 19 12 12 19"/></svg>
          </a>
          <span class="workiro-cta-note">· Or come see us at stand <strong>1144</strong></span>
        </div>
      </div>
    </div>
    <div class="hero-page-footer">
      Free · Built by <a href="https://workiro.com" target="_blank" rel="noopener">Workiro</a> · <a href="https://www.workiro.com/terms-and-policies/accountex-gameplan" target="_blank" rel="noopener">Privacy &amp; terms</a>
    </div>
    <div class="sponsors-footer" style="border-top:none;">
      <div class="sponsors-footer-label">BROUGHT TO YOU BY</div>
      <div class="sponsors-strip-logos" style="justify-content:center;margin-top:8px;">
        <img class="sponsor-img xu-img" src="/app/images/XU%20Magazine.webp" alt="XU Magazine">
        <img class="sponsor-img workiro-img" src="/app/images/workiro-logo.svg" alt="Workiro">
      </div>
    </div>
  `;
}

// ── Main render ───────────────────────────────────────────────────────────────

function renderApp() {
  const root = $('plan-root');
  if (!root) return;

  root.innerHTML = renderTabNav() + `<div class="plan-tab-content">${renderCurrentTab()}</div>`;

  if (_currentTab === 'checklist') {
    attachPlanListeners(_plan.id, _plan.sessions, _plan.booths);
  }
}

const _teamFooterHtml = `
    <div class="hero-page-footer">
      Free · Built by <a href="https://workiro.com" target="_blank" rel="noopener">Workiro</a> · <a href="https://www.workiro.com/terms-and-policies/accountex-gameplan" target="_blank" rel="noopener">Privacy &amp; terms</a>
    </div>
    <div class="sponsors-footer" style="border-top:none;">
      <div class="sponsors-footer-label">BROUGHT TO YOU BY</div>
      <div class="sponsors-strip-logos" style="justify-content:center;margin-top:8px;">
        <img class="sponsor-img xu-img" src="/app/images/XU%20Magazine.webp" alt="XU Magazine">
        <img class="sponsor-img workiro-img" src="/app/images/workiro-logo.svg" alt="Workiro">
      </div>
    </div>
  `;

function renderCurrentTab() {
  const footer = sponsorsFooterHtml();
  switch (_currentTab) {
    case 'checklist': return renderChecklistTab() + footer;
    case 'team':      return renderTeamTab() + _teamFooterHtml;
    case 'cpd':       return renderCpdTab() + footer;
    case 'debrief':   return renderDebriefTab() + footer;
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
      }

      // Join team if invite token present
      if (teamToken) {
        const { data: joinResult, error: joinErr } = await supabase.rpc('join_team', { p_invite_token: teamToken });
        localStorage.removeItem('pendingTeamToken');
        if (joinErr) throw joinErr;
        if (joinResult?.error) {
          showError(`Could not join team: ${joinResult.error}`);
          return;
        }
      }
    }

    const [full, allSessions, allExhibitors] = await Promise.all([
      loadLatestPlan(authUser.id),
      fetch('/data/programme.json').then(r => r.json()).catch(() => []),
      fetch('/data/exhibitors.json').then(r => r.json()).catch(() => []),
    ]);

    if (!full) { showNoPlanState(); return; }

    // Auto-create team for team leads whose plan doesn't yet have a team_id.
    // This defers team creation to the first authenticated load, since the teams
    // table requires a non-anonymous session (RLS blocks wizard-time creation).
    if (!full.team_id && !authUser.is_anonymous) {
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
          max_members:  5,
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

    let teamData = null;
    if (full.team_id) {
      teamData = await loadTeamData(full.team_id);
    }

    _plan          = full;
    _allSessions   = allSessions;
    _allExhibitors = allExhibitors;
    _teamData    = teamData;
    _authUser    = authUser;

    renderApp();
  } catch (err) {
    const detail = err?.message || err?.details || String(err);
    showError(`Could not load your plan: ${detail} — <a href="/app/" style="color:var(--mint)">Start again →</a>`);
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

window.planDismissInviteNudge = function(ev) {
  if (ev) ev.stopPropagation();
  _inviteNudgeDismissed = true;
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
  panel.className = 'checklist-note-panel editing';
  panel.innerHTML = `
    <div class="note-edit-head"><span class="note-edit-label">Your note</span></div>
    <textarea class="rate-panel-note" id="noteDraft-${escHtml(noteId)}"
      placeholder="What stood out · Who to follow up with"
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
    score: (s.canonical_categories || []).filter(c => wantedCanonicals.has(c)).length,
  }));
  scored.sort((a, b) => b.score - a.score || (a.session.title || '').localeCompare(b.session.title || ''));
  const dayLabel = current.day === 'Day 1' ? 'Wed 13 May' : 'Thu 14 May';
  const planIds = new Set((_plan?.sessions || []).map(s => s.session_id));
  const candidatesHtml = scored.length === 0
    ? '<div style="color:var(--text-muted);font-size:14px;padding:12px 0">No other sessions at this time slot.</div>'
    : scored.map(({ session: s, score }) => {
        const inPlan = planIds.has(s.session_id);
        return `
          <div class="slot-swap-row${inPlan ? ' already-in-plan' : ''}">
            <div class="slot-swap-row-main">
              <div class="slot-swap-row-title">${escHtml(s.title || '')}</div>
              <div class="slot-swap-row-meta">${escHtml(s.theatre || '')}${s.start_time ? ' · ' + escHtml(s.start_time) : ''}</div>
              ${score > 0 && !inPlan ? '<span class="slot-swap-match-tag">Matches your categories</span>' : ''}
              ${inPlan ? '<span class="slot-swap-already-tag">Already in your plan</span>' : ''}
            </div>
            ${inPlan
              ? '<button class="slot-swap-row-btn disabled" disabled>In plan</button>'
              : `<button class="slot-swap-row-btn" onclick="planSwapSession('${escHtml(currentId)}','${escHtml(s.session_id)}');document.getElementById('planSlotSwapModal')?.remove()" type="button">Swap to this</button>`
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
      <h2 class="login-modal-title">Swap this <em>slot.</em></h2>
      <p class="login-modal-sub">Currently: <strong>${escHtml(current.title || '')}</strong>. Pick a different session at the same time.</p>
      <div class="slot-swap-list">${candidatesHtml}</div>
    </div>`;
  document.body.appendChild(modal);
};

window.planCopyInvite = function(url, btn) {
  navigator.clipboard.writeText(url).then(() => {
    const orig = btn.innerHTML;
    btn.textContent = 'Copied ✓';
    setTimeout(() => { btn.innerHTML = orig; }, 2000);
  });
};

window.planShareEmail = function(url) {
  const subject = encodeURIComponent('Join my Accountex Game Plan team');
  const body = encodeURIComponent(`I've built our team's Accountex plan using the Workiro Game Plan tool.\n\nClick this link to complete your own quick wizard and join our shared workspace:\n\n${url}\n\nTakes about 2 minutes.`);
  window.open(`mailto:?subject=${subject}&body=${body}`);
};

window.planShareSlack = function(url, btn) {
  navigator.clipboard.writeText(url).then(() => {
    const orig = btn.innerHTML;
    btn.textContent = 'Copied — paste in Slack ✓';
    setTimeout(() => { btn.innerHTML = orig; }, 2000);
  });
};

window.planShowQr = function(url, btn) {
  navigator.clipboard.writeText(url).then(() => {
    const orig = btn.innerHTML;
    btn.textContent = 'Link copied — show to scan ✓';
    setTimeout(() => { btn.innerHTML = orig; }, 2000);
  });
};

// ── Entry point ───────────────────────────────────────────────────────────────

export async function initPlan() {
  const hashParams = new URLSearchParams(window.location.hash.slice(1));
  const qpParams   = new URLSearchParams(window.location.search);
  const errCode    = hashParams.get('error_code') || qpParams.get('error_code');
  const errDesc    = hashParams.get('error_description') || qpParams.get('error_description');
  const teamToken  = qpParams.get('team') || localStorage.getItem('pendingTeamToken') || null;

  if (errCode) {
    const headline = errCode === 'otp_expired'
      ? 'Your magic link has expired or was already used.'
      : (errDesc ? decodeURIComponent(errDesc.replace(/\+/g, ' ')) : 'Authentication failed.');
    showReauthForm(headline);
    return;
  }

  showLoading(true);

  const user = await getUser();

  if (user && !user.is_anonymous) {
    // Fully authenticated — load immediately and we're done.
    showLoading(false);
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

  setTimeout(() => {
    const root = $('plan-root');
    if (root && root.innerHTML.trim() === '') {
      showReauthForm();
    }
  }, 8000);
}
