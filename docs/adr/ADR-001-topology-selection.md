# ADR-001: Topology Selection for Multi-Region Disaster Recovery

| Attribute | Value |
|-----------|-------|
| **Status** | Accepted |
| **Date** | 2026-07-20 |
| **Deciders** | Architecture Team, Security & Compliance, Platform Engineering |
| **Scope** | PaySecure DR platform — all payment processing workloads |

---

## 1. Context

PaySecure is a payment processing system operating under strict Indian regulatory requirements. The platform must guarantee business continuity in the event of a full regional failure while keeping all payment data within Indian sovereign territory.

### 1.1 Constraints

| Constraint | Target | Rationale |
|------------|--------|-----------|
| Recovery Point Objective (RPO) | < 1 minute | Minimise transaction loss during failover |
| Recovery Time Objective (RTO) | < 5 minutes | Ensure merchant-facing services resume rapidly |
| Data Residency | India only | RBI data localisation mandates |
| Regulatory Frameworks | RBI, PCI-DSS v4.0, NPCI UPI | Compliance is non-negotiable |

### 1.2 Candidate Regions

| Role | AWS Region | Region Code | Purpose |
|------|------------|-------------|---------|
| Primary | Asia Pacific (Mumbai) | `ap-south-1` | Active production traffic |
| Secondary | Asia Pacific (Hyderabad) | `ap-south-2` | Warm standby for DR failover |
| Tertiary (Evaluation) | Asia Pacific (Pune) | `ap-south-3` | Future expansion / additional resilience layer |

All three regions are evaluated against latency, AWS service availability, and network backbone diversity to ensure they are not subject to a single point of failure at the infrastructure provider level.

### 1.3 Problem Statement

We need to select a multi-region deployment topology that:
- Satisfies RPO < 1 min and RTO < 5 min.
- Keeps primary and secondary data stores synchronised across Indian regions.
- Aligns with RBI data localisation and PCI-DSS v4.0 requirements.
- Minimises operational complexity and cost while maximising reliability.

---

## 2. Decision

**We will adopt an active-passive topology with Mumbai (`ap-south-1`) as the primary region and Hyderabad (`ap-south-2`) as the passive secondary region.**

### 2.1 Active-Passive Design

- **Primary (Mumbai):** Handles 100% of live production traffic. All write operations originate here.
- **Secondary (Hyderabad):** Maintains a warm standby environment. Data is continuously replicated from Mumbai. Application stacks are pre-deployed but scaled to a minimal footprint (e.g., EKS node pools at baseline, ready to scale out).
- **Failover:** In the event of a primary region failure, traffic is redirected to Hyderabad via DNS/Route 53 health-checked failover. The secondary environment scales out to full production capacity using pre-defined auto-scaling policies.

### 2.2 Data Synchronisation

The following AWS services are configured for cross-region replication with lag monitoring:

| Service | Replication Mechanism | Lag Monitoring |
|---------|----------------------|----------------|
| Amazon Aurora PostgreSQL | Aurora Global Database | CloudWatch `AuroraGlobalDBReplicationLag` |
| Amazon DynamoDB | Global Tables | CloudWatch `ReplicationLatency` |
| Amazon ElastiCache (Redis) | Global Datastore | CloudWatch `GlobalDatastoreReplicationLag` |
| Amazon MSK (Kafka) | MirrorMaker 2 / MSK replication | Custom lag exporter + P1/P2 alerting |

Replication lag thresholds are enforced with P1 (critical) and P2 (warning) alerts to ensure the RPO < 1 min target is not breached.

### 2.3 Pune Tertiary Evaluation

`ap-south-3` (Pune) is held in evaluation status. It is not part of the active DR pair today but is reserved for:
- Future three-region active-passive-passive resilience.
- Regulatory diversification if region-specific compliance requirements emerge.
- Capacity expansion during peak transaction windows (e.g., festive seasons).

---

## 3. Consequences

### 3.1 Positive

- **RPO/RTO Compliance:** Active-passive with synchronous and near-synchronous replication enables RPO < 1 min and RTO < 5 min under normal operating conditions.
- **Cost Efficiency:** Passive region runs at reduced baseline capacity; compute scales only during failover or drills.
- **Operational Simplicity:** Single primary writer eliminates split-brain risk and simplifies conflict resolution.
- **Regulatory Alignment:** All data at rest and in transit remains within Indian AWS regions, satisfying RBI data localisation.
- **Monitoring Resilience:** The monitoring infrastructure itself is designed to fail over to the secondary region, ensuring observability is preserved during a primary region outage.

### 3.2 Negative / Trade-offs

- **Capacity Planning:** Secondary region must maintain sufficient warm capacity and scaling headroom to absorb full production load within minutes.
- **Failover Drills:** Regular DR drills are required to validate RTO; these must be carefully orchestrated to avoid impacting real transactions.
- **Replication Cost:** Cross-region data transfer and Global Database / Global Table replication incur ongoing costs.
- **Tertiary Region Latency:** Pune is currently not utilised; if promoted, additional replication topology design will be required.

### 3.3 Risks & Mitigations

| Risk | Mitigation |
|------|------------|
| Replication lag exceeds RPO during peak load | P1 alerting + auto-throttling + pre-scaled replication throughput |
| Split-brain if primary recovers during failover | Explicit primary demotion procedures in runbooks; fencing via DynamoDB conditional writes |
| Secondary region unable to scale in time | Pre-warmed EKS node pools, cached container images, and pre-provisioned MSK/ElastiCache capacity |

---

## 4. Rejected Alternatives

### 4.1 Active-Active Topology

An active-active configuration (splitting live traffic across Mumbai and Hyderabad simultaneously) was evaluated and rejected for the following reasons:

| Concern | Active-Active Impact |
|---------|---------------------|
| **Data Consistency** | Concurrent writes across regions increase risk of conflicts, requiring complex conflict-resolution logic (e.g., CRDTs or last-write-wins heuristics) that is error-prone for financial transactions. |
| **Latency Sensitivity** | Payment authorisations are latency-sensitive; cross-region write coordination introduces additional round-trip delay. |
| **Compliance Complexity** | RBI expects clear data sovereignty boundaries; active-active blurs the line of "primary" data location and complicates audit trails. |
| **Operational Burden** | Active-active requires dual-region deployment symmetry, dual runbooks, and more sophisticated chaos engineering controls. |
| **RTO Advantage Marginal** | While active-active can theoretically achieve near-zero RTO, our warm standby active-passive design already meets the < 5 min requirement with far lower complexity. |

**Decision:** The operational and compliance overhead of active-active outweighs its benefits for a payment system where RTO < 5 min is already achievable via active-passive.

### 4.2 Single-Region with Backup (Rejected Earlier)

A single-region deployment with periodic snapshots to S3 in a second region was dismissed during initial scoping because it cannot meet the RPO < 1 min requirement.

---

## 5. Compliance Alignment

| Regulation / Standard | Requirement | How This ADR Satisfies It |
|-----------------------|-------------|---------------------------|
| **RBI Data Localisation** | All payment system data must reside within India | Primary, secondary, and tertiary candidate regions are all Indian AWS regions (`ap-south-1`, `ap-south-2`, `ap-south-3`). |
| **PCI-DSS v4.0** | Requirement 9.5.1.2.1 — resilience testing; Requirement 12.10.1 — incident response readiness | DR runbooks, FMEA-driven failure mode analysis, and chaos engineering experiments validate resilience. |
| **NPCI UPI** | UPI system availability and DR guidelines | RTO < 5 min ensures UPI-linked payment services resume within acceptable windows. |

---

## 6. Related Decisions & Documents

- ADR-002: Data Store Selection (Aurora Global DB, DynamoDB Global Tables, ElastiCache Global Datastore)
- ADR-003: Replication & Lag Monitoring Strategy
- Runbooks: 12 production-ready DR runbooks (region failure, split-brain, Kafka issues, cache corruption, DNS, peak load, KMS, secrets, EKS, network, partial degradation, rollback)
- FMEA Analysis: 20+ failure modes with RPN prioritisation
- Dashboards: DR readiness, incident response, executive summary, merchant impact, cost tracking

---

## 7. Notes

- Chaos engineering experiments must be conducted with extreme care to avoid impacting real transactions. All experiments require explicit blast-radius controls and abort criteria.
- The monitoring infrastructure itself must be resilient; if Mumbai fails, monitoring must continue from Hyderabad without loss of alerting or telemetry.
- This ADR will be reviewed quarterly or after any significant regional AWS service incident.
