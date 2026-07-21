import { NavLink, Link } from 'react-router-dom';
import {
  LayoutDashboard,
  Layers,
  BookOpen,
  ShieldCheck,
  AlertTriangle,
  HeartPulse,
  ChevronLeft,
  ChevronRight,
} from 'lucide-react';

const navItems = [
  { to: '/', label: 'Dashboard', icon: LayoutDashboard },
  { to: '/architecture', label: 'Architecture', icon: Layers },
  { to: '/runbooks', label: 'Runbooks', icon: BookOpen },
  { to: '/compliance', label: 'Compliance', icon: ShieldCheck },
  { to: '/fmea', label: 'FMEA', icon: AlertTriangle },
  { to: '/status', label: 'Status', icon: HeartPulse },
];

export default function Sidebar({ collapsed, onToggle }) {
  return (
    <aside
      className={`shrink-0 hidden md:flex flex-col rounded-2xl backdrop-blur-md bg-white/70 dark:bg-gray-900/70 border border-white/20 shadow-lg transition-all duration-300 overflow-hidden ${
        collapsed ? 'w-20' : 'w-64'
      }`}
    >
      <div className="h-16 flex items-center justify-between px-4 border-b border-white/20 dark:border-white/10 shrink-0">
        <Link
          to="/"
          className={`text-lg font-bold text-brand-800 dark:text-brand-300 transition-all duration-300 whitespace-nowrap overflow-hidden no-underline hover:text-brand-900 dark:hover:text-brand-200 ${
            collapsed ? 'opacity-0 max-w-0' : 'opacity-100 max-w-[200px]'
          }`}
        >
          PaySecure DR
        </Link>
        <button
          onClick={onToggle}
          className="p-2 rounded-lg text-gray-500 dark:text-gray-400 hover:bg-white/30 dark:hover:bg-white/10 transition-colors shrink-0"
          aria-label={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
        >
          {collapsed ? <ChevronRight className="w-5 h-5" /> : <ChevronLeft className="w-5 h-5" />}
        </button>
      </div>
      <nav className="flex-1 py-4 space-y-1 px-3 overflow-y-auto">
        {navItems.map(({ to, label, icon: Icon }) => (
          <NavLink
            key={to}
            to={to}
            end={to === '/'}
            title={collapsed ? label : undefined}
            className={({ isActive }) =>
              `flex items-center gap-3 px-3 py-2 rounded-md text-sm font-medium transition-all duration-200 ease-out ${
                collapsed ? 'justify-center' : ''
              } ${
                isActive
                  ? 'bg-brand-500/20 dark:bg-brand-400/20 text-brand-700 dark:text-brand-300 scale-[1.02]'
                  : 'text-gray-600 dark:text-gray-300 hover:bg-white/30 dark:hover:bg-white/10 hover:text-brand-700 dark:hover:text-brand-300 hover:scale-[1.01]'
              }`
            }
          >
            <Icon className="w-5 h-5 shrink-0" />
            <span
              className={`transition-all duration-300 whitespace-nowrap overflow-hidden ${
                collapsed ? 'opacity-0 max-w-0' : 'opacity-100 max-w-[200px]'
              }`}
            >
              {label}
            </span>
          </NavLink>
        ))}
      </nav>
    </aside>
  );
}
