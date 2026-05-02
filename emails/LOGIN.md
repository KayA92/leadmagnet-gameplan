# Login flow handoff — `/login/` page + magic-link auth

How the new dedicated login page works, every scenario it has to
handle, and what's still on the dev to-do list (per
`DELIVERABILITY.md` item 7).

---

## TL;DR

- **New page** at `/login/` (folder + `index.html`) replaces the
  old top-bar popup
- **Auth flow:** user enters email → Supabase Auth sends
  single-use magic link → user clicks → land on `/plan/` (or
  `/plan/?invite=TOKEN` if joining a team)
- Every login = a *fresh* magic link. No "save this email"
  pattern. Welcome email's link is single-use too.
- Existing team-invite logic on `/plan/` is **untouched** —
  `accept_team_invite` RPC still runs there.
- **Two outstanding dev tasks**: resend button + "add to contacts"
  instruction (see *Outstanding work* at the bottom).

---

## File map

| File | Purpose |
|---|---|
| `login/index.html` | The page itself — markup, inline styles, page script |
| `js/auth.js` | Exposes `sendMagicLink(email, redirectTo)` — wraps Supabase Auth `signInWithOtp` |
| `css/main.css` (~line 7740+) | All `.login-page-*` styles |
| `js/plan.js` (~line 2132) | Handles `?invite=TOKEN` arrival post-magic-link → calls `accept_team_invite` RPC |

---

## The two URLs

| URL | What happens | Banner shown? |
|---|---|---|
| `/login/` | Plain magic-link page | No |
| `/login/?invite=TOKEN` | Same form, but stores `TOKEN` in JS state and forwards it through to the magic-link redirect URL so the team-invite flow survives the round trip | **Yes** — purple "You've been invited to join a team" banner above the email field |

Send team-invite emails as `https://autoevent.io/login/?invite={{token}}`.

---

## What happens on submit

The magic-link redirect URL the page sends Supabase is:

| Scenario | Redirect URL |
|---|---|
| Plain login | `https://autoevent.io/plan/` |
| Team invite | `https://autoevent.io/plan/?invite=<encoded TOKEN>` |

Supabase emails the magic link. User clicks it → lands at the
redirect URL with their auth session attached. From there, `plan.js`
takes over.

---

## Scenarios the page handles

### ✅ Returning user with an existing plan
- Visits `/login/`
- Enters email → magic link sent
- Clicks link → `/plan/` with their saved plan loaded

### ✅ New team member with an invite link
- Receives email with `https://autoevent.io/login/?invite=ABC`
  from a teammate's invite-share flow
- Lands on `/login/`, sees the *"You've been invited to join a
  team"* purple banner
- Enters email → magic link sent
- Clicks link → `/plan/?invite=ABC`
- `plan.js` reads `?invite=ABC`, calls `accept_team_invite(ABC)`
  RPC, joins the team atomically, opens the workspace
- Works for both *new* users (Supabase creates account) and
  *returning* users (signs into existing account)

### ✅ Inviter accidentally clicks their own invite link
- Same flow as above, but `accept_team_invite` is idempotent —
  the RPC returns "already a member" and no-ops. They just land
  in their own plan.

### ✅ User with no existing plan tries to log in
- Visits `/login/`, enters email
- Supabase Auth still sends a magic link (it's idempotent — creates
  the user on first click)
- They click → land at `/plan/` with **no saved plan**. `plan.js`
  shows the empty-state "no plan yet" view with a link back to `/`
  to build one
- The page also has a *"Don't have a plan yet? → Build one in 60
  seconds"* link in the secondary section, so users can skip the
  whole login dance

### ✅ User clicks magic link on different device/browser
- Works fine — magic links are not device-bound. Supabase Auth
  attaches the session to whichever browser opens the link.
- Cross-device handoff is covered by the new
  `claim_anonymous_plan_by_email()` RPC (migration `20260501000002`):
  if the user lands on `/plan/` without `localStorage.pendingPlanId`
  (i.e. on a different device), the RPC finds the orphaned anonymous
  user by matching email and transfers the plan to the now-authenticated
  user. Without this, cross-device link-clicks would land on an empty
  plan view.

### ⚠️ Magic link expired or already used
- Supabase Auth redirects to the redirect URL with an `error`
  query param (e.g.
  `/plan/#error=access_denied&error_code=otp_expired&...`)
- `plan.js` currently shows an error page with a re-enter-email
  form (Matty has a screenshot in `Style/Email/Link Landing.png`
  showing this state)
- **Edge case:** if the user came via an invite link and their
  magic link expires, the `?invite=TOKEN` is lost from the URL.
  They'd need to re-click the invite email or be re-invited. Low
  probability — magic links default to 1-hour expiry.

### ⚠️ User submits an invalid email
- Front-end check: must contain `@`. Otherwise inline error message
  *"Please enter a valid email address."* + focus the field.
- Supabase Auth itself also rejects badly-formatted emails — they'd
  get the generic *"Something went wrong"* error if our regex
  somehow lets through a malformed address.

### ✅ User submits, doesn't get email
- After submit, a *"Didn't get it in 60 seconds?"* prompt with a
  **Resend** button reveals after 60s. Click resends to the same
  email + redirect URL. 30s throttle between resends.
- If the user types a different email after the first send, the
  resend prompt is hidden + timers cleared so it never resends to
  a stale address.

### ⚠️ User has anonymous Supabase session from the wizard
- Some users go to `/login/` while still signed in anonymously
  (Supabase `signInAnon` runs at the top of the wizard)
- Magic link auth doesn't conflict — Supabase upgrades the anon
  session to the authenticated one when they click. No special
  handling needed in our code.

---

## Help + secondary links on the page

Every login page surfaces:
- *"Don't have a plan yet?"* → home page (`/`)
- *"Stuck or need help?"* → `mailto:help@autoevent.io`
- Footer privacy link → `/terms-and-policies/autoevent`

These are intentional — they catch users who:
- Got the URL but haven't actually signed up
- Have a problem with the magic link not arriving
- Want to know what data we collect

---

## Existing logic preserved

The new login page **does not** change any of the team-invite or
plan-loading behaviour on `/plan/`. Specifically:

| RPC / function | Where | Status |
|---|---|---|
| `accept_team_invite(p_invite_token)` | `js/plan.js` | Untouched ✓ |
| `get_invite_info(p_invite_token)` | `js/plan.js` | Untouched ✓ |
| `claim_anonymous_plan(plan_id)` | `js/plan.js` after magic-link click | Same-device handoff — untouched ✓ |
| `claim_anonymous_plan_by_email()` | `js/plan.js` after magic-link click | **NEW** — cross-device handoff (migration `20260501000002`) |
| `signInAnon` at wizard start | `js/wizard.js` | Untouched ✓ |

The `/login/` page is a **front-end addition**, not a back-end change.

---

## Outstanding work ✅ DONE

The two items previously flagged here (resend button + add-to-contacts
instruction) are both live. See the updated *Scenarios* section above
and `DELIVERABILITY.md` item 7 for current status.

What's left for dev (deliverability infra, not login flow):
- Configure Supabase Auth SMTP → Postmark sender = `hello@autoevent.io`
- Real `hello@autoevent.io` mailbox so replies + warming work
- DNS records (SPF / DKIM / DMARC) for autoevent.io

All covered in `DELIVERABILITY.md` items 1–3.

---

## Test checklist for dev

After any change to login-related code, walk through:

- [ ] **New user, no invite:** wizard → save → welcome email →
      click link → land in `/plan/` with the plan they built
- [ ] **Returning user, no invite:** `/login/` → email → magic
      link → `/plan/` with their existing plan
- [ ] **Team invite, new user:** `/login/?invite=ABC` → see banner
      → email → magic link → `/plan/?invite=ABC` → joined the
      team, see Team tab populated
- [ ] **Team invite, returning user:** same flow, but signs into
      existing account, gets added to team
- [ ] **Inviter clicks their own invite link:** same, but
      `accept_team_invite` no-ops, lands in their own plan
- [ ] **No plan, no invite:** `/login/` → email → click → `/plan/`
      → empty-state "build one" view
- [ ] **Expired magic link:** click an old link → error page →
      re-enter email → fresh link works
- [ ] **Resend (after item 7a is built):** submit → wait 60s →
      see Resend button → click → second email arrives
- [ ] **Help link:** clicking `help@autoevent.io` opens email
      client correctly
- [ ] **Privacy link:** opens
      `/terms-and-policies/autoevent` page
- [ ] **Mobile:** form, error messages, success messages all
      render correctly on iOS Safari + Android Chrome

---

## Page styling reference

Should anyone need to tweak it visually:

- Top-bar pattern: matches home + about (logo + "Accountex 2026"
  chip + "About" link + login pill). Same `.brand` + `.top-bar-right`
  classes as elsewhere.
- Hero: glass-pill brand wordmark + h1 *"Log in to your Accountex
  2026 plan"* with the "Accountex 2026 plan" phrase in the
  gradient italic em treatment
- Form input: 16px field with mail icon inside (left), 1.5px
  white-stroke border, mint focus ring + halo on focus
- Submit button: same `.cta-primary` as the home hero CTA
- Footer: same `.hero-page-footer` as other pages, plus the
  XU+Workiro `.sponsors-footer` block
- Mobile: padding 96px 18px 48px, fonts scale down sensibly
