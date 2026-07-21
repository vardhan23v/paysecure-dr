# RB-004: Cache Corruption & Recovery

**Version:** 1.0 | **Last Updated:** 2026-07-20 | **Owner:** Platform Engineering Lead
**Classification:** P1 — Sev 1 | **Expected Recovery Time:** < 5 minutes | **Data Loss Risk:** None (cache is ephemeral)

---

## 1. Purpose

This runbook covers recovery from ElastiCache Redis corruption scenarios including poisoned cache entries, stale data after failover, cache stampede, memory exhaustion, and complete cluster failure. Cache corruption can cause incorrect transaction processing (e.g., stale merchant configs, expired rate limits) and must be resolved quickly.

## 2. Trigger Conditions

| Trigger | Detection Mechanism | Automatic / Manual |
|---------|---------------------|--------------------|
| Cache hit rate drops below 80% | CloudWatch `CacheHitRate` | Automatic — P1 alert |
| Cache miss count > 2× baseline | CloudWatch `CacheMisses` | Automatic — P2 alert |
| Evictions > 1000/min | CloudWatch `Evictions` | Automatic — P1 alert |
| Memory usage > 95% | CloudWatch `DatabaseMemoryUsagePercentage` | Automatic — P1 alert |
| Global Datastore replication lag > 5s | CloudWatch `ReplicationLag` | Automatic — P1 alert |
| Application `RedisConnectionException` > 10/min | Application error logs | Automatic — P2 alert |
| Merchant reports of incorrect payment routing | Support tickets / merchant impact dashboard | Manual — triggers investigation |
| Stale merchant config causing wrong gateway selection | Application logs: `routing_mismatch` events | Manual — detected during reconciliation |
| Rate-limit bypass due to missing/expired counters | Application logs: rate-limit miss events | Automatic — P2 alert |
| Duplicate transaction detection failure (idempotency cache miss) | Application logs: `idempotency_miss` events | Automatic — P2 alert |

**Decision gate:** If cache hit rate < 80% AND merchant config namespace affected, treat as Sev 0 (revenue impact). If only non-critical namespaces affected, follow P1 procedure.

## 3. Impact Assessment

| Impact Dimension | Severity | Detail |
|------------------|----------|--------|
| **Payment Routing** | Critical | Stale `merchant:*` or `routing:*` entries cause payments to route to wrong gateways → transaction failures |
| **Revenue** | High | Failed payments due to incorrect routing; ~X% of transactions may fail until cache is corrected |
| **Rate Limiting** | High | Corrupted `rate_limit:*` entries → DOS risk or rate-limit bypass; PCI-DSS and NPCI compliance risk |
| **Fraud Detection** | Medium | Stale `fraud:*` scores → false positives (legitimate transactions blocked) or false negatives (fraud missed) |
| **Duplicate Transactions** | Critical | `idempotency:*` cache miss → duplicate transaction processing; financial reconciliation required |
| **Session Management** | Medium | `session:*` corruption → user auth failures; merchant dashboard inaccessible |
| **Database Load** | High | Cache miss spike → elevated Aurora load; risk of cascading DB performance degradation |
| **Recovery Complexity** | Low–Medium | Cache is ephemeral; flush + warm restores state within 5 min; no permanent data loss |

**Worst-case scenario:** Widespread cache corruption across `merchant:`, `routing:`, and `idempotency:` namespaces simultaneously. Mitigation: full cache flush + hot-key warming (Section 6.2 + Section 8).

## 4. Prerequisites

- [ ] AWS CLI with ElastiCache permissions
- [ ] Redis CLI (`redis-cli`) with TLS configuration
- [ ] Access to ElastiCache metrics in CloudWatch
- [ ] Application deployment pipeline access (for cache warming)
- [ ] Cache namespace documentation (TTLs, key patterns, eviction policies)

## 5. Cache Namespace Reference

| Namespace | Key Pattern | TTL | Eviction | Criticality |
|-----------|------------|-----|----------|-------------|
| `merchant:` | `merchant:{id}:config` | 300s | volatile-lru | HIGH — incorrect config = wrong routing |
| `rate_limit:` | `rate_limit:{api_key}:{endpoint}` | 60s | volatile-ttl | HIGH — corruption = DOS risk |
| `fraud:` | `fraud:{txn_id}:score` | 600s | volatile-lru | MEDIUM — stale scores = false positives |
| `session:` | `session:{token}` | 1800s | volatile-lru | MEDIUM — invalid sessions = auth failures |
| `routing:` | `routing:{bin}:gateway` | 3600s | volatile-lru | HIGH — wrong gateway = failed payments |
| `idempotency:` | `idempotency:{txn_id}` | 86400s | volatile-lru | HIGH — duplicate detection |

## 6. Detection

### 6.1 Automated Alerts

| Alert | Metric | P1 Threshold | P2 Threshold |
|-------|--------|-------------|-------------|
| Cache hit rate drop | `CacheHitRate` | < 80% | < 90% |
| Cache miss spike | `CacheMisses` | > 2x baseline | > 1.5x baseline |
| Evictions spike | `Evictions` | > 1000/min | > 500/min |
| Memory usage > 90% | `DatabaseMemoryUsagePercentage` | > 95% | > 90% |
| Replication lag (Global Datastore) | `ReplicationLag` | > 5s | > 2s |
| Application cache errors | App logs `RedisConnectionException` | > 10/min | > 5/min |

### 6.2 Verification Commands

```bash
# Check cluster health
aws elasticache describe-replication-groups \
  --replication-group-id paysecure-redis-primary \
  --region ap-south-1 \
  --query 'ReplicationGroups[0].[Status,MemberClusters]'

# Check memory usage
aws cloudwatch get-metric-statistics --region ap-south-1 \
  --namespace AWS/ElastiCache --metric-name DatabaseMemoryUsagePercentage \
  --dimensions Name=CacheClusterId,Value=paysecure-redis-001 \
  --start-time $(date -u -d '5 minutes ago' +%Y-%m-%dT%H:%M:%SZ) \
  --end-time $(date -u +%Y-%m-%dT%H:%M:%SZ) \
  --period 60 --statistics Average

# Sample cache keys for corruption
redis-cli -h paysecure-redis-primary.xxx.ng.0001.aps1.cache.amazonaws.com \
  --tls -a "${REDIS_AUTH_TOKEN}" \
  --scan --pattern "merchant:*" --count 10
```

## 7. Scenario A: Poisoned Cache Entries

### 7.1 Identify Poisoned Keys (Owner: Platform Engineer | ETA: 2 min)

```bash
# If a specific merchant/config is returning wrong data:
# 1. Check the cached value
redis-cli -h paysecure-redis-primary.xxx.ng.0001.aps1.cache.amazonaws.com \
  --tls -a "${REDIS_AUTH_TOKEN}" \
  GET "merchant:MERCH001:config"

# 2. Compare with source of truth (Aurora)
psql -h paysecure-aurora-primary.cluster-xxx.ap-south-1.rds.amazonaws.com \
  -U admin -d paysecure \
  -c "SELECT config FROM merchant_configs WHERE merchant_id = 'MERCH001';"

# 3. Check TTL
redis-cli -h paysecure-redis-primary.xxx.ng.0001.aps1.cache.amazonaws.com \
  --tls -a "${REDIS_AUTH_TOKEN}" \
  TTL "merchant:MERCH001:config"
```

### 7.2 Targeted Invalidation (Owner: Platform Engineer | ETA: 1 min)

```bash
# Delete specific poisoned key(s)
redis-cli -h paysecure-redis-primary.xxx.ng.0001.aps1.cache.amazonaws.com \
  --tls -a "${REDIS_AUTH_TOKEN}" \
  DEL "merchant:MERCH001:config"

# Delete by pattern (use with caution — SCAN + DEL in Lua)
redis-cli -h paysecure-redis-primary.xxx.ng.0001.aps1.cache.amazonaws.com \
  --tls -a "${REDIS_AUTH_TOKEN}" \
  --scan --pattern "merchant:MERCH001:*" | xargs -L 1 redis-cli -h paysecure-redis-primary.xxx.ng.0001.aps1.cache.amazonaws.com --tls -a "${REDIS_AUTH_TOKEN}" DEL

# Verify key is gone and will be repopulated from DB on next read
redis-cli -h paysecure-redis-primary.xxx.ng.0001.aps1.cache.amazonaws.com \
  --tls -a "${REDIS_AUTH_TOKEN}" \
  EXISTS "merchant:MERCH001:config"
```

## 8. Scenario B: Full Cache Flush

### 8.1 When to Flush

- Widespread corruption across multiple namespaces
- After database failover where cache is stale
- After schema migration that invalidates all cached data
- Memory exhaustion with no time for selective invalidation

### 8.2 Flush Procedure (Owner: Platform Engineer | ETA: 3–5 min)

```bash
# Step 1: Notify stakeholders — expect elevated DB load for 2-5 minutes
# Step 2: Enable cache warming mode in application (if available)
curl -X POST https://api.paysecure.example.com/admin/cache/warm-mode \
  -H "Authorization: Bearer ${ADMIN_TOKEN}" \
  -d '{"enabled": true}'

# Step 3: Flush all databases on primary
redis-cli -h paysecure-redis-primary.xxx.ng.0001.aps1.cache.amazonaws.com \
  --tls -a "${REDIS_AUTH_TOKEN}" \
  FLUSHALL

# Step 4: Verify flush
redis-cli -h paysecure-redis-primary.xxx.ng.0001.aps1.cache.amazonaws.com \
  --tls -a "${REDIS_AUTH_TOKEN}" \
  DBSIZE
# Expected: 0

# Step 5: Trigger cache warming (see Section 8)
# Step 6: Monitor DB load during warming
aws cloudwatch get-metric-statistics --region ap-south-1 \
  --namespace AWS/RDS --metric-name DatabaseConnections \
  --dimensions Name=DBClusterIdentifier,Value=paysecure-aurora-primary \
  --start-time $(date -u -d '2 minutes ago' +%Y-%m-%dT%H:%M:%SZ) \
  --end-time $(date -u +%Y-%m-%dT%H:%M:%SZ) \
  --period 30 --statistics Average

# Step 7: Disable warming mode once cache hit rate normalises
curl -X POST https://api.paysecure.example.com/admin/cache/warm-mode \
  -H "Authorization: Bearer ${ADMIN_TOKEN}" \
  -d '{"enabled": false}'
```

## 9. Scenario C: Cache Stampede

### 9.1 Detection (Owner: Platform Engineer | ETA: 2 min)

```bash
# Symptoms: DB CPU spike, cache miss spike, latency spike
# Check if multiple clients are requesting the same uncached key simultaneously

# Check DB connections
aws cloudwatch get-metric-statistics --region ap-south-1 \
  --namespace AWS/RDS --metric-name DatabaseConnections \
  --dimensions Name=DBClusterIdentifier,Value=paysecure-aurora-primary \
  --start-time $(date -u -d '5 minutes ago' +%Y-%m-%dT%H:%M:%SZ) \
  --end-time $(date -u +%Y-%m-%dT%H:%M:%SZ) \
  --period 30 --statistics Maximum

# Check cache miss rate
aws cloudwatch get-metric-statistics --region ap-south-1 \
  --namespace AWS/ElastiCache --metric-name CacheMisses \
  --dimensions Name=CacheClusterId,Value=paysecure-redis-001 \
  --start-time $(date -u -d '5 minutes ago' +%Y-%m-%dT%H:%M:%SZ) \
  --end-time $(date -u +%Y-%m-%dT%H:%M:%SZ) \
  --period 30 --statistics Sum
```

### 9.2 Mitigation (Owner: Platform Engineer / SRE | ETA: 3 min)

```bash
# Option A: Pre-warm the hot key
redis-cli -h paysecure-redis-primary.xxx.ng.0001.aps1.cache.amazonaws.com \
  --tls -a "${REDIS_AUTH_TOKEN}" \
  SET "merchant:HOTMERCH:config" "$(psql -h ... -t -c "SELECT config FROM merchant_configs WHERE merchant_id = 'HOTMERCH'")" EX 300

# Option B: Enable request coalescing at application layer (if implemented)
# This is a code-level feature — ensure it's enabled in config

# Option C: Temporarily increase DB connection pool
kubectl set env deployment/payment-gateway -n production \
  DB_POOL_MAX=50  # Up from default 20

# Option D: Rate-limit cache-miss requests at API gateway
# Apply temporary rate limit rule
```

## 10. Cache Warming Strategy

### 10.1 Hot-Key Pre-Warming (Owner: Platform Engineer | ETA: 2–5 min)

```bash
# Script: warm-hot-keys.sh
# Pre-loads the top 1000 most-accessed keys from Aurora

HOT_KEYS=$(psql -h paysecure-aurora-primary.cluster-xxx.ap-south-1.rds.amazonaws.com \
  -U admin -d paysecure -t -c "
    SELECT key_pattern FROM cache_hot_keys
    ORDER BY access_count DESC LIMIT 1000;
  ")

for key in $HOT_KEYS; do
  VALUE=$(psql -h paysecure-aurora-primary.cluster-xxx.ap-south-1.rds.amazonaws.com \
    -U admin -d paysecure -t -c "SELECT value FROM cache_source WHERE key = '$key';")
  redis-cli -h paysecure-redis-primary.xxx.ng.0001.aps1.cache.amazonaws.com \
    --tls -a "${REDIS_AUTH_TOKEN}" \
    SET "$key" "$VALUE" EX 300
done
```

### 10.2 Failover Priming (Owner: Platform Engineer | ETA: 2 min)

```bash
# After failover to Hyderabad, prime the cache with critical data
# Run this immediately after ElastiCache promotion (RB-001 Phase 2.3)

# Prime merchant configs (critical for payment routing)
psql -h paysecure-aurora-secondary.cluster-xxx.ap-south-2.rds.amazonaws.com \
  -U admin -d paysecure -t -c "
    SELECT merchant_id, config FROM merchant_configs WHERE is_active = true;
  " | while read -r mid config; do
    redis-cli -h paysecure-redis-hyderabad.xxx.ng.0001.aps2.cache.amazonaws.com \
      --tls -a "${REDIS_AUTH_TOKEN}" \
      SET "merchant:${mid}:config" "${config}" EX 300
  done

# Prime routing table
psql -h paysecure-aurora-secondary.cluster-xxx.ap-south-2.rds.amazonaws.com \
  -U admin -d paysecure -t -c "
    SELECT bin, gateway FROM routing_table;
  " | while read -r bin gateway; do
    redis-cli -h paysecure-redis-hyderabad.xxx.ng.0001.aps2.cache.amazonaws.com \
      --tls -a "${REDIS_AUTH_TOKEN}" \
      SET "routing:${bin}:gateway" "${gateway}" EX 3600
  done
```

## 11. Scenario D: Complete Cluster Failure

### 11.1 Failover to Secondary (Owner: Platform Engineer / SRE | ETA: 3 min)

```bash
# If primary Redis cluster is completely unavailable:
# Promote Hyderabad Global Datastore secondary to primary
aws elasticache failover-global-replication-group \
  --global-replication-group-id paysecure-redis-global \
  --primary-region ap-south-2 \
  --primary-replication-group-id paysecure-redis-hyderabad

# Update application Redis endpoint
kubectl set env deployment/payment-gateway -n production \
  REDIS_HOST=paysecure-redis-hyderabad.xxx.ng.0001.aps2.cache.amazonaws.com

# Rolling restart to pick up new endpoint
kubectl rollout restart deployment/payment-gateway -n production
kubectl rollout restart deployment/fraud-engine -n production
kubectl rollout restart deployment/settlement-service -n production
```

### 11.2 Bootstrap Fresh Cache (Owner: Platform Engineer | ETA: 5–10 min)

```bash
# If no secondary is available, bootstrap from scratch
# 1. Create new cluster (if needed)
aws elasticache create-replication-group \
  --replication-group-id paysecure-redis-recovery \
  --replication-group-description "Recovery cluster" \
  --cache-node-type cache.r6g.xlarge \
  --engine redis --engine-version 7.0 \
  --num-node-groups 3 --replicas-per-node-group 1 \
  --region ap-south-1

# 2. Point application to new cluster
# 3. Run cache warming (Section 8)
# 4. Accept elevated latency for 5-10 minutes while cache fills
```

## 12. Verification Steps

```bash
# 1. Cache hit rate recovering
aws cloudwatch get-metric-statistics --region ap-south-1 \
  --namespace AWS/ElastiCache --metric-name CacheHitRate \
  --dimensions Name=CacheClusterId,Value=paysecure-redis-001 \
  --start-time $(date -u -d '5 minutes ago' +%Y-%m-%dT%H:%M:%SZ) \
  --end-time $(date -u +%Y-%m-%dT%H:%M:%SZ) \
  --period 60 --statistics Average

# 2. No eviction spikes
aws cloudwatch get-metric-statistics --region ap-south-1 \
  --namespace AWS/ElastiCache --metric-name Evictions \
  --dimensions Name=CacheClusterId,Value=paysecure-redis-001 \
  --start-time $(date -u -d '5 minutes ago' +%Y-%m-%dT%H:%M:%SZ) \
  --end-time $(date -u +%Y-%m-%dT%H:%M:%SZ) \
  --period 60 --statistics Sum

# 3. Application health
curl -s https://api.paysecure.example.com/health/cache | jq .

# 4. Synthetic transaction with cache-dependent routing
curl -s -X POST https://api.paysecure.example.com/v1/payments/test \
  -H "Content-Type: application/json" \
  -d '{"amount": 100, "currency": "INR", "merchant_id": "TESTMERCH001", "test_mode": true}'
```

## 13. Rollback Plan

### 13.1 Full Cache Flush Rollback

If cache warming after flush causes database overload:

| Step | Action | Owner | ETA |
|------|--------|-------|-----|
| 1 | Pause cache warming job immediately | Platform Engineer | 30s |
| 2 | Enable request coalescing at application layer (if not already on) | SRE | 1 min |
| 3 | Temporarily increase Aurora reader instance count to handle elevated read load | DB Engineer | 2 min |
| 4 | Resume cache warming with throttled concurrency (50% rate) | Platform Engineer | 1 min |
| 5 | Monitor DB CPU and connection count; if stable, gradually increase warming rate | Platform Engineer | 5 min |
| 6 | Once cache hit rate > 90%, disable warming mode and scale down readers | Platform Engineer | 2 min |

### 13.2 Cache Failover Rollback (Hyderabad → Mumbai)

If ElastiCache was failed over to Hyderabad and Mumbai recovers:

| Step | Action | Owner | ETA |
|------|--------|-------|-----|
| 1 | Verify Mumbai ElastiCache cluster is healthy | Platform Engineer | 2 min |
| 2 | Re-establish Global Datastore with Mumbai as primary | Platform Engineer | 3 min |
| 3 | Wait for initial sync; verify replication lag < 2s | Platform Engineer | 5 min |
| 4 | Prime Mumbai cache with hot keys from Hyderabad (reverse warming) | Platform Engineer | 2 min |
| 5 | Switch application Redis endpoint back to Mumbai | SRE | 1 min |
| 6 | Rolling restart of cache-dependent services | SRE | 2 min |
| 7 | Verify cache hit rate > 90% in Mumbai | Platform Engineer | 2 min |
| 8 | Scale Hyderabad ElastiCache back to baseline | Platform Engineer | 1 min |

### 13.3 Targeted Invalidation Rollback

If deleting poisoned keys causes unexpected application behaviour:

| Step | Action | Owner | ETA |
|------|--------|-------|-----|
| 1 | Restore deleted keys from Aurora source-of-truth immediately | Platform Engineer | 1 min |
| 2 | Verify key values match expected data | Platform Engineer | 1 min |
| 3 | Investigate root cause of why invalidation caused issues | Platform Engineer | 5 min |
| 4 | If corruption was in source-of-truth (Aurora), escalate to RB-002 | Incident Commander | — |

### 13.4 Prevention Measures

| Measure | Implementation | Owner |
|---------|---------------|-------|
| TTL discipline | All keys must have TTL; no infinite TTL keys | Platform |
| Cache-aside pattern | Application handles cache misses gracefully | Engineering |
| Request coalescing | Single-flight pattern for hot keys | Engineering |
| Memory monitoring | P1 alert at 95%, P2 at 90% | SRE |
| Global Datastore | Cross-region replication for DR | Platform |
| Regular cache audits | Monthly review of key patterns and TTLs | Platform |

## 14. Compliance References

| Regulation / Standard | Requirement | How This Runbook Satisfies It |
|-----------------------|-------------|-------------------------------|
| **RBI Master Direction §4.2.1** | Payment system data integrity and correct transaction routing | `merchant:*` and `routing:*` cache namespaces directly affect payment routing; targeted invalidation (Section 7) and full flush (Section 8) restore correct routing within RTO |
| **RBI Data Localisation** | All payment data must reside within India | ElastiCache clusters in `ap-south-1` and `ap-south-2`; Global Datastore replication stays within Indian regions; no cross-border cache data |
| **PCI-DSS v4.0 Req 3.4** | PAN must be rendered unreadable anywhere it is stored | Cache does NOT store PAN or full cardholder data; only tokenised references and configuration; verified in cache namespace audit (Section 5) |
| **PCI-DSS v4.0 Req 6.4.3** | Payment page integrity — all scripts and configurations must be authorised | `merchant:*:config` cache entries are sourced from Aurora (source of truth); poisoned entries detected via comparison (Section 7.1); invalidated immediately |
| **PCI-DSS v4.0 Req 11.4** | Intrusion detection via rate limiting and anomaly detection | `rate_limit:*` namespace enforces per-API-key rate limits; corruption → DOS risk; P1 alert on cache miss spike triggers immediate investigation |
| **PCI-DSS v4.0 Req 12.10.1** | Incident response readiness for service degradation | This runbook covers poisoned entries, cache stampede, memory exhaustion, and complete cluster failure; P1 alerts enable < 5 min response |
| **NPCI UPI Technical Standards** | Transaction idempotency and duplicate detection | `idempotency:*` namespace with 24h TTL prevents duplicate UPI transaction processing; cache miss → fallback to DynamoDB idempotency table |
| **NPCI UPI** | System availability and performance | Cache warming strategy (Section 10) ensures hot keys are pre-loaded; failover priming (Section 10.2) enables < 5 min cache readiness after region failover |

## 15. Related Runbooks

- RB-001: Complete Region Failure
- RB-002: Database Split-Brain
- RB-006: Peak-Load Failover
- RB-011: Partial Regional Degradation

## 16. Test Schedule

| Test Type | Frequency | Owner |
|-----------|-----------|-------|
| Targeted key invalidation drill | Weekly | Platform |
| Full cache flush + warming drill | Bi-weekly | DR Team |
| Cache stampede simulation | Monthly | Chaos Team |
| Redis cluster failure + failover | Monthly | DR Team |