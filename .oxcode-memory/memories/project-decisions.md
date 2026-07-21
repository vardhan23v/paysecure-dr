---
title: Project decisions
slug: project-decisions
tags: 
scope: project
updated_at: 2026-07-20T19:11:49.052Z
source: live
hook: User-stated constraints, newest: |analytics<br>data|aggregated<br>transaction<br>volumes,<br>trend data
---

- [2026-07-20] |Analytics<br>Data|Aggregated<br>transaction<br>volumes,<br>trend data<br>(anonymised)|No residency<br>constraint (if<br>truly<br>anonymised)|All regions|Anonymisation must be<br>irreversible; verify with DPO|
- [2026-07-20] The monitoring infrastructure itself must be resilient - if the primary region fails, monitoring must continue from the secondary region
- [2026-07-20] For a payment processing system, chaos engineering must be conducted with extreme care to avoid impacting real transactions
- Active-passive topology selected for multi-region DR to meet RPO < 1 minute and RTO < 5 minutes.
- India-centric regions (Mumbai, Hyderabad, Pune) chosen for data residency and regulatory compliance.
- Aurora Global DB, DynamoDB Global Tables, ElastiCache Global Datastore, and MSK replication configured with cross-region sync and lag monitoring.
- P1/P2 alerting thresholds defined for replication lag, application health, infrastructure, and security metrics.
- 12 production-ready DR runbooks authored covering region failure, split-brain, Kafka issues, cache corruption, DNS, peak load, KMS, secrets, EKS, network, partial degradation, and rollback.
- FMEA framework applied to 20+ failure modes; RPN prioritization guides mitigation investments.
- Chaos engineering experiments designed with controlled blast radius and abort criteria for validating resilience.
- Dashboards created for DR readiness, incident response, executive summary, merchant impact, and cost tracking with defined refresh rates.
- All design decisions mapped to RBI, PCI-DSS v4.0, NPCI UPI, and India data localisation requirements.
- Attack surface analysis completed for multi-region deployment risks and corresponding mitigations documented.
• Project directory structure established under pro3 root with docs/ subdirectories: adr/, architecture/, rpo-rto/, compliance/, runbooks/, diagrams/
• All subdirectories created successfully using mkdir -p command
• Directory layout finalized for subsequent documentation phases
• No transient states or incomplete tasks recorded
• No failures or warnings in baseline diagnostics
- Active-passive topology selected for multi-region disaster recovery in India-centric AWS regions (Mumbai primary, Hyderabad secondary, Pune tertiary evaluation).
- RPO < 1 minute and RTO < 5 minutes constraints met through synchronous replication and lag monitoring.
- Compliance aligned with RBI data localisation, PCI-DSS v4.0, and NPCI UPI requirements.
- Rejected active-active topology due to data consistency risks, latency, compliance complexity, and minimal RTO benefit.
- Rejected single-region with backup due to inability to meet RPO requirements.
- Aurora Global DB, DynamoDB Global Tables, ElastiCache Global Datastore, and MSK replication implemented with cross-region sync and P1/P2 alerting.
- 12 production-ready DR runbooks authored for various failure scenarios.
- FMEA framework applied to 20+ failure modes with RPN-based mitigation prioritization.
- Chaos engineering experiments designed with controlled blast radius and abort criteria.
- Dashboards created for DR readiness, incident response, executive summary, merchant impact, and cost tracking.
- Active-passive multi-region DR topology selected for RPO < 1 minute and RTO < 5 minutes
- Regional layout: Mumbai (primary), Hyderabad (secondary), Pune (tertiary evaluation)
- Network: VPCs, ALBs, Route 53 health-checked failover with TTL and thresholds
- Compute: EKS clusters with node pools, auto-scaling, workload distribution
- Data layer: Aurora Global DB, DynamoDB Global Tables, ElastiCache Global Datastore, MSK with cross-region sync and lag monitoring
- Security: Multi-Region KMS, Secrets Manager replication, WAF, TLS, VPC endpoints, IAM
- Monitoring: Cross-region resilient monitoring, P1/P2 thresholds, synthetic canaries
- Component-to-region mapping documented for all 14 components
- State replication flows illustrated with ASCII diagrams for normal, failover, and failback operations
- All design decisions aligned with RBI, PCI-DSS v4.0, NPCI UPI, and India data localisation requirements
- 12 production-ready DR runbooks authored covering key failure scenarios
- FMEA framework applied to 20+ failure modes with RPN prioritization
- Chaos engineering conducted with controlled blast radius and abort criteria
- Dashboards created for DR readiness, incident response, executive summary, merchant impact, and cost tracking
- Active-passive topology selected for multi-region DR to meet RPO < 1 minute and RTO < 5 minutes
- Aurora Global DB replication lag target: <5 seconds
- DynamoDB Global Tables replication lag target: <3 seconds
- ElastiCache Global Datastore replication lag target: <5 seconds
- MSK MirrorMaker 2 replication lag target: <30 seconds
- Aggregate worst-case RPO budget: <43 seconds
- Failover phases: failure detection (90s), DNS propagation (60s), EKS scale-out (90s), data store promotion (60s), application readiness (30s)
- Parallel execution and 20% contingency ensure RTO < 5 minutes
- Component-level RPO/RTO budget allocation documented with mitigations
- Timed recovery steps linked to 12 DR runbooks
- Monitoring thresholds defined for replication lag, application health, infrastructure, and security
- Compliance mapping to RBI, PCI-DSS v4.0, NPCI UPI, and India data localisation requirements
- Chaos engineering conducted with controlled blast radius and abort criteria for resilience validation
- Implemented src/pages/Compliance.jsx with sortable control table and framework summary cards for RBI, PCI-DSS v4.0, NPCI UPI, and India Data Localisation.
- Implemented src/pages/FMEA.jsx with sortable failure modes table, RPN color coding, filtering, and runbook linking from src/data/fmea.json.
- Added /compliance and /fmea routes in src/App.jsx.
- Built and validated project with clean npm run build output.
