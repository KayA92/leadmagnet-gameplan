# Email Flows & Plan Access

Reference for every email sent by the app, how plan access works end-to-end, and known gaps.

---

## Emails Sent

### Day-before reminder
**Trigger:** Manual  
**Sent via:** HubSpot (manual send, no automation configured yet)  
**Content:** Pre-conference reminder to attendees who created a plan  
**Status:** Not automated

---

### Day-of reminder
**Trigger:** Manual  
**Sent via:** HubSpot (manual send, no automation configured yet)  
**Content:** Reminder/prompt on the day of the conference — this is a marketing email, not an auth email  
**Note:** Entirely separate from the login magic link. Does not contain a sign-in link.  
**Status:** Not automated

---

### Login magic link (returning user)
**Trigger:** Returning user requests a link on [/login/](login/index.html)  
**Sent via:** Supabase Auth (`signInWithOtp`)  
**Template:** Supabase dashboard → Auth → Email Templates → "Magic Link"  
**Redirect URL:** `/magic-link-confirm/?` (with `?team=TOKEN` appended if an invite token is present)  
**What happens after click:** [magic-link-confirm/index.html](magic-link-confirm/index.html) stores the token hash in `sessionStorage`, then redirects to `/plan/` where `verifyOtp()` exchanges it for a live session  

---

### Welcome / first-time magic link
**Trigger:** New user completes the wizard and clicks "Unlock my game plan"  
**Sent via:** Supabase Auth (`signInWithOtp`) — same mechanism as the returning-user login link  
**Template:** Same Supabase dashboard "Magic Link" template — there is no separate welcome email  
**Redirect URL:** `/magic-link-confirm/?team=TOKEN&` if the user arrived via a team invite, otherwise `/magic-link-confirm/?`  
**Note:** The magic link doubles as the welcome email for new users. It is the first email they ever receive.

---

### Team invite — new user
**Trigger:** Team lead enters a colleague's email in the Team tab  
**Sent via:** `send-team-invite` Supabase Edge Function → Resend  
**Template:** HTML lives in the Edge Function code (not the Supabase dashboard): [`emails/team-invite-new-user.html`](emails/team-invite-new-user.html)  
**Email CTA destination:** `/join/?team=TOKEN&email=ENCODED_EMAIL&inviter=ENCODED_NAME&company=ENCODED_COMPANY`  
**What happens after click:**  
1. Invitee lands on [`/join/`](join/index.html) — a personalised invite landing page (not the magic link page). The headline and copy are filled with the inviter's name and company from the URL params. This page exists specifically so the invitee gets context before entering the wizard.  
2. They click **"Plan Accountex with [inviter]"** — the CTA forwards them to the wizard at `/?team=TOKEN&email=...`  
3. They complete the wizard — the `?team=` token is carried in `state.teamInviteToken` and written to `localStorage` as a safety net  
4. On save ("Unlock my game plan"), the token is embedded into the magic link redirect URL so it survives the email click: `/magic-link-confirm/?team=TOKEN&`  
5. They click the magic link → land on `/magic-link-confirm/` (the standard auth handoff page) → redirected to `/plan/?team=TOKEN`  
6. On the plan page, authentication completes and they are **automatically added to the team** — no separate accept step  

**Note:** The `/join/` page also has a secondary link — "Already use AutoEvent? Log in to join from your account →" — which takes them to `/login/?team=TOKEN&email=...` if they already have a plan. This handles the edge case where someone was a new user when the invite was sent but had since created an account.  

---

### Team invite — existing user
**Trigger:** Team lead enters a colleague's email in the Team tab (colleague already has a plan)  
**Sent via:** `send-team-invite` Supabase Edge Function → Resend  
**Template:** HTML lives in the Edge Function code: [`emails/team-invite-existing-user.html`](emails/team-invite-existing-user.html)  
**Link destination:** `/login/?team=TOKEN&email=ENCODED_EMAIL`  
**What happens after click:**  
1. Invitee logs in via the login page — the `?team=` token is passed through the magic link redirect  
2. They land on `/plan/` — a "Join [Company]'s team?" banner appears  
3. They must click **Join team** to accept — this calls the `accept_team_invite` RPC  
4. Page reloads; they are now a team member  

---

### Team invite reminder
**Status:** Not currently configured

---

### Teammate joined notification
**Status:** Not currently configured

---

## How a User Accesses Their Plan

There are four entry paths to `/plan/`:

### Path 1 — Magic link click (same device/browser as where plan was created)
1. User clicks magic link in email
2. Lands on `/magic-link-confirm/` — token hash stored in `sessionStorage`, redirect to `/plan/`
3. `initPlan()` reads token from `sessionStorage`, calls `supabase.auth.verifyOtp()`
4. On success: `handleSignIn()` recovers `pendingPlan` from `localStorage`, saves to DB, renders plan

### Path 2 — Magic link click (different device or browser)
1. User clicks magic link in email on a different device
2. Same `/magic-link-confirm/` flow — token stored in that device's `sessionStorage`
3. `initPlan()` calls `verifyOtp()`, authentication succeeds
4. No `pendingPlan` in `localStorage` on this device — `claim_anonymous_plan_by_email()` RPC attempts to locate the plan by email address
5. `loadLatestPlan()` fetches the plan from the DB; plan renders

### Path 3 — Returning user, already authenticated (active session)
1. User navigates to `/plan/` directly
2. `initPlan()` finds no `token_hash`, calls `getUser()` — returns active session
3. `handleSignIn()` runs with existing user, loads plan from DB

### Path 4 — In-app team invite detection (already logged in, no URL token)
1. User is already on `/plan/` when a team invite is sent
2. `initPlan()` calls `get_incoming_invite` RPC on load
3. If a pending invite exists, the "Join team?" banner is shown
4. User clicks **Join team** → `accept_team_invite` RPC → page reload

---

## Known Gaps & Risks

### High priority

**Join banner disappears on page refresh**  -- will keep working on this
[js/plan.js](js/plan.js) ~line 3243–3247  
When a returning user opens a team invite link, the `?team=` token is removed from the URL (to prevent re-triggering) and from `localStorage`. The join banner appears, but if the user refreshes before clicking "Join team", the banner is gone permanently. The `get_incoming_invite` RPC should catch this case, but only fires for users who are already in-app — it's a fallback, not a guarantee. If the invite was already partially processed and cleared from the URL, the user has no way to recover it without a new invite email.

**Magic link is unusable if opened on a different device to where plan was created**   -- i dont think this is a problem, i would expect magic links to be browser specific?

[magic-link-confirm/index.html](magic-link-confirm/index.html) ~line 103, [js/plan.js](js/plan.js) ~line 4994  
The token hash is stored in `sessionStorage` (tab-scoped, not shared). The plan data is in `localStorage` (device-scoped). If a new user creates a plan on their phone but clicks the magic link email on their desktop, the desktop has neither the sessionStorage token (it was stored on phone) nor the `pendingPlan` in localStorage. The `claim_anonymous_plan_by_email` RPC is the recovery mechanism, but see next gap.

**`claim_anonymous_plan_by_email` fails silently** 

[js/plan.js](js/plan.js) ~line 3225–3229  
This RPC is the only recovery path when a user opens their magic link on a different device. If it fails (no matching anonymous plan by email, permissions error, etc.), the error is swallowed — the user lands on "No plan found. Create yours →" with no explanation that their plan exists but couldn't be located.

**Reauth form loses the team invite token**  -- they would receive the notification in the app of the invite. Team mates can easily resend

[js/plan.js](js/plan.js) ~line 3413–3490  
If a user's magic link expires and they are prompted to re-enter their email on the plan page, the fresh magic link sent from that form uses the default redirect URL (`/magic-link-confirm/?`) with no `?team=` param. The team invite token is lost. A new invite email would be required.

---

## Outstanding Work

### Emails to complete

| Email | Status | Notes |
|---|---|---|
| Day-before reminder | Not automated | Manual HubSpot send for now |
| Day-of reminder | Not automated | Manual HubSpot send for now |
| Team invite reminder | Not built | Send X days after invite if invitee hasn't created a plan yet |
| Teammate joined notification | Not built | Notify the team lead when someone accepts their invite |

---

### Team invite — existing user: skip the login step

**Current experience:** Existing user receives team invite email → clicks CTA → lands on `/login/` with email pre-filled → clicks "Send me a link" → receives a second magic link email → clicks that → lands on `/plan/` with join banner.

**Desired experience:** The invite email itself contains a magic link. One click → straight into `/plan/` with the join banner. No second email, no intermediate step.

**How to implement:** In [supabase/functions/send-team-invite/index.ts](supabase/functions/send-team-invite/index.ts), for existing users call `supabase.auth.admin.generateLink({ type: 'magiclink', email: inviteeEmail, options: { redirectTo: '/magic-link-confirm/?team=TOKEN' } })` to generate a signed magic link at send time, then use that URL as the email CTA instead of the `/login/` URL. The rest of the flow (magic-link-confirm → plan → join banner) is unchanged.

**Also consider:** A `/join/`-style personalised landing page for existing users so the invite email has the same warm, contextual feel as the new-user invite — rather than dropping them straight into the plan. Could be the same `/join/` page with a conditional branch, or a separate page.

---

### Debrief tab — rank numbers visually cut off

The rank numbers (1, 2, 3…) in the hot sessions/booths list on the Debrief tab are clipped. The numbers use `background-clip: text` with a gradient and `line-height: 1` at 30px — the `overflow: hidden` on `.debrief-hot-card` ([css/main.css](css/main.css) ~line 6663) is likely the cause, or the cell needs more padding. Needs a CSS tweak and visual check on desktop and mobile.

---

## Test Cases

Work through these after completing the items above. Tick each once confirmed.

### New user — standard flow
- [ ] Complete wizard, click "Unlock my game plan", enter email → magic link email arrives
- [ ] Click magic link on the **same device/browser** → `/plan/` loads with plan rendered correctly
- [ ] Click magic link on a **different device** → `/plan/` loads and plan is recovered correctly
- [ ] Let the magic link expire → re-auth form appears on `/plan/`, new link can be requested and works

### New user — team invite flow
- [ ] Receive team invite email as a new user → CTA goes to `/join/`, inviter name and company visible in headline
- [ ] Click CTA on `/join/` → forwarded to wizard with `?team=TOKEN` in the URL
- [ ] Complete wizard → magic link email arrives
- [ ] Click magic link → land on `/plan/` → **automatically added to team**, no separate accept step, no join banner
- [ ] Open magic link on a different device from where wizard was completed → team join still completes correctly

### Existing user — login flow
- [ ] Go to `/login/`, enter email → magic link email arrives → click link → `/plan/` loads correctly
- [ ] Navigate directly to `/plan/` with an active session → plan loads without requesting a new link

### Existing user — team invite flow (current)
- [ ] Receive team invite email → CTA goes to `/login/` with email pre-filled
- [ ] Request link → receive email → click → land on `/plan/` with join banner visible
- [ ] Click "Join team" → banner disappears, team membership confirmed after reload
- [ ] Refresh the page **before** clicking "Join team" → join banner reappears (in-app `get_incoming_invite` fallback)

### Existing user — team invite flow (post-improvement, once built)
- [ ] Receive team invite email → CTA is a direct magic link, no login page
- [ ] Click CTA → land on `/plan/` in one step with join banner visible
- [ ] Join banner shows correct team name and company
- [ ] Click "Join team" → confirmed as team member

### Debrief tab — rank numbers
- [ ] Rate at least one session and one booth on the Checklist tab
- [ ] Open Debrief tab → rank numbers (1, 2, 3…) are fully visible, not clipped on any edge
- [ ] Check on mobile (≤640px) — rank numbers still fully visible
- [ ] Hot list is ordered correctly (highest-rated first)

### Edge cases
- [ ] Invite link forwarded via an email client that strips query strings → `/join/` falls back to `/` without breaking
- [ ] Invite sent to someone already in the team → user sees a readable error, not a raw DB constraint string
- [ ] User was a new user when invited but creates their own account before clicking the invite link → secondary "Already use AutoEvent?" link on `/join/` routes them to `/login/?team=TOKEN` correctly
