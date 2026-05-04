# CLAUDE.md — Accountex Gameplan App

Quick-start reference for Claude Code. Covers the non-obvious parts that take longest to learn from cold.

---

## What this app is

A lead-magnet web app for the Accountex 2026 accounting conference. A 5-stage wizard matches sessions/booths to a user's problems via Claude AI, captures their email, then shows a post-auth collaborative plan. Built by Workiro.

Live at: `autoevent.io`  
Repo: GitHub Pages — pushing to `main` auto-deploys.

---

## Tech stack — read this first

**There is no build step for the frontend.** No React, no bundler, no package.json. Pure vanilla JS ES modules + a single compiled CSS file. Edit files directly and push.

| Layer | Detail |
|---|---|
| Frontend | Vanilla JS modules, two separate HTML pages |
| Styles | `css/main.css` — one compiled static file, edit it directly. No Tailwind source. |
| Backend | Supabase (Postgres + Auth + Edge Functions) |
| AI | Claude Haiku via `supabase/functions/match-sessions/index.ts` (Deno/TypeScript) |
| Hosting | GitHub Pages, CNAME → autoevent.io |

**Edge Function changes require a deploy:** `supabase functions deploy match-sessions`  
**Data changes (CSV → JSON):** Run `node scripts/csv-to-json.js` and `node scripts/exhibitors-csv-to-json.js`, then commit the output files in `data/`.

---

## Two-page structure

```
index.html          ← Wizard (stages 0–7, email-sent)
plan/index.html     ← Post-auth app (4 tabs, rendered entirely by JS)
```

These are independent pages with separate JS entry points. `plan/index.html` imports `initPlan` from `js/plan.js`. `index.html` runs `js/wizard.js` inline.

---

## Key files

| File | Role |
|---|---|
| `js/wizard.js` | 5-stage wizard UI, AI call, plan save (658 lines) |
| `js/plan.js` | All 4 post-auth tabs: Checklist, Team, Debrief, CPD (2,666 lines) |
| `js/filter.js` | Stage 1 pre-filter: narrows ~225 sessions → 45 before the AI call |
| `js/api.js` | Edge Function caller — 2 retries, 25s timeout |
| `js/auth.js` | Thin wrapper: magic link, anon sign-in, session |
| `js/config.js` | Supabase URL + anon key (safe to commit — public key) |
| `css/main.css` | All styles — edit directly, no source file |
| `supabase/functions/match-sessions/index.ts` | Claude AI ranker |
| `supabase/migrations/` | 4 SQL stored procedures |
| `data/programme.json` / `data/exhibitors.json` | Static JSON served to client, generated from CSVs |

---

## Non-obvious things that will trip you up

### 1. CSS is one big file — there is no source
`css/main.css` is 7,000+ lines. It's compiled and committed as a static asset. Edit it directly. Styles are roughly organised in order: reset/base → top-bar → wizard stages → plan tabs → mobile media queries at the bottom.

### 2. The top-bar on `index.html`
Structure after recent changes:
```html
<nav class="top-bar">
  <a class="brand" href="/">...</a>
  <button class="login-btn" id="login-btn">Return to my plan</button>
</nav>
```
`.top-bar-right` wrapper **no longer exists** — it was removed. The `.progress-indicator` (5 dots) was also removed from the nav. `justify-content: space-between` on `.top-bar` handles brand-left / button-right with just 2 children.

### 3. `.progress-indicator { display: none }` — dots are hidden everywhere
The 5-dot progress indicator is no longer used. The CSS rule explicitly hides it globally. The only progress shown in the wizard is the `01 / 04` text counter + animated gradient bar in `.q-number`, which appears above each question title and works perfectly on all screen sizes.

### 4. Wizard stage numbering is non-linear
`Q_STAGES = ['1', '2', '3', '4', '5']` in wizard.js — but there is **no `id="stage-1"` HTML element**. The question stages in HTML are `stage-2` through `stage-5`. Stage 0 is the hero. Stage 1 is a legacy entry in the JS constant; it doesn't correspond to a visible HTML section.

### 5. Global function pattern in `plan.js`
Interactive elements rendered by JS call `window.planXxx()` functions. If you add a button in a JS-rendered template, the handler must be assigned as `window.planXxx = function(...) {...}` in `plan.js`. There is no event delegation system.

### 6. `sessions` and `booths` are stored as JSONB
The `plans` table stores the entire session/booth list as JSONB columns, not normalised rows. If you add a field to a session or booth object, update it in `wizard.js` (where it's saved) AND read it in `plan.js`.

### 7. The anonymous-to-authenticated handoff
Every visitor is silently signed in anonymously (`signInAnon()`) when the wizard starts. When they save their plan via magic link, `claim_anonymous_plan(planId)` RPC transfers DB ownership from the anon user to the authenticated user and deletes the anon record. The plan ID is stored in `localStorage` as a safety net.

### 8. All team operations go through RPCs, not direct writes
`accept_team_invite`, `get_invite_info`, `remove_team_member`, `claim_anonymous_plan` — all are `SECURITY DEFINER` stored procedures in `supabase/migrations/`. Don't try to replicate their logic in JS; call the RPC.

### 9. The preview page's fixed CTA bar
On stage 7 (plan preview), `.confirm-fixed-cta` is `position: fixed; bottom: 0`. It doesn't affect normal document flow. The "← Start over with different answers" button and `.footer-micro` sit below `#plan-preview-content` in the page flow, appearing below the preview content when the user scrolls.

### 10. `plan/index.html` tab structure is entirely JS-rendered
The HTML file is a shell with just a loading spinner and `<script type="module">` that calls `initPlan()`. All tabs, buttons, and content are generated by `plan.js`. When the plan page needs top-bar changes, they live in `plan.js`'s `renderTabNav()` (the `.app-tabs` bar), not in `plan/index.html`.

### 11. `body.app-active` hides the wizard top-bar
`body.app-active .top-bar { display: none; }` — the wizard's `<nav class="top-bar">` is completely hidden on the plan page. The plan page uses its own `.app-tabs` navigation bar with its own brand element.

### 12. Workiro's booth is hardcoded
The host's booth is force-injected into results via an `is_host` flag. Search for `is_host` in `plan.js` and `filter.js` to find the injection points.

### 13. Notes are not real-time
No Supabase subscriptions. Notes refresh only when switching to the Debrief tab or after a save. This is intentional.

---

## Mobile breakpoint

Single breakpoint: `@media (max-width: 640px)`. All mobile rules are in one block near the bottom of `css/main.css` (~line 7100). The wizard's question stages (`stage-2` through `stage-5`) use `.stage.flow-mode` which has `padding: 96px 18px 40px` on mobile to clear the fixed top-bar.

---

## Database quick reference

| Table | Key columns |
|---|---|
| `public.users` | `id`, `first_name`, `last_name`, `company`, `email` |
| `public.plans` | `id`, `user_id`, `team_id`, `sessions jsonb`, `booths jsonb`, `ai_themes[]` |
| `public.notes` | `plan_id`, `item_type`, `item_id`, `note_text`, `created_by` |
| `public.teams` | `id`, `lead_user_id`, `invite_token`, `max_members` (10, cosmetic — not enforced server-side) |
| `public.team_members` | `team_id`, `user_id`, `role` ('lead'/'member') |

RPCs (all `SECURITY DEFINER`, grant to `authenticated`):
- `claim_anonymous_plan(bigint)` — transfers plan ownership after magic link sign-in
- `accept_team_invite(text)` — join team atomically
- `get_invite_info(text)` — invite preview banner
- `remove_team_member(uuid)` — any member can remove any other

---

## Common tasks

**Add a UI element to the wizard** → edit `index.html` + `css/main.css`  
**Add a UI element to the plan tabs** → edit `js/plan.js` (JS-rendered HTML strings) + `css/main.css`  
**Change the AI prompt** → edit `supabase/functions/match-sessions/index.ts`, then `supabase functions deploy match-sessions`  
**Change pre-filter logic** → edit `js/filter.js` (`CATEGORY_MATCH`, `EXHIBITOR_PRODUCT_MATCH`, `ROLE_THEATRE`)  
**Add a database migration** → new file in `supabase/migrations/` with timestamp prefix  
**Update session/exhibitor data** → edit CSVs, run `node scripts/csv-to-json.js` + `node scripts/exhibitors-csv-to-json.js`, commit JSON files
