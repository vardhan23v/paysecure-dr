# PaySecure Gateway — Multi-Region DR Architecture Overview

**Version:** 1.0  
**Date:** 2026-07-20  
**Classification:** Strictly Private and Confidential

---

## Executive Summary

PaySecure Gateway Private Limited processes 3.2 million daily transactions worth 500 crore INR across 45,000 merchants from a single AWS Mumbai region (ap-south-1). Current uptime of 99.92% falls short of the regulatory mandate requiring 99.99% uptime with RPO < 1 minute and RTO < 5 minutes by Q3 2026.

This document presents the multi-region disaster recovery architecture that achieves these targets through an **active-passive (warm standby)** topology spanning AWS Mumbai (ap-south-1, primary) and Hyderabad (ap-south-2, secondary).

---

## Architecture Principles

1. **Data Residency First** — All payment data remains within Indian AWS regions (Mumbai, Hyderabad)
2. **Single Writer** — Only the primary region accepts writes; eliminates conflict resolution risks
3. **Automated Failover** — Route 53 health checks trigger DNS failover; EKS auto-scales secondary region
4. **Defense in Depth** — Multiple independent monitoring layers detect failures within 30 seconds
5. **Immutable Infrastructure** — All infrastructure defined as Terraform; no manual configuration
6. **Quarterly Validation** — DR drills conducted every quarter with full transaction simulation

---

## High-Level Architecture

```
                          ┌─────────────────────────────┐
                          │       Route 53 (DNS)        │
                          │  ┌───────────────────────┐  │
                          │  │  paysecure-gateway.in │  │
                          │  │  Primary: ap-south-1  │  │
                          │  │  Secondary: ap-south-2│  │
                          │  │  Failover: automatic  │  │
                          │  └───────────────────────┘  │
                          └──────────┬──────────────────┘
                                     │
                    ┌────────────────┴────────────────┐
                    │                                 │
    ┌───────────────▼──────────────┐   ┌──────────────▼──────────────┐
    │     MUMBAI (ap-south-1)      │   │   HYDERABAD (ap-south-2)    │
    │         PRIMARY              │   │       SECONDARY (DR)        │
    │                              │   │                              │
    │  ┌────────────────────────┐  │   │  ┌────────────────────────┐  │
    │  │   AWS WAF + ALB        │  │   │  │   AWS WAF + ALB        │  │
    │  └───────────┬────────────┘  │   │  └───────────┬────────────┘  │
    │              │               │   │              │               │
    │  ┌───────────▼────────────┐  │   │  ┌───────────▼────────────┐  │
    │  │   EKS Cluster          │  │   │  │   EKS Cluster (30%)    │  │
    │  │   ┌────────────────┐   │  │   │  │   ┌────────────────┐   │  │
    │  │   │ Payment API    │   │  │   │  │   │ Payment API    │   │  │
    │  │   │ Auth Service   │   │  │   │  │   │ Auth Service   │   │  │
    │  │   │ Routing Engine │   │  │   │  │   │ Routing Engine │   │  │
    │  │   │ Settlement     │   │  │   │  │   │ Settlement     │   │  │
    │  │   │ Reconciliation │   │  │   │  │   │ Reconciliation │   │  │
    │  │   └────────────────┘   │   │  │   │   └────────────────┘   │   │
    │  └───────────┬────────────┘   │   │  └───────────┬────────────┘   │
    │              │               │   │              │               │
    │  ┌───────────▼────────────┐  │   │  ┌───────────▼────────────┐  │
    │  │  Aurora PostgreSQL     │  │   │  │  Aurora PostgreSQL     │  │
    │  │  (Writer)              │──┼───┼──│  (Reader — Global DB)  │  │
    │  └────────────────────────┘  │   │  └────────────────────────┘  │
    │                              │   │                              │
    │  ┌────────────────────────┐  │   │  ┌────────────────────────┐  │
    │  │  DynamoDB Global Table │──┼───┼──│  DynamoDB Global Table │  │
    │  │  (Primary writes)      │  │   │  │  (Replica)             │  │
    │  └────────────────────────┘  │   │  └────────────────────────┘  │
    │                              │   │                              │
    │  ┌────────────────────────┐  │   │  ┌────────────────────────┐  │
    │  │  ElastiCache Redis     │──┼───┼──│  ElastiCache Redis     │  │
    │  │  (Primary)             │  │   │  │  (Replica — Global)    │  │
    │  └────────────────────────┘  │   │  └────────────────────────┘  │
    │                              │   │                              │
    │  ┌────────────────────────┐  │   │  ┌────────────────────────┐  │
    │  │  MSK (Kafka)           │──┼───┼──│  MSK (Kafka)           │  │
    │  │  (Producer)            │  │   │  │  (Consumer — MM2)      │  │
    │  └────────────────────────┘  │   │  └────────────────────────┘  │
    │                              │   │                              │
    │  ┌────────────────────────┐  │   │  ┌────────────────────────┐  │
    │  │  S3 + CRR              │──┼───┼──│  S3 + CRR              │  │
    │  └────────────────────────┘  │   │  └────────────────────────┘  │
    │                              │   │                              │
    │  ┌────────────────────────┐  │   │  ┌────────────────────────┐  │
    │  │  KMS + Secrets Manager │──┼───┼──│  KMS + Secrets Manager │  │
    │  └────────────────────────┘  │   │  └────────────────────────┘  │
    │                              │   │                              │
    │  ┌────────────────────────┐  │   │  ┌────────────────────────┐  │
    │  │  CloudWatch /          │  │   │  │  CloudWatch /          │  │
    │  │  Datadog Monitoring    │──┼───┼──│  Datadog Monitoring    │  │
    │  └────────────────────────┘  │   │  └────────────────────────┘  │
    └──────────────────────────────┘   └──────────────────────────────┘
```

---

## Component Summary

| Component | Primary (Mumbai) | Secondary (Hyderabad) | Replication |
|-----------|:---:|:---:|-------------|
| **Route 53** | Active DNS endpoint | Failover DNS endpoint | N/A (DNS-level) |
| **AWS WAF + ALB** | Active, full capacity | Warm, reduced capacity | WAF rules via IaC |
| **EKS** | Full capacity (12 nodes) | 30% capacity (4 nodes), auto-scale on failover | GitOps (ArgoCD) |
| **Aurora PostgreSQL** | Writer instance (db.r6g.4xlarge) | Reader instance (db.r6g.2xlarge) | Global DB (physical, <1s lag) |
| **DynamoDB** | Primary write region | Replica region | Global Tables (<1.5s lag) |
| **ElastiCache Redis** | Primary cluster | Global Datastore replica | Global Datastore (<1s lag) |
| **MSK (Kafka)** | Producer cluster | Consumer cluster | MirrorMaker 2 (unidirectional) |
| **S3** | Primary bucket | Replica bucket | Cross-Region Replication |
| **KMS** | Primary keys | Replica keys | Multi-region key replication |
| **Secrets Manager** | Primary secrets | Replica secrets | Cross-region replication |
| **Monitoring** | CloudWatch + Datadog | CloudWatch + Datadog | Cross-region dashboards |

---

## Network Architecture

```
┌──────────────────────────────────────────────────────────────┐
│                     AWS Global Network                       │
│                                                              │
│  ┌─────────────────────────┐    ┌─────────────────────────┐  │
│  │  ap-south-1 (Mumbai)    │    │  ap-south-2 (Hyderabad) │  │
│  │  VPC: 10.0.0.0/16       │    │  VPC: 10.1.0.0/16       │  │
│  │                         │    │                         │  │
│  │  ┌───────────────────┐  │    │  ┌───────────────────┐  │  │
│  │  │ Public Subnets    │  │    │  │ Public Subnets    │  │  │
│  │  │ 10.0.1.0/24       │  │    │  │ 10.1.1.0/24       │  │  │
│  │  │ 10.0.2.0/24       │  │    │  │ 10.1.2.0/24       │  │  │
│  │  │ [ALB, NAT GW]     │  │    │  │ [ALB, NAT GW]     │  │  │
│  │  └───────────────────┘  │    │  └───────────────────┘  │  │
│  │                         │    │                         │  │
│  │  ┌───────────────────┐  │    │  ┌───────────────────┐  │  │
│  │  │ Private Subnets   │  │    │  │ Private Subnets   │  │  │
│  │  │ 10.0.10.0/24      │  │    │  │ 10.1.10.0/24      │  │  │
│  │  │ 10.0.11.0/24      │  │    │  │ 10.1.11.0/24      │  │  │
│  │  │ [EKS Nodes]       │  │    │  │ [EKS Nodes]       │  │  │
│  │  └───────────────────┘  │    │  └───────────────────┘  │  │
│  │                         │    │                         │  │
│  │  ┌───────────────────┐  │    │  ┌───────────────────┐  │  │
│  │  │ Data Subnets      │  │    │  │ Data Subnets      │  │  │
│  │  │ 10.0.20.0/24      │  │    │  │ 10.1.20.0/24      │  │  │
│  │  │ 10.0.21.0/24      │  │    │  │ 10.1.21.0/24      │  │  │
│  │  │ [Aurora,          │  │    │  │ [Aurora,          │  │  │
│  │  │  ElastiCache,     │  │    │  │  ElastiCache,     │  │  │
│  │  │  MSK]             │  │    │  │  MSK]             │  │  │
│  │  └───────────────────┘  │    │  └───────────────────┘  │  │
│  │                         │    │                         │  │
│  │  ┌───────────────────┐  │    │  ┌───────────────────┐  │  │
│  │  │ VPC Endpoints     │  │    │  │ VPC Endpoints     │  │  │
│  │  │ (S3, DDB, KMS,    │  │    │  │ (S3, DDB, KMS,    │  │  │
│  │  │  Secrets Manager) │  │    │  │  Secrets Manager) │  │  │
│  │  └───────────────────┘  │    │  └───────────────────┘  │  │
│  └─────────────────────────┘    └─────────────────────────┘  │
│                                                              │
│  ┌─────────────────────────────────────────────────────────┐ │
│  │              VPC Peering (ap-south-1 ↔ ap-south-2)      │ │
│  │              Encrypted with dedicated TLS certs         │ │
│  └─────────────────────────────────────────────────────────┘ │
└──────────────────────────────────────────────────────────────┘
```

---

## Traffic Flow

### Normal Operations
```
Client → Route 53 → ap-south-1 ALB → EKS (Mumbai) → Aurora Writer (Mumbai)
                                                  → DynamoDB (Mumbai writes)
                                                  → ElastiCache (Mumbai)
                                                  → MSK (Mumbai producer)
                                                         │
                                              MirrorMaker 2 (async)
                                                         │
                                                         ▼
                                                  MSK (Hyderabad consumer)
```

### Failover Operations
```
Client → Route 53 → ap-south-2 ALB → EKS (Hyderabad, auto-scaled)
                                                  → Aurora (Hyderabad promoted to writer)
                                                  → DynamoDB (Hyderabad writes)
                                                  → ElastiCache (Hyderabad promoted to primary)
                                                  → MSK (Hyderabad producer)
```

---

## Key Design Decisions

| Decision | Rationale | Reference |
|----------|-----------|-----------|
| Active-Passive over Active-Active | Transaction integrity; single-writer eliminates conflict resolution | ADR-001 |
| Hyderabad over Pune for DR | Lower latency (3-5ms vs 8-12ms); full AWS service parity | ADR-001 |
| Aurora Global DB over manual replication | Managed physical replication; <1s lag; automated failover | ADR-002 |
| MirrorMaker 2 over Confluent Replicator | Native AWS MSK integration; no additional licensing | ADR-003 |
| 30% pre-warmed EKS capacity | Balances cost vs RTO; HPA scales to full within 90s | ADR-001 |
| Route 53 DNS failover over Global Accelerator | Simpler; sufficient for 5-min RTO; lower cost | ADR-004 |

---

## Cost Model

| Resource | Primary (Mumbai) | Secondary (Hyderabad) | Monthly Total |
|----------|:---:|:---:|---:|
| EKS (compute) | $12,000 | $4,000 (30%) | $16,000 |
| Aurora PostgreSQL | $8,000 | $4,000 (reader) | $12,000 |
| DynamoDB | $6,000 | $3,000 (replica) | $9,000 |
| ElastiCache | $4,000 | $2,000 (replica) | $6,000 |
| MSK | $5,000 | $3,000 (consumer) | $8,000 |
| S3 + CRR | $2,000 | $1,500 | $3,500 |
| ALB + WAF | $1,500 | $1,000 | $2,500 |
| Route 53 | $500 | — | $500 |
| KMS + Secrets Manager | $1,000 | $500 | $1,500 |
| Data Transfer (inter-region) | — | $3,000 | $3,000 |
| CloudWatch + Datadog | $3,000 | $1,500 | $4,500 |
| **Total** | **$43,000** | **$23,500** | **$66,500** |

**Current single-region spend:** ~$47,000/month  
**Multi-region DR spend:** ~$66,500/month  
**Increase:** ~$19,500/month (~41% increase)

---

## Next Steps

1. **ADR-002:** Aurora Global DB replication strategy (Phase 2)
2. **ADR-003:** MSK MirrorMaker 2 configuration (Phase 2)
3. **ADR-004:** Route 53 failover routing policy (Phase 2)
4. **Terraform IaC:** VPC, EKS, and data store provisioning (Phase 2)
5. **DR Runbooks:** 12 production-ready runbooks (Phase 3)
6. **FMEA:** 20+ failure modes with RPN scoring (Phase 4)
7. **Chaos Engineering:** 6 controlled experiments (Phase 4)
8. **Compliance Matrix:** Full regulatory mapping (Phase 5)
9. **BC Review Board:** Stakeholder presentation (Phase 6)