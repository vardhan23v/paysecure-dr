# RB-006: Peak-Load Failover

**Version:** 1.0 | **Last Updated:** 2026-07-20 | **Owner:** SRE Lead / Platform Engineer
**Classification:** P1 — Sev 1 | **Expected RTO:** < 5 minutes | **Expected RPO:** < 1 minute

---

## 1. Purpose

This runbook covers scenarios where traffic surges beyond Mumbai's provisioned capacity, including merchant campaign-induced spikes, seasonal load (Diwali, UPI festival peaks), DDoS attacks overwhelming the primary region, and upstream provider rate-limiting. The objective is to protect transaction integrity by either absorbing the surge through proactive scaling or failing over to Hyderabad for additional capacity before Mumbai degrades.

## 2. Trigger Conditions

| Trigger | Detection Mechanism | Automatic / Manual |
|---------|---------------------|--------------------|
| ALB request count exceeds 80% of provisioned capacity | CloudWatch `RequestCount` > threshold | Automatic — P2 alert |
| EKS node CPU/Memory > 85% across all nodes | CloudWatch `node_cpu_utilization` / `node_memory_utilization` | Automatic — P2 alert; Cluster Autoscaler triggers |
| Aurora connection count > 80% of `max_connections` | CloudWatch `DatabaseConnections` | Automatic — P1 alert |
| DynamoDB throttled requests (WriteThrottleEvents > 0) | CloudWatch `WriteThrottleEvents` | Automatic — P1 alert |
| ElastiCache `CacheHitRate` drops below 70% | CloudWatch `CacheHitRate` | Automatic — P2 alert |
| MSK consumer lag > 100,000 messages | CloudWatch / custom lag exporter | Automatic — P1 alert |
| P95 API latency > 2s (baseline < 200ms) | CloudWatch `p95` on ALB TargetResponseTime | Automatic — P1 alert |
| API error rate (5xx) > 1% | CloudWatch `HTTPCode_Target_5XX_Count` | Automatic — P1 alert |
| Known merchant campaign or seasonal event approaching | Merchant calendar / marketing schedule | Manual — proactive scaling |
| AWS Shield Advanced DDoS detected | Shield Advanced alert | Automatic — Shield Advanced auto-mitigation |

**Decision gate:** If Mumbai is degrading but still partially functional, attempt in-place scaling first (Scenario A). If Mumbai cannot scale fast enough or is already failing, fail over to Hyderabad (Scenario B). If this is a DDoS, engage Scenario C.

## 3. Impact Assessment

| Impact Dimension | Severity | Detail |
|------------------|----------|--------|
| **Service Availability** | High–Critical | Degraded performance → complete outage if capacity is exhausted |
| **Revenue** | High–Critical | Transaction failures or timeouts during peak; revenue loss proportional to degradation |
| **Merchant Experience** | High | Slow API responses, timeouts, partial failures; merchant trust erosion |
| **End-Customer Experience** | High | Payment failures at checkout; cart abandonment; customer frustration |
| **Settlement Risk** | Medium | Delayed settlement batches if processing backlog accumulates |
| **Regulatory** | Medium | NPCI UPI SLA breach if latency exceeds thresholds; RBI reporting if outage > 15 min |
| **Data Loss (RPO)** | Low | Replication lag may increase under load but bounded by monitoring thresholds |
| **Recovery Complexity** | Medium | Scaling is automated but may need manual intervention; failover to Hyderabad is well-rehearsed |

**Worst-case acceptable degradation:** P95 latency < 5s, error rate < 5%. Beyond these, fail over to Hyderabad.

## 4. Prerequisites

- [ ] EKS Cluster Autoscaler configured and tested in both regions
- [ ] HPA (Horizontal Pod Autoscaler) configured for all critical deployments with `minReplicas` and `maxReplicas`
- [ ] Hyderabad warm standby at baseline capacity (can scale to full production in < 3 min)
- [ ] Circuit breaker thresholds defined in application config (e.g., Resilience4j)
- [ ] Rate limiter configuration in API Gateway with per-merchant quotas
- [ ] AWS Service Quotas reviewed and increased for peak capacity (EC2 instances, RDS connections, DynamoDB WCU/RCU)
- [ ] Pre-warmed EBS volumes and cached AMIs in Hyderabad for rapid node provisioning
- [ ] Merchant campaign calendar accessible for proactive scaling decisions
- [ ] DDoS response plan reviewed with AWS Shield Advanced team

## 5. Recovery Procedure

### Scenario A: In-Place Scaling — Mumbai Absorbs Surge (Owner: SRE | ETA: 3–5 min)

> Use when Mumbai is still functional but approaching capacity limits.

```bash
# Step 1: Assess current load and headroom
echo "=== MUMBAI CAPACITY ASSESSMENT ==="
kubectl top nodes --context=eks-mumbai
kubectl top pods -n production --context=eks-mumbai
kubectl get hpa -n production --context=eks-mumbai

# Aurora connections
aws cloudwatch get-metric-statistics --region ap-south-1 \
  --namespace AWS/RDS --metric-name DatabaseConnections \
  --dimensions Name=DBClusterIdentifier,Value=paysecure-aurora-primary \
  --start-time "$(date -u -d '5 minutes ago' +%Y-%m-%dT%H:%M:%SZ)" \
  --end-time "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
  --period 60 --statistics Maximum \
  --query 'Datapoints[-1].Maximum' --output text

# DynamoDB throttling
aws cloudwatch get-metric-statistics --region ap-south-1 \
  --namespace AWS/DynamoDB --metric-name WriteThrottleEvents \
  --dimensions Name=TableName,Value=paysecure-transactions \
  --start-time "$(date -u -d '5 minutes ago' +%Y-%m-%dT%H:%M:%SZ)" \
  --end-time "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
  --period 60 --statistics Sum \
  --query 'Datapoints[-1].Sum' --output text

# Step 2: Scale EKS deployments beyond normal max
kubectl patch hpa payment-gateway -n production --context=eks-mumbai \
  --patch '{"spec":{"maxReplicas":12}}'
kubectl patch hpa fraud-engine -n production --context=eks-mumbai \
  --patch '{"spec":{"maxReplicas":8}}'
kubectl patch hpa api-gateway -n production --context=eks-mumbai \
  --patch '{"spec":{"maxReplicas":12}}'

# Step 3: Scale up Aurora reader instances (if read-heavy surge)
aws rds create-db-instance \
  --db-instance-identifier paysecure-aurora-primary-reader-surge \
  --db-cluster-identifier paysecure-aurora-primary \
  --db-instance-class db.r6g.xlarge \
  --engine aurora-postgresql \
  --region ap-south-1

# Step 4: Increase DynamoDB provisioned capacity
aws dynamodb update-table \
  --table-name paysecure-transactions \
  --billing-mode PROVISIONED \
  --provisioned-throughput ReadCapacityUnits=20000,WriteCapacityUnits=20000 \
  --region ap-south-1

# Step 5: Scale ElastiCache (add read replicas)
aws elasticache increase-replica-count \
  --replication-group-id paysecure-redis-primary \
  --new-replica-count 3 \
  --apply-immediately \
  --region ap-south-1

# Step 6: Verify scaling is effective
sleep 60
echo "=== POST-SCALE CAPACITY ASSESSMENT ==="
kubectl get pods -n production --context=eks-mumbai | grep -c Running
kubectl get hpa -n production --context=eks-mumbai

# Step 7: Monitor for 2 minutes — if still degrading, proceed to Scenario B
```

**Abort criteria (Scenario A):** P95 latency still > 2s after scaling; error rate still > 1%; Aurora connections still > 80% of max; DynamoDB throttling persists; new nodes fail to join cluster within 3 min.

### Scenario B: Emergency Failover to Hyderabad (Owner: SRE / Incident Commander | ETA: 5 min)

> Use when Mumbai cannot absorb the surge or is already failing.

```bash
# Step 1: Declare incident — "Peak load exceeding Mumbai capacity"
# Notify Incident Commander, DR Coordinator, SRE Lead

# Step 2: Activate circuit breakers for non-critical features in Mumbai
kubectl set env deployment/payment-gateway -n production --context=eks-mumbai \
  CIRCUIT_BREAKER_ANALYTICS_ENABLED=false \
  CIRCUIT_BREAKER_WEBHOOK_BATCH_ENABLED=false \
  CIRCUIT_BREAKER_REPORT_GENERATION_ENABLED=false

# Step 3: Scale Hyderabad EKS to production capacity
kubectl config use-context eks-hyderabad
kubectl scale deployment payment-gateway -n production --replicas=6
kubectl scale deployment fraud-engine -n production --replicas=4
kubectl scale deployment settlement-service -n production --replicas=3
kubectl scale deployment notification-service -n production --replicas=2
kubectl scale deployment api-gateway -n production --replicas=6

kubectl wait --for=condition=ready pod \
  -l app.kubernetes.io/part-of=paysecure \
  -n production \
  --timeout=180s

# Step 4: Promote Hyderabad data stores (if not already promoted)
# See RB-001 Phase 2 for full data store promotion
aws rds describe-db-clusters \
  --db-cluster-identifier paysecure-aurora-secondary \
  --region ap-south-2 \
  --query 'DBClusters[0].DBClusterMembers[?IsClusterWriter==`true`].DBInstanceIdentifier'

# If no writer, promote:
aws rds promote-read-replica-db-cluster \
  --db-cluster-identifier paysecure-aurora-secondary \
  --region ap-south-2

# Step 5: Shift traffic to Hyderabad via weighted DNS — start with 50%
aws route53 change-resource-record-sets \
  --hosted-zone-id ZXXXXXXXXXXXX \
  --change-batch '{
    "Changes": [{
      "Action": "UPSERT",
      "ResourceRecordSet": {
        "Name": "api.paysecure.example.com", "Type": "A",
        "SetIdentifier": "mumbai", "Weight": 50,
        "AliasTarget": {
          "HostedZoneId": "Z2XXXXXXXXXXXX",
          "DNSName": "paysecure-alb-mumbai-1234567890.ap-south-1.elb.amazonaws.com",
          "EvaluateTargetHealth": true
        }
      }
    }, {
      "Action": "UPSERT",
      "ResourceRecordSet": {
        "Name": "api.paysecure.example.com", "Type": "A",
        "SetIdentifier": "hyderabad", "Weight": 50,
        "AliasTarget": {
          "HostedZoneId": "Z2XXXXXXXXXXXX",
          "DNSName": "paysecure-alb-hyderabad-1234567890.ap-south-2.elb.amazonaws.com",
          "EvaluateTargetHealth": true
        }
      }
    }]
  }'

# Step 6: Monitor both regions for 2 minutes
sleep 120

# Step 7: If Mumbai is still degrading, shift to 100% Hyderabad
aws route53 change-resource-record-sets \
  --hosted-zone-id ZXXXXXXXXXXXX \
  --change-batch '{
    "Changes": [{
      "Action": "UPSERT",
      "ResourceRecordSet": {
        "Name": "api.paysecure.example.com", "Type": "A",
        "SetIdentifier": "mumbai", "Weight": 0,
        "AliasTarget": {
          "HostedZoneId": "Z2XXXXXXXXXXXX",
          "DNSName": "paysecure-alb-mumbai-1234567890.ap-south-1.elb.amazonaws.com",
          "EvaluateTargetHealth": true
        }
      }
    }, {
      "Action": "UPSERT",
      "ResourceRecordSet": {
        "Name": "api.paysecure.example.com", "Type": "A",
        "SetIdentifier": "hyderabad", "Weight": 100,
        "AliasTarget": {
          "HostedZoneId": "Z2XXXXXXXXXXXX",
          "DNSName": "paysecure-alb-hyderabad-1234567890.ap-south-2.elb.amazonaws.com",
          "EvaluateTargetHealth": true
        }
      }
    }]
  }'

echo "Traffic shifted to 100% Hyderabad. Mumbai can recover."
```

**Abort criteria (Scenario B):** Hyderabad fails to scale within 3 min; Hyderabad health checks fail; data store promotion fails.

### Scenario C: DDoS Attack Mitigation (Owner: Security Engineer / SRE | ETA: 5 min)

```bash
# Step 1: Confirm DDoS attack with AWS Shield Advanced
aws shield describe-attack --attack-id <attack-id>
aws shield describe-protection --resource-arn <alb-arn>

# Step 2: Verify Shield Advanced automatic mitigation is active

# Step 3: If attack is application-layer (L7), apply WAF rate-based rules
aws wafv2 update-web-acl \
  --name paysecure-waf --scope REGIONAL --region ap-south-1 \
  --rules '[{
    "Name": "DDoS-RateLimit-Emergency", "Priority": 1,
    "Statement": {
      "RateBasedStatement": {"Limit": 100, "AggregateKeyType": "IP"}
    },
    "Action": {"Block": {}},
    "VisibilityConfig": {
      "SampledRequestsEnabled": true,
      "CloudWatchMetricsEnabled": true,
      "MetricName": "DDoSRateLimitEmergency"
    }
  }]'

# Step 4: If attack is volumetric (L3/L4), engage AWS DRT
# Via AWS Support — SEV1 ticket with "DDoS Attack — Requesting DRT engagement"

# Step 5: If Mumbai is overwhelmed, fail over to Hyderabad (Scenario B)
# DDoS may follow the DNS — be prepared to shift again
```

### Scenario D: Proactive Pre-Peak Scaling (Owner: SRE | ETA: 10 min — pre-scheduled)

> For known events: Diwali, UPI festival sales, merchant campaigns. Execute BEFORE the peak.

```bash
# Step 1: Pre-scale Mumbai 2 hours before expected peak
kubectl scale deployment payment-gateway -n production --context=eks-mumbai --replicas=12
kubectl scale deployment fraud-engine -n production --context=eks-mumbai --replicas=8
kubectl scale deployment settlement-service -n production --context=eks-mumbai --replicas=6
kubectl scale deployment api-gateway -n production --context=eks-mumbai --replicas=12

# Step 2: Pre-warm Hyderabad to 50% capacity
kubectl scale deployment payment-gateway -n production --context=eks-hyderabad --replicas=3
kubectl scale deployment fraud-engine -n production --context=eks-hyderabad --replicas=2
kubectl scale deployment api-gateway -n production --context=eks-hyderabad --replicas=3

# Step 3: Increase DynamoDB capacity
aws dynamodb update-table \
  --table-name paysecure-transactions \
  --billing-mode PROVISIONED \
  --provisioned-throughput ReadCapacityUnits=30000,WriteCapacityUnits=30000 \
  --region ap-south-1

# Step 4: Pre-warm ElastiCache with expected hot keys
# (Run cache warming script with peak-season key set)

# Step 5: Notify merchants of increased capacity
# "PaySecure has scaled for [event]. Expected capacity: 3x normal."

# Step 6: Monitor throughout the peak; be ready to execute Scenario B
```

## 6. Verification Steps

| Check | Command / Method | Expected |
|-------|-----------------|----------|
| P95 latency | CloudWatch `p95` on ALB TargetResponseTime | < 2s |
| Error rate (5xx) | CloudWatch `HTTPCode_Target_5XX_Count` | < 1% |
| Pod count | `kubectl get pods -n production --context=<region>` | All Running, at desired replicas |
| Node utilisation | `kubectl top nodes --context=<region>` | < 85% CPU, < 85% memory |
| Aurora connections | CloudWatch `DatabaseConnections` | < 80% of max |
| DynamoDB throttling | CloudWatch `WriteThrottleEvents` | 0 |
| Cache hit rate | CloudWatch `CacheHitRate` | > 85% |
| MSK consumer lag | Custom lag exporter | < 10,000 messages |
| Synthetic transaction | `curl -X POST https://api.paysecure.example.com/v1/payments/test` | 201 Created, < 1s |
| DNS routing correct | `dig api.paysecure.example.com +short` | Matches intended weight distribution |

## 7. Rollback Plan (Post-Peak Scale-Down)

```bash
# Step 1: Confirm peak has passed (sustained load drop for 15+ min)

# Step 2: Scale Mumbai back to normal capacity
kubectl scale deployment payment-gateway -n production --context=eks-mumbai --replicas=6
kubectl scale deployment fraud-engine -n production --context=eks-mumbai --replicas=4
kubectl scale deployment settlement-service -n production --context=eks-mumbai --replicas=3
kubectl scale deployment api-gateway -n production --context=eks-mumbai --replicas=6

# Step 3: If traffic was shifted to Hyderabad, shift back
# See RB-005 Section 7 (Rollback Plan) and RB-012 Phase 8

# Step 4: Scale Hyderabad back to standby
kubectl scale deployment payment-gateway -n production --context=eks-hyderabad --replicas=1
kubectl scale deployment fraud-engine -n production --context=eks-hyderabad --replicas=1
kubectl scale deployment api-gateway -n production --context=eks-hyderabad --replicas=1

# Step 5: Remove surge Aurora reader
aws rds delete-db-instance \
  --db-instance-identifier paysecure-aurora-primary-reader-surge \
  --skip-final-snapshot --region ap-south-1

# Step 6: Reduce DynamoDB capacity back to baseline
aws dynamodb update-table \
  --table-name paysecure-transactions \
  --billing-mode PROVISIONED \
  --provisioned-throughput ReadCapacityUnits=10000,WriteCapacityUnits=10000 \
  --region ap-south-1

# Step 7: Reduce ElastiCache replicas
aws elasticache decrease-replica-count \
  --replication-group-id paysecure-redis-primary \
  --new-replica-count 1 --apply-immediately --region ap-south-1

# Step 8: Reset HPA maxReplicas to normal values
kubectl patch hpa payment-gateway -n production --context=eks-mumbai \
  --patch '{"spec":{"maxReplicas":6}}'
kubectl patch hpa fraud-engine -n production --context=eks-mumbai \
  --patch '{"spec":{"maxReplicas":4}}'
kubectl patch hpa api-gateway -n production --context=eks-mumbai \
  --patch '{"spec":{"maxReplicas":6}}'

echo "Scale-down complete. Infrastructure returned to baseline."
```

### Rollback Abort Criteria

- Load increases again during scale-down
- Error rate increases during scale-down
- Any service fails to stabilise at reduced capacity

## 8. Circuit Breaker Reference

| Circuit Breaker | Service | Threshold | Effect When Open |
|----------------|---------|-----------|-----------------|
| `ANALYTICS` | payment-gateway | 50% failure rate / 10s window | Analytics events buffered locally; not sent to Kafka |
| `WEBHOOK_BATCH` | payment-gateway | 50% failure rate / 10s window | Webhooks queued; delivered after circuit closes |
| `REPORT_GENERATION` | settlement-service | 50% failure rate / 10s window | Reports deferred; generated after peak |
| `FRAUD_NONCRITICAL` | fraud-engine | 30% timeout rate / 10s window | Non-critical fraud checks skipped; critical checks continue |
| `NOTIFICATION_NONCRITICAL` | notification-service | 50% failure rate / 10s window | Marketing notifications deferred; transactional notifications continue |

## 9. Compliance References

| Regulation / Standard | Requirement | How This Runbook Satisfies It |
|-----------------------|-------------|-------------------------------|
| **RBI Master Direction §7.3** | DR drills every 6 months; capacity planning for peak loads | Pre-peak scaling (Scenario D) and quarterly DR tests validate capacity; all scaling actions logged via CloudTrail |
| **RBI Data Localisation** | All payment data must remain within India | All scaling and failover stays within Indian regions; no cross-border capacity |
| **PCI-DSS v4.0 Req 9.5.1.2.1** | Resilience testing under load conditions | Peak-load failover is tested quarterly; circuit breaker thresholds validated |
| **PCI-DSS v4.0 Req 12.10.1** | Incident response plan for capacity exhaustion | This runbook IS the incident response plan for peak-load scenarios |
| **PCI-DSS v4.0 Req 12.10.5** | Monitoring must continue during capacity incidents | CloudWatch alarms, HPA metrics, and synthetic canaries continue during scaling events |
| **NPCI UPI Technical Standards** | UPI system must handle peak transaction volumes (Diwali, festivals) | Scenario D provides proactive scaling for known peaks; Scenario B provides emergency capacity via Hyderabad |
| **NPCI UPI** | Transaction latency must remain within SLA during peaks | Circuit breaker reference (Section 8) protects critical payment path; non-critical features shed first |
| **PCI-DSS v4.0 Req 6.4.1** | WAF protection during DDoS events | Scenario C covers WAF rate-based rule deployment during DDoS attacks |

## 10. Related Runbooks

| Runbook | Relationship |
|---------|-------------|
| **RB-001: Complete Region Failure** | Scenario B follows RB-001 Phase 2 (data store promotion) and Phase 4 (EKS scaling) |
| **RB-004: Cache Corruption** | Cache hit rate degradation during peak may indicate corruption; coordinate with RB-004 |
| **RB-005: DNS Failover** | Weighted DNS shift in Scenario B uses RB-005 procedures |
| **RB-009: EKS Node Failure** | Node failures during peak scaling may compound; coordinate with RB-009 |
| **RB-011: Partial Degradation** | Peak load may trigger partial degradation; use RB-011 triage framework |
| **RB-012: Full Rollback** | Post-peak scale-down and failback follow RB-012 Phase 9 (Scale Down Hyderabad) |

## 11. Test Schedule

| Test Type | Frequency | Owner |
|-----------|-----------|-------|
| HPA scale-up simulation (non-prod) | Weekly | SRE |
| Circuit breaker activation drill | Monthly | SRE |
| Pre-peak scaling rehearsal (before Diwali) | Annually (September) | DR Team |
| DDoS response drill with AWS Shield | Quarterly | Security Engineer |
| Production peak-load failover (during quarterly DR test) | Quarterly | DR Team |

---

**Document Control:** Review and update after every major peak event (Diwali, UPI festival) or quarterly DR test. Update capacity thresholds based on observed peak loads.