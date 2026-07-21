# RB-001: Complete Region Failure

**Version:** 1.0 | **Last Updated:** 2026-07-20 | **Owner:** SRE Lead
**Classification:** P1 — Sev 0 | **Expected RTO:** < 5 minutes | **Expected RPO:** < 1 minute

---

## 1. Purpose

This runbook covers the complete loss of the primary AWS region (ap-south-1, Mumbai) due to a catastrophic event (natural disaster, widespread power outage, backbone network partition, or AWS service-wide degradation). The objective is to fail over all services to the secondary region (ap-south-2, Hyderabad) within the 5-minute RTO while preserving the < 1-minute RPO.

## 2. Trigger Conditions

| Trigger | Detection Mechanism | Automatic / Manual |
|---------|---------------------|--------------------|
| Route 53 health check failure on Mumbai ALB | 3 consecutive failures (90s window) | Automatic — DNS failover initiates |
| CloudWatch Synthetics canary failure from 2+ external locations | 3 consecutive failures | Automatic — P1 alert fires |
| EKS control plane unreachable (> 60s timeout) | kubectl / AWS API probes | Manual verification required |
| Cross-region ping from Hyderabad monitoring — 100% packet loss for 30s | Hyderabad → Mumbai ICMP/TCP probes | Automatic — composite alarm |
| PagerDuty "RegionUnreachable" composite alarm | Aggregated signal from all above | Automatic — incident declared |
| AWS Health Dashboard reports service-wide outage in ap-south-1 | `aws health describe-events` | Manual — informs decision to fail over |
| Multiple independent merchant reports of API unavailability | Support ticket volume spike | Manual — corroborates automated signals |

**Decision gate:** Failover is authorised when Mumbai is unreachable from 3+ independent vantage points AND Hyderabad is confirmed healthy. If Hyderabad is also degraded, escalate to RB-011 (Partial Degradation).

## 3. Impact Assessment

| Impact Dimension | Severity | Detail |
|------------------|----------|--------|
| **Revenue** | Critical | All payment processing halted; ~₹X Cr/hour revenue loss |
| **Merchant Experience** | Critical | 100% of merchants unable to process transactions |
| **End-Customer Experience** | Critical | All UPI/card/netbanking payments failing |
| **Settlement Risk** | High | Pending settlement batches delayed; SLA breach if > 2 hours |
| **Regulatory** | High | NPCI UPI availability breach if > 15 min; RBI reporting obligation |
| **Data Loss (RPO)** | Low-Medium | < 1 minute of transaction data at risk (bounded by replication lag) |
| **Reputation** | Critical | Public-facing payment failure; social media and press risk |
| **Recovery Complexity** | High | Full cross-region failover; 14 components to validate |

**Worst-case acceptable downtime:** 5 minutes (RTO). Beyond 5 minutes, invoke executive communication plan.

## 4. Prerequisites

- [ ] IAM credentials with cross-region access to both Mumbai and Hyderabad
- [ ] AWS CLI v2+ configured with profiles for both regions
- [ ] kubectl contexts for both EKS clusters (`eks-mumbai`, `eks-hyderabad`)
- [ ] Access to PagerDuty/Opsgenie for incident declaration
- [ ] Route 53 hosted zone administrative access
- [ ] Aurora Global DB, DynamoDB Global Tables, ElastiCache Global Datastore, and MSK cluster credentials stored in Hyderabad Secrets Manager (pre-replicated)
- [ ] DR runbook printed or accessible offline (in case Mumbai-hosted wiki is unavailable)

## 5. Detection

### 5.1 Automated Detection

| Signal | Source | Threshold |
|--------|--------|-----------|
| CloudWatch Synthetics canary failure | Mumbai region | 3 consecutive failures from 2+ external locations |
| Route 53 health check failure | ap-south-1 endpoint | 2 consecutive failures |
| EKS control plane unreachable | kubectl / AWS API | > 60s timeout |
| Cross-region ping from Hyderabad monitoring | Hyderabad → Mumbai | 100% packet loss for 30s |
| PagerDuty alert: "RegionUnreachable" | Composite alarm | Immediate |

### 5.2 Manual Verification

```bash
# 1. Verify Mumbai region status
aws health describe-events --region us-east-1 --filter '{"services": ["EC2","RDS","EKS","DYNAMODB","ELASTICACHE","MSK"],"regions": ["ap-south-1"]}'

# 2. Check if this is a false alarm — can we reach any Mumbai endpoint?
curl -s -o /dev/null -w "%{http_code}" https://paysecure-api.mumbai.example.com/health

# 3. Verify Hyderabad is healthy
aws eks describe-cluster --name paysecure-hyderabad --region ap-south-2
```

**Decision gate:** If Mumbai is unreachable from 3+ independent vantage points AND Hyderabad is healthy, proceed to failover. If Hyderabad is also degraded, escalate to RB-011 (Partial Degradation).

## 6. Failover Procedure

### Phase 1: Declare Incident (Owner: Incident Commander | ETA: 30s)

```bash
# 1. Create PagerDuty incident — SEV0
# 2. Notify DR coordinator, SRE lead, CTO, and compliance officer
# 3. Start incident timer
# 4. Open war room bridge (Zoom/Chime)
```

### Phase 2: Promote Data Stores (Owner: DB Engineer / SRE | ETA: 90s — parallel execution)

#### 6.1 Aurora PostgreSQL Global DB (Owner: DB Engineer | ETA: 30–60s)

```bash
# Promote secondary cluster to standalone primary
aws rds promote-read-replica-db-cluster \
  --db-cluster-identifier paysecure-aurora-secondary \
  --region ap-south-2

# Wait for promotion (typically 30-60s)
aws rds wait db-cluster-available \
  --db-cluster-identifier paysecure-aurora-secondary \
  --region ap-south-2

# Verify writer endpoint is available
aws rds describe-db-clusters \
  --db-cluster-identifier paysecure-aurora-secondary \
  --region ap-south-2 \
  --query 'DBClusters[0].Status'
```

#### 6.2 DynamoDB Global Tables (Owner: DB Engineer | ETA: 10–20s)

```bash
# Remove Mumbai replica from all global tables
TABLES=("transactions" "merchants" "settlements" "fraud_scores" "audit_log")

for table in "${TABLES[@]}"; do
  aws dynamodb update-global-table \
    --global-table-name "paysecure-${table}" \
    --replica-updates '[{"Delete": {"RegionName": "ap-south-1"}}]' \
    --region ap-south-2
done

# Verify Hyderabad replica is active for all tables
for table in "${TABLES[@]}"; do
  aws dynamodb describe-global-table \
    --global-table-name "paysecure-${table}" \
    --region ap-south-2 \
    --query 'GlobalTableDescription.ReplicationGroup[?RegionName==`ap-south-2`].ReplicaStatus'
done
```

#### 6.3 ElastiCache Global Datastore (Owner: Platform Engineer | ETA: 15–20s)

```bash
# Promote secondary to primary
aws elasticache failover-global-replication-group \
  --global-replication-group-id paysecure-redis-global \
  --primary-region ap-south-2 \
  --primary-replication-group-id paysecure-redis-hyderabad

# Verify promotion
aws elasticache describe-global-replication-groups \
  --global-replication-group-id paysecure-redis-global \
  --region ap-south-2 \
  --query 'GlobalReplicationGroups[0].Members'
```

#### 6.4 MSK / Kafka (Owner: Data Platform Lead | ETA: 20–30s)

```bash
# MM2 is already running in Hyderabad; verify it's healthy
# Check connector status
curl -s "https://kafka-connect-hyderabad.example.com/connectors/mm2-source/status" | jq '.connector.state'

# If MM2 is behind, check consumer lag
# Acceptable: < 30s lag (within RPO budget)
kafka-consumer-groups --bootstrap-server b-1.paysecure-msk-hyd.abc123.c2.kafka.ap-south-2.amazonaws.com:9098 \
  --group mm2-consumer-group \
  --describe
```

### Phase 3: DNS Failover (Owner: SRE / Network Engineer | ETA: 60s)

```bash
# Update Route 53 weighted routing — shift 100% to Hyderabad
aws route53 change-resource-record-sets \
  --hosted-zone-id ZXXXXXXXXXXXX \
  --change-batch '{
    "Changes": [{
      "Action": "UPSERT",
      "ResourceRecordSet": {
        "Name": "api.paysecure.example.com",
        "Type": "A",
        "SetIdentifier": "hyderabad",
        "Weight": 100,
        "AliasTarget": {
          "HostedZoneId": "Z2XXXXXXXXXXXX",
          "DNSName": "paysecure-alb-hyderabad-1234567890.ap-south-2.elb.amazonaws.com",
          "EvaluateTargetHealth": true
        }
      }
    }, {
      "Action": "UPSERT",
      "ResourceRecordSet": {
        "Name": "api.paysecure.example.com",
        "Type": "A",
        "SetIdentifier": "mumbai",
        "Weight": 0,
        "AliasTarget": {
          "HostedZoneId": "Z2XXXXXXXXXXXX",
          "DNSName": "paysecure-alb-mumbai-1234567890.ap-south-1.elb.amazonaws.com",
          "EvaluateTargetHealth": true
        }
      }
    }]
  }'

# Verify DNS propagation (may take 30-60s)
dig api.paysecure.example.com +short
```

### Phase 4: Scale EKS Workloads (Owner: SRE / Platform Engineer | ETA: 90s)

```bash
# Switch kubectl context
kubectl config use-context eks-hyderabad

# Scale up critical deployments to production capacity
kubectl scale deployment payment-gateway -n production --replicas=6
kubectl scale deployment fraud-engine -n production --replicas=4
kubectl scale deployment settlement-service -n production --replicas=3
kubectl scale deployment notification-service -n production --replicas=2
kubectl scale deployment api-gateway -n production --replicas=6

# Wait for all pods to be ready
kubectl wait --for=condition=ready pod \
  -l app.kubernetes.io/part-of=paysecure \
  -n production \
  --timeout=120s

# Verify all deployments
kubectl get deployments -n production
```

### Phase 5: Verify Application Health (Owner: SRE | ETA: 30s)

```bash
# 1. Health endpoint
curl -s https://api.paysecure.example.com/health | jq .

# 2. Database connectivity
curl -s https://api.paysecure.example.com/health/db | jq .

# 3. Cache connectivity
curl -s https://api.paysecure.example.com/health/cache | jq .

# 4. Kafka connectivity
curl -s https://api.paysecure.example.com/health/kafka | jq .

# 5. Synthetic transaction test
curl -s -X POST https://api.paysecure.example.com/v1/payments/test \
  -H "Content-Type: application/json" \
  -d '{"amount": 1, "currency": "INR", "test_mode": true}' | jq .
```

### Phase 6: Enable Monitoring (Owner: SRE | ETA: 30s)

```bash
# Verify CloudWatch dashboards are receiving Hyderabad metrics
aws cloudwatch describe-alarms \
  --region ap-south-2 \
  --query 'MetricAlarms[?StateValue==`OK`].AlarmName'

# Verify Datadog agent is reporting from Hyderabad EKS
kubectl get pods -n datadog -o wide

# Enable synthetic canaries from Hyderabad
aws synthetics start-canary --name paysecure-canary-hyderabad --region ap-south-2
```

## 7. Verification Steps

| Check | Command / Method | Expected |
|-------|-----------------|----------|
| All pods running | `kubectl get pods -n production` | All Ready 1/1 |
| Aurora writer available | `aws rds describe-db-clusters` | Status: available |
| DynamoDB tables writable | Application health endpoint | 200 OK |
| Redis cache accepting writes | Application health endpoint | 200 OK |
| Kafka consumers active | `kafka-consumer-groups --describe` | No LAG > 0 |
| SSL certificate valid | Browser / curl | Valid, no warnings |
| KMS keys accessible | `aws kms describe-key` | Enabled |
| Secrets readable | `aws secretsmanager get-secret-value` | Success |
| Payment flow end-to-end | Synthetic transaction | 201 Created |
| Settlement batch triggered | Settlement service logs | Batch started |

## 8. Communication Template

```
SEVERITY 0 — REGION FAILOVER ACTIVATED

Primary region (ap-south-1, Mumbai) is unreachable.
Failover to secondary region (ap-south-2, Hyderabad) has been initiated.

Status:
- Aurora Global DB: [PROMOTED / IN PROGRESS]
- DynamoDB Global Tables: [FAILED OVER / IN PROGRESS]
- ElastiCache: [PROMOTED / IN PROGRESS]
- MSK: [ACTIVE / IN PROGRESS]
- DNS: [ROUTED / IN PROGRESS]
- EKS: [SCALED / IN PROGRESS]

Current RTO: [Xm Ys]
Estimated full recovery: [ETA]

War room: [Link]
Incident: [PagerDuty link]
Next update: [Time]
```

## 9. Rollback Plan (Failback to Mumbai)

### 9.1 Preconditions for Rollback

- [ ] Mumbai region confirmed healthy and stable for ≥ 30 minutes (all AWS services green)
- [ ] Mumbai EKS cluster, Aurora, DynamoDB, ElastiCache, and MSK validated
- [ ] Change window approved; stakeholders notified
- [ ] Rollback runbook RB-012 reviewed by Incident Commander

### 9.2 Rollback Procedure Summary

| Step | Action | Owner | ETA |
|------|--------|-------|-----|
| 1 | Validate Mumbai infrastructure health (all 14 components) | SRE | 5 min |
| 2 | Take pre-failback snapshot of Hyderabad Aurora (safety checkpoint) | DB Engineer | 2 min |
| 3 | Re-establish Aurora Global DB: Mumbai primary, Hyderabad secondary | DB Engineer | 5 min |
| 4 | Wait for initial Aurora sync; verify lag < 5s | DB Engineer | 10–30 min |
| 5 | Reverse-replicate DynamoDB (Hyderabad → Mumbai) | DB Engineer | 5 min |
| 6 | Reverse-replicate ElastiCache (Hyderabad → Mumbai) | Platform Engineer | 2 min |
| 7 | Reverse MM2 replication (Hyderabad → Mumbai MSK) | Data Platform Lead | 5 min |
| 8 | Shift DNS back to Mumbai: weighted 10% → 50% → 100% over 5 min | SRE | 5 min |
| 9 | Validate transaction processing in Mumbai | SRE | 2 min |
| 10 | Scale Hyderabad EKS back to baseline standby | SRE | 2 min |
| 11 | Scale Hyderabad Aurora back to 2 readers | DB Engineer | 2 min |
| 12 | Announce failback complete; close incident | Incident Commander | — |

**Total rollback time:** ~40–60 minutes (dominated by Aurora initial sync).

### 9.3 Rollback Abort Criteria

- Mumbai health checks fail during validation (Step 1)
- Aurora sync lag does not stabilise < 5s within 30 min (Step 4)
- Any data consistency check fails
- New incident declared in Hyderabad during rollback

For the complete detailed failback procedure, see **RB-012: Full Rollback**.

## 10. Failure Modes & Contingencies

| Failure | Contingency |
|---------|-------------|
| Aurora promotion fails | Escalate to RB-002 (Split-Brain); manually promote via snapshot restore |
| DynamoDB replica removal fails | Proceed with Hyderabad-only writes; Mumbai replica will be stale and must be reconciled later |
| ElastiCache promotion fails | Bootstrap fresh cache from Aurora; accept cold-cache latency for 5-10 min |
| MSK MM2 has > 30s lag | Accept data loss within RPO; replay from DLQ after failover |
| DNS propagation delayed | Use lower TTL (30s pre-set); if still delayed, distribute ALB IP directly to critical clients |
| EKS scale-up fails | Over-provision Hyderabad to 50% capacity at all times (warm standby) |
| KMS key inaccessible | Use Hyderabad-local KMS keys (pre-provisioned); see RB-007 |

## 11. Compliance References

| Regulation / Standard | Requirement | How This Runbook Satisfies It |
|-----------------------|-------------|-------------------------------|
| **RBI Master Direction on Payment Systems §7.3** | DR drills every 6 months; all failover steps logged for audit | Quarterly production failover tests (Section 13); every CLI command in this runbook produces audit trails via CloudTrail |
| **RBI Data Localisation** | All payment system data must reside within India | Failover is intra-India only: Mumbai (`ap-south-1`) → Hyderabad (`ap-south-2`); no cross-border data transfer |
| **PCI-DSS v4.0 Req 9.5.1.2.1** | Resilience testing of critical security controls | Failover procedure validates KMS key availability, Secrets Manager access, and WAF rule parity in Hyderabad (Phase 5) |
| **PCI-DSS v4.0 Req 12.10.1** | Incident response plan must be activated and followed | This runbook IS the incident response plan for region failure; Phase 1 declares SEV0 and opens war room |
| **PCI-DSS v4.0 Req 12.10.5** | Alerting and monitoring must continue during incident | Phase 6 ensures Hyderabad CloudWatch alarms, X-Ray, and PagerDuty routing are active before declaring recovery |
| **NPCI UPI Technical Standards** | UPI system availability; notify NPCI within 15 min of region change | RTO < 5 min ensures UPI-linked services resume within acceptable window; communication template (Section 8) covers NPCI notification |
| **India Data Localisation (MeitY guidelines)** | Sensitive personal and payment data must not leave Indian territory | All replication and failover traffic stays within Indian AWS regions; verified in Phase 5 validation |
| **PCI-DSS v4.0 Req 10.2–10.3** | Audit trail integrity and coverage during incident | CloudTrail enabled in both regions; audit log replication verified in Phase 6; forensic evidence preserved per Section 10 |

## 12. Related Runbooks

- RB-002: Database Split-Brain Recovery
- RB-005: DNS Failover (detailed)
- RB-007: KMS Key Compromise
- RB-008: Secrets Rotation
- RB-011: Partial Regional Degradation
- RB-012: Full Rollback

## 13. Test Schedule

| Test Type | Frequency | Owner |
|-----------|-----------|-------|
| Tabletop walkthrough | Monthly | SRE Lead |
| Simulated failover (non-prod) | Bi-weekly | DR Team |
| Production failover test | Quarterly | CTO + SRE Lead |
| Chaos experiment (region isolation) | Quarterly | Chaos Engineering Team |

---

**Document Control:** Review and update after every production failover test or actual incident.