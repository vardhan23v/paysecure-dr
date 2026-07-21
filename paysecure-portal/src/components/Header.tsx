import { Link } from 'react-router-dom';
import { Activity, Sun, Moon } from 'lucide-react';
import useDarkMode from '../hooks/useDarkMode';

export default function Header() {
  const { isDark, toggle } = useDarkMode();

  return (
    <header className="h-16 rounded-2xl backdrop-blur-md bg-white/70 dark:bg-gray-900/70 border border-white/20 shadow-lg transition-all duration-300 flex items-center justify-between px-6 shrink-0">
      <Link
        to="/"
        className="text-xl font-bold text-brand-800 dark:text-brand-300 transition-all duration-200 ease-out hover:text-brand-900 dark:hover:text-brand-200 no-underline"
      >
        PaySecure DR Portal
      </Link>
      <div className="flex items-center gap-3">
        <button
          onClick={toggle}
          className="p-2 rounded-lg text-gray-500 dark:text-gray-400 hover:bg-white/30 dark:hover:bg-white/10 transition-colors"
          aria-label="Toggle theme"
        >
          {isDark ? <Sun className="w-5 h-5" /> : <Moon className="w-5 h-5" />}
        </button>
        <div className="flex items-center gap-2 text-sm font-medium text-emerald-600 dark:text-emerald-400 bg-emerald-50/70 dark:bg-emerald-900/30 px-3 py-1 rounded-full transition-all duration-200 ease-out hover:bg-emerald-100/70 dark:hover:bg-emerald-900/50 hover:scale-[1.02]">
          <Activity className="w-4 h-4" />
          <span>System Healthy</span>
        </div>
      </div>
    </header>
  );
}