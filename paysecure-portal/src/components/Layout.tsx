import { useEffect } from 'react';
import { useLocation } from 'react-router-dom';
import { AnimatePresence } from 'framer-motion';
import Header from './Header';
import Sidebar from './Sidebar';
import Breadcrumb from './Breadcrumb';
import PageTransition from './PageTransition';
import useSidebar from '../hooks/useSidebar';
import type { ReactNode } from 'react';

export default function Layout({ children }: { children: ReactNode }) {
  const { pathname } = useLocation();
  const { collapsed, toggle } = useSidebar();

  useEffect(() => {
    window.scrollTo({ top: 0, behavior: 'instant' });
  }, [pathname]);

  return (
    <div className="min-h-screen flex bg-gray-50 dark:bg-gray-900 p-3 gap-3">
      <Sidebar collapsed={collapsed} onToggle={toggle} />
      <div className="flex-1 flex flex-col min-w-0 gap-3">
        <Header />
        <div className="rounded-2xl backdrop-blur-md bg-white/70 dark:bg-gray-900/70 border border-white/20 shadow-lg transition-all duration-300">
          <Breadcrumb />
        </div>
        <main className="flex-1 overflow-auto rounded-2xl backdrop-blur-md bg-white/70 dark:bg-gray-900/70 border border-white/20 shadow-lg transition-all duration-300 text-gray-900 dark:text-gray-100">
          <AnimatePresence mode="wait">
            <PageTransition key={pathname}>
              <div className="p-6">{children}</div>
            </PageTransition>
          </AnimatePresence>
        </main>
      </div>
    </div>
  );
}