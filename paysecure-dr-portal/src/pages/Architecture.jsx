import {
  Layers,
  MapPin,
  Database,
  Cpu,
  Activity,
  Container,
  ArrowRight,
  ShieldCheck,
  Clock,
  Target,
  Server,
  Globe,
  Network,
  Lock,
  BookOpen,
} from 'lucide-react';
import architecture from '../data/architecture.json';

const regions = [
  {
    name: 'Mumbai',
    code: 'ap-south-1',
    role: 'Primary',
    description: 'Handles 100% of live production traffic. All write operations originate here.',
    color: 'border-brand-500 bg-brand-50 dark:bg-brand-900/30',
    iconBg: 'bg-brand-100 text-brand-600 dark:text-brand-400',
  },
  {
    name: 'Hyderabad',
    code: 'ap-south-2',
    role: 'Secondary (Warm Standby)',
    description: 'Maintains warm standby. Data continuously replicated. Scales out on failover.',
    color: 'border-emerald-500 bg-emerald-50 dark:bg-emerald-900/30',
    iconBg: 'bg-emerald-100 text-emerald-600 dark:text-emerald-400',
  },
  {
    name: 'Pune',
    code: 'ap-south-3',
    role: 'Tertiary (Evaluation)',
    description: 'Reserved for future three-region resilience and capacity expansion.',
    color: 'border-purple-500 bg-purple-50 dark:bg-purple-900/30',
    iconBg: 'bg-purple-100 text-purple-600 dark:text-purple-400',
  },
];

const components = [
  {
    name: 'Aurora Global DB',
    icon: Database,
    description: 'PostgreSQL with cross-region replication. Transaction ledger, settlement records, merchant onboarding.',
    rpo: '< 1 min',
    replication: 'Aurora Global Database',
    lagMetric: 'AuroraGlobalDBReplicationLag',
    doc: 'database-replication-aurora',
  },
  {
    name: 'DynamoDB',
    icon: Server,
    description: 'Global Tables for session state, idempotency keys, rate-limit counters, configuration.',
    rpo: '< 1 sec',
    replication: 'Global Tables',
    lagMetric: 'ReplicationLatency',
    doc: 'database-replication-dynamodb',
  },
  {
    name: 'ElastiCache',
    icon: Cpu,
    description: 'Redis Global Datastore for cached payment metadata, auth tokens, merchant config.',
    rpo: '< 1 sec',
    replication: 'Global Datastore',
    lagMetric: 'GlobalDatastoreReplicationLag',
    doc: 'database-replication-elasticache',
  },
  {
    name: 'MSK (Kafka)',
    icon: Activity,
    description: 'Multi-region event streaming with MirrorMaker 2 for payment events and audit logs.',
    rpo: '< 30 sec',
    replication: 'MirrorMaker 2',
    lagMetric: 'Consumer lag (custom)',
    doc: 'kafka-msk-replication',
  },
  {
    name: 'EKS',
    icon: Container,
    description: 'Kubernetes clusters in both regions. Pre-deployed with baseline capacity; scales on failover.',
    rpo: 'N/A',
    replication: 'Pre-deployed warm standby',
    lagMetric: 'N/A',
    doc: null,
  },
];

const dataFlows = [
  {
    from: 'Mumbai (Primary)',
    to: 'Hyderabad (Secondary)',
    items: [
      { label: 'Aurora PostgreSQL', detail: 'Async replication via Global DB; typical lag < 500ms' },
      { label: 'DynamoDB', detail: 'Multi-master Global Tables; typical lag < 45ms' },
      { label: 'ElastiCache Redis', detail: 'Async command-stream replication; typical lag < 500ms' },
      { label: 'MSK / Kafka', detail: 'MirrorMaker 2; typical lag < 210ms' },
      { label: 'Secrets Manager', detail: 'Cross-region secret replication; validated every 5 min' },
      { label: 'KMS', detail: 'Multi-Region keys; cross-region decrypt canary every 15 min' },
    ],
  },
  {
    from: 'Hyderabad (Secondary)',
    to: 'Mumbai (Primary)',
    items: [
      { label: 'Health Checks', detail: 'Cross-region ICMP/TCP probes every 10s' },
      { label: 'CloudWatch Metrics', detail: 'Replication lag, service health reported to primary dashboards' },
      { label: 'Synthetic Canaries', detail: 'API health probes from Hyderabad to Mumbai ALB' },
    ],
  },
];

export default function Architecture() {
  return (
    <div className="p-6 space-y-6">
      {/* Header */}
      <div>
        <h1 className="text-2xl font-bold text-gray-900 dark:text-gray-100">Architecture</h1>
        <p className="text-sm text-gray-500 dark:text-gray-400 mt-1">
          Active-passive multi-region topology — ADR-001
        </p>
      </div>

      {/* Topology Overview */}
      <div className="bg-white dark:bg-gray-800 rounded-xl border border-gray-200 dark:border-gray-700 p-6 opacity-0 animate-fade-in">
        <div className="flex items-center gap-2 mb-4">
          <Layers className="w-5 h-5 text-brand-600 dark:text-brand-400" />
          <h2 className="text-lg font-semibold text-gray-900 dark:text-gray-100">Topology: Active-Passive</h2>
        </div>
        <p className="text-sm text-gray-600 dark:text-gray-400 mb-6">
          Mumbai handles 100% of production traffic. Hyderabad maintains a warm standby with continuous
          data replication. On primary region failure, DNS fails over to Hyderabad within the 5-minute RTO.
        </p>

        {/* Visual topology flow */}
        <div className="flex flex-col lg:flex-row items-center gap-4 p-6 bg-gray-50 dark:bg-gray-900 rounded-xl border border-gray-100 dark:border-gray-800">
          {/* Mumbai */}
          <div className="flex-1 w-full bg-white dark:bg-gray-800 rounded-lg border-2 border-brand-400 p-4 text-center">
            <div className="inline-flex items-center justify-center w-10 h-10 rounded-full bg-brand-100 text-brand-600 dark:text-brand-400 mb-2">
              <MapPin className="w-5 h-5" />
            </div>
            <h3 className="font-bold text-gray-900 dark:text-gray-100">Mumbai</h3>
            <p className="text-xs text-gray-500 dark:text-gray-400">ap-south-1</p>
            <span className="inline-block mt-2 px-2 py-0.5 text-xs font-semibold bg-brand-100 text-brand-700 dark:text-brand-400 rounded-full">
              PRIMARY
            </span>
            <p className="text-xs text-gray-500 dark:text-gray-400 mt-2">100% production traffic</p>
          </div>

          {/* Arrow + replication */}
          <div className="flex flex-col items-center gap-1 shrink-0">
            <ArrowRight className="w-6 h-6 text-gray-400 dark:text-gray-500" />
            <span className="text-xs font-medium text-gray-500 dark:text-gray-400">Replication</span>
            <div className="flex flex-wrap justify-center gap-1 max-w-[200px]">
              {['Aurora', 'DynamoDB', 'ElastiCache', 'MSK', 'Secrets', 'KMS'].map((s) => (
                <span key={s} className="px-1.5 py-0.5 text-[10px] font-medium bg-gray-100 dark:bg-gray-800 text-gray-600 dark:text-gray-400 rounded">
                  {s}
                </span>
              ))}
            </div>
          </div>

          {/* Hyderabad */}
          <div className="flex-1 w-full bg-white dark:bg-gray-800 rounded-lg border-2 border-emerald-400 p-4 text-center">
            <div className="inline-flex items-center justify-center w-10 h-10 rounded-full bg-emerald-100 text-emerald-600 dark:text-emerald-400 mb-2">
              <MapPin className="w-5 h-5" />
            </div>
            <h3 className="font-bold text-gray-900 dark:text-gray-100">Hyderabad</h3>
            <p className="text-xs text-gray-500 dark:text-gray-400">ap-south-2</p>
            <span className="inline-block mt-2 px-2 py-0.5 text-xs font-semibold bg-emerald-100 text-emerald-700 rounded-full">
              SECONDARY
            </span>
            <p className="text-xs text-gray-500 dark:text-gray-400 mt-2">Warm standby</p>
          </div>
        </div>

        {/* RPO/RTO bar */}
        <div className="grid grid-cols-2 gap-4 mt-6">
          <div className="flex items-center gap-3 p-4 bg-amber-50 dark:bg-amber-900/30 rounded-lg border border-amber-100">
            <Target className="w-5 h-5 text-amber-600 dark:text-amber-400" />
            <div>
              <p className="text-sm font-semibold text-gray-900 dark:text-gray-100">RPO &lt; 1 minute</p>
              <p className="text-xs text-gray-500 dark:text-gray-400">Maximum acceptable data loss</p>
            </div>
          </div>
          <div className="flex items-center gap-3 p-4 bg-emerald-50 dark:bg-emerald-900/30 rounded-lg border border-emerald-100">
            <Clock className="w-5 h-5 text-emerald-600 dark:text-emerald-400" />
            <div>
              <p className="text-sm font-semibold text-gray-900 dark:text-gray-100">RTO &lt; 5 minutes</p>
              <p className="text-xs text-gray-500 dark:text-gray-400">Time to restore service</p>
            </div>
          </div>
        </div>
      </div>

      {/* Region Cards */}
      <div>
        <h2 className="text-lg font-semibold text-gray-900 dark:text-gray-100 mb-4">Regions</h2>
        <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
          {regions.map((region, i) => (
            <div
              key={region.name}
              className={`rounded-xl border-2 ${region.color} p-5 opacity-0 animate-fade-in`}
              style={{ animationDelay: `${i * 60}ms` }}
            >
              <div className="flex items-center gap-3 mb-3">
                <div className={`p-2 rounded-lg ${region.iconBg}`}>
                  <MapPin className="w-5 h-5" />
                </div>
                <div>
                  <h3 className="font-bold text-gray-900 dark:text-gray-100">{region.name}</h3>
                  <p className="text-xs text-gray-500 dark:text-gray-400 font-mono">{region.code}</p>
                </div>
              </div>
              <span className="inline-block px-2 py-0.5 text-xs font-semibold bg-white dark:bg-gray-800 rounded-full border border-gray-200 dark:border-gray-700 mb-2">
                {region.role}
              </span>
              <p className="text-sm text-gray-600 dark:text-gray-400">{region.description}</p>
            </div>
          ))}
        </div>
      </div>

      {/* Component List */}
      <div className="bg-white dark:bg-gray-800 rounded-xl border border-gray-200 dark:border-gray-700 p-6">
        <h2 className="text-lg font-semibold text-gray-900 dark:text-gray-100 mb-4">Components</h2>
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
          {components.map((comp, i) => (
            <div
              key={comp.name}
              className="rounded-lg border border-gray-100 dark:border-gray-800 p-4 hover:border-gray-200 dark:hover:border-gray-700 transition-colors opacity-0 animate-fade-in"
              style={{ animationDelay: `${i * 60}ms` }}
            >
              <div className="flex items-start gap-3">
                <div className="p-2 rounded-lg bg-gray-100 dark:bg-gray-800 text-gray-600 dark:text-gray-400 shrink-0">
                  <comp.icon className="w-5 h-5" />
                </div>
                <div className="min-w-0 flex-1">
                  <h3 className="font-semibold text-gray-900 dark:text-gray-100">{comp.name}</h3>
                  <p className="text-sm text-gray-500 dark:text-gray-400 mt-1">{comp.description}</p>
                  <div className="flex flex-wrap items-center gap-3 mt-3 text-xs">
                    <span className="inline-flex items-center gap-1 text-gray-500 dark:text-gray-400">
                      <Target className="w-3 h-3" />
                      RPO: <span className="font-medium text-gray-700 dark:text-gray-300">{comp.rpo}</span>
                    </span>
                    <span className="inline-flex items-center gap-1 text-gray-500 dark:text-gray-400">
                      <Activity className="w-3 h-3" />
                      <span className="font-medium text-gray-700 dark:text-gray-300">{comp.replication}</span>
                    </span>
                  </div>
                  <p className="text-xs text-gray-400 dark:text-gray-500 mt-1 font-mono">
                    Metric: {comp.lagMetric}
                  </p>
                </div>
              </div>
            </div>
          ))}
        </div>
      </div>

      {/* Data Flows */}
      <div className="bg-white dark:bg-gray-800 rounded-xl border border-gray-200 dark:border-gray-700 p-6">
        <h2 className="text-lg font-semibold text-gray-900 dark:text-gray-100 mb-4">Data Flows</h2>
        <div className="space-y-6">
          {dataFlows.map((flow, i) => (
            <div key={flow.from + flow.to} className="opacity-0 animate-fade-in" style={{ animationDelay: `${i * 60}ms` }}>
              <div className="flex items-center gap-2 mb-3">
                <span className="text-sm font-semibold text-gray-900 dark:text-gray-100">{flow.from}</span>
                <ArrowRight className="w-4 h-4 text-gray-400 dark:text-gray-500" />
                <span className="text-sm font-semibold text-gray-900 dark:text-gray-100">{flow.to}</span>
              </div>
              <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
                {flow.items.map((item) => (
                  <div
                    key={item.label}
                    className="rounded-lg border border-gray-100 dark:border-gray-800 p-3 hover:border-gray-200 dark:hover:border-gray-700 transition-colors"
                  >
                    <p className="text-sm font-medium text-gray-900 dark:text-gray-100">{item.label}</p>
                    <p className="text-xs text-gray-500 dark:text-gray-400 mt-1">{item.detail}</p>
                  </div>
                ))}
              </div>
            </div>
          ))}
        </div>
      </div>

      {/* Architecture Documents */}
      <div className="bg-white dark:bg-gray-800 rounded-xl border border-gray-200 dark:border-gray-700 p-6">
        <h2 className="text-lg font-semibold text-gray-900 dark:text-gray-100 mb-4">Architecture Documents</h2>
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
          {architecture.map((doc, i) => (
            <a
              key={doc.id}
              href={`/content/architecture/${doc.file}`}
              target="_blank"
              rel="noopener noreferrer"
              className="flex items-start gap-3 p-4 rounded-lg border border-gray-100 dark:border-gray-800 hover:border-brand-200 dark:hover:border-brand-800 hover:bg-brand-50 dark:hover:bg-brand-900/30 transition-colors group opacity-0 animate-fade-in"
              style={{ animationDelay: `${i * 50}ms` }}
            >
              <BookOpen className="w-5 h-5 text-gray-400 dark:text-gray-500 group-hover:text-brand-500 shrink-0 mt-0.5" />
              <div className="min-w-0">
                <p className="text-sm font-medium text-gray-900 dark:text-gray-100 group-hover:text-brand-700 line-clamp-2">
                  {doc.title}
                </p>
                <div className="flex items-center gap-2 mt-1.5">
                  <span className="text-xs text-gray-500 dark:text-gray-400">{doc.owner}</span>
                  <span className="text-xs px-1.5 py-0.5 rounded bg-gray-100 dark:bg-gray-800 text-gray-600 dark:text-gray-400 font-medium">
                    {doc.status}
                  </span>
                </div>
              </div>
            </a>
          ))}
        </div>
      </div>
    </div>
  );
}