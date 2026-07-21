import { Link, useLocation } from 'react-router-dom';
import { ChevronRight, Home } from 'lucide-react';

const labelMap: Record<string, string> = {
  '': 'Dashboard',
  architecture: 'Architecture',
  runbooks: 'Runbooks',
  compliance: 'Compliance',
  fmea: 'FMEA',
  status: 'Status',
};

export default function Breadcrumb() {
  const { pathname } = useLocation();
  const segments = pathname.split('/').filter(Boolean);

  const crumbs = segments.map((seg, i) => {
    const path = '/' + segments.slice(0, i + 1).join('/');
    const label = labelMap[seg] || seg.charAt(0).toUpperCase() + seg.slice(1);
    return { path, label };
  });

  return (
    <nav className="flex items-center gap-1 text-sm text-gray-500 dark:text-gray-400 px-6 py-3" aria-label="Breadcrumb">
      <Link
        to="/"
        className="flex items-center gap-1 hover:text-brand-600 dark:hover:text-brand-400 transition-colors"
      >
        <Home className="w-4 h-4" />
        <span>Home</span>
      </Link>
      {crumbs.map((crumb) => (
        <span key={crumb.path} className="flex items-center gap-1">
          <ChevronRight className="w-4 h-4" />
          <Link
            to={crumb.path}
            className="hover:text-brand-600 dark:hover:text-brand-400 transition-colors"
          >
            {crumb.label}
          </Link>
        </span>
      ))}
    </nav>
  );
}