# RB-002: Database Split-Brain Recovery

**Version:** 1.0 | **Last Updated:** 2026-07-20 | **Owner:** Database Reliability Lead
**Classification:** P1 — Sev 0 | **Expected Recovery Time:** < 15 minutes | **Data Loss Risk:** Moderate

---

## 1. Purpose

This runbook addresses split-brain scenarios where both the primary (Mumbai) and secondary (Hyderabad) Aurora PostgreSQL clusters accept writes simultaneously, or where DynamoDB Global Tables develop conflicting versions of the same item. Split-brain is the most dangerous failure mode for data integrity in an active-passive topology and must be handled with extreme care.

## 2. Trigger Conditions

| Trigger | Detection Mechanism | Automatic / Manual |
|---------|---------------------|--------------------|
| Both Aurora clusters report `Status: available` with writer instances | AWS RDS API / CloudWatch | Automatic — P1 alert fires |
| WAL replication lag diverges between clusters (bidirectional lag > 0) | CloudWatch `AuroraGlobalDBReplicationLag` on both clusters | Automatic — P1 alert |
| `duplicate key` or `unique violation` errors spike in `transactions` table | Application error logs / RDS Performance Insights | Automatic — P2 alert; manual investigation |
| `pg_stat_replication` shows unexpected bidirectional entries | PostgreSQL system view query | Manual — DB Engineer investigation |
| CloudTrail shows unauthorised `promote-read-replica` on secondary | AWS CloudTrail → EventBridge | Automatic — P1 security alert |
| `ConditionalCheckFailedException` spike on DynamoDB writes | Application logs / CloudWatch | Automatic — P2 alert |
| DynamoDB version vector divergence (`oldImage.version > newImage.version`) | DynamoDB Streams | Manual — detected during reconciliation |
| Writes to Mumbai replica after failover declared | CloudTrail | Manual — forensic analysis |
| `ReplicationLatency` spikes bidirectionally (> 100ms both ways) | CloudWatch | Automatic — P1 alert |

**Decision gate:** If ANY Aurora split-brain indicator fires, immediately contain writes (Section 4). For DynamoDB, investigate `ConditionalCheckFailedException` spike before declaring split-brain.

## 3. Impact Assessment

| Impact Dimension | Severity | Detail |
|------------------|----------|--------|
| **Data Integrity** | Critical | Divergent transaction records between regions; risk of double-processing payments |
| **Revenue** | Critical | If duplicate transactions processed, financial reconciliation required; potential chargeback exposure |
| **Settlement Accuracy** | Critical | Settlement batch totals may diverge; manual reconciliation of every affected batch |
| **Merchant Experience** | High | Write freeze (Section 4) halts all payment processing during containment |
| **Regulatory** | Critical | RBI requires accurate transaction ledgers; PCI-DSS requires data integrity; audit findings if not resolved correctly |
| **Recovery Complexity** | Very High | Requires forensic snapshot comparison, manual row-level reconciliation, and DBA expertise |
| **Data Loss Risk** | Moderate | Transactions written to the non-authoritative cluster during split window may be lost |
| **Time to Full Recovery** | 15–60 min | 15 min for containment + promotion; up to 60 min for full data reconciliation |

**Worst-case scenario:** Both clusters have accepted writes for an extended period (> 5 min) and divergent transactions include completed payments. Requires payments team + compliance officer involvement.

## 4. Prerequisites

- [ ] Direct access to both Aurora clusters (Mumbai and Hyderabad) via AWS Console or CLI
- [ ] Database admin credentials (stored in Secrets Manager, both regions)
- [ ] Access to PostgreSQL audit logs (CloudWatch Logs)
- [ ] Access to DynamoDB Streams and CloudTrail for write reconciliation
- [ ] PagerDuty incident declared
- [ ] Application deployment pipeline access (to halt writes if needed)

## 5. Detection

### 5.1 Aurora Split-Brain Indicators

| Signal | Source | Threshold |
|--------|--------|-----------|
| Both clusters report `Status: available` with writer instances | AWS RDS API | Immediate |
| WAL replication lag diverges between clusters | CloudWatch `AuroraGlobalDBReplicationLag` | > 0 on both sides |
| Write timestamp conflicts in `transactions` table | Application logs | `duplicate key` or `unique violation` errors |
| `pg_stat_replication` shows bidirectional replication | PostgreSQL | Unexpected entries |
| CloudTrail shows `promote-read-replica` on secondary | AWS CloudTrail | Unauthorised promotion |

### 5.2 DynamoDB Split-Brain Indicators

| Signal | Source | Threshold |
|--------|--------|-----------|
| `ConditionalCheckFailedException` on writes | Application logs | Spike > baseline |
| Version vector divergence | DynamoDB Streams | `oldImage.version > newImage.version` |
| Writes to Mumbai replica after failover declared | CloudTrail | Any write after failover timestamp |
| `ReplicationLatency` spikes in both directions | CloudWatch | > 100ms bidirectional |

### 5.3 Verification Commands

```bash
# Aurora: Check both clusters for writer instances
aws rds describe-db-clusters --db-cluster-identifier paysecure-aurora-primary --region ap-south-1 \
  --query 'DBClusters[0].DBClusterMembers[?IsClusterWriter==`true`].DBInstanceIdentifier'
aws rds describe-db-clusters --db-cluster-identifier paysecure-aurora-secondary --region ap-south-2 \
  --query 'DBClusters[0].DBClusterMembers[?IsClusterWriter==`true`].DBInstanceIdentifier'

# DynamoDB: Check write metrics in both regions
aws cloudwatch get-metric-statistics --region ap-south-1 \
  --namespace AWS/DynamoDB --metric-name SuccessfulRequestCount \
  --dimensions Name=TableName,Value=paysecure-transactions Name=Operation,Value=PutItem \
  --start-time $(date -u -d '5 minutes ago' +%Y-%m-%dT%H:%M:%SZ) \
  --end-time $(date -u +%Y-%m-%dT%H:%M:%SZ) \
  --period 60 --statistics Sum
```

## 6. Immediate Containment

### 6.1 Stop All Application Writes (Owner: SRE / Incident Commander | ETA: 30s)

```bash
# CRITICAL: Halt writes to prevent further divergence
# Option A: Scale down all write-capable services to 0
kubectl scale deployment payment-gateway -n production --replicas=0
kubectl scale deployment settlement-service -n production --replicas=0
kubectl scale deployment fraud-engine -n production --replicas=0

# Option B (if available): Enable maintenance mode via feature flag
curl -X POST https://api.paysecure.example.com/admin/maintenance-mode \
  -H "Authorization: Bearer ${ADMIN_TOKEN}" \
  -d '{"enabled": true, "message": "Scheduled maintenance — split-brain recovery in progress"}'
```

### 6.2 Freeze Both Database Clusters (Owner: DB Engineer | ETA: 60s)

```bash
# Aurora: Revoke write permissions temporarily
# Apply IAM policy denying write actions, OR:
# For each cluster, set to read-only mode
# (Requires pre-configured parameter group with read_only = on)

# DynamoDB: Apply IAM SCP to deny PutItem/UpdateItem/DeleteItem
aws organizations create-policy \
  --name "split-brain-write-freeze" \
  --type SERVICE_CONTROL_POLICY \
  --content '{"Version":"2012-10-17","Statement":[{"Effect":"Deny","Action":["dynamodb:PutItem","dynamodb:UpdateItem","dynamodb:DeleteItem"],"Resource":["arn:aws:dynamodb:*:*:table/paysecure-*"]}]}'
```

## 7. Aurora Split-Brain Resolution

### 7.1 Determine the Authoritative Cluster (Owner: DB Engineer | ETA: 2 min)

```bash
# 1. Identify which cluster has the most recent committed transactions
# Query both clusters for the max transaction ID / LSN

# On Mumbai:
psql -h paysecure-aurora-primary.cluster-xxx.ap-south-1.rds.amazonaws.com \
  -U admin -d paysecure \
  -c "SELECT pg_current_wal_lsn(), pg_last_wal_receive_lsn(), pg_last_wal_replay_lsn();"

# On Hyderabad:
psql -h paysecure-aurora-secondary.cluster-xxx.ap-south-2.rds.amazonaws.com \
  -U admin -d paysecure \
  -c "SELECT pg_current_wal_lsn(), pg_last_wal_receive_lsn(), pg_last_wal_replay_lsn();"

# 2. Compare transaction counts in critical tables
# On both clusters:
psql -h <endpoint> -U admin -d paysecure \
  -c "SELECT COUNT(*), MAX(created_at) FROM transactions WHERE created_at > NOW() - INTERVAL '1 hour';"
```

### 7.2 Decision Matrix

| Scenario | Authoritative Cluster | Action |
|----------|----------------------|--------|
| Mumbai has higher LSN and more transactions | Mumbai | Demote Hyderabad, re-establish replication Mumbai → Hyderabad |
| Hyderabad has higher LSN and more transactions | Hyderabad | Mumbai was stale before split; keep Hyderabad as new primary |
| Both have identical LSN | Mumbai (original primary) | Demote Hyderabad, re-establish replication |
| Cannot determine (both unreachable) | Last known good backup | Restore from most recent backup; accept data loss |

### 7.3 Reconciliation Procedure — Mumbai Authoritative (Owner: DB Engineer | ETA: 10 min)

```bash
# Step 1: Demote Hyderabad to read-replica
aws rds remove-role-from-db-cluster \
  --db-cluster-identifier paysecure-aurora-secondary \
  --role-arn arn:aws:iam::123456789012:role/aurora-global-db-role \
  --region ap-south-2

# Step 2: Delete the secondary cluster (it will be recreated)
# First, take a snapshot for forensic analysis
aws rds create-db-cluster-snapshot \
  --db-cluster-identifier paysecure-aurora-secondary \
  --db-cluster-snapshot-identifier paysecure-split-brain-forensic-$(date +%Y%m%d-%H%M%S) \
  --region ap-south-2

# Step 3: Recreate secondary from primary
aws rds create-db-cluster \
  --db-cluster-identifier paysecure-aurora-secondary \
  --source-db-cluster-identifier arn:aws:rds:ap-south-1:123456789012:cluster:paysecure-aurora-primary \
  --region ap-south-2

# Step 4: Wait for replication to establish
aws rds wait db-cluster-available \
  --db-cluster-identifier paysecure-aurora-secondary \
  --region ap-south-2

# Step 5: Verify replication lag is 0
aws cloudwatch get-metric-statistics --region ap-south-2 \
  --namespace AWS/RDS --metric-name AuroraGlobalDBReplicationLag \
  --dimensions Name=DBClusterIdentifier,Value=paysecure-aurora-secondary \
  --start-time $(date -u -d '5 minutes ago' +%Y-%m-%dT%H:%M:%SZ) \
  --end-time $(date -u +%Y-%m-%dT%H:%M:%SZ) \
  --period 60 --statistics Average
```

### 7.4 Divergent Data Reconciliation (Owner: DB Engineer + Payments Team | ETA: 15–30 min)

```bash
# Identify divergent rows (rows written to Hyderabad during split-brain)
# Compare forensic snapshot with current primary state
# This requires a manual SQL reconciliation script:

# 1. Restore forensic snapshot to a temporary cluster
aws rds restore-db-cluster-from-snapshot \
  --db-cluster-identifier paysecure-forensic-temp \
  --snapshot-identifier paysecure-split-brain-forensic-20260720-143000 \
  --region ap-south-2

# 2. Run reconciliation queries
# Identify transactions in forensic that are NOT in primary:
# SELECT t1.transaction_id FROM forensic.transactions t1
# LEFT JOIN primary.transactions t2 ON t1.transaction_id = t2.transaction_id
# WHERE t2.transaction_id IS NULL AND t1.created_at > <split_start_time>;

# 3. For each divergent transaction, decide:
#    - If idempotent: replay on primary
#    - If already processed by downstream: skip (log for audit)
#    - If payment: MANUAL REVIEW REQUIRED — escalate to payments team

# 4. Clean up temporary cluster
aws rds delete-db-cluster --db-cluster-identifier paysecure-forensic-temp \
  --skip-final-snapshot --region ap-south-2
```

## 8. DynamoDB Split-Brain Resolution

### 8.1 Identify Conflicting Items (Owner: DB Engineer | ETA: 5 min)

```bash
# Use DynamoDB Streams to find items modified in both regions during the split window
# Query CloudTrail for writes to Mumbai after failover timestamp

aws cloudtrail lookup-events \
  --region ap-south-1 \
  --lookup-attributes AttributeKey=EventName,AttributeValue=PutItem \
  --start-time "2026-07-20T14:00:00Z" \
  --end-time "2026-07-20T14:30:00Z" \
  --query 'Events[?CloudTrailEvent.contains(`"tableName":"paysecure-transactions"`)]'
```

### 8.2 Last-Writer-Wins Resolution (Owner: DB Engineer | ETA: 5 min)

```bash
# DynamoDB Global Tables use last-writer-wins by default
# The item with the most recent timestamp survives
# Verify this is acceptable for each table:

# transactions: ACCEPTABLE — idempotent by transaction_id
# merchants: REQUIRES REVIEW — merchant config changes may be lost
# settlements: ACCEPTABLE — settlement batches are idempotent
# fraud_scores: ACCEPTABLE — latest score wins
# audit_log: APPEND-ONLY — both versions must be preserved

# For merchants table: manually compare and merge
aws dynamodb get-item \
  --table-name paysecure-merchants \
  --key '{"merchant_id": {"S": "MERCH001"}}' \
  --region ap-south-1

aws dynamodb get-item \
  --table-name paysecure-merchants \
  --key '{"merchant_id": {"S": "MERCH001"}}' \
  --region ap-south-2
```

### 8.3 Audit Log Preservation (Owner: DB Engineer | ETA: 5 min)

```bash
# For append-only tables, export both versions to S3 for audit
aws dynamodb export-table-to-point-in-time \
  --table-arn arn:aws:dynamodb:ap-south-1:123456789012:table/paysecure-audit_log \
  --s3-bucket paysecure-audit-exports \
  --s3-prefix split-brain-20260720/mumbai/ \
  --export-time $(date -u +%Y-%m-%dT%H:%M:%SZ)

aws dynamodb export-table-to-point-in-time \
  --table-arn arn:aws:dynamodb:ap-south-2:123456789012:table/paysecure-audit_log \
  --s3-bucket paysecure-audit-exports \
  --s3-prefix split-brain-20260720/hyderabad/ \
  --export-time $(date -u +%Y-%m-%dT%H:%M:%SZ)
```

## 9. Resume Operations (Owner: SRE | ETA: 3 min)

```bash
# 1. Remove write freeze
aws organizations delete-policy --policy-id <policy-id>

# 2. Verify single writer
aws rds describe-db-clusters --query 'DBClusters[?Status==`available`].DBClusterIdentifier'

# 3. Scale up application services
kubectl scale deployment payment-gateway -n production --replicas=6
kubectl scale deployment settlement-service -n production --replicas=3
kubectl scale deployment fraud-engine -n production --replicas=4

# 4. Verify health
curl -s https://api.paysecure.example.com/health | jq .

# 5. Run synthetic transactions
curl -s -X POST https://api.paysecure.example.com/v1/payments/test \
  -H "Content-Type: application/json" \
  -d '{"amount": 1, "currency": "INR", "test_mode": true}'
```

## 10. Verification Steps

### 10.1 Data Integrity Verification

| Check | Command / Method | Expected Result |
|-------|-----------------|-----------------|
| Single writer instance | `aws rds describe-db-clusters --query 'DBClusters[].DBClusterMembers[?IsClusterWriter==\`true\`]'` | Exactly 1 writer across both regions |
| Replication lag = 0 | CloudWatch `AuroraGlobalDBReplicationLag` | 0 ms for 5+ consecutive minutes |
| No duplicate transactions | `SELECT transaction_id, COUNT(*) FROM transactions WHERE created_at > <split_start> GROUP BY transaction_id HAVING COUNT(*) > 1;` | 0 rows |
| Settlement batch totals match | Compare `SUM(amount)` per batch between forensic snapshot and primary | Identical |
| DynamoDB no bidirectional writes | CloudWatch `SuccessfulRequestCount` for PutItem in Mumbai | 0 after failover timestamp |
| Audit log completeness | `SELECT COUNT(*) FROM audit_log WHERE created_at BETWEEN <split_start> AND <split_end>` | All events present in primary |
| Application health | `curl https://api.paysecure.example.com/health` | 200 OK; all dependencies green |

### 10.2 Post-Mortem Checklist

- [ ] Document the root cause of the split-brain
- [ ] Identify all divergent records and their resolution
- [ ] Verify no duplicate payments were processed
- [ ] Reconcile settlement totals between regions
- [ ] Update runbook with lessons learned
- [ ] Review IAM policies to prevent unauthorised promotions
- [ ] Add additional safeguards (e.g., require MFA for `promote-read-replica`)
- [ ] Schedule tabletop exercise for split-brain scenario

## 11. Rollback Plan (Post-Resolution Stabilisation)

### 11.1 If Mumbai Was Kept as Authoritative

| Step | Action | Owner | ETA |
|------|--------|-------|-----|
| 1 | Confirm Hyderabad secondary is recreated and replicating from Mumbai | DB Engineer | 2 min |
| 2 | Verify `AuroraGlobalDBReplicationLag` = 0 for 5 consecutive minutes | DB Engineer | 5 min |
| 3 | Verify DynamoDB Global Tables have only Mumbai as write region | DB Engineer | 2 min |
| 4 | Remove IAM write-freeze SCP (if applied) | Security | 1 min |
| 5 | Scale application services back to production capacity | SRE | 2 min |
| 6 | Run synthetic transactions against Mumbai | SRE | 1 min |
| 7 | Monitor for 15 min; if stable, declare resolved | Incident Commander | 15 min |

### 11.2 If Hyderabad Was Promoted as New Primary

| Step | Action | Owner | ETA |
|------|--------|-------|-----|
| 1 | Confirm Mumbai cluster is fully demoted (no writer instances) | DB Engineer | 1 min |
| 2 | Take forensic snapshot of Mumbai before any changes | DB Engineer | 2 min |
| 3 | Re-establish Global DB with Hyderabad as primary, Mumbai as secondary | DB Engineer | 5 min |
| 4 | Wait for initial sync; verify lag < 5s | DB Engineer | 10–30 min |
| 5 | Update application connection strings to Hyderabad writer endpoint | SRE | 1 min |
| 6 | Scale Hyderabad EKS to full production capacity | SRE | 2 min |
| 7 | Run synthetic transactions; validate all services | SRE | 2 min |
| 8 | Monitor for 30 min; if stable, plan failback to Mumbai per RB-012 | Incident Commander | — |

### 11.3 Rollback Abort Criteria

- Replication lag does not stabilise within 30 min
- Divergent data reconciliation reveals unrecoverable payment discrepancies
- New split-brain indicators detected during stabilisation
- Application health checks fail after resuming writes

## 12. Prevention Measures

| Measure | Implementation | Owner |
|---------|---------------|-------|
| MFA-protected promotion | IAM policy requiring MFA for `rds:PromoteReadReplica` | Security |
| Promotion alert | CloudTrail → EventBridge → PagerDuty on any promotion | SRE |
| Write lock mechanism | Application-level distributed lock (Redis-based) | Platform |
| Regular split-brain drills | Quarterly chaos experiment | Chaos Team |
| Automated write freeze | Lambda triggered by dual-writer detection | SRE |

## 14. Compliance References

| Regulation / Standard | Requirement | How This Runbook Satisfies It |
|-----------------------|-------------|-------------------------------|
| **RBI Master Direction §7.3.2** | All reconciliation actions must be logged and auditable | Every CLI command in this runbook is captured by CloudTrail; forensic snapshots preserved (Section 7.3); reconciliation queries logged |
| **RBI Data Localisation** | Payment data must remain within India | All forensic analysis and reconciliation performed within Indian regions (`ap-south-1`, `ap-south-2`); no cross-border data movement |
| **PCI-DSS v4.0 Req 10.2.1** | All individual accesses to cardholder data during reconciliation must be logged | Forensic snapshot access is audited via CloudTrail; temporary cluster access uses IAM roles with full logging |
| **PCI-DSS v4.0 Req 10.3** | Audit records must include user ID, type of event, date/time, success/failure | PostgreSQL `audit` schema captures all reconciliation queries; DynamoDB Streams preserve item-level change history |
| **PCI-DSS v4.0 Req 3.4** | PAN must be rendered unreadable anywhere it is stored | Forensic snapshots containing cardholder data are encrypted with KMS; access restricted to authorised DBAs |
| **PCI-DSS v4.0 Req 12.10.1** | Incident response plan for data integrity breaches | This runbook IS the incident response plan for split-brain; Section 6 (Immediate Containment) halts writes within 30s |
| **NPCI UPI Technical Standards** | Transaction traceability and integrity | `transaction_id` used as idempotency key prevents duplicate processing; divergent transaction reconciliation (Section 7.4) ensures ledger accuracy |
| **NPCI UPI** | Notify NPCI if any UPI transactions were affected | Post-mortem checklist (Section 10) includes NPCI notification step; communication template in RB-001 Section 8 |

## 15. Related Runbooks

- RB-001: Complete Region Failure
- RB-003: Kafka Partition Loss
- RB-004: Cache Corruption
- RB-012: Full Rollback

## 16. Test Schedule

| Test Type | Frequency | Owner |
|-----------|-----------|-------|
| Tabletop walkthrough | Monthly | DBA Lead |
| Aurora split-brain simulation (non-prod) | Monthly | DR Team |
| DynamoDB conflict resolution drill | Monthly | DR Team |
| Full split-brain chaos experiment | Quarterly | Chaos Team |