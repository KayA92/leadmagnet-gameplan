// Reads programme.csv and exhibitors.csv → writes data/programme.json and data/exhibitors.json
// Run: node scripts/build-data.js
// Re-run whenever the CSVs change.

const fs = require('fs');
const path = require('path');

// ── CSV parser (handles quoted fields, embedded commas and newlines) ──────────
function parseCSV(text) {
  const rows = [];
  let row = [];
  let field = '';
  let inQuotes = false;

  for (let i = 0; i <= text.length; i++) {
    const ch = i < text.length ? text[i] : null;

    if (inQuotes) {
      if (ch === '"') {
        if (i + 1 < text.length && text[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else if (ch === null) {
        row.push(field);
        if (row.some(f => f.trim() !== '')) rows.push(row);
      } else {
        field += ch;
      }
    } else {
      if (ch === '"') {
        inQuotes = true;
      } else if (ch === ',') {
        row.push(field.trim());
        field = '';
      } else if (ch === '\n' || ch === null) {
        row.push(field.trim());
        field = '';
        if (row.some(f => f !== '')) rows.push(row);
        row = [];
      } else if (ch !== '\r') {
        field += ch;
      }
    }
  }

  return rows;
}

// ── Canonical category mapping ────────────────────────────────────────────────
// Maps raw CSV Categories strings to the canonical set used by filter.js.
// A session can belong to multiple canonical categories.
function getCanonicalCategories(raw) {
  const r = (raw || '').toLowerCase();
  const out = [];

  if (r.includes('ai') || r.includes('data analytic') || r.includes('digital asset') ||
      r.includes('blockchain') || r.includes('crypto') || r.includes('digital transform')) {
    out.push('AI');
  }
  if (r.includes('bookkeeping')) out.push('Bookkeeping');
  if (r.includes('tax') || r.includes('vat') || r.includes('mtd')) out.push('Tax / VAT / MTD');
  if (r.includes('regulation') || r.includes('legislation') || r.includes('e-invoic') ||
      r.includes('e invoic') || r.includes('audit') || r.includes('aml') ||
      r.includes('anti-money') || r.includes('compliance')) {
    out.push('Regulation');
  }
  if (r.includes('payroll')) out.push('Payroll');
  if (r.includes('practice management') || r.includes('progressive practice') ||
      r.includes('advisory') || r.includes('app advisory') ||
      r.includes('market overview') || r.includes('market trend')) {
    out.push('Practice Management');
  }
  if (r.includes('sales') || r.includes('marketing') || r.includes('branding') ||
      r.includes('client relationship') || r.includes('customer service') ||
      r.includes('networking')) {
    out.push('Sales & Marketing');
  }
  if (r.includes('leadership') || r.includes('motivation') || r.includes('mindset') ||
      r.includes('education') || r.includes('qualifications') ||
      r.includes('communication') || r.includes('soft skill') || r.includes('impact')) {
    out.push('Leadership');
  }
  if (r.includes('recruit') || r.includes('talent') || r.includes('upskilling') ||
      r.includes('retention') || r.includes('diversity') || r.includes('engagement') ||
      (r.includes('training') && !r.includes('tax')) ||
      (r.includes(' hr ') || r.includes('/hr') || r.includes('hr,'))) {
    out.push('Talent');
  }
  if (r.includes('wellbeing') || r.includes('mental health')) out.push('Wellbeing');
  if (r.includes('scaling') || r.includes('growth') || r.includes('exit strateg') ||
      r.includes('insolvenc')) {
    out.push('Scaling');
  }

  return out.length > 0 ? out : ['Other'];
}

// ── Build programme.json ──────────────────────────────────────────────────────
// Columns: [0]Session ID [1]Title [2]Day [3]Date [4]Theatre [5]Start Time
//          [6]End Time [7]Categories [8]Description
//          [9-12]Speaker1 [13-16]Speaker2 [17-20]Speaker3
//          [21-24]Speaker4 [25-28]Speaker5 [29]Session URL
function buildProgramme() {
  const csv = fs.readFileSync(path.join(__dirname, '../programme.csv'), 'utf8');
  const rows = parseCSV(csv);
  const data = rows.slice(1); // skip header

  return data
    .map(row => {
      const speakers = [];
      for (let i = 0; i < 5; i++) {
        const b = 9 + i * 4;
        if (row[b] && row[b].trim()) {
          speakers.push({
            name: row[b] || '',
            job_title: row[b + 1] || '',
            company: row[b + 2] || '',
            profile_url: row[b + 3] || '',
          });
        }
      }

      return {
        session_id: row[0] || '',
        title: row[1] || '',
        day: row[2] || '',
        date: row[3] || '',
        theatre: row[4] || '',
        start_time: row[5] || '',
        end_time: row[6] || '',
        categories: row[7] || '',
        canonical_categories: getCanonicalCategories(row[7] || ''),
        description: row[8] || '',
        speakers,
        session_url: row[29] || '',
      };
    })
    .filter(s => s.session_id);
}

// ── Build exhibitors.json ─────────────────────────────────────────────────────
// Columns: [0]Show [1]Company Name [2]Stand Number [3]Stand Type
//          [4]Show Category [5]Country [6]Website [7]Email
//          [8]LinkedIn [9]Twitter/X [10]Facebook
//          [11]Products & Services [12]Products & Services Target
//          [13]Company Description [14]Profile URL [15]Logo URL
function buildExhibitors() {
  const csv = fs.readFileSync(path.join(__dirname, '../exhibitors.csv'), 'utf8');
  const rows = parseCSV(csv);
  const data = rows.slice(1);

  const exhibitors = data
    .map(row => {
      const name = row[1] || '';
      return {
        show: row[0] || '',
        company_name: name,
        stand_number: row[2] || '',
        show_category: row[4] || '',
        country: row[5] || '',
        website: row[6] || '',
        normalised_products: (row[11] || '').split(',').map(p => p.trim()).filter(Boolean),
        products_target: (row[12] || '').split(',').map(t => t.trim()).filter(Boolean),
        company_description: row[13] || '',
        profile_url: row[14] || '',
        logo_url: row[15] || '',
        is_host: name.toLowerCase().includes('workiro'),
      };
    })
    .filter(e => e.company_name);

  // Ensure Workiro is present (it may not be in the CSV as an exhibitor)
  if (!exhibitors.some(e => e.is_host)) {
    exhibitors.unshift({
      show: 'Accountex',
      company_name: 'Workiro',
      stand_number: '1144',
      show_category: 'Accountex London',
      country: 'United Kingdom (UK)',
      website: 'https://workiro.com',
      normalised_products: [
        'Document Management',
        'Practice & Project Management',
        'AI / Automation / Optimisation',
        'Accounting Software',
        'CRM',
      ],
      products_target: ['Accountants in Practice', 'Bookkeepers'],
      company_description:
        'Workiro is secure document management and client portals for UK accounting firms. ' +
        'Automate document requests, approvals, and client communication from one place.',
      profile_url: 'https://workiro.com',
      logo_url: 'https://workiro.com/logo.png',
      is_host: true,
    });
    console.log('  ℹ Workiro not found in CSV — added as host exhibitor');
  }

  return exhibitors;
}

// ── Write output ──────────────────────────────────────────────────────────────
const outDir = path.join(__dirname, '../data');
if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });

const sessions = buildProgramme();
const exhibitors = buildExhibitors();

fs.writeFileSync(path.join(outDir, 'programme.json'), JSON.stringify(sessions, null, 2));
fs.writeFileSync(path.join(outDir, 'exhibitors.json'), JSON.stringify(exhibitors, null, 2));

console.log(`✓ data/programme.json  — ${sessions.length} sessions`);
console.log(`✓ data/exhibitors.json — ${exhibitors.length} exhibitors`);
console.log(`  Host flag: ${exhibitors.some(e => e.is_host) ? '✓ Workiro present' : '⚠ not found'}`);
