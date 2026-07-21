# RB-003: Kafka Partition Loss & Recovery

**Version:** 1.0 | **Last Updated:** 2026-07-20 | **Owner:** Data Platform Lead
**Classification:** P1 — Sev 1 | **Expected Recovery Time:** < 10 minutes | **Data Loss Risk:** Low (with replication)

---

## 1. Purpose

This runbook covers recovery from Kafka partition loss scenarios in the MSK cluster, including broker failure, partition leader loss, under-replicated partitions, and complete topic unavailability. It also covers MirrorMaker 2 failure in the cross-region replication path.

## 2. Trigger Conditions

| Trigger | Detection Mechanism | Automatic / Manual |
|---------|---------------------|--------------------|
| `UnderReplicatedPartitions` > 0 for 60s | CloudWatch MSK metric | Automatic — P1 alert |
| `OfflinePartitionsCount` > 0 | CloudWatch MSK metric | Automatic — P1 alert (Sev 0 if critical topic) |
| `ActiveControllerCount` != 1 | CloudWatch MSK metric | Automatic — P1 alert |
| Broker CPU > 90% for 5 min | CloudWatch `CpuUser` + `CpuSystem` | Automatic — P2 → P1 escalation |
| MM2 replication lag > 30s | Custom `MirrorMakerLag` metric | Automatic — P1 alert |
| MM2 connector state != RUNNING | MSK Connect API | Automatic — P1 alert |
| Consumer group lag > 100,000 messages on critical topics | Kafka Consumer Group API | Automatic — P2 alert |
| Producer `NOT_ENOUGH_REPLICAS` errors in application logs | Application error logs | Automatic — P2 alert |
| DLQ depth > 100 messages in 5 min on critical DLQ | Custom CloudWatch metric per DLQ topic | Automatic — P1 alert |
| Inter-cluster bandwidth > 80% provisioned | VPC Flow Logs | Automatic — P2 alert |

**Decision gate:** If `OfflinePartitionsCount` > 0 on a critical topic (`paysecure.payments.*`, `paysecure.fraud.*`), treat as Sev 0 and initiate immediate recovery. For non-critical topics, follow P1 procedure.

## 3. Impact Assessment

| Impact Dimension | Severity | Detail |
|------------------|----------|--------|
| **Event Processing** | High–Critical | Payment events, fraud alerts, and audit events may be delayed or lost if partitions are offline |
| **Revenue** | Medium | Payment authorisation path is synchronous (Aurora-backed); Kafka is asynchronous — revenue impact is indirect |
| **Settlement Delay** | High | Settlement batch events (`paysecure.settlements.*`) delayed; SLA breach if > 30 min |
| **Audit Completeness** | High | `paysecure.audit.events.v1` partition loss creates compliance gap; must backfill from Aurora |
| **Cross-Region DR Readiness** | High | MM2 failure means Hyderabad MSK is stale; region failover (RB-001) would have increased RPO |
| **Consumer Catch-Up Time** | Medium | After recovery, consumers must replay accumulated lag; 5–15 min depending on backlog |
| **Data Loss Risk** | Low | RF=3 with min.insync.replicas=2; data loss only if 2+ brokers fail simultaneously before replication |
| **DLQ Overflow Risk** | Medium | If consumers are down, DLQ topics grow; may require manual replay after recovery |

**Worst-case scenario:** Complete MSK cluster failure in Mumbai. Mitigation: fail over to Hyderabad MSK per RB-001 Phase 6.4.

## 4. Prerequisites

- [ ] AWS CLI with MSK permissions
- [ ] Kafka CLI tools (`kafka-topics`, `kafka-consumer-groups`, `kafka-reassign-partitions`)
- [ ] Access to MSK Connect console for MM2 management
- [ ] Prometheus/Grafana access for broker metrics
- [ ] CloudWatch Logs access for MSK broker logs

## 5. Detection

### 5.1 Automated Alerts

| Alert | Metric | P1 Threshold | P2 Threshold |
|-------|--------|-------------|-------------|
| Under-replicated partitions | `UnderReplicatedPartitions` | > 0 for 60s | > 0 for 30s |
| Offline partitions | `OfflinePartitionsCount` | > 0 | N/A |
| Active controller count | `ActiveControllerCount` | != 1 | N/A |
| Broker CPU > 90% | `CpuUser` + `CpuSystem` | > 90% for 5 min | > 80% for 10 min |
| MM2 replication lag | `MirrorMakerLag` | > 30s | > 10s |

### 5.2 Verification Commands

```bash
# Check cluster health
kafka-broker-api-versions --bootstrap-server b-1.paysecure-msk.abc123.c2.kafka.ap-south-1.amazonaws.com:9098

# List under-replicated partitions
kafka-topics --bootstrap-server b-1.paysecure-msk.abc123.c2.kafka.ap-south-1.amazonaws.com:9098 \
  --describe --under-replicated-partitions

# Check consumer group lag
kafka-consumer-groups --bootstrap-server b-1.paysecure-msk.abc123.c2.kafka.ap-south-1.amazonaws.com:9098 \
  --group payment-processor --describe

# Check MM2 connector status
curl -s https://kafka-connect-hyderabad.example.com/connectors/mm2-source/status | jq .
```

## 6. Scenario A: Single Broker Failure

### 6.1 Assess Impact (Owner: Data Platform Lead | ETA: 2 min)

```bash
# Identify which partitions were on the failed broker
aws kafka list-nodes --cluster-arn arn:aws:kafka:ap-south-1:123456789012:cluster/paysecure-msk/xxx

# Check if partitions have ISR replicas on other brokers
kafka-topics --bootstrap-server b-2.paysecure-msk.abc123.c2.kafka.ap-south-1.amazonaws.com:9098 \
  --describe --topic paysecure-transactions
```

### 6.2 Recovery — Automatic for RF=3 (Owner: Data Platform Lead | ETA: 3 min)

```bash
# MSK automatically elects new leaders from ISR
# Verify leader election completed
kafka-topics --bootstrap-server b-2.paysecure-msk.abc123.c2.kafka.ap-south-1.amazonaws.com:9098 \
  --describe --topic paysecure-transactions | grep -c "Leader: -1"  # Should be 0

# If partitions are stuck without leader:
# 1. Check if min.insync.replicas can be met
# 2. Temporarily reduce min.insync.replicas if needed
kafka-configs --bootstrap-server b-2.paysecure-msk.abc123.c2.kafka.ap-south-1.amazonaws.com:9098 \
  --entity-type topics --entity-name paysecure-transactions \
  --alter --add-config min.insync.replicas=1

# 3. After recovery, restore to original value
kafka-configs --bootstrap-server b-2.paysecure-msk.abc123.c2.kafka.ap-south-1.amazonaws.com:9098 \
  --entity-type topics --entity-name paysecure-transactions \
  --alter --add-config min.insync.replicas=2
```

### 6.3 Replace Failed Broker (Owner: Data Platform Lead / AWS Support | ETA: 10–15 min)

```bash
# AWS MSK automatically replaces failed brokers
# Monitor replacement progress
aws kafka list-nodes --cluster-arn arn:aws:kafka:ap-south-1:123456789012:cluster/paysecure-msk/xxx \
  --query 'NodeInfoList[*].[BrokerNodeInfo.BrokerId,NodeType]'

# Once new broker is active, rebalance partitions
# Generate reassignment plan
kafka-reassign-partitions --bootstrap-server b-1.paysecure-msk.abc123.c2.kafka.ap-south-1.amazonaws.com:9098 \
  --topics-to-move-json-file topics.json \
  --broker-list "1,2,3,4,5,6" \
  --generate
```

## 7. Scenario B: Complete Topic Unavailability

### 7.1 Diagnose (Owner: Data Platform Lead | ETA: 3 min)

```bash
# Check if topic exists
kafka-topics --bootstrap-server b-1.paysecure-msk.abc123.c2.kafka.ap-south-1.amazonaws.com:9098 --list

# Check topic configuration
kafka-topics --bootstrap-server b-1.paysecure-msk.abc123.c2.kafka.ap-south-1.amazonaws.com:9098 \
  --describe --topic paysecure-transactions

# Check broker logs for errors
aws logs filter-log-events \
  --log-group-name /aws/msk/paysecure-msk \
  --filter-pattern "ERROR" \
  --start-time $(date -u -d '10 minutes ago' +%s%3N) \
  --region ap-south-1
```

### 7.2 Recovery Options (Owner: Data Platform Lead | ETA: 5–10 min)

```bash
# Option A: If topic was accidentally deleted, recreate from backup config
kafka-topics --bootstrap-server b-1.paysecure-msk.abc123.c2.kafka.ap-south-1.amazonaws.com:9098 \
  --create --topic paysecure-transactions \
  --partitions 12 --replication-factor 3 \
  --config min.insync.replicas=2 \
  --config retention.ms=604800000 \
  --config cleanup.policy=compact,delete

# Option B: Fail over to Hyderabad MSK (see RB-001 Phase 2.4)
# Consumers must switch to Hyderabad bootstrap servers

# Option C: Replay from DLQ if data loss is acceptable
# See Section 7 for DLQ replay procedure
```

## 8. Scenario C: MirrorMaker 2 Failure

### 8.1 Diagnose MM2 (Owner: Data Platform Lead | ETA: 2 min)

```bash
# Check connector status
curl -s https://kafka-connect-hyderabad.example.com/connectors/mm2-source/status | jq '.tasks[].state'

# Check connector logs
aws logs filter-log-events \
  --log-group-name /aws/msk-connect/mm2-connector \
  --filter-pattern "ERROR|WARN" \
  --start-time $(date -u -d '10 minutes ago' +%s%3N) \
  --region ap-south-2

# Check replication lag
kafka-consumer-groups --bootstrap-server b-1.paysecure-msk-hyd.abc123.c2.kafka.ap-south-2.amazonaws.com:9098 \
  --group mm2-consumer-group --describe
```

### 8.2 Restart MM2 (Owner: Data Platform Lead | ETA: 5 min)

```bash
# Restart the connector
curl -X POST https://kafka-connect-hyderabad.example.com/connectors/mm2-source/restart

# If restart fails, recreate connector
aws kafkaconnect create-connector \
  --connector-name mm2-source-v2 \
  --connector-configuration '{
    "connector.class": "org.apache.kafka.connect.mirror.MirrorSourceConnector",
    "source.cluster.alias": "mumbai",
    "target.cluster.alias": "hyderabad",
    "source.cluster.bootstrap.servers": "b-1.paysecure-msk.abc123.c2.kafka.ap-south-1.amazonaws.com:9098,...",
    "target.cluster.bootstrap.servers": "b-1.paysecure-msk-hyd.abc123.c2.kafka.ap-south-2.amazonaws.com:9098,...",
    "topics": "paysecure-transactions,paysecure-settlements,paysecure-fraud,paysecure-notifications,paysecure-audit,paysecure-dlq-.*",
    "replication.factor": 3,
    "sync.topic.configs.enabled": "true",
    "sync.topic.acls.enabled": "false",
    "emit.heartbeats.enabled": "true",
    "emit.checkpoints.enabled": "true",
    "refresh.topics.interval.seconds": 30,
    "offset-syncs.topic.replication.factor": 3",
    "heartbeats.topic.replication.factor": 3",
    "checkpoints.topic.replication.factor": 3"
  }' \
  --capacity '{"provisionedCapacity": {"mcuCount": 4, "workerCount": 4}}' \
  --region ap-south-2
```

## 9. Dead Letter Queue Recovery

### 9.1 Assess DLQ Depth (Owner: Data Platform Lead | ETA: 2 min)

```bash
# Check DLQ topic sizes
kafka-run-class kafka.tools.GetOffsetShell \
  --bootstrap-server b-1.paysecure-msk.abc123.c2.kafka.ap-south-1.amazonaws.com:9098 \
  --topic paysecure-dlq-payments --time -1

# List DLQ messages (sample)
kafka-console-consumer --bootstrap-server b-1.paysecure-msk.abc123.c2.kafka.ap-south-1.amazonaws.com:9098 \
  --topic paysecure-dlq-payments \
  --from-beginning --max-messages 10
```

### 9.2 DLQ Replay Decision Matrix

| DLQ Topic | Auto-Replay Safe? | Approval Required |
|-----------|-------------------|-------------------|
| `paysecure-dlq-payments` | NO | Payments Lead + Compliance |
| `paysecure-dlq-settlements` | NO | Settlements Lead |
| `paysecure-dlq-fraud` | NO | Fraud Lead |
| `paysecure-dlq-notifications` | YES | None |
| `paysecure-dlq-audit` | YES | None |

### 9.3 Replay Procedure (Owner: Data Platform Lead / Payments Team | ETA: 5–15 min)

```bash
# For safe-to-replay topics:
kafka-console-consumer --bootstrap-server b-1.paysecure-msk.abc123.c2.kafka.ap-south-1.amazonaws.com:9098 \
  --topic paysecure-dlq-notifications --from-beginning \
  | kafka-console-producer --bootstrap-server b-1.paysecure-msk.abc123.c2.kafka.ap-south-1.amazonaws.com:9098 \
  --topic paysecure-notifications

# For payments DLQ: use controlled replay tool with idempotency checks
# This must be done by the payments team with manual verification
```

## 10. Verification Steps

```bash
# 1. All partitions have leaders
kafka-topics --bootstrap-server b-1.paysecure-msk.abc123.c2.kafka.ap-south-1.amazonaws.com:9098 \
  --describe | grep -c "Leader: -1"  # Must be 0

# 2. No under-replicated partitions
kafka-topics --bootstrap-server b-1.paysecure-msk.abc123.c2.kafka.ap-south-1.amazonaws.com:9098 \
  --describe --under-replicated-partitions  # Must be empty

# 3. Consumer lag recovering
kafka-consumer-groups --bootstrap-server b-1.paysecure-msk.abc123.c2.kafka.ap-south-1.amazonaws.com:9098 \
  --group payment-processor --describe

# 4. MM2 replication healthy
curl -s https://kafka-connect-hyderabad.example.com/connectors/mm2-source/status | jq '.connector.state'  # RUNNING

# 5. End-to-end message flow
# Produce test message and verify consumption
echo '{"test": true, "timestamp": "'$(date -u +%Y-%m-%dT%H:%M:%SZ)'"}' | \
  kafka-console-producer --bootstrap-server b-1.paysecure-msk.abc123.c2.kafka.ap-south-1.amazonaws.com:9098 \
  --topic paysecure-test
```

## 11. Rollback Plan

### 11.1 Broker Recovery Rollback

If broker replacement or partition reassignment causes instability:

| Step | Action | Owner | ETA |
|------|--------|-------|-----|
| 1 | Pause all partition reassignment operations | Data Platform Lead | 30s |
| 2 | Revert `min.insync.replicas` to original value (2) if temporarily reduced | Data Platform Lead | 30s |
| 3 | Validate all partitions have leaders | Data Platform Lead | 1 min |
| 4 | Verify consumer groups are stable (no rebalancing storms) | Data Platform Lead | 2 min |
| 5 | If instability persists, fail over consumers to Hyderabad MSK per RB-001 | Incident Commander | 5 min |

### 11.2 MM2 Recovery Rollback

If MM2 restart/recreation causes data corruption in Hyderabad:

| Step | Action | Owner | ETA |
|------|--------|-------|-----|
| 1 | Stop the new MM2 connector immediately | Data Platform Lead | 30s |
| 2 | Verify Hyderabad topic integrity (no duplicate or truncated partitions) | Data Platform Lead | 3 min |
| 3 | If corruption detected, delete affected topics in Hyderabad and re-replicate from Mumbai | Data Platform Lead | 10 min |
| 4 | Restart MM2 from last known good checkpoint | Data Platform Lead | 2 min |
| 5 | Monitor replication lag until stable < 10s | Data Platform Lead | 5 min |

### 11.3 DLQ Replay Rollback

If DLQ replay causes duplicate processing:

| Step | Action | Owner | ETA |
|------|--------|-------|-----|
| 1 | Stop DLQ replay consumer immediately | Data Platform Lead | 30s |
| 2 | Identify duplicate events via `transaction_id` in DynamoDB idempotency table | Payments Team | 5 min |
| 3 | For payments DLQ: escalate to Payments Lead + Compliance for manual review | Incident Commander | — |
| 4 | For safe-to-replay DLQs: verify idempotency before resuming | Data Platform Lead | 2 min |

### 11.4 Prevention Measures

| Measure | Implementation |
|---------|---------------|
| RF=3 for all topics | Enforced via topic creation policy |
| min.insync.replicas=2 | Per-topic configuration |
| Broker monitoring | CloudWatch + Prometheus alerts |
| MM2 health checks | 30s interval with PagerDuty escalation |
| DLQ depth monitoring | P1 alert if DLQ depth > 100 for 5 min |
| Regular partition rebalance | Monthly automated rebalance |

## 12. Compliance References

| Regulation / Standard | Requirement | How This Runbook Satisfies It |
|-----------------------|-------------|-------------------------------|
| **RBI Master Direction §4.2.1** | Real-time transaction logging with integrity and non-repudiation | All payment events published to `paysecure.payments.*` topics with RF=3; producer `acks=all` ensures committed writes; MM2 replicates to Hyderabad for DR |
| **RBI Master Direction §7.3** | DR testing every 6 months; audit trail completeness | Kafka failover tested quarterly (Section 14); `paysecure.audit.events.v1` replicated with 90-day retention; partition loss recovery preserves audit trail |
| **RBI Data Localisation** | Payment data must remain within India | Both MSK clusters in Indian regions (`ap-south-1`, `ap-south-2`); MM2 traffic stays within Indian AWS backbone |
| **PCI-DSS v4.0 Req 10.2** | Audit trail coverage for all CDE events | All cardholder data environment events flow through `paysecure.audit.events.v1`; replicated to Hyderabad; DLQ preserves failed events |
| **PCI-DSS v4.0 Req 10.3** | Audit trail integrity — append-only, no updates/deletes | Kafka topics configured with `cleanup.policy=compact,delete`; immutable message retention; no update/delete operations on audit topics |
| **PCI-DSS v4.0 Req 10.5** | Audit trail availability during incidents | 90-day retention; Hyderabad MSK ensures availability during primary outage; DLQ replay procedure (Section 9) recovers failed audit events |
| **PCI-DSS v4.0 Req 12.10.1** | Incident response readiness for data processing failures | This runbook covers broker failure, partition loss, MM2 failure, and DLQ overflow; P1 alerts enable rapid response |
| **NPCI UPI Technical Standards** | Transaction traceability via `transaction_id` | `transaction_id` in every message header; propagated across all topics; idempotency keys in DynamoDB prevent duplicate processing |
| **NPCI UPI** | 99.99% uptime mandate | Active-passive with < 5 min RTO; Kafka failover to Hyderabad within RTO budget (RB-001 Phase 6.4) |

## 13. Related Runbooks

- RB-001: Complete Region Failure
- RB-002: Database Split-Brain
- RB-010: Network Partition
- RB-011: Partial Regional Degradation

## 14. Test Schedule

| Test Type | Frequency | Owner |
|-----------|-----------|-------|
| Broker kill test (non-prod) | Weekly | Data Platform |
| MM2 failure/recovery drill | Bi-weekly | DR Team |
| DLQ replay drill | Monthly | Payments + Platform |
| Full Kafka chaos experiment | Quarterly | Chaos Team |