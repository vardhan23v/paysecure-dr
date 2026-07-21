import { useState, useMemo } from 'react';
import {
  ShieldCheck,
  Search,
  Filter,
  CheckCircle2,
  AlertTriangle,
  XCircle,
  BookOpen,
  ChevronDown,
  ChevronUp,
} from 'lucide-react';
import runbooks from '../data/runbooks.json';

const frameworks = [
  {
    name: 'RBI',
    fullName: 'Reserve Bank of India',
    description: 'Guidelines on IT governance, risk management, and business continuity for regulated financial entities.',
    color: 'border-blue-500 bg-blue-50 dark:bg-blue-900/30',
    iconBg: 'bg-blue-100 text-blue-600 dark:text-blue-400',
    controls: 8,
    satisfied: 8,
    partial: 0,
    gap: 0,
  },
  {
    name: 'PCI-DSS v4.0',
    fullName: 'Payment Card Industry Data Security Standard',
    description: 'Requirements for securing cardholder data, access control, encryption, and continuous monitoring.',
    color: 'border-emerald-500 bg-emerald-50 dark:bg-emerald-900/30',
    iconBg: 'bg-emerald-100 text-emerald-600 dark:text-emerald-400',
    controls: 10,
    satisfied: 10,
    partial: 0,
    gap: 0,
  },
  {
    name: 'NPCI UPI',
    fullName: 'National Payments Corporation of India — UPI',
    description: 'Technical and operational requirements for UPI payment systems, including uptime and data handling.',
    color: 'border-purple-500 bg-purple-50 dark:bg-purple-900/30',
    iconBg: 'bg-purple-100 text-purple-600 dark:text-purple-400',
    controls: 6,
    satisfied: 6,
    partial: 0,
    gap: 0,
  },
  {
    name: 'India Data Localisation',
    fullName: 'Data Localisation & Residency',
    description: 'Requirements that payment data be stored and processed exclusively within India.',
    color: 'border-amber-500 bg-amber-50 dark:bg-amber-900/30',
    iconBg: 'bg-amber-100 text-amber-600 dark:text-amber-400',
    controls: 5,
    satisfied: 5,
    partial: 0,
    gap: 0,
  },
];

interface Control {
  id: string;
  control: string;
  description: string;
  rbi: string;
  pci: string;
  npci: string;
  localisation: string;
  runbooks: string[];
  evidence: string;
}

const controls: Control[] = [
  {
    id: 'CTL-001',
    control: 'Data-at-rest encryption',
    description: 'All payment data encrypted at rest using AES-256 with AWS KMS CMKs',
    rbi: 'satisfied',
    pci: 'satisfied',
    npci: 'satisfied',
    localisation: 'satisfied',
    runbooks: ['RB-007'],
    evidence: 'KMS multi-region keys; CMK audit log enabled',
  },
  {
    id: 'CTL-002',
    control: 'Data-in-transit encryption',
    description: 'TLS 1.2+ for all inter-service and cross-region communication',
    rbi: 'satisfied',
    pci: 'satisfied',
    npci: 'satisfied',
    localisation: 'satisfied',
    runbooks: ['RB-007', 'RB-008'],
    evidence: 'ACM certificates; mTLS between services; VPC peering encryption',
  },
  {
    id: 'CTL-003',
    control: 'Access control & least privilege',
    description: 'IAM roles with least-privilege policies; MFA for all human access',
    rbi: 'satisfied',
    pci: 'satisfied',
    npci: 'satisfied',
    localisation: 'satisfied',
    runbooks: ['RB-008'],
    evidence: 'IAM Access Analyzer; quarterly access reviews; break-glass procedure',
  },
  {
    id: 'CTL-004',
    control: 'Audit logging & monitoring',
    description: 'All API calls, data access, and configuration changes logged to CloudTrail',
    rbi: 'satisfied',
    pci: 'satisfied',
    npci: 'satisfied',
    localisation: 'satisfied',
    runbooks: [],
    evidence: 'CloudTrail multi-region trail; CloudWatch Logs; 90-day retention',
  },
  {
    id: 'CTL-005',
    control: 'Secrets management & rotation',
    description: 'All credentials stored in AWS Secrets Manager with automatic rotation',
    rbi: 'satisfied',
    pci: 'satisfied',
    npci: 'satisfied',
    localisation: 'satisfied',
    runbooks: ['RB-008'],
    evidence: 'Secrets Manager rotation configured; cross-region replication verified',
  },
  {
    id: 'CTL-006',
    control: 'Business continuity & DR',
    description: 'Active-passive multi-region DR with RPO < 1 min and RTO < 5 min',
    rbi: 'satisfied',
    pci: 'satisfied',
    npci: 'satisfied',
    localisation: 'satisfied',
    runbooks: ['RB-001', 'RB-005', 'RB-012'],
    evidence: '12 production-ready runbooks; quarterly DR drills; ADR-001',
  },
  {
    id: 'CTL-007',
    control: 'Vulnerability management',
    description: 'Continuous vulnerability scanning; patch management within SLA windows',
    rbi: 'satisfied',
    pci: 'satisfied',
    npci: 'satisfied',
    localisation: 'n/a',
    runbooks: [],
    evidence: 'Amazon Inspector; ECR image scanning; 30-day patch SLA',
  },
  {
    id: 'CTL-008',
    control: 'Network segmentation',
    description: 'VPC isolation; security groups with least-privilege rules; WAF protection',
    rbi: 'satisfied',
    pci: 'satisfied',
    npci: 'satisfied',
    localisation: 'satisfied',
    runbooks: ['RB-010'],
    evidence: 'Private subnets; NAT gateways; AWS WAF rate-based rules',
  },
  {
    id: 'CTL-009',
    control: 'Key management & HSM',
    description: 'KMS CMKs with automatic rotation; key deletion protection',
    rbi: 'satisfied',
    pci: 'satisfied',
    npci: 'satisfied',
    localisation: 'satisfied',
    runbooks: ['RB-007'],
    evidence: 'Multi-region KMS keys; 7-day deletion waiting period; CloudHSM option',
  },
  {
    id: 'CTL-010',
    control: 'Incident response',
    description: 'Defined incident response plan with escalation matrix and communication templates',
    rbi: 'satisfied',
    pci: 'satisfied',
    npci: 'satisfied',
    localisation: 'n/a',
    runbooks: ['RB-001', 'RB-011'],
    evidence: 'PagerDuty integration; incident commander rotation; post-mortem process',
  },
  {
    id: 'CTL-011',
    control: 'Data residency — payment data',
    description: 'All payment transaction data stored exclusively in India regions',
    rbi: 'satisfied',
    pci: 'n/a',
    npci: 'satisfied',
    localisation: 'satisfied',
    runbooks: [],
    evidence: 'Mumbai, Hyderabad, Pune regions only; SCP enforcement',
  },
  {
    id: 'CTL-012',
    control: 'Data residency — PII',
    description: 'All personally identifiable information stored and processed within India',
    rbi: 'satisfied',
    pci: 'satisfied',
    npci: 'satisfied',
    localisation: 'satisfied',
    runbooks: [],
    evidence: 'Data classification tags; DPO attestation; no cross-border PII transfer',
  },
  {
    id: 'CTL-013',
    control: 'Anonymisation of analytics data',
    description: 'Aggregated transaction volumes and trend data irreversibly anonymised before analytics',
    rbi: 'satisfied',
    pci: 'n/a',
    npci: 'n/a',
    localisation: 'satisfied',
    runbooks: [],
    evidence: 'DPO verification of anonymisation; no residency constraint post-anonymisation',
  },
  {
    id: 'CTL-014',
    control: 'UPI uptime SLA',
    description: '99.95% uptime for UPI payment processing across all regions',
    rbi: 'n/a',
    pci: 'n/a',
    npci: 'satisfied',
    localisation: 'n/a',
    runbooks: ['RB-001', 'RB-006'],
    evidence: 'Active-passive DR; auto-scaling; synthetic canary monitoring',
  },
  {
    id: 'CTL-015',
    control: 'Replication integrity monitoring',
    description: 'Continuous monitoring of cross-region replication lag with P1 alerting',
    rbi: 'satisfied',
    pci: 'satisfied',
    npci: 'satisfied',
    localisation: 'satisfied',
    runbooks: ['RB-001', 'RB-002', 'RB-003', 'RB-004'],
    evidence: 'CloudWatch alarms; replication lag dashboards; auto-throttle on threshold breach',
  },
  {
    id: 'CTL-016',
    control: 'Secure software development',
    description: 'SAST/DAST in CI/CD; dependency scanning; code review requirements',
    rbi: 'satisfied',
    pci: 'satisfied',
    npci: 'n/a',
    localisation: 'n/a',
    runbooks: [],
    evidence: 'GitHub Advanced Security; Snyk; mandatory PR reviews',
  },
];

const frameworkKeys = [
  { key: 'rbi' as const, label: 'RBI', short: 'RBI' },
  { key: 'pci' as const, label: 'PCI-DSS v4.0', short: 'PCI' },
  { key: 'npci' as const, label: 'NPCI UPI', short: 'NPCI' },
  { key: 'localisation' as const, label: 'India Data Localisation', short: 'LOC' },
];

function StatusIcon({ status }: { status: string }) {
  if (status === 'satisfied') {
    return (
      <span className="inline-flex items-center gap-1 text-emerald-600 dark:text-emerald-400" title="Satisfied">
        <CheckCircle2 className="w-4 h-4" />
      </span>
    );
  }
  if (status === 'partial') {
    return (
      <span className="inline-flex items-center gap-1 text-amber-500" title="Partially satisfied">
        <AlertTriangle className="w-4 h-4" />
      </span>
    );
  }
  if (status === 'gap') {
    return (
      <span className="inline-flex items-center gap-1 text-red-500" title="Gap — not addressed">
        <XCircle className="w-4 h-4" />
      </span>
    );
  }
  return <span className="text-xs text-gray-300 dark:text-gray-600">—</span>;
}

export default function Compliance() {
  const [search, setSearch] = useState('');
  const [frameworkFilter, setFrameworkFilter] = useState('all');
  const [statusFilter, setStatusFilter] = useState('all');
  const [sortKey, setSortKey] = useState('id');
  const [sortDir, setSortDir] = useState('asc');

  const filtered = useMemo(() => {
    let result = [...controls];

    if (search) {
      const q = search.toLowerCase();
      result = result.filter(
        (c) =>
          c.id.toLowerCase().includes(q) ||
          c.control.toLowerCase().includes(q) ||
          c.description.toLowerCase().includes(q) ||
          c.evidence.toLowerCase().includes(q)
      );
    }

    if (frameworkFilter !== 'all') {
      result = result.filter((c) => {
        const status = c[frameworkFilter as keyof Control] as string;
        return statusFilter === 'all' ? status !== 'n/a' : status === statusFilter;
      });
    }

    if (statusFilter !== 'all' && frameworkFilter === 'all') {
      result = result.filter((c) =>
        frameworkKeys.some((fk) => c[fk.key] === statusFilter)
      );
    }

    result.sort((a, b) => {
      const aVal = a[sortKey as keyof Control] || '';
      const bVal = b[sortKey as keyof Control] || '';
      const cmp = String(aVal).localeCompare(String(bVal));
      return sortDir === 'asc' ? cmp : -cmp;
    });

    return result;
  }, [search, frameworkFilter, statusFilter, sortKey, sortDir]);

  const handleSort = (key: string) => {
    if (sortKey === key) {
      setSortDir((d) => (d === 'asc' ? 'desc' : 'asc'));
    } else {
      setSortKey(key);
      setSortDir('asc');
    }
  };

  const SortArrow = ({ col }: { col: string }) => {
    if (sortKey !== col) return null;
    return sortDir === 'asc' ? (
      <ChevronUp className="w-3.5 h-3.5 inline ml-1" />
    ) : (
      <ChevronDown className="w-3.5 h-3.5 inline ml-1" />
    );
  };

  return (
    <div className="p-6 space-y-6">
      {/* Header */}
      <div>
        <h1 className="text-2xl font-bold text-gray-900 dark:text-gray-100">Compliance</h1>
        <p className="text-sm text-gray-500 dark:text-gray-400 mt-1">
          Controls mapped to RBI, PCI-DSS v4.0, NPCI UPI, and India Data Localisation
        </p>
      </div>

      {/* Framework Summary Cards */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
        {frameworks.map((fw, i) => (
          <div
            key={fw.name}
            className={`rounded-xl border-2 ${fw.color} p-5 opacity-0 animate-fade-in`}
            style={{ animationDelay: `${i * 60}ms` }}
          >
            <div className="flex items-center gap-3 mb-3">
              <div className={`p-2 rounded-lg ${fw.iconBg}`}>
                <ShieldCheck className="w-5 h-5" />
              </div>
              <div>
                <h3 className="font-bold text-gray-900 dark:text-gray-100">{fw.name}</h3>
                <p className="text-xs text-gray-500 dark:text-gray-400">{fw.fullName}</p>
              </div>
            </div>
            <p className="text-sm text-gray-600 dark:text-gray-400 mb-3">{fw.description}</p>
            <div className="flex items-center gap-4 text-sm">
              <div>
                <span className="text-gray-500 dark:text-gray-400">Controls</span>
                <p className="font-bold text-gray-900 dark:text-gray-100">{fw.controls}</p>
              </div>
              <div>
                <span className="text-gray-500 dark:text-gray-400">Satisfied</span>
                <p className="font-bold text-emerald-600 dark:text-emerald-400">{fw.satisfied}</p>
              </div>
              {fw.partial > 0 && (
                <div>
                  <span className="text-gray-500 dark:text-gray-400">Partial</span>
                  <p className="font-bold text-amber-600 dark:text-amber-400">{fw.partial}</p>
                </div>
              )}
              {fw.gap > 0 && (
                <div>
                  <span className="text-gray-500 dark:text-gray-400">Gaps</span>
                  <p className="font-bold text-red-600 dark:text-red-400">{fw.gap}</p>
                </div>
              )}
            </div>
            {/* Progress bar */}
            <div className="mt-3 w-full bg-gray-200 dark:bg-gray-700 rounded-full h-2">
              <div
                className="h-2 rounded-full bg-emerald-500 transition-all"
                style={{ width: `${(fw.satisfied / fw.controls) * 100}%` }}
              />
            </div>
            <p className="mt-1 text-xs text-gray-400 dark:text-gray-500">
              {Math.round((fw.satisfied / fw.controls) * 100)}% compliant
            </p>
          </div>
        ))}
      </div>

      {/* Filters */}
      <div className="bg-white dark:bg-gray-800 rounded-xl border border-gray-200 dark:border-gray-700 p-4 opacity-0 animate-fade-in" style={{ animationDelay: '120ms' }}>
        <div className="flex flex-col sm:flex-row gap-3">
          {/* Search */}
          <div className="relative flex-1">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-400 dark:text-gray-500" />
            <input
              type="text"
              placeholder="Search controls by ID, name, description, or evidence..."
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              className="w-full pl-9 pr-4 py-2 text-sm border border-gray-200 dark:border-gray-700 rounded-lg bg-white dark:bg-gray-800 text-gray-900 dark:text-gray-100 placeholder-gray-400 dark:placeholder-gray-500 focus:outline-none focus:ring-2 focus:ring-brand-500 focus:border-transparent"
            />
          </div>

          {/* Framework filter */}
          <div className="relative">
            <Filter className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-400 dark:text-gray-500" />
            <select
              value={frameworkFilter}
              onChange={(e) => {
                setFrameworkFilter(e.target.value);
                if (e.target.value === 'all') setStatusFilter('all');
              }}
              className="pl-9 pr-8 py-2 text-sm border border-gray-200 dark:border-gray-700 rounded-lg focus:outline-none focus:ring-2 focus:ring-brand-500 focus:border-transparent appearance-none bg-white dark:bg-gray-800"
            >
              <option value="all">All Frameworks</option>
              {frameworkKeys.map((fk) => (
                <option key={fk.key} value={fk.key}>{fk.label}</option>
              ))}
            </select>
          </div>

          {/* Status filter */}
          <div className="relative">
            <Filter className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-400 dark:text-gray-500" />
            <select
              value={statusFilter}
              onChange={(e) => setStatusFilter(e.target.value)}
              className="pl-9 pr-8 py-2 text-sm border border-gray-200 dark:border-gray-700 rounded-lg focus:outline-none focus:ring-2 focus:ring-brand-500 focus:border-transparent appearance-none bg-white dark:bg-gray-800"
            >
              <option value="all">All Statuses</option>
              <option value="satisfied">Satisfied</option>
              <option value="partial">Partial</option>
              <option value="gap">Gap</option>
            </select>
          </div>
        </div>

        <p className="mt-3 text-xs text-gray-400 dark:text-gray-500">
          Showing {filtered.length} of {controls.length} controls
        </p>
      </div>

      {/* Controls Table */}
      <div className="bg-white dark:bg-gray-800 rounded-xl border border-gray-200 dark:border-gray-700 overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-gray-100 dark:border-gray-800 bg-gray-50 dark:bg-gray-900">
                <th
                  className="text-left py-3 px-4 font-medium text-gray-500 dark:text-gray-400 cursor-pointer hover:text-gray-700 dark:hover:text-gray-300 select-none"
                  onClick={() => handleSort('id')}
                >
                  ID<SortArrow col="id" />
                </th>
                <th
                  className="text-left py-3 px-4 font-medium text-gray-500 dark:text-gray-400 cursor-pointer hover:text-gray-700 dark:hover:text-gray-300 select-none"
                  onClick={() => handleSort('control')}
                >
                  Control<SortArrow col="control" />
                </th>
                <th className="text-left py-3 px-4 font-medium text-gray-500 dark:text-gray-400 hidden lg:table-cell">
                  Description
                </th>
                {frameworkKeys.map((fk) => (
                  <th
                    key={fk.key}
                    className="text-center py-3 px-3 font-medium text-gray-500 dark:text-gray-400"
                    title={fk.label}
                  >
                    {fk.short}
                  </th>
                ))}
                <th className="text-left py-3 px-4 font-medium text-gray-500 dark:text-gray-400 hidden xl:table-cell">
                  Runbooks
                </th>
                <th className="text-left py-3 px-4 font-medium text-gray-500 dark:text-gray-400 hidden 2xl:table-cell">
                  Evidence
                </th>
              </tr>
            </thead>
            <tbody>
              {filtered.map((ctl, i) => (
                <tr
                  key={ctl.id}
                  className="border-b border-gray-50 dark:border-gray-900 hover:bg-brand-50 dark:hover:bg-brand-900/30 transition-colors opacity-0 animate-fade-in"
                  style={{ animationDelay: `${i * 40}ms` }}
                >
                  <td className="py-3 px-4">
                    <span className="font-mono text-xs font-semibold text-brand-700 dark:text-brand-400 bg-brand-50 dark:bg-brand-900/30 px-2 py-0.5 rounded">
                      {ctl.id}
                    </span>
                  </td>
                  <td className="py-3 px-4">
                    <span className="font-medium text-gray-900 dark:text-gray-100">{ctl.control}</span>
                  </td>
                  <td className="py-3 px-4 hidden lg:table-cell">
                    <span className="text-gray-500 dark:text-gray-400 text-xs leading-relaxed line-clamp-2">
                      {ctl.description}
                    </span>
                  </td>
                  {frameworkKeys.map((fk) => (
                    <td key={fk.key} className="py-3 px-3 text-center">
                      <StatusIcon status={ctl[fk.key]} />
                    </td>
                  ))}
                  <td className="py-3 px-4 hidden xl:table-cell">
                    <div className="flex flex-wrap gap-1">
                      {ctl.runbooks.length > 0 ? (
                        ctl.runbooks.map((rb) => (
                          <a
                            key={rb}
                            href={`/runbook/${rb}`}
                            className="inline-flex items-center gap-1 px-1.5 py-0.5 text-xs font-medium text-brand-600 dark:text-brand-400 bg-brand-50 dark:bg-brand-900/30 rounded hover:bg-brand-100 transition-colors"
                          >
                            <BookOpen className="w-3 h-3" />
                            {rb}
                          </a>
                        ))
                      ) : (
                        <span className="text-xs text-gray-300 dark:text-gray-600">—</span>
                      )}
                    </div>
                  </td>
                  <td className="py-3 px-4 hidden 2xl:table-cell">
                    <span className="text-xs text-gray-400 dark:text-gray-500 line-clamp-2">{ctl.evidence}</span>
                  </td>
                </tr>
              ))}
              {filtered.length === 0 && (
                <tr>
                  <td colSpan={9} className="py-12 text-center text-gray-400 dark:text-gray-500">
                    <Search className="w-8 h-8 mx-auto mb-2 opacity-50" />
                    <p className="text-sm">No controls match your filters</p>
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </div>

      {/* Legend */}
      <div className="flex items-center gap-6 text-xs text-gray-500 dark:text-gray-400">
        <span className="inline-flex items-center gap-1">
          <CheckCircle2 className="w-3.5 h-3.5 text-emerald-600 dark:text-emerald-400" /> Satisfied
        </span>
        <span className="inline-flex items-center gap-1">
          <AlertTriangle className="w-3.5 h-3.5 text-amber-500" /> Partial
        </span>
        <span className="inline-flex items-center gap-1">
          <XCircle className="w-3.5 h-3.5 text-red-500" /> Gap
        </span>
        <span className="inline-flex items-center gap-1">
          <span className="text-gray-300 dark:text-gray-600">—</span> Not applicable
        </span>
      </div>
    </div>
  );
}
