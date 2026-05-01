# Email deliverability plan — AutoEvent for Accountex 2026

**The problem:** `autoevent.io` is a brand-new domain with zero sender
reputation. Workiro security won't let us send via `workiro.com`. The
welcome + login emails are critical — if they land in junk, users
can't access the app at all.

**The window:** ~2 weeks until Accountex (13–14 May).

**Realistic outcome with this plan in place:** ~85–90% inbox
placement at launch, climbing as engagement builds. Users who hit
junk are caught by in-app *"mark as not junk"* UX.

This doc has 8 actions, in priority order. Items 1–4 are
**non-negotiable**. Items 5–8 are uplift on top.

---

## 1. DNS authentication for `autoevent.io` — TODAY

**Owner:** Ops (DNS access required)

Without these, nothing else matters. Gmail and Yahoo *reject* mail
that doesn't authenticate (since their February 2024 sender
requirements update).

Add these three TXT records to `autoevent.io`:

| Record | Type | Value (example for Postmark — adjust per ESP) |
|---|---|---|
| `autoevent.io` | TXT | `v=spf1 include:spf.postmarkapp.com -all` |
| `[selector]._domainkey.autoevent.io` | TXT | (DKIM public key — provided by ESP) |
| `_dmarc.autoevent.io` | TXT | `v=DMARC1; p=none; rua=mailto:dmarc@autoevent.io;` |

Notes:
- Start DMARC at `p=none` for monitoring. After ~2 weeks of clean
  reports, move to `p=quarantine`.
- The DKIM selector and key value come from the ESP (item 2 below).
- Set up the mailbox `dmarc@autoevent.io` to receive aggregate
  reports (or use a service like Valimail / dmarcian — free tiers
  exist).

**Verification:** use [mxtoolbox.com](https://mxtoolbox.com) to
confirm SPF + DKIM + DMARC all return green.

---

## 2. Use Postmark as the transactional ESP

**Owner:** Matty (sign up) → Dev (configure)

Don't send via Supabase Auth's default SMTP — it's poor for new
domains. Don't roll your own SMTP either.

**Why Postmark specifically:**
- Refuses to send marketing mail → their shared IP reputation is
  spotless (best inbox placement in the industry for transactional)
- Brand-new domains land in inbox if DKIM is set up right
- Free for 100 emails/month, $10/mo for up to 10k. We'll comfortably
  fit in the cheap tier for the show.
- Postmark gives you bounce / complaint / open-rate dashboards out
  of the box — essential for monitoring delivery during the event

Alternatives if Postmark won't work for some internal reason:
**AWS SES** (more setup, IP warming on you) or **Resend** (newer,
similar transactional positioning).

**Setup steps:**
1. Matty signs up at [postmarkapp.com](https://postmarkapp.com)
2. Add `autoevent.io` as a verified Sender Domain
3. Postmark gives you the exact DKIM record + SPF include — paste
   these into ops's DNS task above
4. Generate a Server API token for transactional emails

**Dev task:** Configure Supabase Auth → Email Templates → SMTP
settings to point at Postmark:
- Host: `smtp.postmarkapp.com`
- Port: 587
- Username + Password: the Server API token from step 4
- Sender: `hello@autoevent.io`

**Templates affected (in `emails/` folder):** `welcome.html`,
`login-link.html`. These are the two transactional emails Supabase
Auth sends.

---

## 3. Set up a real `hello@autoevent.io` mailbox

**Owner:** Ops (~30 min)

A real mailbox at `hello@autoevent.io` is needed for two reasons:
1. **Replies** to our welcome / login emails come back somewhere
   monitored — and replies are gold for inbox reputation
2. **The warming service** (item 5 below) needs SMTP/IMAP access to
   a real mailbox to send warmup traffic from

Options:
- **Google Workspace** — $6/user/month. Simplest. Familiar interface.
- **Fastmail** — $5/user/month. Lighter, ad-free.
- **Microsoft 365** — if Workiro is already on Microsoft, easy.

Pick whatever Workiro's existing IT prefers. Just needs:
- IMAP + SMTP enabled
- Mailbox: `hello@autoevent.io` (and aliases: `help@autoevent.io`,
  `dmarc@autoevent.io`)

---

## 4. Update all email senders to `hello@autoevent.io`

**Owner:** Dev

Currently the templates in `emails/` say
`From: AutoEvent <hello@autoevent.io>`. Switch to
`AutoEvent <hello@autoevent.io>` everywhere:
- All 7 email template comment headers
- Supabase Auth SMTP sender setting
- The "sender" line in the in-app *"Check your inbox"* screen
  (`index.html` stage email-sent — the bit that says
  *"Sender: hello@autoevent.io"*)
- The *"mark not junk"* reminder text in the welcome email

Search-and-replace across `emails/` + `index.html` + `js/wizard.js`:
- `hello@autoevent.io` → `hello@autoevent.io`

---

## 5. Use a warming service — Lemwarm

**Owner:** Matty (sign up + connect)

Warming services aren't magic, but they add ~5–10pp to inbox
placement and they generate sending history fast. Worth ~$15 for the
2-week window.

**Pick: [Lemwarm](https://www.lemlist.com/lemwarm)** — by Lemlist,
solid reputation in cold-outreach circles, $29/month, no tool
onboarding required.

**Setup:**
1. Sign up
2. Connect the `hello@autoevent.io` mailbox via IMAP/SMTP (item 3)
3. Set warming to start at low volume (default settings are fine)
4. Let it run for the full 2 weeks

The warming service sends from the mailbox to a network of inboxes
that engage positively (open, reply, mark not junk). Postmark sends
the actual production transactional traffic from the *same* address
in parallel. Both signals contribute to autoevent.io's reputation.

**Don't** rely solely on this — see item 6.

---

## 6. Manual warming with Workiro team — Days 0–7

**Owner:** Matty (recruit) → Workiro internal team (engage)

Real human engagement is worth more than automated warmup. Get 30–50
Workiro team members to do the following over Days 0–7:

| Day | Volume | Action ask |
|---|---|---|
| 0–2 | 5–10 emails to internal team | Each person opens, replies *"got it!"*, clicks the login button, marks not junk if it lands there |
| 3–4 | 20–30 emails | Same ask — adds engagement velocity |
| 5–7 | 50+ to extended Workiro network + panellists' close networks | Same ask, broader audience |

**Brief to send each warming participant:**

> Hi — we're warming up our new email domain (autoevent.io) ahead of
> Accountex 2026. You'll get a test welcome email at [their email].
>
> Three things to do, takes 30 seconds:
> 1. **Open the email**
> 2. **Reply** with *"looks good"* (or anything — replies are the
>    strongest positive signal)
> 3. **Click the login button** inside
>
> If it landed in spam/junk, mark it as *"Not junk"* / move to inbox.
>
> Thank — this directly affects whether thousands of accountants get
> their plan emails next week.

This activity is what teaches Gmail/Outlook *"people want this
mail"*. Far more valuable than the automated warmup.

---

## 7. In-app mitigations — Days 7–10

**Owner:** Dev

The "Check your inbox" screen already includes a *"mark as not
junk"* reminder. Two more high-value adds:

### a) "Resend my login link" on `/login/`

If a user requests a login link and doesn't get it, they need a
button that resends. Currently the form just shows a success
message. Add:

- After submit success, show: *"Didn't get the email in 60 seconds?"*
  with a **Resend** button that re-fires the magic link request
- Throttle: max 1 resend every 30s per email address (Supabase Auth
  rate-limits magic-link requests anyway)

Without this, anyone who misses the email is locked out — the
resend is the safety net for everything we don't catch.

### b) "Add `hello@autoevent.io` to your contacts" instruction

On the success screen (and in the welcome email itself), add a
small instruction:

> 💡 **Add `hello@autoevent.io` to your contacts** — every email
> client treats messages from contacts as priority and skips spam
> filtering.

This is one of the strongest individual-user-side allowlist signals
that exists. People will skip it, but the ones who do it are
guaranteed inbox.

---

## 8. Phased launch — ramp the audience

**Owner:** Matty (audience timing) → Marketing (broadcasts)

Don't blast 5,000 accountants on Day 1 of a cold domain. Ramp:

| Days from now | Audience | Volume | Goal |
|---|---|---|---|
| 0–2 | Workiro internal team | 30–50 | Manual warming (item 6) |
| 3–7 | Workiro extended + panellists' networks | 100–200 | Real engagement, monitor delivery |
| 8–10 | Soft launch — partner firms, beta users | 500–1000 | Real-world signal |
| 11–13 | Full marketing push | All-comers | Should be in good shape |

Each batch should include high-engagement audiences first
(people who opted in, panellists' contacts, partner firms — not
purchased lists). Send to engaged people first; let them establish
the reputation that protects the cold-list send later.

---

## 9. Monitor delivery during the event

**Owner:** Dev / Matty

Set these up to know if delivery is working:

- **Postmark Server stats** — opens, bounces, delivery rate by
  recipient ISP. Should see 95%+ delivered, <1% bounces.
- **Gmail Postmaster Tools** — sign up at
  [postmaster.google.com](https://postmaster.google.com). Add
  `autoevent.io`. Shows spam rate, IP reputation, domain reputation
  per Gmail's view. Updates daily.
- **DMARC aggregate reports** — Postmark or a service like
  [postmarkapp.com/dmarc](https://dmarc.postmarkapp.com) (free)
  parses these into a dashboard. Shows whether your mail is passing
  DMARC alignment.

Check these daily during the warming period and during the event.
If Postmark complaint rate goes above 0.5% or Gmail spam rate above
0.3%, we have a problem and need to throttle marketing sends.

---

## Costs summary

| Item | Cost |
|---|---|
| Postmark (transactional) | ~$10/month for up to 10k sends |
| Mailbox at autoevent.io (Google Workspace) | $6/month |
| Lemwarm (warming) | $29/month for 2 weeks |
| **Total** | **~$45 for the duration** |

---

## Final realistic expectations

Even with all of the above:
- **Day 1 of public launch:** ~70–80% inbox, ~20–30% junk
- **By show day:** ~85–95% inbox if warming went well
- **Outlook 365 corporate** is the worst — many large firms have
  aggressive filtering you can't fully solve. The "junk → mark not
  junk" UX is essential here.
- Some users **will** miss the email regardless. The `/login/`
  resend flow is the safety net.

---

## What to tell stakeholders

> *"With Postmark + warming + DNS done right, we're targeting ~85%
> inbox placement at launch and ramping up through the show. The
> in-app UX has been designed so users who hit junk can still
> recover. Some Outlook 365 corporate filtering is unsolvable
> short-term — that's an industry reality."*

Don't promise 99%. Don't pretend the new-domain risk is zero.

---

## Owners + sequencing

**This week (Days 0–3):**
- Ops: DNS records (item 1) — DAY 0
- Ops: Mailbox setup (item 3) — DAY 0
- Matty: Sign up for Postmark (item 2) — DAY 0
- Matty: Sign up for Lemwarm (item 5) — DAY 1
- Dev: Configure Supabase Auth → Postmark (item 2) — DAY 1
- Dev: Update sender across templates (item 4) — DAY 1
- Matty: Recruit 30 internal warming participants (item 6) — DAY 1
- Internal team: Days 2–7 manual warming (item 6)

**Next week (Days 7–13):**
- Dev: `/login/` resend button (item 7a) — DAY 7
- Dev: "Add to contacts" instruction (item 7b) — DAY 7
- Matty: Soft launch to panellists / partners (item 8) — DAY 8
- All: Monitor Postmark + Gmail Postmaster (item 9) — daily

**Show day (13 May):**
- Full launch
- Monitor closely
- Resend button is the safety net
- help@autoevent.io monitored for "didn't get my link" complaints
