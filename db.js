const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');

const candidateDataDirs = [
  path.join(__dirname, '..', 'data'),
  path.join(__dirname, 'data')
];
const DATA_DIR = (fs.existsSync(candidateDataDirs[0]) && fs.existsSync(path.join(candidateDataDirs[0], 'crm.db')))
  ? candidateDataDirs[0]
  : candidateDataDirs[1];

if (!fs.existsSync(DATA_DIR)) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}

const DB_PATH = path.join(DATA_DIR, 'crm.db');
const db = new DatabaseSync(DB_PATH);

// Initialize schema
db.exec(`
  CREATE TABLE IF NOT EXISTS leads (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    serial_no TEXT UNIQUE NOT NULL,
    customer_name TEXT NOT NULL,
    mobile_number TEXT NOT NULL,
    loan_type TEXT NOT NULL,
    loan_amount REAL NOT NULL,
    vehicle_number TEXT,
    model TEXT,
    variant TEXT,
    reference_by TEXT,
    finance_name TEXT,
    login_date TEXT NOT NULL,
    disbursed_amount REAL DEFAULT 0,
    disbursed_date TEXT,
    rto_amount REAL DEFAULT 0,
    rto_name TEXT,
    seller_amount REAL DEFAULT 0,
    seller_name TEXT,
    seller_date TEXT,
    utr_no TEXT,
    status TEXT NOT NULL DEFAULT 'Logged In',
    notes TEXT,
    created_at TEXT DEFAULT (datetime('now', 'localtime')),
    updated_at TEXT DEFAULT (datetime('now', 'localtime'))
  );

  CREATE TABLE IF NOT EXISTS insurance_policies (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    serial_no TEXT UNIQUE NOT NULL,
    customer_name TEXT NOT NULL,
    mobile_number TEXT NOT NULL,
    loan_type TEXT NOT NULL DEFAULT 'Comprehensive',
    vehicle_number TEXT,
    model TEXT,
    variant TEXT,
    idv_value REAL DEFAULT 0,
    premium_amount REAL DEFAULT 0,
    from_date TEXT NOT NULL,
    to_date TEXT NOT NULL,
    insurance_company TEXT NOT NULL,
    policy_number TEXT,
    reference_by TEXT,
    status TEXT NOT NULL DEFAULT 'Active',
    notes TEXT,
    created_at TEXT DEFAULT (datetime('now', 'localtime')),
    updated_at TEXT DEFAULT (datetime('now', 'localtime'))
  );
`);

// Safe column migrations for existing databases
const migrations = [
  'ALTER TABLE leads ADD COLUMN disbursed_amount REAL DEFAULT 0',
  'ALTER TABLE leads ADD COLUMN disbursed_date TEXT',
  'ALTER TABLE leads ADD COLUMN rto_amount REAL DEFAULT 0',
  'ALTER TABLE leads ADD COLUMN rto_name TEXT',
  'ALTER TABLE leads ADD COLUMN seller_amount REAL DEFAULT 0',
  'ALTER TABLE leads ADD COLUMN seller_name TEXT',
  'ALTER TABLE leads ADD COLUMN seller_date TEXT',
  'ALTER TABLE leads ADD COLUMN utr_no TEXT'
];

migrations.forEach(sql => {
  try {
    db.exec(sql);
  } catch (err) {
    // Column already exists, safe to ignore
  }
});

// Drop legacy tenure column and constraint from earlier versions
try {
  db.exec('ALTER TABLE leads DROP COLUMN tenure');
} catch (err) {
  // Column already dropped or doesn't exist, safe to ignore
}

// Normalize existing serial numbers to simple 1, 2, 3...
function normalizeSerialNumbers() {
  const rows = db.prepare('SELECT id, serial_no FROM leads ORDER BY id ASC').all();
  const updateStmt = db.prepare('UPDATE leads SET serial_no = ? WHERE id = ?');
  rows.forEach((row, idx) => {
    const expected = String(idx + 1);
    if (row.serial_no !== expected) {
      try {
        updateStmt.run(expected, row.id);
      } catch (e) {
        // Unique constraint fallback
      }
    }
  });
}
normalizeSerialNumbers();

// Backfill any Disbursed lead missing disbursed_date or disbursed_amount
try {
  db.exec(`
    UPDATE leads 
    SET disbursed_date = login_date 
    WHERE status = 'Disbursed' AND (disbursed_date IS NULL OR disbursed_date = '');

    UPDATE leads 
    SET disbursed_amount = loan_amount 
    WHERE status = 'Disbursed' AND (disbursed_amount IS NULL OR disbursed_amount = 0);
  `);
} catch (e) {
  // Ignore
}

function seedInitialDataIfEmpty() {
  const countRow = db.prepare('SELECT COUNT(*) as count FROM leads').get();
  if (countRow.count === 0) {
    const today = new Date().toISOString().slice(0, 10);
    const sampleLeads = [
      {
        serial_no: '1',
        customer_name: 'Rajesh Kumar',
        mobile_number: '9840123456',
        loan_type: 'New Car',
        loan_amount: 650000,
        vehicle_number: 'TN 09 BK 4321',
        model: 'Maruti Suzuki Swift',
        variant: 'VXI DualJet',
        reference_by: 'Karthik (City Motors)',
        finance_name: 'HDFC Bank',
        login_date: today,
        disbursed_amount: 0,
        disbursed_date: '',
        rto_amount: 0,
        seller_amount: 0,
        status: 'Logged In',
        notes: 'Documents collected. Salary slip & 6 months bank statement verified.'
      },
      {
        serial_no: '2',
        customer_name: 'Priya Sundaram',
        mobile_number: '9884567890',
        loan_type: 'Used Car',
        loan_amount: 820000,
        vehicle_number: 'TN 02 AX 7890',
        model: 'Hyundai Creta',
        variant: '1.5 SX Executive',
        reference_by: 'Suresh Auto Deals',
        finance_name: 'Sundaram Finance',
        login_date: today,
        disbursed_amount: 0,
        disbursed_date: '',
        rto_amount: 0,
        seller_amount: 0,
        status: 'Approved',
        notes: 'Valuation report completed (Valued at 9.5 Lakh). Approved at 8.75% ROI.'
      },
      {
        serial_no: '3',
        customer_name: 'Anand Mohan',
        mobile_number: '9790112233',
        loan_type: 'Refinance',
        loan_amount: 500000,
        vehicle_number: 'TN 07 CE 5544',
        model: 'Mahindra Scorpio',
        variant: 'S11 7-Seater',
        reference_by: 'Direct Customer',
        finance_name: 'Cholamandalam Investment',
        login_date: today,
        disbursed_amount: 500000,
        disbursed_date: today,
        rto_amount: 4500,
        seller_amount: 485000,
        status: 'Disbursed',
        notes: 'Foreclosure letter cleared. Payout processed and disbursed successfully.'
      }
    ];

    sampleLeads.forEach(lead => createLead(lead));
  }
}

seedInitialDataIfEmpty();

function getAllLeads(filters = {}) {
  let query = 'SELECT * FROM leads WHERE 1=1';
  const params = [];

  if (filters.search) {
    const s = `%${filters.search.trim()}%`;
    query += ` AND (
      serial_no LIKE ? OR 
      customer_name LIKE ? OR 
      mobile_number LIKE ? OR 
      vehicle_number LIKE ? OR 
      model LIKE ? OR 
      reference_by LIKE ? OR 
      finance_name LIKE ?
    )`;
    params.push(s, s, s, s, s, s, s);
  }

  if (filters.status && filters.status !== 'All') {
    query += ' AND status = ?';
    params.push(filters.status);
  }

  if (filters.loan_type && filters.loan_type !== 'All') {
    query += ' AND loan_type = ?';
    params.push(filters.loan_type);
  }

  if (filters.finance_name && filters.finance_name !== 'All') {
    query += ' AND finance_name = ?';
    params.push(filters.finance_name);
  }

  // Month-wise filter by Disbursed Date (not login date)
  if (filters.disbursed_month && filters.disbursed_month !== 'All') {
    query += ' AND disbursed_date LIKE ?';
    params.push(`${filters.disbursed_month.trim()}%`);
  }

  if (filters.disbursed_from) {
    query += ' AND disbursed_date >= ?';
    params.push(filters.disbursed_from);
  }

  if (filters.disbursed_to) {
    query += ' AND disbursed_date <= ?';
    params.push(filters.disbursed_to);
  }

  if (filters.from_date) {
    query += ' AND login_date >= ?';
    params.push(filters.from_date);
  }

  if (filters.to_date) {
    query += ' AND login_date <= ?';
    params.push(filters.to_date);
  }

  query += ' ORDER BY CAST(serial_no AS INTEGER) ASC, id ASC';

  const stmt = db.prepare(query);
  return stmt.all(...params);
}

function getLeadById(id) {
  const stmt = db.prepare('SELECT * FROM leads WHERE id = ?');
  return stmt.get(Number(id));
}

function getNextSerialNo() {
  const rows = db.prepare('SELECT serial_no FROM leads').all();
  let maxNum = 0;
  rows.forEach(r => {
    const n = parseInt(r.serial_no, 10);
    if (!isNaN(n) && n > maxNum) {
      maxNum = n;
    }
  });
  return String(maxNum + 1);
}

function createLead(data) {
  const now = new Date().toISOString().replace('T', ' ').substring(0, 19);
  const serialNo = (data.serial_no && String(data.serial_no).trim()) || getNextSerialNo();

  const isDisbursed = data.status === 'Disbursed';
  const disbursedAmount = isDisbursed 
    ? (Number(data.disbursed_amount) || Number(data.loan_amount) || 0)
    : 0;
  const disbursedDate = isDisbursed 
    ? (data.disbursed_date || data.login_date || new Date().toISOString().slice(0, 10))
    : '';
  const rtoAmount = isDisbursed ? (Number(data.rto_amount) || 0) : 0;
  const rtoName = isDisbursed ? (data.rto_name ? data.rto_name.trim() : '') : '';
  const sellerAmount = isDisbursed ? (Number(data.seller_amount) || 0) : 0;
  const sellerName = isDisbursed ? (data.seller_name ? data.seller_name.trim() : '') : '';
  const sellerDate = isDisbursed ? (data.seller_date ? data.seller_date.trim() : '') : '';
  const utrNo = isDisbursed ? (data.utr_no ? data.utr_no.trim() : '') : '';

  const stmt = db.prepare(`
    INSERT INTO leads (
      serial_no, customer_name, mobile_number, loan_type, loan_amount,
      vehicle_number, model, variant, reference_by,
      finance_name, login_date, disbursed_amount, disbursed_date,
      rto_amount, rto_name, seller_amount, seller_name, seller_date, utr_no,
      status, notes, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  stmt.run(
    serialNo,
    data.customer_name ? data.customer_name.trim() : '',
    data.mobile_number ? data.mobile_number.trim() : '',
    data.loan_type || 'New Car',
    Number(data.loan_amount) || 0,
    data.vehicle_number ? data.vehicle_number.trim().toUpperCase() : '',
    data.model ? data.model.trim() : '',
    data.variant ? data.variant.trim() : '',
    data.reference_by ? data.reference_by.trim() : '',
    data.finance_name ? data.finance_name.trim() : '',
    data.login_date || new Date().toISOString().slice(0, 10),
    disbursedAmount,
    disbursedDate,
    rtoAmount,
    rtoName,
    sellerAmount,
    sellerName,
    sellerDate,
    utrNo,
    data.status || 'Logged In',
    data.notes ? data.notes.trim() : '',
    now,
    now
  );

  const lastIdStmt = db.prepare('SELECT last_insert_rowid() as id');
  const result = lastIdStmt.get();
  return getLeadById(result.id);
}

function updateLead(id, data) {
  const now = new Date().toISOString().replace('T', ' ').substring(0, 19);

  const isDisbursed = data.status === 'Disbursed';
  const disbursedAmount = isDisbursed 
    ? (Number(data.disbursed_amount) || Number(data.loan_amount) || 0)
    : 0;
  const disbursedDate = isDisbursed 
    ? (data.disbursed_date || data.login_date || new Date().toISOString().slice(0, 10))
    : '';
  const rtoAmount = isDisbursed ? (Number(data.rto_amount) || 0) : 0;
  const rtoName = isDisbursed ? (data.rto_name ? data.rto_name.trim() : '') : '';
  const sellerAmount = isDisbursed ? (Number(data.seller_amount) || 0) : 0;
  const sellerName = isDisbursed ? (data.seller_name ? data.seller_name.trim() : '') : '';
  const sellerDate = isDisbursed ? (data.seller_date ? data.seller_date.trim() : '') : '';
  const utrNo = isDisbursed ? (data.utr_no ? data.utr_no.trim() : '') : '';

  const stmt = db.prepare(`
    UPDATE leads SET
      serial_no = ?,
      customer_name = ?,
      mobile_number = ?,
      loan_type = ?,
      loan_amount = ?,
      vehicle_number = ?,
      model = ?,
      variant = ?,
      reference_by = ?,
      finance_name = ?,
      login_date = ?,
      disbursed_amount = ?,
      disbursed_date = ?,
      rto_amount = ?,
      rto_name = ?,
      seller_amount = ?,
      seller_name = ?,
      seller_date = ?,
      utr_no = ?,
      status = ?,
      notes = ?,
      updated_at = ?
    WHERE id = ?
  `);

  stmt.run(
    data.serial_no ? String(data.serial_no).trim() : '',
    data.customer_name ? data.customer_name.trim() : '',
    data.mobile_number ? data.mobile_number.trim() : '',
    data.loan_type || 'New Car',
    Number(data.loan_amount) || 0,
    data.vehicle_number ? data.vehicle_number.trim().toUpperCase() : '',
    data.model ? data.model.trim() : '',
    data.variant ? data.variant.trim() : '',
    data.reference_by ? data.reference_by.trim() : '',
    data.finance_name ? data.finance_name.trim() : '',
    data.login_date || new Date().toISOString().slice(0, 10),
    disbursedAmount,
    disbursedDate,
    rtoAmount,
    rtoName,
    sellerAmount,
    sellerName,
    sellerDate,
    utrNo,
    data.status || 'Logged In',
    data.notes ? data.notes.trim() : '',
    now,
    Number(id)
  );

  return getLeadById(id);
}

function deleteLead(id) {
  const stmt = db.prepare('DELETE FROM leads WHERE id = ?');
  stmt.run(Number(id));
  return { success: true, id: Number(id) };
}

function getStats() {
  const totalStmt = db.prepare('SELECT COUNT(*) as count, COALESCE(SUM(loan_amount), 0) as total_volume FROM leads');
  const total = totalStmt.get();

  const statusRows = db.prepare("SELECT status, COUNT(*) as count, COALESCE(SUM(CASE WHEN status = 'Disbursed' THEN disbursed_amount ELSE loan_amount END), 0) as total_amount FROM leads GROUP BY status").all();
  
  const loanTypeRows = db.prepare('SELECT loan_type, COUNT(*) as count FROM leads GROUP BY loan_type').all();

  const financeRows = db.prepare("SELECT finance_name, COUNT(*) as count FROM leads WHERE finance_name IS NOT NULL AND finance_name != '' GROUP BY finance_name ORDER BY count DESC LIMIT 5").all();

  const disbursedStmt = db.prepare("SELECT COUNT(*) as count, COALESCE(SUM(disbursed_amount), 0) as total_disbursed FROM leads WHERE status = 'Disbursed'");
  const disbursedStats = disbursedStmt.get();

  return {
    totalLeads: total.count,
    totalVolume: total.total_volume,
    disbursedCount: disbursedStats.count,
    disbursedVolume: disbursedStats.total_disbursed,
    byStatus: statusRows,
    byLoanType: loanTypeRows,
    topFinance: financeRows
  };
}

// ==========================================
// INSURANCE CRM MODULE
// ==========================================

function calculateInsuranceDaysLeft(toDateStr) {
  if (!toDateStr) return null;
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const toDate = new Date(toDateStr);
  toDate.setHours(0, 0, 0, 0);
  const diffTime = toDate.getTime() - today.getTime();
  return Math.ceil(diffTime / (1000 * 60 * 60 * 24));
}

function decoratePolicy(policy) {
  if (!policy) return null;
  const daysLeft = calculateInsuranceDaysLeft(policy.to_date);
  const isExpiringSoon = daysLeft !== null && daysLeft >= 0 && daysLeft <= 10;
  const isExpired = daysLeft !== null && daysLeft < 0;

  let alertLevel = 'normal';
  let alertBadgeText = '';
  if (isExpired) {
    alertLevel = 'expired';
    alertBadgeText = `🔴 Expired ${Math.abs(daysLeft)} days ago`;
  } else if (daysLeft === 0) {
    alertLevel = 'expiring_soon';
    alertBadgeText = '🚨 Expires Today!';
  } else if (isExpiringSoon) {
    alertLevel = 'expiring_soon';
    alertBadgeText = `⚠️ ${daysLeft} days left`;
  } else if (daysLeft !== null) {
    alertLevel = 'active';
    alertBadgeText = `Active (${daysLeft} days left)`;
  }

  return {
    ...policy,
    days_left: daysLeft,
    is_expiring_soon: isExpiringSoon,
    is_expired: isExpired,
    alert_level: alertLevel,
    alert_badge_text: alertBadgeText
  };
}

function getAllInsurancePolicies(filters = {}) {
  let query = 'SELECT * FROM insurance_policies WHERE 1=1';
  const params = [];

  if (filters.search) {
    const s = `%${filters.search.trim()}%`;
    query += ` AND (
      serial_no LIKE ? OR 
      customer_name LIKE ? OR 
      mobile_number LIKE ? OR 
      vehicle_number LIKE ? OR 
      model LIKE ? OR 
      variant LIKE ? OR 
      insurance_company LIKE ? OR 
      policy_number LIKE ? OR 
      reference_by LIKE ?
    )`;
    params.push(s, s, s, s, s, s, s, s, s);
  }

  if (filters.insurance_company && filters.insurance_company !== 'All') {
    query += ' AND insurance_company = ?';
    params.push(filters.insurance_company);
  }

  if (filters.loan_type && filters.loan_type !== 'All') {
    query += ' AND loan_type = ?';
    params.push(filters.loan_type);
  }

  if (filters.expiry_month && filters.expiry_month !== 'All') {
    query += ' AND to_date LIKE ?';
    params.push(`${filters.expiry_month}%`);
  }

  if (filters.from_date) {
    query += ' AND to_date >= ?';
    params.push(filters.from_date);
  }

  if (filters.to_date) {
    query += ' AND to_date <= ?';
    params.push(filters.to_date);
  }

  query += ' ORDER BY CAST(serial_no AS INTEGER) ASC, id ASC';

  const rows = db.prepare(query).all(...params);
  let decorated = rows.map(decoratePolicy);

  // Status filtering in JS for precise 0-10 days logic
  if (filters.status && filters.status !== 'All') {
    if (filters.status === 'Expiring Soon' || filters.status === 'expiring_10') {
      decorated = decorated.filter(p => p.is_expiring_soon);
    } else if (filters.status === 'Expired') {
      decorated = decorated.filter(p => p.is_expired);
    } else if (filters.status === 'Active') {
      decorated = decorated.filter(p => !p.is_expired && !p.is_expiring_soon && p.status !== 'Renewed');
    } else {
      decorated = decorated.filter(p => p.status === filters.status);
    }
  }

  return decorated;
}

function getInsurancePolicyById(id) {
  const row = db.prepare('SELECT * FROM insurance_policies WHERE id = ?').get(Number(id));
  return decoratePolicy(row);
}

function getNextInsuranceSerialNo() {
  const rows = db.prepare('SELECT serial_no FROM insurance_policies').all();
  let maxNum = 0;
  for (const r of rows) {
    const num = parseInt(r.serial_no, 10);
    if (!isNaN(num) && num > maxNum) {
      maxNum = num;
    }
  }
  return String(maxNum + 1);
}

function createInsurancePolicy(data) {
  let serialNo = data.serial_no;
  if (!serialNo || String(serialNo).trim() === '') {
    serialNo = getNextInsuranceSerialNo();
  } else {
    serialNo = String(serialNo).trim();
  }

  const daysLeft = calculateInsuranceDaysLeft(data.to_date);
  let status = data.status || 'Active';
  if (!data.status || data.status === 'Active' || data.status === 'Expiring Soon' || data.status === 'Expired') {
    if (daysLeft !== null) {
      if (daysLeft < 0) status = 'Expired';
      else if (daysLeft <= 10) status = 'Expiring Soon';
      else status = 'Active';
    }
  }

  const stmt = db.prepare(`
    INSERT INTO insurance_policies (
      serial_no, customer_name, mobile_number, loan_type, vehicle_number,
      model, variant, idv_value, premium_amount, from_date, to_date,
      insurance_company, policy_number, reference_by, status, notes
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  const result = stmt.run(
    serialNo,
    data.customer_name ? data.customer_name.trim() : '',
    data.mobile_number ? data.mobile_number.trim() : '',
    data.loan_type ? data.loan_type.trim() : 'Comprehensive',
    data.vehicle_number ? data.vehicle_number.trim().toUpperCase() : '',
    data.model ? data.model.trim() : '',
    data.variant ? data.variant.trim() : '',
    Number(data.idv_value) || 0,
    Number(data.premium_amount) || 0,
    data.from_date || '',
    data.to_date || '',
    data.insurance_company ? data.insurance_company.trim() : '',
    data.policy_number ? data.policy_number.trim() : '',
    data.reference_by ? data.reference_by.trim() : '',
    status,
    data.notes ? data.notes.trim() : ''
  );

  return getInsurancePolicyById(result.lastInsertRowid);
}

function updateInsurancePolicy(id, data) {
  const existing = getInsurancePolicyById(id);
  if (!existing) {
    throw new Error('Insurance policy not found');
  }

  let serialNo = data.serial_no !== undefined ? String(data.serial_no).trim() : existing.serial_no;
  if (!serialNo) serialNo = existing.serial_no;

  const toDate = data.to_date !== undefined ? data.to_date : existing.to_date;
  const daysLeft = calculateInsuranceDaysLeft(toDate);

  let status = data.status || existing.status;
  if (data.status === undefined || data.status === 'Active' || data.status === 'Expiring Soon' || data.status === 'Expired') {
    if (daysLeft !== null && status !== 'Renewed') {
      if (daysLeft < 0) status = 'Expired';
      else if (daysLeft <= 10) status = 'Expiring Soon';
      else status = 'Active';
    }
  }

  const stmt = db.prepare(`
    UPDATE insurance_policies SET
      serial_no = ?,
      customer_name = ?,
      mobile_number = ?,
      loan_type = ?,
      vehicle_number = ?,
      model = ?,
      variant = ?,
      idv_value = ?,
      premium_amount = ?,
      from_date = ?,
      to_date = ?,
      insurance_company = ?,
      policy_number = ?,
      reference_by = ?,
      status = ?,
      notes = ?,
      updated_at = datetime('now', 'localtime')
    WHERE id = ?
  `);

  stmt.run(
    serialNo,
    data.customer_name !== undefined ? data.customer_name.trim() : existing.customer_name,
    data.mobile_number !== undefined ? data.mobile_number.trim() : existing.mobile_number,
    data.loan_type !== undefined ? data.loan_type.trim() : existing.loan_type,
    data.vehicle_number !== undefined ? data.vehicle_number.trim().toUpperCase() : existing.vehicle_number,
    data.model !== undefined ? data.model.trim() : existing.model,
    data.variant !== undefined ? data.variant.trim() : existing.variant,
    data.idv_value !== undefined ? (Number(data.idv_value) || 0) : existing.idv_value,
    data.premium_amount !== undefined ? (Number(data.premium_amount) || 0) : existing.premium_amount,
    toDate,
    data.from_date !== undefined ? data.from_date : existing.from_date,
    data.insurance_company !== undefined ? data.insurance_company.trim() : existing.insurance_company,
    data.policy_number !== undefined ? data.policy_number.trim() : existing.policy_number,
    data.reference_by !== undefined ? data.reference_by.trim() : existing.reference_by,
    status,
    data.notes !== undefined ? data.notes.trim() : existing.notes,
    Number(id)
  );

  return getInsurancePolicyById(id);
}

function deleteInsurancePolicy(id) {
  const stmt = db.prepare('DELETE FROM insurance_policies WHERE id = ?');
  stmt.run(Number(id));
  return { success: true, id: Number(id) };
}

function getInsuranceStats() {
  const all = getAllInsurancePolicies({});
  const totalPolicies = all.length;
  const expiringSoon = all.filter(p => p.is_expiring_soon);
  const expired = all.filter(p => p.is_expired);
  const active = all.filter(p => !p.is_expired && !p.is_expiring_soon && p.status !== 'Renewed');

  const totalPremium = all.reduce((sum, p) => sum + (Number(p.premium_amount) || 0), 0);
  const totalIdv = all.reduce((sum, p) => sum + (Number(p.idv_value) || 0), 0);

  const companyMap = {};
  all.forEach(p => {
    const c = p.insurance_company || 'Other';
    companyMap[c] = (companyMap[c] || 0) + 1;
  });
  const byCompany = Object.entries(companyMap).map(([company, count]) => ({ company, count }));

  const typeMap = {};
  all.forEach(p => {
    const t = p.loan_type || 'Comprehensive';
    typeMap[t] = (typeMap[t] || 0) + 1;
  });
  const byType = Object.entries(typeMap).map(([loan_type, count]) => ({ loan_type, count }));

  return {
    totalPolicies,
    expiringSoonCount: expiringSoon.length,
    expiredCount: expired.length,
    activeCount: active.length,
    totalPremium,
    totalIdv,
    byCompany,
    byType
  };
}

function seedInsuranceIfEmpty() {
  const countRow = db.prepare('SELECT COUNT(*) as count FROM insurance_policies').get();
  if (countRow.count === 0) {
    const today = new Date();
    const fmt = d => d.toISOString().slice(0, 10);

    // 1. Expiring in 4 days (Within 0-10 days -> RED ALERT)
    const d4 = new Date(today);
    d4.setDate(d4.getDate() + 4);
    const d4From = new Date(today);
    d4From.setFullYear(d4From.getFullYear() - 1);
    d4From.setDate(d4From.getDate() + 5);

    // 2. Expiring in 8 days (Within 0-10 days -> RED ALERT)
    const d8 = new Date(today);
    d8.setDate(d8.getDate() + 8);
    const d8From = new Date(today);
    d8From.setFullYear(d8From.getFullYear() - 1);
    d8From.setDate(d8From.getDate() + 9);

    // 3. Expires Today (0 days left -> RED ALERT)
    const dToday = new Date(today);
    const dTodayFrom = new Date(today);
    dTodayFrom.setFullYear(dTodayFrom.getFullYear() - 1);
    dTodayFrom.setDate(dTodayFrom.getDate() + 1);

    // 4. Active (8 months from now)
    const dFuture = new Date(today);
    dFuture.setMonth(dFuture.getMonth() + 8);
    const dFutureFrom = new Date(today);
    dFutureFrom.setMonth(dFutureFrom.getMonth() - 4);

    // 5. Expired (6 days ago -> RED ALERT)
    const dPast = new Date(today);
    dPast.setDate(dPast.getDate() - 6);
    const dPastFrom = new Date(today);
    dPastFrom.setFullYear(dPastFrom.getFullYear() - 1);
    dPastFrom.setDate(dPastFrom.getDate() - 5);

    const samplePolicies = [
      {
        serial_no: '1',
        customer_name: 'Rajesh Kumar',
        mobile_number: '9840123456',
        loan_type: 'Comprehensive',
        vehicle_number: 'TN 09 BK 4321',
        model: 'Maruti Suzuki Swift',
        variant: 'VXI DualJet',
        idv_value: 580000,
        premium_amount: 14200,
        from_date: fmt(d4From),
        to_date: fmt(d4),
        insurance_company: 'HDFC ERGO',
        policy_number: 'HDFC-23098124',
        reference_by: 'Karthik (City Motors)',
        status: 'Expiring Soon',
        notes: 'Called customer. Wants zero dep quote comparison before renewal.'
      },
      {
        serial_no: '2',
        customer_name: 'Senthil Nathan',
        mobile_number: '9841029384',
        loan_type: 'Zero Depreciation',
        vehicle_number: 'TN 14 AX 9081',
        model: 'Hyundai Creta',
        variant: '1.5 SX Executive',
        idv_value: 920000,
        premium_amount: 22800,
        from_date: fmt(d8From),
        to_date: fmt(d8),
        insurance_company: 'ICICI Lombard',
        policy_number: 'ICICI-MOT-88910',
        reference_by: 'Sundaram Finance',
        status: 'Expiring Soon',
        notes: 'Renewal notice sent on WhatsApp. Customer will pay by Saturday.'
      },
      {
        serial_no: '3',
        customer_name: 'Muruganandam P',
        mobile_number: '9710345678',
        loan_type: 'Comprehensive',
        vehicle_number: 'TN 07 DC 1234',
        model: 'Kia Seltos',
        variant: 'HTK Plus Petrol',
        idv_value: 850000,
        premium_amount: 19500,
        from_date: fmt(dTodayFrom),
        to_date: fmt(dToday),
        insurance_company: 'Tata AIG',
        policy_number: 'TATA-AIG-99812',
        reference_by: 'Direct Customer',
        status: 'Expiring Soon',
        notes: 'URGENT: Policy expiring TODAY! Renewal link shared.'
      },
      {
        serial_no: '4',
        customer_name: 'Priya Sundaram',
        mobile_number: '9884567890',
        loan_type: 'Zero Depreciation',
        vehicle_number: 'TN 02 AX 7890',
        model: 'Toyota Innova Crysta',
        variant: '2.4 GX 7 STR',
        idv_value: 1650000,
        premium_amount: 36500,
        from_date: fmt(dFutureFrom),
        to_date: fmt(dFuture),
        insurance_company: 'Bajaj Allianz',
        policy_number: 'BAJ-CR-55421',
        reference_by: 'Suresh Auto Deals',
        status: 'Active',
        notes: '1-year policy renewed with 50% NCB bonus.'
      },
      {
        serial_no: '5',
        customer_name: 'Kavitha Ramesh',
        mobile_number: '9444123490',
        loan_type: 'Third Party',
        vehicle_number: 'TN 22 BY 4455',
        model: 'Tata Tiago',
        variant: 'XT Revotron',
        idv_value: 390000,
        premium_amount: 8900,
        from_date: fmt(dPastFrom),
        to_date: fmt(dPast),
        insurance_company: 'GoDigit',
        policy_number: 'DIGIT-MOT-1029',
        reference_by: 'Ramesh Brother',
        status: 'Expired',
        notes: 'Policy expired. Inspection required for break-in renewal.'
      }
    ];

    samplePolicies.forEach(p => createInsurancePolicy(p));
  }
}

seedInsuranceIfEmpty();

module.exports = {
  // Vehicle Loan CRM
  getAllLeads,
  getLeadById,
  getNextSerialNo,
  createLead,
  updateLead,
  deleteLead,
  getStats,

  // Insurance CRM
  getAllInsurancePolicies,
  getInsurancePolicyById,
  getNextInsuranceSerialNo,
  createInsurancePolicy,
  updateInsurancePolicy,
  deleteInsurancePolicy,
  getInsuranceStats
};
