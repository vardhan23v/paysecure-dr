# RB-010: Network Partition & Recovery

**Version:** 1.0 | **Last Updated:** 2026-07-20 | **Owner:** Network Engineering Lead
**Classification:** P1 — Sev 0 | **Expected Recovery Time:** < 10 minutes | **Data Loss Risk:** Low (bounded by replication lag)

---

## 1. Purpose

This runbook covers recovery from network partition scenarios affecting the PaySecure multi-region platform. Scenarios include cross-region VPC peering failure, intra-region AZ network isolation, DNS resolution failure, and external connectivity loss. Network partitions are particularly dangerous because they can trigger split-brain conditions (see RB-002) if not handled with strict write-side fencing.

## 2. Trigger Conditions

| Trigger | Detection Mechanism | Automatic / Manual |
|---------|---------------------|--------------------|
| Cross-region VPC peering connection `Status: failed` | AWS VPC API / CloudWatch | Automatic — P1 alert |
| Cross-region ping from Hyderabad → Mumbai: 100% packet loss for 30s | Hyderabad monitoring probes | Automatic — P1 alert (composite with RB-001) |
| Aurora replication lag > 30s | CloudWatch `AuroraGlobalDBReplicationLag` | Automatic — P1 alert |
| DynamoDB `ReplicationLatency` > 30s | CloudWatch | Automatic — P1 alert |
| ElastiCache `GlobalDatastoreReplicationLag` > 30s | CloudWatch | Automatic — P1 alert |
| MSK MM2 connector state != RUNNING | MSK Connect API | Automatic — P1 alert |
| Route 53 health checks failing from specific regions | Route 53 console | Automatic — P2 alert |
| Inter-AZ latency > 10ms (baseline < 2ms) | VPC Flow Logs / custom probes | Automatic — P2 alert |
| `tcp_retransmit` spike on cross-region links | VPC Flow Logs / ENI metrics | Automatic — P2 alert |
| VPC peering data transfer drops to 0 | CloudWatch `DataTransferOut` on peering connection | Automatic — P1 alert |
| External API calls (NPCI, bank gateways) timeout > 5% | Application logs / APM | Automatic — P2 alert |
| DNS resolution failures (NXDOMAIN or timeout) | CoreDNS metrics / custom probes | Automatic — P1 alert |
| Merchant reports of connectivity issues | Support tickets | Manual — corroborates automated signals |

**Decision gate:** If cross-region connectivity is lost AND Mumbai is still healthy, this is a network partition — NOT a region failure. Do NOT fail over to Hyderabad. Instead, fence writes and wait for network recovery. If Mumbai is also unreachable from external vantage points, escalate to RB-001 (Complete Region Failure).

## 3. Impact Assessment

| Impact Dimension | Severity | Detail |
|------------------|----------|--------|
| **DR Readiness** | Critical | Hyderabad data stores become stale; RPO clock starts ticking; failover capability degraded |
| **Data Integrity** | High | Risk of split-brain if writes continue in Mumbai while Hyderabad is unreachable and someone mistakenly promotes Hyderabad |
| **Revenue** | Low–Medium | Mumbai continues processing; revenue impact only if partition triggers incorrect failover |
| **Replication Lag** | High | All four data stores accumulate lag; catch-up time proportional to partition duration |
| **Settlement Risk** | Medium | Settlement events not replicated to Hyderabad; if Mumbai fails during partition, settlement data may be lost |
| **Audit Completeness** | Medium | Audit events not replicated; compliance gap if partition persists > 15 min |
| **Recovery Complexity** | Medium | Network partitions typically self-resolve; complexity arises only if partition triggers split-brain |
| **External Dependency Risk** | High | If partition affects external connectivity (NPCI, banks), payment processing may be partially impaired |

**Worst-case scenario:** Cross-region partition persists > 5 min AND Mumbai then fails. Hyderabad data stores are stale by > 5 min, exceeding RPO. Mitigation: aggressive replication lag monitoring and automated write fencing.

## 4. Prerequisites

- [ ] AWS CLI with VPC, EC2, and Route 53 permissions
- [ ] Access to VPC Flow Logs in both regions (CloudWatch Logs or S3)
- [ ] Network diagnostic tools: `mtr`, `traceroute`, `tcptraceroute`, `hping3`
- [ ] VPC peering connection IDs for all cross-region links
- [ ] Security group and NACL configurations for both regions
- [ ] Route 53 hosted zone administrative access
- [ ] External monitoring vantage points (CloudWatch Synthetics, third-party probes)

## 5. Network Topology Reference

### 5.1 Cross-Region Connectivity

| Connection | Source | Destination | Purpose | Bandwidth |
|------------|--------|-------------|---------|-----------|
| VPC Peering `pcx-mum-hyd-01` | Mumbai VPC (`10.0.0.0/16`) | Hyderabad VPC (`10.1.0.0/16`) | Aurora, ElastiCache, MSK replication | Up to 10 Gbps |
| VPC Peering `pcx-mum-hyd-02` | Mumbai VPC (`10.0.0.0/16`) | Hyderabad VPC (`10.1.0.0/16`) | DynamoDB Streams, CloudWatch Logs replication | Up to 10 Gbps |
| AWS Backbone | Mumbai region | Hyderabad region | DynamoDB Global Tables, KMS multi-region, Secrets Manager replication | AWS-managed |

### 5.2 Intra-Region Connectivity (per region)

| Layer | Subnet CIDR | AZ Distribution | Connectivity |
|-------|------------|----------------|--------------|
| Edge (Public) | `10.x.0.0/24` per AZ | 3 AZs | Internet Gateway, NAT Gateway |
| Compute (Private) | `10.x.1.0/24` per AZ | 3 AZs | NAT Gateway for egress; VPC endpoints for AWS services |
| Data (Isolated) | `10.x.2.0/24` per AZ | 3 AZs | No internet access; VPC endpoints only |

### 5.3 External Connectivity

| Endpoint | Protocol | Source | Criticality |
|----------|----------|--------|-------------|
| NPCI UPI Switch | HTTPS (TLS 1.3) | Mumbai EKS | Critical — UPI payments |
| Bank Payment Gateways | HTTPS (TLS 1.3) | Mumbai EKS | Critical — card/netbanking |
| Merchant Webhooks | HTTPS (TLS 1.3) | Mumbai EKS → Internet | High — async notifications |
| AWS Service APIs (KMS, Secrets Manager, etc.) | HTTPS via VPC Endpoints | Both regions | Critical — encryption, secrets |
| PagerDuty / Opsgenie | HTTPS | Both regions | Critical — alerting |
| CloudWatch / Datadog | HTTPS | Both regions | High — monitoring |

## 6. Detection

### 6.1 Automated Alerts

| Alert | Metric / Source | P1 Threshold | P2 Threshold |
|-------|----------------|-------------|-------------|
| VPC peering down | `aws vpc describe-vpc-peering-connections` | Status != active | — |
| Cross-region packet loss | Hyderabad → Mumbai ICMP probes | 100% for 30s | > 10% for 60s |
| Cross-region latency spike | Hyderabad → Mumbai TCP probes | > 100ms | > 50ms |
| Replication lag (all stores) | CloudWatch per-store metrics | > 30s | > 10s |
| MM2 connector down | MSK Connect API | State != RUNNING | — |
| DNS resolution failures | CoreDNS `error_count` | > 10/min | > 5/min |
| External API timeout rate | APM / application logs | > 5% | > 2% |

### 6.2 Verification Commands

```bash
# 1. Check VPC peering status
aws ec2 describe-vpc-peering-connections \
  --filters "Name=status-code,Values=active,failed,deleted" \
  --region ap-south-1 \
  --query 'VpcPeeringConnections[*].[VpcPeeringConnectionId,Status.Code]'

# 2. Test cross-region connectivity from Hyderabad
# From a Hyderabad bastion or monitoring pod:
ping -c 10 -i 1 <mumbai-endpoint-ip>
mtr --report <mumbai-endpoint-ip>
tcptraceroute <mumbai-endpoint-ip> 5432  # Aurora port

# 3. Check replication lag on all data stores
aws cloudwatch get-metric-statistics --region ap-south-2 \
  --namespace AWS/RDS --metric-name AuroraGlobalDBReplicationLag \
  --dimensions Name=DBClusterIdentifier,Value=paysecure-aurora-secondary \
  --start-time $(date -u -d '5 minutes ago' +%Y-%m-%dT%H:%M:%SZ) \
  --end-time $(date -u +%Y-%m-%dT%H:%M:%SZ) \
  --period 60 --statistics Average

# 4. Check DNS resolution
dig api.paysecure.example.com +short
nslookup paysecure-aurora-primary.cluster-xxx.ap-south-1.rds.amazonaws.com

# 5. Check VPC Flow Logs for cross-region traffic
aws logs filter-log-events \
  --log-group-name /aws/vpc/flow-logs/mumbai \
  --filter-pattern "10.1.0.0/16" \
  --start-time $(date -u -d '10 minutes ago' +%s%3N) \
  --region ap-south-1

# 6. Check external connectivity from Mumbai EKS
kubectl run network-test --rm -it --image=nicolaka/netshoot --restart=Never -- \
  curl -s -o /dev/null -w "%{http_code}" https://npci-upi.example.com/health
```

## 7. Scenario A: Cross-Region VPC Peering Failure

### 7.1 Immediate Containment — Fence Writes (Owner: Incident Commander | ETA: 30s)

```bash
# CRITICAL: Prevent split-brain by ensuring Hyderabad cannot be promoted
# while cross-region link is down.

# Step 1: Verify Mumbai is still the active region
kubectl config use-context eks-mumbai
kubectl get deployments -n production

# Step 2: Lock Hyderabad promotion capability
# Apply IAM policy denying promote-read-replica in Hyderabad
aws iam put-group-policy \
  --group-name DBA-Team \
  --policy-name deny-hyderabad-promotion \
  --policy-document '{
    "Version": "2012-10-17",
    "Statement": [{
      "Effect": "Deny",
      "Action": [
        "rds:PromoteReadReplica",
        "rds:PromoteReadReplicaDBCluster",
        "elasticache:FailoverGlobalReplicationGroup"
      ],
      "Resource": "*",
      "Condition": {
        "StringEquals": {"aws:RequestedRegion": "ap-south-2"}
      }
    }]
  }'

# Step 3: Notify all engineers: "Cross-region partition in progress. 
# DO NOT promote Hyderabad. DO NOT initiate failover. 
# Mumbai remains authoritative."
```

### 7.2 Diagnose Peering Failure (Owner: Network Engineer | ETA: 3 min)

```bash
# Check peering connection details
aws ec2 describe-vpc-peering-connections \
  --vpc-peering-connection-ids pcx-mum-hyd-01 \
  --region ap-south-1

# Check route tables in both VPCs
aws ec2 describe-route-tables \
  --filters "Name=route.vpc-peering-connection-id,Values=pcx-mum-hyd-01" \
  --region ap-south-1

aws ec2 describe-route-tables \
  --filters "Name=route.vpc-peering-connection-id,Values=pcx-mum-hyd-01" \
  --region ap-south-2

# Check security group rules for cross-region traffic
aws ec2 describe-security-groups \
  --filters "Name=ip-permission.cidr,Values=10.1.0.0/16" \
  --region ap-south-1

# Check NACLs
aws ec2 describe-network-acls \
  --region ap-south-1 \
  --query 'NetworkAcls[*].[NetworkAclId,Entries[?CidrBlock==`10.1.0.0/16`]]'
```

### 7.3 Recovery Actions (Owner: Network Engineer | ETA: 5–10 min)

```bash
# Option A: If peering is deleted or failed — recreate
aws ec2 create-vpc-peering-connection \
  --vpc-id vpc-mumbai-xxx \
  --peer-vpc-id vpc-hyderabad-yyy \
  --peer-region ap-south-2 \
  --region ap-south-1

# Accept the peering request
aws ec2 accept-vpc-peering-connection \
  --vpc-peering-connection-id pcx-NEW \
  --region ap-south-2

# Add routes in both VPCs
aws ec2 create-route \
  --route-table-id rtb-mumbai-private \
  --destination-cidr-block 10.1.0.0/16 \
  --vpc-peering-connection-id pcx-NEW \
  --region ap-south-1

aws ec2 create-route \
  --route-table-id rtb-hyderabad-private \
  --destination-cidr-block 10.0.0.0/16 \
  --vpc-peering-connection-id pcx-NEW \
  --region ap-south-2

# Option B: If peering is active but traffic is blocked — check DNS
# DNS resolution may be enabled/disabled on the peering
aws ec2 modify-vpc-peering-connection-options \
  --vpc-peering-connection-id pcx-mum-hyd-01 \
  --requester-peering-connection-options '{"AllowDnsResolutionFromRemoteVpc":true}' \
  --region ap-south-1

aws ec2 modify-vpc-peering-connection-options \
  --vpc-peering-connection-id pcx-mum-hyd-01 \
  --accepter-peering-connection-options '{"AllowDnsResolutionFromRemoteVpc":true}' \
  --region ap-south-2

# Option C: If peering is active but MTU mismatch — check Path MTU Discovery
# Ensure jumbo frames (9001 MTU) are enabled consistently
# Check for ICMP fragmentation-needed packets being dropped
```

### 7.4 Verify Recovery (Owner: Network Engineer | ETA: 3 min)

```bash
# 1. Peering status active
aws ec2 describe-vpc-peering-connections \
  --vpc-peering-connection-ids pcx-mum-hyd-01 \
  --region ap-south-1 \
  --query 'VpcPeeringConnections[0].Status.Code'

# 2. Cross-region ping restored
ping -c 10 <mumbai-endpoint-ip>  # From Hyderabad

# 3. Replication lag recovering
aws cloudwatch get-metric-statistics --region ap-south-2 \
  --namespace AWS/RDS --metric-name AuroraGlobalDBReplicationLag \
  --dimensions Name=DBClusterIdentifier,Value=paysecure-aurora-secondary \
  --start-time $(date -u -d '5 minutes ago' +%Y-%m-%dT%H:%M:%SZ) \
  --end-time $(date -u +%Y-%m-%dT%H:%M:%SZ) \
  --period 60 --statistics Average

# 4. MM2 connector running
curl -s https://kafka-connect-hyderabad.example.com/connectors/mm2-source/status | jq '.connector.state'

# 5. Remove promotion lock
aws iam delete-group-policy --group-name DBA-Team --policy-name deny-hyderabad-promotion
```

## 8. Scenario B: Intra-Region AZ Network Isolation

### 8.1 Detection (Owner: Network Engineer | ETA: 2 min)

```bash
# Check if nodes in one AZ are unreachable from others
kubectl get nodes -o jsonpath='{range .items[*]}{.metadata.name}{"\t"}{.metadata.labels.topology\.kubernetes\.io/zone}{"\t"}{.status.conditions[?(@.type=="Ready")].status}{"\n"}{end}'

# Check inter-AZ latency from monitoring probes
# Check VPC Flow Logs for dropped packets between AZs

# Check if the AZ has an AWS issue
aws health describe-events \
  --filter '{"services":["EC2","VPC"],"regions":["ap-south-1"]}' \
  --region us-east-1
```

### 8.2 Recovery (Owner: Network Engineer / Platform Engineer | ETA: 5–10 min)

```bash
# Step 1: Cordon all nodes in the isolated AZ
AFFECTED_AZ="ap-south-1a"
for node in $(kubectl get nodes -l topology.kubernetes.io/zone=${AFFECTED_AZ} -o name); do
  kubectl cordon ${node}
done

# Step 2: Drain pods from isolated AZ
for node in $(kubectl get nodes -l topology.kubernetes.io/zone=${AFFECTED_AZ} -o name); do
  kubectl drain ${node} --ignore-daemonsets --delete-emptydir-data --timeout=300s --force &
done
wait

# Step 3: Verify pods rescheduled to healthy AZs
kubectl get pods -n production -o wide | grep ${AFFECTED_AZ}  # Should be empty

# Step 4: If AZ isolation persists, temporarily remove it from load balancing
# Update ALB target group to deregister targets in affected AZ
# (ALB does this automatically when health checks fail)

# Step 5: If AZ issue is prolonged, update ASGs to exclude affected AZ
aws autoscaling update-auto-scaling-group \
  --auto-scaling-group-name paysecure-mumbai-application \
  --availability-zones ap-south-1b ap-south-1c \
  --region ap-south-1

# Step 6: After AZ recovers, re-add to ASG and uncordon nodes
aws autoscaling update-auto-scaling-group \
  --auto-scaling-group-name paysecure-mumbai-application \
  --availability-zones ap-south-1a ap-south-1b ap-south-1c \
  --region ap-south-1
```

## 9. Scenario C: DNS Resolution Failure

### 9.1 Detection (Owner: Network Engineer | ETA: 2 min)

```bash
# Check CoreDNS health in EKS
kubectl get pods -n kube-system -l k8s-app=kube-dns

# Check CoreDNS metrics
kubectl get --raw /metrics | grep coredns_dns_requests_total

# Check Route 53 health
aws route53 get-health-check-status --health-check-id <health-check-id>

# Test DNS resolution from within cluster
kubectl run dns-test --rm -it --image=busybox --restart=Never -- \
  nslookup api.paysecure.example.com

# Check Route 53 hosted zone
aws route53 list-resource-record-sets \
  --hosted-zone-id ZXXXXXXXXXXXX \
  --query 'ResourceRecordSets[?Name==`api.paysecure.example.com.`]'
```

### 9.2 Recovery (Owner: Network Engineer / SRE | ETA: 5 min)

```bash
# Option A: CoreDNS failure in EKS
# Restart CoreDNS pods
kubectl rollout restart deployment coredns -n kube-system

# If CoreDNS is completely broken, scale up
kubectl scale deployment coredns -n kube-system --replicas=4

# Option B: Route 53 hosted zone issue
# Verify NS records are correct
aws route53 get-hosted-zone --id ZXXXXXXXXXXXX \
  --query 'DelegationSet.NameServers'

# If hosted zone is misconfigured, restore from IaC
cd infra/terraform/dns
terraform apply

# Option C: External DNS resolution failing
# Check if Route 53 resolvers are reachable
# If AWS DNS is degraded, use alternative resolvers temporarily
# (Note: this is an AWS-managed service; most issues self-resolve)

# Option D: Application-level DNS caching issue
# Restart applications to clear DNS cache
kubectl rollout restart deployment/payment-gateway -n production
kubectl rollout restart deployment/api-gateway -n production
```

## 10. Scenario D: External Connectivity Loss

### 10.1 Detection (Owner: Network Engineer | ETA: 2 min)

```bash
# Check NAT Gateway status
aws ec2 describe-nat-gateways \
  --region ap-south-1 \
  --query 'NatGateways[*].[NatGatewayId,State]'

# Check Internet Gateway
aws ec2 describe-internet-gateways \
  --region ap-south-1

# Check external endpoint reachability from EKS
kubectl run ext-test --rm -it --image=nicolaka/netshoot --restart=Never -- \
  curl -s -o /dev/null -w "%{http_code}" https://npci-upi.example.com/health

# Check VPC endpoints
aws ec2 describe-vpc-endpoints \
  --region ap-south-1 \
  --query 'VpcEndpoints[*].[VpcEndpointId,ServiceName,State]'
```

### 10.2 Recovery (Owner: Network Engineer | ETA: 5–10 min)

```bash
# Option A: NAT Gateway failure
# NAT Gateway is AZ-specific; if one AZ's NAT GW fails, traffic routes through others
# Check route tables for the affected AZ
aws ec2 describe-route-tables \
  --filters "Name=association.subnet-id,Values=subnet-xxx" \
  --region ap-south-1

# If all NAT Gateways are down, create a new one
aws ec2 create-nat-gateway \
  --subnet-id subnet-public-az1 \
  --allocation-id eipalloc-xxx \
  --region ap-south-1

# Update route tables to use new NAT Gateway
aws ec2 create-route \
  --route-table-id rtb-private-az1 \
  --destination-cidr-block 0.0.0.0/0 \
  --nat-gateway-id nat-NEW \
  --region ap-south-1

# Option B: VPC Endpoint failure
# If a VPC endpoint is down, traffic to that AWS service will fail
# Check if the endpoint can be recreated
aws ec2 delete-vpc-endpoints --vpc-endpoint-ids vpce-xxx --region ap-south-1
aws ec2 create-vpc-endpoint \
  --vpc-id vpc-mumbai-xxx \
  --service-name com.amazonaws.ap-south-1.kms \
  --vpc-endpoint-type Interface \
  --subnet-ids subnet-private-az1 subnet-private-az2 subnet-private-az3 \
  --security-group-ids sg-vpce-xxx \
  --region ap-south-1

# Option C: External service (NPCI, bank) unreachable
# This is outside our control; implement circuit breaker
# Enable fallback routing if available
# Notify NPCI/bank support
```

## 11. Split-Brain Prevention During Network Partition

### 11.1 Write Fencing Protocol (Owner: Incident Commander | ETA: 30s)

```
NETWORK PARTITION DETECTED
├── Mumbai is reachable from external vantage points?
│   ├── YES → Mumbai is authoritative. Fence Hyderabad writes.
│   │   ├── Apply IAM deny policy on Hyderabad promotions (Section 7.1)
│   │   ├── Notify all engineers: DO NOT promote Hyderabad
│   │   └── Monitor replication lag; wait for network recovery
│   └── NO → Mumbai is unreachable. Escalate to RB-001.
│       ├── Verify Hyderabad is healthy
│       ├── If Hyderabad healthy → initiate failover per RB-001
│       └── If Hyderabad also unhealthy → escalate to RB-011
```

### 11.2 Automated Fencing (Owner: SRE | Pre-configured)

```bash
# Lambda function triggered by composite alarm:
# "CrossRegionPartitionDetected" = 
#   (VPC Peering DOWN) AND (Mumbai ALB Health Check OK)

# The Lambda automatically:
# 1. Applies IAM deny policy on Hyderabad promotion actions
# 2. Sends PagerDuty alert: "Network partition — Hyderabad promotion locked"
# 3. Posts to Slack: "@here Cross-region partition detected. 
#    Mumbai is authoritative. Do NOT fail over."
```

## 12. Verification Steps

```bash
# 1. VPC peering active
aws ec2 describe-vpc-peering-connections \
  --region ap-south-1 \
  --query 'VpcPeeringConnections[*].Status.Code'

# 2. Cross-region connectivity restored
ping -c 10 <mumbai-endpoint-ip>  # From Hyderabad: 0% packet loss

# 3. All replication lag recovering to normal
aws cloudwatch get-metric-statistics --region ap-south-2 \
  --namespace AWS/RDS --metric-name AuroraGlobalDBReplicationLag \
  --dimensions Name=DBClusterIdentifier,Value=paysecure-aurora-secondary \
  --start-time $(date -u -d '10 minutes ago' +%Y-%m-%dT%H:%M:%SZ) \
  --end-time $(date -u +%Y-%m-%dT%H:%M:%SZ) \
  --period 60 --statistics Average
# Expected: < 1s

# 4. MM2 connector running
curl -s https://kafka-connect-hyderabad.example.com/connectors/mm2-source/status | jq '.connector.state'

# 5. DNS resolution working
dig api.paysecure.example.com +short

# 6. External connectivity restored
curl -s -o /dev/null -w "%{http_code}" https://npci-upi.example.com/health

# 7. Application health
curl -s https://api.paysecure.example.com/health | jq .

# 8. Promotion lock removed
aws iam get-group-policy --group-name DBA-Team --policy-name deny-hyderabad-promotion
# Expected: NoSuchEntity error (policy was removed)
```

## 13. Rollback Plan

### 13.1 Network Recovery Post-Partition

After cross-region connectivity is restored:

| Step | Action | Owner | ETA |
|------|--------|-------|-----|
| 1 | Verify all four data store replication streams have resumed | DB Engineer / Data Platform | 3 min |
| 2 | Monitor replication lag until all stores are caught up (lag < 1s) | DB Engineer | 5–15 min |
| 3 | Verify no split-brain occurred during partition (see RB-002 Section 5) | DB Engineer | 3 min |
| 4 | Remove IAM promotion lock | Security | 1 min |
| 5 | Verify MM2 has replayed all accumulated events | Data Platform Lead | 3 min |
| 6 | Run synthetic transactions to validate end-to-end flow | SRE | 2 min |
| 7 | Declare network partition resolved; close incident | Incident Commander | — |

### 13.2 If Split-Brain Occurred During Partition

| Step | Action | Owner | ETA |
|------|--------|-------|-----|
| 1 | Immediately escalate to RB-002 (Database Split-Brain Recovery) | Incident Commander | — |
| 2 | Follow RB-002 Section 6 (Immediate Containment) | DB Engineer | 30s |
| 3 | Follow RB-002 Section 7 (Aurora Resolution) or Section 8 (DynamoDB Resolution) | DB Engineer | 15–30 min |
| 4 | Do NOT remove promotion lock until split-brain is fully resolved | Security | — |

### 13.3 If External Connectivity Was Lost

| Step | Action | Owner | ETA |
|------|--------|-------|-----|
| 1 | Verify NAT Gateways and Internet Gateways are healthy | Network Engineer | 2 min |
| 2 | Verify VPC endpoints are healthy | Network Engineer | 2 min |
| 3 | Test connectivity to all critical external endpoints (NPCI, banks, PagerDuty) | Network Engineer | 3 min |
| 4 | Replay any queued outbound events (webhooks, notifications) | SRE | 5 min |
| 5 | Verify merchant-facing services are reachable from internet | SRE | 2 min |

### 13.4 Prevention Measures

| Measure | Implementation | Owner |
|---------|---------------|-------|
| Redundant VPC peering | Two peering connections between regions for fault tolerance | Network |
| Automated write fencing | Lambda triggered by partition detection | SRE |
| Cross-region network monitoring | Continuous ICMP/TCP probes with P1 alerting | SRE |
| Route 53 health checks | 30s interval with failover configuration | SRE |
| Multi-AZ NAT Gateways | One per AZ; automatic failover | Network |
| VPC endpoints for all AWS services | No internet dependency for KMS, Secrets Manager, CloudWatch | Network |
| DNS caching | CoreDNS with appropriate TTLs; node-local DNS cache | Platform |
| External circuit breakers | Application-level resilience for NPCI/bank timeouts | Engineering |

## 14. Compliance References

| Regulation / Standard | Requirement | How This Runbook Satisfies It |
|-----------------------|-------------|-------------------------------|
| **RBI Master Direction §7.3** | DR infrastructure must maintain data integrity during network failures | Write fencing protocol (Section 11) prevents split-brain; automated IAM lock ensures Hyderabad cannot be promoted during partition |
| **RBI Data Localisation** | All payment data must remain within India | All cross-region traffic stays within Indian AWS backbone; VPC peering does not traverse public internet |
| **PCI-DSS v4.0 Req 1.2** | Network segmentation and isolation of CDE | VPC Flow Logs monitor all cross-region traffic; security groups and NACLs enforce least-privilege between layers |
| **PCI-DSS v4.0 Req 1.3** | Restrict direct public access between internet and CDE | Data layer subnets are isolated (no internet access); all external connectivity goes through ALB or VPC endpoints |
| **PCI-DSS v4.0 Req 6.4.3** | Payment page integrity during network disruptions | DNS failover (Route 53) ensures payment pages remain accessible; WAF rules active in both regions |
| **PCI-DSS v4.0 Req 10.5** | Audit trail availability during network incidents | VPC Flow Logs capture all network traffic; CloudTrail logs replicated cross-region; partition does not affect local audit logging |
| **PCI-DSS v4.0 Req 12.10.1** | Incident response readiness for network failures | This runbook covers peering failure, AZ isolation, DNS failure, and external connectivity loss; P1 alerts enable rapid response |
| **NPCI UPI Technical Standards** | Secure, reliable connectivity to UPI switch | External connectivity monitoring (Section 10) ensures NPCI reachability; circuit breakers prevent cascading failures |
| **NPCI UPI** | 99.99% uptime mandate | Redundant VPC peering, multi-AZ NAT Gateways, and VPC endpoints ensure network resilience; DNS failover provides < 5 min RTO |

## 15. Related Runbooks

- RB-001: Complete Region Failure
- RB-002: Database Split-Brain Recovery
- RB-003: Kafka Partition Loss
- RB-005: DNS Failover
- RB-009: EKS Node Failure
- RB-011: Partial Regional Degradation
- RB-012: Full Rollback

## 16. Test Schedule

| Test Type | Frequency | Owner |
|-----------|-----------|-------|
| VPC peering failure simulation (non-prod) | Monthly | Network + DR Team |
| AZ isolation drill | Monthly | Chaos Team |
| DNS failure tabletop | Quarterly | Network + SRE |
| External connectivity loss drill | Quarterly | Network + Engineering |
| Full network partition chaos experiment | Quarterly | Chaos Team |

---

**Document Control:** Review and update after every network incident or quarterly DR test.