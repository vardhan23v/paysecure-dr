# pro3 — PaySecure Disaster Recovery Platform

Multi-region disaster recovery platform for payment processing systems, designed for **RPO < 1 minute** and **RTO < 5 minutes** with active-passive topology across India-centric regions (Mumbai, Hyderabad, Pune).

## Live Demos

| Portal | URL |
|---|---|
| **PaySecure Portal** (primary) | [paysecure-portal.vercel.app](https://paysecure-portal.vercel.app) |
| **PaySecure DR Portal** (disaster recovery) | [paysecure-dr-portal.vercel.app](https://paysecure-dr-portal.vercel.app) |

## Repository

[https://github.com/vardhan23v/pro3](https://github.com/vardhan23v/pro3)

## Project Structure

```
pro3/
├── paysecure-portal/       # Primary React + Vite + Tailwind portal
├── paysecure-dr-portal/    # DR portal with runbook viewer
├── paysecure-dr/           # DR infrastructure & automation
├── docs/                   # Architecture, runbooks, ADRs, compliance
│   ├── architecture/       # Kafka MSK replication, multi-region topology
│   ├── runbooks/           # Operational runbooks (secrets rotation, failover, etc.)
│   ├── adr/                # Architecture Decision Records
│   ├── compliance/         # Compliance & FMEA documentation
│   └── rpo-rto/            # RPO/RTO analysis
└── .oxcode-memory/         # OxCode project memory
```

## Tech Stack

- **Frontend**: React 18, Vite, Tailwind CSS, Framer Motion, Lucide React, Recharts
- **Routing**: React Router v6
- **Content**: React Markdown for runbook rendering
- **Deployment**: Vercel (both portals)

## Getting Started

```bash
# Primary portal
cd paysecure-portal
npm install
npm run dev

# DR portal
cd paysecure-dr-portal
npm install
npm run dev
```

## Key Features

- **Multi-region DR dashboard** with active-passive failover monitoring
- **Runbook viewer** with searchable operational procedures
- **FMEA (Failure Mode & Effects Analysis)** matrix
- **Compliance tracking** with control evidence mapping
- **System health indicators** with region-level status
- **Chaos engineering protocols** for payment processing resilience