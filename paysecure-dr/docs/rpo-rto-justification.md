# RPO/RTO Justification Document

**Project:** PaySecure Gateway Multi-Region DR  
**Version:** 1.0  
**Date:** 2026-07-20  
**Target:** RPO < 1 minute | RTO < 5 minutes | Uptime 99.99%

---

## 1. Regulatory Context

### 1.1 RBI Master Direction on Payment Systems (2021)

| Clause | Requirement | How Met |
|--------|-------------|---------|
| §12.3(a) | Payment system operators must have a documented business continuity plan with defined RPO and RTO | This document, ADR-001, and 12 DR runbooks |
| §12.3(b) | Critical systems must be able to resume operations within a timeframe that does not disrupt the payment ecosystem | RTO < 5 minutes ensures no disruption to merchant settlements |
| §12.4 | DR drills must be conducted at least quarterly | Quarterly failover drills committed in operational calendar |
| §12.5 | DR site must be geographically distant from primary site | Hyderabad (~300km from Mumbai) satisfies geographic diversity |
| Annex II §3 | Payment data must be stored only in India | Both Mumbai and Hyderabad are within India |

### 1.2 PCI-DSS v4.0

| Requirement | Description | How Met |
|-------------|-------------|---------|
| 6.4.2 | Critical systems must have high-availability architecture | Active-passive multi-region with automated failover |
| 4.2.1 | Encrypted transmission of cardholder data across networks | All cross-region replication encrypted with TLS 1.2+ |
| 10.4.1 | Audit trails must be preserved across failover | CloudWatch Logs replicated cross-region; centralized Datadog |
| 11.4.5 | Intrusion detection/prevention across all environments | AWS WAF rules replicated via IaC; GuardDuty cross-region |

### 1.3 NPCI UPI Technical Standards v2.0

| Requirement | Description | How Met |
|-------------|-------------|---------|
| §4.2.1 | UPI transaction processing must be highly available | 99.99% uptime target with automated failover |
| §4.2.3 | Transaction idempotency must be preserved | DynamoDB Global Tables with idempotency key design; single-writer model |
| §5.1.2 | Reconciliation must continue during DR events | Kafka MirrorMaker 2 ensures transaction events reach both regions |

---

## 2. RPO Analysis: Component-Level Breakdown

### 2.1 Aurora PostgreSQL (Global DB)

```
┌─────────────────────────────────────────────────────────────────┐
│                    Aurora Global DB Replication                 │
│                                                                 │
│  Mumbai (Writer)                        Hyderabad (Reader)      │
│  ┌─────────────────┐                   ┌─────────────────┐      │
│  │ Transaction Log  │───── STREAM ────▶│ Replay Log      │      │
│  │ (continuous)     │    < 1 second     │ (continuous)    │      │
│  └─────────────────┘                   └─────────────────┘      │
│                                                                 │
│  Replication type: Physical (storage-level)                     │
│  Typical lag: < 100ms                                           │
│  P99 lag: < 1 second                                            │
│  P99.9 lag: < 5 seconds                                         │
│  Monitoring: CloudWatch AuroraGlobalDBReplicationLag            │
│  Alert threshold: > 30 seconds (P1)                             │
│                                                                 │
│  RPO Contribution: < 1 second ✅                                │
└─────────────────────────────────────────────────────────────────┘
```

**Justification:** Aurora Global DB uses dedicated, low-latency physical replication at the storage layer. Unlike logical replication, it does not depend on statement or row-level change capture. The replication lag is consistently sub-second because it replicates redo log records directly. AWS SLA guarantees < 1 second lag in the 99th percentile for same-continent Global DB configurations.

**Failure scenario:** If replication lag exceeds 30 seconds, CloudWatch triggers a P1 alert. The on-call engineer follows Runbook #3 (Replication Lag). If lag exceeds 60 seconds, automated suppression of non-critical writes begins to allow the replication stream to catch up.

### 2.2 DynamoDB Global Tables

```
┌─────────────────────────────────────────────────────────────────┐
│                  DynamoDB Global Tables Replication             │
│                                                                 │
│  Mumbai Table                          Hyderabad Table          │
│  ┌─────────────────┐                   ┌─────────────────┐      │
│  │ Write (primary)  │───── ASYNC ─────▶│ Replica         │      │
│  │                  │   < 1.5 seconds   │                 │      │
│  └─────────────────┘                   └─────────────────┘      │
│                                                                 │
│  Replication type: Multi-master (logical, item-level)           │
│  Typical lag: < 1 second                                        │
│  P99 lag: < 1.5 seconds                                         │
│  Conflict resolution: Last-writer-wins (mitigated by single-    │
│                       writer application design)                │
│  Monitoring: CloudWatch ReplicationLatency                      │
│  Alert threshold: > 10 seconds (P2)                             │
│                                                                 │
│  RPO Contribution: < 1.5 seconds ✅                             │
└─────────────────────────────────────────────────────────────────┘
```

**Justification:** DynamoDB Global Tables replicate item-level changes asynchronously using the DynamoDB Streams infrastructure. While the underlying replication is multi-master, the application design enforces writes only to the Mumbai region during normal operations, eliminating conflict resolution concerns. The replication latency is typically sub-second within the same continent.

**Key design constraint:** Idempotency keys are prefixed with region (`MUM-{uuid}`) to prevent collisions even if a write accidentally reaches both regions. This is a defense-in-depth measure beyond the single-writer application design.

### 2.3 ElastiCache Redis (Global Datastore)

```
┌─────────────────────────────────────────────────────────────────┐
│                ElastiCache Global Datastore Replication         │
│                                                                 │
│  Mumbai Cluster                        Hyderabad Cluster        │
│  ┌─────────────────┐                   ┌─────────────────┐      │
│  │ Primary          │───── ASYNC ─────▶│ Replica         │      │
│  │ (read/write)     │    < 1 second     │ (read-only)     │      │
│  └─────────────────┘                   └─────────────────┘      │
│                                                                 │
│  Replication type: Async, in-memory                             │
│  Typical lag: < 100ms                                           │
│  P99 lag: < 1 second                                            │
│  Monitoring: CloudWatch GlobalDatastoreReplicationLag           │
│  Alert threshold: > 5 seconds (P2)                              │
│                                                                 │
│  RPO Contribution: < 1 second ✅                                │
└─────────────────────────────────────────────────────────────────┘
```

**Justification:** ElastiCache Global Datastore replicates Redis commands asynchronously. Since Redis operates entirely in memory, replication is extremely fast. The primary use case for Redis in PaySecure is session state, rate limiting counters, and temporary transaction locks — all of which are ephemeral and can be rebuilt if lost. This reduces the criticality of Redis RPO relative to Aurora or DynamoDB.

**Cache warming strategy:** On failover, the Hyderabad replica is promoted to primary. Application-level cache warming queries the most recent 5 minutes of transaction data from Aurora to rebuild hot keys. This takes approximately 30 seconds and is included in the RTO budget.

### 2.4 MSK (Kafka) — MirrorMaker 2

```
┌─────────────────────────────────────────────────────────────────┐
│                    MSK MirrorMaker 2 Replication                │
│                                                                 │
│  Mumbai MSK                            Hyderabad MSK            │
│  ┌─────────────────┐                   ┌─────────────────┐      │
│  │ transactions     │───── MM2 ───────▶│ transactions     │      │
│  │ settlements      │   < 5 seconds     │ settlements      │      │
│  │ notifications    │                   │ notifications    │      │
│  │ audit            │                   │ audit            │      │
│  └─────────────────┘                   └─────────────────┘      │
│                                                                 │
│  Replication type: Async, topic-level via MirrorMaker 2         │
│  Typical lag: < 1 second                                        │
│  P99 lag: < 5 seconds                                           │
│  Monitoring: CloudWatch KafkaConsumerLag (MM2 consumer group)   │
│  Alert threshold: > 30 seconds (P2), > 60 seconds (P1)         │
│                                                                 │
│  RPO Contribution: < 5 seconds ✅                               │
└─────────────────────────────────────────────────────────────────┘
```

**Justification:** MirrorMaker 2 replicates Kafka topics asynchronously by consuming from the source cluster and producing to the target cluster. The replication lag is primarily determined by consumer throughput and network latency. With dedicated MM2 instances on the same instance type as brokers, throughput is not a bottleneck. The 3-5ms inter-region latency between Mumbai and Hyderabad keeps replication lag consistently under 5 seconds.

**Offset translation:** MM2 maintains offset translation topics that map source cluster offsets to target cluster offsets, enabling seamless consumer failover. Consumer groups in Hyderabad can resume from the correct offset without message loss or duplication.

### 2.5 S3 Cross-Region Replication (CRR)

```
┌─────────────────────────────────────────────────────────────────┐
│                      S3 Cross-Region Replication                │
│                                                                 │
│  Mumbai Bucket                         Hyderabad Bucket         │
│  ┌─────────────────┐                   ┌─────────────────┐      │
│  │ idempotency/    │───── CRR ────────▶│ idempotency/    │      │
│  │ receipts/       │    < 1 second      │ receipts/       │      │
│  │ settlements/    │                   │ settlements/    │      │
│  └─────────────────┘                   └─────────────────┘      │
│                                                                 │
│  Replication type: Async, object-level                          │
│  Typical lag: < 1 second                                        │
│  P99 lag: < 5 seconds                                           │
│  Monitoring: S3 ReplicationLatency (custom CloudWatch metric)   │
│  Alert threshold: > 60 seconds (P2)                             │
│                                                                 │
│  RPO Contribution: < 1 second ✅                                │
└─────────────────────────────────────────────────────────────────┘
```

**Justification:** S3 CRR replicates objects asynchronously after the PUT operation completes in the source bucket. For same-region replication, this is near-instantaneous. Cross-region replication adds the inter-region latency (~3-5ms) plus processing overhead, but typically completes within 1 second. S3 is used for idempotency receipts, settlement files, and audit archives — data that is written less frequently than transaction records and has lower RPO criticality.

### 2.6 Secrets Manager

```
┌─────────────────────────────────────────────────────────────────┐
│                  Secrets Manager Cross-Region Replication       │
│                                                                 │
│  Mumbai Secrets                        Hyderabad Secrets        │
│  ┌─────────────────┐                   ┌─────────────────┐      │
│  │ DB credentials   │───── REPLICATE ─▶│ DB credentials   │      │
│  │ API keys         │    < 1 minute     │ API keys         │      │
│  │ TLS certs        │                   │ TLS certs        │      │
│  └─────────────────┘                   └─────────────────┘      │
│                                                                 │
│  Replication type: On-demand (triggered by secret rotation)     │
│  Typical lag: < 30 seconds                                      │
│  P99 lag: < 1 minute                                            │
│  Monitoring: Custom Lambda checks secret version parity         │
│  Alert threshold: > 5 minutes (P2)                              │
│                                                                 │
│  RPO Contribution: < 1 minute ✅                                │
└─────────────────────────────────────────────────────────────────┘
```

**Justification:** Secrets Manager cross-region replication is triggered on secret rotation events. Since secrets are rotated on a scheduled basis (daily for DB credentials, weekly for API keys), replication lag is not a continuous concern. The worst-case RPO is 1 minute after a rotation event. This is acceptable because: (a) secrets changes are infrequent, (b) the application caches secrets with a refresh interval, and (c) the previous secret version remains valid during the rotation window.

---

## 3. Aggregate RPO Calculation

| Component | RPO (P99) | Weight | Criticality | Weighted RPO |
|-----------|:---:|:---:|:---:|---:|
| Aurora PostgreSQL | < 1s | 0.35 | Critical — transaction data | 0.35s |
| DynamoDB | < 1.5s | 0.30 | Critical — idempotency, routing | 0.45s |
| ElastiCache Redis | < 1s | 0.10 | Medium — ephemeral state | 0.10s |
| MSK (Kafka) | < 5s | 0.15 | High — event stream | 0.75s |
| S3 | < 1s | 0.05 | Low — batch files | 0.05s |
| Secrets Manager | < 60s | 0.05 | Low — infrequent changes | 3.00s |

**Weighted aggregate RPO: ~4.7 seconds**  
**Worst-case component RPO: < 60 seconds (Secrets Manager)**  
**Transaction data RPO (Aurora + DynamoDB): < 1.5 seconds**

**Conclusion:** The aggregate RPO is well within the 1-minute target. The limiting component (Secrets Manager) does not affect transaction data integrity. All transaction-critical components (Aurora, DynamoDB) replicate within 1.5 seconds, providing a comfortable margin below the 60-second requirement.

---

## 4. RTO Analysis: Phase-by-Phase Breakdown

### Phase 1: Detection (Target: 30 seconds)

```
┌─────────────────────────────────────────────────────────────────┐
│                        Detection Pipeline                       │
│                                                                 │
│  Layer 1: Route 53 Health Checks (10-second interval)           │
│  ┌───────────────────────────────────────────────────────────┐  │
│  │ Endpoint: /health (ALB → EKS → Aurora → DynamoDB → Redis) │  │
│  │ Failure threshold: 3 consecutive failures (30 seconds)    │  │
│  │ Action: Mark endpoint unhealthy                           │  │
│  └───────────────────────────────────────────────────────────┘  │
│                                                                 │
│  Layer 2: CloudWatch Composite Alarm (15-second evaluation)     │
│  ┌───────────────────────────────────────────────────────────┐  │
│  │ Conditions:                                                │  │
│  │   - Transaction error rate > 5% for 1 minute              │  │
│  │   - ALB 5XX count > 100 in 1 minute                       │  │
│  │   - Aurora connection failures > 50 in 1 minute           │  │
│  │ Action: Trigger PagerDuty + initiate runbook              │  │
│  └───────────────────────────────────────────────────────────┘  │
│                                                                 │
│  Layer 3: Synthetic Transaction Monitoring (30-second interval) │
│  ┌───────────────────────────────────────────────────────────┐  │
│  │ Test: Complete payment flow (₹1 test transaction)          │  │
│  │ Failure threshold: 2 consecutive failures (60 seconds)    │  │
│  │ Action: Escalate to Incident Commander                    │  │
│  └───────────────────────────────────────────────────────────┘  │
│                                                                 │
│  Detection time: 30 seconds (Layer 1 triggers first)            │
└─────────────────────────────────────────────────────────────────┘
```

### Phase 2: Decision (Target: 30 seconds)

| Scenario | Decision Maker | Action | Max Time |
|----------|:---:|--------|:---:|
| Route 53 health check failure (3/3) | Automated | DNS failover initiated | 0 seconds |
| CloudWatch composite alarm | On-call engineer | Confirm region failure; execute failover | 60 seconds |
| Synthetic transaction failure | Incident Commander | Declare incident; authorize failover | 120 seconds |
| Manual failover (DR drill) | Platform Engineering lead | Execute runbook #1 | N/A (planned) |

**Design decision:** Route 53 health check failures trigger automated DNS failover without human intervention. This is the fastest path and covers the most common failure mode (complete region unavailability). CloudWatch alarms require human confirmation to prevent false positives from triggering unnecessary failovers. This balances speed with safety.

### Phase 3: DNS Cutover (Target: 60 seconds)

```
┌─────────────────────────────────────────────────────────────────┐
│                     Route 53 Failover Timeline                  │
│                                                                 │
│  T+0s    Route 53 marks Mumbai endpoint unhealthy               │
│  T+0s    DNS responses begin returning Hyderabad ALB IP         │
│  T+0-60s DNS propagation: cached resolvers refresh (TTL 60s)   │
│  T+30s   50% of clients routed to Hyderabad                     │
│  T+60s   99%+ of clients routed to Hyderabad                    │
│                                                                 │
│  Note: TTL of 60s is a tradeoff:                               │
│  - Lower TTL = faster failover but higher DNS query cost        │
│  - Higher TTL = slower failover but lower cost                  │
│  - 60s chosen as optimal balance for 5-minute RTO               │
└─────────────────────────────────────────────────────────────────┘
```

### Phase 4: Compute Scale-Up (Target: 90 seconds)

```
┌─────────────────────────────────────────────────────────────────┐
│                    EKS Auto-Scaling Timeline                    │
│                                                                 │
│  T+0s    Failover signal received by ArgoCD + HPA              │
│  T+0s    HPA target increased from 30% to 100%                 │
│  T+15s   Cluster Autoscaler requests new EC2 instances          │
│  T+45s   New nodes join cluster (pre-warmed AMI)                │
│  T+60s   Pods scheduled on new nodes                            │
│  T+75s   Pods pass readiness probes                             │
│  T+90s   All services at full capacity                          │
│                                                                 │
│  Pre-warming strategy:                                          │
│  - 4 nodes running at all times (30% of primary's 12)          │
│  - Critical services (Payment API, Auth) already running        │
│  - Non-critical services (Reporting, Analytics) scaled on demand│
│  - AMI pre-baked with all container images                      │
└─────────────────────────────────────────────────────────────────┘
```

### Phase 5: Cache Warm (Target: 30 seconds)

```
┌─────────────────────────────────────────────────────────────────┐
│                      Cache Warming Strategy                     │
│                                                                 │
│  Step 1: Promote ElastiCache replica to primary (automatic)     │
│          Time: < 5 seconds                                      │
│                                                                 │
│  Step 2: Application cache warm                                 │
│          - Query Aurora for last 5 minutes of hot transaction   │
│            data (merchant configs, routing rules, rate limits)  │
│          - Populate Redis with pre-computed cache keys           │
│          Time: ~20 seconds                                      │
│                                                                 │
│  Step 3: Gradual traffic ramp                                   │
│          - First 5 seconds: 10% traffic (cache miss tolerant)   │
│          - Next 10 seconds: 50% traffic                         │
│          - Next 15 seconds: 100% traffic                        │
│          Time: ~30 seconds total                                │
└─────────────────────────────────────────────────────────────────┘
```

### Phase 6: Verification (Target: 30 seconds)

```
┌─────────────────────────────────────────────────────────────────┐
│                     Failover Verification                       │
│                                                                 │
│  Automated checks:                                              │
│  ┌───────────────────────────────────────────────────────────┐  │
│  │ ✅ Synthetic payment transaction (₹1) succeeds             │  │
│  │ ✅ Health endpoint returns 200                             │  │
│  │ ✅ Aurora writer promotion confirmed                       │  │
│  │ ✅ DynamoDB writes succeeding in Hyderabad                 │  │
│  │ ✅ Kafka consumers active in Hyderabad                     │  │
│  │ ✅ Merchant notification sent (status page updated)        │  │
│  └───────────────────────────────────────────────────────────┘  │
│                                                                 │
│  Manual checks (Incident Commander):                            │
│  ┌───────────────────────────────────────────────────────────┐  │
│  │ ✅ Transaction success rate > 99%                          │  │
│  │ ✅ P99 latency within SLA                                  │  │
│  │ ✅ No duplicate transactions detected                      │  │
│  │ ✅ All dashboards reflecting Hyderabad metrics             │  │
│  └───────────────────────────────────────────────────────────┘  │
│                                                                 │
│  Verification time: 30 seconds                                  │
└─────────────────────────────────────────────────────────────────┘
```

---

## 5. Aggregate RTO Timeline

```
Time (seconds)    0    30    60    90   120   150   180   210   240   270   300
                  │     │     │     │     │     │     │     │     │     │     │
Detection         ██████
                  │
Decision          ████████████
                  │           │
DNS Cutover       ████████████████████████████████████████████████████████████
                  │           │                                               │
Compute Scale-Up  ██████████████████████████████████████████████████████████
                  │           │                                               │
Cache Warm        ███████████████████████████████████████████████████████████
                  │           │                                               │
Verification      ████████████████████████████████████████████████████████████
                  │           │                                               │
                  ▼           ▼                                               ▼
               T+30s      T+60s                                          T+270s
            Detection   Decision +                                    Verification
            complete    DNS begins                                     complete
                                                                          │
                                                                     RTO: 4:30 ✅
                                                                     (Target: 5:00)
```

| Phase | Duration | Cumulative |
|-------|:---:|:---:|
| Detection | 30s | 0:30 |
| Decision | 30s | 1:00 |
| DNS Cutover | 60s | 2:00 |
| Compute Scale-Up | 90s | 3:30 |
| Cache Warm | 30s | 4:00 |
| Verification | 30s | 4:30 |

**Total RTO: 4 minutes 30 seconds** — within the 5-minute target with 30 seconds of buffer.

---

## 6. RTO Sensitivity Analysis

| Scenario | Impact on RTO | Mitigation |
|----------|:---:|------------|
| DNS TTL cached > 60s at some resolvers | +30-60s (still within 5 min) | Acceptable; 99%+ resolvers honor 60s TTL |
| EKS node provisioning delay (AWS API throttling) | +30-60s | Pre-warmed nodes at 30% capacity handle initial traffic |
| Aurora promotion delay (cross-region) | +30-120s | Promotion typically < 60s; Global DB designed for this |
| Cache cold start (high miss rate) | +15-30s | Gradual traffic ramp mitigates thundering herd |
| Human decision delay (false alarm investigation) | +60-120s | Automated failover for clear-cut region failures |

**Worst-case RTO (all delays compound): ~7 minutes** — exceeds target. Mitigation: automated failover for unambiguous failures eliminates the human decision delay, keeping RTO within 5 minutes for the most critical scenarios.

---

## 7. 99.99% Uptime Justification

### Current State (Single Region)
- Uptime: 99.92%
- Annual downtime: ~7 hours (420 minutes)
- Primary cause: Single-region dependency; any region-level incident causes full outage

### Target State (Multi-Region)
- Target uptime: 99.99%
- Maximum annual downtime: ~52.6 minutes
- Each failover event: ~4.5 minutes of downtime

### Downtime Budget Allocation

| Category | Budget | Justification |
|----------|:---:|---------------|
| Region failover events (2/year) | 9 minutes | 2 events × 4.5 minutes |
| Planned maintenance (4/year) | 12 minutes | 4 windows × 3 minutes (rolling updates) |
| Partial degradation (6/year) | 18 minutes | 6 events × 3 minutes (degraded but not down) |
| Unaccounted buffer | 13.6 minutes | Safety margin |
| **Total** | **52.6 minutes** | **Within 99.99% budget** |

### Key Assumptions
1. Region-level failures are rare (AWS SLA: 99.99% per region = ~52 min downtime/region/year)
2. Probability of simultaneous failure of both Mumbai and Hyderabad: negligible (< 0.0001%)
3. Planned maintenance uses rolling updates; no full downtime required
4. Partial degradation (e.g., single AZ failure) does not trigger full region failover

---

## 8. Validation Plan

| Test | Frequency | Method | Success Criteria |
|------|:---:|--------|------------------|
| Component failover (Aurora) | Monthly | Promote Global DB secondary; verify writes | RTO < 2 min; no data loss |
| Component failover (DynamoDB) | Monthly | Switch write region; verify consistency | RTO < 1 min; no conflicts |
| Full region failover | Quarterly | Execute Runbook #1; full traffic shift | RTO < 5 min; RPO < 1 min |
| Failback | Quarterly | Execute Runbook #12; return to Mumbai | RTO < 10 min; no data loss |
| Chaos experiment (node kill) | Monthly | Kill random EKS node; observe recovery | Pods rescheduled < 30s; no tx failures |
| Chaos experiment (latency) | Monthly | Inject 200ms Aurora latency | Circuit breakers activate; P99 < 500ms |

---

## 9. Document Control

| Version | Date | Author | Changes |
|---------|------|--------|---------|
| 1.0 | 2026-07-20 | Platform Engineering | Initial RPO/RTO justification for multi-region DR |

**Next review:** 2026-10-20 (quarterly, aligned with DR drill schedule)  
**Approval:** VP Engineering, CTO, Compliance Head