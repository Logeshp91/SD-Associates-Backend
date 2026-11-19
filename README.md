# SD Associates CRM - Backend

Fast, zero-dependency REST API and SQLite Database Engine for SD Associates CRM.

## ✨ Features
- **Pure Native Node.js**: Built entirely with `node:http`, `node:fs`, `node:path`, and native `node:sqlite`. Zero external npm packages required.
- **RESTful Endpoints**: Full CRUD operations for Vehicle Loan leads and Insurance policies.
- **Auto Serial Numbering**: Automatically generates sequential policy numbers.
- **Automated Expiry Calculations**: Computes real-time days left and renewal alert zones.
- **Built-in Report Generator**: Native CSV export and printable PDF reports.
- **Native Environment Config**: Built-in `.env` loader without third-party dependencies.

## 🚀 Getting Started

### 1. Prerequisites
- Node.js v20.6.0 or higher (supports native `node:sqlite` and `.env` loader)

### 2. Configure Environment
```bash
cp .env.example .env
```
Adjust `PORT` (default: 4000) or `HOST` as needed.

### 3. Run Server
```bash
npm start
# or
node server.js
```
The server will boot and serve the API on `http://localhost:4000`.

## 📡 API Endpoints
- `GET /api/leads` - List loan leads
- `POST /api/leads` - Create new loan lead
- `GET /api/leads/stats` - Loan metrics & pipeline statistics
- `GET /api/insurance` - List insurance policies
- `POST /api/insurance` - Create new insurance policy
- `GET /api/insurance/stats` - Insurance metrics (Total, Expiring $\le 10$ days, Expired, Total Premium)
- `GET /api/insurance/export` - Export policies to CSV
- `GET /report/insurance` - Printable PDF table view
