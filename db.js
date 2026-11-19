// SD Associates CRM - MongoDB Atlas Database Engine & Data Access Layer
const fs = require('node:fs');
const path = require('node:path');
const { MongoClient, ObjectId } = require('mongodb');

// Ensure .env is loaded
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
    // Continue with existing environment variables
  }
}

const MONGODB_URI = process.env.MONGODB_URI;
const DB_NAME = process.env.DB_NAME || 'sd_associates_crm';

let client = null;
let db = null;
let isConnected = false;
let initPromise = null;
let sqliteFallback = null;

// Safe URI string with masked password for logging
function maskUri(uri) {
  if (!uri) return 'None';
  return uri.replace(/\/\/([^:]+):([^@]+)@/, '//$1:****@');
}

// Lazy-load SQLite fallback if Atlas credentials are placeholder or offline
function getSqliteFallback() {
  if (!sqliteFallback) {
    try {
      sqliteFallback = require('./db-sqlite.js');
    } catch (e) {
      console.warn('SQLite fallback unavailable:', e.message);
    }
  }
  return sqliteFallback;
}

// Connect to MongoDB Atlas
async function connectToMongo() {
  if (isConnected && db) return db;

  if (!MONGODB_URI || MONGODB_URI.includes('<db_password>') || MONGODB_URI.includes('<password>')) {
    console.warn(`\n⚠️  MongoDB Atlas URI is not fully configured (contains <db_password> placeholder).`);
    console.warn(`👉 Please set your actual Atlas database password in backend/.env:`);
    console.warn(`   MONGODB_URI=mongodb+srv://Sdassociates:<YOUR_ACTUAL_PASSWORD>@cluster0.d0z9kkn.mongodb.net/?retryWrites=true&w=majority\n`);
    return null;
  }

  try {
    client = new MongoClient(MONGODB_URI, {
      maxPoolSize: 20,
      minPoolSize: 2,
      serverSelectionTimeoutMS: 5000,
      socketTimeoutMS: 45000
    });

    await client.connect();
    db = client.db(DB_NAME);
    isConnected = true;

    console.log(`✅ Connected successfully to MongoDB Atlas!`);
    console.log(`📦 Database: ${DB_NAME}`);
    console.log(`🌐 Cluster: ${maskUri(MONGODB_URI)}`);

    await ensureIndexesAndSeed();
    return db;
  } catch (err) {
    console.error(`❌ MongoDB Atlas connection error: ${err.message}`);
    isConnected = false;
    client = null;
    db = null;
    return null;
  }
}

async function getDb() {
  if (isConnected && db) return db;
  if (!initPromise) {
    initPromise = connectToMongo();
  }
  const database = await initPromise;
  initPromise = null;
  return database;
}

// Atomic counter generator for IDs and sequential serial numbers
async function getNextSequence(sequenceName) {
  const database = await getDb();
  if (!database) {
    const fb = getSqliteFallback();
    if (sequenceName === 'lead_id' || sequenceName === 'lead_serial') return parseInt(fb.getNextSerialNo(), 10);
    return parseInt(fb.getNextInsuranceSerialNo(), 10);
  }

  const countersCol = database.collection('counters');
  const res = await countersCol.findOneAndUpdate(
    { _id: sequenceName },
    { $inc: { seq: 1 } },
    { returnDocument: 'after', upsert: true }
  );

  return res ? res.seq : 1;
}

// Ensure indexes and seed initial data if collections are empty
async function ensureIndexesAndSeed() {
  if (!db) return;

  try {
    const leadsCol = db.collection('leads');
    const insuranceCol = db.collection('insurance_policies');
    const countersCol = db.collection('counters');

    // Create Indexes for Leads
    await leadsCol.createIndex({ id: 1 }, { unique: true, sparse: true });
    await leadsCol.createIndex({ serial_no: 1 });
    await leadsCol.createIndex({ status: 1 });
    await leadsCol.createIndex({ customer_name: 1 });
    await leadsCol.createIndex({ mobile_number: 1 });
    await leadsCol.createIndex({ vehicle_number: 1 });
    await leadsCol.createIndex({ disbursed_date: 1 });
    await leadsCol.createIndex({ login_date: 1 });

    // Create Indexes for Insurance Policies
    await insuranceCol.createIndex({ id: 1 }, { unique: true, sparse: true });
    await insuranceCol.createIndex({ serial_no: 1 });
    await insuranceCol.createIndex({ status: 1 });
    await insuranceCol.createIndex({ to_date: 1 });
    await insuranceCol.createIndex({ insurance_company: 1 });
    await insuranceCol.createIndex({ customer_name: 1 });
    await insuranceCol.createIndex({ vehicle_number: 1 });

    // Check if migration or seeding is needed
    const leadCount = await leadsCol.countDocuments();
    const insuranceCount = await insuranceCol.countDocuments();

    // Check if local SQLite exists to auto-migrate
    let sqliteMigrated = false;
    try {
      const { DatabaseSync } = require('node:sqlite');
      const candidatePaths = [
        path.join(__dirname, 'data', 'crm.db'),
        path.join(__dirname, '..', 'data', 'crm.db')
      ];
      const sqlitePath = candidatePaths.find(p => fs.existsSync(p));

      if (sqlitePath && (leadCount === 0 || insuranceCount === 0)) {
        const sqliteDb = new DatabaseSync(sqlitePath);
        
        // Migrate Leads
        if (leadCount === 0) {
          const sqliteLeads = sqliteDb.prepare('SELECT * FROM leads ORDER BY id ASC').all();
          if (sqliteLeads.length > 0) {
            console.log(`🔄 Migrating ${sqliteLeads.length} leads from SQLite to MongoDB Atlas...`);
            let maxLeadId = 0;
            const preparedLeads = sqliteLeads.map(l => {
              const numId = Number(l.id) || 1;
              if (numId > maxLeadId) maxLeadId = numId;
              return {
                id: numId,
                serial_no: String(l.serial_no || numId),
                customer_name: l.customer_name || '',
                mobile_number: l.mobile_number || '',
                loan_type: l.loan_type || 'New Car',
                loan_amount: Number(l.loan_amount) || 0,
                vehicle_number: l.vehicle_number || '',
                model: l.model || '',
                variant: l.variant || '',
                reference_by: l.reference_by || '',
                finance_name: l.finance_name || '',
                login_date: l.login_date || '',
                disbursed_amount: Number(l.disbursed_amount) || 0,
                disbursed_date: l.disbursed_date || '',
                rto_amount: Number(l.rto_amount) || 0,
                rto_name: l.rto_name || '',
                seller_amount: Number(l.seller_amount) || 0,
                seller_name: l.seller_name || '',
                seller_date: l.seller_date || '',
                utr_no: l.utr_no || '',
                status: l.status || 'Logged In',
                notes: l.notes || '',
                created_at: l.created_at || new Date().toISOString(),
                updated_at: l.updated_at || new Date().toISOString()
              };
            });
            await leadsCol.insertMany(preparedLeads);
            await countersCol.updateOne(
              { _id: 'lead_id' },
              { $set: { seq: maxLeadId } },
              { upsert: true }
            );
            await countersCol.updateOne(
              { _id: 'lead_serial' },
              { $set: { seq: maxLeadId } },
              { upsert: true }
            );
            sqliteMigrated = true;
          }
        }

        // Migrate Insurance Policies
        if (insuranceCount === 0) {
          try {
            const sqlitePolicies = sqliteDb.prepare('SELECT * FROM insurance_policies ORDER BY id ASC').all();
            if (sqlitePolicies.length > 0) {
              console.log(`🔄 Migrating ${sqlitePolicies.length} insurance policies from SQLite to MongoDB Atlas...`);
              let maxInsId = 0;
              const preparedPolicies = sqlitePolicies.map(p => {
                const numId = Number(p.id) || 1;
                if (numId > maxInsId) maxInsId = numId;
                return {
                  id: numId,
                  serial_no: String(p.serial_no || numId),
                  customer_name: p.customer_name || '',
                  mobile_number: p.mobile_number || '',
                  loan_type: p.loan_type || 'Comprehensive',
                  vehicle_number: p.vehicle_number || '',
                  model: p.model || '',
                  variant: p.variant || '',
                  idv_value: Number(p.idv_value) || 0,
                  premium_amount: Number(p.premium_amount) || 0,
                  from_date: p.from_date || '',
                  to_date: p.to_date || '',
                  insurance_company: p.insurance_company || '',
                  policy_number: p.policy_number || '',
                  reference_by: p.reference_by || '',
                  status: p.status || 'Active',
                  notes: p.notes || '',
                  created_at: p.created_at || new Date().toISOString(),
                  updated_at: p.updated_at || new Date().toISOString()
                };
              });
              await insuranceCol.insertMany(preparedPolicies);
              await countersCol.updateOne(
                { _id: 'insurance_id' },
                { $set: { seq: maxInsId } },
                { upsert: true }
              );
              await countersCol.updateOne(
                { _id: 'insurance_serial' },
                { $set: { seq: maxInsId } },
                { upsert: true }
              );
              sqliteMigrated = true;
            }
          } catch (e) {
            // Insurance table might not exist in older SQLite db
          }
        }
      }
    } catch (e) {
      // Ignore SQLite read error
    }

    // If still empty (new fresh installation), seed sample records
    if (!sqliteMigrated && leadCount === 0) {
      await seedSampleLeads(leadsCol, countersCol);
    }
    if (!sqliteMigrated && insuranceCount === 0) {
      await seedSampleInsurance(insuranceCol, countersCol);
    }
  } catch (err) {
    console.error('Error ensuring MongoDB indexes and seed:', err.message);
  }
}

async function seedSampleLeads(leadsCol, countersCol) {
  const today = new Date().toISOString().slice(0, 10);
  const sampleLeads = [
    {
      id: 1,
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
      rto_name: '',
      seller_amount: 0,
      seller_name: '',
      seller_date: '',
      utr_no: '',
      status: 'Logged In',
      notes: 'Customer looking for low ROI and fast delivery.',
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString()
    },
    {
      id: 2,
      serial_no: '2',
      customer_name: 'Senthil Nathan',
      mobile_number: '9841029384',
      loan_type: 'Used Car',
      loan_amount: 420000,
      vehicle_number: 'TN 10 AJ 1290',
      model: 'Hyundai i20',
      variant: 'Sportz 1.2 Petrol',
      reference_by: 'Vicky Cars',
      finance_name: 'ICICI Bank',
      login_date: today,
      disbursed_amount: 0,
      disbursed_date: '',
      rto_amount: 0,
      rto_name: '',
      seller_amount: 0,
      seller_name: '',
      seller_date: '',
      utr_no: '',
      status: 'In Process',
      notes: 'Valuation completed, waiting for banking statements approval.',
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString()
    },
    {
      id: 3,
      serial_no: '3',
      customer_name: 'Muruganandam P',
      mobile_number: '9710345678',
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
      rto_name: 'KALLI',
      seller_amount: 485000,
      seller_name: 'MAHESH',
      seller_date: today,
      utr_no: 'UTR10010000456',
      status: 'Disbursed',
      notes: 'Foreclosure letter cleared. Payout processed and disbursed successfully.',
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString()
    }
  ];

  await leadsCol.insertMany(sampleLeads);
  await countersCol.updateOne({ _id: 'lead_id' }, { $set: { seq: 3 } }, { upsert: true });
  await countersCol.updateOne({ _id: 'lead_serial' }, { $set: { seq: 3 } }, { upsert: true });
  console.log('✅ Seeded initial leads into MongoDB Atlas');
}

async function seedSampleInsurance(insuranceCol, countersCol) {
  const today = new Date();
  const fmt = d => d.toISOString().slice(0, 10);

  const d4 = new Date(today);
  d4.setDate(d4.getDate() + 4);
  const d4From = new Date(today);
  d4From.setFullYear(d4From.getFullYear() - 1);
  d4From.setDate(d4From.getDate() + 5);

  const d8 = new Date(today);
  d8.setDate(d8.getDate() + 8);
  const d8From = new Date(today);
  d8From.setFullYear(d8From.getFullYear() - 1);
  d8From.setDate(d8From.getDate() + 9);

  const dToday = new Date(today);
  const dTodayFrom = new Date(today);
  dTodayFrom.setFullYear(dTodayFrom.getFullYear() - 1);
  dTodayFrom.setDate(dTodayFrom.getDate() + 1);

  const dFuture = new Date(today);
  dFuture.setMonth(dFuture.getMonth() + 8);
  const dFutureFrom = new Date(today);
  dFutureFrom.setMonth(dFutureFrom.getMonth() - 4);

  const dPast = new Date(today);
  dPast.setDate(dPast.getDate() - 6);
  const dPastFrom = new Date(today);
  dPastFrom.setFullYear(dPastFrom.getFullYear() - 1);
  dPastFrom.setDate(dPastFrom.getDate() - 5);

  const samplePolicies = [
    {
      id: 1,
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
      notes: 'Called customer. Wants zero dep quote comparison before renewal.',
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString()
    },
    {
      id: 2,
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
      notes: 'Renewal notice sent on WhatsApp. Customer will pay by Saturday.',
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString()
    },
    {
      id: 3,
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
      notes: 'URGENT: Policy expiring TODAY! Renewal link shared.',
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString()
    },
    {
      id: 4,
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
      notes: '1-year policy renewed with 50% NCB bonus.',
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString()
    },
    {
      id: 5,
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
      notes: 'Policy expired. Inspection required for break-in renewal.',
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString()
    }
  ];

  await insuranceCol.insertMany(samplePolicies);
  await countersCol.updateOne({ _id: 'insurance_id' }, { $set: { seq: 5 } }, { upsert: true });
  await countersCol.updateOne({ _id: 'insurance_serial' }, { $set: { seq: 5 } }, { upsert: true });
  console.log('✅ Seeded initial insurance policies into MongoDB Atlas');
}

// Format MongoDB document to match exact CRM contract
function formatLeadDoc(doc) {
  if (!doc) return null;
  return {
    id: doc.id !== undefined ? doc.id : doc._id.toString(),
    _id: doc._id ? doc._id.toString() : undefined,
    serial_no: String(doc.serial_no || doc.id || ''),
    customer_name: doc.customer_name || '',
    mobile_number: doc.mobile_number || '',
    loan_type: doc.loan_type || 'New Car',
    loan_amount: Number(doc.loan_amount) || 0,
    vehicle_number: doc.vehicle_number || '',
    model: doc.model || '',
    variant: doc.variant || '',
    reference_by: doc.reference_by || '',
    finance_name: doc.finance_name || '',
    login_date: doc.login_date || '',
    disbursed_amount: Number(doc.disbursed_amount) || 0,
    disbursed_date: doc.disbursed_date || '',
    rto_amount: Number(doc.rto_amount) || 0,
    rto_name: doc.rto_name || '',
    seller_amount: Number(doc.seller_amount) || 0,
    seller_name: doc.seller_name || '',
    seller_date: doc.seller_date || '',
    utr_no: doc.utr_no || '',
    status: doc.status || 'Logged In',
    notes: doc.notes || '',
    created_at: doc.created_at || '',
    updated_at: doc.updated_at || ''
  };
}

// Build query selector for lookup by numeric id or Mongo ObjectId
function buildIdQuery(id) {
  const queries = [];
  const numId = Number(id);
  if (!isNaN(numId)) {
    queries.push({ id: numId });
  }
  if (typeof id === 'string' && ObjectId.isValid(id) && id.length === 24) {
    queries.push({ _id: new ObjectId(id) });
  }
  queries.push({ serial_no: String(id) });
  return queries.length === 1 ? queries[0] : { $or: queries };
}

// ==========================================
// VEHICLE LOAN CRM METHODS
// ==========================================

async function getAllLeads(filters = {}) {
  const database = await getDb();
  if (!database) {
    return getSqliteFallback().getAllLeads(filters);
  }

  const query = {};

  if (filters.search && filters.search.trim()) {
    const s = filters.search.trim();
    const regex = new RegExp(s.replace(/[-[\]{}()*+?.,\\^$|#\s]/g, '\\$&'), 'i');
    query.$or = [
      { serial_no: regex },
      { customer_name: regex },
      { mobile_number: regex },
      { vehicle_number: regex },
      { model: regex },
      { reference_by: regex },
      { finance_name: regex }
    ];
  }

  if (filters.status && filters.status !== 'All') {
    query.status = filters.status;
  }

  if (filters.loan_type && filters.loan_type !== 'All') {
    query.loan_type = filters.loan_type;
  }

  if (filters.finance_name && filters.finance_name !== 'All') {
    query.finance_name = filters.finance_name;
  }

  if (filters.disbursed_month && filters.disbursed_month !== 'All') {
    query.disbursed_date = new RegExp('^' + filters.disbursed_month.trim());
  }

  if (filters.disbursed_from || filters.disbursed_to) {
    query.disbursed_date = query.disbursed_date || {};
    if (typeof query.disbursed_date === 'object' && !(query.disbursed_date instanceof RegExp)) {
      if (filters.disbursed_from) query.disbursed_date.$gte = filters.disbursed_from;
      if (filters.disbursed_to) query.disbursed_date.$lte = filters.disbursed_to;
    }
  }

  if (filters.from_date || filters.to_date) {
    query.login_date = query.login_date || {};
    if (filters.from_date) query.login_date.$gte = filters.from_date;
    if (filters.to_date) query.login_date.$lte = filters.to_date;
  }

  const leadsCol = database.collection('leads');
  const docs = await leadsCol.find(query).sort({ id: 1 }).toArray();
  return docs.map(formatLeadDoc);
}

async function getLeadById(id) {
  const database = await getDb();
  if (!database) {
    return getSqliteFallback().getLeadById(id);
  }

  const leadsCol = database.collection('leads');
  const doc = await leadsCol.findOne(buildIdQuery(id));
  return formatLeadDoc(doc);
}

async function getNextSerialNo() {
  const database = await getDb();
  if (!database) {
    return getSqliteFallback().getNextSerialNo();
  }

  const leadsCol = database.collection('leads');
  const topDoc = await leadsCol.find().sort({ id: -1 }).limit(1).toArray();
  if (topDoc.length > 0 && typeof topDoc[0].id === 'number') {
    return String(topDoc[0].id + 1);
  }
  return '1';
}

async function createLead(data) {
  const database = await getDb();
  if (!database) {
    return getSqliteFallback().createLead(data);
  }

  const nextId = await getNextSequence('lead_id');
  const serialNo = (data.serial_no && String(data.serial_no).trim()) || String(nextId);

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
  const now = new Date().toISOString().replace('T', ' ').substring(0, 19);

  const doc = {
    id: nextId,
    serial_no: serialNo,
    customer_name: data.customer_name ? data.customer_name.trim() : '',
    mobile_number: data.mobile_number ? data.mobile_number.trim() : '',
    loan_type: data.loan_type || 'New Car',
    loan_amount: Number(data.loan_amount) || 0,
    vehicle_number: data.vehicle_number ? data.vehicle_number.trim().toUpperCase() : '',
    model: data.model ? data.model.trim() : '',
    variant: data.variant ? data.variant.trim() : '',
    reference_by: data.reference_by ? data.reference_by.trim() : '',
    finance_name: data.finance_name ? data.finance_name.trim() : '',
    login_date: data.login_date || new Date().toISOString().slice(0, 10),
    disbursed_amount: disbursedAmount,
    disbursed_date: disbursedDate,
    rto_amount: rtoAmount,
    rto_name: rtoName,
    seller_amount: sellerAmount,
    seller_name: sellerName,
    seller_date: sellerDate,
    utr_no: utrNo,
    status: data.status || 'Logged In',
    notes: data.notes ? data.notes.trim() : '',
    created_at: now,
    updated_at: now
  };

  const leadsCol = database.collection('leads');
  const res = await leadsCol.insertOne(doc);
  return formatLeadDoc({ ...doc, _id: res.insertedId });
}

async function updateLead(id, data) {
  const database = await getDb();
  if (!database) {
    return getSqliteFallback().updateLead(id, data);
  }

  const leadsCol = database.collection('leads');
  const existing = await leadsCol.findOne(buildIdQuery(id));
  if (!existing) {
    throw new Error('Lead not found');
  }

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
  const now = new Date().toISOString().replace('T', ' ').substring(0, 19);

  const updateFields = {
    serial_no: data.serial_no ? String(data.serial_no).trim() : existing.serial_no,
    customer_name: data.customer_name ? data.customer_name.trim() : existing.customer_name,
    mobile_number: data.mobile_number ? data.mobile_number.trim() : existing.mobile_number,
    loan_type: data.loan_type || existing.loan_type,
    loan_amount: Number(data.loan_amount) || existing.loan_amount,
    vehicle_number: data.vehicle_number ? data.vehicle_number.trim().toUpperCase() : existing.vehicle_number,
    model: data.model ? data.model.trim() : existing.model,
    variant: data.variant ? data.variant.trim() : existing.variant,
    reference_by: data.reference_by ? data.reference_by.trim() : existing.reference_by,
    finance_name: data.finance_name ? data.finance_name.trim() : existing.finance_name,
    login_date: data.login_date || existing.login_date,
    disbursed_amount: disbursedAmount,
    disbursed_date: disbursedDate,
    rto_amount: rtoAmount,
    rto_name: rtoName,
    seller_amount: sellerAmount,
    seller_name: sellerName,
    seller_date: sellerDate,
    utr_no: utrNo,
    status: data.status || existing.status,
    notes: data.notes !== undefined ? data.notes.trim() : existing.notes,
    updated_at: now
  };

  await leadsCol.updateOne({ _id: existing._id }, { $set: updateFields });
  return getLeadById(existing.id || existing._id);
}

async function deleteLead(id) {
  const database = await getDb();
  if (!database) {
    return getSqliteFallback().deleteLead(id);
  }

  const leadsCol = database.collection('leads');
  const target = await leadsCol.findOne(buildIdQuery(id));
  if (target) {
    await leadsCol.deleteOne({ _id: target._id });
  }
  return { success: true, id };
}

async function getStats() {
  const database = await getDb();
  if (!database) {
    return getSqliteFallback().getStats();
  }

  const leadsCol = database.collection('leads');
  const allLeads = await leadsCol.find().toArray();

  const totalLeads = allLeads.length;
  const totalVolume = allLeads.reduce((sum, l) => sum + (Number(l.loan_amount) || 0), 0);

  const disbursedLeads = allLeads.filter(l => l.status === 'Disbursed');
  const disbursedCount = disbursedLeads.length;
  const disbursedVolume = disbursedLeads.reduce((sum, l) => sum + (Number(l.disbursed_amount) || Number(l.loan_amount) || 0), 0);

  // Group by Status
  const statusMap = {};
  allLeads.forEach(l => {
    const s = l.status || 'Logged In';
    if (!statusMap[s]) statusMap[s] = { count: 0, total_amount: 0 };
    statusMap[s].count++;
    const amt = s === 'Disbursed' ? (Number(l.disbursed_amount) || Number(l.loan_amount) || 0) : Number(l.loan_amount) || 0;
    statusMap[s].total_amount += amt;
  });
  const byStatus = Object.entries(statusMap).map(([status, val]) => ({
    status,
    count: val.count,
    total_amount: val.total_amount
  }));

  // Group by Loan Type
  const typeMap = {};
  allLeads.forEach(l => {
    const t = l.loan_type || 'New Car';
    typeMap[t] = (typeMap[t] || 0) + 1;
  });
  const byLoanType = Object.entries(typeMap).map(([loan_type, count]) => ({ loan_type, count }));

  // Top Finance Partners
  const financeMap = {};
  allLeads.forEach(l => {
    if (l.finance_name && l.finance_name.trim()) {
      const f = l.finance_name.trim();
      financeMap[f] = (financeMap[f] || 0) + 1;
    }
  });
  const topFinance = Object.entries(financeMap)
    .map(([finance_name, count]) => ({ finance_name, count }))
    .sort((a, b) => b.count - a.count)
    .slice(0, 5);

  return {
    totalLeads,
    totalVolume,
    disbursedCount,
    disbursedVolume,
    byStatus,
    byLoanType,
    topFinance
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

function formatInsuranceDoc(doc) {
  if (!doc) return null;
  const formatted = {
    id: doc.id !== undefined ? doc.id : doc._id.toString(),
    _id: doc._id ? doc._id.toString() : undefined,
    serial_no: String(doc.serial_no || doc.id || ''),
    customer_name: doc.customer_name || '',
    mobile_number: doc.mobile_number || '',
    loan_type: doc.loan_type || 'Comprehensive',
    vehicle_number: doc.vehicle_number || '',
    model: doc.model || '',
    variant: doc.variant || '',
    idv_value: Number(doc.idv_value) || 0,
    premium_amount: Number(doc.premium_amount) || 0,
    from_date: doc.from_date || '',
    to_date: doc.to_date || '',
    insurance_company: doc.insurance_company || '',
    policy_number: doc.policy_number || '',
    reference_by: doc.reference_by || '',
    status: doc.status || 'Active',
    notes: doc.notes || '',
    created_at: doc.created_at || '',
    updated_at: doc.updated_at || ''
  };
  return decoratePolicy(formatted);
}

async function getAllInsurancePolicies(filters = {}) {
  const database = await getDb();
  if (!database) {
    return getSqliteFallback().getAllInsurancePolicies(filters);
  }

  const query = {};

  if (filters.search && filters.search.trim()) {
    const s = filters.search.trim();
    const regex = new RegExp(s.replace(/[-[\]{}()*+?.,\\^$|#\s]/g, '\\$&'), 'i');
    query.$or = [
      { serial_no: regex },
      { customer_name: regex },
      { mobile_number: regex },
      { vehicle_number: regex },
      { model: regex },
      { variant: regex },
      { insurance_company: regex },
      { policy_number: regex },
      { reference_by: regex }
    ];
  }

  if (filters.insurance_company && filters.insurance_company !== 'All') {
    query.insurance_company = filters.insurance_company;
  }

  if (filters.loan_type && filters.loan_type !== 'All') {
    query.loan_type = filters.loan_type;
  }

  if (filters.expiry_month && filters.expiry_month !== 'All') {
    query.to_date = new RegExp('^' + filters.expiry_month.trim());
  }

  if (filters.from_date || filters.to_date) {
    query.to_date = query.to_date || {};
    if (typeof query.to_date === 'object' && !(query.to_date instanceof RegExp)) {
      if (filters.from_date) query.to_date.$gte = filters.from_date;
      if (filters.to_date) query.to_date.$lte = filters.to_date;
    }
  }

  const insuranceCol = database.collection('insurance_policies');
  const docs = await insuranceCol.find(query).sort({ id: 1 }).toArray();
  let decorated = docs.map(formatInsuranceDoc);

  // Status filtering in JS for accurate dynamic 0-10 days expiry logic
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

async function getInsurancePolicyById(id) {
  const database = await getDb();
  if (!database) {
    return getSqliteFallback().getInsurancePolicyById(id);
  }

  const insuranceCol = database.collection('insurance_policies');
  const doc = await insuranceCol.findOne(buildIdQuery(id));
  return formatInsuranceDoc(doc);
}

async function getNextInsuranceSerialNo() {
  const database = await getDb();
  if (!database) {
    return getSqliteFallback().getNextInsuranceSerialNo();
  }

  const insuranceCol = database.collection('insurance_policies');
  const topDoc = await insuranceCol.find().sort({ id: -1 }).limit(1).toArray();
  if (topDoc.length > 0 && typeof topDoc[0].id === 'number') {
    return String(topDoc[0].id + 1);
  }
  return '1';
}

async function createInsurancePolicy(data) {
  const database = await getDb();
  if (!database) {
    return getSqliteFallback().createInsurancePolicy(data);
  }

  const nextId = await getNextSequence('insurance_id');
  let serialNo = data.serial_no ? String(data.serial_no).trim() : '';
  if (!serialNo) serialNo = String(nextId);

  const daysLeft = calculateInsuranceDaysLeft(data.to_date);
  let status = data.status || 'Active';
  if (!data.status || data.status === 'Active' || data.status === 'Expiring Soon' || data.status === 'Expired') {
    if (daysLeft !== null) {
      if (daysLeft < 0) status = 'Expired';
      else if (daysLeft <= 10) status = 'Expiring Soon';
      else status = 'Active';
    }
  }

  const now = new Date().toISOString().replace('T', ' ').substring(0, 19);

  const doc = {
    id: nextId,
    serial_no: serialNo,
    customer_name: data.customer_name ? data.customer_name.trim() : '',
    mobile_number: data.mobile_number ? data.mobile_number.trim() : '',
    loan_type: data.loan_type ? data.loan_type.trim() : 'Comprehensive',
    vehicle_number: data.vehicle_number ? data.vehicle_number.trim().toUpperCase() : '',
    model: data.model ? data.model.trim() : '',
    variant: data.variant ? data.variant.trim() : '',
    idv_value: Number(data.idv_value) || 0,
    premium_amount: Number(data.premium_amount) || 0,
    from_date: data.from_date || '',
    to_date: data.to_date || '',
    insurance_company: data.insurance_company ? data.insurance_company.trim() : '',
    policy_number: data.policy_number ? data.policy_number.trim() : '',
    reference_by: data.reference_by ? data.reference_by.trim() : '',
    status,
    notes: data.notes ? data.notes.trim() : '',
    created_at: now,
    updated_at: now
  };

  const insuranceCol = database.collection('insurance_policies');
  const res = await insuranceCol.insertOne(doc);
  return formatInsuranceDoc({ ...doc, _id: res.insertedId });
}

async function updateInsurancePolicy(id, data) {
  const database = await getDb();
  if (!database) {
    return getSqliteFallback().updateInsurancePolicy(id, data);
  }

  const insuranceCol = database.collection('insurance_policies');
  const existing = await insuranceCol.findOne(buildIdQuery(id));
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

  const now = new Date().toISOString().replace('T', ' ').substring(0, 19);

  const updateFields = {
    serial_no: serialNo,
    customer_name: data.customer_name !== undefined ? data.customer_name.trim() : existing.customer_name,
    mobile_number: data.mobile_number !== undefined ? data.mobile_number.trim() : existing.mobile_number,
    loan_type: data.loan_type !== undefined ? data.loan_type.trim() : existing.loan_type,
    vehicle_number: data.vehicle_number !== undefined ? data.vehicle_number.trim().toUpperCase() : existing.vehicle_number,
    model: data.model !== undefined ? data.model.trim() : existing.model,
    variant: data.variant !== undefined ? data.variant.trim() : existing.variant,
    idv_value: data.idv_value !== undefined ? (Number(data.idv_value) || 0) : existing.idv_value,
    premium_amount: data.premium_amount !== undefined ? (Number(data.premium_amount) || 0) : existing.premium_amount,
    from_date: data.from_date !== undefined ? data.from_date : existing.from_date,
    to_date: toDate,
    insurance_company: data.insurance_company !== undefined ? data.insurance_company.trim() : existing.insurance_company,
    policy_number: data.policy_number !== undefined ? data.policy_number.trim() : existing.policy_number,
    reference_by: data.reference_by !== undefined ? data.reference_by.trim() : existing.reference_by,
    status,
    notes: data.notes !== undefined ? data.notes.trim() : existing.notes,
    updated_at: now
  };

  await insuranceCol.updateOne({ _id: existing._id }, { $set: updateFields });
  return getInsurancePolicyById(existing.id || existing._id);
}

async function deleteInsurancePolicy(id) {
  const database = await getDb();
  if (!database) {
    return getSqliteFallback().deleteInsurancePolicy(id);
  }

  const insuranceCol = database.collection('insurance_policies');
  const target = await insuranceCol.findOne(buildIdQuery(id));
  if (target) {
    await insuranceCol.deleteOne({ _id: target._id });
  }
  return { success: true, id };
}

async function getInsuranceStats() {
  const database = await getDb();
  if (!database) {
    return getSqliteFallback().getInsuranceStats();
  }

  const all = await getAllInsurancePolicies({});
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
  getInsuranceStats,

  // Database Connection
  connectToMongo,
  getDb
};
