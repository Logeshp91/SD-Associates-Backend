# SD Associates CRM - Backend (MongoDB Atlas)

Scalable, high-performance REST API and Database Engine for the SD Associates CRM, powered by native Node.js and MongoDB Atlas.

## ✨ Database Architecture & Features
- **MongoDB Atlas Integration**: Primary cloud database storing all vehicle loan leads, insurance policies, and system metadata.
- **Atomic Counters (`counters` collection)**: Thread-safe, atomic auto-incrementing sequential numbers for IDs and serial numbers (`1`, `2`, `3`...).
- **Automatic Migration**: Auto-migrates existing records from local SQLite (`crm.db`) to MongoDB Atlas upon first connection, with zero data loss.
- **Zero-Downtime Fallback**: If MongoDB credentials are missing or offline, gracefully operates in fallback mode without crashing.
- **RESTful Endpoints**: Full CRUD operations for Vehicle Loan leads and Insurance policies.
- **Automated Expiry Calculations**: Real-time renewal countdown and $\le 10$ days red alert zones.
- **Native Report Generator**: Live CSV exports and printable PDF table views.
- **Safe Credential Handling**: Database URIs are automatically masked in all logs to guarantee security.

## 🗄️ MongoDB Collections
- `leads`: Vehicle loan leads (customer details, loan amount, RTO, seller amount, UTR, status).
- `insurance_policies`: Motor insurance policies (IDV value, premium, validity dates, insurance company).
- `counters`: Atomic sequence numbers for `lead_id`, `lead_serial`, `insurance_id`, `insurance_serial`.

## 🚀 Getting Started

### 1. Prerequisites
- Node.js v20.6.0 or higher
- MongoDB Atlas cluster account

### 2. Configure Environment (`.env`)
Copy `.env.example` to `.env`:
```bash
cp .env.example .env
```
Set your MongoDB Atlas connection string:
```ini
PORT=4000
HOST=localhost
NODE_ENV=development
MONGODB_URI=mongodb+srv://Sdassociates:<YOUR_ATLAS_PASSWORD>@cluster0.d0z9kkn.mongodb.net/?retryWrites=true&w=majority
DB_NAME=sd_associates_crm
```

### 3. Run One-Click SQLite to Atlas Migration (Optional)
If you already have data in SQLite and want to trigger migration manually:
```bash
npm run migrate
```

### 4. Start Server
```bash
npm start
# or development watch mode:
npm run dev
```
Open **http://localhost:4000** in your browser.

## 📡 API Endpoints
- `GET /api/leads` - List/filter loan leads
- `POST /api/leads` - Create new loan lead
- `GET /api/leads/:id` - Fetch single lead by numeric ID or ObjectId
- `PUT /api/leads/:id` - Update loan lead
- `DELETE /api/leads/:id` - Delete loan lead
- `GET /api/leads/stats` - Loan metrics & pipeline statistics
- `GET /api/export` - Export leads to CSV
- `GET /report` - Printable PDF table view of leads
- `GET /api/insurance` - List/filter insurance policies
- `POST /api/insurance` - Create new insurance policy
- `GET /api/insurance/:id` - Fetch insurance policy
- `PUT /api/insurance/:id` - Update insurance policy
- `DELETE /api/insurance/:id` - Delete insurance policy
- `GET /api/insurance/stats` - Insurance metrics (Total, Expiring $\le 10$ days, Expired, Total Premium)
- `GET /api/insurance/export` - Export policies to CSV
- `GET /report/insurance` - Printable PDF table view of insurance
