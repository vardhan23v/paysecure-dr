# ElastiCache Redis Global Datastore — Replication Strategy

| Attribute | Value |
|-----------|-------|
| **Status** | Current |
| **Date** | 2026-07-20 |
| **Owner** | Database Engineering |
| **Scope** | PaySecure cached payment instrument metadata, temporary auth tokens, merchant configuration cache |

---

## 1. Overview

Amazon ElastiCache Global Datastore for Redis provides cross-region replication for PaySecure's in-memory caching layer. The primary cluster in Mumbai (`ap-south-1`) replicates to a secondary cluster in Hyderabad (`ap-south-2`), ensuring cached data is available immediately upon failover.

### 1.1 Why ElastiCache Global Datastore

| Criterion | Evaluation |
|-----------|------------|
| **RPO** | Asynchronous replication with typical lag < 1 second; well within the 1-minute RPO budget |
| **RTO** | Secondary cluster promotion completes in < 1 minute; cache warming scripts pre-populate hot keys |
| **Consistency** | Single-primary model; no split-brain risk |
| **Operational overhead** | Fully managed by AWS; no self-managed Redis Sentinel or cluster |
| **Compliance** | All data resides within Indian regions (`ap-south-1` → `ap-south-2`) |

### 1.2 Cache-Aside Pattern

PaySecure uses a **cache-aside** pattern: the application checks Redis first; on a cache miss, it fetches from Aurora/DynamoDB and populates Redis. This means Redis data is **recreatable** — a cold cache after failover is a performance degradation, not a data-loss event. However, Global Datastore replication minimises the cold-start impact by keeping the Hyderabad cache warm.

---

## 2. Cluster Topology

```
┌──────────────────────────────────────────────────────────────────────┐
│                     MUMBAI (ap-south-1) — PRIMARY                     │
│  ┌────────────────────────────────────────────────────────────────┐  │
│  │  ElastiCache Global Datastore: paysecure-cache                 │  │
│  │  ┌──────────┐  ┌──────────┐  ┌──────────┐                     │  │
│  │  │ Shard 1  │  │ Shard 2  │  │ Shard 3  │  (Cluster Mode)    │  │
│  │  │ Primary  │  │ Primary  │  │ Primary  │                     │  │
│  │  │ +Replica │  │ +Replica │  │ +Replica │                     │  │
│  │  │ (az-1)   │  │ (az-2)   │  │ (az-3)   │                     │  │
│  │  └────┬─────┘  └────┬─────┘  └────┬─────┘                     │  │
│  │       │              │              │                            │  │
│  │       │  Asynchronous replication to Global Datastore secondary │  │
│  └───────┼──────────────┼──────────────┼────────────────────────────┘  │
└──────────┼──────────────┼──────────────┼──────────────────────────────┘
           │              │              │
           │  Encrypted cross-region replication (AWS backbone)
           ▼              ▼              ▼
┌──────────────────────────────────────────────────────────────────────┐
│                    HYDERABAD (ap-south-2) — SECONDARY                 │
│  ┌────────────────────────────────────────────────────────────────┐  │
│  │  ElastiCache Global Datastore: paysecure-cache (secondary)     │  │
│  │  ┌──────────┐  ┌──────────┐  ┌──────────┐                     │  │
│  │  │ Shard 1  │  │ Shard 2  │  │ Shard 3  │                     │  │
│  │  │ Primary  │  │ Primary  │  │ Primary  │  (Read-only)        │  │
│  │  │ +Replica │  │ +Replica │  │ +Replica │                     │  │
│  │  │ (az-1)   │  │ (az-2)   │  │ (az-3)   │                     │  │
│  │  └──────────┘  └──────────┘  └──────────┘                     │  │
│  │                                                                  │  │
│  │  Read-only under normal operations; promoted on failover       │  │
│  └────────────────────────────────────────────────────────────────┘  │
└──────────────────────────────────────────────────────────────────────┘
```

### 2.1 Cluster Configuration

| Parameter | Mumbai (Primary) | Hyderabad (Secondary) |
|-----------|------------------|----------------------|
| **Engine** | Redis 7.x (Cluster Mode Enabled) | Redis 7.x (Cluster Mode Enabled) |
| **Node type** | `cache.r6g.xlarge` | `cache.r6g.large` (baseline) |
| **Shards** | 3 | 3 |
| **Replicas per shard** | 1 | 1 |
| **Total nodes** | 6 (3 primary + 3 replica) | 6 (3 primary + 3 replica) |
| **Multi-AZ** | Yes (3 AZs) | Yes (3 AZs) |
| **Encryption at rest** | Enabled (KMS) | Enabled (KMS) |
| **Encryption in transit** | Enabled (TLS 1.3) | Enabled (TLS 1.3) |
| **Auth token** | Enabled (AUTH token) | Enabled (AUTH token, replicated) |
| **Automatic failover** | Enabled (within region) | Enabled (within region) |
| **Backup retention** | 7 days | 7 days |

### 2.2 Cache Namespaces Covered

| Key Prefix | Purpose | Criticality | Avg Size | TTL | Eviction Policy |
|------------|---------|-------------|----------|-----|-----------------|
| `pm:instrument:` | Payment instrument metadata (masked card, UPI handle) | P0 — transaction-critical | ~2 KB | 15 minutes | volatile-lru |
| `auth:token:` | Temporary authentication tokens | P1 — authentication | ~500 B | 5 minutes | volatile-lru |
| `merchant:config:` | Merchant configuration (routing rules, limits) | P1 — operational | ~10 KB | 30 minutes | volatile-lru |
| `rate:counter:` | Rate-limit counters (backup to DynamoDB) | P1 — platform protection | ~100 B | 1 minute | volatile-ttl |
| `session:cache:` | Hot session data (backup to DynamoDB) | P2 — user experience | ~1 KB | 10 minutes | volatile-lru |
| `fx:rate:` | Foreign exchange rates (refreshed every 60s) | P1 — financial accuracy | ~200 B | 60 seconds | volatile-ttl |

---

## 3. Replication Mechanism

### 3.1 Asynchronous Replication via Global Datastore

ElastiCache Global Datastore replicates data from the primary cluster to the secondary cluster using Redis's built-in replication protocol over an AWS-managed cross-region channel.

| Property | Detail |
|----------|--------|
| **Replication type** | Asynchronous, command-stream replication |
| **Replication unit** | Individual Redis write commands (SET, DEL, HSET, etc.) |
| **Replication path** | Mumbai primary nodes → Hyderabad primary nodes (AWS backbone) |
| **Encryption** | TLS 1.3 in transit; KMS-encrypted at rest in both regions |
| **Conflict resolution** | Single-primary model; no conflicts possible |
| **Typical observed lag** | < 500 ms under normal load; < 2 seconds under peak load |

### 3.2 Replication Flow

```
Application Write (SET, DEL, HSET, EXPIRE, etc.)
       │
       ▼
┌─────────────────┐
│  Mumbai Primary │─── Write acknowledged to client
│  (ap-south-1)   │
└────────┬────────┘
         │
         │ 1. Replicate to local replica (synchronous-ish, within region)
         ▼
┌─────────────────┐
│  Mumbai Replica │
│  (ap-south-1)   │
└────────┬────────┘
         │
         │ 2. Global Datastore: cross-region async replication
         │
         ▼
┌─────────────────┐
│ Hyderabad       │─── Command applied; eventually consistent
│ Primary         │
│ (ap-south-2)    │
└────────┬────────┘
         │
         │ 3. Replicate to local replica (within Hyderabad)
         ▼
┌─────────────────┐
│ Hyderabad       │
│ Replica         │
│ (ap-south-2)    │
└─────────────────┘
```

### 3.3 Cache Warming Strategy

To minimise cold-start impact during failover, PaySecure runs **cache warming jobs** in Hyderabad:

| Job | Trigger | Action |
|-----|---------|--------|
| **Hot-key pre-warming** | Every 5 minutes (cron) | Reads top 10,000 most-accessed keys from Mumbai and writes to Hyderabad (via application, not direct replication) |
| **Failover cache priming** | On failover trigger | Bulk-loads merchant configs, active sessions, and FX rates from Aurora/DynamoDB into Hyderabad Redis |
| **Lazy warming** | On cache miss in Hyderabad | Application fetches from Aurora/DynamoDB and populates Hyderabad Redis (standard cache-aside) |

---

## 4. Lag Monitoring

### 4.1 Primary Metric

| Metric | Source | Description |
|--------|--------|-------------|
| `GlobalDatastoreReplicationLag` | CloudWatch (ElastiCache) | Replication lag in seconds between the primary and secondary Global Datastore clusters |

### 4.2 Alerting Thresholds

| Severity | Threshold | Evaluation Window | Action |
|----------|-----------|-------------------|--------|
| **P2 — Warning** | Lag > 10 seconds for 2 consecutive data points (60s period) | 2 minutes | Notify DB on-call via Slack; create Jira ticket |
| **P1 — Critical** | Lag > 30 seconds for 2 consecutive data points (60s period) | 2 minutes | Page DB on-call via PagerDuty; trigger incident response |
| **P0 — Emergency** | Lag > 60 seconds for 1 data point | 1 minute | Page Incident Commander; evaluate pre-failover readiness |

### 4.3 Supplementary Metrics

| Metric | Purpose | Threshold |
|--------|---------|-----------|
| `CacheHitRate` | Cache effectiveness | < 85% (P2), < 70% (P1) |
| `CacheMisses` | Miss rate anomaly | Spike > 3x baseline |
| `Evictions` | Memory pressure | > 1,000 evictions/min (P2), > 10,000 evictions/min (P1) |
| `CurrConnections` | Connection count | > 80% of `maxclients` |
| `CPUUtilization` | Node CPU pressure | > 80% (P2), > 90% (P1) |
| `DatabaseMemoryUsagePercentage` | Memory utilisation | > 80% (P2), > 90% (P1) |
| `ReplicationLag` (per node) | Per-node replication lag within a region | > 5 seconds (P2), > 10 seconds (P1) |
| `BytesUsedForCache` | Cache size growth | Anomaly detection (> 20% growth in 1 hour) |

### 4.4 Lag Dashboard Panel

The **DR Readiness Dashboard** (30-second refresh) displays:

- Real-time `GlobalDatastoreReplicationLag` gauge (green < 5s, amber 5–30s, red > 30s).
- 24-hour lag trend line with peak annotations.
- Cache hit rate per namespace.
- Memory utilisation per cluster.
- Eviction rate (should be near zero under normal operations).

---

## 5. Failover Procedure

### 5.1 Planned Failover (DR Drill / Maintenance)

**Preconditions:**
- `GlobalDatastoreReplicationLag` < 5 seconds for at least 5 minutes.
- All Hyderabad nodes are healthy.
- Change window approved; stakeholders notified.

**Procedure:**

| Step | Action | Owner | Expected Duration |
|------|--------|-------|-------------------|
| 1 | Notify stakeholders; announce change window | Incident Commander | 5 min (pre-work) |
| 2 | Stop application writes to Mumbai Redis (drain) | SRE / App Team | 15 seconds |
| 3 | Verify `GlobalDatastoreReplicationLag` = 0 | DB Engineer | 15 seconds |
| 4 | Promote Hyderabad Global Datastore secondary to primary via AWS Console / CLI | DB Engineer | 30 seconds |
| 5 | Wait for promotion to complete | DB Engineer | 30–60 seconds |
| 6 | Update application Redis endpoint to Hyderabad cluster | App Team | 30 seconds |
| 7 | Run cache priming script (hot keys from Aurora/DynamoDB) | SRE | 30 seconds |
| 8 | Validate application health and cache hit rate | SRE | 60 seconds |
| 9 | Announce failover complete | Incident Commander | — |

**Total planned failover time:** ~3–4 minutes.

### 5.2 Unplanned Failover (Region Failure)

**Trigger:** Mumbai region becomes unavailable.

| Step | Action | Owner | Expected Duration |
|------|--------|-------|-------------------|
| 1 | Confirm Mumbai region failure (multiple signal loss) | Incident Commander | 30 seconds |
| 2 | Declare DR event; activate Incident Response Dashboard | Incident Commander | 15 seconds |
| 3 | Promote Hyderabad Global Datastore secondary to primary | DB Engineer | 30 seconds |
| 4 | Wait for promotion to complete | DB Engineer | 30–60 seconds |
| 5 | Update application Redis endpoint to Hyderabad cluster | App Team / SRE | 30 seconds |
| 6 | Run cache priming script | SRE | 30 seconds |
| 7 | Validate application health (expect temporarily reduced cache hit rate) | SRE | 60 seconds |
| 8 | Notify merchants and stakeholders | Incident Commander | — |

**Total unplanned failover time (ElastiCache portion):** ~3–4 minutes.

> **Note:** After unplanned failover, the Hyderabad cache may have a gap (data written in Mumbai after the last replicated command). The cache priming script and lazy warming (cache-aside) fill this gap. Cache hit rate may dip temporarily but recovers within 2–5 minutes.

### 5.3 Failover Decision Matrix

| Scenario | Action | Automation |
|----------|--------|-------------|
| Mumbai healthy, lag < 5s | No action | — |
| Mumbai healthy, lag 5–30s | Investigate; do not fail over | Manual decision |
| Mumbai healthy, lag > 30s | P1 incident; prepare for failover | Manual decision |
| Mumbai unhealthy, lag unknown | Fail over to Hyderabad | Manual with runbook |
| Mumbai unhealthy, Hyderabad also unhealthy | Accept degraded performance (cache-aside from Aurora/DynamoDB); provision new cluster | Manual |

---

## 6. Failback Procedure

After Mumbai region is restored and validated:

| Step | Action | Owner | Expected Duration |
|------|--------|-------|-------------------|
| 1 | Validate Mumbai cluster health (all nodes, shards) | DB Engineer | 2 minutes |
| 2 | Take snapshot of Hyderabad cluster (safety checkpoint) | DB Engineer | 1 minute |
| 3 | Re-establish Global Datastore: Mumbai as primary, Hyderabad as secondary | DB Engineer | 3 minutes |
| 4 | Wait for initial sync to complete | DB Engineer | 5–10 minutes |
| 5 | Verify `GlobalDatastoreReplicationLag` stabilises < 5 seconds | DB Engineer | 5 minutes |
| 6 | Switch application Redis endpoint back to Mumbai | App Team | 30 seconds |
| 7 | Validate cache hit rate in Mumbai | SRE | 2 minutes |
| 8 | Scale Hyderabad back to baseline node type (`cache.r6g.large`) | DB Engineer | 2 minutes |
| 9 | Announce failback complete | Incident Commander | — |

**Total failback time:** ~20–25 minutes.

---

## 7. Operational Considerations

### 7.1 Eviction & Memory Management

| Policy | Namespace | Rationale |
|--------|-----------|-----------|
| `volatile-lru` | `pm:instrument:`, `auth:token:`, `merchant:config:`, `session:cache:` | Evict least-recently-used keys with TTL set; never evict keys without TTL |
| `volatile-ttl` | `rate:counter:`, `fx:rate:` | Evict keys closest to TTL expiry first; natural turnover pattern |

- **Maxmemory**: Set to 75% of node memory to leave headroom for replication buffers and Redis overhead.
- **No eviction of persistent keys**: Keys without TTL (if any) are never evicted under `volatile-lru` and `volatile-ttl` policies.

### 7.2 Connection Management

- **Connection pooling**: Application uses `ioredis` (Node.js) or `Lettuce` (Java) with connection pooling.
- **Cluster mode endpoint**: Applications use the **configuration endpoint** for cluster-mode Redis, which automatically discovers shards.
- **DNS TTL**: Application-side Redis endpoint resolution uses a 30-second TTL.

### 7.3 Backup & Restore

| Backup Type | Frequency | Retention | Region |
|-------------|-----------|-----------|--------|
| Automated snapshots | Daily | 7 days | Mumbai |
| Manual snapshots (pre-DR drill) | Per drill | 90 days | Hyderabad |
| Export to S3 | Weekly | 90 days | Mumbai (cross-region copy to Hyderabad) |

### 7.4 Maintenance Windows

- **Minor version upgrades**: Applied to secondary cluster first; validated for 24 hours before applying to primary.
- **Node type scaling**: Secondary scaled first; validated; then primary scaled during low-traffic window.
- **Shard rebalancing**: Performed during planned maintenance windows; slots redistributed online.

### 7.5 Cost Optimisation

- Hyderabad cluster runs at a smaller node type (`cache.r6g.large` vs. `cache.r6g.xlarge`) during normal operations.
- During failover, Hyderabad scales up to match Mumbai's production capacity.
- Reserved Nodes (1-year, All Upfront) for Mumbai baseline; On-Demand for Hyderabad baseline.

---

## 8. Compliance Mapping

| Regulation | Requirement | Satisfaction |
|------------|-------------|--------------|
| **RBI Data Localisation** | Payment data must reside in India | All ElastiCache clusters in `ap-south-1` and `ap-south-2`; replication traffic stays within Indian AWS regions |
| **PCI-DSS v4.0 — Req 3** | Encrypt cardholder data at rest | KMS-encrypted at rest in both regions; AUTH token enabled |
| **PCI-DSS v4.0 — Req 4** | Encrypt data in transit | TLS 1.3 for all Redis connections and cross-region replication |
| **PCI-DSS v4.0 — Req 3.4** | PAN masking | `pm:instrument:` keys store only masked PAN (last 4 digits) and token references; full PAN never stored in Redis |
| **PCI-DSS v4.0 — Req 9.5.1.2.1** | Resilience testing | DR drills validate failover/failback procedures quarterly |
| **PCI-DSS v4.0 — Req 12.10.1** | Incident response readiness | Runbook RUN-004 (Cache Corruption) and RUN-001 (Region Failure) cover ElastiCache scenarios |
| **NPCI UPI** | System availability | RTO < 5 min ensures UPI-linked services resume within acceptable window |

---

## 9. Failure Modes & Mitigations

| Failure Mode | RPN (1–1000) | Detection | Mitigation |
|--------------|--------------|-----------|------------|
| Global Datastore replication lag exceeds RPO | 560 | `GlobalDatastoreReplicationLag` P1 alarm | Scale primary; investigate replication bottleneck; prepare failover |
| Cache node failure (within region) | 360 | `CacheHitRate` drop; `CurrConnections` anomaly | Multi-AZ auto-failover to replica within the same region |
| Cache corruption (bad data replicated) | 720 | Application errors; `CacheMisses` spike | Flush corrupted namespace; reload from Aurora/DynamoDB; runbook RUN-004 |
| Memory exhaustion (eviction storm) | 480 | `Evictions` spike; `DatabaseMemoryUsagePercentage` > 90% | Scale up node type; add shards; review TTL policies |
| Cold cache after unplanned failover | 540 | `CacheHitRate` < 50% after failover | Cache priming script; lazy warming; temporary performance degradation accepted |
| AUTH token mismatch after failover | 640 | Connection errors from application | AUTH token replicated via Secrets Manager; validate during DR drills |
| KMS key unavailable in Hyderabad | 480 | Decryption errors on secondary | Multi-Region KMS key ensures key material is available |

---

## 10. Related Documents

- [Architecture Overview](architecture-overview.md)
- [Aurora PostgreSQL Replication Strategy](database-replication-aurora.md)
- [DynamoDB Global Tables Replication Strategy](database-replication-dynamodb.md)
- [ADR-001: Topology Selection](../adr/ADR-001-topology-selection.md)
- [RPO/RTO Justification](../rpo-rto/rpo-rto-justification.md)
- Runbook RUN-001: Region Failure
- Runbook RUN-004: Cache Corruption
- Runbook RUN-012: Full Rollback & Failback

---

## 11. Change Log

| Date | Version | Author | Change |
|------|---------|--------|--------|
| 2026-07-20 | 1.0 | Architecture Team | Initial version |