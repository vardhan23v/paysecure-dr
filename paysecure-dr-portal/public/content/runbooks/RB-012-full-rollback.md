# RB-012: Full Rollback (Failback to Primary Region)

**Version:** 1.0 | **Last Updated:** 2026-07-20 | **Owner:** Incident Commander / DR Coordinator
**Classification:** P2 — Planned Maintenance | **Expected Duration:** 40–60 minutes | **Data Loss Risk:** None (controlled procedure)

---

## 1. Purpose

This runbook provides the complete, coordinated procedure for failing back from the secondary region (Hyderabad, `ap-south-2`) to the primary region (Mumbai, `ap-south-1`) after a DR event. It integrates and sequences the rollback procedures from all prior runbooks (RB-001 through RB-011) into a single, end-to-end workflow. This is a planned, controlled operation — NOT an emergency procedure.

## 2. When to Use This Runbook

| Trigger | Description |
|---------|-------------|
| Post-RB-001 failover | Region failed over to Hyderabad; Mumbai has recovered and is stable |
| Post-RB-002 split-brain | Split-brain resolved; Mumbai re-established as authoritative |
| Post-RB-011 partial degradation | Mumbai degraded, failed over to Hyderabad; Mumbai fully recovered |
| Scheduled DR test | Quarterly production failover test — planned failback |
| Chaos experiment conclusion | Region isolation experiment complete; return to normal operations |

## 3. Prerequisites (Failback Gate)

**ALL of the following must be confirmed before starting failback:**

- [ ] Mumbai region confirmed healthy and stable for ≥ 30 continuous minutes
- [ ] Mumbai ALB health checks passing (3+ consecutive successes)
- [ ] Mumbai EKS cluster operational (control plane + all node groups `Active`)
- [ ] Mumbai Aurora cluster available (will be reconfigured during failback)
- [ ] Mumbai DynamoDB tables accessible
- [ ] Mumbai ElastiCache cluster available
- [ ] Mumbai MSK cluster available
- [ ] Mumbai KMS keys accessible and enabled
- [ ] Mumbai Secrets Manager secrets accessible
- [ ] Mumbai WAF WebACL attached and rules current
- [ ] Mumbai CloudWatch alarms active and receiving metrics
- [ ] Cross-region VPC peering active (both directions)
- [ ] Change window approved by CTO or DR Coordinator
- [ ] All stakeholders notified (merchants, NPCI, internal teams)
- [ ] Hyderabad currently serving production traffic and stable
- [ ] Rollback team assembled: Incident Commander, DB Engineer, Platform Engineer, SRE, Data Platform Lead, Network Engineer
- [ ] All prior runbooks reviewed and accessible

**If any prerequisite fails, DO NOT proceed. Investigate and resolve before continuing.**

## 4. Impact Assessment

| Impact Dimension | Severity | Detail |
|------------------|----------|--------|
| **Service Availability** | Low | Hyderabad continues serving traffic during most of the failback; brief DNS cutover at the end |
| **Revenue** | Low | No downtime expected; at most a brief (< 30s) DNS propagation delay |
| **Merchant Experience** | None–Low | Transparent if done correctly; merchants may notice slightly elevated latency during data sync |
| **Data Integrity** | Critical (during procedure) | Must ensure no data loss during replication reversal; all steps are verified |
| **Recovery Complexity** | High | 14 components to coordinate; 12-step procedure; multiple verification gates |
| **Duration** | 40–60 min | Dominated by Aurora initial sync (10–30 min); other steps are parallelised |
| **Rollback Risk** | Low | Each step has an abort criterion; can revert to Hyderabad at any point before DNS cutover |

## 5. Pre-Failback Checklist

### 5.1 Validate Mumbai Infrastructure (Owner: SRE | ETA: 5 min)

```bash
#!/bin/bash
# pre-failback-validation.sh

echo "=== PRE-FAILBACK VALIDATION: $(date -u +%Y-%m-%dT%H:%M:%SZ) ==="
FAIL=0

# 1. ALB health
echo -n "ALB Health: "
HTTP_CODE=$(curl -s -o /dev/null -w "%{http_code}" https://paysecure-mumbai.example.com/health)
if [ "$HTTP_CODE" = "200" ]; then echo "PASS"; else echo "FAIL ($HTTP_CODE)"; FAIL=1; fi

# 2. EKS cluster
echo -n "EKS Cluster: "
STATUS=$(aws eks describe-cluster --name paysecure-mumbai --region ap-south-1 --query 'cluster.status' --output text)
if [ "$STATUS" = "ACTIVE" ]; then echo "PASS"; else echo "FAIL ($STATUS)"; FAIL=1; fi

# 3. EKS nodes
echo -n "EKS Nodes: "
READY=$(kubectl get nodes --context=eks-mumbai --no-headers | grep -c "Ready")
TOTAL=$(kubectl get nodes --context=eks-mumbai --no-headers | wc -l)
if [ "$READY" -eq "$TOTAL" ] && [ "$TOTAL" -gt 0 ]; then echo "PASS ($READY/$TOTAL)"; else echo "FAIL ($READY/$TOTAL)"; FAIL=1; fi

# 4. Aurora
echo -n "Aurora Cluster: "
AURORA_STATUS=$(aws rds describe-db-clusters --db-cluster-identifier paysecure-aurora-primary --region ap-south-1 --query 'DBClusters[0].Status' --output text)
if [ "$AURORA_STATUS" = "available" ]; then echo "PASS"; else echo "FAIL ($AURORA_STATUS)"; FAIL=1; fi

# 5. DynamoDB
echo -n "DynamoDB: "
DDB_STATUS=$(aws dynamodb describe-table --table-name paysecure-transactions --region ap-south-1 --query 'Table.TableStatus' --output text)
if [ "$DDB_STATUS" = "ACTIVE" ]; then echo "PASS"; else echo "FAIL ($DDB_STATUS)"; FAIL=1; fi

# 6. ElastiCache
echo -n "ElastiCache: "
EC_STATUS=$(aws elasticache describe-replication-groups --replication-group-id paysecure-redis-primary --region ap-south-1 --query 'ReplicationGroups[0].Status' --output text)
if [ "$EC_STATUS" = "available" ]; then echo "PASS"; else echo "FAIL ($EC_STATUS)"; FAIL=1; fi

# 7. MSK
echo -n "MSK Cluster: "
MSK_STATUS=$(aws kafka list-clusters --region ap-south-1 --query 'ClusterInfoList[?ClusterName==`paysecure-msk`].State' --output text)
if [ "$MSK_STATUS" = "ACTIVE" ]; then echo "PASS"; else echo "FAIL ($MSK_STATUS)"; FAIL=1; fi

# 8. KMS
echo -n "KMS Key: "
KMS_STATUS=$(aws kms describe-key --key-id alias/paysecure-primary --region ap-south-1 --query 'KeyMetadata.KeyState' --output text)
if [ "$KMS_STATUS" = "Enabled" ]; then echo "PASS"; else echo "FAIL ($KMS_STATUS)"; FAIL=1; fi

# 9. Secrets Manager
echo -n "Secrets Manager: "
SECRET_ARN=$(aws secretsmanager describe-secret --secret-id paysecure/db/primary --region ap-south-1 --query 'ARN' --output text 2>/dev/null)
if [ -n "$SECRET_ARN" ]; then echo "PASS"; else echo "FAIL"; FAIL=1; fi

# 10. VPC Peering
echo -n "VPC Peering: "
PEERING_STATUS=$(aws ec2 describe-vpc-peering-connections --filters "Name=status-code,Values=active" --region ap-south-1 --query 'length(VpcPeeringConnections)' --output text)
if [ "$PEERING_STATUS" -gt 0 ]; then echo "PASS ($PEERING_STATUS active)"; else echo "FAIL"; FAIL=1; fi

# 11. Hyderabad current status
echo -n "Hyderabad serving: "
HYD_HEALTH=$(curl -s -o /dev/null -w "%{http_code}" https://api.paysecure.example.com/health)
if [ "$HYD_HEALTH" = "200" ]; then echo "PASS (Hyderabad healthy)"; else echo "WARN (Hyderabad health: $HYD_HEALTH)"; fi

echo ""
if [ "$FAIL" -eq 0 ]; then
  echo "=== ALL CHECKS PASSED — Ready for failback ==="
else
  echo "=== SOME CHECKS FAILED — DO NOT PROCEED ==="
fi
```

### 5.2 Notify Stakeholders (Owner: Incident Commander | ETA: 2 min)

```
PLANNED MAINTENANCE — FAILBACK TO PRIMARY REGION

PaySecure will fail back from Hyderabad (ap-south-2) to Mumbai (ap-south-1).

Window: [Start Time] — [End Time] (estimated 40–60 min)
Impact: No downtime expected. Brief DNS propagation delay (< 30s) at cutover.
Risk: Low. Hyderabad remains available throughout most of the procedure.

Timeline:
- T+0:  Pre-failback validation
- T+5:  Aurora Global DB re-establishment (Mumbai primary)
- T+15: DynamoDB reverse replication
- T+20: ElastiCache reverse replication
- T+25: MSK reverse replication
- T+30: DNS weighted shift (10% → 50% → 100%)
- T+35: Full validation
- T+40: Hyderabad scale-down
- T+45: All-clear announcement

Contacts:
- Incident Commander: [Name / Phone]
- DR Coordinator: [Name / Phone]
- On-call SRE: [Name / Phone]
```

## 6. Failback Procedure

### Phase 1: Pre-Failback Safety Snapshot (Owner: DB Engineer | ETA: 2 min)

```bash
# Take a safety snapshot of Hyderabad Aurora before any changes
# This is the rollback point if failback goes wrong
aws rds create-db-cluster-snapshot \
  --db-cluster-identifier paysecure-aurora-secondary \
  --db-cluster-snapshot-identifier paysecure-pre-failback-$(date +%Y%m%d-%H%M%S) \
  --region ap-south-2

echo "Safety snapshot created. Rollback point secured."
```

### Phase 2: Re-establish Aurora Global DB — Mumbai Primary (Owner: DB Engineer | ETA: 10–30 min)

> **Reference:** RB-001 Section 9.2 (Rollback Procedure Summary), RB-002 Section 11 (Rollback Plan)

```bash
# Step 1: Verify Hyderabad Aurora is the current writer
aws rds describe-db-clusters \
  --db-cluster-identifier paysecure-aurora-secondary \
  --region ap-south-2 \
  --query 'DBClusters[0].DBClusterMembers[?IsClusterWriter==`true`].DBInstanceIdentifier'

# Step 2: If Mumbai Aurora was previously promoted (during failover), 
# it may still think it's a primary. Demote it first.
# Check Mumbai cluster status
aws rds describe-db-clusters \
  --db-cluster-identifier paysecure-aurora-primary \
  --region ap-south-1 \
  --query 'DBClusters[0].[Status,DBClusterMembers[?IsClusterWriter==`true`].DBInstanceIdentifier]'

# If Mumbai has a writer, it must be demoted before re-establishing Global DB
# Delete the Mumbai cluster (it will be recreated from Hyderabad)
aws rds create-db-cluster-snapshot \
  --db-cluster-identifier paysecure-aurora-primary \
  --db-cluster-snapshot-identifier paysecure-mumbai-pre-failback-$(date +%Y%m%d-%H%M%S) \
  --region ap-south-1

aws rds delete-db-cluster \
  --db-cluster-identifier paysecure-aurora-primary \
  --skip-final-snapshot \
  --region ap-south-1

# Wait for deletion
aws rds wait db-cluster-deleted \
  --db-cluster-identifier paysecure-aurora-primary \
  --region ap-south-1

# Step 3: Recreate Mumbai as secondary in Global DB, replicating from Hyderabad
aws rds create-db-cluster \
  --db-cluster-identifier paysecure-aurora-primary \
  --source-db-cluster-identifier arn:aws:rds:ap-south-2:123456789012:cluster:paysecure-aurora-secondary \
  --region ap-south-1

# Step 4: Wait for Mumbai cluster to be available
aws rds wait db-cluster-available \
  --db-cluster-identifier paysecure-aurora-primary \
  --region ap-south-1

# Step 5: Add reader instances to Mumbai
aws rds create-db-instance \
  --db-instance-identifier paysecure-aurora-primary-reader-1 \
  --db-cluster-identifier paysecure-aurora-primary \
  --db-instance-class db.r6g.xlarge \
  --engine aurora-postgresql \
  --region ap-south-1

# Step 6: Monitor replication lag until stable < 5s
echo "Monitoring replication lag... (this may take 10-30 minutes)"
while true; do
  LAG=$(aws cloudwatch get-metric-statistics --region ap-south-1 \
    --namespace AWS/RDS --metric-name AuroraGlobalDBReplicationLag \
    --dimensions Name=DBClusterIdentifier,Value=paysecure-aurora-primary \
    --start-time $(date -u -d '2 minutes ago' +%Y-%m-%dT%H:%M:%SZ) \
    --end-time $(date -u +%Y-%m-%dT%H:%M:%SZ) \
    --period 60 --statistics Average \
    --query 'Datapoints[-1].Average' --output text)
  
  if [ -z "$LAG" ] || [ "$LAG" = "None" ]; then
    LAG=0
  fi
  
  echo "$(date -u +%H:%M:%S) — Replication lag: ${LAG}ms"
  
  if [ "$(echo "$LAG < 5000" | bc -l 2>/dev/null || echo 0)" = "1" ]; then
    echo "Replication lag stable < 5s. Proceeding."
    break
  fi
  sleep 30
done

# Step 7: Perform planned switchover — promote Mumbai to primary
aws rds promote-read-replica-db-cluster \
  --db-cluster-identifier paysecure-aurora-primary \
  --region ap-south-1

# Wait for promotion
aws rds wait db-cluster-available \
  --db-cluster-identifier paysecure-aurora-primary \
  --region ap-south-1

# Step 8: Re-establish Hyderabad as secondary
# Delete and recreate Hyderabad as secondary from Mumbai
aws rds delete-db-cluster \
  --db-cluster-identifier paysecure-aurora-secondary \
  --skip-final-snapshot \
  --region ap-south-2

aws rds wait db-cluster-deleted \
  --db-cluster-identifier paysecure-aurora-secondary \
  --region ap-south-2

aws rds create-db-cluster \
  --db-cluster-identifier paysecure-aurora-secondary \
  --source-db-cluster-identifier arn:aws:rds:ap-south-1:123456789012:cluster:paysecure-aurora-primary \
  --region ap-south-2

echo "Aurora Global DB re-established: Mumbai primary → Hyderabad secondary"
```

**Abort criteria (Phase 2):**
- Mumbai Aurora fails to create or become available
- Replication lag does not stabilise < 5s within 30 min
- Any error during promotion

### Phase 3: Reverse DynamoDB Replication (Owner: DB Engineer | ETA: 5 min)

> **Reference:** RB-001 Section 6.2 (DynamoDB Global Tables), RB-002 Section 8 (DynamoDB Split-Brain)

```bash
# During failover, Mumbai replicas may have been removed from Global Tables
# Re-add Mumbai as a replica to all Global Tables

TABLES=("transactions" "merchants" "settlements" "fraud_scores" "audit_log")

for table in "${TABLES[@]}"; do
  echo "Adding Mumbai replica to paysecure-${table}..."
  aws dynamodb update-global-table \
    --global-table-name "paysecure-${table}" \
    --replica-updates "[{\"Create\": {\"RegionName\": \"ap-south-1\"}}]" \
    --region ap-south-2
done

# Wait for all replicas to become active
echo "Waiting for DynamoDB replicas to become active..."
for table in "${TABLES[@]}"; do
  while true; do
    STATUS=$(aws dynamodb describe-global-table \
      --global-table-name "paysecure-${table}" \
      --region ap-south-2 \
      --query 'GlobalTableDescription.ReplicationGroup[?RegionName==`ap-south-1`].ReplicaStatus' \
      --output text)
    echo "  paysecure-${table}: ${STATUS}"
    if [ "$STATUS" = "ACTIVE" ]; then break; fi
    sleep 10
  done
done

echo "DynamoDB Global Tables: Mumbai replica active on all tables"
```

**Abort criteria (Phase 3):**
- Any table fails to add Mumbai replica
- Replica status does not reach ACTIVE within 10 min

### Phase 4: Reverse ElastiCache Replication (Owner: Platform Engineer | ETA: 3 min)

> **Reference:** RB-001 Section 6.3 (ElastiCache Global Datastore), RB-004 Section 13.2 (Cache Failover Rollback)

```bash
# During failover, Hyderabad was promoted to primary
# Re-establish Global Datastore with Mumbai as primary

# Step 1: Verify Hyderabad is current primary
aws elasticache describe-global-replication-groups \
  --global-replication-group-id paysecure-redis-global \
  --region ap-south-2 \
  --query 'GlobalReplicationGroups[0].Members'

# Step 2: Fail back to Mumbai
aws elasticache failover-global-replication-group \
  --global-replication-group-id paysecure-redis-global \
  --primary-region ap-south-1 \
  --primary-replication-group-id paysecure-redis-primary

# Step 3: Wait for failover to complete
aws elasticache wait replication-group-available \
  --replication-group-id paysecure-redis-primary \
  --region ap-south-1

# Step 4: Verify Mumbai is now primary
aws elasticache describe-global-replication-groups \
  --global-replication-group-id paysecure-redis-global \
  --region ap-south-1 \
  --query 'GlobalReplicationGroups[0].Members[?Role==`PRIMARY`].ReplicationGroupId'

# Step 5: Prime Mumbai cache with hot keys from Hyderabad
# See RB-004 Section 10.2 (Failover Priming) — reverse direction
echo "Priming Mumbai cache with hot keys..."
# (Run cache warming script — see RB-004 Section 10)

echo "ElastiCache Global Datastore: Mumbai primary, Hyderabad secondary"
```

**Abort criteria (Phase 4):**
- Failover command fails
- Mumbai cluster does not become available within 5 min

### Phase 5: Reverse MSK Replication (Owner: Data Platform Lead | ETA: 5 min)

> **Reference:** RB-001 Section 6.4 (MSK), RB-003 Section 8 (MirrorMaker 2)

```bash
# During failover, consumers switched to Hyderabad MSK
# Re-establish MM2 replication: Mumbai → Hyderabad

# Step 1: Verify Hyderabad MSK is healthy and consumers are active
kafka-consumer-groups --bootstrap-server b-1.paysecure-msk-hyd.abc123.c2.kafka.ap-south-2.amazonaws.com:9098 \
  --group payment-processor --describe

# Step 2: Verify Mumbai MSK is healthy
kafka-broker-api-versions --bootstrap-server b-1.paysecure-msk.abc123.c2.kafka.ap-south-1.amazonaws.com:9098

# Step 3: If MM2 was running Hyderabad → Mumbai during failover, stop it
# (We need to reverse direction)
curl -X DELETE https://kafka-connect-mumbai.example.com/connectors/mm2-reverse-source

# Step 4: Recreate MM2 connector: Mumbai → Hyderabad
# (MM2 should already be configured in this direction as the normal state)
# If it was stopped or deleted, recreate per RB-003 Section 8.2

curl -s https://kafka-connect-hyderabad.example.com/connectors/mm2-source/status | jq '.connector.state'

# If not RUNNING, restart:
curl -X POST https://kafka-connect-hyderabad.example.com/connectors/mm2-source/restart

# Step 5: Verify replication lag
kafka-consumer-groups --bootstrap-server b-1.paysecure-msk-hyd.abc123.c2.kafka.ap-south-2.amazonaws.com:9098 \
  --group mm2-consumer-group --describe

echo "MSK replication: Mumbai → Hyderabad (normal direction restored)"
```

**Abort criteria (Phase 5):**
- Mumbai MSK not reachable
- MM2 connector fails to start
- Replication lag > 30s sustained for 5 min

### Phase 6: Scale Mumbai EKS to Production Capacity (Owner: SRE | ETA: 3 min)

> **Reference:** RB-001 Phase 4 (Scale EKS Workloads), RB-009 Section 7 (Node Recovery)

```bash
# Switch to Mumbai context
kubectl config use-context eks-mumbai

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

# Update application connection strings to Mumbai endpoints
kubectl set env deployment/payment-gateway -n production \
  DB_HOST=paysecure-aurora-primary.cluster-xxx.ap-south-1.rds.amazonaws.com \
  REDIS_HOST=paysecure-redis-primary.xxx.ng.0001.aps1.cache.amazonaws.com \
  KAFKA_BOOTSTRAP=b-1.paysecure-msk.abc123.c2.kafka.ap-south-1.amazonaws.com:9098

# Rolling restart to pick up new endpoints
kubectl rollout restart deployment/payment-gateway -n production
kubectl rollout restart deployment/fraud-engine -n production
kubectl rollout restart deployment/settlement-service -n production
kubectl rollout restart deployment/notification-service -n production
kubectl rollout restart deployment/api-gateway -n production

# Wait for rollout to complete
kubectl rollout status deployment/payment-gateway -n production --timeout=120s
kubectl rollout status deployment/fraud-engine -n production --timeout=120s
kubectl rollout status deployment/settlement-service -n production --timeout=120s

echo "Mumbai EKS scaled to production capacity"
```

**Abort criteria (Phase 6):**
- Any deployment fails to reach desired replicas
- Pods stuck in Pending or CrashLoopBackOff
- Application health check fails on Mumbai

### Phase 7: Validate Mumbai Application Health (Owner: SRE | ETA: 3 min)

> **Reference:** RB-001 Phase 5 (Verify Application Health)

```bash
# 1. Health endpoint
curl -s https://paysecure-mumbai.example.com/health | jq .

# 2. Database connectivity
curl -s https://paysecure-mumbai.example.com/health/db | jq .

# 3. Cache connectivity
curl -s https://paysecure-mumbai.example.com/health/cache | jq .

# 4. Kafka connectivity
curl -s https://paysecure-mumbai.example.com/health/kafka | jq .

# 5. Synthetic transaction test
curl -s -X POST https://paysecure-mumbai.example.com/v1/payments/test \
  -H "Content-Type: application/json" \
  -d '{"amount": 1, "currency": "INR", "test_mode": true}' | jq .

# 6. KMS accessibility
aws kms describe-key --key-id alias/paysecure-primary --region ap-south-1

# 7. Secrets Manager accessibility
aws secretsmanager get-secret-value --secret-id paysecure/db/primary --region ap-south-1

# 8. WAF rules active
aws wafv2 get-web-acl --name paysecure-waf --scope REGIONAL --region ap-south-1 \
  --id <web-acl-id> --query 'WebACL.Rules[].Name'
```

**Abort criteria (Phase 7):**
- Any health check fails
- Synthetic transaction fails
- KMS or Secrets Manager inaccessible

### Phase 8: DNS Cutover — Weighted Shift to Mumbai (Owner: SRE / Network Engineer | ETA: 5 min)

> **Reference:** RB-001 Phase 3 (DNS Failover), RB-005 (DNS Failover)

```bash
# Gradual weighted shift to minimise risk:
# Step 1: 10% Mumbai, 90% Hyderabad — observe for 2 min
aws route53 change-resource-record-sets \
  --hosted-zone-id ZXXXXXXXXXXXX \
  --change-batch '{
    "Changes": [{
      "Action": "UPSERT",
      "ResourceRecordSet": {
        "Name": "api.paysecure.example.com",
        "Type": "A",
        "SetIdentifier": "mumbai",
        "Weight": 10,
        "AliasTarget": {
          "HostedZoneId": "Z2XXXXXXXXXXXX",
          "DNSName": "paysecure-alb-mumbai-1234567890.ap-south-1.elb.amazonaws.com",
          "EvaluateTargetHealth": true
        }
      }
    }, {
      "Action": "UPSERT",
      "ResourceRecordSet": {
        "Name": "api.paysecure.example.com",
        "Type": "A",
        "SetIdentifier": "hyderabad",
        "Weight": 90,
        "AliasTarget": {
          "HostedZoneId": "Z2XXXXXXXXXXXX",
          "DNSName": "paysecure-alb-hyderabad-1234567890.ap-south-2.elb.amazonaws.com",
          "EvaluateTargetHealth": true
        }
      }
    }]
  }'

echo "DNS: 10% Mumbai, 90% Hyderabad. Observing for 2 minutes..."
sleep 120

# Verify Mumbai is handling traffic correctly
# Check CloudWatch metrics for Mumbai ALB — requests should be flowing

# Step 2: 50% Mumbai, 50% Hyderabad — observe for 2 min
aws route53 change-resource-record-sets \
  --hosted-zone-id ZXXXXXXXXXXXX \
  --change-batch '{
    "Changes": [{
      "Action": "UPSERT",
      "ResourceRecordSet": {
        "Name": "api.paysecure.example.com",
        "Type": "A",
        "SetIdentifier": "mumbai",
        "Weight": 50,
        "AliasTarget": {
          "HostedZoneId": "Z2XXXXXXXXXXXX",
          "DNSName": "paysecure-alb-mumbai-1234567890.ap-south-1.elb.amazonaws.com",
          "EvaluateTargetHealth": true
        }
      }
    }, {
      "Action": "UPSERT",
      "ResourceRecordSet": {
        "Name": "api.paysecure.example.com",
        "Type": "A",
        "SetIdentifier": "hyderabad",
        "Weight": 50,
        "AliasTarget": {
          "HostedZoneId": "Z2XXXXXXXXXXXX",
          "DNSName": "paysecure-alb-hyderabad-1234567890.ap-south-2.elb.amazonaws.com",
          "EvaluateTargetHealth": true
        }
      }
    }]
  }'

echo "DNS: 50% Mumbai, 50% Hyderabad. Observing for 2 minutes..."
sleep 120

# Step 3: 100% Mumbai, 0% Hyderabad
aws route53 change-resource-record-sets \
  --hosted-zone-id ZXXXXXXXXXXXX \
  --change-batch '{
    "Changes": [{
      "Action": "UPSERT",
      "ResourceRecordSet": {
        "Name": "api.paysecure.example.com",
        "Type": "A",
        "SetIdentifier": "mumbai",
        "Weight": 100,
        "AliasTarget": {
          "HostedZoneId": "Z2XXXXXXXXXXXX",
          "DNSName": "paysecure-alb-mumbai-1234567890.ap-south-1.elb.amazonaws.com",
          "EvaluateTargetHealth": true
        }
      }
    }, {
      "Action": "UPSERT",
      "ResourceRecordSet": {
        "Name": "api.paysecure.example.com",
        "Type": "A",
        "SetIdentifier": "hyderabad",
        "Weight": 0,
        "AliasTarget": {
          "HostedZoneId": "Z2XXXXXXXXXXXX",
          "DNSName": "paysecure-alb-hyderabad-1234567890.ap-south-2.elb.amazonaws.com",
          "EvaluateTargetHealth": true
        }
      }
    }]
  }'

echo "DNS: 100% Mumbai. Failback complete."
```

**Abort criteria (Phase 8):**
- Mumbai error rate increases at 10% or 50% stage
- Mumbai health checks fail during weighted shift
- Merchant reports of issues during shift

**If abort is needed:** Immediately shift DNS back to 100% Hyderabad.

### Phase 9: Scale Down Hyderabad to Standby (Owner: SRE | ETA: 3 min)

> **Reference:** RB-001 Section 9.2 Step 10

```bash
# Switch to Hyderabad context
kubectl config use-context eks-hyderabad

# Scale down to standby capacity
kubectl scale deployment payment-gateway -n production --replicas=1
kubectl scale deployment fraud-engine -n production --replicas=1
kubectl scale deployment settlement-service -n production --replicas=1
kubectl scale deployment notification-service -n production --replicas=1
kubectl scale deployment api-gateway -n production --replicas=1

# Scale down Aurora readers in Hyderabad
aws rds delete-db-instance \
  --db-instance-identifier paysecure-aurora-secondary-reader-2 \
  --skip-final-snapshot \
  --region ap-south-2

# Scale down ElastiCache in Hyderabad (if scaled up during failover)
aws elasticache modify-replication-group \
  --replication-group-id paysecure-redis-hyderabad \
  --cache-node-type cache.r6g.large \
  --apply-immediately \
  --region ap-south-2

echo "Hyderabad scaled back to standby baseline"
```

### Phase 10: Enable Mumbai Monitoring (Owner: SRE | ETA: 2 min)

> **Reference:** RB-001 Phase 6 (Enable Monitoring)

```bash
# Verify CloudWatch alarms are active in Mumbai
aws cloudwatch describe-alarms \
  --region ap-south-1 \
  --query 'MetricAlarms[?StateValue==`OK`].AlarmName'

# Verify Datadog agent reporting from Mumbai EKS
kubectl get pods -n datadog -o wide --context=eks-mumbai

# Enable synthetic canaries from Mumbai
aws synthetics start-canary --name paysecure-canary-mumbai --region ap-south-1

# Verify PagerDuty routing is configured for Mumbai alerts
# (Should already be configured — verify during validation)
```

### Phase 11: Final Validation (Owner: SRE | ETA: 3 min)

```bash
#!/bin/bash
# post-failback-validation.sh

echo "=== POST-FAILBACK VALIDATION: $(date -u +%Y-%m-%dT%H:%M:%SZ) ==="

# 1. DNS routing to Mumbai
echo -n "DNS: "
RESOLVED=$(dig api.paysecure.example.com +short)
echo "$RESOLVED"

# 2. Application health
echo -n "Health: "
curl -s https://api.paysecure.example.com/health | jq -r '.status'

# 3. Synthetic transaction
echo -n "Transaction: "
curl -s -X POST https://api.paysecure.example.com/v1/payments/test \
  -H "Content-Type: application/json" \
  -d '{"amount": 1, "currency": "INR", "test_mode": true}' | jq -r '.status'

# 4. All data stores in normal state
echo "Aurora: $(aws rds describe-db-clusters --db-cluster-identifier paysecure-aurora-primary --region ap-south-1 --query 'DBClusters[0].Status' --output text)"
echo "DynamoDB: $(aws dynamodb describe-table --table-name paysecure-transactions --region ap-south-1 --query 'Table.TableStatus' --output text)"
echo "ElastiCache: $(aws elasticache describe-replication-groups --replication-group-id paysecure-redis-primary --region ap-south-1 --query 'ReplicationGroups[0].Status' --output text)"
echo "MSK: $(aws kafka list-clusters --region ap-south-1 --query 'ClusterInfoList[?ClusterName==`paysecure-msk`].State' --output text)"

# 5. Replication healthy
echo -n "Aurora lag: "
aws cloudwatch get-metric-statistics --region ap-south-2 \
  --namespace AWS/RDS --metric-name AuroraGlobalDBReplicationLag \
  --dimensions Name=DBClusterIdentifier,Value=paysecure-aurora-secondary \
  --start-time $(date -u -d '2 minutes ago' +%Y-%m-%dT%H:%M:%SZ) \
  --end-time $(date -u +%Y-%m-%dT%H:%M:%SZ) \
  --period 60 --statistics Average \
  --query 'Datapoints[-1].Average' --output text

echo ""
echo "=== FAILBACK VALIDATION COMPLETE ==="
```

### Phase 12: Announce Failback Complete (Owner: Incident Commander | ETA: 2 min)

```
FAILBACK COMPLETE — NORMAL OPERATIONS RESTORED

PaySecure has successfully failed back to the primary region (Mumbai, ap-south-1).

Summary:
- Start time: [Time]
- End time: [Time]
- Total duration: [X minutes]
- Data loss: None
- Service impact: None (transparent failback)

Current state:
- Mumbai: ACTIVE (100% production traffic)
- Hyderabad: STANDBY (warm, replicating)
- All data stores: Normal replication (Mumbai → Hyderabad)
- All monitoring: Active in both regions

Post-failback actions:
- [ ] Monitor Mumbai for 24 hours for any anomalies
- [ ] Schedule post-mortem within 48 hours
- [ ] Update runbooks with lessons learned
- [ ] Verify all DR dashboards reflect normal state
- [ ] Close PagerDuty incident

Thank you to the failback team.
```

## 7. Complete Failback Checklist

| # | Phase | Step | Owner | ETA | Done |
|---|-------|------|-------|-----|------|
| 0 | Pre-Failback | Validate Mumbai infrastructure (all 14 components) | SRE | 5 min | ☐ |
| 0 | Pre-Failback | Notify stakeholders | Incident Commander | 2 min | ☐ |
| 1 | Safety | Take Hyderabad Aurora snapshot | DB Engineer | 2 min | ☐ |
| 2 | Aurora | Re-establish Global DB (Mumbai primary) | DB Engineer | 10–30 min | ☐ |
| 3 | DynamoDB | Reverse replication (add Mumbai replicas) | DB Engineer | 5 min | ☐ |
| 4 | ElastiCache | Reverse Global Datastore (Mumbai primary) | Platform Engineer | 3 min | ☐ |
| 5 | MSK | Reverse MM2 replication (Mumbai → Hyderabad) | Data Platform Lead | 5 min | ☐ |
| 6 | EKS | Scale Mumbai to production capacity | SRE | 3 min | ☐ |
| 7 | Validate | Verify Mumbai application health | SRE | 3 min | ☐ |
| 8 | DNS | Weighted shift: 10% → 50% → 100% Mumbai | SRE / Network | 5 min | ☐ |
| 9 | Scale Down | Scale Hyderabad to standby baseline | SRE | 3 min | ☐ |
| 10 | Monitoring | Enable Mumbai monitoring | SRE | 2 min | ☐ |
| 11 | Validate | Final end-to-end validation | SRE | 3 min | ☐ |
| 12 | Announce | Failback complete communication | Incident Commander | 2 min | ☐ |

## 8. Emergency Rollback (Abort Failback)

If failback must be aborted at any point before Phase 8 (DNS cutover):

```bash
# Abort procedure — revert to Hyderabad as primary

# 1. Stop all in-progress operations
# 2. If Aurora was already promoted to Mumbai:
#    Re-promote Hyderabad using the safety snapshot from Phase 1
aws rds restore-db-cluster-from-snapshot \
  --db-cluster-identifier paysecure-aurora-secondary-recovery \
  --snapshot-identifier paysecure-pre-failback-YYYYMMDD-HHMMSS \
  --region ap-south-2

# 3. If DNS was already shifted, immediately revert to 100% Hyderabad
aws route53 change-resource-record-sets \
  --hosted-zone-id ZXXXXXXXXXXXX \
  --change-batch '{
    "Changes": [{
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
    }, {
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
    }]
  }'

# 4. Announce abort and revert to Hyderabad
# 5. Investigate root cause of failback failure
# 6. Re-schedule failback after issues are resolved
```

## 9. Post-Failback Monitoring (24 Hours)

| Metric | Threshold | Action if Breached |
|--------|-----------|-------------------|
| Mumbai error rate | > 1% (baseline < 0.1%) | Investigate immediately; consider reverting to Hyderabad |
| Aurora replication lag | > 5s sustained | Check VPC peering; check Aurora writer load |
| DynamoDB replication latency | > 5s sustained | Check Global Table status |
| ElastiCache replication lag | > 5s sustained | Check Global Datastore status |
| MSK consumer lag | > 10,000 messages | Check MM2; check consumer health |
| Mumbai ALB 5xx rate | > 0.5% | Investigate application errors |
| Synthetic transaction failure | Any failure | Immediate investigation |
| Merchant-reported issues | Any report | Immediate investigation |

## 10. Related Runbooks (Complete Reference)

This runbook integrates procedures from ALL prior runbooks. The relevant sections are referenced inline above.

| Runbook | Referenced In | Purpose |
|---------|--------------|---------|
| **RB-001: Complete Region Failure** | Phases 2–10 | Primary failover/failback procedures for all data stores, EKS, DNS, and monitoring |
| **RB-002: Database Split-Brain** | Phase 2, Abort | Aurora promotion safety; split-brain prevention during replication reversal |
| **RB-003: Kafka Partition Loss** | Phase 5 | MSK replication reversal; MM2 connector management |
| **RB-004: Cache Corruption** | Phase 4 | ElastiCache failback; cache warming after region switch |
| **RB-005: DNS Failover** | Phase 8 | Weighted DNS shift procedure; health check validation |
| **RB-006: Peak-Load Failover** | Phase 6 | EKS scaling to production capacity; load validation |
| **RB-007: KMS Key Compromise** | Phase 7 | KMS key accessibility validation during health checks |
| **RB-008: Secrets Rotation** | Phase 7 | Secrets Manager accessibility validation |
| **RB-009: EKS Node Failure** | Phase 6 | Node group health; pod scheduling validation |
| **RB-010: Network Partition** | Phase 0 | VPC peering validation; cross-region connectivity |
| **RB-011: Partial Degradation** | Phase 0, Abort | Component health assessment; decision framework for abort |

## 11. Compliance References

| Regulation / Standard | Requirement | How This Runbook Satisfies It |
|-----------------------|-------------|-------------------------------|
| **RBI Master Direction §7.3** | DR drills every 6 months; all failover AND failback steps logged for audit | This runbook provides the complete auditable failback procedure; every CLI command produces CloudTrail logs; checklist (Section 7) ensures all steps are documented |
| **RBI Data Localisation** | All payment data must remain within India during failback | All data movement during failback stays within Indian regions; safety snapshots stored in `ap-south-2`; no cross-border data transfer |
| **PCI-DSS v4.0 Req 9.5.1.2.1** | Resilience testing must include return to normal operations | This runbook IS the return-to-normal procedure; tested quarterly during production DR drills |
| **PCI-DSS v4.0 Req 10.2–10.3** | Audit trail integrity during failback operations | All failback steps are logged via CloudTrail; pre-failback snapshot preserves forensic evidence; post-failback validation verifies audit log completeness |
| **PCI-DSS v4.0 Req 12.10.1** | Incident response plan must include recovery and return to normal | This runbook completes the incident response lifecycle: detection → containment → recovery → failback → normal operations |
| **PCI-DSS v4.0 Req 12.10.5** | Monitoring must be restored to normal after incident | Phase 10 explicitly re-enables Mumbai monitoring; Phase 9 verifies Hyderabad monitoring remains active |
| **NPCI UPI Technical Standards** | System must maintain transaction integrity during region transitions | Weighted DNS shift (Phase 8) ensures no transaction loss during cutover; idempotency keys prevent duplicate processing across regions |
| **NPCI UPI** | Notify NPCI of region changes | Communication templates in Phase 5.2 (pre-failback) and Phase 12 (post-failback) include NPCI notification |

## 12. Test Schedule

| Test Type | Frequency | Owner |
|-----------|-----------|-------|
| Tabletop failback walkthrough | Monthly | DR Coordinator |
| Non-production failback drill | Bi-weekly | DR Team |
| Production failback (after scheduled failover test) | Quarterly | CTO + DR Team |
| Emergency abort drill (mid-failback) | Quarterly | DR Team |

---

**Document Control:** Review and update after every production failback or quarterly DR test. Update timing estimates based on observed performance.