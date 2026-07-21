# RB-005: DNS Failover

**Version:** 1.0 | **Last Updated:** 2026-07-20 | **Owner:** Network Engineer / SRE
**Classification:** P1 — Sev 1 | **Expected RTO:** < 5 minutes | **Expected RPO:** N/A (no data loss)

---

## 1. Purpose

This runbook covers DNS-level failures affecting PaySecure's Route 53 hosted zone, including health check failures, DNS propagation delays, weighted routing misconfiguration, DDoS-induced DNS overload, and registrar compromise. DNS is the critical first hop for all merchant and end-customer traffic — a failure here blocks all payment processing regardless of backend health.

## 2. Trigger Conditions

| Trigger | Detection Mechanism | Automatic / Manual |
|---------|---------------------|--------------------|
| Route 53 health check failure on Mumbai ALB | 3 consecutive failures (90s window) | Automatic — DNS failover initiates |
| Route 53 health check failure on Hyderabad ALB | 3 consecutive failures (90s window) | Automatic — P1 alert fires |
| DNS resolution returns NXDOMAIN for `api.paysecure.example.com` | External synthetic canary (CloudWatch Synthetics) | Automatic — P1 alert |
| DNS resolution returns incorrect IP / CNAME | External synthetic canary + diff check | Automatic — P2 alert |
| Weighted routing shows 0% traffic to expected region | CloudWatch `DNSQueries` metric anomaly | Manual verification |
| Route 53 API throttling (5xx responses) | AWS Health Dashboard + CloudTrail | Manual |
| Registrar domain expiry alert | AWS Route 53 Domains notification | Automatic — 30/15/7/1 day warnings |
| DDoS attack on DNS infrastructure | AWS Shield Advanced alert + CloudWatch anomaly | Automatic — Shield Advanced auto-mitigation |
| Cross-region DNS resolution latency > 500ms | External monitoring (Catchpoint / ThousandEyes) | Automatic — P2 alert |
| DNSSEC validation failure | Route 53 DNSSEC monitoring | Automatic — P1 alert |

**Decision gate:** If DNS failover has already triggered automatically (Route 53 health checks), verify Hyderabad is healthy before confirming the failover. If DNS failover has NOT triggered but Mumbai is unreachable, manually execute Phase 3 of RB-001 and then this runbook.

## 3. Impact Assessment

| Impact Dimension | Severity | Detail |
|------------------|----------|--------|
| **Service Availability** | Critical | 100% of merchant and customer traffic blocked at DNS resolution |
| **Revenue** | Critical | All payment processing halted; ~₹X Cr/hour revenue loss |
| **Merchant Experience** | Critical | All merchants unable to resolve API endpoints; SDK/plugin failures |
| **End-Customer Experience** | Critical | All UPI/card/netbanking payments failing at initiation |
| **Settlement Risk** | High | Pending settlement batches delayed; SLA breach if > 2 hours |
| **Regulatory** | High | NPCI UPI availability breach if > 15 min; RBI reporting obligation |
| **Reputation** | Critical | Public-facing payment failure; social media and press risk |
| **Recovery Complexity** | Medium | DNS changes propagate within 60s (low TTL); backend already warm in Hyderabad |

**Worst-case acceptable downtime:** 5 minutes (RTO). Beyond 5 minutes, invoke executive communication plan.

## 4. Prerequisites

- [ ] IAM credentials with `route53:ChangeResourceRecordSets` permission on hosted zone `ZXXXXXXXXXXXX`
- [ ] AWS CLI v2+ configured with `--region us-east-1` (Route 53 is a global service)
- [ ] Access to external DNS monitoring tools (Catchpoint, ThousandEyes, or CloudWatch Synthetics)
- [ ] Hyderabad ALB endpoint DNS name documented and accessible
- [ ] Mumbai ALB endpoint DNS name documented and accessible
- [ ] Route 53 hosted zone ID documented
- [ ] Health check IDs for both Mumbai and Hyderabad ALBs documented
- [ ] TTL values confirmed: 60s for weighted records, 30s for health check evaluation
- [ ] Registrar credentials accessible (if domain expiry is the trigger)
- [ ] DNSSEC KSK/ZSK key material accessible (if DNSSEC failure is the trigger)

## 5. Recovery Procedure

### Scenario A: Route 53 Health Check Failure — Automatic Failover (Owner: SRE | ETA: 2 min)

> This is the most common scenario. Route 53 has already shifted traffic to Hyderabad. Verify and confirm.

```bash
# Step 1: Verify the failover has occurred
# Check which ALB is currently receiving traffic
dig api.paysecure.example.com +short

# Expected: Hyderabad ALB IPs (not Mumbai)

# Step 2: Verify Hyderabad is healthy
curl -s https://api.paysecure.example.com/health | jq '.status'
# Expected: "healthy"

# Step 3: Verify Mumbai is truly down (not a false positive)
curl -s -o /dev/null -w "%{http_code}" https://paysecure-mumbai.example.com/health --connect-timeout 5
# If this returns 200, the health check may have been a false positive — investigate

# Step 4: Confirm DNS propagation
# Check from multiple geographic locations
for resolver in "8.8.8.8" "1.1.1.1" "208.67.222.222"; do
  echo -n "Resolver $resolver: "
  dig @$resolver api.paysecure.example.com +short
done

# Step 5: Verify weighted routing records
aws route53 list-resource-record-sets \
  --hosted-zone-id ZXXXXXXXXXXXX \
  --query "ResourceRecordSets[?Name=='api.paysecure.example.com.']" \
  --output table

# Step 6: If failover is confirmed and Hyderabad is healthy, declare DNS failover complete
echo "DNS failover confirmed: traffic routing to Hyderabad"
```

### Scenario B: DNS Resolution Failure — NXDOMAIN or SERVFAIL (Owner: Network Engineer | ETA: 5 min)

```bash
# Step 1: Verify the hosted zone exists
aws route53 get-hosted-zone --id ZXXXXXXXXXXXX
# If NOT FOUND: hosted zone may have been deleted — escalate to AWS Support immediately

# Step 2: Check if the domain has expired
aws route53domains get-domain-detail --domain-name paysecure.example.com
# Check "ExpirationDate" — if expired, renew immediately

# Step 3: Verify NS records are correct at the registrar
dig paysecure.example.com NS +short
# Expected: 4 Route 53 name servers (ns-xxx.awsdns-xx.xxx)
# If different: registrar NS records may have been changed — investigate

# Step 4: Verify the A/AAAA records exist
aws route53 list-resource-record-sets \
  --hosted-zone-id ZXXXXXXXXXXXX \
  --query "ResourceRecordSets[?Name=='api.paysecure.example.com.' && Type=='A']"

# Step 5: If records are missing, recreate them from backup
# (Records should be stored in infrastructure-as-code — Terraform/CloudFormation)
# Emergency recreation:
aws route53 change-resource-record-sets \
  --hosted-zone-id ZXXXXXXXXXXXX \
  --change-batch '{
    "Changes": [{
      "Action": "CREATE",
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

# Step 6: Verify resolution is restored
dig api.paysecure.example.com +short
```

### Scenario C: Weighted Routing Misconfiguration (Owner: Network Engineer | ETA: 3 min)

```bash
# Step 1: Check current weighted routing configuration
aws route53 list-resource-record-sets \
  --hosted-zone-id ZXXXXXXXXXXXX \
  --query "ResourceRecordSets[?Name=='api.paysecure.example.com.']" \
  --output table

# Step 2: Verify weights match expected state
# Normal: Mumbai=100, Hyderabad=0
# Failover: Mumbai=0, Hyderabad=100
# Rollback: Mumbai=100, Hyderabad=0 (after phased shift)

# Step 3: If weights are incorrect, correct them
# Example: Force 100% to Hyderabad
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

# Step 4: Wait for propagation (TTL = 60s)
echo "Waiting 60s for DNS propagation..."
sleep 60

# Step 5: Verify from multiple resolvers
dig api.paysecure.example.com +short
```

### Scenario D: DDoS-Induced DNS Overload (Owner: Network Engineer / Security | ETA: 5 min)

```bash
# Step 1: Verify AWS Shield Advanced is engaged
aws shield describe-attack --attack-id <attack-id>
# Shield Advanced should auto-mitigate DNS DDoS

# Step 2: Check Route 53 API throttling
aws cloudtrail lookup-events \
  --lookup-attributes AttributeKey=EventSource,AttributeValue=route53.amazonaws.com \
  --query "Events[?ErrorCode!=null]" \
  --output table

# Step 3: If Shield Advanced is not sufficient, engage AWS DRT (DDoS Response Team)
# Via AWS Support — SEV1 ticket with "DDoS Attack on Route 53"

# Step 4: Implement emergency DNS hardening
# - Enable DNSSEC if not already enabled
# - Reduce TTL to 30s for faster failover
# - Add additional health checks from diverse geographic locations

# Step 5: If DNS remains degraded, distribute ALB IPs directly to critical merchants
# (Emergency workaround — bypass DNS entirely)
aws elbv2 describe-load-balancers \
  --names paysecure-alb-hyderabad \
  --region ap-south-2 \
  --query 'LoadBalancers[0].DNSName'

# Communicate IPs to critical merchants via out-of-band channel (phone/SMS)
```

### Scenario E: DNSSEC Validation Failure (Owner: Network Engineer | ETA: 5 min)

```bash
# Step 1: Verify DNSSEC status
aws route53 get-dnssec --hosted-zone-id ZXXXXXXXXXXXX

# Step 2: Check DNSSEC chain of trust
dig api.paysecure.example.com +dnssec +short
# Look for RRSIG records — if missing, DNSSEC signing may have failed

# Step 3: If DNSSEC is broken, temporarily disable it to restore resolution
# WARNING: This reduces security. Re-enable as soon as possible.
aws route53 disable-hosted-zone-dnssec \
  --hosted-zone-id ZXXXXXXXXXXXX

# Step 4: Verify resolution is restored
dig api.paysecure.example.com +short

# Step 5: Investigate root cause of DNSSEC failure
# - KSK/ZSK expiry?
# - Parent DS record mismatch?
# - Key signing ceremony required?

# Step 6: Re-enable DNSSEC after root cause is resolved
aws route53 enable-hosted-zone-dnssec \
  --hosted-zone-id ZXXXXXXXXXXXX \
  --signing-key key-signing-key-xxx
```

## 6. Verification Steps

| Check | Command / Method | Expected |
|-------|-----------------|----------|
| DNS resolution succeeds | `dig api.paysecure.example.com +short` | Returns valid IPs |
| Correct region receiving traffic | `dig api.paysecure.example.com +short` + ALB IP lookup | Matches intended region |
| Health check passing | `aws route53 get-health-check-status --health-check-id <id>` | Status: Healthy |
| Weighted routing correct | `aws route53 list-resource-record-sets` | Weights match intended state |
| DNSSEC valid (if enabled) | `dig api.paysecure.example.com +dnssec` | AD flag present; RRSIG valid |
| TTL values correct | `dig api.paysecure.example.com +short` (check TTL in response) | 60s or less |
| Cross-region resolution consistent | Resolve from 3+ geographic locations | Same result |
| Application health via DNS | `curl -s https://api.paysecure.example.com/health` | 200 OK |
| Synthetic transaction via DNS | `curl -s -X POST https://api.paysecure.example.com/v1/payments/test` | 201 Created |

## 7. Rollback Plan

### 7.1 Rollback After DNS Failover (Failback to Mumbai)

> **Reference:** RB-012 Phase 8 (DNS Cutover — Weighted Shift to Mumbai)

```bash
# Gradual weighted shift back to Mumbai:
# Step 1: 10% Mumbai, 90% Hyderabad — observe 2 min
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

echo "DNS: 10% Mumbai. Observing for 2 minutes..."
sleep 120

# Step 2: 50% Mumbai, 50% Hyderabad — observe 2 min
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

echo "DNS: 50% Mumbai. Observing for 2 minutes..."
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

echo "DNS: 100% Mumbai. Rollback complete."
```

### 7.2 Rollback Abort Criteria

- Mumbai error rate increases at 10% or 50% stage
- Mumbai health checks fail during weighted shift
- Merchant reports of issues during shift
- DNS propagation shows inconsistent results across resolvers

**If abort is needed:** Immediately shift DNS back to 100% Hyderabad.

## 8. DNS Configuration Reference

### 8.1 Normal State (Mumbai Active)

| Record | Type | Set Identifier | Weight | Target | TTL |
|--------|------|---------------|--------|--------|-----|
| `api.paysecure.example.com` | A | `mumbai` | 100 | Mumbai ALB | 60s |
| `api.paysecure.example.com` | A | `hyderabad` | 0 | Hyderabad ALB | 60s |

### 8.2 Failover State (Hyderabad Active)

| Record | Type | Set Identifier | Weight | Target | TTL |
|--------|------|---------------|--------|--------|-----|
| `api.paysecure.example.com` | A | `mumbai` | 0 | Mumbai ALB | 60s |
| `api.paysecure.example.com` | A | `hyderabad` | 100 | Hyderabad ALB | 60s |

### 8.3 Health Check Configuration

| Health Check | Target | Port | Path | Interval | Failure Threshold |
|-------------|--------|------|------|----------|-------------------|
| `paysecure-mumbai-alb` | Mumbai ALB DNS | 443 | `/health` | 30s | 3 |
| `paysecure-hyderabad-alb` | Hyderabad ALB DNS | 443 | `/health` | 30s | 3 |

## 9. Compliance References

| Regulation / Standard | Requirement | How This Runbook Satisfies It |
|-----------------------|-------------|-------------------------------|
| **RBI Master Direction §7.3** | DR drills every 6 months; all failover steps logged for audit | DNS failover is tested quarterly; every Route 53 API call is logged via CloudTrail |
| **RBI Data Localisation** | All payment data must remain within India | DNS records point only to Indian-region ALBs (`ap-south-1`, `ap-south-2`); no cross-border routing |
| **PCI-DSS v4.0 Req 6.4.1** | Public-facing web applications must be protected by a WAF | DNS routes traffic through ALBs with WAF WebACLs attached; failover preserves WAF protection |
| **PCI-DSS v4.0 Req 9.5.1.2.1** | Resilience testing of critical security controls | DNS failover testing validates WAF, TLS termination, and health check integrity in both regions |
| **PCI-DSS v4.0 Req 12.10.1** | Incident response plan must be activated for service disruptions | This runbook IS the incident response plan for DNS failures; Scenario A covers automatic failover response |
| **PCI-DSS v4.0 Req 12.10.5** | Monitoring must continue during incident | External synthetic canaries and multi-resolver DNS checks continue regardless of region state |
| **NPCI UPI Technical Standards** | UPI system availability; notify NPCI within 15 min | DNS failover completes within RTO < 5 min; communication template covers NPCI notification |
| **DNSSEC Best Practices** | DNSSEC must be maintained for domain integrity | Scenario E covers DNSSEC failure recovery; KSK/ZSK rotation procedures included |

## 10. Related Runbooks

| Runbook | Relationship |
|---------|-------------|
| **RB-001: Complete Region Failure** | Phase 3 (DNS Failover) — this runbook provides the detailed DNS procedure referenced by RB-001 |
| **RB-006: Peak-Load Failover** | DNS weighted routing may be used to shed traffic during peak load |
| **RB-010: Network Partition** | Network partitions may cause DNS resolution failures; coordinate with RB-010 |
| **RB-011: Partial Degradation** | DNS may be used to route traffic away from degraded components |
| **RB-012: Full Rollback** | Phase 8 (DNS Cutover) — this runbook provides the weighted shift procedure used during failback |

## 11. Test Schedule

| Test Type | Frequency | Owner |
|-----------|-----------|-------|
| DNS resolution from 5+ geographic locations | Daily (automated) | SRE |
| Health check failover simulation (non-prod) | Weekly | Network Engineer |
| Weighted routing shift drill | Monthly | Network Engineer |
| DNSSEC validation check | Monthly | Security Engineer |
| Production DNS failover (during quarterly DR test) | Quarterly | DR Team |
| Registrar domain renewal audit | Quarterly | Network Engineer |

---

**Document Control:** Review and update after every production DNS failover event or quarterly DR test. Update ALB DNS names if ALBs are recreated.