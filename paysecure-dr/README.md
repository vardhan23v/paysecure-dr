# PaySecure Gateway — Multi-Region DR Architecture

**Project 1C: DevOps & Cloud Engineer — Multi-Region DR Architecture for Payment Systems**

**Version:** 1.0 | **Date:** 2026-07-20 | **Classification:** Strictly Private and Confidential

---

## Project Overview

Design and deliver a complete multi-region disaster recovery architecture for **PaySecure Gateway Private Limited**, a mid-tier payment aggregator processing **3.2 million daily transactions** worth **500 crore INR** across **45,000 merchants**.

### Current State
- Single AWS Mumbai region (ap-south-1)
- 99.92% uptime (~7 hours annual downtime)
- No cross-region DR capability

### Target State
- Multi-region active-passive across Mumbai (ap-south-1) and Hyderabad (ap-south-2)
- **99.99% uptime** (≤52.6 minutes annual downtime)
- **RPO < 1 minute** | **RTO < 5 minutes**
- Full compliance with RBI, PCI-DSS v4.0, NPCI UPI, and India data localisation

---

## Repository Structure

```
paysecure-dr/
├── README.md                                    # This file
├── docs/
│   ├── architecture-overview.md                 # High-level architecture & diagrams
│   ├── rpo-rto-justification.md                 # Detailed RPO/RTO analysis
│   ├── adr/
│   │   ├── ADR-001-topology-selection.md        # Active-passive vs active-active
│   │   ├── ADR-002-aurora-replication.md        # Aurora Global DB strategy
│   │   ├── ADR-003-msk-mirrormaker.md           # Kafka cross-region replication
│   │   └── ADR-004-route53-failover.md          # DNS failover routing policy
│   ├── runbooks/
│   │   ├── RB-01-region-failure.md              # Complete region failure
│   │   ├── RB-02-database-split-brain.md        # Aurora split-brain scenario
│   │   ├── RB-03-replication-lag.md             # Replication lag exceeding thresholds
│   │   ├── RB-04-kafka-partition-loss.md        # Kafka partition/data loss
│   │   ├── RB-05-cache-corruption.md            # ElastiCache corruption
│   │   ├── RB-06-dns-failover.md                # Route 53 failover procedures
│   │   ├── RB-07-peak-load-failover.md          # Peak traffic DR scenario
│   │   ├── RB-08-kms-key-compromise.md          # KMS key security incident
│   │   ├── RB-09-secrets-rotation.md            # Cross-region secrets rotation
│   │   ├── RB-10-eks-node-failure.md            # EKS cluster recovery
│   │   ├── RB-11-network-partition.md           # Cross-region network issues
│   │   └── RB-12-failback-procedure.md          # Return to primary region
│   ├── fmea/
│   │   └── fmea-framework.md                    # 20+ failure modes with RPN
│   ├── chaos-engineering/
│   │   └── chaos-experiments.md                 # 6 controlled chaos experiments
│   ├── compliance/
│   │   └── compliance-traceability-matrix.md    # Regulatory requirement mapping
│   ├── security/
│   │   └── attack-surface-analysis.md           # Multi-region security analysis
│   ├── dashboards/
│   │   └── dashboard-specifications.md          # 5 dashboard designs
│   └── presentation/
│       └── bc-review-board-deck.md              # Stakeholder presentation
├── iac/
│   └── terraform/                               # Infrastructure as Code (Phase 2)
└── stakeholders/
    └── personas.md                              # 5 stakeholder personas
```

---

## Phase Delivery Status

| Phase | Deliverable | Status |
|:---:|-------------|:---:|
| **1** | Architecture Foundation | ✅ Complete |
| | — ADR-001: Topology Selection | ✅ |
| | — Architecture Overview | ✅ |
| | — RPO/RTO Justification | ✅ |
| **2** | Data & Messaging Layer | ⬜ Pending |
| **3** | Operations & Runbooks | ⬜ Pending |
| **4** | Resilience & Validation | ⬜ Pending |
| **5** | Compliance & Governance | ⬜ Pending |
| **6** | Delivery & Presentation | ⬜ Pending |

---

## Key Design Decisions

| # | Decision | Rationale |
|:---:|----------|-----------|
| 1 | Active-Passive over Active-Active | Transaction integrity; single-writer eliminates conflict resolution risks |
| 2 | Hyderabad over Pune for DR | Lower latency (3-5ms); full AWS service parity |
| 3 | Aurora Global DB | Managed physical replication; <1s lag; automated failover |
| 4 | MirrorMaker 2 for Kafka | Native MSK integration; no additional licensing |
| 5 | 30% pre-warmed EKS capacity | Balances cost vs RTO; HPA scales to full within 90s |
| 6 | Route 53 DNS failover | Sufficient for 5-min RTO; simpler than Global Accelerator |

---

## Compliance Coverage

| Regulation | Coverage |
|------------|----------|
| RBI Master Direction on Payment Systems (2021) | §12.3–12.5 Business Continuity, DR drills, data residency |
| PCI-DSS v4.0 | Requirements 4.2.1, 6.4.2, 6.5.1, 10.4.1, 11.4.5 |
| NPCI UPI Technical Standards v2.0 | §4.2.1, §4.2.3, §5.1.2 |
| India Data Localisation (RBI Circular 2017-18) | All payment data stored within Indian regions |

---

## Stakeholders

| Role | Persona | Primary Concern |
|------|---------|-----------------|
| CTO | Technical leadership | Architecture soundness, scalability |
| CRO | Risk & compliance | Regulatory adherence, audit readiness |
| VP Engineering | Delivery ownership | Operational feasibility, team capacity |
| Compliance Head | Regulatory oversight | RBI, PCI-DSS, NPCI compliance |
| Merchant Relations | Business impact | Merchant experience during DR events |

---

## Cost Summary

| Region | Monthly Cost |
|--------|---:|
| Mumbai (Primary) | $43,000 |
| Hyderabad (Secondary) | $23,500 |
| **Total** | **$66,500** |
| Current single-region | $47,000 |
| **Increase** | **$19,500 (41%)** |

---

## Quick Links

- [Architecture Overview](docs/architecture-overview.md)
- [RPO/RTO Justification](docs/rpo-rto-justification.md)
- [ADR-001: Topology Selection](docs/adr/ADR-001-topology-selection.md)
- [FMEA Framework](docs/fmea/fmea-framework.md) *(pending)*
- [DR Runbooks](docs/runbooks/) *(pending)*
- [Compliance Matrix](docs/compliance/compliance-traceability-matrix.md) *(pending)*
- [BC Review Board Presentation](docs/presentation/bc-review-board-deck.md) *(pending)*