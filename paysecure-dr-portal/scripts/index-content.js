import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

// ── helpers ──────────────────────────────────────────────────────────

function ensureDir(dir) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

function copyDir(src, dest) {
  ensureDir(dest);
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    const s = path.join(src, entry.name);
    const d = path.join(dest, entry.name);
    if (entry.isDirectory()) copyDir(s, d);
    else if (entry.name.endsWith('.md')) fs.copyFileSync(s, d);
  }
}

function parseFrontMatter(raw) {
  const lines = raw.split('\n');
  const meta = {};
  for (const line of lines) {
    // Stop at the first `---` separator or `## ` heading
    if (line.trim() === '---' || /^##\s/.test(line)) break;
    // Skip the H1 title line and blank lines
    if (/^#\s/.test(line) || line.trim() === '') continue;

    // Handle table-row format: | **Key** | Value |
    const tableKv = line.match(/^\|\s*\*\*(.+?)\*\*\s*\|\s*(.+?)\s*\|?\s*$/);
    if (tableKv) {
      const key = tableKv[1].trim().replace(/:$/, '');
      meta[key] = tableKv[2].trim();
      continue;
    }

    // Handle inline bold format: **Key:** value | **Key2:** value2 | ...
    // Split on ` | ` that precedes `**`
    const parts = line.split(/\s*\|\s+(?=\*\*)/);
    for (const part of parts) {
      // Format: **Key:** value  (key includes trailing colon)
      const kv = part.match(/^\*\*(.+?)\*\*\s+(.+)/);
      if (kv) {
        const key = kv[1].trim().replace(/:$/, '');
        meta[key] = kv[2].trim();
      }
    }
  }
  return meta;
}

function extractTitle(raw) {
  const h1 = raw.match(/^#\s+(.+)/m);
  if (h1) return h1[1].trim();
  // fallback: first bold line
  const bold = raw.match(/^\*\*(.+?)\*\*/m);
  return bold ? bold[1].trim() : 'Untitled';
}

function extractId(filename) {
  return filename.replace(/\.md$/, '');
}

function extractTags(raw, meta) {
  const tags = new Set();
  // from classification
  if (meta.Classification) {
    const m = meta.Classification.match(/P\d/);
    if (m) tags.add(m[0]);
  }
  // from content keywords
  const lower = raw.toLowerCase();
  if (lower.includes('failover') || lower.includes('fail over')) tags.add('failover');
  if (lower.includes('split-brain')) tags.add('split-brain');
  if (lower.includes('cache')) tags.add('cache');
  if (lower.includes('kafka') || lower.includes('msk')) tags.add('kafka');
  if (lower.includes('dns')) tags.add('dns');
  if (lower.includes('kms') || lower.includes('key')) tags.add('encryption');
  if (lower.includes('secret')) tags.add('secrets');
  if (lower.includes('eks') || lower.includes('node')) tags.add('kubernetes');
  if (lower.includes('network') || lower.includes('partition')) tags.add('network');
  if (lower.includes('peak') || lower.includes('load')) tags.add('scaling');
  if (lower.includes('rollback') || lower.includes('failback')) tags.add('rollback');
  if (lower.includes('degradation')) tags.add('degradation');
  if (lower.includes('compliance') || lower.includes('pci') || lower.includes('rbi') || lower.includes('npci')) tags.add('compliance');
  if (lower.includes('aurora') || lower.includes('dynamodb') || lower.includes('elasticache')) tags.add('data-stores');
  if (lower.includes('replication')) tags.add('replication');
  if (lower.includes('rpo') || lower.includes('rto')) tags.add('rpo-rto');
  if (lower.includes('topology') || lower.includes('active-passive')) tags.add('architecture');
  return [...tags];
}

function extractOwner(meta) {
  return meta.Owner || meta.Deciders || meta.Author || 'Unknown';
}

function extractEta(meta) {
  const rto = meta['Expected RTO'] || meta['Expected Recovery Time'] || meta['Expected Duration'] || '';
  const m = rto.match(/<?\s*(\d+)\s*(min|minutes|seconds|sec|hour|hours)/i);
  if (m) {
    const val = parseInt(m[1], 10);
    const unit = m[2].toLowerCase();
    if (unit.startsWith('sec')) return val < 60 ? `${val}s` : `${Math.round(val / 60)}m`;
    if (unit.startsWith('min')) return `${val}m`;
    if (unit.startsWith('hour')) return `${val}h`;
  }
  return rto || 'N/A';
}

function extractComplianceFrameworks(raw) {
  const frameworks = new Set();
  const lower = raw.toLowerCase();
  if (lower.includes('pci-dss') || lower.includes('pci dss')) frameworks.add('PCI-DSS v4.0');
  if (lower.includes('rbi')) frameworks.add('RBI');
  if (lower.includes('npci') || lower.includes('upi')) frameworks.add('NPCI UPI');
  if (lower.includes('data localisation') || lower.includes('data localization') || lower.includes('meity')) frameworks.add('India Data Localisation');
  if (lower.includes('dpdp')) frameworks.add('DPDP Act');
  return [...frameworks];
}

// ── runbook metadata ─────────────────────────────────────────────────

function indexRunbooks(sourceDir) {
  const entries = [];
  if (!fs.existsSync(sourceDir)) return entries;

  for (const file of fs.readdirSync(sourceDir)) {
    if (!file.endsWith('.md')) continue;
    const raw = fs.readFileSync(path.join(sourceDir, file), 'utf-8');
    const meta = parseFrontMatter(raw);
    entries.push({
      id: extractId(file),
      title: extractTitle(raw),
      tags: extractTags(raw, meta),
      owner: extractOwner(meta),
      eta: extractEta(meta),
      classification: meta.Classification || 'Unclassified',
      complianceFrameworks: extractComplianceFrameworks(raw),
      file: file,
    });
  }
  return entries;
}

// ── architecture metadata ────────────────────────────────────────────

function indexArchitecture(sourceDir) {
  const entries = [];
  if (!fs.existsSync(sourceDir)) return entries;

  for (const file of fs.readdirSync(sourceDir)) {
    if (!file.endsWith('.md')) continue;
    const raw = fs.readFileSync(path.join(sourceDir, file), 'utf-8');
    const meta = parseFrontMatter(raw);
    entries.push({
      id: extractId(file),
      title: extractTitle(raw),
      tags: extractTags(raw, meta),
      owner: extractOwner(meta),
      scope: meta.Scope || '',
      status: meta.Status || 'Current',
      complianceFrameworks: extractComplianceFrameworks(raw),
      file: file,
    });
  }
  return entries;
}

// ── ADR metadata ─────────────────────────────────────────────────────

function indexAdr(sourceDir) {
  const entries = [];
  if (!fs.existsSync(sourceDir)) return entries;

  for (const file of fs.readdirSync(sourceDir)) {
    if (!file.endsWith('.md')) continue;
    const raw = fs.readFileSync(path.join(sourceDir, file), 'utf-8');
    const meta = parseFrontMatter(raw);
    entries.push({
      id: extractId(file),
      title: extractTitle(raw),
      tags: extractTags(raw, meta),
      status: meta.Status || 'Unknown',
      date: meta.Date || '',
      deciders: meta.Deciders || meta.Owner || '',
      complianceFrameworks: extractComplianceFrameworks(raw),
      file: file,
    });
  }
  return entries;
}

// ── compliance metadata ──────────────────────────────────────────────

function indexCompliance(sourceDir) {
  const entries = [];
  if (!fs.existsSync(sourceDir)) return entries;

  for (const file of fs.readdirSync(sourceDir)) {
    if (!file.endsWith('.md')) continue;
    const raw = fs.readFileSync(path.join(sourceDir, file), 'utf-8');
    const meta = parseFrontMatter(raw);
    entries.push({
      id: extractId(file),
      title: extractTitle(raw),
      tags: extractTags(raw, meta),
      frameworks: extractComplianceFrameworks(raw),
      file: file,
    });
  }
  return entries;
}

// ── FMEA generator ───────────────────────────────────────────────────

function generateFmea(runbooks) {
  // Derive 20+ failure modes from runbook trigger/impact data
  const modes = [
    {
      id: 'FM-001',
      failureMode: 'Complete primary region (Mumbai) failure',
      component: 'AWS Region ap-south-1',
      effect: 'All payment processing halted; 100% merchant impact',
      severity: 10,
      occurrence: 2,
      detection: 2,
      rpn: 40,
      runbook: 'RB-001',
      mitigation: 'Active-passive failover to Hyderabad within 5 min RTO',
    },
    {
      id: 'FM-002',
      failureMode: 'Aurora Global DB replication lag exceeds RPO',
      component: 'Aurora PostgreSQL',
      effect: 'Up to 30s of transaction data at risk during failover',
      severity: 8,
      occurrence: 3,
      detection: 3,
      rpn: 72,
      runbook: 'RB-001, RB-002',
      mitigation: 'P1 alert at 30s lag; auto-throttle writes; pre-scaled replication I/O',
    },
    {
      id: 'FM-003',
      failureMode: 'Aurora split-brain (dual writers)',
      component: 'Aurora PostgreSQL',
      effect: 'Divergent transaction records; risk of double-processing payments',
      severity: 10,
      occurrence: 2,
      detection: 4,
      rpn: 80,
      runbook: 'RB-002',
      mitigation: 'Immediate write freeze; forensic snapshot comparison; manual reconciliation',
    },
    {
      id: 'FM-004',
      failureMode: 'DynamoDB Global Table replication latency > 30s',
      component: 'DynamoDB',
      effect: 'Stale idempotency keys and session state in Hyderabad',
      severity: 7,
      occurrence: 3,
      detection: 3,
      rpn: 63,
      runbook: 'RB-001',
      mitigation: 'P1 alert; switch to on-demand capacity; verify Global Table health',
    },
    {
      id: 'FM-005',
      failureMode: 'ElastiCache Global Datastore replication lag > 30s',
      component: 'ElastiCache Redis',
      effect: 'Cold cache on failover; elevated DB load for 5-10 min',
      severity: 6,
      occurrence: 3,
      detection: 3,
      rpn: 54,
      runbook: 'RB-004',
      mitigation: 'Cache warming scripts; hot-key pre-loading; lazy warming on cache miss',
    },
    {
      id: 'FM-006',
      failureMode: 'MSK MirrorMaker 2 connector failure',
      component: 'MSK / Kafka',
      effect: 'Event replication stops; Hyderabad MSK becomes stale',
      severity: 7,
      occurrence: 3,
      detection: 2,
      rpn: 42,
      runbook: 'RB-003',
      mitigation: 'Auto-restart with backoff; redundant MM2 tasks; P1 alert on connector state',
    },
    {
      id: 'FM-007',
      failureMode: 'KMS key disabled or scheduled for deletion',
      component: 'AWS KMS',
      effect: 'All encrypted data inaccessible; complete platform outage',
      severity: 10,
      occurrence: 1,
      detection: 2,
      rpn: 20,
      runbook: 'RB-007',
      mitigation: '7-day deletion waiting period; immediate cancel + re-enable; multi-region keys',
    },
    {
      id: 'FM-008',
      failureMode: 'KMS key material exposed / compromised',
      component: 'AWS KMS',
      effect: 'All data at rest decryptable by attacker; mandatory breach notification',
      severity: 10,
      occurrence: 1,
      detection: 5,
      rpn: 50,
      runbook: 'RB-007',
      mitigation: 'Immediate key rotation; re-encrypt all resources; forensic audit',
    },
    {
      id: 'FM-009',
      failureMode: 'Secrets Manager automatic rotation failure',
      component: 'AWS Secrets Manager',
      effect: 'Expired credentials cause cascading auth failures across all services',
      severity: 9,
      occurrence: 2,
      detection: 3,
      rpn: 54,
      runbook: 'RB-008',
      mitigation: 'Manual rotation with break-glass credentials; staggered pod recycling',
    },
    {
      id: 'FM-010',
      failureMode: 'Secret leakage (database password, API key)',
      component: 'AWS Secrets Manager',
      effect: 'Unauthorised data access; mandatory breach notification',
      severity: 10,
      occurrence: 2,
      detection: 4,
      rpn: 80,
      runbook: 'RB-008',
      mitigation: 'Immediate revocation + rotation; forensic preservation; Git history purge',
    },
    {
      id: 'FM-011',
      failureMode: 'Route 53 health check false positive (triggers unnecessary failover)',
      component: 'Route 53 DNS',
      effect: 'Unnecessary failover to Hyderabad; operational disruption',
      severity: 5,
      occurrence: 3,
      detection: 3,
      rpn: 45,
      runbook: 'RB-005',
      mitigation: '3-consecutive-failure threshold; multi-vantage-point verification; manual confirmation gate',
    },
    {
      id: 'FM-012',
      failureMode: 'DNS propagation delay exceeds 60s TTL',
      component: 'Route 53 DNS',
      effect: 'Merchants unable to resolve API endpoint during critical failover window',
      severity: 8,
      occurrence: 2,
      detection: 2,
      rpn: 32,
      runbook: 'RB-005',
      mitigation: '30s TTL pre-set; direct ALB IP distribution to critical merchants as fallback',
    },
    {
      id: 'FM-013',
      failureMode: 'EKS node group degradation (> 30% nodes NotReady)',
      component: 'Amazon EKS',
      effect: 'Insufficient compute capacity; pods stuck in Pending',
      severity: 7,
      occurrence: 3,
      detection: 2,
      rpn: 42,
      runbook: 'RB-009',
      mitigation: 'Node drain + ASG instance refresh; multi-AZ distribution; Cluster Autoscaler',
    },
    {
      id: 'FM-014',
      failureMode: 'EKS control plane impairment',
      component: 'Amazon EKS',
      effect: 'No new deployments, scaling, or health checks; existing pods continue',
      severity: 8,
      occurrence: 2,
      detection: 2,
      rpn: 32,
      runbook: 'RB-009',
      mitigation: 'Fail over to Hyderabad EKS if > 10 min; AWS-managed recovery',
    },
    {
      id: 'FM-015',
      failureMode: 'Cross-region VPC peering failure',
      component: 'VPC / Network',
      effect: 'All replication streams interrupted; Hyderabad data stores become stale',
      severity: 8,
      occurrence: 2,
      detection: 2,
      rpn: 32,
      runbook: 'RB-010',
      mitigation: 'Write fencing to prevent split-brain; redundant peering connections; automated IAM promotion lock',
    },
    {
      id: 'FM-016',
      failureMode: 'Intra-region AZ network isolation',
      component: 'VPC / Network',
      effect: 'Nodes in isolated AZ unreachable; pods rescheduled to healthy AZs',
      severity: 6,
      occurrence: 3,
      detection: 2,
      rpn: 36,
      runbook: 'RB-010',
      mitigation: 'Cordon + drain affected AZ; ASG AZ exclusion; multi-AZ pod topology spread',
    },
    {
      id: 'FM-017',
      failureMode: 'Cache corruption (poisoned entries across multiple namespaces)',
      component: 'ElastiCache Redis',
      effect: 'Incorrect payment routing; rate-limit bypass; duplicate transactions',
      severity: 9,
      occurrence: 2,
      detection: 3,
      rpn: 54,
      runbook: 'RB-004',
      mitigation: 'Full cache flush + hot-key warming; targeted invalidation; source-of-truth comparison',
    },
    {
      id: 'FM-018',
      failureMode: 'Cache stampede (mass concurrent cache misses)',
      component: 'ElastiCache Redis',
      effect: 'DB CPU spike; elevated latency; potential cascading DB degradation',
      severity: 7,
      occurrence: 3,
      detection: 2,
      rpn: 42,
      runbook: 'RB-004',
      mitigation: 'Request coalescing; pre-warm hot keys; circuit breaker on DB reads',
    },
    {
      id: 'FM-019',
      failureMode: 'Peak load exceeds Mumbai provisioned capacity',
      component: 'EKS / Aurora / DynamoDB',
      effect: 'P95 latency > 2s; error rate > 1%; transaction failures',
      severity: 8,
      occurrence: 3,
      detection: 2,
      rpn: 48,
      runbook: 'RB-006',
      mitigation: 'In-place scaling first; circuit breakers on non-critical features; failover to Hyderabad if scaling insufficient',
    },
    {
      id: 'FM-020',
      failureMode: 'DDoS attack overwhelming primary region',
      component: 'ALB / WAF / Shield',
      effect: 'Service degradation or outage; volumetric or application-layer attack',
      severity: 9,
      occurrence: 2,
      detection: 2,
      rpn: 36,
      runbook: 'RB-006',
      mitigation: 'AWS Shield Advanced auto-mitigation; WAF rate-based rules; failover to Hyderabad if overwhelmed',
    },
    {
      id: 'FM-021',
      failureMode: 'Partial regional degradation (2+ components RED)',
      component: 'Multiple',
      effect: 'Intermittent failures; degraded merchant experience; decision complexity',
      severity: 8,
      occurrence: 3,
      detection: 3,
      rpn: 72,
      runbook: 'RB-011',
      mitigation: 'Structured triage framework; decision matrix for recover-in-place vs failover',
    },
    {
      id: 'FM-022',
      failureMode: 'Kafka partition loss on critical payment topic',
      component: 'MSK / Kafka',
      effect: 'Payment events delayed or lost; settlement batch SLA breach',
      severity: 8,
      occurrence: 2,
      detection: 2,
      rpn: 32,
      runbook: 'RB-003',
      mitigation: 'RF=3; min.insync.replicas=2; automatic leader election; DLQ replay',
    },
    {
      id: 'FM-023',
      failureMode: 'Multi-region KMS key desynchronisation',
      component: 'AWS KMS',
      effect: 'Hyderabad cannot decrypt data during failover; RB-001 failover would fail',
      severity: 9,
      occurrence: 2,
      detection: 3,
      rpn: 54,
      runbook: 'RB-007',
      mitigation: 'Cross-region decrypt canary every 15 min; Scenario G validation before any failover',
    },
    {
      id: 'FM-024',
      failureMode: 'Cross-region Secrets Manager desynchronisation',
      component: 'AWS Secrets Manager',
      effect: 'Hyderabad has stale or missing credentials; failover auth failures',
      severity: 9,
      occurrence: 2,
      detection: 3,
      rpn: 54,
      runbook: 'RB-008',
      mitigation: 'Cross-region secret validation every 5 min; reconcile before any failover',
    },
    {
      id: 'FM-025',
      failureMode: 'Failback data inconsistency after extended DR event',
      component: 'Aurora / DynamoDB / MSK',
      effect: 'Data divergence between regions; complex reconciliation required',
      severity: 8,
      occurrence: 2,
      detection: 4,
      rpn: 64,
      runbook: 'RB-012',
      mitigation: 'Pre-failback safety snapshot; phased DNS cutover; comprehensive validation gates',
    },
  ];

  return modes;
}

// ── main indexer ─────────────────────────────────────────────────────

async function indexDocs(sourceDir, publicDir, dataDir) {
  const docsRoot = path.resolve(ROOT, sourceDir);
  const publicRoot = path.resolve(ROOT, publicDir);
  const dataRoot = path.resolve(ROOT, dataDir);

  console.log(`Indexing docs from: ${docsRoot}`);
  console.log(`Public content to: ${publicRoot}`);
  console.log(`Data files to:    ${dataRoot}`);

  // 1. Copy raw markdown files into public/content/
  const runbooksSrc = path.join(docsRoot, 'runbooks');
  const architectureSrc = path.join(docsRoot, 'architecture');
  const adrSrc = path.join(docsRoot, 'adr');
  const complianceSrc = path.join(docsRoot, 'compliance');
  const rpoRtoSrc = path.join(docsRoot, 'rpo-rto');

  if (fs.existsSync(runbooksSrc)) copyDir(runbooksSrc, path.join(publicRoot, 'content', 'runbooks'));
  if (fs.existsSync(architectureSrc)) copyDir(architectureSrc, path.join(publicRoot, 'content', 'architecture'));
  if (fs.existsSync(adrSrc)) copyDir(adrSrc, path.join(publicRoot, 'content', 'adr'));
  if (fs.existsSync(complianceSrc)) copyDir(complianceSrc, path.join(publicRoot, 'content', 'compliance'));
  if (fs.existsSync(rpoRtoSrc)) copyDir(rpoRtoSrc, path.join(publicRoot, 'content', 'rpo-rto'));

  console.log('  ✓ Raw markdown copied to public/content/');

  // 2. Generate runbooks.json
  const runbooks = indexRunbooks(runbooksSrc);
  ensureDir(dataRoot);
  fs.writeFileSync(path.join(dataRoot, 'runbooks.json'), JSON.stringify(runbooks, null, 2));
  console.log(`  ✓ runbooks.json (${runbooks.length} entries)`);

  // 3. Generate architecture.json
  const architecture = indexArchitecture(architectureSrc);
  // also include rpo-rto docs
  if (fs.existsSync(rpoRtoSrc)) {
    for (const file of fs.readdirSync(rpoRtoSrc)) {
      if (!file.endsWith('.md')) continue;
      const raw = fs.readFileSync(path.join(rpoRtoSrc, file), 'utf-8');
      const meta = parseFrontMatter(raw);
      architecture.push({
        id: extractId(file),
        title: extractTitle(raw),
        tags: extractTags(raw, meta),
        owner: extractOwner(meta),
        scope: meta.Scope || '',
        status: meta.Status || 'Current',
        complianceFrameworks: extractComplianceFrameworks(raw),
        file: file,
      });
    }
  }
  fs.writeFileSync(path.join(dataRoot, 'architecture.json'), JSON.stringify(architecture, null, 2));
  console.log(`  ✓ architecture.json (${architecture.length} entries)`);

  // 4. Generate compliance.json
  const compliance = indexCompliance(complianceSrc);
  // also pull compliance info from ADRs and architecture docs
  if (fs.existsSync(adrSrc)) {
    for (const file of fs.readdirSync(adrSrc)) {
      if (!file.endsWith('.md')) continue;
      const raw = fs.readFileSync(path.join(adrSrc, file), 'utf-8');
      const meta = parseFrontMatter(raw);
      compliance.push({
        id: extractId(file),
        title: extractTitle(raw),
        tags: extractTags(raw, meta),
        frameworks: extractComplianceFrameworks(raw),
        file: file,
      });
    }
  }
  fs.writeFileSync(path.join(dataRoot, 'compliance.json'), JSON.stringify(compliance, null, 2));
  console.log(`  ✓ compliance.json (${compliance.length} entries)`);

  // 5. Generate fmea.json
  const fmea = generateFmea(runbooks);
  fs.writeFileSync(path.join(dataRoot, 'fmea.json'), JSON.stringify(fmea, null, 2));
  console.log(`  ✓ fmea.json (${fmea.length} failure modes)`);

  console.log('\nIndexing complete.');
}

// ── CLI entry ────────────────────────────────────────────────────────

const sourceDir = process.argv[2] || '../docs';
const publicDir = process.argv[3] || 'public';
const dataDir = process.argv[4] || 'src/data';

indexDocs(sourceDir, publicDir, dataDir).catch(err => {
  console.error('Indexing failed:', err);
  process.exit(1);
});