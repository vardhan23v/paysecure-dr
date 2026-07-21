# RB-009: EKS Node Failure & Recovery

**Version:** 1.0 | **Last Updated:** 2026-07-20 | **Owner:** Platform Engineering Lead
**Classification:** P1 — Sev 1 | **Expected Recovery Time:** < 10 minutes | **Data Loss Risk:** None (stateless workloads)

---

## 1. Purpose

This runbook covers recovery from Amazon EKS node failures in both the primary (Mumbai) and secondary (Hyderabad) clusters. Scenarios include single-node failure, node group degradation, AZ-wide node loss, control plane impairment, and complete cluster unavailability. Since PaySecure workloads are stateless at the compute layer, recovery focuses on rapid pod rescheduling and node replacement rather than data recovery.

## 2. Trigger Conditions

| Trigger | Detection Mechanism | Automatic / Manual |
|---------|---------------------|--------------------|
| Node `NotReady` status for > 60s | `kubectl get nodes` / Kube-state-metrics | Automatic — P2 alert; P1 if > 3 nodes |
| `NodeHasDiskPressure`, `NodeHasMemoryPressure`, `NodeHasPIDPressure` condition true | Kube-state-metrics → Prometheus | Automatic — P2 alert |
| Pods stuck in `Pending` state > 120s | Kube-state-metrics `kube_pod_status_phase` | Automatic — P1 alert |
| Cluster Autoscaler unable to provision nodes | CA logs: `scale-up failed` | Automatic — P1 alert |
| `kube-system` pods degraded (CoreDNS, kube-proxy) | Kube-state-metrics | Automatic — P1 alert |
| AWS EC2 instance status check failure (2/2) | CloudWatch `StatusCheckFailed_Instance` | Automatic — P1 alert |
| AWS EC2 scheduled maintenance event | AWS Health Dashboard / `aws ec2 describe-instance-status` | Manual — triggers proactive node drain |
| EKS control plane API errors > 10/min | CloudWatch `apiserver_request_total{code=~"5.."}` | Automatic — P1 alert |
| Node group `Degraded` status in AWS Console | AWS EKS API / CloudWatch | Automatic — P1 alert |
| Spot instance interruption notice (2-min warning) | EC2 instance metadata / EventBridge | Automatic — triggers node drain |
| Container runtime (containerd) crash on node | Node `KernelDeadlock` or `ContainerRuntimeUnhealthy` condition | Automatic — P2 alert |
| CNI plugin failures (pod networking broken) | `aws-node` DaemonSet pod failures | Automatic — P1 alert |

**Decision gate:** If > 30% of nodes in the Mumbai production node group are `NotReady`, escalate to RB-001 (Complete Region Failure) and consider failing over to Hyderabad. If only the Hyderabad cluster is affected, treat as P1 but no customer impact.

## 3. Impact Assessment

| Impact Dimension | Severity | Detail |
|------------------|----------|--------|
| **Service Availability** | High | Pods on failed nodes become unavailable until rescheduled; PDBs may limit eviction rate |
| **Revenue** | Medium–High | If payment-gateway pods are affected, transaction processing capacity degrades; revenue impact proportional to capacity loss |
| **Merchant Experience** | Medium | Increased latency or 503 errors if remaining pods are overloaded |
| **End-Customer Experience** | Medium | Payment failures or timeouts during node recovery window |
| **DR Readiness** | High | If Hyderabad EKS is degraded, region failover (RB-001) is compromised; must recover Hyderabad first |
| **Recovery Complexity** | Low–Medium | Stateless workloads reschedule automatically; node replacement is automated via ASG; control plane issues require AWS support |
| **Data Loss Risk** | None | All state is in Aurora, DynamoDB, ElastiCache, and MSK; EKS runs stateless containers |
| **Cascading Risk** | Medium | Overloaded remaining nodes may trigger further failures; HPA must scale pods to compensate |

**Worst-case scenario:** Complete Mumbai EKS control plane failure. Mitigation: fail over to Hyderabad EKS per RB-001 Phase 4.

## 4. Prerequisites

- [ ] `kubectl` configured with contexts for both `eks-mumbai` and `eks-hyderabad`
- [ ] AWS CLI with EKS and EC2 permissions
- [ ] Access to EKS console and CloudWatch Logs for control plane logs
- [ ] Node group ASG details (min/max/desired, instance types)
- [ ] Pod Disruption Budget (PDB) documentation for all critical services
- [ ] Cluster Autoscaler configuration and logs

## 5. EKS Cluster Reference

### 5.1 Mumbai Cluster (`eks-mumbai`)

| Node Group | Instance Type | Min | Max | Desired (Normal) | Purpose |
|------------|--------------|-----|-----|-------------------|---------|
| `system` | `m6i.xlarge` | 3 | 6 | 3 | CoreDNS, kube-proxy, monitoring, ingress controllers |
| `application` | `c6i.2xlarge` | 6 | 24 | 12 | Payment microservices, API gateways, webhook processors |
| `data-plane` | `r6i.2xlarge` | 3 | 12 | 6 | Kafka consumers, cache warmers, batch processors |

### 5.2 Hyderabad Cluster (`eks-hyderabad`)

| Node Group | Instance Type | Min | Max | Desired (Standby) | Purpose |
|------------|--------------|-----|-----|--------------------|---------|
| `system` | `m6i.xlarge` | 3 | 6 | 3 | CoreDNS, kube-proxy, monitoring agents (always active) |
| `application` | `c6i.2xlarge` | 2 | 24 | 2 | Standby microservices (scales to 12 on failover) |
| `data-plane` | `r6i.2xlarge` | 1 | 12 | 1 | Standby consumers (scales to 6 on failover) |

### 5.3 Critical System Pods

| Namespace | Pod | Failure Impact |
|-----------|-----|----------------|
| `kube-system` | `coredns-*` | DNS resolution within cluster fails; service discovery broken |
| `kube-system` | `aws-node-*` | Pod networking (VPC CNI) fails; pods cannot communicate |
| `kube-system` | `kube-proxy-*` | Service IPTables rules stale; ClusterIP services unreachable |
| `kube-system` | `cluster-autoscaler-*` | Node scaling stops; pods stuck in Pending |
| `kube-system` | `aws-load-balancer-controller-*` | New ALB/NLB targets not registered |
| `kube-system` | `ebs-csi-controller-*` | PVC provisioning fails; stateful pods cannot start |
| `datadog` | `datadog-agent-*` | Monitoring gap; metrics and logs not shipped |
| `cert-manager` | `cert-manager-*` | TLS certificate renewal stops |

## 6. Detection

### 6.1 Automated Alerts

| Alert | Metric / Source | P1 Threshold | P2 Threshold |
|-------|----------------|-------------|-------------|
| Node NotReady | `kube_node_status_condition{condition="Ready",status="true"} == 0` | > 3 nodes for 60s | > 1 node for 60s |
| Pods Pending | `kube_pod_status_phase{phase="Pending"}` | > 10 pods for 120s | > 5 pods for 60s |
| Cluster Autoscaler failure | CA logs: `scale-up failed` | Any occurrence | — |
| CoreDNS degraded | `kube_deployment_status_replicas_available{deployment="coredns"}` | < 2 for 60s | < 3 for 60s |
| EC2 status check failure | CloudWatch `StatusCheckFailed_Instance` | Any instance for 60s | — |
| Control plane API errors | `apiserver_request_total{code=~"5.."}` | > 10/min | > 5/min |
| CNI pod failures | `kube_daemonset_status_number_ready{daemonset="aws-node"}` | < desired for 120s | < desired for 60s |

### 6.2 Verification Commands

```bash
# Check node status
kubectl get nodes -o wide

# Check for node conditions
kubectl describe nodes | grep -A5 "Conditions:"

# Check pods by status
kubectl get pods -A --field-selector=status.phase!=Running

# Check Cluster Autoscaler logs
kubectl logs -n kube-system -l app=cluster-autoscaler --tail=50

# Check EC2 instance status
aws ec2 describe-instance-status \
  --instance-ids $(kubectl get nodes -o jsonpath='{.items[*].spec.providerID}' | sed 's|.*/||') \
  --region ap-south-1

# Check EKS control plane health
aws eks describe-cluster --name paysecure-mumbai --region ap-south-1 \
  --query 'cluster.status'

# Check node group status
aws eks describe-nodegroup \
  --cluster-name paysecure-mumbai \
  --nodegroup-name application \
  --region ap-south-1 \
  --query 'nodegroup.status'
```

## 7. Scenario A: Single Node Failure

### 7.1 Assess Impact (Owner: Platform Engineer | ETA: 2 min)

```bash
# Identify which node failed
kubectl get nodes | grep NotReady

# List pods running on the failed node
NODE_NAME="ip-10-0-1-123.ap-south-1.compute.internal"
kubectl get pods -A -o wide --field-selector spec.nodeName=${NODE_NAME}

# Check if critical pods are affected
kubectl get pods -A -o wide --field-selector spec.nodeName=${NODE_NAME} \
  | grep -E "payment-gateway|fraud-engine|settlement-service|api-gateway"
```

### 7.2 Recovery — Automatic (Owner: Platform Engineer | ETA: 3–5 min)

```bash
# Kubernetes automatically marks node as NotReady after 40s (node-monitor-grace-period)
# Pods are evicted after 5 min (pod-eviction-timeout) and rescheduled on healthy nodes

# Step 1: Cordon the failed node (prevent new pods)
kubectl cordon ${NODE_NAME}

# Step 2: Drain the node (evict pods gracefully)
kubectl drain ${NODE_NAME} \
  --ignore-daemonsets \
  --delete-emptydir-data \
  --grace-period=30 \
  --timeout=300s

# Step 3: Verify pods rescheduled
kubectl get pods -A -o wide | grep -E "Pending|ContainerCreating"

# Step 4: If node is an EC2 instance failure, terminate it (ASG will replace)
aws ec2 terminate-instances --instance-ids i-0abc123def4567890 --region ap-south-1

# Step 5: Verify new node joins cluster
kubectl get nodes -w  # Watch for new node in Ready state
```

### 7.3 If Pods Are Stuck in Pending (Owner: Platform Engineer | ETA: 3 min)

```bash
# Check why pods are pending
kubectl describe pod ${POD_NAME} -n production | grep -A10 "Events:"

# Common causes and fixes:

# Cause 1: Insufficient CPU/memory
# Fix: Scale node group or reduce resource requests
aws eks update-nodegroup-config \
  --cluster-name paysecure-mumbai \
  --nodegroup-name application \
  --scaling-config minSize=8,desiredSize=12,maxSize=24 \
  --region ap-south-1

# Cause 2: PVC not bound (EBS CSI issue)
kubectl get pvc -A | grep Pending
kubectl describe pvc ${PVC_NAME} -n production

# Cause 3: Node selector / taint mismatch
kubectl get nodes --show-labels | grep ${LABEL}
kubectl describe nodes | grep -A5 "Taints:"
```

## 8. Scenario B: Node Group Degradation

### 8.1 Diagnose (Owner: Platform Engineer | ETA: 3 min)

```bash
# Check node group status
aws eks describe-nodegroup \
  --cluster-name paysecure-mumbai \
  --nodegroup-name application \
  --region ap-south-1

# Check ASG health
ASG_NAME=$(aws eks describe-nodegroup \
  --cluster-name paysecure-mumbai \
  --nodegroup-name application \
  --region ap-south-1 \
  --query 'nodegroup.resources.autoScalingGroups[0].name' \
  --output text)

aws autoscaling describe-auto-scaling-groups \
  --auto-scaling-group-names ${ASG_NAME} \
  --region ap-south-1 \
  --query 'AutoScalingGroups[0].[DesiredCapacity,Instances[?HealthStatus!=`Healthy`].InstanceId]'

# Check for spot interruptions
aws ec2 describe-instances \
  --filters "Name=tag:aws:autoscaling:groupName,Values=${ASG_NAME}" \
  --region ap-south-1 \
  --query 'Reservations[*].Instances[*].[InstanceId,InstanceLifecycle,State.Name]'
```

### 8.2 Recovery Actions (Owner: Platform Engineer | ETA: 5–10 min)

```bash
# Option A: If ASG is healthy but nodes are NotReady — recycle nodes
for node in $(kubectl get nodes -l node-group=application -o name | grep NotReady); do
  kubectl drain ${node} --ignore-daemonsets --delete-emptydir-data --timeout=300s
done

# Option B: If ASG is degraded — force refresh
aws autoscaling start-instance-refresh \
  --auto-scaling-group-name ${ASG_NAME} \
  --preferences '{"MinHealthyPercentage": 80, "InstanceWarmup": 120}' \
  --region ap-south-1

# Option C: If node group is completely broken — recreate
# First, create a new node group with same config
aws eks create-nodegroup \
  --cluster-name paysecure-mumbai \
  --nodegroup-name application-v2 \
  --subnets subnet-xxx subnet-yyy subnet-zzz \
  --instance-types c6i.2xlarge \
  --scaling-config minSize=6,maxSize=24,desiredSize=12 \
  --region ap-south-1

# Wait for new nodes to join
kubectl get nodes -l node-group=application-v2 -w

# Drain old node group
kubectl drain -l node-group=application --ignore-daemonsets --delete-emptydir-data --timeout=300s

# Delete old node group
aws eks delete-nodegroup \
  --cluster-name paysecure-mumbai \
  --nodegroup-name application \
  --region ap-south-1
```

## 9. Scenario C: AZ-Wide Node Loss

### 9.1 Detection (Owner: Platform Engineer | ETA: 2 min)

```bash
# Check node distribution across AZs
kubectl get nodes -o jsonpath='{range .items[*]}{.metadata.name}{"\t"}{.metadata.labels.topology\.kubernetes\.io/zone}{"\n"}{end}'

# If all nodes in one AZ are NotReady:
# Check AWS Health for AZ issues
aws health describe-events \
  --filter '{"services":["EC2"],"regions":["ap-south-1"]}' \
  --region us-east-1

# Check if the AZ has capacity issues
aws ec2 describe-availability-zones \
  --region ap-south-1 \
  --query 'AvailabilityZones[?ZoneName==`ap-south-1a`].State'
```

### 9.2 Recovery (Owner: Platform Engineer | ETA: 5–10 min)

```bash
# Step 1: Cordon all nodes in the affected AZ
AFFECTED_AZ="ap-south-1a"
for node in $(kubectl get nodes -l topology.kubernetes.io/zone=${AFFECTED_AZ} -o name); do
  kubectl cordon ${node}
done

# Step 2: Drain pods from affected AZ
for node in $(kubectl get nodes -l topology.kubernetes.io/zone=${AFFECTED_AZ} -o name); do
  kubectl drain ${node} --ignore-daemonsets --delete-emptydir-data --timeout=300s --force &
done
wait

# Step 3: Verify pods are rescheduled to other AZs
kubectl get pods -n production -o wide | grep ${AFFECTED_AZ}  # Should be empty

# Step 4: Scale up remaining AZs to compensate
# Increase desired capacity on node groups in healthy AZs
# (ASG will launch instances in remaining AZs)

# Step 5: If AZ outage is prolonged, update node group to exclude affected AZ
aws eks update-nodegroup-config \
  --cluster-name paysecure-mumbai \
  --nodegroup-name application \
  --subnets subnet-healthy-az1 subnet-healthy-az2 \
  --region ap-south-1

# Step 6: Verify all critical pods are running
kubectl get deployments -n production
```

## 10. Scenario D: Control Plane Impairment

### 10.1 Detection (Owner: Platform Engineer | ETA: 2 min)

```bash
# Check EKS control plane status
aws eks describe-cluster --name paysecure-mumbai --region ap-south-1 \
  --query 'cluster.{status:status,endpoint:endpoint,version:version}'

# Check API server availability
kubectl get --raw /healthz
kubectl get --raw /livez

# Check API server metrics (if accessible)
kubectl get --raw /metrics | grep apiserver_request_total

# Check CloudWatch for control plane logs
aws logs filter-log-events \
  --log-group-name /aws/eks/paysecure-mumbai/cluster \
  --filter-pattern "ERROR" \
  --start-time $(date -u -d '10 minutes ago' +%s%3N) \
  --region ap-south-1
```

### 10.2 Recovery Options (Owner: Platform Engineer / AWS Support | ETA: 5–15 min)

```bash
# Option A: If control plane is degraded but reachable — wait for AWS recovery
# EKS control planes are AWS-managed; most issues self-resolve within 5-10 min
# Monitor: aws eks describe-cluster --name paysecure-mumbai --region ap-south-1

# Option B: If control plane is completely unreachable — fail over workloads
# Existing pods continue running even if control plane is down
# But: no new deployments, no scaling, no health checks

# If control plane is down > 10 min, initiate failover to Hyderabad:
# See RB-001 Phase 4 (Scale EKS Workloads in Hyderabad)

# Step 1: Switch to Hyderabad context
kubectl config use-context eks-hyderabad

# Step 2: Scale Hyderabad to production capacity
kubectl scale deployment payment-gateway -n production --replicas=6
kubectl scale deployment fraud-engine -n production --replicas=4
kubectl scale deployment settlement-service -n production --replicas=3
kubectl scale deployment notification-service -n production --replicas=2
kubectl scale deployment api-gateway -n production --replicas=6

# Step 3: Promote data stores (see RB-001 Phase 2)
# Step 4: DNS failover (see RB-001 Phase 3)

# Option C: If control plane is down but workloads are fine — wait
# Existing pods, services, and networking continue to function
# Only management operations are blocked
# Set maximum wait time: 15 min before failover decision
```

## 11. Scenario E: Complete Cluster Unavailability (Hyderabad)

### 11.1 Impact

If Hyderabad EKS is completely unavailable, the DR capability is compromised. Mumbai continues to serve traffic but there is no warm standby for failover.

### 11.2 Recovery (Owner: Platform Engineer | ETA: 15–30 min)

```bash
# Step 1: Assess if this is an AWS regional issue
aws health describe-events \
  --filter '{"services":["EKS"],"regions":["ap-south-2"]}' \
  --region us-east-1

# Step 2: If cluster is irrecoverable, recreate from IaC
# Use Terraform/CloudFormation to recreate the cluster
cd infra/terraform/hyderabad
terraform apply -target=module.eks

# Step 3: Re-deploy baseline workloads
kubectl config use-context eks-hyderabad
kubectl apply -k kubernetes/hyderabad/base/

# Step 4: Verify system pods
kubectl get pods -n kube-system
kubectl get pods -n datadog
kubectl get pods -n cert-manager

# Step 5: Deploy application workloads at standby scale
kubectl apply -k kubernetes/hyderabad/standby/

# Step 6: Verify DR readiness
kubectl get deployments -n production
# All deployments should show 1-2 replicas (standby scale)
```

## 12. Pod Disruption Budget Recovery

### 12.1 If PDB Blocks Evictions (Owner: Platform Engineer | ETA: 2 min)

```bash
# Check PDB status
kubectl get pdb -n production

# If a PDB is blocking evictions during node drain:
# Temporarily increase PDB maxUnavailable or remove PDB
kubectl patch pdb payment-gateway-pdb -n production \
  --type='json' -p='[{"op": "replace", "path": "/spec/maxUnavailable", "value": "50%"}]'

# After recovery, restore original PDB
kubectl patch pdb payment-gateway-pdb -n production \
  --type='json' -p='[{"op": "replace", "path": "/spec/maxUnavailable", "value": "25%"}]'
```

## 13. Verification Steps

```bash
# 1. All nodes Ready
kubectl get nodes | grep -c "Ready"  # Should equal total node count

# 2. No pods in Pending or CrashLoopBackOff
kubectl get pods -A --field-selector=status.phase!=Running | grep -v "Completed"

# 3. All deployments at desired replicas
kubectl get deployments -A | grep -v "1/1\|2/2\|3/3\|4/4\|6/6\|12/12"

# 4. CoreDNS healthy
kubectl get deployment coredns -n kube-system

# 5. CNI pods running on all nodes
kubectl get daemonset aws-node -n kube-system

# 6. Cluster Autoscaler running
kubectl get pods -n kube-system -l app=cluster-autoscaler

# 7. Application health
curl -s https://api.paysecure.example.com/health | jq .

# 8. Node group status
aws eks describe-nodegroup --cluster-name paysecure-mumbai --nodegroup-name application \
  --region ap-south-1 --query 'nodegroup.status'

# 9. Synthetic transaction
curl -s -X POST https://api.paysecure.example.com/v1/payments/test \
  -H "Content-Type: application/json" \
  -d '{"amount": 1, "currency": "INR", "test_mode": true}' | jq .
```

## 14. Rollback Plan

### 14.1 Node Drain Rollback

If draining a node causes unexpected application instability:

| Step | Action | Owner | ETA |
|------|--------|-------|-----|
| 1 | Uncordon the node immediately | Platform Engineer | 30s |
| 2 | Verify pods are rescheduled back (if they were evicted) | Platform Engineer | 2 min |
| 3 | Investigate why drain caused issues (PDB, anti-affinity, resource constraints) | Platform Engineer | 5 min |
| 4 | Re-attempt drain with higher grace period and lower concurrency | Platform Engineer | 5 min |

### 14.2 Node Group Recreation Rollback

If new node group fails to launch or causes issues:

| Step | Action | Owner | ETA |
|------|--------|-------|-----|
| 1 | Stop draining old node group | Platform Engineer | 30s |
| 2 | Verify old node group is still functional | Platform Engineer | 2 min |
| 3 | Delete new (problematic) node group | Platform Engineer | 2 min |
| 4 | Investigate launch failures (AMI, subnet, IAM role, security group) | Platform Engineer | 10 min |
| 5 | Recreate node group with corrected configuration | Platform Engineer | 10 min |

### 14.3 Control Plane Failover Rollback

If workloads were failed over to Hyderabad due to Mumbai control plane issues:

| Step | Action | Owner | ETA |
|------|--------|-------|-----|
| 1 | Verify Mumbai control plane is healthy | Platform Engineer | 2 min |
| 2 | Scale Mumbai deployments back to production capacity | SRE | 2 min |
| 3 | Shift DNS back to Mumbai (see RB-001 Section 9) | SRE | 5 min |
| 4 | Scale Hyderabad back to standby | SRE | 2 min |
| 5 | Full failback procedure per RB-012 | Incident Commander | — |

### 14.4 Prevention Measures

| Measure | Implementation | Owner |
|---------|---------------|-------|
| Multi-AZ node distribution | Node groups span 3 AZs; topology spread constraints on pods | Platform |
| Pod Disruption Budgets | Defined for all critical services (min 1 available) | Platform |
| Cluster Autoscaler | Enabled with appropriate min/max; over-provisioning buffer | Platform |
| Node problem detector | DaemonSet monitoring kernel, Docker, and hardware issues | Platform |
| Spot instance diversification | Multiple instance types in ASG; fallback to on-demand | Platform |
| Control plane monitoring | CloudWatch alarms on API server errors | SRE |
| Regular node rotation | Monthly node group recycling via instance refresh | Platform |
| Pre-pulled images | Critical images cached in Hyderabad node AMI for fast scale-out | Platform |

## 15. Compliance References

| Regulation / Standard | Requirement | How This Runbook Satisfies It |
|-----------------------|-------------|-------------------------------|
| **RBI Master Direction §7.3** | DR infrastructure must be tested and recoverable | Hyderabad EKS cluster maintained as warm standby; node failure recovery tested quarterly (Section 17); failover procedure (Section 10.2) ensures < 5 min RTO |
| **RBI Data Localisation** | All payment processing must remain within India | Both EKS clusters in Indian regions (`ap-south-1`, `ap-south-2`); no cross-border compute |
| **PCI-DSS v4.0 Req 6.4.3** | Payment page integrity — all scripts and configurations must be authorised | EKS deployments are immutable (container images); node replacements use approved AMIs; no unauthorised changes during recovery |
| **PCI-DSS v4.0 Req 9.5.1.2.1** | Resilience testing of critical security controls | Node failure drills validate that security controls (WAF, IAM, network policies) remain effective during degraded operations |
| **PCI-DSS v4.0 Req 12.10.1** | Incident response readiness for infrastructure failures | This runbook covers single node, node group, AZ-wide, and control plane failures; P1 alerts enable rapid response |
| **PCI-DSS v4.0 Req 12.10.5** | Alerting and monitoring must continue during incident | System node group includes monitoring agents (Datadog); control plane failure does not affect pod-level monitoring |
| **NPCI UPI Technical Standards** | System availability and performance | Multi-AZ node distribution ensures UPI services survive single-AZ failure; PDBs maintain minimum pod availability during node drains |
| **NPCI UPI** | 99.99% uptime mandate | Active-passive with < 5 min RTO; EKS failover to Hyderabad within RTO budget (RB-001 Phase 4) |

## 16. Related Runbooks

- RB-001: Complete Region Failure
- RB-005: DNS Failover
- RB-006: Peak-Load Failover
- RB-010: Network Partition
- RB-011: Partial Regional Degradation
- RB-012: Full Rollback

## 17. Test Schedule

| Test Type | Frequency | Owner |
|-----------|-----------|-------|
| Single node drain drill | Weekly | Platform |
| Node group instance refresh | Monthly | Platform |
| AZ failure simulation (non-prod) | Monthly | Chaos Team |
| Control plane failure tabletop | Quarterly | SRE + Platform |
| Full EKS failover to Hyderabad | Quarterly | DR Team |

---

**Document Control:** Review and update after every production node failure incident or quarterly DR test.