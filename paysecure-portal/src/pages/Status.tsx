import { useState, useRef, useEffect, useMemo } from 'react';
import {
  Server,
  Database,
  Cpu,
  Container,
  Globe,
  AlertTriangle,
  CheckCircle2,
  XCircle,
  Clock,
  Activity,
  ArrowUpRight,
  ArrowDownRight,
  Minus,
  Search,
  X,
} from 'lucide-react';
import useKeyboardShortcuts from '../hooks/useKeyboardShortcuts';
import useDarkMode from '../hooks/useDarkMode';
import useSidebar from '../hooks/useSidebar';

interface Region {
  name: string;
  role: string;
  status: string;
  services: { up: number; degraded: number; down: number };
  load: number;
  latency: string;
}

const regions: Region[] = [
  {
    name: 'Mumbai',
    role: 'Primary',
    status: 'healthy',
    services: { up: 5, degraded: 0, down: 0 },
    load: 78,
    latency: '2ms',
  },
  {
    name: 'Hyderabad',
    role: 'Secondary',
    status: 'healthy',
    services: { up: 5, degraded: 0, down: 0 },
    load: 12,
    latency: '8ms',
  },
  {
    name: 'Pune',
    role: 'Observer',
    status: 'degraded',
    services: { up: 4, degraded: 1, down: 0 },
    load: 5,
    latency: '14ms',
  },
];

const services = [
  { name: 'Database', icon: Database, regions: { Mumbai: 'up', Hyderabad: 'up', Pune: 'up' } },
  { name: 'Cache', icon: Cpu, regions: { Mumbai: 'up', Hyderabad: 'up', Pune: 'degraded' } },
  { name: 'Kafka', icon: Activity, regions: { Mumbai: 'up', Hyderabad: 'up', Pune: 'up' } },
  { name: 'EKS', icon: Container, regions: { Mumbai: 'up', Hyderabad: 'up', Pune: 'up' } },
  { name: 'DNS', icon: Globe, regions: { Mumbai: 'up', Hyderabad: 'up', Pune: 'up' } },
];

const replicationLags = [
  { label: 'Aurora Global DB', primary: 'Mumbai', secondary: 'Hyderabad', lag: '120ms', trend: 'stable', threshold: '500ms' },
  { label: 'DynamoDB Global', primary: 'Mumbai', secondary: 'Hyderabad', lag: '45ms', trend: 'stable', threshold: '200ms' },
  { label: 'ElastiCache', primary: 'Mumbai', secondary: 'Hyderabad', lag: '80ms', trend: 'up', threshold: '300ms' },
  { label: 'MSK (Kafka)', primary: 'Mumbai', secondary: 'Hyderabad', lag: '210ms', trend: 'stable', threshold: '1s' },
];

const incidents = [
  {
    title: 'Cache degradation — Pune region',
    status: 'investigating',
    severity: 'P2',
    time: 'Ongoing · started 45m ago',
    description: 'ElastiCache node in Pune showing elevated latency. Failover to Hyderabad not triggered.',
  },
  {
    title: 'Replication lag spike — Aurora',
    status: 'resolved',
    severity: 'P1',
    time: 'Resolved · 3 days ago',
    description: 'Aurora Global DB replication lag reached 800ms during peak load. Auto-throttled and recovered within 2 minutes.',
  },
  {
    title: 'DNS propagation delay',
    status: 'resolved',
    severity: 'P2',
    time: 'Resolved · 1 week ago',
    description: 'Route 53 health check flip took 45s instead of expected 30s. TTL adjusted post-incident.',
  },
];

function StatusBadge({ status }: { status: string }) {
  const config: Record<string, { icon: typeof CheckCircle2; className: string; label: string }> = {
    up: { icon: CheckCircle2, className: 'text-emerald-500', label: 'Up' },
    degraded: { icon: AlertTriangle, className: 'text-amber-500', label: 'Degraded' },
    down: { icon: XCircle, className: 'text-red-500', label: 'Down' },
  };
  const { icon: Icon, className, label } = config[status] || config.down;
  return (
    <span className={`inline-flex items-center gap-1 text-xs font-medium ${className}`}>
      <Icon className="w-3.5 h-3.5" />
      {label}
    </span>
  );
}

function RegionStatusCard({ region }: { region: Region }) {
  const statusColor =
    region.status === 'healthy'
      ? 'border-emerald-200/40 dark:border-emerald-800/40'
      : 'border-amber-200/40 dark:border-amber-800/40';

  return (
    <div className={`glass-card glass-card-hover hover-lift p-5 ${statusColor}`}>
      <div className="flex items-center justify-between mb-3">
        <div>
          <h3 className="text-lg font-bold text-gray-900 dark:text-gray-100">{region.name}</h3>
          <span className="text-xs font-medium text-gray-500 dark:text-gray-400">{region.role}</span>
        </div>
        <StatusBadge status={region.status} />
      </div>
      <div className="grid grid-cols-2 gap-3 text-sm">
        <div>
          <span className="text-gray-500 dark:text-gray-400">Services</span>
          <p className="font-semibold text-gray-900 dark:text-gray-100">
            {region.services.up}
            <span className="text-emerald-500">↑</span>{' '}
            {region.services.degraded > 0 && (
              <>{region.services.degraded}<span className="text-amber-500">~</span> </>
            )}
            {region.services.down > 0 && (
              <>{region.services.down}<span className="text-red-500">↓</span></>
            )}
          </p>
        </div>
        <div>
          <span className="text-gray-500 dark:text-gray-400">Load</span>
          <p className="font-semibold text-gray-900 dark:text-gray-100">{region.load}%</p>
        </div>
        <div>
          <span className="text-gray-500 dark:text-gray-400">Latency</span>
          <p className="font-semibold text-gray-900 dark:text-gray-100">{region.latency}</p>
        </div>
      </div>
    </div>
  );
}

function TrendIcon({ trend }: { trend: string }) {
  if (trend === 'up')
    return <ArrowUpRight className="w-3.5 h-3.5 text-amber-500" />;
  if (trend === 'down')
    return <ArrowDownRight className="w-3.5 h-3.5 text-emerald-500" />;
  return <Minus className="w-3.5 h-3.5 text-gray-400 dark:text-gray-500" />;
}

export default function Status() {
  const [search, setSearch] = useState('');
  const [severityFilter, setSeverityFilter] = useState('all');
  const searchRef = useRef<HTMLInputElement>(null);
  const { isDark, toggle: toggleTheme } = useDarkMode();
  const { toggle: toggleSidebar } = useSidebar();

  const filteredIncidents = useMemo(() => {
    return incidents.filter((inc) => {
      const matchesSearch =
        !search ||
        inc.title.toLowerCase().includes(search.toLowerCase()) ||
        inc.description.toLowerCase().includes(search.toLowerCase()) ||
        inc.severity.toLowerCase().includes(search.toLowerCase()) ||
        inc.status.toLowerCase().includes(search.toLowerCase());
      const matchesSeverity = severityFilter === 'all' || inc.severity === severityFilter;
      return matchesSearch && matchesSeverity;
    });
  }, [search, severityFilter]);

  useKeyboardShortcuts({
    '/': () => {
      searchRef.current?.focus();
    },
    t: () => {
      toggleTheme();
    },
    '[': () => {
      toggleSidebar();
    },
  });

  return (
    <div className="p-6 space-y-6">
      {/* Search & Filter Bar */}
      <div className="glass-card p-4 flex flex-col sm:flex-row items-stretch sm:items-center gap-3">
        <div className="relative flex-1">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-400 dark:text-gray-500" />
          <input
            ref={searchRef}
            type="text"
            placeholder="Search incidents, services, regions…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="w-full pl-10 pr-8 py-2 rounded-xl bg-white/50 dark:bg-gray-800 border border-white/20 dark:border-white/10 text-sm text-gray-900 dark:text-gray-100 placeholder-gray-400 dark:placeholder-gray-500 focus:outline-none focus:ring-2 focus:ring-brand-500/50 focus:border-brand-500/50 transition-all"
          />
          {search && (
            <button
              onClick={() => setSearch('')}
              className="absolute right-3 top-1/2 -translate-y-1/2 text-gray-400 hover:text-gray-600 dark:hover:text-gray-300"
            >
              <X className="w-4 h-4" />
            </button>
          )}
          <kbd className="absolute right-3 top-1/2 -translate-y-1/2 hidden sm:inline-flex items-center px-1.5 py-0.5 text-[10px] font-medium text-gray-400 dark:text-gray-500 bg-gray-100 dark:bg-gray-800 rounded border border-gray-200 dark:border-gray-700 pointer-events-none">
            /
          </kbd>
        </div>
        <select
          value={severityFilter}
          onChange={(e) => setSeverityFilter(e.target.value)}
          className="px-4 py-2 rounded-xl bg-white/50 dark:bg-gray-800/50 border border-white/20 dark:border-white/10 text-sm text-gray-900 dark:text-gray-100 focus:outline-none focus:ring-2 focus:ring-brand-500/50 transition-all cursor-pointer"
        >
          <option value="all">All Severities</option>
          <option value="P1">P1 — Critical</option>
          <option value="P2">P2 — Major</option>
        </select>
      </div>

      {/* Region Health */}
      <div>
        <h2 className="text-lg font-semibold text-gray-900 dark:text-gray-100 mb-4">Region Health</h2>
        <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
          {regions.map((region, i) => (
            <div key={region.name} className="opacity-0 animate-fade-in" style={{ animationDelay: `${i * 60}ms` }}>
              <RegionStatusCard region={region} />
            </div>
          ))}
        </div>
      </div>

      {/* Service Grid */}
      <div className="glass-card p-6">
        <h2 className="text-lg font-semibold text-gray-900 dark:text-gray-100 mb-4">Service Grid</h2>
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-white/10 dark:border-white/5">
                <th className="text-left py-3 px-4 font-medium text-gray-500 dark:text-gray-400">Service</th>
                <th className="text-center py-3 px-4 font-medium text-gray-500 dark:text-gray-400">Mumbai</th>
                <th className="text-center py-3 px-4 font-medium text-gray-500 dark:text-gray-400">Hyderabad</th>
                <th className="text-center py-3 px-4 font-medium text-gray-500 dark:text-gray-400">Pune</th>
              </tr>
            </thead>
            <tbody>
              {services.map((svc, i) => (
                <tr key={svc.name} className="border-b border-white/5 dark:border-white/5 hover:bg-white/30 dark:hover:bg-white/5 transition-colors opacity-0 animate-fade-in" style={{ animationDelay: `${i * 40}ms` }}>
                  <td className="py-3 px-4">
                    <div className="flex items-center gap-2">
                      <svc.icon className="w-4 h-4 text-gray-400 dark:text-gray-500" />
                      <span className="font-medium text-gray-900 dark:text-gray-100">{svc.name}</span>
                    </div>
                  </td>
                  {(['Mumbai', 'Hyderabad', 'Pune'] as const).map((region) => (
                    <td key={region} className="py-3 px-4 text-center">
                      <StatusBadge status={svc.regions[region]} />
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      {/* Replication Lag */}
      <div className="glass-card p-6">
        <h2 className="text-lg font-semibold text-gray-900 dark:text-gray-100 mb-4">Replication Lag</h2>
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
          {replicationLags.map((rep, i) => (
            <div
              key={rep.label}
              className="glass-card glass-card-hover hover-lift p-4 opacity-0 animate-fade-in"
              style={{ animationDelay: `${i * 60}ms` }}
            >
              <p className="text-sm font-medium text-gray-900 dark:text-gray-100">{rep.label}</p>
              <p className="mt-2 text-2xl font-bold text-gray-900 dark:text-gray-100">{rep.lag}</p>
              <div className="mt-2 flex items-center justify-between text-xs text-gray-500 dark:text-gray-400">
                <span>
                  {rep.primary} → {rep.secondary}
                </span>
                <span className="inline-flex items-center gap-1">
                  <TrendIcon trend={rep.trend} />
                </span>
              </div>
              <div className="mt-2 w-full bg-gray-100/50 dark:bg-gray-800/50 rounded-full h-1.5">
                <div
                  className={`h-1.5 rounded-full ${rep.trend === 'up' ? 'bg-amber-400' : 'bg-emerald-400'}`}
                  style={{
                    width: `${Math.min(
                      (parseInt(rep.lag) / parseInt(rep.threshold)) * 100,
                      100
                    )}%`,
                  }}
                />
              </div>
              <p className="mt-1 text-xs text-gray-400 dark:text-gray-500">Threshold: {rep.threshold}</p>
            </div>
          ))}
        </div>
      </div>

      {/* Incident Timeline */}
      <div className="glass-card p-6">
        <h2 className="text-lg font-semibold text-gray-900 dark:text-gray-100 mb-4">
          Incident Timeline
          {filteredIncidents.length !== incidents.length && (
            <span className="ml-2 text-sm font-normal text-gray-400 dark:text-gray-500">
              ({filteredIncidents.length} of {incidents.length})
            </span>
          )}
        </h2>
        {filteredIncidents.length === 0 ? (
          <div className="text-center py-8 text-gray-400 dark:text-gray-500">
            <Search className="w-8 h-8 mx-auto mb-2 opacity-50" />
            <p className="text-sm">No incidents match your search or filter.</p>
          </div>
        ) : (
          <div className="space-y-4">
            {filteredIncidents.map((inc, i) => (
              <div key={i} className="flex gap-4 opacity-0 animate-fade-in" style={{ animationDelay: `${i * 60}ms` }}>
                <div className="flex flex-col items-center">
                  <div
                    className={`w-3 h-3 rounded-full border-2 ${inc.status === 'investigating' ? 'border-amber-500 bg-amber-100 dark:bg-amber-900/50' : 'border-emerald-500 bg-emerald-100 dark:bg-emerald-900/50'}`}
                  />
                  {i < filteredIncidents.length - 1 && (
                    <div className="w-px flex-1 bg-gray-200/50 dark:bg-gray-700/50 my-1" />
                  )}
                </div>
                <div className="pb-4 min-w-0 flex-1">
                  <div className="flex items-center gap-2 flex-wrap">
                    <h3 className="text-sm font-semibold text-gray-900 dark:text-gray-100">{inc.title}</h3>
                    <span
                      className={`text-xs font-medium px-2 py-0.5 rounded-full ${inc.severity === 'P1' ? 'bg-red-50/70 dark:bg-red-900/30 text-red-600 dark:text-red-400' : 'bg-amber-50/70 dark:bg-amber-900/30 text-amber-600 dark:text-amber-400'}`}
                    >
                      {inc.severity}
                    </span>
                    <span
                      className={`text-xs font-medium px-2 py-0.5 rounded-full ${inc.status === 'investigating' ? 'bg-amber-50/70 dark:bg-amber-900/30 text-amber-600 dark:text-amber-400' : 'bg-emerald-50/70 dark:bg-emerald-900/30 text-emerald-600 dark:text-emerald-400'}`}
                    >
                      {inc.status}
                    </span>
                  </div>
                  <p className="mt-1 text-sm text-gray-500 dark:text-gray-400">{inc.description}</p>
                  <p className="mt-1 text-xs text-gray-400 dark:text-gray-500 flex items-center gap-1">
                    <Clock className="w-3 h-3" />
                    {inc.time}
                  </p>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}