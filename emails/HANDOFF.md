# AutoEvent for Accountex 2026 — Email + Schema handoff

Everything dev needs to wire up the new email flow and the marketing
opt-in field on the save form.

---

## TL;DR — two things to do

1. **Database:** add a column to `public.users`:

   ```sql
   ALTER TABLE public.users ADD COLUMN marketing_opt_in BOOLEAN DEFAULT FALSE;
   ```

   The wizard's save-form upsert at `js/wizard.js:464` already writes to
   this column. Without the column, signup will error.

2. **Email templates:** 7 HTML files live in this folder
   (`emails/`). Copy each one into Supabase Auth / Postmark / SendGrid
   per the table below. Subject + sender + variables are in the
   comment block at the top of each `.html` file.

---

## Where to find each thing

- **Source files:** `emails/` folder in the repo, deployed live at
  `https://autoevent.io/emails/welcome.html` etc.
- **Visual preview hub:** `https://autoevent.io/emails/` — opens
  every template side-by-side for review.
- **Sender / Reply-To** for every template: `AutoEvent <hello@autoevent.io>`

---

## The 7 templates

| Template | Trigger | Subject |
|---|---|---|
| `welcome.html` | Account creation (right after wizard save form) | *{{firstName}} — your Accountex plan is ready. Open it inside.* |
| `login-link.html` | **NEW** · Every time a user submits the `/login/` form | *{{firstName}} — your AutoEvent login link* |
| `team-invite.html` | 24h post-signup if user has 0 teammates AND event >48h away | *{{firstName}} — bring your team to your Accountex workspace* |
| `teammate-joined.html` | When someone accepts the workspace's invite link | *{{joinerFirstName}} just joined your Accountex workspace* |
| `day-before.html` | Tue 12 May ~5pm UK | *Accountex tomorrow — open your plan tonight* |
| `day1-morning.html` | Wed 13 May 7:30am UK | *Your Accountex Day 1 starts now — open your plan* |
| `day-of-login.html` | Wed 13 May, show floor opens | *You're in at Accountex — log in and bring your team* |

**Preview text (preheader)** is built into each template as a hidden
`<div style="display:none;...mso-hide:all;">` at the top of `<body>`.
Don't strip it — that's what shows in the inbox preview line under the
subject.

---

## Login flow context

- **welcome.html** is the *first* login link. One-time use. Sent right
  after the wizard.
- **login-link.html** is the *recurring* login email. Sent fresh every
  time a user submits the `/login/` form.
- All "save / star / pin / flag this email" copy was removed from the
  old templates — it was misleading under this single-use model.

Subsequent lifecycle emails (day-before, day-of, etc) link to a fresh
magic link or to `/login/` directly.

---

## Template variables

| Variable | Used in |
|---|---|
| `{{firstName}}` | All templates |
| `{{loginUrl}}` | welcome, login-link, team-invite, teammate-joined, day-before, day1-morning, day-of-login |
| `{{teamInviteUrl}}` | welcome, team-invite, teammate-joined, day-before, day-of-login |
| `{{joinerFirstName}}`, `{{joinerFullName}}`, `{{joinerRole}}`, `{{teamSize}}`, `{{remainingSpots}}` | teammate-joined |
| `{{teamGreeting}}`, `{{teamBody}}` | day-before (conditional based on `teamSize`) |
| `{{unsubscribeUrl}}` | All templates |

---

## Marketing opt-in handling

The save form now collects an opt-in via a new checkbox. It writes to
`public.users.marketing_opt_in` (the column you'll add — see TL;DR).

**Use this column to gate the lifecycle / marketing emails:**
`team-invite.html`, `day-before.html`, `day1-morning.html`,
`day-of-login.html`.

**Transactional emails send regardless of opt-in** because they're
functional, not marketing: `welcome.html`, `login-link.html`,
`teammate-joined.html`.

---

## Anti-spam considerations baked in

- Subject lines lead with first name where possible — personal,
  transactional tone, low spam-score
- `welcome.html` includes a "mark not junk" reminder card (the previous
  welcome email was being flagged in Outlook)
- Single primary CTA per email
- `login-link.html` has the standard "didn't request this?" security
  disclaimer
- Plain-text fallbacks live in the original `Style/Email/Emails/`
  folder if you want to use them — note they'll need the same
  brand/URL substitutions applied

---

## Checklist for dev

- [ ] Schema: `marketing_opt_in` column added to `public.users`
- [ ] Subject lines configured per the table above
- [ ] Sender + Reply-To: `AutoEvent <hello@autoevent.io>` (DMARC /
      SPF / DKIM aligned for `autoevent.io` to keep delivery clean)
- [ ] Variables wired up per template
- [ ] Welcome + login-link emails sent via Supabase Auth's
      email-template hooks (or your transactional ESP)
- [ ] Lifecycle emails (team-invite, day-before, etc) scheduled jobs
      that respect `marketing_opt_in`
- [ ] Test send from each template — visually check the preheader
      appears in inbox preview
- [ ] Test the full new-user flow: wizard → save → welcome email →
      click link → enter plan
- [ ] Test the recurring-login flow: visit `/login/` → enter email →
      login-link email → click → enter plan

---

## Privacy / terms link

All pages link to `https://www.workiro.com/terms-and-policies/autoevent`.
Legal copy for that URL is being prepared by Matty separately. Dev
doesn't need to touch the page itself, just trust the link.
