# DynamoDB Global Tables — Replication Strategy

| Attribute | Value |
|-----------|-------|
| **Status** | Current |
| **Date** | 2026-07-20 |
| **Owner** | Database Engineering |
| **Scope** | PaySecure session state, idempotency keys, rate-limit counters, configuration tables |

---

## 1. Overview

Amazon DynamoDB Global Tables provide fully managed, multi-region replication for PaySecure's key-value and document workloads. Although Global Tables support multi-active writes, PaySecure operates them in **active-passive mode** — all writes target Mumbai (`ap-south-1`), and Hyderabad (`ap-south-2`) serves as a read-only replica until failover.

### 1.1 Why DynamoDB Global Tables

| Criterion | Evaluation |
|-----------|------------|
| **RPO** | Sub-second item-level replication within the same AWS partition; well within the 1-minute RPO budget |
| **RTO** | Replica is always ready; no promotion step needed — application simply switches write endpoint |
| **Consistency** | Eventually consistent across regions; strongly consistent within a region |
| **Operational overhead** | Fully managed; no replication agents, no partition management |
| **Compliance** | All data resides within Indian regions (`ap-south-1` → `ap-south-2`) |

---

## 2. Table Topology

```
┌──────────────────────────────────────────────────────────────────────┐
│                     MUMBAI (ap-south-1) — PRIMARY                     │
│  ┌────────────────────────────────────────────────────────────────┐  │
│  │  DynamoDB Global Table: paysecure-sessions                     │  │
│  │  ┌──────────┐  ┌──────────┐  ┌──────────┐                     │  │
│  │  │ Partition│  │ Partition│  │ Partition│  ... (auto-scaled)  │  │
│  │  │   1-N    │  │   N+1-2N │  │  2N+1-3N │                     │  │
│  │  └────┬─────┘  └────┬─────┘  └────┬─────┘                     │  │
│  │       │              │              │                            │  │
│  │       │  Writes accepted; items replicated via DynamoDB Streams │  │
│  └───────┼──────────────┼──────────────┼────────────────────────────┘  │
└──────────┼──────────────┼──────────────┼──────────────────────────────┘
           │              │              │
           │  Encrypted cross-region replication (DynamoDB service)
           ▼              ▼              ▼
┌──────────────────────────────────────────────────────────────────────┐
│                    HYDERABAD (ap-south-2) — REPLICA                   │
│  ┌────────────────────────────────────────────────────────────────┐  │
│  │  DynamoDB Global Table: paysecure-sessions (replica)           │  │
│  │  ┌──────────┐  ┌──────────┐  ┌──────────┐                     │  │
│  │  │ Partition│  │ Partition│  │ Partition│  ... (auto-scaled)  │  │
│  │  │   1-N    │  │   N+1-2N │  │  2N+1-3N │                     │  │
│  │  └──────────┘  └──────────┘  └──────────┘                     │  │
│  │                                                                  │  │
│  │  Read-only under normal operations (active-passive mode)       │  │
│  └────────────────────────────────────────────────────────────────┘  │
└──────────────────────────────────────────────────────────────────────┘
```

### 2.1 Tables Covered

| Table Name | Purpose | Criticality | Avg Item Size | Peak Write Rate |
|------------|---------|-------------|---------------|-----------------|
| `paysecure-sessions` | User/merchant session state | P1 — authentication | ~2 KB | 5,000 writes/sec |
| `paysecure-idempotency` | Payment idempotency keys (24h TTL) | P0 — revenue integrity | ~1 KB | 3,200 writes/sec |
| `paysecure-rate-limits` | Per-merchant rate-limit counters (1min TTL) | P1 — platform protection | ~500 B | 10,000 writes/sec |
| `paysecure-config` | Feature flags, runtime configuration | P1 — operational | ~5 KB | 50 writes/sec |
| `paysecure-locks` | Distributed locks for scheduled jobs | P2 — operational | ~200 B | 100 writes/sec |

### 2.2 Table Configuration

| Parameter | Value |
|-----------|-------|
| **Billing mode** | On-demand (pay-per-request) for variable workloads; provisioned for stable high-throughput tables |
| **Global Table version** | 2019.11.21 (current) |
| **Replica regions** | `ap-south-1` (Mumbai), `ap-south-2` (Hyderabad) |
| **Stream enabled** | Yes (NEW_AND_OLD_IMAGES) — required for Global Tables |
| **TTL** | Enabled on `paysecure-sessions` (1 hour), `paysecure-idempotency` (24 hours), `paysecure-rate-limits` (1 minute) |
| **Point-in-Time Recovery (PITR)** | Enabled on all tables |
| **Deletion protection** | Enabled on all tables |
| **Encryption** | AWS-owned KMS key (default); KMS-encrypted at rest |

---

## 3. Replication Mechanism

### 3.1 Item-Level Replication via DynamoDB Streams

DynamoDB Global Tables use **DynamoDB Streams** to replicate item-level changes across regions. When an item is written in Mumbai, the stream captures the change and the DynamoDB service replicates it to the Hyderabad replica table.

| Property | Detail |
|----------|--------|
| **Replication type** | Item-level, asynchronous |
| **Replication unit** | Individual item mutations (Put, Update, Delete) |
| **Replication path** | DynamoDB service (AWS-managed); no customer-managed infrastructure |
| **Encryption** | TLS 1.3 in transit; KMS-encrypted at rest in both regions |
| **Conflict resolution** | Last-writer-wins (LWW) based on item timestamp |
| **Typical observed lag** | < 500 ms within Indian regions under normal load |

### 3.2 Active-Passive Write Discipline

Although Global Tables natively support multi-active writes, PaySecure enforces **single-primary writes** to avoid LWW conflicts that could corrupt idempotency keys or rate-limit counters:

| Rule | Enforcement |
|------|-------------|
| All application writes target Mumbai endpoint | Application configuration; IAM policy denies `dynamodb:PutItem` / `dynamodb:UpdateItem` / `dynamodb:DeleteItem` to Hyderabad endpoint during normal operations |
| Hyderabad serves reads only (if needed for DR drills) | Application read replicas can target Hyderabad for validation |
| During failover, write endpoint switches to Hyderabad | IAM policy updated; application config updated |

### 3.3 Replication Flow

```
Application Write
       │
       ▼
┌─────────────────┐
│  Mumbai Table   │─── Write acknowledged to client
│  (ap-south-1)   │
└────────┬────────┘
         │
         │ DynamoDB Stream (NEW_AND_OLD_IMAGES)
         │
         ▼
┌─────────────────┐
│  Replication    │─── AWS-managed; no customer action
│  Service        │
└────────┬────────┘
         │
         │ Cross-region (encrypted)
         │
         ▼
┌─────────────────┐
│ Hyderabad Table │─── Item applied; eventually consistent
│  (ap-south-2)   │
└─────────────────┘
```

---

## 4. Lag Monitoring

### 4.1 Primary Metric

| Metric | Source | Description |
|--------|--------|-------------|
| `ReplicationLatency` | CloudWatch (DynamoDB) | Replication latency in milliseconds for the Global Table replica |

### 4.2 Alerting Thresholds

| Severity | Threshold | Evaluation Window | Action |
|----------|-----------|-------------------|--------|
| **P2 — Warning** | `ReplicationLatency` > 10 seconds for 2 consecutive data points (60s period) | 2 minutes | Notify DB on-call via Slack; create Jira ticket |
| **P1 — Critical** | `ReplicationLatency` > 30 seconds for 2 consecutive data points (60s period) | 2 minutes | Page DB on-call via PagerDuty; trigger incident response |
| **P0 — Emergency** | `ReplicationLatency` > 60 seconds for 1 data point | 1 minute | Page Incident Commander; evaluate pre-failover readiness |

### 4.3 Supplementary Metrics

| Metric | Purpose | Threshold |
|--------|---------|-----------|
| `ConsumedWriteCapacityUnits` | Write throughput utilisation | > 80% of provisioned (if provisioned mode) |
| `ConsumedReadCapacityUnits` | Read throughput utilisation | > 80% of provisioned |
| `ThrottledRequests` | Request throttling | Any throttles > 0 for 2 consecutive minutes |
| `SystemErrors` | Internal DynamoDB errors | Any errors > 0 for 1 minute |
| `UserErrors` | Client-side errors (4xx) | Spike > 2x baseline |
| `TimeToLiveDeletedItemCount` | TTL deletion rate | Anomaly detection (sudden drop may indicate TTL misconfiguration) |

### 4.4 Per-Table Lag Monitoring

Each Global Table emits its own `ReplicationLatency` metric. Alarms are configured per table, with the most critical tables (`paysecure-idempotency`, `paysecure-sessions`) having the tightest thresholds.

### 4.5 Lag Dashboard Panel

The **DR Readiness Dashboard** (30-second refresh) displays:

- Real-time `ReplicationLatency` gauge per table (green < 5s, amber 5–30s, red > 30s).
- 24-hour lag trend line per table with peak annotations.
- Write/read throughput utilisation per table.
- Throttled request count (should always be zero).

---

## 5. Failover Procedure

### 5.1 Planned Failover (DR Drill / Maintenance)

**Preconditions:**
- `ReplicationLatency` < 5 seconds on all tables for at least 5 minutes.
- All Hyderabad tables are healthy.
- Change window approved; stakeholders notified.

**Procedure:**

| Step | Action | Owner | Expected Duration |
|------|--------|-------|-------------------|
| 1 | Notify stakeholders; announce change window | Incident Commander | 5 min (pre-work) |
| 2 | Stop application writes to Mumbai DynamoDB (drain) | SRE / App Team | 15 seconds |
| 3 | Verify `ReplicationLatency` = 0 on all tables | DB Engineer | 15 seconds |
| 4 | Update application configuration to target Hyderabad endpoint for writes | App Team | 30 seconds |
| 5 | Update IAM policy to allow writes to Hyderabad | Security / SRE | 15 seconds |
| 6 | Validate application health and item writes in Hyderabad | SRE | 60 seconds |
| 7 | Announce failover complete | Incident Commander | — |

**Total planned failover time:** ~2–3 minutes.

### 5.2 Unplanned Failover (Region Failure)

**Trigger:** Mumbai region becomes unavailable.

| Step | Action | Owner | Expected Duration |
|------|--------|-------|-------------------|
| 1 | Confirm Mumbai region failure (multiple signal loss) | Incident Commander | 30 seconds |
| 2 | Declare DR event; activate Incident Response Dashboard | Incident Commander | 15 seconds |
| 3 | Update application configuration to target Hyderabad endpoint | App Team / SRE | 30 seconds |
| 4 | Update IAM policy to allow writes to Hyderabad | Security / SRE | 15 seconds |
| 5 | Verify Hyderabad tables are accepting writes | SRE | 15 seconds |
| 6 | Validate transaction processing (idempotency keys working) | SRE | 60 seconds |
| 7 | Notify merchants and stakeholders | Incident Commander | — |

**Total unplanned failover time (DynamoDB portion):** ~2–3 minutes.

> **Note:** DynamoDB Global Tables require no "promotion" step. The Hyderabad replica is always ready to accept writes. The failover is purely an application-configuration and IAM-policy change.

### 5.3 Failover Decision Matrix

| Scenario | Action | Automation |
|----------|--------|-------------|
| Mumbai healthy, lag < 5s | No action | — |
| Mumbai healthy, lag 5–30s | Investigate; do not fail over | Manual decision |
| Mumbai healthy, lag > 30s | P1 incident; prepare for failover | Manual decision |
| Mumbai unhealthy, lag unknown | Fail over to Hyderabad | Manual with runbook |
| Mumbai unhealthy, Hyderabad also unhealthy | Escalate to AWS; DynamoDB is a regional service — if both regions fail, this is an AWS-wide incident | Manual |

---

## 6. Failback Procedure

After Mumbai region is restored and validated:

| Step | Action | Owner | Expected Duration |
|------|--------|-------|-------------------|
| 1 | Validate Mumbai table health (all tables accessible) | DB Engineer | 2 minutes |
| 2 | Verify Mumbai tables have caught up (replication from Hyderabad back to Mumbai) | DB Engineer | 5 minutes |
| 3 | Verify `ReplicationLatency` stabilises < 5 seconds | DB Engineer | 5 minutes |
| 4 | Switch application writes back to Mumbai endpoint | App Team | 30 seconds |
| 5 | Update IAM policy to deny writes to Hyderabad (restore active-passive) | Security / SRE | 15 seconds |
| 6 | Validate transaction processing in Mumbai | SRE | 2 minutes |
| 7 | Announce failback complete | Incident Commander | — |

**Total failback time:** ~15 minutes.

> **Note:** During the period when Hyderabad is the active writer, DynamoDB Global Tables replicate writes back to Mumbai automatically. No manual re-sync is needed. The failback is primarily an application-configuration change.

---

## 7. Operational Considerations

### 7.1 Conflict Resolution Strategy

| Scenario | Risk | Mitigation |
|----------|------|------------|
| **Split-brain writes** (both regions accept writes simultaneously) | LWW can cause data loss for concurrent updates to the same item | IAM policy enforces single-region writes; application uses conditional writes (`ConditionExpression`) for idempotency keys |
| **Stale reads** (reading from Hyderabad before replication completes) | Application sees outdated data | Application uses `ConsistentRead=true` for critical reads; Hyderabad reads only used for DR validation, not production traffic |
| **TTL inconsistency** (TTL expiry in one region before replication) | Item deleted in Mumbai but still present in Hyderabad | TTL deletions are replicated; eventual consistency means Hyderabad may briefly retain expired items (acceptable — TTL is best-effort) |

### 7.2 Capacity Management

| Table | Billing Mode | Provisioned WCU (if applicable) | Provisioned RCU (if applicable) |
|-------|-------------|-------------------------------|-------------------------------|
| `paysecure-sessions` | On-demand | — | — |
| `paysecure-idempotency` | Provisioned | 5,000 | 2,000 |
| `paysecure-rate-limits` | Provisioned | 12,000 | 1,000 |
| `paysecure-config` | On-demand | — | — |
| `paysecure-locks` | On-demand | — | — |

- **Auto-scaling**: Enabled on provisioned tables; target utilisation 70%.
- **Burst capacity**: On-demand tables handle spikes automatically; provisioned tables have burst capacity for 15 minutes.

### 7.3 Backup & Restore

| Backup Type | Frequency | Retention | Region |
|-------------|-----------|-----------|--------|
| Point-in-Time Recovery (PITR) | Continuous (1-second granularity) | 35 days | Mumbai |
| On-demand backups | Weekly | 90 days | Mumbai |
| Cross-region backup copy | Weekly | 90 days | Hyderabad (independent copy) |

### 7.4 Cost Optimisation

- **On-demand vs. provisioned**: High-throughput, predictable tables (`paysecure-idempotency`, `paysecure-rate-limits`) use provisioned capacity with Reserved Capacity for cost savings. Variable-workload tables use on-demand.
- **TTL**: Aggressive TTL on `paysecure-sessions` (1 hour), `paysecure-rate-limits` (1 minute), and `paysecure-idempotency` (24 hours) minimises storage costs.
- **Hyderabad replica**: Incurs write capacity costs for replication but no additional read capacity costs under normal operations (reads not served from Hyderabad).

---

## 8. Compliance Mapping

| Regulation | Requirement | Satisfaction |
|------------|-------------|--------------|
| **RBI Data Localisation** | Payment data must reside in India | All DynamoDB tables in `ap-south-1` and `ap-south-2`; replication traffic stays within Indian AWS regions |
| **PCI-DSS v4.0 — Req 3** | Encrypt cardholder data at rest | KMS-encrypted at rest in both regions |
| **PCI-DSS v4.0 — Req 4** | Encrypt data in transit | TLS 1.3 for all DynamoDB API calls and cross-region replication |
| **PCI-DSS v4.0 — Req 9.5.1.2.1** | Resilience testing | DR drills validate failover/failback procedures quarterly |
| **PCI-DSS v4.0 — Req 10** | Audit logging | CloudTrail enabled for all DynamoDB API calls in both regions |
| **PCI-DSS v4.0 — Req 12.10.1** | Incident response readiness | Runbook RUN-001 (Region Failure) and RUN-011 (Partial Degradation) cover DynamoDB scenarios |
| **NPCI UPI** | System availability | RTO < 5 min ensures UPI-linked services resume within acceptable window |

---

## 9. Failure Modes & Mitigations

| Failure Mode | RPN (1–1000) | Detection | Mitigation |
|--------------|--------------|-----------|------------|
| Replication lag exceeds RPO | 640 | `ReplicationLatency` P1 alarm | Scale write capacity; investigate stream backlog; prepare failover |
| Write throttling in Mumbai | 560 | `ThrottledRequests` alarm | Auto-scaling; switch to on-demand if provisioned capacity exhausted |
| Split-brain writes (dual-writer) | 810 | `ReplicationLatency` anomaly; item version mismatch | IAM policy enforcement; conditional writes; runbook RUN-002 |
| Accidental table deletion | 720 | `UserErrors` spike; application alert | Deletion protection enabled; PITR restore |
| TTL misconfiguration (items not expiring) | 360 | `TimeToLiveDeletedItemCount` drop | TTL validation in CI/CD pipeline; periodic audit |
| KMS key unavailable in Hyderabad | 480 | Decryption errors on replica | Multi-Region KMS key ensures key material is available |
| Hot partition (uneven key distribution) | 540 | `ThrottledRequests` on specific partition; `ConsumedWriteCapacityUnits` imbalance | Adaptive capacity; key redesign if persistent |

---

## 10. Related Documents

- [Architecture Overview](architecture-overview.md)
- [Aurora PostgreSQL Replication Strategy](database-replication-aurora.md)
- [ElastiCache Redis Replication Strategy](database-replication-elasticache.md)
- [ADR-001: Topology Selection](../adr/ADR-001-topology-selection.md)
- [RPO/RTO Justification](../rpo-rto/rpo-rto-justification.md)
- Runbook RUN-001: Region Failure
- Runbook RUN-002: Database Split-Brain
- Runbook RUN-011: Partial Degradation

---

## 11. Change Log

| Date | Version | Author | Change |
|------|---------|--------|--------|
| 2026-07-20 | 1.0 | Architecture Team | Initial version |