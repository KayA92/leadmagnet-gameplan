// Regenerates data/programme.json from programme.csv
// Usage: node scripts/csv-to-json.js
'use strict';
const fs   = require('fs');
const path = require('path');

// Maps raw CSV category strings → filter key(s) used in _EDITOR_CATEGORY_LABELS / PLAN_CATEGORY_MATCH
const CAT_MAP = {
  'AI':                                                                          ['ai-automation'],
  'AI & Automation':                                                             ['ai-automation'],
  'AI / Bookkeeping':                                                            ['ai-automation', 'bookkeeping'],
  'AI / Practice Management':                                                    ['ai-automation', 'practice-management'],
  'AML - Anti Money Laundering':                                                 ['aml-kyc'],
  'AML/KYC':                                                                     ['aml-kyc'],
  'Auto Enrolment / Pensions':                                                   ['payroll'],
  'Banking & Payments':                                                          ['banking-payments'],
  'Banking Services':                                                            ['banking-payments'],
  'Bookkeeping':                                                                 ['bookkeeping'],
  'Bookkeeping / AI':                                                            ['bookkeeping', 'ai-automation'],
  'CRM & Comms':                                                                 ['crm-comms'],
  'Change Management':                                                           ['practice-management'],
  'Client Relationships / Customer Service':                                     ['practice-management'],
  'Communication':                                                               ['practice-management'],
  'Cyber Security':                                                              ['cyber-security'],
  'Data & Analytics':                                                            ['data-analytics'],
  'Data Analytics':                                                              ['data-analytics'],
  'Diversity':                                                                   ['hr-people'],
  'Doc Automation':                                                              ['doc-automation'],
  'Document Management':                                                         ['doc-management'],
  'E Invoicing':                                                                 ['banking-payments'],
  'Education & Qualifications':                                                  ['practice-management'],
  'Engagement / Recruitment / Training / Development / Upskilling / Retention / HR': ['hr-people'],
  'Equality & Inclusion':                                                        ['hr-people'],
  'Exit Strategies':                                                             ['practice-management'],
  'Expenses':                                                                    ['expenses'],
  'Fractional CFO - Training / Systems / Advice':                                ['practice-management'],
  'HR & Leadership':                                                             ['hr-people'],
  'HR & People':                                                                 ['hr-people'],
  'How To Influence Up / How To Sell Yourself':                                  ['practice-management'],
  'Market Overview & Insight':                                                   ['marketing-growth'],
  'Market Trends':                                                               ['marketing-growth'],
  'Marketing & Growth':                                                          ['marketing-growth'],
  'Mental Health & Wellbeing':                                                   ['hr-people'],
  'Motivation / Leadership / Mindset':                                           ['practice-management'],
  'Neurodiversity':                                                              ['hr-people'],
  'Open Banking':                                                                ['banking-payments'],
  'Outsourcing':                                                                 ['outsourcing'],
  'Payment / FX':                                                                ['banking-payments'],
  'Payroll':                                                                     ['payroll'],
  'Practice Management':                                                         ['practice-management'],
  'Practice Management / Progressive Practice':                                  ['practice-management'],
  'Practice Management / Scaling':                                               ['practice-management'],
  'Pricing':                                                                     ['practice-management', 'marketing-growth'],
  'Regulation & Legislation':                                                    ['tax-mtd'],
  'Sales & Marketing / Branding':                                                ['marketing-growth'],
  'Sales & Marketing / Branding / Social Media':                                 ['marketing-growth'],
  'Sales & Marketing / Networking':                                              ['marketing-growth'],
  'Sales & Marketing / Scaling':                                                 ['marketing-growth', 'practice-management'],
  'Sales & Marketing / Social Media':                                            ['marketing-growth'],
  'Scaling / Practice Growth':                                                   ['practice-management', 'marketing-growth'],
  'Tax & MTD':                                                                   ['tax-mtd'],
  'Tax / VAT / MTD':                                                             ['tax-mtd'],
  'Time Management / Productivity':                                              ['practice-management'],
  'eSign':                                                                       ['esign'],
  // Unmapped — no matching filter key
  'Advisory':                                                     [],
  'Carbon accounting / Sustainability / ESG':                     [],
  'CFO':                                                          [],
  'Client Communication':                                         [],
  'Corp Responsibility':                                          [],
  'Digital Assets / Blockchain / Crypto Currency':               [],
  'Insolvency':                                                   [],
  'Legal':                                                        [],
  'Other':                                                        [],
  'Research & Development':                                       [],
  'Technology & Software':                                        [],
};

function parseCSV(text) {
  const rows = [];
  let row = [], field = '', inQuote = false;
  const chars = text.replace(/\r/g, '');
  for (let i = 0; i < chars.length; i++) {
    const c = chars[i];
    if (inQuote) {
      if (c === '"' && chars[i + 1] === '"') { field += '"'; i++; }
      else if (c === '"') inQuote = false;
      else field += c;
    } else {
      if (c === '"') inQuote = true;
      else if (c === ',') { row.push(field); field = ''; }
      else if (c === '\n') { row.push(field); rows.push(row); row = []; field = ''; }
      else field += c;
    }
  }
  if (field || row.length) { row.push(field); rows.push(row); }
  return rows;
}

function fixEncoding(s) {
  return (s || '')
    .replace(/â€™/g, "'").replace(/â€œ/g, '“').replace(/â€/g, '”')
    .replace(/â€"/g, '–').replace(/â€"/g, '—')
    .replace(/Ã©/g, 'é').replace(/Ã¨/g, 'è').replace(/Ã /g, 'à')
    .trim();
}

const root = path.join(__dirname, '..');
const csvText = fs.readFileSync(path.join(root, 'programme.csv'), 'utf8').replace(/^﻿/, '');
const rows = parseCSV(csvText);
const headers = rows[0].map(h => h.trim());

const idx = k => headers.indexOf(k);
const H = {
  id:      idx('Session ID'),
  title:   idx('Title'),
  day:     idx('Day'),
  date:    idx('Date'),
  theatre: idx('Theatre'),
  start:   idx('Start Time'),
  end:     idx('End Time'),
  cats:    idx('Categories'),
  desc:    idx('Description'),
  url:     idx('Session URL'),
};

const SPEAKERS = 5;

function slugId(title) {
  return 'auto-' + title.toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 60);
}

const sessions = rows.slice(1)
  .filter(r => r[H.title] && r[H.title].trim())
  .map(r => {
    const get = i => fixEncoding(r[i] || '');

    // Parse canonical_categories from Categories column
    const rawCats = get(H.cats).split(',').map(c => c.trim()).filter(Boolean);
    const canonicalSet = new Set();
    rawCats.forEach(c => (CAT_MAP[c] || []).forEach(k => canonicalSet.add(k)));

    // Parse speakers
    const speakers = [];
    for (let i = 1; i <= SPEAKERS; i++) {
      const base = `Speaker ${i} `;
      const nameIdx  = idx(base + 'Name');
      const titleIdx = idx(base + 'Job Title');
      const coIdx    = idx(base + 'Company');
      const urlIdx   = idx(base + 'Profile URL');
      if (nameIdx < 0) break;
      const name = get(nameIdx);
      if (!name) continue;
      speakers.push({
        name,
        job_title:   get(titleIdx),
        company:     get(coIdx),
        profile_url: get(urlIdx),
      });
    }

    const rawId = get(H.id);
    return {
      session_id:           rawId || slugId(get(H.title) + '-' + get(H.day) + '-' + get(H.start)),
      title:                get(H.title),
      day:                  get(H.day),
      date:                 get(H.date),
      theatre:              get(H.theatre),
      start_time:           get(H.start),
      end_time:             get(H.end),
      categories:           get(H.cats),
      canonical_categories: [...canonicalSet],
      description:          get(H.desc),
      speakers,
      session_url:          get(H.url),
    };
  });

const outPath = path.join(root, 'data', 'programme.json');
fs.writeFileSync(outPath, JSON.stringify(sessions, null, 2), 'utf8');
console.log(`Written ${sessions.length} sessions to ${outPath}`);
