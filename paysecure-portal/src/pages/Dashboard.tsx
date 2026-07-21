import {
  BookOpen,
  ShieldCheck,
  MapPin,
  Clock,
  Target,
  ArrowRight,
  AlertTriangle,
  CheckCircle2,
  RefreshCw,
  Zap,
  Server,
} from 'lucide-react';
import { Link } from 'react-router-dom';
import runbooks from '../data/runbooks.json';

const summaryCards = [
  {
    label: 'Total Runbooks',
    value: runbooks.length,
    icon: BookOpen,
    color: 'text-blue-600 dark:text-blue-400 bg-blue-50 dark:bg-blue-900/30',
    link: '/runbooks',
  },
  {
    label: 'Compliance Frameworks',
    value: 4,
    icon: ShieldCheck,
    color: 'text-emerald-600 dark:text-emerald-400 bg-emerald-50 dark:bg-emerald-900/30',
    link: '/compliance',
  },
  {
    label: 'Regions',
    value: 3,
    icon: MapPin,
    color: 'text-purple-600 dark:text-purple-400 bg-purple-50 dark:bg-purple-900/30',
    detail: 'Mumbai · Hyderabad · Pune',
  },
  {
    label: 'RPO Target',
    value: '< 1 min',
    icon: Target,
    color: 'text-amber-600 dark:text-amber-400 bg-amber-50 dark:bg-amber-900/30',
    detail: 'RTO: < 5 min',
  },
];

const recentActivity = [
  {
    type: 'runbook',
    action: 'RB-001 executed',
    detail: 'Region failure drill — Mumbai → Hyderabad failover',
    time: '2 hours ago',
    icon: RefreshCw,
    iconColor: 'text-blue-500 bg-blue-50 dark:bg-blue-900/30',
  },
  {
    type: 'compliance',
    action: 'PCI-DSS v4.0 audit passed',
    detail: 'Quarterly assessment — all controls satisfied',
    time: '1 day ago',
    icon: CheckCircle2,
    iconColor: 'text-emerald-500 bg-emerald-50 dark:bg-emerald-900/30',
  },
  {
    type: 'alert',
    action: 'Replication lag spike',
    detail: 'Aurora Global DB lag reached 800ms — auto-resolved',
    time: '3 days ago',
    icon: AlertTriangle,
    iconColor: 'text-amber-500 bg-amber-50 dark:bg-amber-900/30',
  },
  {
    type: 'runbook',
    action: 'RB-008 executed',
    detail: 'Scheduled secrets rotation across all regions',
    time: '5 days ago',
    icon: RefreshCw,
    iconColor: 'text-blue-500 bg-blue-50 dark:bg-blue-900/30',
  },
  {
    type: 'compliance',
    action: 'RBI annual filing submitted',
    detail: 'Data localisation attestation for Mumbai, Hyderabad, Pune',
    time: '1 week ago',
    icon: CheckCircle2,
    iconColor: 'text-emerald-500 bg-emerald-50 dark:bg-emerald-900/30',
  },
];

const quickActions = [
  { label: 'View Runbooks', to: '/runbooks', icon: BookOpen },
  { label: 'Check Status', to: '/status', icon: Zap },
  { label: 'Compliance Report', to: '/compliance', icon: ShieldCheck },
  { label: 'FMEA Analysis', to: '/fmea', icon: AlertTriangle },
];

export default function Dashboard() {
  return (
    <div className="p-6 space-y-6">
      {/* Summary Cards */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
        {summaryCards.map((card, i) => (
          <div
            key={card.label}
            className="bg-white dark:bg-gray-800 rounded-xl border border-gray-200 dark:border-gray-700 p-5 hover:shadow-md transition-shadow opacity-0 animate-fade-in"
            style={{ animationDelay: `${i * 60}ms` }}
          >
            <div className="flex items-start justify-between">
              <div className={`p-2.5 rounded-lg ${card.color}`}>
                <card.icon className="w-5 h-5" />
              </div>
              {card.link && (
                <Link
                  to={card.link}
                  className="text-gray-400 dark:text-gray-500 hover:text-brand-600 transition-colors"
                >
                  <ArrowRight className="w-4 h-4" />
                </Link>
              )}
            </div>
            <p className="mt-4 text-3xl font-bold text-gray-900 dark:text-gray-100">{card.value}</p>
            <p className="mt-1 text-sm font-medium text-gray-600 dark:text-gray-400">{card.label}</p>
            {card.detail && (
              <p className="mt-1 text-xs text-gray-400 dark:text-gray-500">{card.detail}</p>
            )}
          </div>
        ))}
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        {/* Recent Activity */}
        <div className="lg:col-span-2 bg-white dark:bg-gray-800 rounded-xl border border-gray-200 dark:border-gray-700 p-6">
          <div className="flex items-center justify-between mb-5">
            <h2 className="text-lg font-semibold text-gray-900 dark:text-gray-100">Recent Activity</h2>
            <span className="text-xs text-gray-400 dark:text-gray-500 font-medium">Last 7 days</span>
          </div>
          <div className="space-y-4">
            {recentActivity.map((item, i) => (
              <div key={i} className="flex gap-4 opacity-0 animate-fade-in" style={{ animationDelay: `${i * 50}ms` }}>
                <div
                  className={`shrink-0 w-9 h-9 rounded-full flex items-center justify-center ${item.iconColor}`}
                >
                  <item.icon className="w-4 h-4" />
                </div>
                <div className="min-w-0 flex-1">
                  <p className="text-sm font-medium text-gray-900 dark:text-gray-100">{item.action}</p>
                  <p className="text-sm text-gray-500 dark:text-gray-400 truncate">{item.detail}</p>
                </div>
                <span className="shrink-0 text-xs text-gray-400 dark:text-gray-500">{item.time}</span>
              </div>
            ))}
          </div>
        </div>

        {/* Quick Actions */}
        <div className="bg-white dark:bg-gray-800 rounded-xl border border-gray-200 dark:border-gray-700 p-6">
          <h2 className="text-lg font-semibold text-gray-900 dark:text-gray-100 mb-5">Quick Actions</h2>
          <div className="space-y-2">
            {quickActions.map((action, i) => (
              <Link
                key={action.to}
                to={action.to}
                className="flex items-center gap-3 px-4 py-3 rounded-lg border border-gray-100 dark:border-gray-800 hover:border-brand-200 dark:hover:border-brand-800 hover:bg-brand-50 dark:hover:bg-brand-900/30 text-sm font-medium text-gray-700 dark:text-gray-300 hover:text-brand-700 dark:hover:text-brand-400 transition-colors group opacity-0 animate-fade-in"
                style={{ animationDelay: `${i * 50}ms` }}
              >
                <action.icon className="w-4 h-4 text-gray-400 dark:text-gray-500 group-hover:text-brand-500 transition-colors" />
                {action.label}
                <ArrowRight className="w-4 h-4 ml-auto text-gray-300 dark:text-gray-600 group-hover:text-brand-400 transition-colors" />
              </Link>
            ))}
          </div>

          {/* DR Targets */}
          <div className="mt-6 glass-card glass-card-hover p-5 opacity-0 animate-fade-in" style={{ animationDelay: '200ms' }}>
            <div className="flex items-center gap-2 mb-4">
              <div className="p-1.5 rounded-lg bg-brand-50 dark:bg-brand-900/30">
                <Clock className="w-4 h-4 text-brand-600 dark:text-brand-400" />
              </div>
              <span className="text-sm font-semibold text-gray-900 dark:text-gray-100">DR Targets</span>
            </div>
            <div className="space-y-3">
              <div className="flex items-center gap-3">
                <Target className="w-4 h-4 text-amber-500 shrink-0" />
                <span className="text-sm text-gray-600 dark:text-gray-400 flex-1">RPO</span>
                <span className="text-xs font-mono font-bold px-2.5 py-1 rounded-full bg-amber-50 dark:bg-amber-900/30 text-amber-700 dark:text-amber-400 border border-amber-200 dark:border-amber-800">&lt; 1 min</span>
              </div>
              <div className="flex items-center gap-3">
                <Clock className="w-4 h-4 text-blue-500 shrink-0" />
                <span className="text-sm text-gray-600 dark:text-gray-400 flex-1">RTO</span>
                <span className="text-xs font-mono font-bold px-2.5 py-1 rounded-full bg-blue-50 dark:bg-blue-900/30 text-blue-700 dark:text-blue-400 border border-blue-200 dark:border-blue-800">&lt; 5 min</span>
              </div>
              <div className="flex items-center gap-3">
                <Server className="w-4 h-4 text-purple-500 shrink-0" />
                <span className="text-sm text-gray-600 dark:text-gray-400 flex-1">Topology</span>
                <span className="text-xs font-medium px-2.5 py-1 rounded-full bg-purple-50 dark:bg-purple-900/30 text-purple-700 dark:text-purple-400 border border-purple-200 dark:border-purple-800">Active-Passive</span>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
