# RB-008: Secrets Rotation

**Version:** 1.0 | **Last Updated:** 2026-07-20 | **Owner:** Security Engineer / Platform Engineer
**Classification:** P1 — Sev 1 | **Expected RTO:** < 10 minutes | **Expected RPO:** N/A (secrets rotation preserves data)

---

## 1. Purpose

This runbook covers AWS Secrets Manager secret rotation failures, secret leakage detection, credential expiry during an active incident, Secrets Manager regional service outage, and cross-region secret desynchronisation. Secrets Manager stores all database credentials, API keys, Kafka authentication tokens, and service-account keys for the PaySecure platform — a secret rotation failure or leakage threatens both security posture and service availability.

## 2. Trigger Conditions

| Trigger | Detection Mechanism | Automatic / Manual |
|---------|---------------------|--------------------|
| Secrets Manager automatic rotation fails | CloudWatch `RotationFailed` metric on secret | Automatic — P1 alert |
| Application logs show `SecretsManagerException` or `AccessDeniedException` | Application error logs → Datadog | Automatic — P1 alert |
| CloudTrail logs show unauthorised `secretsmanager:GetSecretValue` calls | CloudTrail + GuardDuty anomaly detection | Automatic — P0 alert |
| Secret marked for deletion (scheduled or immediate) | AWS Config rule `secret-scheduled-for-deletion` | Automatic — P1 alert |
| Cross-region secret version mismatch detected | CloudWatch Synthetics canary — `secret-version-cross-region` | Automatic — P1 alert |
| Secrets Manager API error rate > 5% (throttling or service degradation) | CloudWatch `SecretsManager.ThrottleCount` or `SecretsManager.Errors` | Automatic — P1 alert |
| Lambda rotation function execution failure | CloudWatch Logs `/aws/lambda/paysecure-secrets-rotation` | Automatic — P1 alert |
| Database connection failures with "authentication failed" errors | Application logs: `FATAL: password authentication failed` | Automatic — P1 alert |
| Credential expiry alert (secret `NextRotationDate` within 24h and rotation failing) | CloudWatch composite alarm | Automatic — P1 alert |
| Secret value exposed in logs, code repository, or support ticket | Manual report / GitHub secret scanning / internal audit | Manual — immediate P0 |
| Cross-region `get-secret-value` returns different version in Hyderabad vs Mumbai | CloudWatch Synthetics canary — `secret-version-cross-region` | Automatic — P1 alert |
| Secrets Manager service degradation in Mumbai (`ap-south-1`) | AWS Health Dashboard + CloudWatch Synthetics | Automatic — P1 alert |

**Decision gate:** If a secret is confirmed exposed, rotate it immediately and revoke the compromised credential at the target service. If Secrets Manager is degraded in Mumbai, validate Hyderabad replica accessibility and redirect applications if needed. If cross-region secret versions are desynchronised, reconcile before any region failover is attempted. If rotation Lambda is failing, escalate to the platform team and perform manual rotation.

## 3. Impact Assessment

| Impact Dimension | Severity | Detail |
|------------------|----------|--------|
| **Service Availability** | Critical | Expired or invalid credentials cause database connection failures, Kafka authentication failures, and API authentication failures — cascading across all services |
| **Data Confidentiality** | Critical | Exposed database credentials or API keys allow unauthorised access to transaction data, PII, and PAN tokens |
| **Revenue** | Critical | If database credentials expire and rotation fails, all payment processing halts |
| **Regulatory** | Critical | Credential leakage is a reportable breach under RBI guidelines and PCI-DSS; mandatory notification within 24–72 hours |
| **Merchant Trust** | Critical | Data breach notification to merchants if credentials were exposed; potential contract termination |
| **Recovery Complexity** | Medium | Manual rotation requires coordinated secret update across Secrets Manager, target service, and all consuming applications; pod recycling needed to pick up new credentials |
| **Cross-Region DR Readiness** | Critical | If Hyderabad Secrets Manager has stale or missing secrets, region failover (RB-001) will fail — applications cannot connect to promoted data stores |
| **Cascading Risk** | High | A single expired database credential can trigger cascading failures across payment-gateway, fraud-engine, settlement-service, and notification-service simultaneously |

**Worst-case scenario:** Database master password exposed and rotated, but rotation Lambda fails silently — new password not propagated to consuming pods. All services lose database connectivity. Mitigation: multi-version secret support in Secrets Manager; applications can fall back to previous version during rotation window.

## 4. Prerequisites

- [ ] IAM credentials with `secretsmanager:GetSecretValue`, `secretsmanager:PutSecretValue`, `secretsmanager:UpdateSecret`, `secretsmanager:RotateSecret`, `secretsmanager:CancelRotateSecret`, `secretsmanager:RestoreSecret` permissions
- [ ] Secrets Manager secrets inventory documented with ARNs, rotation schedules, and target services
- [ ] Rotation Lambda function ARN and CloudWatch Logs group documented
- [ ] Cross-region secret replication configured and validated for all production secrets
- [ ] CloudTrail enabled in both regions with log file validation
- [ ] GuardDuty enabled in both regions
- [ ] AWS Config rules active: `secret-scheduled-for-deletion`
- [ ] Access to secret policy backup (stored in version control)
- [ ] Database admin credentials (break-glass) stored securely offline for emergency manual rotation
- [ ] List of all Kubernetes deployments consuming each secret (maintained in infrastructure-as-code)
- [ ] Cross-region secret version canary running every 5 minutes (CloudWatch Synthetics)

## 5. Secrets Inventory

| Secret ID | Type | Rotation Schedule | Target Service | Consumers |
|-----------|------|-------------------|----------------|-----------|
| `paysecure/db/primary` | Aurora master password | Every 7 days | Aurora PostgreSQL (`paysecure-aurora-primary`) | payment-gateway, fraud-engine, settlement-service, notification-service |
| `paysecure/db/readonly` | Aurora read-only password | Every 7 days | Aurora PostgreSQL readers | analytics-service, reporting-service, audit-log-reader |
| `paysecure/redis/auth` | ElastiCache auth token | Every 30 days | ElastiCache Redis (`paysecure-redis-primary`) | payment-gateway, fraud-engine, session-store |
| `paysecure/kafka/broker` | MSK SASL/SCRAM credentials | Every 30 days | MSK cluster (`paysecure-msk`) | All Kafka producers and consumers |
| `paysecure/api/internal` | Internal service-to-service API key | Every 30 days | API Gateway internal endpoints | All microservices |
| `paysecure/api/external/merchants` | Merchant API signing key | Every 90 days | Merchant-facing API | api-gateway, merchant-onboarding |
| `paysecure/api/npci` | NPCI UPI integration API key | Every 90 days | NPCI UPI gateway | payment-gateway, upi-processor |
| `paysecure/s3/backup` | S3 backup access key | Every 90 days | S3 backup buckets | backup-service, dr-sync-service |
| `paysecure/monitoring/datadog` | Datadog API key | Every 90 days | Datadog agent | datadog-agent (DaemonSet) |
| `paysecure/tls/certificate-private-key` | TLS private key | Every 90 days | ALB / API Gateway | aws-load-balancer-controller |

## 6. Recovery Procedure

### Scenario A: Automatic Rotation Failure (Owner: Security Engineer | ETA: 5 min)

> Use when Secrets Manager automatic rotation fails — the secret has not been rotated and the `NextRotationDate` is approaching or has passed.

```bash
# Step 1: Identify which secret rotation failed
aws secretsmanager describe-secret \
  --secret-id paysecure/db/primary \
  --region ap-south-1 \
  --query '{Name:Name,LastRotatedDate:LastRotatedDate,NextRotationDate:NextRotationDate,RotationEnabled:RotationEnabled,RotationLambdaARN:RotationLambdaARN}' \
  --output json

# Step 2: Check rotation Lambda logs for the failure cause
ROTATION_LAMBDA=$(aws secretsmanager describe-secret \
  --secret-id paysecure/db/primary \
  --region ap-south-1 \
  --query 'RotationLambdaARN' --output text)

aws logs filter-log-events \
  --log-group-name /aws/lambda/paysecure-secrets-rotation \
  --filter-pattern "ERROR" \
  --start-time $(date -u -d '1 hour ago' +%s%3N) \
  --region ap-south-1 \
  --query 'events[-5:].[timestamp,message]' --output text

# Step 3: Common failure causes and fixes

# Cause A: Lambda timeout (target database unreachable)
# Fix: Verify target database is accessible from Lambda VPC
aws lambda get-function-configuration \
  --function-name paysecure-secrets-rotation \
  --region ap-south-1 \
  --query '{Timeout:Timeout,VpcConfig:VpcConfig}' --output json

# Cause B: Lambda lacks permissions to update the target service
# Fix: Check and update Lambda IAM role
aws iam get-role-policy \
  --role-name paysecure-secrets-rotation-role \
  --policy-name SecretsRotationPolicy

# Cause C: Secret version staging issue
# Fix: Check secret versions
aws secretsmanager list-secret-version-ids \
  --secret-id paysecure/db/primary \
  --region ap-south-1 \
  --query 'Versions[*].[VersionId,VersionStages]' --output table

# Step 4: Manually trigger rotation after fixing the root cause
aws secretsmanager rotate-secret \
  --secret-id paysecure/db/primary \
  --region ap-south-1

# Step 5: Verify rotation succeeded
aws secretsmanager describe-secret \
  --secret-id paysecure/db/primary \
  --region ap-south-1 \
  --query '{LastRotatedDate:LastRotatedDate,NextRotationDate:NextRotationDate}' \
  --output json

# Step 6: Verify the new credential works
# Retrieve the current secret and test connectivity
DB_SECRET=$(aws secretsmanager get-secret-value \
  --secret-id paysecure/db/primary \
  --region ap-south-1 \
  --query 'SecretString' --output text)

DB_HOST=$(echo $DB_SECRET | jq -r '.host')
DB_USER=$(echo $DB_SECRET | jq -r '.username')
DB_PASS=$(echo $DB_SECRET | jq -r '.password')

PGPASSWORD=$DB_PASS psql -h $DB_HOST -U $DB_USER -d paysecure -c "SELECT 1;"
# Expected: 1 row returned

echo "Rotation completed and verified."
```

### Scenario B: Secret Leakage Detected — Emergency Rotation (Owner: Security Engineer | ETA: 8 min)

> Use when a secret has been exposed (e.g., committed to a repository, leaked in logs, exfiltrated by an attacker). This is a P0 incident.

```bash
# Step 1: Immediately revoke the compromised credential at the target service
# For Aurora database password:
# Connect with admin credentials and revoke the compromised user's password
ADMIN_SECRET=$(aws secretsmanager get-secret-value \
  --secret-id paysecure/db/admin-break-glass \
  --region ap-south-1 \
  --query 'SecretString' --output text)

ADMIN_USER=$(echo $ADMIN_SECRET | jq -r '.username')
ADMIN_PASS=$(echo $ADMIN_SECRET | jq -r '.password')
DB_HOST=$(echo $ADMIN_SECRET | jq -r '.host')

# Generate a new strong password immediately
NEW_PASSWORD=$(openssl rand -base64 32)

# Update the database user password directly
PGPASSWORD=$ADMIN_PASS psql -h $DB_HOST -U $ADMIN_USER -d paysecure -c \
  "ALTER USER paysecure_app WITH PASSWORD '$NEW_PASSWORD';"

# Step 2: Update the secret in Secrets Manager with the new password
CURRENT_SECRET=$(aws secretsmanager get-secret-value \
  --secret-id paysecure/db/primary \
  --region ap-south-1 \
  --query 'SecretString' --output text)

UPDATED_SECRET=$(echo $CURRENT_SECRET | jq --arg pass "$NEW_PASSWORD" '.password = $pass')

aws secretsmanager put-secret-value \
  --secret-id paysecure/db/primary \
  --secret-string "$UPDATED_SECRET" \
  --version-stages AWSCURRENT \
  --region ap-south-1

# Step 3: Cancel any in-progress automatic rotation to avoid conflict
aws secretsmanager cancel-rotate-secret \
  --secret-id paysecure/db/primary \
  --region ap-south-1

# Step 4: Force all consuming pods to pick up the new secret immediately
# Option A: Rolling restart of all deployments that consume this secret
kubectl rollout restart deployment/payment-gateway -n production --context=eks-mumbai
kubectl rollout restart deployment/fraud-engine -n production --context=eks-mumbai
kubectl rollout restart deployment/settlement-service -n production --context=eks-mumbai
kubectl rollout restart deployment/notification-service -n production --context=eks-mumbai

# Option B: If using External Secrets Operator or CSI driver, force refresh
kubectl annotate secretstore paysecure-secrets -n production \
  force-refresh=$(date +%s) --overwrite

# Step 5: Verify all pods are running with new credentials
kubectl get pods -n production --context=eks-mumbai | grep -v "Running\|Completed"

# Step 6: Verify database connectivity from all services
for svc in payment-gateway fraud-engine settlement-service notification-service; do
  echo "=== $svc ==="
  kubectl logs -n production --context=eks-mumbai \
    -l app=$svc --tail=20 | grep -i "database connection\|authentication"
done

# Step 7: Re-enable automatic rotation with the new secret
aws secretsmanager rotate-secret \
  --secret-id paysecure/db/primary \
  --region ap-south-1

# Step 8: If the secret was exposed in a Git repository:
# - Immediately revoke and rotate the exposed credential (done above)
# - Purge the secret from Git history using BFG Repo-Cleaner or git filter-branch
# - Enable GitHub secret scanning push protection
# - Audit all other secrets in the repository

# Step 9: Preserve forensic evidence
aws cloudtrail lookup-events \
  --lookup-attributes AttributeKey=EventName,AttributeValue=GetSecretValue \
  --region ap-south-1 \
  --query 'Events[?CloudTrailEvent.contains(`paysecure/db/primary`)].CloudTrailEvent' \
  --output json > /tmp/secret-access-forensic-$(date +%Y%m%d-%H%M%S).json

echo "Emergency rotation complete. Compromised credential revoked."
```

**For non-database secrets (API keys, tokens):**

```bash
# Example: Rotating a compromised Kafka SASL/SCRAM credential

# Step 1: Generate new credentials in MSK
aws kafka update-broker-storage \
  --cluster-arn arn:aws:kafka:ap-south-1:123456789012:cluster/paysecure-msk/xxx \
  --current-version <version> \
  --target-broker-ebs-volume-info '[{"KafkaBrokerNodeId": "All", "VolumeSizeGB": 500}]' \
  --region ap-south-1

# For SASL/SCRAM: create a new secret in Secrets Manager, then associate with cluster
aws kafka batch-associate-scram-secret \
  --cluster-arn arn:aws:kafka:ap-south-1:123456789012:cluster/paysecure-msk/xxx \
  --secret-arn-list "arn:aws:secretsmanager:ap-south-1:123456789012:secret:paysecure/kafka/broker-new-xxxxx" \
  --region ap-south-1

# Step 2: Update the secret in Secrets Manager
aws secretsmanager put-secret-value \
  --secret-id paysecure/kafka/broker \
  --secret-string '{"username":"paysecure-kafka","password":"<new-password>"}' \
  --region ap-south-1

# Step 3: Disassociate the old (compromised) secret
aws kafka batch-disassociate-scram-secret \
  --cluster-arn arn:aws:kafka:ap-south-1:123456789012:cluster/paysecure-msk/xxx \
  --secret-arn-list "arn:aws:secretsmanager:ap-south-1:123456789012:secret:paysecure/kafka/broker-old-xxxxx" \
  --region ap-south-1

# Step 4: Restart Kafka consumers and producers
kubectl rollout restart deployment/payment-gateway -n production --context=eks-mumbai
kubectl rollout restart deployment/fraud-engine -n production --context=eks-mumbai
```

### Scenario C: Secrets Manager Regional Outage (Owner: Platform Engineer | ETA: 5 min)

> Use when Secrets Manager service is degraded or unavailable in Mumbai (`ap-south-1`). Applications cannot retrieve secrets, causing cascading authentication failures.

```bash
# Step 1: Verify Secrets Manager degradation
aws secretsmanager get-secret-value \
  --secret-id paysecure/db/primary \
  --region ap-south-1
# If this returns 5xx, timeout, or InternalFailure, Secrets Manager is degraded

# Step 2: Check AWS Health Dashboard
aws health describe-events \
  --filter '{"services": ["SECRETSMANAGER"], "regions": ["ap-south-1"]}' \
  --region us-east-1

# Step 3: Verify Hyderabad Secrets Manager is healthy
aws secretsmanager get-secret-value \
  --secret-id paysecure/db/primary \
  --region ap-south-2
# Cross-region replicas should be accessible

# Step 4: If Hyderabad is healthy, redirect applications to Hyderabad Secrets Manager
# Update the Secrets Manager endpoint in application config
kubectl set env deployment/payment-gateway -n production --context=eks-mumbai \
  AWS_SECRETS_MANAGER_ENDPOINT=https://secretsmanager.ap-south-2.amazonaws.com

kubectl set env deployment/fraud-engine -n production --context=eks-mumbai \
  AWS_SECRETS_MANAGER_ENDPOINT=https://secretsmanager.ap-south-2.amazonaws.com

kubectl set env deployment/settlement-service -n production --context=eks-mumbai \
  AWS_SECRETS_MANAGER_ENDPOINT=https://secretsmanager.ap-south-2.amazonaws.com

kubectl set env deployment/notification-service -n production --context=eks-mumbai \
  AWS_SECRETS_MANAGER_ENDPOINT=https://secretsmanager.ap-south-2.amazonaws.com

# Step 5: Rolling restart to pick up the new endpoint
kubectl rollout restart deployment/payment-gateway -n production --context=eks-mumbai
kubectl rollout restart deployment/fraud-engine -n production --context=eks-mumbai
kubectl rollout restart deployment/settlement-service -n production --context=eks-mumbai
kubectl rollout restart deployment/notification-service -n production --context=eks-mumbai

# Step 6: Verify applications can retrieve secrets from Hyderabad
kubectl logs -n production --context=eks-mumbai \
  -l app=payment-gateway --tail=20 | grep -i "secret"

# Step 7: Monitor AWS Health for Mumbai Secrets Manager recovery
# Once recovered, revert the endpoint
kubectl set env deployment/payment-gateway -n production --context=eks-mumbai \
  AWS_SECRETS_MANAGER_ENDPOINT-

kubectl rollout restart deployment/payment-gateway -n production --context=eks-mumbai

echo "Secrets Manager endpoint redirected to Hyderabad. Monitor for Mumbai recovery."
```

**Decision gate:** If Hyderabad Secrets Manager is also degraded, this is a multi-region AWS service outage. Escalate to AWS Support (SEV1). Applications will rely on cached secrets (if using a sidecar or CSI driver with TTL-based caching). If cached secrets have expired, manual credential injection may be required.

### Scenario D: Credential Expiry During Active Incident (Owner: Security Engineer / SRE | ETA: 5 min)

> Use when a credential is about to expire or has expired during an active incident (e.g., during a region failover or split-brain scenario). The credential must be rotated without disrupting the ongoing incident response.

```bash
# Step 1: Check which secret is expiring
aws secretsmanager describe-secret \
  --secret-id paysecure/db/primary \
  --region ap-south-1 \
  --query '{LastRotatedDate:LastRotatedDate,NextRotationDate:NextRotationDate,RotationEnabled:RotationEnabled}' \
  --output json

# Calculate hours until expiry
NEXT_ROTATION=$(aws secretsmanager describe-secret \
  --secret-id paysecure/db/primary \
  --region ap-south-1 \
  --query 'NextRotationDate' --output text)

CURRENT_TIME=$(date -u +%s)
EXPIRY_TIME=$(date -u -d "$NEXT_ROTATION" +%s)
HOURS_LEFT=$(( (EXPIRY_TIME - CURRENT_TIME) / 3600 ))

echo "Hours until credential expiry: $HOURS_LEFT"

# Step 2: If expiry is imminent (< 2 hours) during an active incident:
# Perform a manual rotation that preserves the AWSPREVIOUS version as fallback

# Step 2a: Retrieve current secret
CURRENT_SECRET=$(aws secretsmanager get-secret-value \
  --secret-id paysecure/db/primary \
  --region ap-south-1 \
  --query 'SecretString' --output text)

CURRENT_PASSWORD=$(echo $CURRENT_SECRET | jq -r '.password')

# Step 2b: Generate new password
NEW_PASSWORD=$(openssl rand -base64 32)

# Step 2c: Update the database with the new password
# Use admin credentials (break-glass) to avoid dependency on the expiring credential
ADMIN_SECRET=$(aws secretsmanager get-secret-value \
  --secret-id paysecure/db/admin-break-glass \
  --region ap-south-1 \
  --query 'SecretString' --output text)

ADMIN_USER=$(echo $ADMIN_SECRET | jq -r '.username')
ADMIN_PASS=$(echo $ADMIN_SECRET | jq -r '.password')
DB_HOST=$(echo $ADMIN_SECRET | jq -r '.host')

PGPASSWORD=$ADMIN_PASS psql -h $DB_HOST -U $ADMIN_USER -d paysecure -c \
  "ALTER USER paysecure_app WITH PASSWORD '$NEW_PASSWORD';"

# Step 2d: Update Secrets Manager — move current to AWSPREVIOUS, new to AWSCURRENT
UPDATED_SECRET=$(echo $CURRENT_SECRET | jq --arg pass "$NEW_PASSWORD" '.password = $pass')

aws secretsmanager put-secret-value \
  --secret-id paysecure/db/primary \
  --secret-string "$UPDATED_SECRET" \
  --version-stages AWSCURRENT \
  --region ap-south-1

# Step 2e: Verify both versions are accessible
aws secretsmanager get-secret-value \
  --secret-id paysecure/db/primary \
  --version-stage AWSCURRENT \
  --region ap-south-1 \
  --query 'SecretString' --output text | jq -r '.password'

aws secretsmanager get-secret-value \
  --secret-id paysecure/db/primary \
  --version-stage AWSPREVIOUS \
  --region ap-south-1 \
  --query 'SecretString' --output text | jq -r '.password'

# Step 2f: Rolling restart of consuming pods (staggered to maintain capacity)
# During an active incident, restart one deployment at a time
kubectl rollout restart deployment/payment-gateway -n production --context=eks-mumbai
kubectl rollout status deployment/payment-gateway -n production --context=eks-mumbai --timeout=120s

kubectl rollout restart deployment/fraud-engine -n production --context=eks-mumbai
kubectl rollout status deployment/fraud-engine -n production --context=eks-mumbai --timeout=120s

kubectl rollout restart deployment/settlement-service -n production --context=eks-mumbai
kubectl rollout status deployment/settlement-service -n production --context=eks-mumbai --timeout=120s

# Step 2g: Verify all pods healthy with new credential
kubectl get pods -n production --context=eks-mumbai

echo "Credential rotated during incident. AWSPREVIOUS version retained as fallback."
```

**Critical note:** During an active incident, never restart all deployments simultaneously. Stagger restarts to maintain at least 50% capacity at all times. If the new credential fails, pods can fall back to `AWSPREVIOUS` if the application is configured for multi-version secret support.

### Scenario E: Cross-Region Secret Desynchronisation (Owner: Platform Engineer | ETA: 8 min)

> Use when Secrets Manager secrets in Hyderabad have diverged from Mumbai — different secret versions, missing secrets, or stale values. This is critical because Hyderabad must have current credentials to connect to promoted data stores during a failover (RB-001).

```bash
# Step 1: Compare secret versions between regions
echo "=== Mumbai (ap-south-1) ==="
aws secretsmanager describe-secret \
  --secret-id paysecure/db/primary \
  --region ap-south-1 \
  --query '{Name:Name,LastChangedDate:LastChangedDate,LastRotatedDate:LastRotatedDate,VersionIdsToStages:VersionIdsToStages}' \
  --output json

echo "=== Hyderabad (ap-south-2) ==="
aws secretsmanager describe-secret \
  --secret-id paysecure/db/primary \
  --region ap-south-2 \
  --query '{Name:Name,LastChangedDate:LastChangedDate,LastRotatedDate:LastRotatedDate,VersionIdsToStages:VersionIdsToStages}' \
  --output json

# Step 2: Compare actual secret values
MUMBAI_SECRET=$(aws secretsmanager get-secret-value \
  --secret-id paysecure/db/primary \
  --region ap-south-1 \
  --query 'SecretString' --output text)

HYDERABAD_SECRET=$(aws secretsmanager get-secret-value \
  --secret-id paysecure/db/primary \
  --region ap-south-2 \
  --query 'SecretString' --output text)

MUMBAI_HASH=$(echo $MUMBAI_SECRET | sha256sum)
HYDERABAD_HASH=$(echo $HYDERABAD_SECRET | sha256sum)

if [ "$MUMBAI_HASH" = "$HYDERABAD_HASH" ]; then
  echo "Secrets match across regions."
else
  echo "WARNING: Secret mismatch detected!"
  echo "Mumbai hash: $MUMBAI_HASH"
  echo "Hyderabad hash: $HYDERABAD_HASH"
fi

# Step 3: Check all production secrets for cross-region consistency
SECRETS=(
  "paysecure/db/primary"
  "paysecure/db/readonly"
  "paysecure/redis/auth"
  "paysecure/kafka/broker"
  "paysecure/api/internal"
  "paysecure/api/external/merchants"
  "paysecure/api/npci"
  "paysecure/s3/backup"
  "paysecure/monitoring/datadog"
  "paysecure/tls/certificate-private-key"
)

FAIL=0
for secret_id in "${SECRETS[@]}"; do
  MUMBAI_VAL=$(aws secretsmanager get-secret-value \
    --secret-id "$secret_id" --region ap-south-1 \
    --query 'SecretString' --output text 2>/dev/null | sha256sum)
  
  HYD_VAL=$(aws secretsmanager get-secret-value \
    --secret-id "$secret_id" --region ap-south-2 \
    --query 'SecretString' --output text 2>/dev/null | sha256sum)
  
  if [ "$MUMBAI_VAL" = "$HYD_VAL" ]; then
    echo "  $secret_id: MATCH"
  else
    echo "  $secret_id: MISMATCH"
    FAIL=1
  fi
done

# Step 4: If secrets are mismatched, replicate Mumbai → Hyderabad
if [ "$FAIL" -eq 1 ]; then
  echo "Replicating secrets from Mumbai to Hyderabad..."
  
  for secret_id in "${SECRETS[@]}"; do
    MUMBAI_SECRET=$(aws secretsmanager get-secret-value \
      --secret-id "$secret_id" --region ap-south-1 \
      --query 'SecretString' --output text)
    
    aws secretsmanager put-secret-value \
      --secret-id "$secret_id" \
      --secret-string "$MUMBAI_SECRET" \
      --region ap-south-2
    
    echo "  $secret_id: replicated"
  done
fi

# Step 5: If a secret is missing entirely in Hyderabad, create it
for secret_id in "${SECRETS[@]}"; do
  EXISTS=$(aws secretsmanager describe-secret \
    --secret-id "$secret_id" --region ap-south-2 \
    --query 'ARN' --output text 2>/dev/null)
  
  if [ -z "$EXISTS" ]; then
    echo "Secret $secret_id missing in Hyderabad — creating..."
    
    # Get Mumbai secret metadata
    MUMBAI_DESC=$(aws secretsmanager describe-secret \
      --secret-id "$secret_id" --region ap-south-1 \
      --query '{Name:Name,Description:Description,KmsKeyId:KmsKeyId}' --output json)
    
    MUMBAI_SECRET=$(aws secretsmanager get-secret-value \
      --secret-id "$secret_id" --region ap-south-1 \
      --query 'SecretString' --output text)
    
    # Create in Hyderabad
    aws secretsmanager create-secret \
      --name "$secret_id" \
      --description "$(echo $MUMBAI_DESC | jq -r '.Description')" \
      --kms-key-id "$(echo $MUMBAI_DESC | jq -r '.KmsKeyId')" \
      --secret-string "$MUMBAI_SECRET" \
      --region ap-south-2
    
    echo "  $secret_id: created in Hyderabad"
  fi
done

# Step 6: Validate cross-region consistency after reconciliation
echo "=== POST-RECONCILIATION VALIDATION ==="
for secret_id in "${SECRETS[@]}"; do
  MUMBAI_VAL=$(aws secretsmanager get-secret-value \
    --secret-id "$secret_id" --region ap-south-1 \
    --query 'SecretString' --output text 2>/dev/null | sha256sum)
  
  HYD_VAL=$(aws secretsmanager get-secret-value \
    --secret-id "$secret_id" --region ap-south-2 \
    --query 'SecretString' --output text 2>/dev/null | sha256sum)
  
  if [ "$MUMBAI_VAL" = "$HYD_VAL" ]; then
    echo "  $secret_id: MATCH"
  else
    echo "  $secret_id: STILL MISMATCHED — manual investigation required"
  fi
done

echo "Cross-region secret reconciliation complete."
```

**Decision gate:** If cross-region secret desync cannot be resolved within 10 minutes, escalate to AWS Support (SEV1) and declare Hyderabad DR readiness as DEGRADED. Do NOT attempt a region failover (RB-001) until secret synchronisation is restored — Hyderabad would be unable to authenticate to promoted data stores.

### Scenario F: Pod Recycling After Secret Rotation (Owner: SRE | ETA: 3 min)

> Standard procedure to ensure all consuming pods pick up newly rotated secrets. Use after any manual or emergency rotation.

```bash
# Step 1: Identify all deployments consuming the rotated secret
# (Maintain this mapping in deployment annotations or a config map)
SECRET_ID="paysecure/db/primary"

# For database credentials, these deployments are affected:
DEPLOYMENTS=(
  "payment-gateway"
  "fraud-engine"
  "settlement-service"
  "notification-service"
  "analytics-service"
  "reporting-service"
  "audit-log-reader"
)

# Step 2: Verify current secret version is AWSCURRENT
aws secretsmanager describe-secret \
  --secret-id $SECRET_ID \
  --region ap-south-1 \
  --query 'VersionIdsToStages' --output json

# Step 3: Staggered rolling restart (maintain capacity)
for deployment in "${DEPLOYMENTS[@]}"; do
  echo "Restarting $deployment..."
  
  # Get current replica count
  REPLICAS=$(kubectl get deployment $deployment -n production \
    --context=eks-mumbai -o jsonpath='{.spec.replicas}')
  
  # If > 1 replica, safe to restart
  if [ "$REPLICAS" -gt 1 ]; then
    kubectl rollout restart deployment/$deployment -n production --context=eks-mumbai
    kubectl rollout status deployment/$deployment -n production \
      --context=eks-mumbai --timeout=120s
  else
    echo "  WARNING: $deployment has only $REPLICAS replica(s) — restart will cause brief downtime"
    kubectl rollout restart deployment/$deployment -n production --context=eks-mumbai
    kubectl rollout status deployment/$deployment -n production \
      --context=eks-mumbai --timeout=120s
  fi
  
  echo "  $deployment: restarted and healthy"
done

# Step 4: Verify all pods are running with the new secret
for deployment in "${DEPLOYMENTS[@]}"; do
  echo "=== $deployment ==="
  kubectl logs -n production --context=eks-mumbai \
    -l app=$deployment --tail=10 | grep -i "database connection\|authenticated\|secret"
done

# Step 5: Verify application health
curl -s https://api.paysecure.example.com/health | jq .
curl -s https://api.paysecure.example.com/health/db | jq .

echo "Pod recycling complete. All deployments using new credentials."
```

### Scenario G: Rollback to Previous Secret Version (Owner: Security Engineer | ETA: 3 min)

> Use when a newly rotated secret causes authentication failures and the previous version must be restored immediately.

```bash
# Step 1: Identify the AWSPREVIOUS version
aws secretsmanager list-secret-version-ids \
  --secret-id paysecure/db/primary \
  --region ap-south-1 \
  --query 'Versions[?VersionStages[?contains(@, `AWSPREVIOUS`)]].VersionId' \
  --output text

PREVIOUS_VERSION_ID=$(aws secretsmanager list-secret-version-ids \
  --secret-id paysecure/db/primary \
  --region ap-south-1 \
  --query 'Versions[?VersionStages[?contains(@, `AWSPREVIOUS`)]].VersionId' \
  --output text)

# Step 2: Retrieve the previous secret value
PREVIOUS_SECRET=$(aws secretsmanager get-secret-value \
  --secret-id paysecure/db/primary \
  --version-id $PREVIOUS_VERSION_ID \
  --region ap-south-1 \
  --query 'SecretString' --output text)

PREVIOUS_PASSWORD=$(echo $PREVIOUS_SECRET | jq -r '.password')

# Step 3: Update the target service with the previous password
ADMIN_SECRET=$(aws secretsmanager get-secret-value \
  --secret-id paysecure/db/admin-break-glass \
  --region ap-south-1 \
  --query 'SecretString' --output text)

ADMIN_USER=$(echo $ADMIN_SECRET | jq -r '.username')
ADMIN_PASS=$(echo $ADMIN_SECRET | jq -r '.password')
DB_HOST=$(echo $ADMIN_SECRET | jq -r '.host')

PGPASSWORD=$ADMIN_PASS psql -h $DB_HOST -U $ADMIN_USER -d paysecure -c \
  "ALTER USER paysecure_app WITH PASSWORD '$PREVIOUS_PASSWORD';"

# Step 4: Promote AWSPREVIOUS to AWSCURRENT in Secrets Manager
aws secretsmanager update-secret-version-stage \
  --secret-id paysecure/db/primary \
  --version-stage AWSCURRENT \
  --remove-from-version-id $(aws secretsmanager describe-secret \
    --secret-id paysecure/db/primary \
    --region ap-south-1 \
    --query 'VersionIdsToStages.AWSCURRENT[0]' --output text) \
  --move-to-version-id $PREVIOUS_VERSION_ID \
  --region ap-south-1

# Step 5: Verify the rollback
aws secretsmanager describe-secret \
  --secret-id paysecure/db/primary \
  --region ap-south-1 \
  --query 'VersionIdsToStages' --output json

# Step 6: Recycle pods to pick up the rolled-back secret
kubectl rollout restart deployment/payment-gateway -n production --context=eks-mumbai
kubectl rollout restart deployment/fraud-engine -n production --context=eks-mumbai
kubectl rollout restart deployment/settlement-service -n production --context=eks-mumbai
kubectl rollout restart deployment/notification-service -n production --context=eks-mumbai

# Step 7: Verify connectivity restored
curl -s https://api.paysecure.example.com/health/db | jq .

echo "Rollback to previous secret version complete."
```

## 7. Secret Replication Validation (Proactive)

### 7.1 Cross-Region Secret Validation Script

> Run this before any planned failover (RB-012 Phase 0) and as a periodic health check.

```bash
#!/bin/bash
# cross-region-secret-validation.sh
# Validates that all Secrets Manager secrets are consistent across regions

echo "=== CROSS-REGION SECRET VALIDATION: $(date -u +%Y-%m-%dT%H:%M:%SZ) ==="
FAIL=0

SECRETS=(
  "paysecure/db/primary"
  "paysecure/db/readonly"
  "paysecure/redis/auth"
  "paysecure/kafka/broker"
  "paysecure/api/internal"
  "paysecure/api/external/merchants"
  "paysecure/api/npci"
  "paysecure/s3/backup"
  "paysecure/monitoring/datadog"
  "paysecure/tls/certificate-private-key"
)

for secret_id in "${SECRETS[@]}"; do
  echo ""
  echo "--- $secret_id ---"
  
  # Check Mumbai
  MUMBAI_EXISTS=$(aws secretsmanager describe-secret \
    --secret-id "$secret_id" --region ap-south-1 \
    --query 'ARN' --output text 2>/dev/null)
  if [ -z "$MUMBAI_EXISTS" ]; then
    echo "  Mumbai: MISSING"
    FAIL=1
    continue
  fi
  
  MUMBAI_VERSION=$(aws secretsmanager describe-secret \
    --secret-id "$secret_id" --region ap-south-1 \
    --query 'VersionIdsToStages.AWSCURRENT[0]' --output text)
  echo "  Mumbai: PRESENT (version: $MUMBAI_VERSION)"
  
  # Check Hyderabad
  HYD_EXISTS=$(aws secretsmanager describe-secret \
    --secret-id "$secret_id" --region ap-south-2 \
    --query 'ARN' --output text 2>/dev/null)
  if [ -z "$HYD_EXISTS" ]; then
    echo "  Hyderabad: MISSING"
    FAIL=1
    continue
  fi
  
  HYD_VERSION=$(aws secretsmanager describe-secret \
    --secret-id "$secret_id" --region ap-south-2 \
    --query 'VersionIdsToStages.AWSCURRENT[0]' --output text)
  echo "  Hyderabad: PRESENT (version: $HYD_VERSION)"
  
  # Compare values
  MUMBAI_VAL=$(aws secretsmanager get-secret-value \
    --secret-id "$secret_id" --region ap-south-1 \
    --query 'SecretString' --output text 2>/dev/null | sha256sum | cut -d' ' -f1)
  
  HYD_VAL=$(aws secretsmanager get-secret-value \
    --secret-id "$secret_id" --region ap-south-2 \
    --query 'SecretString' --output text 2>/dev/null | sha256sum | cut -d' ' -f1)
  
  if [ "$MUMBAI_VAL" = "$HYD_VAL" ]; then
    echo "  Value: MATCH"
  else
    echo "  Value: MISMATCH (Mumbai: $MUMBAI_VAL, Hyderabad: $HYD_VAL)"
    FAIL=1
  fi
  
  # Check rotation status
  ROTATION_ENABLED=$(aws secretsmanager describe-secret \
    --secret-id "$secret_id" --region ap-south-1 \
    --query 'RotationEnabled' --output text 2>/dev/null)
  echo "  Rotation: $ROTATION_ENABLED"
done

echo ""
if [ "$FAIL" -eq 0 ]; then
  echo "=== ALL CROSS-REGION SECRET VALIDATIONS PASSED ==="
else
  echo "=== SOME VALIDATIONS FAILED — DO NOT FAIL OVER UNTIL RESOLVED ==="
fi
```

**Schedule:** Run this validation:
- Before every planned failover (RB-012 Phase 0)
- As a CloudWatch Synthetics canary every 5 minutes
- After any manual or emergency secret rotation (Scenarios A, B, D)
- After any cross-region secret reconciliation (Scenario E)

## 8. Verification Steps

| Check | Command / Method | Expected |
|-------|-----------------|----------|
| All secrets exist in Mumbai | `aws secretsmanager list-secrets --region ap-south-1` | All 10 production secrets listed |
| All secrets exist in Hyderabad | `aws secretsmanager list-secrets --region ap-south-2` | All 10 production secrets listed |
| Rotation enabled for all secrets | `aws secretsmanager describe-secret --query 'RotationEnabled'` | `true` for all rotating secrets |
| No rotation failures | CloudWatch `RotationFailed` metric | 0 failures in last 24h |
| Cross-region secret values match | Scenario 7.1 validation script | All secrets MATCH |
| Database connectivity with current secret | `PGPASSWORD=<secret> psql -h <host> -U <user> -c "SELECT 1"` | 1 row returned |
| Redis connectivity with current secret | `redis-cli -h <host> -a <token> PING` | `PONG` |
| Kafka connectivity with current secret | `kafka-broker-api-versions --bootstrap-server <broker>` | Broker metadata returned |
| Application health (secrets-dependent) | `curl -s https://api.paysecure.example.com/health/secrets` | 200 OK |
| No secrets scheduled for deletion | `aws secretsmanager list-secrets --query 'SecretList[?DeletedDate!=null]'` | Empty list |
| Rotation Lambda healthy | `aws lambda get-function --function-name paysecure-secrets-rotation` | State: Active |
| CloudTrail logging active | `aws cloudtrail describe-trails --query 'trailList[].Status.IsLogging'` | `true` |
| GuardDuty active | `aws guardduty list-detectors` | Detector ID present |

## 9. Rollback Plan

### 9.1 Rollback After Secret Rotation

If a newly rotated secret causes authentication failures:

| Step | Action | Owner | ETA |
|------|--------|-------|-----|
| 1 | Identify AWSPREVIOUS version ID | Security Engineer | 30s |
| 2 | Retrieve previous secret value | Security Engineer | 30s |
| 3 | Update target service with previous credential | Security Engineer | 1 min |
| 4 | Promote AWSPREVIOUS to AWSCURRENT in Secrets Manager | Security Engineer | 30s |
| 5 | Recycle consuming pods (staggered) | SRE | 3 min |
| 6 | Verify connectivity restored | SRE | 1 min |
| 7 | Investigate why new credential failed | Security Engineer | — |

### 9.2 Rollback After Cross-Region Replication

If replicating secrets to Hyderabad causes issues:

| Step | Action | Owner | ETA |
|------|--------|-------|-----|
| 1 | Restore Hyderabad secrets from pre-replication backup | Platform Engineer | 2 min |
| 2 | Validate Hyderabad secrets match pre-change state | Platform Engineer | 1 min |
| 3 | Investigate replication failure root cause | Platform Engineer | — |

### 9.3 Rollback Abort Criteria

- New secret causes authentication failures on any target service
- Cross-region secret replication fails for any secret
- Rotation Lambda fails after manual intervention
- Pod recycling causes capacity drop below 50%
- Any secret enters `PendingDeletion` state during rotation

## 10. Compliance References

| Regulation / Standard | Requirement | How This Runbook Satisfies It |
|-----------------------|-------------|-------------------------------|
| **RBI Master Direction §7.3** | Security incident reporting; credential management | Secret leakage is a reportable incident; Scenario B provides immediate response procedure; all actions logged via CloudTrail |
| **RBI Data Localisation** | Payment system credentials must remain within India | All Secrets Manager secrets stored in Indian regions only; cross-region replication stays within India |
| **PCI-DSS v4.0 Req 3.6.1.2** | Secret and private keys must be stored securely | Secrets Manager encrypts secrets with KMS; access controlled via IAM policies; secret values never logged |
| **PCI-DSS v4.0 Req 3.6.1.3** | Access to secrets must be restricted to least privilege | IAM policies grant `secretsmanager:GetSecretValue` only to authorised service roles; CloudTrail audits all access |
| **PCI-DSS v4.0 Req 3.7.2** | Key management policies must include secret rotation | All database and API credentials on defined rotation schedules (Section 5); automatic rotation via Lambda |
| **PCI-DSS v4.0 Req 8.3.4** | User passwords must be changed at least every 90 days | All secrets have rotation schedules ≤ 90 days; database passwords rotate every 7 days |
| **PCI-DSS v4.0 Req 8.3.9** | If passwords are suspected compromised, change immediately | Scenario B provides emergency rotation procedure with immediate revocation and forensic preservation |
| **PCI-DSS v4.0 Req 10.2–10.3** | Audit trail of all credential access | CloudTrail logs all `GetSecretValue` calls; Scenario B preserves forensic evidence |
| **PCI-DSS v4.0 Req 12.10.1** | Incident response plan for security breaches | This runbook IS the incident response plan for secret leakage and rotation failures |
| **NPCI UPI Technical Standards** | Secure storage of UPI integration credentials | `paysecure/api/npci` secret on 90-day rotation; encrypted with KMS; access restricted to payment-gateway and upi-processor |

## 11. Related Runbooks

| Runbook | Relationship |
|---------|-------------|
| **RB-001: Complete Region Failure** | Secrets Manager degradation in Mumbai may trigger region failover (Scenario C); Hyderabad secret replicas must be validated before failover (Scenario E). RB-001 Phase 5 validates Secrets Manager accessibility post-failover. |
| **RB-007: KMS Key Compromise** | Secrets Manager depends on KMS for encryption; if KMS key is rotated (RB-007 Scenario B), all secrets must be re-encrypted with the new key. Coordinate secret and key rotation to avoid decryption failures. |
| **RB-009: EKS Node Failure** | Pod recycling after secret rotation (Scenario F) interacts with EKS node health; if nodes are degraded, rolling restart may fail. Coordinate with RB-009 if node issues are present. |
| **RB-012: Full Rollback** | Cross-region secret validation (Section 7.1) is a mandatory pre-flight check in RB-012 Phase 0 (Pre-Failback Validation). Secrets Manager accessibility is validated in RB-012 Phase 7. |

## 12. Test Schedule

| Test Type | Frequency | Owner |
|-----------|-----------|-------|
| Automatic rotation success validation | Continuous (CloudWatch alarm) | Security Engineer |
| Manual rotation drill (non-prod) | Monthly | Security Engineer |
| Emergency rotation drill (simulated leak) | Monthly | Security Engineer |
| Cross-region secret validation (Section 7.1) | Every 5 min (automated canary) | Platform Engineer |
| Cross-region secret desync recovery drill | Quarterly | Platform Engineer |
| Secrets Manager regional outage simulation | Quarterly | Chaos Team |
| Pod recycling after rotation (staggered restart) | Monthly | SRE |
| Rollback to previous secret version drill | Quarterly | Security Engineer |
| Full secret leakage tabletop exercise | Bi-annually | CISO + DR Team |

---

**Document Control:** Review and update after every secret rotation incident, security event, or quarterly DR test. Update secrets inventory (Section 5) when new services or credentials are added. Validate cross-region secret consistency (Section 7.1) before every planned failover.