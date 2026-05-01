// Regenerates data/exhibitors.json from exhibitors.csv
// Usage: node scripts/exhibitors-csv-to-json.js
'use strict';
const fs   = require('fs');
const path = require('path');

const CAT_MAP = {
  'AI & Automation':                                      ['ai-automation'],
  'AML - Anti Money Laundering':                          ['aml-kyc'],
  'Accounts Payable / Accounts Receivable':               ['banking-payments'],
  'Analytics & Reporting':                                ['data-analytics'],
  'Audit':                                                ['tax-mtd'],
  'Auto Enrolment & Pensions':                            ['payroll'],
  'Banking & Payments':                                   ['banking-payments'],
  'Banking Services / Open Banking / Payment / FX Budgeting': ['banking-payments'],
  'Bookkeeping':                                          ['bookkeeping'],
  'Capital Allowances':                                   ['tax-mtd'],
  'Cash Flow Forecasting':                                ['banking-payments'],
  'Charity / Not for Profit':                             [],
  'Consulting & Business Services':                       ['practice-management'],
  'Corporate Finance / Mergers & Acquisitions':           ['practice-management'],
  'CRM':                                                  ['crm-comms'],
  'Cyber Security':                                       ['cyber-security'],
  'Data & Analytics':                                     ['data-analytics'],
  'Data Entry / OCR (Optical Character Recognition)':     ['doc-automation'],
  'Document Management':                                  ['doc-management'],
  'Education & Qualifications':                           ['practice-management'],
  'Employee Benefits / Incentives / Salary Sacrifice':    ['hr-people'],
  'ERP':                                                  ['practice-management'],
  'Expenses':                                             ['expenses'],
  'Foreign Exchange and Multi-Currency Services':         ['banking-payments'],
  'AML/KYC':                                              ['aml-kyc'],
  'HR':                                                   ['hr-people'],
  'HR & Leadership':                                      ['hr-people'],
  'HR & People':                                          ['hr-people'],
  'IT Solutions':                                         [],
  'Insolvency':                                           [],
  'Insurance':                                            [],
  'MTD':                                                  ['tax-mtd'],
  'Magazines & Publishing':                               [],
  'Marketing & Growth':                                   ['marketing-growth'],
  'O2C – Order-To-Cash':                             ['banking-payments'],
  'Outsourcing':                                          ['outsourcing'],
  'Outsourcing / Offshoring':                             ['outsourcing'],
  'Payment Process Services':                             ['banking-payments'],
  'Payroll':                                              ['payroll'],
  'Practice & Project Management':                        ['practice-management'],
  'Practice Management':                                  ['practice-management'],
  'Recruitment & Training':                               ['hr-people'],
  'Research & Development':                               [],
  'Restructuring & Business Recovery':                    ['practice-management'],
  'Sales & Marketing':                                    ['marketing-growth'],
  'Spend Management':                                     ['expenses'],
  'Tax':                                                  ['tax-mtd'],
  'Tax & MTD':                                            ['tax-mtd'],
  'Association / Professional Body':                      [],
  'Other':                                                [],
};

function fixEncoding(s) {
  return (s || '')
    .replace(/â€™/g, "'").replace(/â€œ/g, '"').replace(/â€/g, '"')
    .replace(/â€"/g, '–').replace(/â€"/g, '—')
    .replace(/Ã©/g, 'é').replace(/Ã¨/g, 'è').replace(/Ã /g, 'à')
    .trim();
}

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

const root    = path.join(__dirname, '..');
const csvText = fs.readFileSync(path.join(root, 'exhibitors.csv'), 'utf8').replace(/^﻿/, '');
const rows    = parseCSV(csvText);
const headers = rows[0].map(h => h.trim());

const idx = k => headers.indexOf(k);
const H = {
  show:        idx('Show'),
  name:        idx('Company Name'),
  stand:       idx('Stand Number'),
  standType:   idx('Stand Type'),
  showCat:     idx('Show Category'),
  country:     idx('Country'),
  website:     idx('Website'),
  cats:        idx('Categories'),
  desc:        idx('Company Description'),
  profileUrl:  idx('Profile URL'),
  logoUrl:     idx('Logo URL'),
};

const exhibitors = rows.slice(1)
  .filter(r => r[H.name] && r[H.name].trim())
  .map(r => {
    const get = i => fixEncoding(r[i] || '');

    const rawCats = get(H.cats).split(',').map(c => c.trim()).filter(Boolean);
    const canonicalSet = new Set();
    rawCats.forEach(c => (CAT_MAP[c] || []).forEach(k => canonicalSet.add(k)));

    return {
      show:                 get(H.show),
      company_name:         get(H.name),
      stand_number:         get(H.stand),
      stand_type:           get(H.standType),
      show_category:        get(H.showCat),
      country:              get(H.country),
      website:              get(H.website),
      categories:           get(H.cats),
      canonical_categories: [...canonicalSet],
      company_description:  get(H.desc),
      profile_url:          get(H.profileUrl),
      logo_url:             get(H.logoUrl),
      is_host:              false,
    };
  });

const outPath = path.join(root, 'data', 'exhibitors.json');
fs.writeFileSync(outPath, JSON.stringify(exhibitors, null, 2), 'utf8');
console.log(`Written ${exhibitors.length} exhibitors to ${outPath}`);
