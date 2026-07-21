# RB-007: KMS Key Compromise

**Version:** 1.0 | **Last Updated:** 2026-07-20 | **Owner:** Security Engineer / Platform Engineer
**Classification:** P0 — Sev 0 | **Expected RTO:** < 15 minutes | **Expected RPO:** N/A (no data loss; key rotation preserves data)

---

## 1. Purpose

This runbook covers AWS KMS key compromise scenarios including suspected key material exposure, unauthorised KMS API calls, key deletion attempts, key disablement (accidental or malicious), multi-region key desynchronisation, and KMS service degradation in a region. KMS keys protect all data at rest (Aurora, DynamoDB, ElastiCache, EBS, S3, Secrets Manager) — a key compromise threatens the confidentiality and integrity of the entire payment platform.

## 2. Trigger Conditions

| Trigger | Detection Mechanism | Automatic / Manual |
|---------|---------------------|--------------------|
| CloudTrail logs show unauthorised `kms:Decrypt` or `kms:Encrypt` calls | CloudTrail + GuardDuty anomaly detection | Automatic — P0 alert |
| CloudTrail logs show `kms:ScheduleKeyDeletion` or `kms:DisableKey` | CloudTrail + Config rule `kms-cmk-not-scheduled-for-deletion` | Automatic — P0 alert |
| KMS key state changes to `Disabled` or `PendingDeletion` | AWS Config + CloudWatch Events | Automatic — P0 alert |
| Multi-Region KMS key replica state diverges from primary | Custom CloudWatch composite alarm | Automatic — P1 alert |
| KMS API error rate > 5% (throttling or service degradation) | CloudWatch `KMS.ThrottleCount` or `KMS.Errors` | Automatic — P1 alert |
| Secrets Manager fails to decrypt secrets (KMS-dependent) | Application logs: `KMSDecryptException` | Automatic — P1 alert |
| Aurora/DynamoDB/ElastiCache encryption failures | Service-specific CloudWatch metrics | Automatic — P1 alert |
| GuardDuty finding: `UnauthorizedAccess:IAMUser/KMSKeyDecrypt` | GuardDuty | Automatic — P0 alert |
| IAM Access Analyzer reports external access to KMS key policy | IAM Access Analyzer | Automatic — P1 alert |
| Security team notification of key material leak (e.g., exposed in code repo) | Manual report / GitHub secret scanning | Manual — immediate P0 |
| Cross-region decryption test fails in Hyderabad | CloudWatch Synthetics canary — `kms-decrypt-cross-region` | Automatic — P1 alert |
| Multi-region key replica enters `PendingDeletion` or `Disabled` independently | AWS Config + CloudWatch Events in `ap-south-2` | Automatic — P1 alert |

**Decision gate:** If key deletion is scheduled (7-day waiting period), immediate action is required to cancel the deletion. If key material is confirmed exposed, rotate keys immediately and re-encrypt affected resources. If KMS service is degraded in one region, validate the other region's key replicas are accessible. If multi-region keys are desynchronised, re-establish replication before any failover is attempted.

## 3. Impact Assessment

| Impact Dimension | Severity | Detail |
|------------------|----------|--------|
| **Data Confidentiality** | Critical | Exposed key material allows decryption of all data at rest — transaction records, PII, PAN tokens |
| **Data Availability** | Critical | Disabled/deleted key makes all encrypted data inaccessible — complete platform outage |
| **Revenue** | Critical | If data stores become inaccessible, all payment processing halts |
| **Regulatory** | Critical | Key compromise is a reportable breach under RBI guidelines and PCI-DSS; mandatory notification within 24–72 hours |
| **Merchant Trust** | Critical | Data breach notification to merchants; potential contract termination |
| **Legal / Compliance** | Critical | GDPR-equivalent penalties under Indian DPDP Act; PCI-DSS non-compliance fines |
| **Recovery Complexity** | High | Key rotation requires coordinated re-encryption across 4 data stores; multi-region key sync must be validated |
| **Forensic Requirement** | High | Full CloudTrail audit required; key usage history must be preserved for investigation |
| **Cross-Region DR Readiness** | Critical | If multi-region key replicas are desynchronised, Hyderabad cannot decrypt data during failover — RB-001 failover would fail |

**Worst-case scenario:** Key deleted and waiting period expired — data is permanently inaccessible. Mitigation: AWS KMS minimum 7-day deletion waiting period provides a recovery window.

## 4. Prerequisites

- [ ] IAM credentials with `kms:CancelKeyDeletion`, `kms:EnableKey`, `kms:CreateKey`, `kms:UpdateAlias`, `kms:ReplicateKey` permissions
- [ ] Multi-Region KMS key ARNs documented for both Mumbai (`ap-south-1`) and Hyderabad (`ap-south-2`)
- [ ] Key aliases documented: `alias/paysecure-primary`, `alias/paysecure-aurora`, `alias/paysecure-dynamodb`, `alias/paysecure-elasticache`, `alias/paysecure-ebs`, `alias/paysecure-secrets`
- [ ] List of all resources encrypted with each key (maintained in infrastructure-as-code)
- [ ] CloudTrail enabled in both regions with log file validation
- [ ] GuardDuty enabled in both regions
- [ ] AWS Config rules active: `kms-cmk-not-scheduled-for-deletion`
- [ ] Access to key policy backup (stored in version control)
- [ ] Security incident response plan activated
- [ ] DPO and compliance officer contact information
- [ ] Cross-region KMS decrypt canary running in Hyderabad (CloudWatch Synthetics)

## 5. Recovery Procedure

### Scenario A: Key Scheduled for Deletion — Cancel Immediately (Owner: Security Engineer | ETA: 2 min)

> **CRITICAL:** KMS key deletion has a 7-day mandatory waiting period. If you catch it within 7 days, the key can be recovered.

```bash
# Step 1: Identify the key scheduled for deletion
aws kms list-keys --region ap-south-1 --query 'Keys[].KeyId' --output text

for key in $(aws kms list-keys --region ap-south-1 --query 'Keys[].KeyId' --output text); do
  STATUS=$(aws kms describe-key --key-id $key --region ap-south-1 --query 'KeyMetadata.KeyState' --output text)
  if [ "$STATUS" = "PendingDeletion" ]; then
    echo "KEY SCHEDULED FOR DELETION: $key"
    DELETION_DATE=$(aws kms describe-key --key-id $key --region ap-south-1 --query 'KeyMetadata.DeletionDate' --output text)
    echo "Deletion date: $DELETION_DATE"
  fi
done

# Step 2: Cancel the deletion immediately
aws kms cancel-key-deletion --key-id <key-id> --region ap-south-1

# Step 3: Verify key is now Enabled
aws kms describe-key --key-id <key-id> --region ap-south-1 --query 'KeyMetadata.KeyState'
# Expected: "Enabled"

# Step 4: If this was a multi-region key, check the replica
aws kms describe-key --key-id <key-id> --region ap-south-2 --query 'KeyMetadata.KeyState'
# Expected: "Enabled"

# Step 5: Investigate who scheduled the deletion
aws cloudtrail lookup-events \
  --lookup-attributes AttributeKey=EventName,AttributeValue=ScheduleKeyDeletion \
  --region ap-south-1 \
  --query 'Events[].CloudTrailEvent' | jq -r '.userIdentity.arn'

# Step 6: Revoke the IAM principal's KMS permissions immediately
# (See Scenario D for IAM remediation)

echo "Key deletion cancelled. Key is now Enabled."
```

### Scenario B: Key Material Confirmed Exposed — Rotate Immediately (Owner: Security Engineer | ETA: 15 min)

> Use when key material has been leaked (e.g., exposed in a public repository, exfiltrated by an attacker).

```bash
# Step 1: Disable the compromised key to prevent further use
# WARNING: This will cause decryption failures for resources using this key.
# Coordinate with SRE before disabling.
aws kms disable-key --key-id <compromised-key-id> --region ap-south-1

# Step 2: Create a new KMS key with the same policy
# Export the existing key policy first
aws kms get-key-policy \
  --key-id <compromised-key-id> \
  --policy-name default \
  --region ap-south-1 \
  --query 'Policy' --output text > /tmp/kms-key-policy.json

# Create new multi-region key
NEW_KEY_ARN=$(aws kms create-key \
  --policy file:///tmp/kms-key-policy.json \
  --multi-region \
  --region ap-south-1 \
  --query 'KeyMetadata.Arn' --output text)

echo "New key ARN: $NEW_KEY_ARN"

# Step 3: Create replica in Hyderabad
aws kms replicate-key \
  --key-id $NEW_KEY_ARN \
  --replica-region ap-south-2

# Step 4: Update key alias to point to new key
aws kms update-alias \
  --alias-name alias/paysecure-primary \
  --target-key-id $NEW_KEY_ARN \
  --region ap-south-1

# Step 5: Re-encrypt Secrets Manager secrets with new key
# For each secret encrypted with the old key:
aws secretsmanager update-secret \
  --secret-id paysecure/db/primary \
  --kms-key-id $NEW_KEY_ARN \
  --region ap-south-1

# Step 6: Re-encrypt RDS instances (Aurora)
# Aurora uses the KMS key for storage encryption — requires snapshot and restore
aws rds create-db-cluster-snapshot \
  --db-cluster-identifier paysecure-aurora-primary \
  --db-cluster-snapshot-identifier paysecure-reencrypt-$(date +%Y%m%d) \
  --region ap-south-1

aws rds restore-db-cluster-from-snapshot \
  --db-cluster-identifier paysecure-aurora-primary-new \
  --snapshot-identifier paysecure-reencrypt-$(date +%Y%m%d) \
  --kms-key-id $NEW_KEY_ARN \
  --region ap-south-1

# Step 7: Re-encrypt DynamoDB tables
# DynamoDB uses AWS-owned keys by default; if CMK is used:
aws dynamodb update-table \
  --table-name paysecure-transactions \
  --sse-specification Enabled=true,SSEType=KMS,KMSMasterKeyId=$NEW_KEY_ARN \
  --region ap-south-1

# Step 8: Re-encrypt ElastiCache
aws elasticache modify-replication-group \
  --replication-group-id paysecure-redis-primary \
  --kms-key-id $NEW_KEY_ARN \
  --apply-immediately \
  --region ap-south-1

# Step 9: Re-encrypt EBS volumes (EKS worker nodes)
# New node groups will use the new key; terminate existing nodes
# See RB-009 for node replacement procedure

# Step 10: Verify all resources are accessible with new key
aws secretsmanager get-secret-value --secret-id paysecure/db/primary --region ap-south-1
aws rds describe-db-clusters --db-cluster-identifier paysecure-aurora-primary-new --region ap-south-1
aws dynamodb describe-table --table-name paysecure-transactions --region ap-south-1

echo "Key rotation complete. Compromised key disabled."
```

### Scenario C: Key Disablement — Accidental or Malicious (Owner: Security Engineer | ETA: 3 min)

> Use when a KMS key has been disabled (state = `Disabled`) without authorisation, or when a legitimate disablement needs to be reversed. A disabled key blocks all encrypt/decrypt operations for resources using it.

```bash
# Step 1: Identify the disabled key
aws kms list-keys --region ap-south-1 --query 'Keys[].KeyId' --output text

for key in $(aws kms list-keys --region ap-south-1 --query 'Keys[].KeyId' --output text); do
  STATUS=$(aws kms describe-key --key-id $key --region ap-south-1 --query 'KeyMetadata.KeyState' --output text)
  if [ "$STATUS" = "Disabled" ]; then
    echo "DISABLED KEY: $key"
    DISABLE_REASON=$(aws kms describe-key --key-id $key --region ap-south-1 \
      --query 'KeyMetadata.Description' --output text)
    echo "Description: $DISABLE_REASON"
  fi
done

# Step 2: Determine if disablement was authorised
aws cloudtrail lookup-events \
  --lookup-attributes AttributeKey=EventName,AttributeValue=DisableKey \
  --region ap-south-1 \
  --query 'Events[0].CloudTrailEvent' | jq '{user: .userIdentity.arn, time: .eventTime, sourceIP: .sourceIPAddress}'

# Step 3: If unauthorised, re-enable the key immediately
aws kms enable-key --key-id <key-id> --region ap-south-1

# Step 4: Verify key is now Enabled
aws kms describe-key --key-id <key-id> --region ap-south-1 --query 'KeyMetadata.KeyState'
# Expected: "Enabled"

# Step 5: Verify multi-region replica is also Enabled
aws kms describe-key --key-id <key-id> --region ap-south-2 --query 'KeyMetadata.KeyState'
# Expected: "Enabled"

# Step 6: Test decryption works after re-enablement
echo "test" | base64 > /tmp/test-plaintext.txt
aws kms encrypt \
  --key-id <key-id> \
  --plaintext fileb:///tmp/test-plaintext.txt \
  --region ap-south-1 \
  --query CiphertextBlob --output text | base64 -d > /tmp/test-ciphertext.bin

aws kms decrypt \
  --key-id <key-id> \
  --ciphertext-blob fileb:///tmp/test-ciphertext.bin \
  --region ap-south-1 \
  --query Plaintext --output text | base64 -d

# Step 7: Verify application health recovers
curl -s https://api.paysecure.example.com/health/kms | jq .
# Expected: {"status": "healthy", "kms": "accessible"}

# Step 8: Revoke the IAM principal that disabled the key
# (See Scenario D for IAM remediation)

echo "Key re-enabled. All dependent services should recover within 60s."
```

**Note:** During the window when the key was disabled, all encrypt/decrypt operations failed. Applications may have cached errors. A rolling restart of affected deployments may be needed:

```bash
kubectl rollout restart deployment/payment-gateway -n production --context=eks-mumbai
kubectl rollout restart deployment/fraud-engine -n production --context=eks-mumbai
kubectl rollout restart deployment/settlement-service -n production --context=eks-mumbai
```

### Scenario D: Unauthorised KMS API Calls Detected (Owner: Security Engineer | ETA: 5 min)

```bash
# Step 1: Identify the source of unauthorised calls
aws cloudtrail lookup-events \
  --lookup-attributes AttributeKey=EventName,AttributeValue=Decrypt \
  --region ap-south-1 \
  --query 'Events[?CloudTrailEvent.contains(`"errorCode"`)==`false`]' \
  --output json | jq '.[].CloudTrailEvent' | jq -r '.userIdentity.arn, .sourceIPAddress, .eventTime'

# Step 2: Immediately revoke the IAM principal's KMS permissions
# Attach a deny policy to the IAM role/user
aws iam put-user-policy \
  --user-name <compromised-user> \
  --policy-name EmergencyKMSDeny \
  --policy-document '{
    "Version": "2012-10-17",
    "Statement": [{
      "Effect": "Deny",
      "Action": ["kms:*"],
      "Resource": ["*"]
    }]
  }'

# Step 3: Rotate the compromised IAM credentials
aws iam update-access-key \
  --user-name <compromised-user> \
  --access-key-id <access-key-id> \
  --status Inactive

# Step 4: Review the key policy for overly permissive grants
aws kms get-key-policy \
  --key-id alias/paysecure-primary \
  --policy-name default \
  --region ap-south-1

# Step 5: Enable GuardDuty KMS findings if not already enabled
aws guardduty update-detector \
  --detector-id <detector-id> \
  --enable true \
  --features '[{"Name": "EKS_AUDIT_LOGS", "Status": "ENABLED"}]'

# Step 6: Preserve all CloudTrail logs for forensic investigation
aws cloudtrail create-trail \
  --name paysecure-forensic-$(date +%Y%m%d) \
  --s3-bucket-name paysecure-forensic-logs \
  --is-multi-region-trail \
  --enable-log-file-validation

echo "Unauthorised access contained. Forensic investigation initiated."
```

### Scenario E: Multi-Region Key Desynchronisation (Owner: Platform Engineer | ETA: 10 min)

> Use when the multi-region KMS key replica in Hyderabad has diverged from the primary in Mumbai — different key state, different key policy, or replica independently disabled/deleted. This is critical because Hyderabad must be able to decrypt data during a failover (RB-001).

```bash
# Step 1: Compare key states between regions
echo "=== Mumbai (ap-south-1) ==="
aws kms describe-key --key-id alias/paysecure-primary --region ap-south-1 \
  --query 'KeyMetadata.{State:KeyState,Arn:Arn,MultiRegion:MultiRegion}' --output json

echo "=== Hyderabad (ap-south-2) ==="
aws kms describe-key --key-id alias/paysecure-primary --region ap-south-2 \
  --query 'KeyMetadata.{State:KeyState,Arn:Arn,MultiRegion:MultiRegion}' --output json

# Step 2: Compare key policies
aws kms get-key-policy \
  --key-id alias/paysecure-primary \
  --policy-name default \
  --region ap-south-1 \
  --query 'Policy' --output text > /tmp/kms-policy-mumbai.json

aws kms get-key-policy \
  --key-id alias/paysecure-primary \
  --policy-name default \
  --region ap-south-2 \
  --query 'Policy' --output text > /tmp/kms-policy-hyderabad.json

diff /tmp/kms-policy-mumbai.json /tmp/kms-policy-hyderabad.json

# Step 3: If replica is Disabled, re-enable it
aws kms enable-key --key-id <replica-key-id> --region ap-south-2

# Step 4: If replica is PendingDeletion, cancel deletion
aws kms cancel-key-deletion --key-id <replica-key-id> --region ap-south-2

# Step 5: If replica key policy has diverged, sync it from primary
aws kms put-key-policy \
  --key-id <replica-key-id> \
  --policy-name default \
  --policy file:///tmp/kms-policy-mumbai.json \
  --region ap-south-2

# Step 6: If replica was deleted and cannot be recovered, create a new replica
# First, verify the primary key is multi-region
PRIMARY_ARN=$(aws kms describe-key --key-id alias/paysecure-primary --region ap-south-1 \
  --query 'KeyMetadata.Arn' --output text)

aws kms replicate-key \
  --key-id $PRIMARY_ARN \
  --replica-region ap-south-2

# Step 7: Update Hyderabad alias to point to new replica
aws kms update-alias \
  --alias-name alias/paysecure-primary \
  --target-key-id <new-replica-key-id> \
  --region ap-south-2

# Step 8: Validate cross-region decryption works
echo "test-cross-region" | base64 > /tmp/test-plaintext.txt

# Encrypt in Mumbai
CIPHERTEXT=$(aws kms encrypt \
  --key-id alias/paysecure-primary \
  --plaintext fileb:///tmp/test-plaintext.txt \
  --region ap-south-1 \
  --query CiphertextBlob --output text)

# Decrypt in Hyderabad using the replica
echo $CIPHERTEXT | base64 -d > /tmp/test-ciphertext.bin
aws kms decrypt \
  --key-id alias/paysecure-primary \
  --ciphertext-blob fileb:///tmp/test-ciphertext.bin \
  --region ap-south-2 \
  --query Plaintext --output text | base64 -d

echo "Multi-region key synchronisation validated."

# Step 9: Verify all key aliases in Hyderabad point to correct replicas
for alias in paysecure-primary paysecure-aurora paysecure-dynamodb paysecure-elasticache paysecure-ebs paysecure-secrets; do
  echo "=== alias/$alias ==="
  aws kms describe-key --key-id alias/$alias --region ap-south-2 \
    --query 'KeyMetadata.{State:KeyState,MultiRegion:MultiRegion}' --output json
done
```

**Decision gate:** If multi-region key desync cannot be resolved within 10 minutes, escalate to AWS Support (SEV1) and declare Hyderabad DR readiness as DEGRADED. Do NOT attempt a region failover (RB-001) until key synchronisation is restored — Hyderabad would be unable to decrypt data stores.

### Scenario F: KMS Service Degradation in Mumbai (Owner: Platform Engineer | ETA: 5 min)

> KMS API throttling or service outage in Mumbai prevents encryption/decryption operations.

```bash
# Step 1: Verify KMS degradation
aws kms describe-key --key-id alias/paysecure-primary --region ap-south-1
# If this returns 5xx or timeout, KMS is degraded

# Step 2: Check if Hyderabad KMS replica is accessible
aws kms describe-key --key-id alias/paysecure-primary --region ap-south-2
# Multi-region keys should be accessible from Hyderabad

# Step 3: If Hyderabad KMS is healthy, redirect encryption operations to Hyderabad
# Update application config to use Hyderabad KMS endpoint
kubectl set env deployment/payment-gateway -n production --context=eks-mumbai \
  AWS_KMS_ENDPOINT=https://kms.ap-south-2.amazonaws.com

# Step 4: Verify decryption works from Hyderabad
aws kms decrypt \
  --key-id alias/paysecure-primary \
  --ciphertext-blob fileb:///tmp/test-ciphertext.bin \
  --region ap-south-2

# Step 5: If Mumbai KMS is completely unavailable and Hyderabad is healthy,
# consider failing over to Hyderabad entirely (see RB-001)

# Step 6: Monitor AWS Health Dashboard for KMS service recovery in Mumbai
aws health describe-events \
  --filter '{"services": ["KMS"], "regions": ["ap-south-1"]}' \
  --region us-east-1

# Step 7: Once Mumbai KMS recovers, revert KMS endpoint
kubectl set env deployment/payment-gateway -n production --context=eks-mumbai \
  AWS_KMS_ENDPOINT=https://kms.ap-south-1.amazonaws.com
```

### Scenario G: Cross-Region Decryption Validation (Owner: Platform Engineer | ETA: 3 min)

> Proactive validation that Hyderabad can decrypt data encrypted with Mumbai KMS keys. Run this before any planned failover (RB-012) and as a periodic health check.

```bash
#!/bin/bash
# cross-region-kms-validation.sh
# Validates that all multi-region KMS keys can decrypt across regions

echo "=== CROSS-REGION KMS DECRYPTION VALIDATION: $(date -u +%Y-%m-%dT%H:%M:%SZ) ==="
FAIL=0

KEYS=("paysecure-primary" "paysecure-aurora" "paysecure-dynamodb" "paysecure-elasticache" "paysecure-ebs" "paysecure-secrets")

for alias in "${KEYS[@]}"; do
  echo ""
  echo "--- alias/$alias ---"

  # Step 1: Verify key exists and is Enabled in Mumbai
  MUMBAI_STATE=$(aws kms describe-key --key-id alias/$alias --region ap-south-1 \
    --query 'KeyMetadata.KeyState' --output text 2>/dev/null)
  echo "  Mumbai: $MUMBAI_STATE"

  # Step 2: Verify key exists and is Enabled in Hyderabad
  HYD_STATE=$(aws kms describe-key --key-id alias/$alias --region ap-south-2 \
    --query 'KeyMetadata.KeyState' --output text 2>/dev/null)
  echo "  Hyderabad: $HYD_STATE"

  # Step 3: Encrypt a test payload in Mumbai
  TEST_PAYLOAD="cross-region-validation-$(date +%s)"
  CIPHERTEXT=$(echo -n "$TEST_PAYLOAD" | base64 | \
    aws kms encrypt \
      --key-id alias/$alias \
      --plaintext fileb:///dev/stdin \
      --region ap-south-1 \
      --query CiphertextBlob --output text 2>/dev/null)

  if [ -z "$CIPHERTEXT" ]; then
    echo "  Encrypt (Mumbai): FAIL"
    FAIL=1
    continue
  fi
  echo "  Encrypt (Mumbai): PASS"

  # Step 4: Decrypt the ciphertext in Hyderabad using the replica key
  DECRYPTED=$(echo "$CIPHERTEXT" | base64 -d | \
    aws kms decrypt \
      --key-id alias/$alias \
      --ciphertext-blob fileb:///dev/stdin \
      --region ap-south-2 \
      --query Plaintext --output text 2>/dev/null | base64 -d)

  if [ "$DECRYPTED" = "$TEST_PAYLOAD" ]; then
    echo "  Decrypt (Hyderabad): PASS"
  else
    echo "  Decrypt (Hyderabad): FAIL (expected '$TEST_PAYLOAD', got '$DECRYPTED')"
    FAIL=1
  fi

  # Step 5: Verify multi-region configuration
  MUMBAI_MR=$(aws kms describe-key --key-id alias/$alias --region ap-south-1 \
    --query 'KeyMetadata.MultiRegionConfiguration.MultiRegionKeyType' --output text 2>/dev/null)
  HYD_MR=$(aws kms describe-key --key-id alias/$alias --region ap-south-2 \
    --query 'KeyMetadata.MultiRegionConfiguration.MultiRegionKeyType' --output text 2>/dev/null)
  echo "  Multi-Region: Mumbai=$MUMBAI_MR, Hyderabad=$HYD_MR"
done

echo ""
if [ "$FAIL" -eq 0 ]; then
  echo "=== ALL CROSS-REGION KMS VALIDATIONS PASSED ==="
else
  echo "=== SOME VALIDATIONS FAILED — DO NOT FAIL OVER UNTIL RESOLVED ==="
fi
```

**Schedule:** Run this validation:
- Before every planned failover (RB-012 Phase 0)
- As a CloudWatch Synthetics canary every 15 minutes
- After any KMS key rotation (Scenario B)
- After any multi-region key recovery (Scenario E)

## 6. Verification Steps

| Check | Command / Method | Expected |
|-------|-----------------|----------|
| Key state | `aws kms describe-key --key-id <key-id>` | `Enabled` |
| Multi-region replica state | `aws kms describe-key --key-id <key-id> --region ap-south-2` | `Enabled` |
| Secrets Manager decrypt test | `aws secretsmanager get-secret-value --secret-id paysecure/db/primary` | Returns secret value |
| Aurora encryption status | `aws rds describe-db-clusters --query 'DBClusters[0].StorageEncrypted'` | `true` |
| DynamoDB encryption status | `aws dynamodb describe-table --query 'Table.SSEDescription.Status'` | `ENABLED` |
| ElastiCache encryption status | `aws elasticache describe-replication-groups --query 'ReplicationGroups[0].AtRestEncryptionEnabled'` | `true` |
| Application health (KMS-dependent) | `curl -s https://api.paysecure.example.com/health/kms` | 200 OK |
| Cross-region decrypt (Mumbai → Hyderabad) | Scenario G validation script | All keys PASS |
| CloudTrail logging active | `aws cloudtrail describe-trails --query 'trailList[].Status.IsLogging'` | `true` |
| GuardDuty active | `aws guardduty list-detectors` | Detector ID present |
| No pending deletion | `aws kms list-keys` + describe each | No `PendingDeletion` state |
| Key policy unchanged | Compare against version-controlled baseline | No unauthorised changes |

## 7. Rollback Plan

### 7.1 Rollback After Key Rotation

If the new key causes issues, revert to the old key (if not compromised):

```bash
# Step 1: Re-enable the old key (if disabled)
aws kms enable-key --key-id <old-key-id> --region ap-south-1

# Step 2: Point alias back to old key
aws kms update-alias \
  --alias-name alias/paysecure-primary \
  --target-key-id <old-key-id> \
  --region ap-south-1

# Step 3: Revert Secrets Manager secrets
aws secretsmanager update-secret \
  --secret-id paysecure/db/primary \
  --kms-key-id <old-key-id> \
  --region ap-south-1

# Step 4: Revert Aurora (restore from pre-rotation snapshot)
aws rds restore-db-cluster-from-snapshot \
  --db-cluster-identifier paysecure-aurora-primary-rollback \
  --snapshot-identifier paysecure-pre-rotation-YYYYMMDD \
  --region ap-south-1

# Step 5: Verify all resources accessible with old key
```

### 7.2 Rollback After Key Re-Enablement

If re-enabling a key does not restore service:

| Step | Action | Owner | ETA |
|------|--------|-------|-----|
| 1 | Verify key state is `Enabled` in both regions | Security Engineer | 1 min |
| 2 | Restart affected application deployments | SRE | 2 min |
| 3 | If service still degraded, check CloudTrail for other KMS API errors | Security Engineer | 2 min |
| 4 | If KMS service itself is degraded, escalate to AWS Support (SEV1) | Platform Engineer | 5 min |
| 5 | If Mumbai KMS unrecoverable, initiate failover to Hyderabad per RB-001 | Incident Commander | — |

### 7.3 Rollback Abort Criteria

- New key inaccessible from Hyderabad
- Decryption failures on any data store after rotation
- Multi-region key replica fails to create
- Cross-region decryption validation (Scenario G) fails after any key change

## 8. KMS Key Inventory

| Key Alias | Key Type | Regions | Resources Encrypted |
|-----------|----------|---------|---------------------|
| `alias/paysecure-primary` | Multi-Region (symmetric) | `ap-south-1`, `ap-south-2` | Secrets Manager, S3 buckets |
| `alias/paysecure-aurora` | Multi-Region (symmetric) | `ap-south-1`, `ap-south-2` | Aurora clusters, snapshots |
| `alias/paysecure-dynamodb` | Multi-Region (symmetric) | `ap-south-1`, `ap-south-2` | DynamoDB tables |
| `alias/paysecure-elasticache` | Multi-Region (symmetric) | `ap-south-1`, `ap-south-2` | ElastiCache clusters, snapshots |
| `alias/paysecure-ebs` | Multi-Region (symmetric) | `ap-south-1`, `ap-south-2` | EBS volumes (EKS worker nodes) |
| `alias/paysecure-secrets` | Multi-Region (symmetric) | `ap-south-1`, `ap-south-2` | Secrets Manager secrets (credential encryption) |

## 9. Compliance References

| Regulation / Standard | Requirement | How This Runbook Satisfies It |
|-----------------------|-------------|-------------------------------|
| **RBI Master Direction §7.3** | Security incident reporting; encryption key management | Key compromise is a reportable incident; this runbook provides the immediate response procedure; all actions logged via CloudTrail |
| **RBI Data Localisation** | Encryption keys for payment data must remain within India | All KMS keys are in Indian regions only; multi-region keys replicate within India |
| **PCI-DSS v4.0 Req 3.5.1** | Cryptographic key management procedures | This runbook IS the key management incident response procedure; covers key rotation, revocation, disablement, and compromise response |
| **PCI-DSS v4.0 Req 3.6** | Key rotation and retirement procedures | Scenario B provides complete key rotation with re-encryption of all affected resources |
| **PCI-DSS v4.0 Req 3.6.1.2** | Secret and private keys must be stored securely | KMS keys are never exportable; key material is protected by AWS HSM-backed KMS |
| **PCI-DSS v4.0 Req 10.2–10.3** | Audit trail of all key management operations | CloudTrail logs all KMS API calls; Scenario D preserves forensic evidence |
| **PCI-DSS v4.0 Req 12.10.1** | Incident response plan for security breaches | This runbook IS the incident response plan for KMS key compromise |
| **NPCI UPI Technical Standards** | Encryption of UPI transaction data at rest | KMS key inventory (Section 8) maps each key to encrypted resources; all UPI data is covered |

## 10. Related Runbooks

| Runbook | Relationship |
|---------|-------------|
| **RB-001: Complete Region Failure** | KMS service degradation in Mumbai may trigger region failover (Scenario F); Hyderabad KMS replicas must be validated before failover (Scenario G). RB-001 Phase 5 validates KMS key accessibility post-failover. |
| **RB-002: Database Split-Brain** | Key desynchronisation between regions (Scenario E) may cause decryption failures that mimic split-brain symptoms. If Aurora clusters in both regions cannot decrypt with their respective KMS replicas, data becomes inaccessible — coordinate with RB-002. |
| **RB-008: Secrets Rotation** | Secrets Manager depends on KMS for decryption; coordinate key and secret rotation. If KMS key is rotated (Scenario B), all secrets must be re-encrypted with the new key. |
| **RB-009: EKS Node Failure** | EBS volume encryption depends on KMS; node replacement requires key accessibility. If KMS key is disabled, new EBS volumes cannot be created — coordinate with RB-009. |
| **RB-012: Full Rollback** | Cross-region KMS validation (Scenario G) is a mandatory pre-flight check in RB-012 Phase 0 (Pre-Failback Validation). KMS key accessibility is validated in RB-012 Phase 7. |

## 11. Test Schedule

| Test Type | Frequency | Owner |
|-----------|-----------|-------|
| Key rotation drill (non-prod) | Monthly | Security Engineer |
| Multi-region key failover test | Monthly | Platform Engineer |
| Cross-region decryption validation (Scenario G) | Every 15 min (automated canary) | Platform Engineer |
| Unauthorised access simulation (GuardDuty) | Quarterly | Security Engineer |
| Key deletion and recovery drill | Quarterly | Security Engineer |
| Key disablement and re-enablement drill | Quarterly | Security Engineer |
| Multi-region key desync recovery drill | Quarterly | Platform Engineer |
| Full key compromise tabletop exercise | Bi-annually | CISO + DR Team |

---

**Document Control:** Review and update after every key rotation, security incident, or quarterly DR test. Update key inventory when new resources are added. Validate cross-region decryption (Scenario G) before every planned failover.