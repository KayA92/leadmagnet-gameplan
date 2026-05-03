# Scripts — Data Pipeline Reference

This folder contains the two CSV-to-JSON converters that build the static data files
served to the app frontend. No build tooling, no npm — plain Node.js.

---

## Output files (source of truth for the app)

| File | Built by | Used by |
|---|---|---|
| `data/exhibitors.json` | `exhibitors-csv-to-json.js` | `js/filter.js` (booth pre-filter), `js/plan.js` (Checklist tab, booth cards) |
| `data/programme.json` | `sessions-csv-to-json.js` | `js/filter.js` (session pre-filter), `js/plan.js` (Checklist tab, session cards) |

Both files are committed to git and served statically via GitHub Pages. Rebuilding and
committing updated versions is how you deploy data changes.

---

## Exhibitor pipeline — the four run modes

### 1. Full scoring run
Run when setting up for the first time, or when you want to regenerate all 37 pain tag
scores from scratch for every exhibitor.

```bash
node scripts/exhibitors-csv-to-json.js --score
```

- Calls Claude Haiku once per exhibitor (~315 calls, ~5–6 minutes)
- Uses two-layer scoring: keyword signal matching (deterministic) + Haiku semantic scoring
- Writes `data/exhibitors.json` with `pain_scores` on every exhibitor
- Writes `data/exhibitors-pain-scores.csv` — review this before committing
- Estimated cost: ~$0.70–$1.50 (prompt caching enabled after first call)

### 2. CSV column added or changed (no re-scoring)
Run after adding a new column to `exhibitors.csv` or correcting a field value when you
do not need scores to change.

```bash
node scripts/exhibitors-csv-to-json.js
```

- No API calls, no cost, runs in under a second
- Reads `exhibitors.csv` fresh and rebuilds the array
- **Automatically preserves** any `pain_scores` already in `data/exhibitors.json` —
  they are merged back in by company name, so previously scored exhibitors keep their scores
- Use this whenever you add a new data field (e.g. `company_size`) to the CSV

### 3. Signal keywords changed for one pain tag
Run after editing the `signals` array for a specific tag in `PAIN_TAGS` inside the script.
Changed signals alter what keyword evidence is passed to Haiku, so the affected tag's
scores across all exhibitors need refreshing.

```bash
node scripts/exhibitors-csv-to-json.js --score --tag <tag-id>
```

Example — signals changed for the `ai-data-mess` tag:
```bash
node scripts/exhibitors-csv-to-json.js --score --tag ai-data-mess
```

- Calls Haiku once per exhibitor using a compact single-tag prompt (~1/37th the output tokens)
- Updates **only** the specified tag's entry in each exhibitor's `pain_scores`
- All other 36 tag scores are left untouched
- Estimated cost: ~$0.03–$0.05 for all 315 exhibitors
- Valid tag IDs: `ai-start`, `ai-data-mess`, `mtd-volume`, `mtd-clients`, `margin`,
  `hiring`, `retention`, `burnout`, `docs`, `chasing`, `defensible-files`, `aml`,
  `disconnected`, `ai-roi`, `advisory`, `advisory-charge`, `winning`, `ai-team`,
  `cyber`, `penalties`, `frs102`, `portal`, `ai-govern`, `ai-skills`, `onboarding`,
  `month-end`, `bankfeeds`, `cpd`, `career`, `leadership`, `cashflow`,
  `pe`, `exit`, `outsource`, `niche`, `cross-border`, `rd`

### 4. Exhibitor data changed in the CSV
Run after updating a specific exhibitor's description, products, or categories in
`exhibitors.csv`. Their score may have changed with the new data.

```bash
node scripts/exhibitors-csv-to-json.js --score --exhibitor "<name>"
```

Example — Workiro's description was updated:
```bash
node scripts/exhibitors-csv-to-json.js --score --exhibitor "Workiro"
```

- Matches by case-insensitive substring — `"IRIS"` matches "IRIS Software", "IRIS Elements", etc.
- Calls Haiku for matching exhibitor(s) only, all 37 tags
- Merges updated scores back into the full JSON; all other exhibitors are untouched
- Estimated cost: pennies (1–3 API calls)

You can combine `--exhibitor` and `--tag` to re-score a single tag for a single exhibitor:
```bash
node scripts/exhibitors-csv-to-json.js --score --exhibitor "Workiro" --tag ai-data-mess
```

---

## Adding a new field to exhibitors.json

The JSON is the source of truth consumed by the app frontend. To add a new field:

1. **Add the column** to `exhibitors.csv` with the appropriate header name
2. **Register the column** in the `H` index map in the script:
   ```js
   const H = {
     ...
     companySize: idx('Company Size'),   // ← add this
   };
   ```
3. **Add the field** to the `map()` return object:
   ```js
   return {
     ...
     company_size: get(H.companySize),   // ← add this
   };
   ```
4. **Run without `--score`** to rebuild — scores are preserved automatically:
   ```bash
   node scripts/exhibitors-csv-to-json.js
   ```
5. **Commit** `exhibitors.csv` and `data/exhibitors.json` together

No API calls needed. The new field appears in every exhibitor object immediately.

### Worked example: company_size enrichment

The plan is to surface booth recommendations that include a mix of larger established
vendors and smaller specialist vendors — e.g. "3 large + 2 small" suggestions per user.

Proposed `exhibitors.csv` values for a `Company Size` column:

| Value | Meaning |
|---|---|
| `large` | 250+ employees, widely known brand (IRIS, Sage, Xero, etc.) |
| `mid` | 50–250 employees, established product |
| `small` | Under 50 employees, specialist or early-stage |

Once the column is in the CSV and the field added to the script, `company_size` will
be available in every exhibitor object in `filter.js` and `plan.js` for use in
recommendation logic.

---

## How pain scores flow into the app

```
exhibitors.csv
    ↓  exhibitors-csv-to-json.js --score
data/exhibitors.json   (pain_scores per exhibitor)
    ↓  served statically
js/filter.js           (pre-filter: score exhibitors against user's selected pains)
    ↓  top 20 booths passed to Edge Function (or scored deterministically — future)
js/plan.js             (Checklist tab: render booth cards with match reasons)
```

**Band weights** (defined in `js/filter.js`, applied at runtime):

| Band | Weight | Tags |
|---|---|---|
| scorching | 3.0 | ai-start, ai-data-mess, mtd-volume, mtd-clients, margin, hiring, retention, burnout |
| hot | 2.5 | docs, chasing, defensible-files, aml, disconnected, ai-roi, advisory, advisory-charge, winning, ai-team, cyber, penalties, frs102, portal |
| warm | 2.0 | ai-govern, ai-skills, onboarding, month-end, bankfeeds, cpd, career, leadership, cashflow |
| specialist | 1.5 | pe, exit, outsource, niche, cross-border, rd |

At runtime: `score = Σ ( pain_scores[pain].score × BAND_WEIGHTS[band] )` for each
pain the user selected. Higher band weight means a scorching-band match counts more
than a warm-band match for the same raw Haiku score.

---

## API key setup

Scoring requires an Anthropic API key. Store it in `scripts/.env` (gitignored):

```
ANTHROPIC_API_KEY=sk-ant-api03-...
```

The script reads this file automatically. You can also export the key in your shell
(`export ANTHROPIC_API_KEY=...`) if you prefer not to use the file.

**Rotate the key** if it is ever shared in a chat or logged anywhere — generate a
new one at console.anthropic.com and update `scripts/.env`.

---

## Sessions pipeline

```bash
node scripts/sessions-csv-to-json.js
```

Converts `programme.csv` → `data/programme.json`. No AI scoring — sessions are
pre-filtered and ranked entirely by the Edge Function at plan-generation time.
Run this whenever session data changes in the CSV.
