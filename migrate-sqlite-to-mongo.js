// SD Associates CRM - One-Click SQLite to MongoDB Atlas Migration Tool
const fs = require('node:fs');
const path = require('node:path');
const { MongoClient } = require('mongodb');
const { DatabaseSync } = require('node:sqlite');

// Load environment configuration
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
  } catch (e) {}
}

const MONGODB_URI = process.env.MONGODB_URI;
const DB_NAME = process.env.DB_NAME || 'sd_associates_crm';

function maskUri(uri) {
  if (!uri) return 'None';
  return uri.replace(/\/\/([^:]+):([^@]+)@/, '//$1:****@');
}

async function runMigration() {
  console.log('\n==================================================');
  console.log('🚀 SD ASSOCIATES CRM — MONGODB ATLAS MIGRATION');
  console.log('==================================================\n');

  if (!MONGODB_URI || MONGODB_URI.includes('<db_password>') || MONGODB_URI.includes('<password>')) {
    console.error('❌ MONGODB_URI is not configured with your actual Atlas password.');
    console.error('👉 Please update MONGODB_URI in backend/.env before running migration.');
    process.exit(1);
  }

  // Find SQLite Database
  const candidatePaths = [
    path.join(__dirname, 'data', 'crm.db'),
    path.join(__dirname, '..', 'data', 'crm.db')
  ];
  const sqlitePath = candidatePaths.find(p => fs.existsSync(p));

  if (!sqlitePath) {
    console.error('❌ SQLite database file (crm.db) not found in data/ or backend/data/');
    process.exit(1);
  }

  console.log(`📂 Source SQLite Database: ${sqlitePath}`);
  console.log(`🌐 Target MongoDB Atlas:   ${maskUri(MONGODB_URI)}`);
  console.log(`📦 Database Name:           ${DB_NAME}\n`);

  const client = new MongoClient(MONGODB_URI, { serverSelectionTimeoutMS: 8000 });

  try {
    console.log('⏳ Connecting to MongoDB Atlas...');
    await client.connect();
    console.log('✅ Connected successfully!\n');

    const mongoDb = client.db(DB_NAME);
    const sqliteDb = new DatabaseSync(sqlitePath);

    const leadsCol = mongoDb.collection('leads');
    const insuranceCol = mongoDb.collection('insurance_policies');
    const countersCol = mongoDb.collection('counters');

    // 1. Migrate Leads
    console.log('--- 1. Migrating Leads ---');
    const sqliteLeads = sqliteDb.prepare('SELECT * FROM leads ORDER BY id ASC').all();
    console.log(`Found ${sqliteLeads.length} leads in SQLite.`);

    let maxLeadId = 0;
    if (sqliteLeads.length > 0) {
      await leadsCol.deleteMany({}); // Fresh sync
      const formattedLeads = sqliteLeads.map(l => {
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

      await leadsCol.insertMany(formattedLeads);
      await countersCol.updateOne({ _id: 'lead_id' }, { $set: { seq: maxLeadId } }, { upsert: true });
      await countersCol.updateOne({ _id: 'lead_serial' }, { $set: { seq: maxLeadId } }, { upsert: true });
      console.log(`✅ Successfully imported ${formattedLeads.length} leads. Max ID: ${maxLeadId}`);
    }

    // 2. Migrate Insurance Policies
    console.log('\n--- 2. Migrating Insurance Policies ---');
    let sqlitePolicies = [];
    try {
      sqlitePolicies = sqliteDb.prepare('SELECT * FROM insurance_policies ORDER BY id ASC').all();
    } catch (e) {
      console.log('No insurance_policies table in SQLite (skipping).');
    }

    console.log(`Found ${sqlitePolicies.length} insurance policies in SQLite.`);
    let maxInsId = 0;
    if (sqlitePolicies.length > 0) {
      await insuranceCol.deleteMany({}); // Fresh sync
      const formattedPolicies = sqlitePolicies.map(p => {
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

      await insuranceCol.insertMany(formattedPolicies);
      await countersCol.updateOne({ _id: 'insurance_id' }, { $set: { seq: maxInsId } }, { upsert: true });
      await countersCol.updateOne({ _id: 'insurance_serial' }, { $set: { seq: maxInsId } }, { upsert: true });
      console.log(`✅ Successfully imported ${formattedPolicies.length} policies. Max ID: ${maxInsId}`);
    }

    // 3. Ensure Indexes
    console.log('\n--- 3. Verifying Indexes ---');
    await leadsCol.createIndex({ id: 1 }, { unique: true, sparse: true });
    await leadsCol.createIndex({ serial_no: 1 });
    await leadsCol.createIndex({ status: 1 });
    await insuranceCol.createIndex({ id: 1 }, { unique: true, sparse: true });
    await insuranceCol.createIndex({ serial_no: 1 });
    await insuranceCol.createIndex({ to_date: 1 });
    console.log('✅ Indexes verified successfully.');

    console.log('\n==================================================');
    console.log('🎉 MIGRATION COMPLETED SUCCESSFULLY!');
    console.log(`📊 Total Leads:              ${sqliteLeads.length}`);
    console.log(`🛡️ Total Insurance Policies: ${sqlitePolicies.length}`);
    console.log('==================================================\n');
  } catch (err) {
    console.error('\n❌ Migration failed:', err.message);
  } finally {
    await client.close();
  }
}

runMigration();
