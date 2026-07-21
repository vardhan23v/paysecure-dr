# RB-011: Partial Regional Degradation

**Version:** 1.0 | **Last Updated:** 2026-07-20 | **Owner:** SRE Lead
**Classification:** P1 — Sev 1 | **Expected Recovery Time:** < 15 minutes | **Data Loss Risk:** Low–Medium (depends on degraded components)

---

## 1. Purpose

This runbook covers scenarios where the primary region (Mumbai) is partially degraded — some components are failing while others remain healthy. Partial degradation is the most complex failure mode because it requires nuanced decision-making: when is the degradation severe enough to warrant a full region failover, and when should individual components be recovered in-place? This runbook provides a structured triage and decision framework.

## 2. Trigger Conditions

| Trigger | Detection Mechanism | Automatic / Manual |
|---------|---------------------|--------------------|
| Any single P1 alert firing in Mumbai while Mumbai ALB health check is still passing | PagerDuty / CloudWatch | Automatic — triggers triage |
| 2+ P2 alerts firing simultaneously in Mumbai | PagerDuty composite alert | Automatic — P1 escalation |
| Application error rate > 5% but < 50% | APM / CloudWatch | Automatic — P2 → P1 if sustained |
| Aurora writer available but read replicas degraded | CloudWatch `DatabaseConnections` on readers | Automatic — P2 alert |
| DynamoDB throttling (> 10% of requests) | CloudWatch `ThrottledRequests` | Automatic — P1 alert |
| ElastiCache degraded (high latency, evictions) but not down | CloudWatch `CacheHitRate` + `Evictions` | Automatic — P1 alert |
| MSK broker degraded (CPU > 90%, under-replicated) but cluster available | CloudWatch MSK metrics | Automatic — P1 alert |
| EKS node group degraded but cluster operational | Kube-state-metrics | Automatic — P2 → P1 escalation |
| KMS throttling or elevated latency | CloudWatch KMS metrics | Automatic — P2 alert |
| Secrets Manager latency > 100ms | CloudWatch | Automatic — P2 alert |
| WAF rule evaluation latency > 50ms | CloudWatch WAF metrics | Automatic — P2 alert |
| Merchant reports of intermittent failures | Support tickets | Manual — corroborates automated signals |
| Synthetic transaction failure rate > 10% but < 100% | CloudWatch Synthetics | Automatic — P1 alert |

**Decision gate:** The core question is "Is Mumbai still capable of processing payments with acceptable quality?" If YES, recover in-place. If NO, fail over to Hyderabad. The decision matrix in Section 7 provides explicit criteria.

## 3. Impact Assessment

| Impact Dimension | Severity | Detail |
|------------------|----------|--------|
| **Service Availability** | Variable | Depends on which components are degraded; could range from minor latency to partial outage |
| **Revenue** | Medium–High | Intermittent failures → some transactions lost; proportional to error rate |
| **Merchant Experience** | High | Intermittent failures are worse than hard downtime — merchants cannot predict behaviour |
| **End-Customer Experience** | High | Payment failures at checkout → cart abandonment; brand damage |
| **DR Readiness** | Variable | If replication components are degraded, Hyderabad may be stale |
| **Decision Complexity** | Very High | Must decide: recover in-place vs. fail over; wrong decision can worsen the situation |
| **Recovery Complexity** | Medium–High | May require coordinated recovery across multiple components |
| **Data Loss Risk** | Low–Medium | If Aurora writer is degraded but not failed, data may be at risk |

**Worst-case scenario:** Multiple components degraded simultaneously in ways that compound each other (e.g., cache miss spike → DB overload → payment timeouts → retry storm). Mitigation: aggressive circuit-breaking and the decision framework in Section 7.

## 4. Prerequisites

- [ ] Access to all monitoring dashboards (DR Readiness, Incident Response, Merchant Impact)
- [ ] `kubectl` contexts for both EKS clusters
- [ ] AWS CLI with cross-region access
- [ ] PagerDuty incident declared
- [ ] War room bridge open
- [ ] All component runbooks accessible (RB-001 through RB-010)
- [ ] Hyderabad health pre-verified (baseline checks)

## 5. Triage Framework

### 5.1 Component Health Assessment (Owner: SRE | ETA: 3 min)

Run this assessment immediately when partial degradation is detected:

```bash
#!/bin/bash
# triage.sh — Rapid component health assessment

echo "=== TRIAGE: $(date -u +%Y-%m-%dT%H:%M:%SZ) ==="

# 1. ALB / Ingress
echo "--- ALB ---"
curl -s -o /dev/null -w "ALB Health: %{http_code}\n" https://api.paysecure.example.com/health

# 2. EKS
echo "--- EKS ---"
kubectl get nodes --context=eks-mumbai | grep -c "Ready" | xargs echo "Ready nodes:"
kubectl get pods -n production --context=eks-mumbai --field-selector=status.phase!=Running | grep -v "Completed" | wc -l | xargs echo "Non-running pods:"

# 3. Aurora
echo "--- Aurora ---"
aws rds describe-db-clusters --db-cluster-identifier paysecure-aurora-primary --region ap-south-1 \
  --query 'DBClusters[0].[Status,DBClusterMembers[?IsClusterWriter==`true`].DBInstanceIdentifier]'

# 4. DynamoDB
echo "--- DynamoDB ---"
aws cloudwatch get-metric-statistics --region ap-south-1 \
  --namespace AWS/DynamoDB --metric-name ThrottledRequests \
  --dimensions Name=TableName,Value=paysecure-transactions \
  --start-time $(date -u -d '5 minutes ago' +%Y-%m-%dT%H:%M:%SZ) \
  --end-time $(date -u +%Y-%m-%dT%H:%M:%SZ) \
  --period 60 --statistics Sum

# 5. ElastiCache
echo "--- ElastiCache ---"
aws elasticache describe-replication-groups --replication-group-id paysecure-redis-primary --region ap-south-1 \
  --query 'ReplicationGroups[0].Status'

# 6. MSK
echo "--- MSK ---"
aws kafka list-clusters --region ap-south-1 \
  --query 'ClusterInfoList[?ClusterName==`paysecure-msk`].State'

# 7. KMS
echo "--- KMS ---"
aws kms describe-key --key-id alias/paysecure-primary --region ap-south-1 \
  --query 'KeyMetadata.KeyState'

# 8. Secrets Manager
echo "--- Secrets Manager ---"
aws secretsmanager describe-secret --secret-id paysecure/db/primary --region ap-south-1 \
  --query 'Name'

# 9. External Dependencies
echo "--- External ---"
curl -s -o /dev/null -w "NPCI: %{http_code}\n" https://npci-upi.example.com/health
curl -s -o /dev/null -w "Bank GW: %{http_code}\n" https://bank-gateway.example.com/health

# 10. Replication (Hyderabad)
echo "--- Replication ---"
aws cloudwatch get-metric-statistics --region ap-south-2 \
  --namespace AWS/RDS --metric-name AuroraGlobalDBReplicationLag \
  --dimensions Name=DBClusterIdentifier,Value=paysecure-aurora-secondary \
  --start-time $(date -u -d '5 minutes ago' +%Y-%m-%dT%H:%M:%SZ) \
  --end-time $(date -u +%Y-%m-%dT%H:%M:%SZ) \
  --period 60 --statistics Average
```

### 5.2 Component Status Classification

| Status | Definition | Example |
|--------|-----------|---------|
| **GREEN** | Operating normally; all metrics within baseline | Aurora writer available, lag < 1s |
| **YELLOW** | Degraded but functional; elevated latency or error rate | Cache hit rate 75%, DB CPU 85% |
| **RED** | Failed or critically impaired; cannot serve its function | Aurora writer unreachable, KMS key disabled |
| **UNKNOWN** | Cannot determine status (monitoring gap) | Datadog agent not reporting |

## 6. Scenario-Based Recovery

### 6.1 Scenario: Aurora Writer Healthy, Read Replicas Degraded

**Impact:** Write path functional; read-heavy operations (reporting, merchant dashboard) degraded.

```bash
# Recovery: Promote a healthy reader or add a new reader
aws rds create-db-instance \
  --db-instance-identifier paysecure-aurora-reader-3 \
  --db-cluster-identifier paysecure-aurora-primary \
  --db-instance-class db.r6g.xlarge \
  --engine aurora-postgresql \
  --region ap-south-1

# Update application read endpoint to exclude degraded reader
# (Application should have reader endpoint with auto-failover)
```

### 6.2 Scenario: DynamoDB Throttling

**Impact:** Reads/writes to throttled tables fail; idempotency checks, session state affected.

```bash
# Recovery: Increase provisioned capacity or switch to on-demand
aws dynamodb update-table \
  --table-name paysecure-transactions \
  --billing-mode PAY_PER_REQUEST \
  --region ap-south-1

# If already on-demand, check for hot partition
aws dynamodb describe-table \
  --table-name paysecure-transactions \
  --region ap-south-1 \
  --query 'Table.ProvisionedThroughput'
```

### 6.3 Scenario: ElastiCache Degraded (High Latency, Evictions)

**Impact:** Cache-dependent operations slow down; DB load increases.

```bash
# Recovery: See RB-004 for full cache recovery procedures
# Quick mitigation: scale up cache cluster
aws elasticache modify-replication-group \
  --replication-group-id paysecure-redis-primary \
  --cache-node-type cache.r6g.2xlarge \
  --apply-immediately \
  --region ap-south-1

# If scaling doesn't help, flush and warm (RB-004 Section 8)
```

### 6.4 Scenario: MSK Broker Degraded

**Impact:** Event processing delayed; audit events queued; settlement batches delayed.

```bash
# Recovery: See RB-003 for full Kafka recovery procedures
# Quick mitigation: increase broker count
aws kafka update-broker-count \
  --cluster-arn arn:aws:kafka:ap-south-1:123456789012:cluster/paysecure-msk/xxx \
  --current-version <version> \
  --target-number-of-broker-nodes 9 \
  --region ap-south-1
```

### 6.5 Scenario: KMS Throttling

**Impact:** Encryption/decryption operations slow down; all data access affected.

```bash
# Recovery: Request KMS quota increase (AWS Support)
# Short-term: implement client-side caching of KMS responses
# If KMS is completely unavailable, fail over to Hyderabad
# (Hyderabad uses multi-region KMS keys — independent of Mumbai KMS)
```

### 6.6 Scenario: Secrets Manager Latency

**Impact:** Application startup and credential rotation delayed.

```bash
# Recovery: Verify Secrets Manager endpoint is reachable
aws secretsmanager get-secret-value \
  --secret-id paysecure/db/primary \
  --region ap-south-1

# If persistent, applications should use cached secrets
# (SDK-level caching is enabled by default)
```

## 7. Failover Decision Matrix

### 7.1 Automatic Failover Triggers

Fail over to Hyderabad IMMEDIATELY if ANY of these conditions are met:

| Condition | Rationale |
|-----------|-----------|
| Aurora writer unreachable for > 60s | Core transaction database unavailable; cannot process payments |
| DynamoDB error rate > 50% on `transactions` table | Idempotency and session state compromised |
| KMS key `paysecure-primary` disabled or unreachable | All encryption/decryption blocked; all data access fails |
| 3+ components simultaneously RED | Compound failure; recovery in-place unlikely to succeed within RTO |
| Mumbai ALB health check failing (3 consecutive) | External traffic cannot reach Mumbai; effectively a region failure → RB-001 |
| Synthetic transaction failure rate > 50% for 2 min | Customer-facing impact is severe; fail over to restore service |

### 7.2 Manual Failover Considerations

Consider failover (requires Incident Commander decision) if:

| Condition | Consideration |
|-----------|---------------|
| 2 components RED for > 5 min | Recovery may exceed RTO; Hyderabad is ready |
| Any single component RED for > 10 min | Extended degradation erodes merchant confidence |
| Error rate 10–50% sustained for > 5 min | Intermittent failures are worse than clean failover |
| Replication lag < 5s (Hyderabad is current) | Failover cost is low; data loss risk is minimal |
| Peak business hours | Revenue impact of degradation is highest |

### 7.3 Do NOT Fail Over If

| Condition | Rationale |
|-----------|-----------|
| Hyderabad is also degraded | Failover would not improve the situation; recover in-place |
| Replication lag > 30s | Failover would lose > 30s of data; exceeds RPO |
| Only non-critical components affected | Degradation is acceptable; recover in-place |
| Mumbai recovery is imminent (AWS ETA < 5 min) | Failover takes ~5 min; waiting may be faster |
| Split-brain risk is high (network partition) | See RB-010 Section 11; fence writes, do NOT fail over |

### 7.4 Decision Flowchart

```
PARTIAL DEGRADATION DETECTED
│
├── Aurora writer RED? ─── YES ───→ FAIL OVER (RB-001)
│   └── NO
│       ├── KMS key RED? ─── YES ───→ FAIL OVER (RB-001 + RB-007)
│       │   └── NO
│       │       ├── 3+ components RED? ─── YES ───→ FAIL OVER (RB-001)
│       │       │   └── NO
│       │       │       ├── Error rate > 50%? ─── YES ───→ FAIL OVER (RB-001)
│       │       │       │   └── NO
│       │       │       │       ├── Hyderabad healthy AND lag < 5s?
│       │       │       │       │   ├── YES + 2 components RED > 5 min → CONSIDER FAILOVER
│       │       │       │       │   └── NO → RECOVER IN-PLACE
│       │       │       │       └── RECOVER IN-PLACE
│       │       │       └── RECOVER IN-PLACE
│       │       └── RECOVER IN-PLACE
│       └── RECOVER IN-PLACE
```

## 8. In-Place Recovery Procedures

### 8.1 Component-Specific Recovery

For each degraded component, follow the corresponding runbook:

| Component | Primary Runbook | Quick Reference |
|-----------|----------------|-----------------|
| Aurora degradation | RB-002 (split-brain check first) | Add reader; promote if writer degraded |
| DynamoDB throttling | This runbook (Section 6.2) | Switch to on-demand; check hot partitions |
| ElastiCache degradation | RB-004 | Scale up; targeted invalidation; flush if needed |
| MSK degradation | RB-003 | Increase brokers; check under-replicated partitions |
| EKS node issues | RB-009 | Drain nodes; refresh node group |
| KMS issues | RB-007 | Request quota increase; fail over if key disabled |
| Secrets Manager issues | RB-008 | Verify endpoint; use cached secrets |
| DNS issues | RB-005 | Check Route 53; restart CoreDNS |
| Network issues | RB-010 | Check VPC peering; verify security groups |

### 8.2 Coordinated Recovery (Owner: Incident Commander | ETA: 5–15 min)

When multiple components are degraded, coordinate recovery to avoid cascading failures:

```bash
# Recovery order (by dependency):
# 1. Network (VPC peering, DNS) — everything depends on it
# 2. KMS / Secrets Manager — encryption and auth depend on it
# 3. Aurora (database) — source of truth
# 4. ElastiCache (cache) — depends on Aurora for warming
# 5. MSK (events) — depends on Aurora for event sourcing
# 6. EKS (compute) — depends on all above

# After each component recovers, verify before proceeding:
curl -s https://api.paysecure.example.com/health | jq .
```

## 9. Communication Template

```
SEVERITY 1 — PARTIAL REGIONAL DEGRADATION

Mumbai region is experiencing partial degradation affecting the following components:

Affected:
- [Component 1]: [RED/YELLOW] — [Brief description]
- [Component 2]: [RED/YELLOW] — [Brief description]

Healthy:
- [List GREEN components]

Decision: [RECOVER IN-PLACE / FAILING OVER TO HYDERABAD]

Current impact:
- Error rate: [X%]
- Merchant impact: [Description]
- Estimated recovery: [ETA]

If failing over:
- RTO target: < 5 min
- RPO risk: [X seconds of data]
- Hyderabad status: [GREEN / DEGRADED]

War room: [Link]
Incident: [PagerDuty link]
Next update: [Time]
```

## 10. Verification Steps

After in-place recovery:

```bash
# 1. All components GREEN
# Re-run triage.sh (Section 5.1) — all should show GREEN

# 2. Error rate back to baseline
# Check APM dashboard

# 3. Synthetic transactions passing
curl -s -X POST https://api.paysecure.example.com/v1/payments/test \
  -H "Content-Type: application/json" \
  -d '{"amount": 1, "currency": "INR", "test_mode": true}' | jq .

# 4. Replication caught up
aws cloudwatch get-metric-statistics --region ap-south-2 \
  --namespace AWS/RDS --metric-name AuroraGlobalDBReplicationLag \
  --dimensions Name=DBClusterIdentifier,Value=paysecure-aurora-secondary \
  --start-time $(date -u -d '5 minutes ago' +%Y-%m-%dT%H:%M:%SZ) \
  --end-time $(date -u +%Y-%m-%dT%H:%M:%SZ) \
  --period 60 --statistics Average

# 5. No cascading effects
# Check all dependent services are healthy
```

After failover to Hyderabad:

```bash
# Follow RB-001 Phase 5 (Verify Application Health)
# Follow RB-001 Phase 6 (Enable Monitoring)
```

## 11. Rollback Plan

### 11.1 In-Place Recovery Rollback

If in-place recovery actions worsen the situation:

| Step | Action | Owner | ETA |
|------|--------|-------|-----|
| 1 | Stop all recovery actions immediately | Incident Commander | 30s |
| 2 | Re-assess component health (re-run triage.sh) | SRE | 2 min |
| 3 | If situation has deteriorated to RED on critical components, initiate failover per RB-001 | Incident Commander | — |
| 4 | If situation is stable but not improved, escalate to AWS Support | SRE | 5 min |

### 11.2 Post-Failover Stabilisation

After failing over to Hyderabad due to partial degradation:

| Step | Action | Owner | ETA |
|------|--------|-------|-----|
| 1 | Monitor Hyderabad for 30 min to ensure stability | SRE | 30 min |
| 2 | Investigate root cause of Mumbai degradation | SRE + Engineering | Ongoing |
| 3 | Once Mumbai is fully healthy (all components GREEN for 30 min), plan failback per RB-012 | Incident Commander | — |
| 4 | Do NOT rush failback — Hyderabad is stable; Mumbai must be proven healthy | Incident Commander | — |

### 11.3 Prevention Measures

| Measure | Implementation | Owner |
|---------|---------------|-------|
| Composite health scoring | Automated component health aggregation with failover recommendation | SRE |
| Circuit breakers | Application-level circuit breakers prevent cascading failures | Engineering |
| Graceful degradation | Non-critical features disabled automatically under load | Engineering |
| Pre-warmed Hyderabad | Always ready for failover within RTO | Platform |
| Regular partial degradation drills | Simulate component failures and practice decision-making | DR Team |

## 12. Compliance References

| Regulation / Standard | Requirement | How This Runbook Satisfies It |
|-----------------------|-------------|-------------------------------|
| **RBI Master Direction §7.3** | DR procedures must cover partial failures, not just complete outages | This runbook provides a structured triage framework (Section 5) and decision matrix (Section 7) for partial degradation scenarios |
| **RBI Data Localisation** | Payment data must remain within India during degraded operations | All in-place recovery actions stay within Mumbai; failover stays within Indian regions (Hyderabad) |
| **PCI-DSS v4.0 Req 9.5.1.2.1** | Resilience testing of critical security controls under degraded conditions | Partial degradation drills validate that security controls (KMS, WAF, IAM) remain effective when other components are degraded |
| **PCI-DSS v4.0 Req 12.10.1** | Incident response plan must cover a range of scenarios | This runbook covers the full spectrum from single-component degradation to multi-component compound failures |
| **PCI-DSS v4.0 Req 12.10.5** | Alerting and monitoring must continue during degraded operations | Triage framework (Section 5.1) verifies monitoring is functional; Hyderabad monitoring provides redundancy |
| **NPCI UPI Technical Standards** | System must degrade gracefully without data corruption | Decision matrix (Section 7) ensures failover occurs before data integrity is compromised; circuit breakers prevent cascading failures |
| **NPCI UPI** | 99.99% uptime mandate | Failover decision matrix enables rapid (< 5 min) transition to Hyderabad when Mumbai degradation exceeds acceptable thresholds |

## 13. Related Runbooks

- RB-001: Complete Region Failure
- RB-002: Database Split-Brain Recovery
- RB-003: Kafka Partition Loss
- RB-004: Cache Corruption
- RB-005: DNS Failover
- RB-006: Peak-Load Failover
- RB-007: KMS Key Compromise
- RB-008: Secrets Rotation
- RB-009: EKS Node Failure
- RB-010: Network Partition
- RB-012: Full Rollback

## 14. Test Schedule

| Test Type | Frequency | Owner |
|-----------|-----------|-------|
| Single-component degradation drill | Weekly (rotating component) | DR Team |
| Multi-component degradation tabletop | Monthly | SRE Lead |
| Decision matrix validation (simulated) | Monthly | Incident Commander |
| Full partial degradation chaos experiment | Quarterly | Chaos Team |

---

**Document Control:** Review and update after every partial degradation incident or quarterly DR test. Update the decision matrix thresholds based on operational experience.