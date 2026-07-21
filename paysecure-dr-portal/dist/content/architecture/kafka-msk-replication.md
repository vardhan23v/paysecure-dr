# Kafka & Amazon MSK Multi-Region Replication Design

**PaySecure Gateway DR Architecture — Phase 2, Step 5**  
**Version:** 1.0  
**Date:** 2026-07-20  
**Author:** Platform Engineering  
**Status:** Approved  
**Cross-references:** ADR-001, `architecture-overview.md`, `rpo-rto-justification.md`, Runbooks RB-004 (Kafka Partition Loss), RB-012 (Full Rollback)

---

## 1. Executive Summary

This document defines the multi-region replication strategy for Apache Kafka workloads running on Amazon Managed Streaming for Apache Kafka (MSK) across PaySecure Gateway's primary (Mumbai/ap-south-1) and secondary (Hyderabad/ap-south-2) regions. The design uses **MSK MirrorMaker 2 (MM2)** for unidirectional topic replication from primary to secondary, with consumer offset synchronisation, dead-letter queue (DLQ) handling, and strict replication-lag monitoring to maintain the aggregate RPO budget of < 1 minute.

**Key design decisions:**
- **Unidirectional replication** (primary → secondary) aligned with active-passive topology
- **MirrorMaker 2** as the replication engine (native MSK integration, exactly-once semantics via Kafka transactions)
- **Consumer offset sync** enabled for seamless failover without reprocessing or skipping messages
- **Dedicated DLQ topics** per service for poison-pill isolation
- **Replication lag P1 threshold: 30 seconds** (within the 43-second aggregate RPO budget)

---

## 2. Cluster Topology

### 2.1 Primary Region — Mumbai (ap-south-1)

| Attribute | Configuration |
|-----------|---------------|
| Cluster name | `paysecure-msk-primary` |
| Kafka version | 3.6.x |
| Broker count | 6 (3 AZs × 2 brokers) |
| Instance type | kafka.m5.2xlarge |
| Storage | 3 TB per broker (GP3, 16,000 IOPS, 1,000 MB/s throughput) |
| Partitions per topic | 12 (divisible by broker count for even distribution) |
| Replication factor | 3 |
| Min ISR | 2 |
| ZooKeeper | 3-node ensemble (MSK-managed) |

**Topic naming convention:** `paysecure.<domain>.<event-type>.<version>`  
Examples: `paysecure.payments.txn-authorised.v1`, `paysecure.settlements.batch-completed.v1`

### 2.2 Secondary Region — Hyderabad (ap-south-2)

| Attribute | Configuration |
|-----------|---------------|
| Cluster name | `paysecure-msk-secondary` |
| Kafka version | 3.6.x (identical to primary) |
| Broker count | 6 (3 AZs × 2 brokers) |
| Instance type | kafka.m5.2xlarge |
| Storage | 3 TB per broker (GP3) |
| Partitions per topic | 12 |
| Replication factor | 3 |
| Min ISR | 2 |
| ZooKeeper | 3-node ensemble (MSK-managed) |

**Secondary cluster purpose:** Warm standby with replicated topics. No producers write to replicated topics during normal operations. Local-only topics (e.g., `paysecure.monitoring.metrics-local`) are permitted for regional observability data.

### 2.3 MirrorMaker 2 Connector Topology

MirrorMaker 2 runs as a **dedicated MSK Connect connector** in the secondary region, reading from the primary cluster and writing to the secondary cluster.

```
┌─────────────────────────────────────┐
│  Mumbai (ap-south-1)                │
│  ┌─────────────────────────────┐    │
│  │  paysecure-msk-primary      │    │
│  │  ┌─────┐ ┌─────┐ ┌─────┐   │    │
│  │  │ B1  │ │ B2  │ │ B3  │   │    │
│  │  │ B4  │ │ B5  │ │ B6  │   │    │
│  │  └──┬──┘ └──┬──┘ └──┬──┘   │    │
│  └─────┼───────┼───────┼──────┘    │
│        │       │       │            │
│     ┌──┴───────┴───────┴──┐         │
│     │   VPC Peering /     │         │
│     │   PrivateLink       │         │
│     └──────┬──────────────┘         │
└────────────┼────────────────────────┘
             │
             ▼
┌─────────────────────────────────────┐
│  Hyderabad (ap-south-2)             │
│  ┌─────────────────────────────┐    │
│  │  MM2 Connector (MSK Connect)│    │
│  │  ┌─────────────────────┐    │    │
│  │  │ Source: primary     │    │    │
│  │  │ Target: secondary   │    │    │
│  │  │ Offset Sync: ON     │    │    │
│  │  │ Checkpoint Sync: ON │    │    │
│  │  └──────────┬──────────┘    │    │
│  └─────────────┼───────────────┘    │
│                │                     │
│  ┌─────────────┼───────────────┐    │
│  │  paysecure-msk-secondary    │    │
│  │  ┌─────┐ ┌─────┐ ┌─────┐   │    │
│  │  │ B1  │ │ B2  │ │ B3  │   │    │
│  │  │ B4  │ │ B5  │ │ B6  │   │    │
│  │  └─────┘ └─────┘ └─────┘   │    │
│  └─────────────────────────────┘    │
└─────────────────────────────────────┘
```

### 2.4 Network Connectivity

- **Inter-cluster:** AWS PrivateLink (recommended) or VPC peering between Mumbai and Hyderabad VPCs
- **Security:** TLS 1.3 for all inter-cluster traffic; mTLS between MM2 and both clusters
- **Bandwidth:** Provisioned 5 Gbps cross-region link (burstable to 10 Gbps); current peak throughput 1.2 Gbps with 4× headroom

---

## 3. Topic Mirroring Configuration

### 3.1 Replicated Topic List

All business-critical topics are replicated. Local/derived topics are excluded.

| Topic Name | Partitions | Retention | Replication Priority | DLQ Topic |
|------------|-----------|-----------|---------------------|-----------|
| `paysecure.payments.txn-authorised.v1` | 12 | 7 days | Critical | `paysecure.payments.txn-dlq.v1` |
| `paysecure.payments.txn-captured.v1` | 12 | 7 days | Critical | `paysecure.payments.txn-dlq.v1` |
| `paysecure.payments.txn-refunded.v1` | 12 | 7 days | Critical | `paysecure.payments.txn-dlq.v1` |
| `paysecure.settlements.batch-initiated.v1` | 12 | 3 days | High | `paysecure.settlements.dlq.v1` |
| `paysecure.settlements.batch-completed.v1` | 12 | 3 days | High | `paysecure.settlements.dlq.v1` |
| `paysecure.merchants.onboarding.v1` | 6 | 30 days | Medium | `paysecure.merchants.dlq.v1` |
| `paysecure.notifications.email.v1` | 6 | 1 day | Low | `paysecure.notifications.dlq.v1` |
| `paysecure.notifications.sms.v1` | 6 | 1 day | Low | `paysecure.notifications.dlq.v1` |
| `paysecure.audit.events.v1` | 12 | 90 days | High | `paysecure.audit.dlq.v1` |
| `paysecure.fraud.alerts.v1` | 12 | 14 days | Critical | `paysecure.fraud.dlq.v1` |

**Total replicated topics:** 10  
**Total partitions mirrored:** 108

### 3.2 MirrorMaker 2 Configuration

```json
{
  "name": "paysecure-mm2-primary-to-secondary",
  "config": {
    "connector.class": "org.apache.kafka.connect.mirror.MirrorSourceConnector",
    "source.cluster.alias": "primary",
    "target.cluster.alias": "secondary",
    "source.cluster.bootstrap.servers": "b-1.paysecure-msk-primary.xxx.kafka.ap-south-1.amazonaws.com:9094",
    "target.cluster.bootstrap.servers": "b-1.paysecure-msk-secondary.xxx.kafka.ap-south-2.amazonaws.com:9094",
    "tasks.max": "6",
    "topics": "paysecure\\.payments\\..*,paysecure\\.settlements\\..*,paysecure\\.merchants\\..*,paysecure\\.notifications\\..*,paysecure\\.audit\\..*,paysecure\\.fraud\\..*",
    "topics.exclude": ".*\\.mm2-.*,.*\\.heartbeats,.*\\.checkpoints.*",
    "replication.factor": "3",
    "checkpoints.topic.replication.factor": "3",
    "heartbeats.topic.replication.factor": "3",
    "offset-syncs.topic.replication.factor": "3",
    "offset-syncs.topic.location": "target",
    "sync.topic.acls.enabled": "false",
    "sync.topic.configs.enabled": "true",
    "emit.heartbeats.enabled": "true",
    "emit.checkpoints.enabled": "true",
    "refresh.topics.enabled": "true",
    "refresh.topics.interval.seconds": "60",
    "replication.policy.class": "org.apache.kafka.connect.mirror.DefaultReplicationPolicy",
    "replication.policy.separator": ".",
    "consumer.group.id": "mm2-primary-to-secondary",
    "producer.enable.idempotence": "true",
    "producer.transactions.enabled": "true",
    "producer.transaction.id": "mm2-transaction-id",
    "key.converter": "org.apache.kafka.connect.converters.ByteArrayConverter",
    "value.converter": "org.apache.kafka.connect.converters.ByteArrayConverter",
    "header.converter": "org.apache.kafka.connect.converters.ByteArrayConverter"
  }
}
```

### 3.3 Replication Policy

- **Topic renaming:** MM2 prefixes replicated topics with source cluster alias: `primary.paysecure.payments.txn-authorised.v1`
- **Consumer groups:** Replicated consumer group offsets are stored in `secondary.checkpoints.internal` topic
- **Config sync:** Topic-level configurations (retention, compression, min ISR) are synchronised automatically

---

## 4. Consumer Offset Management

### 4.1 Offset Sync Strategy

MM2's `MirrorCheckpointConnector` synchronises consumer group offsets from primary to secondary at 60-second intervals. This ensures that upon failover, consumers in the secondary region can resume processing from the correct position without reprocessing or skipping messages.

| Parameter | Value | Rationale |
|-----------|-------|-----------|
| `emit.checkpoints.enabled` | `true` | Enable offset checkpoint emission |
| `offset-syncs.topic.location` | `target` | Store offset sync metadata on secondary cluster |
| Checkpoint interval | 60s | Balance between freshness and overhead |
| Offset translation | Automatic | MM2 maps primary offsets to secondary offsets using `OffsetSync` records |

### 4.2 Failover Consumer Offset Behaviour

```
Normal Operation:
  Primary Consumer Group "payment-processors"
  ├─ Partition 0: offset 1,245,678
  ├─ Partition 1: offset 1,198,432
  └─ ...

  MM2 Checkpoint Sync (every 60s)
  → Writes to secondary.checkpoints.internal:
     "payment-processors": {0: 1,245,600, 1: 1,198,400, ...}

Failover Scenario:
  Secondary Consumer Group "payment-processors" starts
  → Reads checkpoint: resumes at mapped offsets
  → Maximum reprocessing window: 60s of messages (acceptable per idempotency design)
```

### 4.3 Idempotency Requirement

All downstream consumers **must** be idempotent. The maximum reprocessing window is bounded by:
- Checkpoint sync interval (60s)
- Plus any in-flight messages at failover time (~5s)

**Mitigation:** All payment event processors use `transaction_id` as the idempotency key, stored in DynamoDB with 24-hour TTL.

---

## 5. Dead-Letter Queue (DLQ) Handling

### 5.1 DLQ Architecture

Each service maintains a dedicated DLQ topic for messages that fail processing after 3 retry attempts (with exponential backoff: 1s, 5s, 25s).

```
┌─────────────────┐     ┌─────────────┐     ┌─────────────────┐
│  Main Topic     │────▶│  Consumer   │────▶│  DLQ Topic      │
│  (replicated)   │     │  (3 retries)│     │  (replicated)   │
└─────────────────┘     └─────────────┘     └─────────────────┘
       │                                           │
       │                                           │
       ▼                                           ▼
┌─────────────────┐                       ┌─────────────────┐
│  Secondary      │                       │  Secondary      │
│  (mirrored)     │                       │  (mirrored)     │
└─────────────────┘                       └─────────────────┘
```

### 5.2 DLQ Replication

DLQ topics are replicated via MM2 with the same priority as their source topics. This ensures that poison-pill messages are available in the secondary region for analysis and replay.

| DLQ Topic | Alert Threshold | Manual Review SLA | Auto-replay |
|-----------|----------------|-------------------|-------------|
| `paysecure.payments.txn-dlq.v1` | > 10 msgs / 5 min | 30 minutes | No — manual only |
| `paysecure.settlements.dlq.v1` | > 5 msgs / 5 min | 1 hour | No |
| `paysecure.fraud.dlq.v1` | > 1 msg / 5 min | 15 minutes | No |
| `paysecure.audit.dlq.v1` | > 50 msgs / 5 min | 4 hours | Yes (after review) |
| `paysecure.notifications.dlq.v1` | > 100 msgs / 5 min | 24 hours | Yes |

### 5.3 DLQ Monitoring and Alerting

- **CloudWatch metric:** `Sum(MessagesInPerSec)` per DLQ topic
- **P1 alert:** Any critical DLQ (`payments`, `fraud`) exceeds threshold
- **Dashboard:** DLQ depth, oldest message age, replay status
- **Runbook:** RB-004 (Kafka Partition Loss) includes DLQ overflow procedures

---

## 6. Replication Lag Monitoring

### 6.1 Lag Metrics

| Metric | Source | P1 Threshold | P2 Threshold | Measurement |
|--------|--------|-------------|-------------|-------------|
| Max replication lag (ms) | MM2 JMX / MSK CloudWatch | > 30,000 ms | > 10,000 ms | `record-age-ms` per partition |
| MirrorMaker 2 task failure | MSK Connect | Any task FAILED | Task restart > 3x in 10 min | Connector status API |
| Consumer group lag (primary) | Kafka Consumer Group API | > 100,000 msgs | > 10,000 msgs | `consumer-lag-sum` |
| Inter-cluster bandwidth | VPC Flow Logs | > 80% provisioned | > 50% provisioned | Gbps utilised |
| Checkpoint sync lag | MM2 internal topic | > 120s | > 60s | `checkpoint-latency-ms` |

### 6.2 Lag Alerting Rules

```yaml
# CloudWatch Alarm: Replication Lag P1
ReplicationLagP1:
  MetricName: MaxLag
  Namespace: AWS/Kafka
  Dimensions:
    - Name: Cluster Name
      Value: paysecure-msk-secondary
  Statistic: Maximum
  Period: 60
  EvaluationPeriods: 2
  Threshold: 30000
  ComparisonOperator: GreaterThanThreshold
  AlarmActions:
    - arn:aws:sns:ap-south-2:ACCOUNT:paysecure-p1-alerts

# CloudWatch Alarm: MM2 Task Failure
MM2TaskFailure:
  MetricName: ConnectorFailedTaskCount
  Namespace: AWS/KafkaConnect
  Dimensions:
    - Name: ConnectorName
      Value: paysecure-mm2-primary-to-secondary
  Statistic: Maximum
  Period: 60
  EvaluationPeriods: 1
  Threshold: 1
  ComparisonOperator: GreaterThanOrEqualToThreshold
  AlarmActions:
    - arn:aws:sns:ap-south-2:ACCOUNT:paysecure-p1-alerts
```

### 6.3 Lag Mitigation Playbook

| Lag Scenario | Root Cause | Mitigation | Time to Resolve |
|-------------|-----------|-----------|-----------------|
| Lag < 30s | Normal burst | Auto-scale MM2 tasks (target: 6 → 12) | 2 min |
| Lag 30s–2 min | Network degradation | Failover to backup PrivateLink; alert NOC | 5 min |
| Lag > 2 min | Primary broker overload | Throttle non-critical producers; scale primary brokers | 10 min |
| Lag > 5 min | Partition rebalancing | Pause MM2; resume after rebalancing completes | 15 min |
| Lag > 10 min | Primary region degradation | Initiate region failover (Runbook RB-001) | 5 min (RTO) |

---

## 7. Failover and Failback Procedures

### 7.1 Planned Failover (Maintenance Window)

**Pre-conditions:**
- Replication lag < 5 seconds
- All consumer offsets synced within last 60 seconds
- Secondary cluster health checks passing

**Steps:**

| Step | Action | Owner | Duration |
|------|--------|-------|----------|
| 1 | Stop all primary producers gracefully | SRE | 30s |
| 2 | Wait for MM2 to drain in-flight messages | Automated | 60s |
| 3 | Verify replication lag = 0 | Automated | 15s |
| 4 | Stop MM2 connector | SRE | 15s |
| 5 | Promote secondary topics: remove `primary.` prefix | Automated script | 30s |
| 6 | Update producer configs to point to secondary brokers | SRE | 30s |
| 7 | Start producers in secondary region | SRE | 30s |
| 8 | Verify end-to-end message flow (synthetic canary) | Automated | 60s |
| 9 | Update Route 53 / service discovery entries | SRE | 30s |
| **Total** | | | **~5 min** |

### 7.2 Unplanned Failover (Primary Region Failure)

**Trigger:** Primary region declared failed (Runbook RB-001)

**Steps:**

| Step | Action | Owner | Duration |
|------|--------|-------|----------|
| 1 | Detect primary failure (health check timeout > 90s) | Automated | 90s |
| 2 | Stop MM2 connector (if still running) | Automated | 15s |
| 3 | Assess replication lag at failure time | Automated | 15s |
| 4 | Promote secondary topics | Automated | 30s |
| 5 | Redirect producers to secondary (DNS + config) | Automated | 60s |
| 6 | Start consumers in secondary with checkpoint offsets | Automated | 30s |
| 7 | Verify message flow | Automated | 60s |
| **Total** | | | **~5 min** |

**Data loss assessment:**
- Messages in-flight on primary at failure time: lost (bounded by producer acks)
- Messages replicated but not checkpointed: may be reprocessed (idempotent consumers handle this)
- Maximum un-replicated window: replication lag at failure time (target < 30s)

### 7.3 Failback to Primary

**Pre-conditions:**
- Primary region fully restored and stable for > 30 minutes
- Replication from secondary → primary established (reverse MM2)

**Steps:**

| Step | Action | Owner | Duration |
|------|--------|-------|----------|
| 1 | Start reverse MM2 (secondary → primary) | SRE | 2 min |
| 2 | Wait for lag < 5s and offset sync complete | Automated | 5–15 min |
| 3 | Stop secondary producers | SRE | 30s |
| 4 | Wait for reverse MM2 drain | Automated | 60s |
| 5 | Stop reverse MM2 | SRE | 15s |
| 6 | Restore original topic names on primary | Automated | 30s |
| 7 | Redirect producers to primary | SRE | 30s |
| 8 | Restart forward MM2 (primary → secondary) | SRE | 2 min |
| 9 | Verify end-to-end flow | Automated | 60s |
| **Total** | | | **~15 min** |

---

## 8. Failure Mode and Effects Analysis (FMEA)

| ID | Failure Mode | Effect | Severity (S) | Likelihood (L) | Detection (D) | RPN | Mitigation |
|----|-------------|--------|-------------|---------------|--------------|-----|-----------|
| K1 | MM2 connector crashes | Replication stops; lag grows | 8 | 3 | 2 | 48 | Auto-restart with backoff; P1 alert; standby connector config ready |
| K2 | Cross-region network partition | Replication interrupted; primary continues | 7 | 2 | 2 | 28 | VPC peering + PrivateLink dual path; automatic path failover |
| K3 | Primary broker disk full | Producer blocking; replication stalls | 8 | 2 | 3 | 48 | 80% disk alert; auto-expansion; retention policy enforcement |
| K4 | Secondary broker failure during failover | Cannot assume primary role | 9 | 2 | 2 | 36 | Min ISR = 2; 6-broker cluster tolerates 2 failures; auto-rebalance |
| K5 | Consumer offset sync corruption | Duplicate or skipped messages on failover | 7 | 2 | 3 | 42 | Offset validation checksum; idempotent consumers; manual offset reset procedure |
| K6 | DLQ overflow | Poison pills consume storage; alert fatigue | 6 | 3 | 2 | 36 | DLQ retention 7 days; auto-aging; P1 on critical DLQ depth |
| K7 | Topic configuration drift | Replication behaviour change; data loss risk | 5 | 3 | 4 | 60 | Config sync enabled; drift detection via Terraform plan; weekly audit |
| K8 | Message size exceeds limit | Producer rejection; transaction failure | 6 | 3 | 2 | 36 | 1 MB message limit enforced; large payload S3 reference pattern |

**Highest RPN:** K7 (60) — Topic configuration drift. Mitigated via infrastructure-as-code and weekly audits.

---

## 9. Compliance Mapping

### 9.1 RBI Master Direction on Payment Systems

| Requirement | Implementation |
|-------------|---------------|
| Real-time transaction logging (§4.2.1) | All payment events published to `paysecure.payments.*` topics with 7-day retention; audit trail in `paysecure.audit.events.v1` (90 days) |
| Log integrity and non-repudiation | Producer idempotency + exactly-once MM2 replication + immutable topic retention |
| DR testing every 6 months (§7.3) | Quarterly DR drills including Kafka failover; documented in Runbook RB-012 |

### 9.2 PCI-DSS v4.0

| Requirement | Implementation |
|-------------|---------------|
| 10.2 — Audit trail coverage | All cardholder data environment (CDE) events flow through `paysecure.audit.events.v1`; replicated to secondary |
| 10.3 — Audit trail integrity | Append-only topics; no update/delete operations; retention enforced by broker |
| 10.5 — Audit trail availability | 90-day retention; secondary cluster ensures availability during primary outage |
| 12.10.1 — Incident response readiness | DLQ topics capture processing failures; P1 alerts enable rapid response |

### 9.3 NPCI UPI Technical Standards

| Requirement | Implementation |
|-------------|---------------|
| Transaction traceability | `transaction_id` in every message header; propagated across all topics |
| 99.99% uptime mandate | Active-passive with < 5 min RTO; Kafka failover within RTO budget |
| Message ordering for UPI mandates | Single partition per `mandate_id` ensures ordering; partition count fixed at 12 |

### 9.4 India Data Localisation

| Requirement | Implementation |
|-------------|---------------|
| Payment data within India | Both primary and secondary clusters in Indian regions (Mumbai, Hyderabad) |
| Cross-border transfer prohibition | No replication outside India; MM2 traffic stays within Indian AWS backbone |
| Audit access for regulators | Read-only IAM roles for RBI/NPCI; topic ACLs enforce access boundaries |

---

## 10. Operational Runbooks

| Runbook ID | Title | Trigger | Link |
|-----------|-------|---------|------|
| RB-001 | Region Failure Failover | Primary region unavailable | `docs/runbooks/RB-001-region-failure.md` |
| RB-004 | Kafka Partition Loss / DLQ Overflow | Partition offline or DLQ threshold breached | `docs/runbooks/RB-004-kafka-partition.md` |
| RB-012 | Full Rollback and Failback | Post-incident restoration to primary | `docs/runbooks/RB-012-full-rollback.md` |

---

## 11. Capacity Planning

### 11.1 Current Load

| Metric | Value |
|--------|-------|
| Peak throughput | 45,000 msgs/sec |
| Average throughput | 12,000 msgs/sec |
| Average message size | 2.5 KB |
| Peak bandwidth | 1.2 Gbps |
| Daily volume | ~3.2 billion messages |

### 11.2 Growth Projections (Q3 2026 – Q3 2027)

| Metric | Q3 2026 | Q3 2027 | Headroom |
|--------|---------|---------|----------|
| Peak throughput | 45,000/s | 75,000/s | 67% |
| Storage per broker | 3 TB | 5 TB | 67% |
| Cross-region bandwidth | 5 Gbps | 10 Gbps | 100% |
| MM2 tasks | 6 | 10 | 67% |

---

## 12. Appendix

### 12.1 MM2 Topic Prefix Reference

| Original Topic | Mirrored Topic |
|---------------|----------------|
| `paysecure.payments.txn-authorised.v1` | `primary.paysecure.payments.txn-authorised.v1` |
| `paysecure.audit.events.v1` | `primary.paysecure.audit.events.v1` |

### 12.2 Consumer Group Offset Translation

```python
# Pseudocode for offset translation on failover
def translate_offset(primary_offset, partition):
    checkpoint = read_checkpoint_topic(
        topic="secondary.checkpoints.internal",
        group="payment-processors",
        partition=partition
    )
    # MM2 stores: primary_offset -> secondary_offset mapping
    return checkpoint.get_nearest_secondary_offset(primary_offset)
```

### 12.3 Revision History

| Version | Date | Author | Changes |
|---------|------|--------|---------|
| 1.0 | 2026-07-20 | Platform Engineering | Initial release |

---

**Document Classification:** Strictly Private and Confidential — Not for Circulation  
**Next Review Date:** 2026-10-20