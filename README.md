# The Accountex Game Plan — Lead Magnet

**Live at:** [gameplan.workiro.com](https://gameplan.workiro.com)  
**Event:** Accountex London 2026 · 13–14 May · ExCeL London  
**Owner:** Marketing (lead gen) · Ops (deployment and data)

---

## What this is

A free AI-powered event planner for UK accountants attending Accountex 2026. Visitors answer five quick questions about their practice's problems, software interests, and time at the show. The tool scores all 250+ sessions and exhibitor stands against their answers, then generates a personalised plan in under 60 seconds.

It is a lead magnet. The plan is gated behind an email save. That is the conversion point.

---

## Strategic purpose

| Goal | Mechanic |
|------|----------|
| Capture warm leads | Email required to save the plan |
| Signal intent and segment | Five-question onboarding surfaces firm size, role, problem area, and software categories being evaluated |
| Drive Accountex attendance to the Workiro stand | Workiro's booth is surfaced as a recommended exhibitor for relevant visitors |
| Build brand authority | Co-created with three credentialed practitioners (Francesca McClory FMAAT, Robyn Milstead CTA, Rachel Gregory from Accountex) |
| Generate post-event pipeline | Debrief report and CPD log keep the tool open after the show; team notes extend reach into non-attending colleagues |

---

## User journey (five stages to conversion)

1. **Who's going?** — Solo or team (2–5 people). Team mode generates a shareable invite link, multiplying data capture per firm.
2. **Your mission** — Free-text problem statement, prompted by 12 chips (MTD, AI, onboarding, AML, document chaos, etc.). This is the highest-signal field for sales.
3. **Software categories** — Multi-select: practice management, AI/automation, bookkeeping, tax/MTD, document management/portals, payroll, or general inspiration.
4. **Availability** — Half day Wednesday, full day Wednesday, full day Thursday, or both days.
5. **Role** — Practice founder/partner, senior accountant, bookkeeper, FD/CFO, junior/trainee, or other. Adjusts the framing of surfaced sessions.

After the five questions, a reveal animation scores sessions and exhibitors, then displays a pre-selected plan. The visitor reviews, edits if needed, and hits **Save my plan** — triggering the email capture and unlocking the full in-show experience.

---

## Post-save features (in-show and after)

These extend engagement beyond the email capture and feed the debrief report:

- **Checklist tab** — Personal session and booth schedule, filtered by AI-match score
- **Team tab** — Live shared notes attributed to each team member. Solves the "what did Dave think of the AI panel?" problem on Monday morning.
- **Debrief tab** — Auto-drafted post-show summary with top vendors, team decisions, and action items. Designed to be shareable internally — extends brand reach into the firm.
- **CPD log** — Auto-filled from attended sessions (up to 16 hours across both days). Relevant to AAT and ICAEW members; increases perceived utility and return visits.

---

## Supporting campaign assets

| Asset | Date | Detail |
|-------|------|--------|
| Pre-show panel webinar | 6 May 2026, 11:00–11:45 BST | Free · Online · Hosted by Alexandra Hayter (Workiro) · Panel: Francesca McClory FMAAT, Robyn Milstead CTA, Rachel Gregory (Accountex) |
| Programme data | Loaded in `programme.csv` | 250+ sessions across 16 theatres, scored by the AI matching logic |

---

## Lead data captured per sign-up

| Field | Source |
|-------|--------|
| Email address | Save screen |
| Firm problem statement | Stage 2 free text |
| Software categories being evaluated | Stage 3 multi-select |
| Show attendance window | Stage 4 |
| Role / seniority | Stage 5 |
| Solo or team | Stage 1 |
| Team size (if team) | Invite link usage |
| In-show engagement (sessions rated, notes added) | Post-save app activity |

---

## Key dates

| Date | Milestone |
|------|-----------|
| 6 May 2026 | Pre-show webinar (live recording available after) |
| 13 May 2026 | Accountex Day 1 — show opens 09:30 |
| 14 May 2026 | Accountex Day 2 — show closes 16:30 |

---

## Repository contents

| Path | Purpose |
|------|---------|
| `index.html` | Landing page and 5-stage wizard |
| `plan/index.html` | Post-save app shell (tabs rendered by JS) |
| `js/` | Client-side modules: wizard, plan tabs, filter, auth, API caller |
| `css/main.css` | All styles — compiled static file, edit directly |
| `data/programme.json` / `data/exhibitors.json` | Pre-built session and exhibitor data (generated from CSVs) |
| `programme.csv` / `exhibitors.csv` | Source data — run `node scripts/sessions-csv-to-json.js` to rebuild JSON |
| `supabase/` | Supabase config, Edge Function (Claude AI ranker), and DB migrations |
| `scripts/` | Node.js data pipeline (CSV → JSON) |
| `CNAME` | GitHub Pages custom domain → `gameplan.workiro.com` |

---

## Ops notes

- Deployed via GitHub Pages. Push to `main` auto-deploys. No frontend build step — JS/HTML/CSS are served as-is.
- Backend is Supabase (Postgres + Auth + Edge Functions). The AI matching Edge Function (`supabase/functions/match-sessions/`) calls Claude Haiku and must be deployed separately: `supabase functions deploy match-sessions`.
- To update session or exhibitor data: edit the CSVs, run `node scripts/sessions-csv-to-json.js` and `node scripts/exhibitors-csv-to-json.js`, commit the generated JSON files.
- See `CLAUDE.md` for full developer reference.
