# Architecture Overview: PaySecure Multi-Region Disaster Recovery

| Attribute | Value |
|-----------|-------|
| **Status** | Current |
| **Date** | 2026-07-20 |
| **Owner** | Architecture Team |
| **Scope** | PaySecure DR platform — all payment processing workloads |

---

## 1. Regional Layout

PaySecure operates an **active-passive** multi-region topology across Indian AWS regions to satisfy RBI data localisation, PCI-DSS v4.0, and NPCI UPI requirements.

| Role | AWS Region | Region Code | Purpose |
|------|------------|-------------|---------|
| **Primary** | Asia Pacific (Mumbai) | `ap-south-1` | Active production traffic; sole writer for all data stores |
| **Secondary** | Asia Pacific (Hyderabad) | `ap-south-2` | Warm standby; pre-deployed environment with continuous replication |
| **Tertiary** | Asia Pacific (Pune) | `ap-south-3` | Evaluation / future expansion; not part of the active DR pair today |

### 1.1 Design Targets

| Target | Value | Rationale |
|--------|-------|-----------|
| Recovery Point Objective (RPO) | < 1 minute | Minimise transaction loss during failover |
| Recovery Time Objective (RTO) | < 5 minutes | Ensure merchant-facing services resume rapidly |
| Data Residency | India only | RBI data localisation mandates |

### 1.2 Regional Responsibilities

- **Mumbai (`ap-south-1`)**: Hosts 100% of live production traffic. All write operations originate here. Runs at full production scale.
- **Hyderabad (`ap-south-2`)**: Maintains a warm standby. Application stacks are pre-deployed but run at a minimal baseline footprint, ready to scale out during failover. All data stores are kept in sync via cross-region replication.
- **Pune (`ap-south-3`)**: Reserved for future three-region resilience, regulatory diversification, and peak-season capacity expansion.

---

## 2. Network Architecture

### 2.1 VPC Design

Each region deploys a dedicated, non-overlapping VPC with a multi-AZ subnet layout:

| Layer | Subnet Type | Availability Zones | Purpose |
|-------|-------------|-------------------|---------|
| Edge | Public | 3 AZs | ALB, NAT Gateways, Bastion hosts |
| Compute | Private | 3 AZs | EKS worker nodes, microservices pods |
| Data | Isolated / Database | 3 AZs | Aurora, ElastiCache, MSK brokers |

- **Cross-region VPC peering** connects Mumbai and Hyderabad for encrypted replication traffic between data layers.
- **Transit Gateway** is not used in the current two-region pair to minimise complexity; VPC peering is sufficient for replication bandwidth requirements.
- **Pune (`ap-south-3`)** VPC is defined in infrastructure-as-code but not peered until promoted to active DR status.

### 2.2 Application Load Balancer (ALB)

| Region | ALB Role | State |
|--------|----------|-------|
| Mumbai | Primary ingress for all merchant and internal traffic | Active, full capacity |
| Hyderabad | Standby ingress; health-checked but receiving no production traffic | Warm, baseline capacity |

- ALBs terminate TLS using ACM certificates.
- Web Application Firewall (WAF) rules are attached to both ALBs (see [Security](#5-security)).
- During failover, Route 53 shifts traffic to the Hyderabad ALB, which scales target groups via EKS auto-scaling.

### 2.3 Route 53 DNS & Failover

- **Hosted Zone**: `paysecure.in` (example) managed in Route 53.
- **Failover Policy**: Health-checked failover records for each regional ALB.
  - Primary record: Mumbai ALB (evaluated every 30 seconds).
  - Secondary record: Hyderabad ALB (serves traffic only when Mumbai health checks fail).
- **Health Checks**: HTTP/HTTPS endpoint probes against a `/health` path on each ALB. Failure threshold: 3 consecutive failures.
- **TTL**: 60 seconds for rapid propagation during failover.

---

## 3. Compute Layer (Amazon EKS)

### 3.1 Cluster Topology

| Region | Cluster Role | Node Pool State |
|--------|--------------|-----------------|
| Mumbai | Primary production cluster | Full production node pools (on-demand + spot) |
| Hyderabad | DR standby cluster | Baseline node pool (on-demand only); auto-scaling to full capacity on failover |

### 3.2 EKS Configuration

- **Kubernetes Version**: Kept within N-1 of latest stable EKS release.
- **Node Pools**:
  - **System pool**: CoreDNS, kube-proxy, AWS Load Balancer Controller, monitoring agents (always running in both regions).
  - **Application pool**: Payment microservices, API gateways, webhook processors (full scale in Mumbai; baseline in Hyderabad).
  - **Data plane pool**: Kafka consumers, cache warmers, replication workers (scaled with data store throughput).
- **Auto-scaling**:
  - Cluster Autoscaler in both regions.
  - Hyderabad cluster uses pre-defined node pool templates and cached container images to achieve scale-out within RTO window.
- **Pod Disruption Budgets**: Defined for critical payment services to ensure minimum availability during node rotations.

### 3.3 Workload Distribution

| Workload | Primary Region | Secondary Region |
|----------|---------------|------------------|
| Payment API | Mumbai | Hyderabad (standby) |
| Merchant Portal | Mumbai | Hyderabad (standby) |
| Webhook Delivery | Mumbai | Hyderabad (standby) |
| Reconciliation Jobs | Mumbai | Hyderabad (standby) |
| Monitoring Agents | Mumbai | Hyderabad (active) |

---

## 4. Data Layer

All data stores replicate from Mumbai (primary) to Hyderabad (secondary). Write operations are accepted only in Mumbai under normal operations.

### 4.1 Amazon Aurora PostgreSQL — Global Database

| Attribute | Configuration |
|-----------|---------------|
| **Primary Cluster** | Mumbai (`ap-south-1`) |
| **Secondary Cluster** | Hyderabad (`ap-south-2`) |
| **Replication** | Aurora Global Database physical replication |
| **Failover** | Managed promotion of secondary to primary |

- **RPO Protection**: Near-synchronous replication with typical lag < 500 ms.
- **Lag Monitoring**: CloudWatch `AuroraGlobalDBReplicationLag` with P1 (critical) and P2 (warning) thresholds.
- **Use Cases**: Transaction ledger, settlement records, merchant onboarding data.

### 4.2 Amazon DynamoDB — Global Tables

| Attribute | Configuration |
|-----------|---------------|
| **Primary Region** | Mumbai (`ap-south-1`) |
| **Replica Region** | Hyderabad (`ap-south-2`) |
| **Replication** | DynamoDB Global Tables (multi-region, multi-active capability, but used in active-passive mode) |

- **RPO Protection**: Typically sub-second replication latency within the same AWS partition.
- **Lag Monitoring**: CloudWatch `ReplicationLatency` per table.
- **Use Cases**: Session state, idempotency keys, rate-limit counters, configuration tables.
- **Conflict Resolution**: Although Global Tables support multi-active writes, application logic enforces single-primary writes to avoid conflicts.

### 4.3 Amazon ElastiCache (Redis) — Global Datastore

| Attribute | Configuration |
|-----------|---------------|
| **Primary Cluster** | Mumbai (`ap-south-1`) |
| **Secondary Cluster** | Hyderabad (`ap-south-2`) |
| **Replication** | ElastiCache Global Datastore for Redis |

- **RPO Protection**: Asynchronous replication with typical lag < 1 second.
- **Lag Monitoring**: CloudWatch `GlobalDatastoreReplicationLag`.
- **Use Cases**: Cached payment instrument metadata, temporary auth tokens, merchant configuration cache.
- **Failover Behaviour**: On regional failover, the Hyderabad cluster is promoted to primary. Cache warming scripts pre-populate hot keys in the secondary cluster.

### 4.4 Amazon MSK (Managed Streaming for Kafka)

| Attribute | Configuration |
|-----------|---------------|
| **Primary Cluster** | Mumbai (`ap-south-1`) |
| **Secondary Cluster** | Hyderabad (`ap-south-2`) |
| **Replication** | MirrorMaker 2 (MM2) or native MSK cross-cluster replication |

- **RPO Protection**: Replication lag depends on topic throughput; target < 30 seconds for critical payment topics.
- **Lag Monitoring**: Custom lag exporter (Kafka consumer group lag) + P1/P2 alerting.
- **Use Cases**: Event sourcing for payment events, audit log streaming, reconciliation pipelines, webhook dispatch queues.
- **Topic Strategy**:
  - Critical topics (e.g., `payment.authorized`, `payment.captured`) are replicated with high priority.
  - Analytics topics with anonymised data may be replicated with lower priority (see compliance note below).

### 4.5 Analytics Data Note

Aggregated transaction volumes and trend data used for analytics are anonymised (irreversibly) before any cross-region movement. Anonymisation must be verified with the Data Protection Officer (DPO). No residency constraints apply to truly anonymised data.

---

## 5. Security

### 5.1 AWS KMS (Key Management Service)

| Region | Key Purpose | Replication |
|--------|-------------|-------------|
| Mumbai | Primary encryption keys for data at rest | — |
| Hyderabad | DR replica keys for failover decryption | Multi-Region KMS keys replicate key material from Mumbai |

- **Multi-Region KMS Keys**: Used for Aurora, DynamoDB, EBS, S3, and Secrets Manager to ensure Hyderabad can decrypt data during failover without re-encrypting.
- **Key Rotation**: Automatic annual rotation enabled.
- **Failover**: In a region failure, the Hyderabad replica key becomes the primary for its region without dependency on Mumbai KMS.

### 5.2 AWS Secrets Manager

- **Secret Replication**: Secrets are replicated from Mumbai to Hyderabad using Secrets Manager multi-region secrets.
- **Rotation**: Automatic rotation for database credentials, API keys, and certificate private keys.
- **Failover**: Hyderabad has read access to replicated secrets; during failover, application pods in Hyderabad use regional Secrets Manager endpoints.

### 5.3 AWS WAF (Web Application Firewall)

- **Deployment**: WAFv2 WebACLs attached to both Mumbai and Hyderabad ALBs.
- **Rule Sets**:
  - AWS Managed Rules (Common, Known Bad Inputs, SQLi, XSS).
  - Custom rate-based rules for DDoS protection.
  - Geo-blocking rules (if required by compliance).
- **Failover**: WAF rules are version-controlled and deployed identically to both regions via infrastructure-as-code.

### 5.4 Additional Security Controls

| Control | Implementation |
|---------|----------------|
| **TLS in transit** | 1.3 enforced on ALB, EKS ingress, and inter-service mTLS via AWS Private CA |
| **VPC endpoints** | PrivateLink endpoints for KMS, Secrets Manager, CloudWatch, S3 to prevent traffic leaving the AWS backbone |
| **Security groups** | Least-privilege, layer-specific security groups with explicit cross-region peering rules |
| **IAM** | Regional IAM roles for EKS pod identity; no long-term credentials |
| **Audit logging** | CloudTrail enabled in both regions; logs replicated to S3 with object lock |

---

## 6. Monitoring & Observability

### 6.1 Resilient Monitoring Design

> **Requirement**: If the primary region fails, monitoring must continue from the secondary region without loss of alerting or telemetry.

| Component | Mumbai | Hyderabad |
|-----------|--------|-----------|
| **CloudWatch** | Primary metrics and logs | Secondary metrics and logs |
| **CloudWatch Alarms** | Active | Active (same thresholds) |
| **X-Ray** | Primary trace collection | Secondary trace collection |
| **Alerting Endpoints** | Primary SNS → PagerDuty/OpsGenie | Secondary SNS → PagerDuty/OpsGenie |

- **Cross-Region Log Replication**: Critical CloudWatch Logs groups are replicated from Mumbai to Hyderabad via subscription filters and Kinesis Data Firehose.
- **Alarm Redundancy**: All P1/P2 alarms are defined in both regions. During failover, Hyderabad alarms continue to evaluate metrics locally.
- **Dashboards**: DR readiness, incident response, executive summary, merchant impact, and cost tracking dashboards are deployed in both regions with defined refresh rates.

### 6.2 Replication Lag Monitoring

| Data Store | Metric | P1 Threshold | P2 Threshold |
|------------|--------|--------------|--------------|
| Aurora Global DB | `AuroraGlobalDBReplicationLag` | > 30 seconds | > 10 seconds |
| DynamoDB Global Tables | `ReplicationLatency` | > 30 seconds | > 10 seconds |
| ElastiCache Global Datastore | `GlobalDatastoreReplicationLag` | > 30 seconds | > 10 seconds |
| MSK (Kafka) | Custom consumer lag exporter | > 60 seconds | > 30 seconds |

### 6.3 Health Checks & Synthetic Canaries

- **CloudWatch Synthetics**: Canary scripts run from both Mumbai and Hyderabad to probe payment APIs every 60 seconds.
- **Route 53 Health Checks**: ALB-level health checks drive DNS failover decisions.
- **Custom Probes**: EKS liveness/readiness probes on all payment microservices.

---

## 7. Component-to-Region Mapping

| Component | Mumbai (`ap-south-1`) | Hyderabad (`ap-south-2`) | Pune (`ap-south-3`) |
|-----------|----------------------|-------------------------|---------------------|
| **VPC** | Active production VPC | Warm standby VPC | Defined, not peered |
| **ALB** | Active ingress | Standby ingress | — |
| **Route 53** | Primary health-checked record | Secondary failover record | — |
| **EKS Cluster** | Full production scale | Baseline + auto-scale | — |
| **Aurora PostgreSQL** | Global DB primary | Global DB secondary | — |
| **DynamoDB** | Global Table primary | Global Table replica | — |
| **ElastiCache Redis** | Global Datastore primary | Global Datastore secondary | — |
| **MSK (Kafka)** | Primary cluster | Secondary cluster (MM2) | — |
| **KMS** | Multi-Region key primary | Multi-Region key replica | — |
| **Secrets Manager** | Primary secret | Replicated secret | — |
| **WAF** | Active WebACL | Standby WebACL | — |
| **CloudWatch / Alarms** | Primary monitoring | Secondary monitoring | — |
| **CloudTrail / Audit** | Primary trail | Secondary trail | — |

---

## 8. State Replication Flows

### 8.1 Normal Operations (Mumbai Active, Hyderabad Standby)

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                              MUMBAI (ap-south-1)                            │
│  ┌─────────┐    ┌─────────┐    ┌─────────┐    ┌─────────┐    ┌─────────┐  │
│  │   ALB   │───▶│   EKS   │───▶│ Aurora  │───▶│DynamoDB │───▶│ElastiCache│ │
│  │ (Active)│    │(Primary)│    │(Primary)│    │(Primary)│    │(Primary) │  │
│  └─────────┘    └─────────┘    └────┬────┘    └────┬────┘    └────┬────┘  │
│                                     │              │              │        │
│                              ┌──────┴──────┐       │              │        │
│                              │    MSK      │◀──────┘              │        │
│                              │ (Primary)   │◀─────────────────────┘        │
│                              └──────┬──────┘                               │
└─────────────────────────────────────┼──────────────────────────────────────┘
                                      │
                    ┌─────────────────┼─────────────────┐
                    │   Cross-Region Replication        │
                    │   (Encrypted via VPC Peering)     │
                    └─────────────────┼─────────────────┘
                                      ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│                            HYDERABAD (ap-south-2)                           │
│  ┌─────────┐    ┌─────────┐    ┌─────────┐    ┌─────────┐    ┌─────────┐  │
│  │   ALB   │    │   EKS   │◀───│ Aurora  │◀───│DynamoDB │◀───│ElastiCache│ │
│  │(Standby)│    │(Warm)   │    │(Secondary)│   │(Replica)│    │(Secondary)│ │
│  └─────────┘    └─────────┘    └────┬────┘    └────┬────┘    └────┬────┘  │
│                                     │              │              │        │
│                              ┌──────┴──────┐       │              │        │
│                              │    MSK      │◀──────┘              │        │
│                              │(Secondary)  │◀─────────────────────┘        │
│                              │  (MM2)      │                               │
│                              └─────────────┘                               │
└─────────────────────────────────────────────────────────────────────────────┘
```

### 8.2 Replication Flow Details

1. **Aurora Global DB**: Physical storage-layer replication streams WAL changes from Mumbai to Hyderabad. No application-level logic required.
2. **DynamoDB Global Tables**: DynamoDB service replicates item-level changes. Application writes to Mumbai; Hyderabad receives eventually consistent reads.
3. **ElastiCache Global Datastore**: Redis asynchronous replication propagates cache mutations. Hot keys are pre-warmed in Hyderabad via cache warming jobs.
4. **MSK (Kafka)**: MirrorMaker 2 consumes from Mumbai topics and produces to Hyderabad topics. Consumer group offsets are synchronised to allow seamless failover of stream processors.

### 8.3 Failover Flow (Mumbai Fails → Hyderabad Promoted)

```
Step 1: Route 53 health checks detect Mumbai ALB failure.
        ↓
Step 2: DNS failover routes traffic to Hyderabad ALB.
        ↓
Step 3: EKS Cluster Autoscaler scales Hyderabad node pools to production capacity.
        ↓
Step 4: Aurora Global Database secondary cluster is promoted to primary.
        ↓
Step 5: DynamoDB Global Tables continue serving reads; write endpoint shifts to Hyderabad.
        ↓
Step 6: ElastiCache Global Datastore secondary is promoted to primary.
        ↓
Step 7: MSK stream processors in Hyderabad resume from replicated offsets.
        ↓
Step 8: Monitoring alarms continue from Hyderabad; PagerDuty notifications sent.
```

### 8.4 Failback Flow (Mumbai Recovers)

1. Mumbai infrastructure is validated (network, compute, data store health).
2. Aurora Global Database is re-established with Mumbai as primary (planned switchover).
3. DynamoDB, ElastiCache, and MSK replication directions are reversed.
4. Route 53 traffic is shifted back to Mumbai ALB after health check validation.
5. Hyderabad scales back to baseline standby capacity.

---

## 9. Compliance Alignment

| Regulation / Standard | Requirement | Architecture Satisfaction |
|-----------------------|-------------|---------------------------|
| **RBI Data Localisation** | All payment system data must reside within India | All primary, secondary, and candidate regions are Indian AWS regions (`ap-south-1`, `ap-south-2`, `ap-south-3`). |
| **PCI-DSS v4.0** | Req 9.5.1.2.1 — resilience testing; Req 12.10.1 — incident response readiness | DR runbooks, FMEA analysis, and chaos engineering experiments validate resilience. |
| **NPCI UPI** | UPI system availability and DR guidelines | RTO < 5 min ensures UPI-linked payment services resume within acceptable windows. |
| **India Data Localisation** | Sensitive personal and payment data must not leave Indian territory | All data at rest and in transit remains within Indian regions. Anonymised analytics data is verified by DPO before any relaxed handling. |

---

## 10. Related Documents

- [ADR-001: Topology Selection](../adr/ADR-001-topology-selection.md)
- ADR-002: Data Store Selection (Aurora Global DB, DynamoDB Global Tables, ElastiCache Global Datastore)
- ADR-003: Replication & Lag Monitoring Strategy
- Runbooks: 12 production-ready DR runbooks (region failure, split-brain, Kafka issues, cache corruption, DNS, peak load, KMS, secrets, EKS, network, partial degradation, rollback)
- FMEA Analysis: 20+ failure modes with RPN prioritisation
- Dashboards: DR readiness, incident response, executive summary, merchant impact, cost tracking

---

## 11. Notes & Assumptions

- Chaos engineering experiments must be conducted with extreme care to avoid impacting real transactions. All experiments require explicit blast-radius controls and abort criteria.
- The monitoring infrastructure itself must be resilient; if Mumbai fails, monitoring must continue from Hyderabad without loss of alerting or telemetry.
- This architecture overview will be reviewed quarterly or after any significant regional AWS service incident.
- Pune (`ap-south-3`) is held in evaluation status and is not part of the active DR pair today.
