# ADR-001: Multi-Region Topology Selection

**Status:** Accepted  
**Date:** 2026-07-20  
**Author:** Platform Engineering, PaySecure Gateway  
**Stakeholders:** VP Engineering, CTO, CRO, Compliance Head, Merchant Relations

---

## Context

PaySecure Gateway Private Limited currently operates on a single AWS Mumbai region (ap-south-1) processing 3.2 million daily transactions worth 500 crore INR across 45,000 merchants. Current uptime is 99.92% (~7 hours of annual downtime). Regulatory mandate requires:

- **99.99% uptime** (≤52.6 minutes annual downtime)
- **RPO < 1 minute** (maximum acceptable data loss)
- **RTO < 5 minutes** (maximum acceptable recovery time)
- **Target compliance date:** Q3 2026

The architecture must span AWS Indian regions (Mumbai ap-south-1, Hyderabad ap-south-2, and optionally Pune me-central-1) to satisfy RBI data localisation requirements and NPCI UPI Technical Standards.

---

## Decision Drivers

1. **RPO < 1 minute** — near-real-time data replication across regions
2. **RTO < 5 minutes** — automated failover with minimal human intervention
3. **Data residency** — all transaction data must remain within Indian regions
4. **Cost efficiency** — DR infrastructure should not double operational costs
5. **Operational complexity** — team of ~12 platform engineers must operate the system
6. **Transaction integrity** — no duplicate processing or lost transactions during failover
7. **PCI-DSS v4.0 compliance** — encryption, access controls, audit trails across regions
8. **RBI Master Direction on Payment Systems** — business continuity and DR requirements

---

## Options Considered

### Option A: Active-Active (Multi-Master)

Both regions serve live traffic simultaneously. Each region is fully autonomous for reads and writes.

**Architecture:**
- Route 53 latency-based routing distributes traffic across Mumbai and Hyderabad
- Aurora Global DB with write-forwarding enabled (or application-level write routing)
- DynamoDB Global Tables with multi-master writes
- ElastiCache Global Datastore with active-active Redis
- MSK with bidirectional replication via MirrorMaker 2
- EKS clusters in both regions running identical workloads

**Advantages:**
- Zero-downtime failover (traffic already flowing to both regions)
- Better latency for users geographically closer to Hyderabad
- Higher overall throughput capacity
- No "cold" infrastructure wasting money

**Disadvantages:**
- **Conflict resolution complexity** — DynamoDB "last writer wins" can cause idempotency key collisions; Aurora write-forwarding adds latency and has edge cases
- **Data consistency challenges** — eventual consistency model may violate payment processing atomicity requirements
- **Cost** — both regions run at full capacity continuously (~2x current spend)
- **Operational complexity** — debugging cross-region consistency issues is significantly harder
- **PCI-DSS audit scope** — both regions are in full audit scope simultaneously
- **Kafka offset management** — bidirectional replication creates potential for message loops
- **Testing burden** — every code change must be validated for active-active correctness

### Option B: Active-Passive (Warm Standby)

Primary region (Mumbai) serves all traffic. Secondary region (Hyderabad) maintains synchronized data stores and scaled-down compute, ready to assume full traffic within RTO.

**Architecture:**
- Route 53 DNS failover routing (primary: Mumbai, secondary: Hyderabad)
- Aurora Global DB with primary writer in Mumbai, reader in Hyderabad
- DynamoDB Global Tables (multi-master under the hood, but application writes only to Mumbai)
- ElastiCache Global Datastore with primary in Mumbai, read replica in Hyderabad
- MSK with unidirectional replication Mumbai → Hyderabad via MirrorMaker 2
- EKS in Hyderabad running at reduced capacity (25-30% of primary), auto-scaled on failover

**Advantages:**
- **Strong consistency** — single writer region eliminates conflict resolution
- **Simpler operations** — clear primary/secondary roles reduce debugging complexity
- **Cost efficient** — secondary compute runs at reduced capacity (~1.3-1.5x current spend vs. 2x)
- **Predictable failover** — deterministic behaviour, easier to test and certify
- **PCI-DSS scope** — secondary region has reduced audit scope during normal operations
- **Kafka simplicity** — unidirectional replication, no message loops

**Disadvantages:**
- Failover is not instantaneous (though achievable within RTO)
- Secondary region compute is "wasted" during normal operations (mitigated by reduced capacity)
- Failback requires careful orchestration (reverse replication, data catch-up)
- Latency not improved for users closer to Hyderabad during normal operations

### Option C: Active-Passive (Pilot Light)

Minimal secondary region: only data replication runs continuously. Compute (EKS, EC2) is provisioned on-demand during failover.

**Advantages:**
- Lowest cost (~1.1-1.2x current spend)
- Simplest to reason about

**Disadvantages:**
- **RTO cannot be met** — provisioning EKS clusters, scaling pods, warming caches takes 15-30+ minutes
- Cold caches cause performance degradation post-failover
- Higher risk of provisioning failures during an actual disaster

---

## Decision

**Selected: Option B — Active-Passive (Warm Standby)**

### Rationale

| Criterion | Active-Active | Active-Passive (Warm) | Pilot Light |
|-----------|:---:|:---:|:---:|
| Meets RPO < 1 min | ✅ | ✅ | ✅ |
| Meets RTO < 5 min | ✅ | ✅ | ❌ |
| Data consistency | ⚠️ | ✅ | ✅ |
| Cost efficiency | ❌ | ✅ | ✅ |
| Operational simplicity | ❌ | ✅ | ✅ |
| PCI-DSS scope | ⚠️ | ✅ | ✅ |
| Transaction integrity | ⚠️ | ✅ | ✅ |

Active-passive with warm standby is the only topology that satisfies all mandatory requirements (RPO, RTO, data residency, transaction integrity) while maintaining acceptable cost and operational complexity.

The active-active topology introduces conflict resolution risks that are unacceptable for a payment processing system where duplicate or lost transactions have direct financial and regulatory consequences. The cost of running two fully-active regions (~2x) is also difficult to justify when the secondary region's primary purpose is disaster recovery, not latency optimization.

---

## RPO/RTO Analysis

### RPO Target: < 1 minute

| Component | Replication Method | Expected Lag | RPO Achieved |
|-----------|-------------------|--------------|:---:|
| Aurora PostgreSQL | Global DB (physical replication) | < 1 second (typical), < 5 seconds (p99) | ✅ |
| DynamoDB | Global Tables (multi-region replication) | < 1.5 seconds (typical) | ✅ |
| ElastiCache Redis | Global Datastore (async replication) | < 1 second | ✅ |
| Apache Kafka (MSK) | MirrorMaker 2 (async) | < 5 seconds (typical) | ✅ |
| S3 (idempotency store) | Cross-region replication (CRR) | < 1 second | ✅ |
| Secrets Manager | Multi-region replication | < 1 minute | ✅ |

**Aggregate RPO: < 1 minute** — all stateful components replicate within well under 60 seconds. The limiting factor is Secrets Manager cross-region replication, which is acceptable since secrets changes are infrequent and do not affect transaction data.

### RTO Target: < 5 minutes

| Phase | Action | Duration | Cumulative |
|-------|--------|----------|:---:|
| 1. Detection | CloudWatch alarm triggers on primary region health check failure | 30 seconds | 0:30 |
| 2. Decision | Automated runbook initiates failover (or on-call confirms within 60s) | 30 seconds | 1:00 |
| 3. DNS cutover | Route 53 failover record updated (TTL 60s; cached resolvers may add delay) | 60 seconds | 2:00 |
| 4. Compute scale | EKS HPA scales Hyderabad pods to full capacity (pre-warmed at 30%) | 90 seconds | 3:30 |
| 5. Cache warm | ElastiCache replica promoted to primary; application cache rebuild | 30 seconds | 4:00 |
| 6. Verification | Synthetic transactions validate Hyderabad region is processing | 30 seconds | 4:30 |

**Aggregate RTO: 4 minutes 30 seconds** — within the 5-minute target with 30 seconds of buffer.

---

## Regional Selection

| Region | AWS Name | Role | Rationale |
|--------|----------|------|-----------|
| Mumbai | ap-south-1 | **Primary** | Existing infrastructure; largest AWS India region; lowest latency for current merchant base |
| Hyderabad | ap-south-2 | **Secondary (DR)** | ~300km from Mumbai; sub-5ms inter-region latency; launched 2022 with full service parity |
| Pune | me-central-1 | **Tertiary (future)** | Additional geographic diversity; evaluated for Phase 2 expansion |

Inter-region latency between Mumbai and Hyderabad is consistently 3-5ms, well within the tolerance for synchronous Aurora replication and async Kafka mirroring.

---

## Consequences

### Positive
- Clear primary/secondary roles simplify runbook authoring and incident response
- Single-writer model eliminates transaction integrity risks
- Cost model is predictable: ~1.4x current infrastructure spend
- PCI-DSS audit scope is contained during normal operations
- Failover testing is deterministic and repeatable

### Negative
- Secondary compute resources are underutilized during normal operations (~30% capacity)
- Failback requires planned reverse replication and is not instantaneous
- Users in Hyderabad-adjacent regions do not benefit from lower latency during normal operations
- Team must maintain discipline to avoid writing to secondary region data stores

### Mitigations
- Run non-critical workloads (reporting, analytics, batch processing) on secondary EKS to utilize spare capacity
- Document and automate failback procedure (Runbook #12)
- Implement write-guard middleware that rejects writes to secondary region during normal operations
- Conduct quarterly failover drills to maintain operational readiness

---

## Compliance Mapping

| Requirement | Source | How Addressed |
|-------------|--------|---------------|
| Business continuity plan with defined RPO/RTO | RBI Master Direction on Payment Systems §12.3 | This ADR defines RPO < 1 min, RTO < 5 min with component-level analysis |
| DR drill at least quarterly | RBI Master Direction on Payment Systems §12.4 | Quarterly failover drills committed in consequences section |
| Data localisation — payment data in India | RBI Circular DPSS.CO.OD.No.278/04.02.005/2017-18 | Both regions are within India (Mumbai, Hyderabad) |
| Multi-region availability for critical systems | PCI-DSS v4.0 Requirement 6.4.2 | Active-passive topology with warm standby across two AWS India regions |
| Encrypted data in transit across regions | PCI-DSS v4.0 Requirement 4.2.1 | All cross-region replication encrypted with TLS 1.2+ |
| Change management for DR configuration | PCI-DSS v4.0 Requirement 6.5.1 | ADR process documents topology decisions; IaC ensures reproducible configuration |

---

## References

- [RBI Master Direction on Payment Systems, 2021](https://rbi.org.in/Scripts/BS_ViewMasDirections.aspx?id=12065)
- [PCI-DSS v4.0](https://www.pcisecuritystandards.org/document_library/)
- [NPCI UPI Technical Standards v2.0](https://www.npci.org.in/)
- [AWS Aurora Global DB Documentation](https://docs.aws.amazon.com/AmazonRDS/latest/AuroraUserGuide/aurora-global-database.html)
- [AWS DynamoDB Global Tables](https://docs.aws.amazon.com/amazondynamodb/latest/developerguide/GlobalTables.html)
- [AWS Well-Architected Framework — Disaster Recovery](https://docs.aws.amazon.com/wellarchitected/latest/reliability-pillar/disaster-recovery-options.html)