# Aurora PostgreSQL Global DB — Replication Strategy

| Attribute | Value |
|-----------|-------|
| **Status** | Current |
| **Date** | 2026-07-20 |
| **Owner** | Database Engineering |
| **Scope** | PaySecure transaction ledger, settlement records, merchant onboarding data |

---

## 1. Overview

Amazon Aurora Global Database provides physical storage-layer replication of the PaySecure primary Aurora PostgreSQL cluster in Mumbai (`ap-south-1`) to a secondary cluster in Hyderabad (`ap-south-2`). This is the backbone of the RPO < 1 minute target for structured relational data.

### 1.1 Why Aurora Global DB

| Criterion | Evaluation |
|-----------|------------|
| **RPO** | Near-synchronous physical replication; typical lag < 500 ms, well within the 1-minute RPO budget |
| **RTO** | Managed cross-region failover; secondary promotion completes in < 2 minutes |
| **Consistency** | Single-writer model eliminates split-brain risk |
| **Operational overhead** | Fully managed by AWS; no application-level replication logic |
| **Compliance** | All data resides within Indian regions (`ap-south-1` → `ap-south-2`) |

---

## 2. Cluster Topology

```
┌──────────────────────────────────────────────────────────────────────┐
│                     MUMBAI (ap-south-1) — PRIMARY                     │
│  ┌────────────────────────────────────────────────────────────────┐  │
│  │  Aurora Global DB Cluster: paysecure-primary                   │  │
│  │  ┌──────────┐  ┌──────────┐  ┌──────────┐                     │  │
│  │  │ Writer   │  │ Reader 1 │  │ Reader 2 │                     │  │
│  │  │ (az-1)   │  │ (az-2)   │  │ (az-3)   │                     │  │
│  │  └────┬─────┘  └──────────┘  └──────────┘                     │  │
│  │       │                                                         │  │
│  │       │  Storage volume (6 copies across 3 AZs)                │  │
│  │       │  WAL stream → physical replication                     │  │
│  └───────┼────────────────────────────────────────────────────────┘  │
└──────────┼──────────────────────────────────────────────────────────┘
           │
           │  Encrypted cross-region replication
           │  (VPC Peering + TLS)
           ▼
┌──────────────────────────────────────────────────────────────────────┐
│                    HYDERABAD (ap-south-2) — SECONDARY                 │
│  ┌────────────────────────────────────────────────────────────────┐  │
│  │  Aurora Global DB Cluster: paysecure-secondary                 │  │
│  │  ┌──────────┐  ┌──────────┐                                    │  │
│  │  │ Reader 1 │  │ Reader 2 │   (Baseline: 2 instances)          │  │
│  │  │ (az-1)   │  │ (az-2)   │                                    │  │
│  │  └──────────┘  └──────────┘                                    │  │
│  │                                                                  │  │
│  │  Storage volume (6 copies across 2 AZs)                        │  │
│  │  Receives WAL stream; applies continuously                     │  │
│  └────────────────────────────────────────────────────────────────┘  │
└──────────────────────────────────────────────────────────────────────┘
```

### 2.1 Instance Configuration

| Parameter | Mumbai (Primary) | Hyderabad (Secondary) |
|-----------|------------------|----------------------|
| **Instance class** | `db.r6g.4xlarge` | `db.r6g.2xlarge` (baseline) |
| **Instance count** | 3 (1 writer + 2 readers) | 2 (readers only) |
| **Storage type** | Aurora I/O-Optimized | Aurora I/O-Optimized |
| **Storage size** | Auto-scaling (max 64 TiB) | Auto-scaling (max 64 TiB) |
| **Engine version** | Aurora PostgreSQL 16.x | Aurora PostgreSQL 16.x |
| **Multi-AZ** | Yes (3 AZs) | Yes (2 AZs) |
| **Backup retention** | 35 days | 35 days |
| **Backtrack** | Enabled (72 hours) | Enabled (72 hours) |
| **Deletion protection** | Enabled | Enabled |

### 2.2 Database Schemas Covered

| Schema | Tables | Criticality | RPO Sensitivity |
|--------|--------|-------------|-----------------|
| `txn` | `transactions`, `settlements`, `refunds`, `chargebacks` | P0 — revenue-impacting | < 1 second |
| `merchant` | `merchants`, `merchant_config`, `merchant_kyc` | P1 — onboarding | < 5 seconds |
| `recon` | `reconciliation_batches`, `recon_entries` | P1 — financial accuracy | < 10 seconds |
| `audit` | `audit_log`, `access_log` | P2 — compliance | < 30 seconds |
| `config` | `system_config`, `feature_flags`, `rate_limits` | P1 — operational | < 5 seconds |

---

## 3. Replication Mechanism

### 3.1 Physical Replication (Storage Layer)

Aurora Global DB replicates at the **storage layer**, not the SQL layer. The primary cluster's write-ahead log (WAL) is streamed to the secondary cluster's storage volume, where it is applied continuously.

| Property | Detail |
|----------|--------|
| **Replication type** | Physical (block-level), storage-layer |
| **Replication unit** | Write-ahead log (WAL) segments |
| **Replication path** | Mumbai storage nodes → Hyderabad storage nodes (AWS backbone) |
| **Encryption** | TLS 1.3; KMS-encrypted at rest in both regions |
| **Latency contribution** | Cross-region network latency (~10–15 ms `ap-south-1` → `ap-south-2`) + WAL apply time |
| **Typical observed lag** | < 500 ms under normal load; < 2 seconds under peak load (3.2M daily transactions) |

### 3.2 Replication Topology

- **Single-writer, multi-reader**: Mumbai hosts the sole writer instance. All application writes target Mumbai.
- **Secondary is read-only**: Hyderabad instances serve no production reads under normal operations (active-passive). Read replicas in Hyderabad exist solely for failover readiness and DR drill validation.
- **No circular replication**: Replication is strictly unidirectional (Mumbai → Hyderabad). Failback requires re-establishing the Global DB topology.

### 3.3 Write Forwarding

Write forwarding is **disabled** in the active-passive topology. All writes must originate in Mumbai. During failover, the Hyderabad cluster is promoted to standalone primary and begins accepting writes directly.

---

## 4. Lag Monitoring

### 4.1 Primary Metric

| Metric | Source | Description |
|--------|--------|-------------|
| `AuroraGlobalDBReplicationLag` | CloudWatch (Aurora) | Replication lag in milliseconds between the primary and secondary cluster |

### 4.2 Alerting Thresholds

| Severity | Threshold | Evaluation Window | Action |
|----------|-----------|-------------------|--------|
| **P2 — Warning** | Lag > 10 seconds for 2 consecutive data points (60s period) | 2 minutes | Notify DB on-call via Slack; create Jira ticket |
| **P1 — Critical** | Lag > 30 seconds for 2 consecutive data points (60s period) | 2 minutes | Page DB on-call via PagerDuty; trigger incident response |
| **P0 — Emergency** | Lag > 60 seconds for 1 data point | 1 minute | Page Incident Commander; evaluate pre-failover readiness |

### 4.3 Supplementary Metrics

| Metric | Purpose | Threshold |
|--------|---------|-----------|
| `DatabaseConnections` | Connection pool saturation | > 80% of `max_connections` |
| `WriteLatency` | Writer instance write latency | > 50 ms (P2), > 100 ms (P1) |
| `ReadLatency` | Reader instance read latency | > 20 ms (P2), > 50 ms (P1) |
| `CPUUtilization` | Instance CPU pressure | > 80% (P2), > 90% (P1) |
| `FreeLocalStorage` | Storage headroom | < 20% (P2), < 10% (P1) |
| `VolumeBytesUsed` | Storage growth rate | > 500 GB/day anomaly |
| `ReplicationSlotDiskUsage` | WAL retention pressure | > 50 GB (P2), > 100 GB (P1) |

### 4.4 Lag Dashboard Panel

The **DR Readiness Dashboard** (30-second refresh) displays:

- Real-time `AuroraGlobalDBReplicationLag` gauge (green < 5s, amber 5–30s, red > 30s).
- 24-hour lag trend line with peak annotations.
- Per-schema lag breakdown (if available via custom metrics).
- Secondary cluster health status (instance count, CPU, connections).

---

## 5. Failover Procedure

### 5.1 Planned Failover (DR Drill / Maintenance)

**Preconditions:**
- Replication lag < 5 seconds for at least 5 minutes.
- All Hyderabad instances are healthy.
- Change window approved; stakeholders notified.

**Procedure:**

| Step | Action | Owner | Expected Duration |
|------|--------|-------|-------------------|
| 1 | Notify stakeholders; announce change window | Incident Commander | 5 min (pre-work) |
| 2 | Stop application writes in Mumbai (drain connections) | SRE / App Team | 30 seconds |
| 3 | Verify replication lag = 0 | DB Engineer | 15 seconds |
| 4 | Execute `aws rds promote-global-cluster` on Hyderabad | DB Engineer | 30 seconds |
| 5 | Wait for secondary promotion to complete | DB Engineer | 60–120 seconds |
| 6 | Update application connection strings to Hyderabad writer endpoint | App Team | 30 seconds |
| 7 | Validate application health and transaction processing | SRE | 60 seconds |
| 8 | Announce failover complete | Incident Commander | — |

**Total planned failover time:** ~4–5 minutes.

### 5.2 Unplanned Failover (Region Failure)

**Trigger:** Mumbai region becomes unavailable (detected via Route 53 health checks + CloudWatch alarm absence).

| Step | Action | Owner | Expected Duration |
|------|--------|-------|-------------------|
| 1 | Confirm Mumbai region failure (multiple signal loss) | Incident Commander | 30 seconds |
| 2 | Declare DR event; activate Incident Response Dashboard | Incident Commander | 15 seconds |
| 3 | Execute `aws rds promote-global-cluster --global-cluster-identifier paysecure-global` | DB Engineer | 30 seconds |
| 4 | Wait for promotion (managed failover) | DB Engineer | 60–120 seconds |
| 5 | Verify Hyderabad cluster is writable | DB Engineer | 15 seconds |
| 6 | Application connection strings switch via config or DNS | App Team / SRE | 30 seconds |
| 7 | Validate transaction processing | SRE | 60 seconds |
| 8 | Notify merchants and stakeholders | Incident Commander | — |

**Total unplanned failover time (DB portion):** ~3–4 minutes.

### 5.3 Failover Decision Matrix

| Scenario | Action | Automation |
|----------|--------|-------------|
| Mumbai region healthy, lag < 5s | No action | — |
| Mumbai region healthy, lag 5–30s | Investigate; do not fail over | — |
| Mumbai region healthy, lag > 30s | P1 incident; prepare for failover | Manual decision |
| Mumbai region unhealthy, lag unknown | Fail over to Hyderabad | Manual with runbook |
| Mumbai region unhealthy, Hyderabad also unhealthy | Escalate to AWS; activate tertiary (Pune) plan | Manual |

---

## 6. Failback Procedure

After Mumbai region is restored and validated:

| Step | Action | Owner | Expected Duration |
|------|--------|-------|-------------------|
| 1 | Validate Mumbai cluster health (all instances, storage, network) | DB Engineer | 5 minutes |
| 2 | Take snapshot of Hyderabad cluster (safety checkpoint) | DB Engineer | 2 minutes |
| 3 | Re-establish Global DB: Mumbai as primary, Hyderabad as secondary | DB Engineer | 5 minutes |
| 4 | Wait for initial sync to complete | DB Engineer | 10–30 minutes (volume-dependent) |
| 5 | Verify replication lag stabilises < 5 seconds | DB Engineer | 5 minutes |
| 6 | Switch application writes back to Mumbai | App Team | 30 seconds |
| 7 | Validate transaction processing in Mumbai | SRE | 2 minutes |
| 8 | Scale Hyderabad back to baseline (2 readers) | DB Engineer | 2 minutes |
| 9 | Announce failback complete | Incident Commander | — |

**Total failback time:** ~30–50 minutes (dominated by initial sync).

---

## 7. Operational Considerations

### 7.1 Connection Management

- **Connection pool**: PgBouncer sidecar in EKS pods; pool size tuned per microservice.
- **Endpoint strategy**: Applications use the **cluster endpoint** (writer) for writes and the **reader endpoint** for reads. During failover, the writer endpoint is updated to point to Hyderabad.
- **DNS TTL**: Application-side connection string resolution uses a 30-second TTL to allow rapid cutover.

### 7.2 Backup & Restore

| Backup Type | Frequency | Retention | Region |
|-------------|-----------|-----------|--------|
| Automated snapshots | Daily | 35 days | Mumbai |
| Continuous backup (PITR) | Continuous (5-min granularity) | 35 days | Mumbai |
| Manual snapshots (pre-DR drill) | Per drill | 90 days | Hyderabad |
| Cross-region snapshot copy | Daily | 35 days | Hyderabad (independent copy) |

### 7.3 Maintenance Windows

- **Minor version upgrades**: Applied to secondary cluster first; validated for 24 hours before applying to primary.
- **Major version upgrades**: Performed during planned failover windows with Hyderabad promoted as primary during the upgrade.
- **Instance scaling**: Secondary cluster scaled first; validated; then primary scaled during low-traffic window.

### 7.4 Capacity Planning

| Metric | Current (3.2M tx/day) | Projected (10M tx/day) | Headroom |
|--------|----------------------|------------------------|----------|
| Write IOPS | ~8,000 | ~25,000 | I/O-Optimized (no provisioning) |
| Storage | ~2 TiB | ~6 TiB | Auto-scaling to 64 TiB |
| Connections | ~500 | ~1,500 | PgBouncer pooling |
| Replication bandwidth | ~50 Mbps | ~150 Mbps | VPC peering (up to 100 Gbps) |

### 7.5 Cost Optimisation

- Hyderabad cluster runs at reduced instance count (2 vs. 3) and smaller instance class (`2xlarge` vs. `4xlarge`) during normal operations.
- During failover, Hyderabad scales up to match Mumbai's production capacity.
- Reserved Instances (1-year, All Upfront) for Mumbai baseline; On-Demand for Hyderabad baseline (lower commitment for DR region).

---

## 8. Compliance Mapping

| Regulation | Requirement | Satisfaction |
|------------|-------------|--------------|
| **RBI Data Localisation** | Payment data must reside in India | All Aurora clusters in `ap-south-1` and `ap-south-2`; replication traffic stays within Indian AWS regions |
| **PCI-DSS v4.0 — Req 3** | Encrypt cardholder data at rest | KMS-encrypted storage volumes in both regions |
| **PCI-DSS v4.0 — Req 4** | Encrypt data in transit | TLS 1.3 for cross-region replication; VPC peering (private network) |
| **PCI-DSS v4.0 — Req 9.5.1.2.1** | Resilience testing | DR drills validate failover/failback procedures quarterly |
| **PCI-DSS v4.0 — Req 10** | Audit logging | `audit` schema replicated; CloudTrail enabled in both regions |
| **PCI-DSS v4.0 — Req 12.10.1** | Incident response readiness | Runbook RUN-002 (Database Split-Brain) and RUN-001 (Region Failure) cover Aurora scenarios |
| **NPCI UPI** | System availability | RTO < 5 min ensures UPI-linked services resume within acceptable window |

---

## 9. Failure Modes & Mitigations

| Failure Mode | RPN (1–1000) | Detection | Mitigation |
|--------------|--------------|-----------|------------|
| Replication lag exceeds RPO | 720 | `AuroraGlobalDBReplicationLag` P1 alarm | Scale writer; investigate WAL apply bottleneck; prepare failover |
| Writer instance failure | 540 | `DatabaseConnections` drop; health check | Aurora auto-failover to reader in Mumbai (not cross-region) |
| Cross-region network partition | 640 | Lag spike; CloudWatch metric gap | Wait for partition heal; if > 5 min, evaluate failover |
| Secondary cluster corruption | 480 | `VolumeBytesUsed` anomaly; checksum errors | Rebuild secondary from primary snapshot |
| Storage full | 360 | `FreeLocalStorage` P1 alarm | Auto-scaling; manual storage increase if needed |
| Accidental data deletion | 810 | Application alert; merchant reports | Backtrack to point-in-time before deletion |
| KMS key unavailable in Hyderabad | 560 | Decryption errors on secondary | Multi-Region KMS key ensures key material is available |

---

## 10. Related Documents

- [Architecture Overview](architecture-overview.md)
- [ADR-001: Topology Selection](../adr/ADR-001-topology-selection.md)
- [RPO/RTO Justification](../rpo-rto/rpo-rto-justification.md)
- Runbook RUN-001: Region Failure
- Runbook RUN-002: Database Split-Brain
- Runbook RUN-012: Full Rollback & Failback

---

## 11. Change Log

| Date | Version | Author | Change |
|------|---------|--------|--------|
| 2026-07-20 | 1.0 | Architecture Team | Initial version |