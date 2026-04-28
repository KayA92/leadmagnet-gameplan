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
let _teamData    = null;
let _authUser    = null;
let _currentTab  = 'checklist';
let _checklistFilter = 'all';

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

function findAlternatives(session, planSessions, allSessions, categories) {
  const planIds = new Set(planSessions.map(s => s.session_id));
  return allSessions.filter(s =>
    s.session_id !== session.session_id &&
    !planIds.has(s.session_id) &&
    s.day === session.day &&
    s.start_time === session.start_time &&
    categories.some(cat => s.category === cat),
  ).slice(0, 1);
}

// ── Render helpers ────────────────────────────────────────────────────────────

const TICK_SVG = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>`;
const STAR_SVG = `<svg width="11" height="11" viewBox="0 0 24 24" fill="currentColor"><path d="M12 2l3.09 6.26L22 9.27l-5 4.87 1.18 6.88L12 17.77l-6.18 3.25L7 14.14 2 9.27l6.91-1.01L12 2z"/></svg>`;
const ALT_SVG  = `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg>`;

function flames(rating) {
  return [1, 2, 3].map(n =>
    `<button class="flame-btn ${(rating || 0) >= n ? 'lit' : ''}" data-rating="${n}" aria-label="${n} flame">🔥</button>`
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

function renderChecklistTab() {
  const plan       = _plan;
  const allSessions = _allSessions;
  if (!plan) return '';

  const sessions   = plan.sessions   || [];
  const booths     = plan.booths     || [];
  const themes     = plan.ai_themes  || [];
  const notes      = plan.notes      || [];
  const categories = plan.categories || [];

  const notesByItem = {};
  for (const n of notes) {
    const key = `${n.item_type}:${n.item_id}`;
    // In team mode, show notes from all teammates; keyed by item + user
    if (_teamData && n.created_by && n.created_by !== _authUser?.id) {
      if (!notesByItem[key]) notesByItem[key] = [];
      if (Array.isArray(notesByItem[key])) {
        notesByItem[key].push(n);
      }
    } else if (!_teamData || n.created_by === _authUser?.id || !n.created_by) {
      notesByItem[key] = n.note_text || '';
    }
  }

  // In team mode, also collect notes from teammates' plans
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

  // Filter pills (team mode)
  let filterHtml = '';
  if (_teamData && _teamData.members.length > 1) {
    const pills = [
      `<button class="checklist-filter-pill ${_checklistFilter === 'all' ? 'active' : ''}" onclick="planSetFilter('all')">All sessions</button>`,
      ..._teamData.members.map(m => {
        const u = m.users;
        const isMe = u.id === _authUser?.id;
        return `<button class="checklist-filter-pill ${isMe ? 'me' : ''} ${_checklistFilter === u.id ? 'active' : ''}" onclick="planSetFilter('${u.id}')">${escHtml(u.first_name)}</button>`;
      }),
    ];
    filterHtml = `<div class="checklist-controls"><div class="checklist-filter-pills"><span class="checklist-filter-label">Show</span>${pills.join('')}</div></div>`;
  }

  // Determine which sessions to show (filter by teammate)
  let visibleSessions = sessions;
  if (_teamData && _checklistFilter !== 'all') {
    const memberPlan = _teamData.teamPlans.find(p => p.user_id === _checklistFilter);
    const memberSessionIds = new Set((memberPlan?.sessions || []).map(s => s.session_id));
    visibleSessions = sessions.filter(s => memberSessionIds.has(s.session_id));
  }

  const themePills = themes.map(t => `<span class="theme-pill">${escHtml(t)}</span>`).join('');

  const sessionItems = visibleSessions.map((item, i) => {
    const noteKey      = `session:${item.session_id}`;
    const existingNote = typeof notesByItem[noteKey] === 'string' ? notesByItem[noteKey] : '';
    const dayLabel     = item.day === 'Day 1' ? 'Wed 13 May' : item.day === 'Day 2' ? 'Thu 14 May' : '';
    const whyTags      = whyMatched(item, plan);
    const alts         = findAlternatives(item, sessions, allSessions, categories);
    const teamNotes    = teamNotesByItem[noteKey] || [];

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

    return `
      <div class="checklist-row${item.attended ? ' attended' : ''}" data-item-type="session" data-item-id="${escHtml(item.session_id)}" data-rating="${item.rating || 0}" style="animation-delay:${i * 40}ms">
        <div class="checklist-row-main">
          <div class="checklist-row-leftcol">
            <button class="checklist-box" aria-label="Mark as attended">${TICK_SVG}</button>
            <div class="checklist-time-block">
              <div class="checklist-time-main">${escHtml(item.start_time || '')}</div>
              <div class="checklist-time-sub">${escHtml(dayLabel)}</div>
            </div>
          </div>
          <div class="checklist-main">
            <div class="checklist-main-title">${escHtml(item.title || item.session_id)}</div>
            <div class="checklist-main-meta">${item.theatre ? escHtml(item.theatre) + ' · ' : ''}<span class="type-pill session">Session</span></div>
            ${item.reason ? `<p class="plan-item-reason"><span class="plan-item-reason-label">Why you</span>${escHtml(item.reason)}</p>` : ''}
            ${whyHtml}
            ${altsHtml}
            <div class="plan-item-actions">
              <div class="rating-wrap">${flames(item.rating)}</div>
              <div class="note-wrap">
                ${existingNote ? `<p class="note-text">${escHtml(existingNote)}</p>` : ''}
                <textarea class="note-input" placeholder="Add a note…" rows="2">${escHtml(existingNote)}</textarea>
                <button class="save-note-btn btn-sm">Save note</button>
              </div>
            </div>
            ${teamNotesHtml}
          </div>
        </div>
      </div>`;
  }).join('');

  const boothItems = booths.map((item, i) => {
    const noteKey      = `booth:${item.stand_number}`;
    const existingNote = typeof notesByItem[noteKey] === 'string' ? notesByItem[noteKey] : '';
    const products     = (item.normalised_products || []).slice(0, 2).join(', ');
    const boothMeta    = [`Stand ${escHtml(item.stand_number || '')}`, products ? escHtml(products) : ''].filter(Boolean).join(' · ');
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

  return `
    ${themes.length ? `<section class="plan-themes-section"><div class="plan-themes">${themePills}</div></section>` : ''}
    ${filterHtml}
    <section class="plan-section">
      <h2 class="plan-section-title">Your sessions <span class="count-badge">${visibleSessions.length}</span></h2>
      <div class="checklist">${sessionItems || '<p class="empty-state">No sessions in your plan yet.</p>'}</div>
    </section>
    ${booths.length ? `
      <section class="plan-section">
        <h2 class="plan-section-title">Priority stands <span class="count-badge">${booths.length}</span></h2>
        <div class="mini-item-list">${boothItems}</div>
      </section>
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

// ── Debrief stub ──────────────────────────────────────────────────────────────

function renderDebriefTab() {
  const sessions = _plan?.sessions || [];
  const rated    = sessions.filter(s => s.rating).length;
  return `
    <div class="app-header">
      <h2 class="app-title">Your <em>debrief.</em></h2>
      <p class="app-sub">A full write-up — every note attributed, all sessions rated, vendor conversations, speaker quotes.</p>
    </div>
    <div style="padding:32px 0;color:var(--text-muted);font-size:14px;line-height:1.65;">
      ${rated > 0
        ? `<p>You've rated <strong style="color:var(--text)">${rated} session${rated !== 1 ? 's' : ''}</strong>. Keep rating and adding notes on the Checklist tab — your summary will build up here.</p>`
        : `<p>Rate your first session on the Checklist tab to see your debrief start taking shape.</p>`}
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

function renderCurrentTab() {
  switch (_currentTab) {
    case 'checklist': return renderChecklistTab();
    case 'team':      return renderTeamTab();
    case 'cpd':       return renderCpdTab();
    case 'debrief':   return renderDebriefTab();
    default:          return renderChecklistTab();
  }
}

// ── Event listeners ───────────────────────────────────────────────────────────

function attachPlanListeners(planId, sessions, booths) {
  document.querySelectorAll('.checklist-box').forEach(btn => {
    btn.addEventListener('click', async () => {
      const row    = btn.closest('[data-item-type]');
      const itemId = row.dataset.itemId;
      row.classList.toggle('attended');
      await toggleAttended(planId, itemId, sessions);
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
      await updateRating(planId, itemId, itemType, newRating, sessions, booths);
    });
  });

  document.querySelectorAll('.save-note-btn').forEach(btn => {
    btn.addEventListener('click', async () => {
      const card     = btn.closest('[data-item-type]');
      const itemType = card.dataset.itemType;
      const itemId   = card.dataset.itemId;
      const text     = card.querySelector('.note-input').value.trim();
      btn.textContent = 'Saving…';
      btn.disabled    = true;
      await saveNote(planId, itemId, itemType, text, _authUser?.id);
      btn.textContent = 'Saved ✓';
      setTimeout(() => { btn.textContent = 'Save note'; btn.disabled = false; }, 1500);
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

async function updateRating(planId, itemId, itemType, rating, sessions, booths) {
  const field = itemType === 'session' ? 'sessions' : 'booths';
  const list  = itemType === 'session' ? sessions : booths;
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
          id:         authUser.id,
          email:      authUser.email || '',
          first_name: planData?.user?.firstName || '',
          last_name:  planData?.user?.lastName  || '',
          company:    planData?.user?.company   || null,
        },
        { onConflict: 'id' },
      );
      if (upsertErr) throw upsertErr;

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

    const [full, allSessions] = await Promise.all([
      loadLatestPlan(authUser.id),
      fetch('/data/programme.json').then(r => r.json()).catch(() => []),
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

    _plan        = full;
    _allSessions = allSessions;
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

// ── Global helpers (called from inline onclick in rendered HTML) ───────────────

window.planSwitchTab = function(tabId) {
  _currentTab = tabId;
  renderApp();
  window.scrollTo({ top: 0, behavior: 'smooth' });
};

window.planSetFilter = function(filter) {
  _checklistFilter = filter;
  renderApp();
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
