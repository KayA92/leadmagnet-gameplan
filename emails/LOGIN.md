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

Send team-invite emails as `https://workiro-ai.com/login/?invite={{token}}`.

---

## What happens on submit

The magic-link redirect URL the page sends Supabase is:

| Scenario | Redirect URL |
|---|---|
| Plain login | `https://workiro-ai.com/plan/` |
| Team invite | `https://workiro-ai.com/plan/?invite=<encoded TOKEN>` |

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
- Receives email with `https://workiro-ai.com/login/?invite=ABC`
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

### ⚠️ User submits, doesn't get email
- **Currently:** they sit there. No retry path other than refreshing
  and re-submitting.
- **Fix planned:** see *Outstanding work* below — Item 7a in
  `DELIVERABILITY.md` calls for a "Resend my magic link" button
  that appears 60s after the success message.

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

| RPC / function | Where | Untouched |
|---|---|---|
| `accept_team_invite(p_invite_token)` | `js/plan.js` ~line 2132 | ✓ |
| `get_invite_info(p_invite_token)` | `js/plan.js` ~line 2151 | ✓ |
| `claim_anonymous_plan(plan_id)` | `js/plan.js` after magic-link click | ✓ |
| `signInAnon` at wizard start | `js/wizard.js` | ✓ |

Dev shouldn't need to touch any of these. The `/login/` page is a
**front-end addition**, not a back-end change.

---

## Outstanding work for dev

These are flagged in `DELIVERABILITY.md` (item 7) as in-app
mitigations for email-going-to-junk risk. Both should be done
before the show.

### 7a — Resend button on `/login/`

**Where:** `login/index.html`, in the `<script type="module">` block
that handles form submission.

**Behaviour:**
- After successful submit, the success message *"Check your inbox.
  A magic link is on its way to {email}"* appears.
- After **60 seconds**, additionally show a *"Didn't get the email?"*
  prompt with a **Resend** button.
- Clicking Resend re-fires `sendMagicLink(email, redirectTo)` and
  shows a confirmation *"Resent. Check your inbox again."*
- Throttle: max 1 resend per 30s per email (Supabase Auth
  rate-limits magic-link requests on the back-end too — they'll
  return 429 if you exceed this).

Approx 30 lines of JS + CSS.

### 7b — "Add to contacts" instruction

**Where:** `index.html` stage-email-sent screen + `emails/welcome.html`

**Behaviour:**
- Add a small instruction prompt to both:
  *"💡 Add `hello@autoevent.io` to your contacts — every email
  client treats messages from contacts as priority and skips spam
  filtering."*
- Style as a subtle muted card, similar to the existing junk-folder
  card on the success screen.

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
