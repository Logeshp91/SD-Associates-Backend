const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const url = require('node:url');
const db = require('./db.js');

// Load .env configuration
const envFile = [
  path.join(__dirname, '.env'),
  path.join(__dirname, '..', '.env')
].find(f => fs.existsSync(f));

if (envFile) {
  try {
    const rawEnv = fs.readFileSync(envFile, 'utf-8');
    rawEnv.split('\n').forEach(line => {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) return;
      const eqIdx = trimmed.indexOf('=');
      if (eqIdx !== -1) {
        const key = trimmed.slice(0, eqIdx).trim();
        const val = trimmed.slice(eqIdx + 1).trim().replace(/^["']|["']$/g, '');
        if (!process.env[key]) process.env[key] = val;
      }
    });
  } catch (e) {
    // Continue with defaults if .env cannot be read
  }
}

const DEFAULT_PORT = parseInt(process.env.PORT, 10) || 4000;
const HOST = process.env.HOST || 'localhost';
const PUBLIC_DIR = [
  path.join(__dirname, '..', 'frontend'),
  path.join(__dirname, 'public'),
  path.join(__dirname, '..', 'public')
].find(dir => fs.existsSync(dir)) || path.join(__dirname, '..', 'frontend');

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon'
};

function sendJson(res, statusCode, data) {
  res.writeHead(statusCode, {
    'Content-Type': 'application/json; charset=utf-8',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type'
  });
  res.end(JSON.stringify(data));
}

function parseJsonBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', chunk => {
      body += chunk;
      if (body.length > 1e6) {
        req.destroy();
        reject(new Error('Payload too large'));
      }
    });
    req.on('end', () => {
      try {
        const data = body ? JSON.parse(body) : {};
        resolve(data);
      } catch (err) {
        reject(err);
      }
    });
    req.on('error', reject);
  });
}

function serveStatic(req, res, pathname) {
  let filePath = path.join(PUBLIC_DIR, pathname === '/' ? 'index.html' : pathname);
  
  // Prevent directory traversal
  if (!filePath.startsWith(PUBLIC_DIR)) {
    res.writeHead(403, { 'Content-Type': 'text/plain' });
    res.end('Access Denied');
    return;
  }

  fs.stat(filePath, (err, stats) => {
    if (err || !stats.isFile()) {
      // Fallback to index.html for client-side routing
      const indexPath = path.join(PUBLIC_DIR, 'index.html');
      fs.readFile(indexPath, (err2, content) => {
        if (err2) {
          res.writeHead(404, { 'Content-Type': 'text/plain' });
          res.end('Not Found');
          return;
        }
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(content);
      });
      return;
    }

    const ext = path.extname(filePath).toLowerCase();
    const contentType = MIME_TYPES[ext] || 'application/octet-stream';
    
    fs.readFile(filePath, (err3, content) => {
      if (err3) {
        res.writeHead(500, { 'Content-Type': 'text/plain' });
        res.end('Internal Server Error');
        return;
      }
      res.writeHead(200, { 'Content-Type': contentType });
      res.end(content);
    });
  });
}

const server = http.createServer(async (req, res) => {
  const parsedUrl = url.parse(req.url, true);
  const pathname = parsedUrl.pathname;
  const method = req.method.toUpperCase();

  // Handle CORS Preflight
  if (method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type'
    });
    res.end();
    return;
  }

  try {
    // API Routes
    if (pathname.startsWith('/api/')) {
      // GET /api/leads
      if (pathname === '/api/leads' && method === 'GET') {
        const filters = parsedUrl.query;
        const leads = db.getAllLeads(filters);
        return sendJson(res, 200, { success: true, count: leads.length, data: leads });
      }

      // GET /api/leads/next-serial
      if (pathname === '/api/leads/next-serial' && method === 'GET') {
        const nextSerial = db.getNextSerialNo();
        return sendJson(res, 200, { success: true, nextSerial });
      }

      // GET /api/leads/stats
      if (pathname === '/api/leads/stats' && method === 'GET') {
        const stats = db.getStats();
        return sendJson(res, 200, { success: true, data: stats });
      }

      // GET /api/export
      if (pathname === '/api/export' && method === 'GET') {
        const leads = db.getAllLeads(parsedUrl.query);
        const headers = [
          'Sl. No',
          'Customer Details (Name)',
          'Mobile Number',
          'Loan Type',
          'Loan Amount (INR)',
          'Vehicle Details (Model)',
          'Vehicle Variant',
          'Vehicle Number',
          'Reference Given By',
          'Finance (Lead Given To)',
          'Login Date',
          'Disbursed Amount (INR)',
          'Disbursed Date',
          'UTR No',
          'RTO Amount (INR)',
          'RTO Name',
          'Seller Amount (INR)',
          'Seller Name',
          'Seller Date',
          'Status',
          'Notes'
        ];

        const escapeCsv = (val) => {
          if (val === null || val === undefined) return '""';
          const str = String(val).replace(/"/g, '""');
          return `"${str}"`;
        };

        const rows = leads.map(l => [
          escapeCsv(l.serial_no),
          escapeCsv(l.customer_name),
          escapeCsv(l.mobile_number),
          escapeCsv(l.loan_type),
          escapeCsv(l.loan_amount),
          escapeCsv(l.model),
          escapeCsv(l.variant),
          escapeCsv(l.vehicle_number),
          escapeCsv(l.reference_by),
          escapeCsv(l.finance_name),
          escapeCsv(l.login_date),
          escapeCsv(l.status === 'Disbursed' ? (l.disbursed_amount || l.loan_amount) : 0),
          escapeCsv(l.disbursed_date || ''),
          escapeCsv(l.utr_no || ''),
          escapeCsv(l.rto_amount || 0),
          escapeCsv(l.rto_name || ''),
          escapeCsv(l.seller_amount || 0),
          escapeCsv(l.seller_name || ''),
          escapeCsv(l.seller_date || ''),
          escapeCsv(l.status),
          escapeCsv(l.notes)
        ].join(','));

        const queryParams = parsedUrl.query || {};
        let filenameParts = ['SD_Associates'];

        if (queryParams.status && queryParams.status !== 'All') {
          filenameParts.push(queryParams.status.replace(/[^a-zA-Z0-9]/g, '_'));
        }
        if (queryParams.loan_type && queryParams.loan_type !== 'All') {
          filenameParts.push(queryParams.loan_type.replace(/[^a-zA-Z0-9]/g, '_'));
        }
        if (queryParams.finance_name && queryParams.finance_name !== 'All') {
          filenameParts.push(queryParams.finance_name.replace(/[^a-zA-Z0-9]/g, '_'));
        }
        filenameParts.push('Leads', new Date().toISOString().slice(0, 10));
        const filename = `${filenameParts.join('_')}.csv`;
        
        res.writeHead(200, {
          'Content-Type': 'text/csv; charset=utf-8',
          'Content-Disposition': `attachment; filename="${filename}"`
        });
        return res.end([headers.join(','), ...rows].join('\r\n'));
      }

      // Single Lead match: /api/leads/:id
      const leadIdMatch = pathname.match(/^\/api\/leads\/(\d+)$/);
      if (leadIdMatch) {
        const id = parseInt(leadIdMatch[1], 10);

        if (method === 'GET') {
          const lead = db.getLeadById(id);
          if (!lead) return sendJson(res, 404, { success: false, error: 'Lead not found' });
          return sendJson(res, 200, { success: true, data: lead });
        }

        if (method === 'PUT') {
          const payload = await parseJsonBody(req);
          const updated = db.updateLead(id, payload);
          return sendJson(res, 200, { success: true, message: 'Lead updated successfully', data: updated });
        }

        if (method === 'DELETE') {
          const result = db.deleteLead(id);
          return sendJson(res, 200, { success: true, message: 'Lead deleted successfully', data: result });
        }
      }

      // POST /api/leads
      if (pathname === '/api/leads' && method === 'POST') {
        const payload = await parseJsonBody(req);
        if (!payload.customer_name || !payload.mobile_number) {
          return sendJson(res, 400, { success: false, error: 'Customer Name and Mobile Number are required' });
        }
        const created = db.createLead(payload);
        return sendJson(res, 201, { success: true, message: 'Lead created successfully', data: created });
      }

      // ==========================================
      // INSURANCE CRM API ROUTES
      // ==========================================

      // GET /api/insurance
      if (pathname === '/api/insurance' && method === 'GET') {
        const filters = parsedUrl.query;
        const policies = db.getAllInsurancePolicies(filters);
        return sendJson(res, 200, { success: true, count: policies.length, data: policies });
      }

      // GET /api/insurance/stats
      if (pathname === '/api/insurance/stats' && method === 'GET') {
        const stats = db.getInsuranceStats();
        return sendJson(res, 200, { success: true, data: stats });
      }

      // GET /api/insurance/next-serial
      if (pathname === '/api/insurance/next-serial' && method === 'GET') {
        const nextSerial = db.getNextInsuranceSerialNo();
        return sendJson(res, 200, { success: true, nextSerial });
      }

      // GET /api/insurance/export
      if (pathname === '/api/insurance/export' && method === 'GET') {
        const policies = db.getAllInsurancePolicies(parsedUrl.query);
        const headers = [
          'Sl. No',
          'Customer Name',
          'Mobile Number',
          'Loan / Policy Type',
          'Vehicle Number',
          'Vehicle Model',
          'Vehicle Variant',
          'IDV Value (INR)',
          'Premium Amount (INR)',
          'Insurance From Date',
          'Insurance To Date (Expiry)',
          'Days Left',
          'Alert Status',
          'Insurance Company',
          'Policy Number',
          'Reference Given By',
          'Status',
          'Notes'
        ];

        const escapeCsv = (val) => {
          if (val === null || val === undefined) return '""';
          const str = String(val).replace(/"/g, '""');
          return `"${str}"`;
        };

        const rows = policies.map(p => [
          escapeCsv(p.serial_no),
          escapeCsv(p.customer_name),
          escapeCsv(p.mobile_number),
          escapeCsv(p.loan_type),
          escapeCsv(p.vehicle_number || ''),
          escapeCsv(p.model || ''),
          escapeCsv(p.variant || ''),
          escapeCsv(p.idv_value || 0),
          escapeCsv(p.premium_amount || 0),
          escapeCsv(p.from_date),
          escapeCsv(p.to_date),
          escapeCsv(p.days_left !== null ? p.days_left : ''),
          escapeCsv(p.alert_badge_text || ''),
          escapeCsv(p.insurance_company),
          escapeCsv(p.policy_number || ''),
          escapeCsv(p.reference_by || ''),
          escapeCsv(p.status),
          escapeCsv(p.notes || '')
        ].join(','));

        const queryParams = parsedUrl.query || {};
        let filenameParts = ['SD_Associates_Insurance'];
        if (queryParams.status && queryParams.status !== 'All') {
          filenameParts.push(queryParams.status.replace(/[^a-zA-Z0-9]/g, '_'));
        }
        if (queryParams.insurance_company && queryParams.insurance_company !== 'All') {
          filenameParts.push(queryParams.insurance_company.replace(/[^a-zA-Z0-9]/g, '_'));
        }
        filenameParts.push(new Date().toISOString().slice(0, 10));
        const filename = `${filenameParts.join('_')}.csv`;

        res.writeHead(200, {
          'Content-Type': 'text/csv; charset=utf-8',
          'Content-Disposition': `attachment; filename="${filename}"`
        });
        return res.end([headers.join(','), ...rows].join('\r\n'));
      }

      // Single Insurance match: /api/insurance/:id
      const insuranceIdMatch = pathname.match(/^\/api\/insurance\/(\d+)$/);
      if (insuranceIdMatch) {
        const id = parseInt(insuranceIdMatch[1], 10);

        if (method === 'GET') {
          const policy = db.getInsurancePolicyById(id);
          if (!policy) return sendJson(res, 404, { success: false, error: 'Policy not found' });
          return sendJson(res, 200, { success: true, data: policy });
        }

        if (method === 'PUT') {
          const payload = await parseJsonBody(req);
          const updated = db.updateInsurancePolicy(id, payload);
          return sendJson(res, 200, { success: true, message: 'Policy updated successfully', data: updated });
        }

        if (method === 'DELETE') {
          const result = db.deleteInsurancePolicy(id);
          return sendJson(res, 200, { success: true, message: 'Policy deleted successfully', data: result });
        }
      }

      // POST /api/insurance
      if (pathname === '/api/insurance' && method === 'POST') {
        const payload = await parseJsonBody(req);
        if (!payload.customer_name || !payload.mobile_number) {
          return sendJson(res, 400, { success: false, error: 'Customer Name and Mobile Number are required' });
        }
        if (!payload.to_date) {
          return sendJson(res, 400, { success: false, error: 'Insurance To Date (Expiry Date) is required' });
        }
        const created = db.createInsurancePolicy(payload);
        return sendJson(res, 201, { success: true, message: 'Insurance policy created successfully', data: created });
      }

      return sendJson(res, 404, { success: false, error: 'API endpoint not found' });
    }

    // HTML Table Report for PDF Export
    if (pathname === '/report' && method === 'GET') {
      const filters = parsedUrl.query || {};
      const leads = db.getAllLeads(filters);
      
      const formatInr = (n) => '₹ ' + (Number(n) || 0).toLocaleString('en-IN');
      const totalLoanVolume = leads.reduce((sum, l) => sum + (Number(l.loan_amount) || 0), 0);
      const totalDisbursedVolume = leads.reduce((sum, l) => sum + (l.status === 'Disbursed' ? (Number(l.disbursed_amount) || Number(l.loan_amount) || 0) : 0), 0);
      
      let monthLabel = '';
      if (filters.disbursed_month && filters.disbursed_month !== 'All') {
        const parts = filters.disbursed_month.split('-');
        if (parts.length === 2) {
          const dateObj = new Date(parseInt(parts[0], 10), parseInt(parts[1], 10) - 1, 1);
          monthLabel = dateObj.toLocaleString('en-IN', { month: 'long', year: 'numeric' });
        }
      }

      const filterDesc = [
        monthLabel ? `<span style="background: #15803d; color: white; padding: 2px 8px; border-radius: 4px; font-weight: 700;">Disbursed Month: ${monthLabel}</span>` : '',
        `Status: <strong>${filters.status || 'All'}</strong>`,
        `Loan Type: <strong>${filters.loan_type || 'All'}</strong>`,
        filters.finance_name && filters.finance_name !== 'All' ? `Finance: <strong>${filters.finance_name}</strong>` : '',
        filters.disbursed_from ? `Disbursed From: <strong>${filters.disbursed_from}</strong>` : '',
        filters.disbursed_to ? `Disbursed To: <strong>${filters.disbursed_to}</strong>` : '',
        filters.from_date ? `Login From: <strong>${filters.from_date}</strong>` : '',
        filters.to_date ? `Login To: <strong>${filters.to_date}</strong>` : ''
      ].filter(Boolean).join(' | ');

      const rowsHtml = leads.map(l => {
        const isDisbursed = l.status === 'Disbursed';
        const disbAmt = isDisbursed ? (Number(l.disbursed_amount) || Number(l.loan_amount) || 0) : 0;
        return `
          <tr>
            <td style="text-align: center; font-weight: 700;">${l.serial_no}</td>
            <td>
              <strong>${l.customer_name}</strong><br>
              <span style="font-size: 11px; color: #555;">${l.mobile_number}</span>
            </td>
            <td><span class="badge badge-${(l.loan_type || '').toLowerCase().replace(/\s+/g, '-')}">${l.loan_type}</span></td>
            <td style="text-align: right; font-weight: 600;">${formatInr(l.loan_amount)}</td>
            <td>
              <strong>${l.model || '-'}</strong> ${l.variant ? `<small>(${l.variant})</small>` : ''}<br>
              <code style="font-size: 11px; color: #444;">${l.vehicle_number || 'New'}</code>
            </td>
            <td>${l.reference_by || '-'}</td>
            <td><strong>${l.finance_name || '-'}</strong></td>
            <td>${l.login_date || '-'}</td>
            <td style="text-align: right; font-weight: 600; color: #15803d;">${isDisbursed ? formatInr(disbAmt) : '-'}</td>
            <td style="text-align: center;">${isDisbursed && l.disbursed_date ? l.disbursed_date : '-'}</td>
            <td style="text-align: center;">
              <span class="status-badge status-${(l.status || '').toLowerCase().replace(/\s+/g, '-')}">${l.status}</span>
            </td>
          </tr>
        `;
      }).join('');

      const reportHtml = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <title>SD Associates - Leads Report (Table PDF Format)</title>
  <style>
    @page { size: landscape; margin: 8mm; }
    * { box-sizing: border-box; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; }
    body { background: #fff; color: #1e293b; margin: 0; padding: 15px; font-size: 12px; }
    
    .report-topbar {
      display: flex; justify-content: space-between; align-items: center;
      background: #0f172a; color: #fff; padding: 10px 18px; border-radius: 6px;
      margin-bottom: 15px;
    }
    .report-topbar button {
      background: #2563eb; color: #fff; border: none; padding: 7px 14px;
      border-radius: 4px; font-weight: 600; cursor: pointer; font-size: 12px;
    }
    .report-topbar button:hover { background: #1d4ed8; }
    .report-topbar a { color: #cbd5e1; text-decoration: none; margin-left: 12px; font-size: 12px; }
    
    .report-header {
      border-bottom: 2px solid #2563eb; padding-bottom: 8px; margin-bottom: 12px;
      display: flex; justify-content: space-between; align-items: flex-end;
    }
    .report-title h1 { margin: 0; font-size: 20px; color: #0f172a; letter-spacing: -0.02em; }
    .report-title p { margin: 2px 0 0 0; font-size: 12px; color: #64748b; }
    .report-meta { text-align: right; font-size: 11px; color: #475569; }

    .summary-boxes {
      display: flex; gap: 12px; margin-bottom: 12px;
    }
    .summary-box {
      border: 1px solid #cbd5e1; background: #f8fafc; border-radius: 4px;
      padding: 6px 12px; flex: 1;
    }
    .summary-box-label { font-size: 10px; color: #64748b; text-transform: uppercase; font-weight: 600; }
    .summary-box-val { font-size: 15px; font-weight: 700; color: #0f172a; }

    table { width: 100%; border-collapse: collapse; margin-top: 5px; }
    th {
      background: #f1f5f9; color: #334155; font-size: 10px; text-transform: uppercase;
      letter-spacing: 0.04em; padding: 6px 8px; border: 1px solid #cbd5e1; text-align: left;
    }
    td { padding: 6px 8px; border: 1px solid #e2e8f0; font-size: 11px; vertical-align: middle; }
    tr:nth-child(even) td { background-color: #f8fafc; }

    .badge { display: inline-block; padding: 2px 6px; border-radius: 4px; font-size: 10px; font-weight: 600; }
    .badge-new-car { background: #e0f2fe; color: #0369a1; }
    .badge-used-car { background: #fef3c7; color: #92400e; }
    .badge-refinance { background: #f3e8ff; color: #7e22ce; }

    .status-badge { display: inline-block; padding: 2px 6px; border-radius: 4px; font-size: 10px; font-weight: 600; }
    .status-logged-in { background: #e0f2fe; color: #0284c7; }
    .status-in-process { background: #fef3c7; color: #b45309; }
    .status-approved { background: #f3e8ff; color: #6d28d9; }
    .status-disbursed { background: #dcfce7; color: #15803d; }
    .status-rejected { background: #fee2e2; color: #b91c1c; }

    .tfoot-row td { background: #f1f5f9; font-weight: 700; border-top: 2px solid #94a3b8; }

    @media print {
      .report-topbar { display: none !important; }
      body { padding: 0; }
      th { background: #e2e8f0 !important; -webkit-print-color-adjust: exact; }
    }
  </style>
</head>
<body>
  <div class="report-topbar">
    <div>
      <strong>SD Associates • PDF Table Report</strong>
      <span style="opacity: 0.7; margin-left: 10px;">Select 'Save as PDF' in the destination options</span>
    </div>
    <div>
      <button onclick="window.print()">🖨️ Save as PDF / Print</button>
      <a href="/" onclick="window.close();">✖ Back to CRM</a>
    </div>
  </div>

  <div class="report-header">
    <div class="report-title">
      <h1>SD ASSOCIATES</h1>
      <p>Vehicle Loan & Finance CRM • Leads Directory Report</p>
    </div>
    <div class="report-meta">
      <div>Report Filter: ${filterDesc}</div>
      <div>Generated On: ${new Date().toLocaleString('en-IN')}</div>
    </div>
  </div>

  <div class="summary-boxes">
    <div class="summary-box">
      <div class="summary-box-label">Total Leads</div>
      <div class="summary-box-val">${leads.length}</div>
    </div>
    <div class="summary-box">
      <div class="summary-box-label">Total Loan Pipeline</div>
      <div class="summary-box-val">${formatInr(totalLoanVolume)}</div>
    </div>
    <div class="summary-box">
      <div class="summary-box-label">Total Disbursed Volume</div>
      <div class="summary-box-val" style="color: #15803d;">${formatInr(totalDisbursedVolume)}</div>
    </div>
  </div>

  <table>
    <thead>
      <tr>
        <th style="width: 35px; text-align: center;">Sl. No</th>
        <th>Customer Details</th>
        <th>Loan Type</th>
        <th style="text-align: right;">Loan Amount</th>
        <th>Vehicle Details</th>
        <th>Reference Given By</th>
        <th>Finance Partner</th>
        <th>Login Date</th>
        <th style="text-align: right;">Disbursed Amount</th>
        <th style="text-align: center;">Disbursed Date</th>
        <th style="text-align: center;">Status</th>
      </tr>
    </thead>
    <tbody>
      ${rowsHtml || '<tr><td colspan="11" style="text-align: center; padding: 20px;">No leads found matching criteria.</td></tr>'}
    </tbody>
    <tfoot>
      <tr class="tfoot-row">
        <td colspan="3" style="text-align: right;">Total (${leads.length} Records):</td>
        <td style="text-align: right; color: #1d4ed8;">${formatInr(totalLoanVolume)}</td>
        <td colspan="4"></td>
        <td style="text-align: right; color: #15803d;">${formatInr(totalDisbursedVolume)}</td>
        <td colspan="2"></td>
      </tr>
    </tfoot>
  </table>

  <script>
    // Automatically trigger print dialog if requested
    const urlParams = new URLSearchParams(window.location.search);
    if (urlParams.get('autoprint') === '1') {
      window.addEventListener('load', () => {
        setTimeout(() => window.print(), 350);
      });
    }
  </script>
</body>
</html>`;

      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      return res.end(reportHtml);
    }

    // HTML Table Report for Insurance CRM (PDF Export)
    if (pathname === '/report/insurance' && method === 'GET') {
      const filters = parsedUrl.query || {};
      const policies = db.getAllInsurancePolicies(filters);

      const formatInr = (n) => '₹ ' + (Number(n) || 0).toLocaleString('en-IN');
      const totalPremium = policies.reduce((sum, p) => sum + (Number(p.premium_amount) || 0), 0);
      const totalIdv = policies.reduce((sum, p) => sum + (Number(p.idv_value) || 0), 0);
      const expiringSoonCount = policies.filter(p => p.is_expiring_soon).length;
      const expiredCount = policies.filter(p => p.is_expired).length;

      const filterDesc = [
        `Status: <strong>${filters.status || 'All'}</strong>`,
        filters.insurance_company && filters.insurance_company !== 'All' ? `Company: <strong>${filters.insurance_company}</strong>` : '',
        filters.loan_type && filters.loan_type !== 'All' ? `Policy Type: <strong>${filters.loan_type}</strong>` : '',
        filters.expiry_month && filters.expiry_month !== 'All' ? `Expiry Month: <strong>${filters.expiry_month}</strong>` : ''
      ].filter(Boolean).join(' | ');

      const rowsHtml = policies.map(p => {
        let rowStyle = '';
        let alertBadge = '';
        if (p.is_expired) {
          rowStyle = 'background-color: #fef2f2;';
          alertBadge = `<span style="background: #dc2626; color: #fff; padding: 3px 6px; border-radius: 4px; font-weight: 700; font-size: 10px;">🔴 Expired (${Math.abs(p.days_left)}d ago)</span>`;
        } else if (p.days_left === 0) {
          rowStyle = 'background-color: #fff1f2; font-weight: 600;';
          alertBadge = `<span style="background: #dc2626; color: #fff; padding: 3px 6px; border-radius: 4px; font-weight: 700; font-size: 10px;">🚨 EXPIRES TODAY!</span>`;
        } else if (p.is_expiring_soon) {
          rowStyle = 'background-color: #fef2f2;';
          alertBadge = `<span style="background: #b91c1c; color: #fff; padding: 3px 6px; border-radius: 4px; font-weight: 700; font-size: 10px;">⚠️ ${p.days_left} Days Left</span>`;
        } else {
          alertBadge = `<span style="background: #e0f2fe; color: #0369a1; padding: 3px 6px; border-radius: 4px; font-size: 10px; font-weight: 500;">${p.days_left} days left</span>`;
        }

        return `
          <tr style="${rowStyle}">
            <td style="text-align: center; font-weight: 700;">${p.serial_no}</td>
            <td>
              <strong>${p.customer_name}</strong><br>
              <span style="font-size: 11px; color: #555;">${p.mobile_number}</span>
            </td>
            <td><span class="badge" style="background: #e2e8f0; color: #1e293b; padding: 2px 6px; border-radius: 4px; font-size: 10px; font-weight: 600;">${p.loan_type}</span></td>
            <td>
              <strong>${p.model || '-'}</strong> ${p.variant ? `<small>(${p.variant})</small>` : ''}<br>
              <code style="font-size: 11px; color: #444;">${p.vehicle_number || '-'}</code>
            </td>
            <td style="text-align: right; font-weight: 600;">${formatInr(p.idv_value)}</td>
            <td style="text-align: right; font-weight: 700; color: #2563eb;">${formatInr(p.premium_amount)}</td>
            <td style="font-size: 11px;">
              ${p.from_date || '-'} to <strong style="${p.is_expiring_soon || p.is_expired ? 'color: #dc2626;' : ''}">${p.to_date}</strong>
            </td>
            <td style="text-align: center;">
              ${alertBadge}
            </td>
            <td>
              <strong>${p.insurance_company}</strong><br>
              <small style="color: #64748b;">${p.policy_number || ''}</small>
            </td>
            <td>${p.reference_by || '-'}</td>
          </tr>
        `;
      }).join('');

      const reportHtml = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <title>SD Associates - Insurance Policies Report (Table PDF Format)</title>
  <style>
    @page { size: landscape; margin: 8mm; }
    * { box-sizing: border-box; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; }
    body { background: #fff; color: #1e293b; margin: 0; padding: 15px; font-size: 12px; }
    
    .report-topbar {
      display: flex; justify-content: space-between; align-items: center;
      background: #0f172a; color: #fff; padding: 10px 18px; border-radius: 6px;
      margin-bottom: 15px;
    }
    .report-topbar button {
      background: #dc2626; color: #fff; border: none; padding: 7px 14px;
      border-radius: 4px; font-weight: 600; cursor: pointer; font-size: 12px;
    }
    .report-topbar button:hover { background: #b91c1c; }
    .report-topbar a { color: #cbd5e1; text-decoration: none; margin-left: 12px; font-size: 12px; }
    
    .report-header {
      border-bottom: 2px solid #dc2626; padding-bottom: 8px; margin-bottom: 12px;
      display: flex; justify-content: space-between; align-items: flex-end;
    }
    .report-title h1 { margin: 0; font-size: 20px; color: #0f172a; letter-spacing: -0.02em; }
    .report-title p { margin: 2px 0 0 0; font-size: 12px; color: #64748b; }
    .report-meta { text-align: right; font-size: 11px; color: #475569; }

    .summary-boxes {
      display: flex; gap: 12px; margin-bottom: 12px;
    }
    .summary-box {
      border: 1px solid #cbd5e1; background: #f8fafc; border-radius: 4px;
      padding: 6px 12px; flex: 1;
    }
    .summary-box-alert {
      border: 1px solid #fecaca; background: #fef2f2;
    }
    .summary-box-label { font-size: 10px; color: #64748b; text-transform: uppercase; font-weight: 600; }
    .summary-box-val { font-size: 15px; font-weight: 700; color: #0f172a; }

    table { width: 100%; border-collapse: collapse; margin-top: 5px; }
    th {
      background: #f1f5f9; color: #334155; font-size: 10px; text-transform: uppercase;
      letter-spacing: 0.04em; padding: 6px 8px; border: 1px solid #cbd5e1; text-align: left;
    }
    td { padding: 6px 8px; border: 1px solid #e2e8f0; font-size: 11px; vertical-align: middle; }
    tfoot td { background: #f8fafc; font-weight: 700; border-top: 2px solid #0f172a; }

    @media print {
      .report-topbar { display: none; }
      body { padding: 0; }
    }
  </style>
</head>
<body>
  <div class="report-topbar">
    <div>
      <span style="font-weight: 600;">SD Associates Insurance CRM Report</span>
      <span style="color: #94a3b8; margin-left: 8px;">(Table PDF Layout)</span>
    </div>
    <div>
      <button onclick="window.print()">🖨️ Print / Save as PDF</button>
      <a href="/" onclick="window.close(); return true;">Close</a>
    </div>
  </div>

  <div class="report-header">
    <div class="report-title">
      <h1>SD ASSOCIATES</h1>
      <p>Insurance Policies & Renewal Directory Report &bull; ${filterDesc}</p>
    </div>
    <div class="report-meta">
      <div>Generated: <strong>${new Date().toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' })}</strong></div>
      <div>Total Records: <strong>${policies.length}</strong></div>
    </div>
  </div>

  <div class="summary-boxes">
    <div class="summary-box">
      <div class="summary-box-label">Total Policies</div>
      <div class="summary-box-val">${policies.length}</div>
    </div>
    <div class="summary-box summary-box-alert">
      <div class="summary-box-label" style="color: #b91c1c;">⚠️ Expiring in ≤ 10 Days</div>
      <div class="summary-box-val" style="color: #dc2626;">${expiringSoonCount}</div>
    </div>
    <div class="summary-box">
      <div class="summary-box-label">Expired Policies</div>
      <div class="summary-box-val" style="color: #ef4444;">${expiredCount}</div>
    </div>
    <div class="summary-box">
      <div class="summary-box-label">Total Premium Booked</div>
      <div class="summary-box-val" style="color: #2563eb;">${formatInr(totalPremium)}</div>
    </div>
    <div class="summary-box">
      <div class="summary-box-label">Total IDV Coverage</div>
      <div class="summary-box-val">${formatInr(totalIdv)}</div>
    </div>
  </div>

  <table>
    <thead>
      <tr>
        <th style="width: 45px; text-align: center;">Sl. No</th>
        <th>Customer Details</th>
        <th>Policy Type</th>
        <th>Vehicle Details</th>
        <th style="text-align: right;">IDV Value</th>
        <th style="text-align: right;">Premium Amount</th>
        <th>Insurance Period</th>
        <th style="text-align: center;">Expiry Alert</th>
        <th>Insurance Company</th>
        <th>Reference By</th>
      </tr>
    </thead>
    <tbody>
      ${rowsHtml || '<tr><td colspan="10" style="text-align: center; padding: 25px; color: #94a3b8;">No matching insurance policies found</td></tr>'}
    </tbody>
    <tfoot>
      <tr>
        <td colspan="4" style="text-align: right;">Total (${policies.length} Policies):</td>
        <td style="text-align: right;">${formatInr(totalIdv)}</td>
        <td style="text-align: right; color: #2563eb;">${formatInr(totalPremium)}</td>
        <td colspan="4"></td>
      </tr>
    </tfoot>
  </table>

  <script>
    const urlParams = new URLSearchParams(window.location.search);
    if (urlParams.get('autoprint') === '1') {
      window.addEventListener('load', () => {
        setTimeout(() => window.print(), 350);
      });
    }
  </script>
</body>
</html>`;

      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      return res.end(reportHtml);
    }

    // Static files
    serveStatic(req, res, pathname);
  } catch (error) {
    console.error('Server error:', error);
    sendJson(res, 500, { success: false, error: error.message || 'Internal Server Error' });
  }
});

function startServer(port) {
  server.listen(port, () => {
    console.log(`\n==================================================`);
    console.log(`🚀 SD Associates CRM is running!`);
    console.log(`👉 Open: http://localhost:${port}`);
    console.log(`==================================================\n`);
  });

  server.on('error', (err) => {
    if (err.code === 'EADDRINUSE') {
      console.log(`Port ${port} is in use, trying port ${port + 1}...`);
      startServer(port + 1);
    } else {
      console.error('Server startup error:', err);
    }
  });
}

startServer(DEFAULT_PORT);
