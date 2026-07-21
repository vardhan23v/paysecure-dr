import { useState, useMemo } from 'react';
import { Link } from 'react-router-dom';
import {
  AlertTriangle,
  Search,
  Filter,
  BookOpen,
  ChevronDown,
  ChevronUp,
  ShieldAlert,
  Gauge,
} from 'lucide-react';
import fmea from '../data/fmea.json';

interface FmeaItem {
  id: string;
  failureMode: string;
  component: string;
  effect: string;
  severity: number;
  occurrence: number;
  detection: number;
  rpn: number;
  runbook: string;
  mitigation: string;
}

const fmeaList = fmea as FmeaItem[];

function rpnColor(rpn: number) {
  if (rpn >= 70) return { bg: 'bg-red-50 dark:bg-red-900/30', text: 'text-red-700', border: 'border-red-200 dark:border-red-800', bar: 'bg-red-500' };
  if (rpn >= 40) return { bg: 'bg-amber-50 dark:bg-amber-900/30', text: 'text-amber-700', border: 'border-amber-200 dark:border-amber-800', bar: 'bg-amber-500' };
  return { bg: 'bg-emerald-50 dark:bg-emerald-900/30', text: 'text-emerald-700', border: 'border-emerald-200 dark:border-emerald-800', bar: 'bg-emerald-500' };
}

function RPNBadge({ rpn }: { rpn: number }) {
  const colors = rpnColor(rpn);
  return (
    <span
      className={`inline-flex items-center gap-1 px-2.5 py-1 rounded-full text-xs font-bold border ${colors.bg} ${colors.text} ${colors.border}`}
    >
      {rpn >= 70 && <ShieldAlert className="w-3 h-3" />}
      {rpn}
    </span>
  );
}

function RPNBar({ value }: { value: number }) {
  const colors = rpnColor(value);
  const pct = Math.min((value / 100) * 100, 100);
  return (
    <div className="w-full bg-gray-100 dark:bg-gray-800 rounded-full h-1.5">
      <div
        className={`h-1.5 rounded-full ${colors.bar} transition-all`}
        style={{ width: `${pct}%` }}
      />
    </div>
  );
}

function SeverityBadge({ value }: { value: number }) {
  let color = 'bg-gray-50 dark:bg-gray-900 text-gray-600 dark:text-gray-400 border-gray-200 dark:border-gray-700';
  if (value >= 9) color = 'bg-red-50 dark:bg-red-900/30 text-red-700 border-red-200 dark:border-red-800';
  else if (value >= 7) color = 'bg-amber-50 dark:bg-amber-900/30 text-amber-700 border-amber-200 dark:border-amber-800';
  else if (value >= 5) color = 'bg-blue-50 dark:bg-blue-900/30 text-blue-700 border-blue-200 dark:border-blue-800';
  return (
    <span className={`inline-flex items-center px-2 py-0.5 rounded text-xs font-semibold border ${color}`}>
      {value}
    </span>
  );
}

const rpnRanges = [
  { label: 'Critical (≥70)', min: 70, max: 1000, color: 'bg-red-500', count: fmeaList.filter((f) => f.rpn >= 70).length },
  { label: 'High (40–69)', min: 40, max: 69, color: 'bg-amber-500', count: fmeaList.filter((f) => f.rpn >= 40 && f.rpn < 70).length },
  { label: 'Medium (<40)', min: 0, max: 39, color: 'bg-emerald-500', count: fmeaList.filter((f) => f.rpn < 40).length },
];

export default function FMEA() {
  const [search, setSearch] = useState('');
  const [rpnFilter, setRpnFilter] = useState('all');
  const [severityFilter, setSeverityFilter] = useState('all');
  const [componentFilter, setComponentFilter] = useState('all');
  const [sortKey, setSortKey] = useState('rpn');
  const [sortDir, setSortDir] = useState('desc');

  const allComponents = useMemo(() => {
    const set = new Set<string>();
    fmeaList.forEach((f) => set.add(f.component));
    return [...set].sort();
  }, []);

  const filtered = useMemo(() => {
    let result = [...fmeaList];

    if (search) {
      const q = search.toLowerCase();
      result = result.filter(
        (f) =>
          f.id.toLowerCase().includes(q) ||
          f.failureMode.toLowerCase().includes(q) ||
          f.component.toLowerCase().includes(q) ||
          f.effect.toLowerCase().includes(q) ||
          f.mitigation.toLowerCase().includes(q) ||
          f.runbook.toLowerCase().includes(q)
      );
    }

    if (rpnFilter !== 'all') {
      if (rpnFilter === 'critical') result = result.filter((f) => f.rpn >= 70);
      else if (rpnFilter === 'high') result = result.filter((f) => f.rpn >= 40 && f.rpn < 70);
      else if (rpnFilter === 'medium') result = result.filter((f) => f.rpn < 40);
    }

    if (severityFilter !== 'all') {
      if (severityFilter === 'critical') result = result.filter((f) => f.severity >= 9);
      else if (severityFilter === 'high') result = result.filter((f) => f.severity >= 7 && f.severity < 9);
      else if (severityFilter === 'medium') result = result.filter((f) => f.severity >= 5 && f.severity < 7);
      else if (severityFilter === 'low') result = result.filter((f) => f.severity < 5);
    }

    if (componentFilter !== 'all') {
      result = result.filter((f) => f.component === componentFilter);
    }

    result.sort((a, b) => {
      const aVal = a[sortKey as keyof FmeaItem];
      const bVal = b[sortKey as keyof FmeaItem];
      if (typeof aVal === 'string') {
        const cmp = String(aVal).localeCompare(String(bVal));
        return sortDir === 'asc' ? cmp : -cmp;
      }
      return sortDir === 'asc' ? (aVal as number) - (bVal as number) : (bVal as number) - (aVal as number);
    });

    return result;
  }, [search, rpnFilter, severityFilter, componentFilter, sortKey, sortDir]);

  const handleSort = (key: string) => {
    if (sortKey === key) {
      setSortDir((d) => (d === 'asc' ? 'desc' : 'asc'));
    } else {
      setSortKey(key);
      setSortDir(key === 'rpn' || key === 'severity' || key === 'occurrence' || key === 'detection' ? 'desc' : 'asc');
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

  const avgRPN = Math.round(fmeaList.reduce((sum, f) => sum + f.rpn, 0) / fmeaList.length);
  const maxRPN = Math.max(...fmeaList.map((f) => f.rpn));

  return (
    <div className="p-6 space-y-6">
      {/* Header */}
      <div>
        <h1 className="text-2xl font-bold text-gray-900 dark:text-gray-100">FMEA — Failure Mode & Effects Analysis</h1>
        <p className="text-sm text-gray-500 dark:text-gray-400 mt-1">
          {fmeaList.length} failure modes analysed across {allComponents.length} components
        </p>
      </div>

      {/* Summary Cards */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
        <div className="bg-white dark:bg-gray-800 rounded-xl border border-gray-200 dark:border-gray-700 p-5 opacity-0 animate-fade-in" style={{ animationDelay: '0ms' }}>
          <div className="flex items-center gap-2 mb-2">
            <AlertTriangle className="w-5 h-5 text-gray-400 dark:text-gray-500" />
            <span className="text-sm font-medium text-gray-500 dark:text-gray-400">Total Failure Modes</span>
          </div>
          <p className="text-3xl font-bold text-gray-900 dark:text-gray-100">{fmeaList.length}</p>
        </div>
        <div className="bg-white dark:bg-gray-800 rounded-xl border border-gray-200 dark:border-gray-700 p-5 opacity-0 animate-fade-in" style={{ animationDelay: '60ms' }}>
          <div className="flex items-center gap-2 mb-2">
            <Gauge className="w-5 h-5 text-amber-500" />
            <span className="text-sm font-medium text-gray-500 dark:text-gray-400">Average RPN</span>
          </div>
          <p className="text-3xl font-bold text-gray-900 dark:text-gray-100">{avgRPN}</p>
          <RPNBar value={avgRPN} />
        </div>
        <div className="bg-white dark:bg-gray-800 rounded-xl border border-gray-200 dark:border-gray-700 p-5 opacity-0 animate-fade-in" style={{ animationDelay: '120ms' }}>
          <div className="flex items-center gap-2 mb-2">
            <ShieldAlert className="w-5 h-5 text-red-500" />
            <span className="text-sm font-medium text-gray-500 dark:text-gray-400">Max RPN</span>
          </div>
          <p className="text-3xl font-bold text-gray-900 dark:text-gray-100">{maxRPN}</p>
          <RPNBar value={maxRPN} />
        </div>
        <div className="bg-white dark:bg-gray-800 rounded-xl border border-gray-200 dark:border-gray-700 p-5 opacity-0 animate-fade-in" style={{ animationDelay: '180ms' }}>
          <div className="flex items-center gap-2 mb-2">
            <BookOpen className="w-5 h-5 text-brand-500" />
            <span className="text-sm font-medium text-gray-500 dark:text-gray-400">Linked Runbooks</span>
          </div>
          <p className="text-3xl font-bold text-gray-900 dark:text-gray-100">
            {new Set(fmeaList.flatMap((f) => f.runbook.split(', ').map((r) => r.trim()))).size}
          </p>
        </div>
      </div>

      {/* RPN Distribution */}
      <div className="bg-white dark:bg-gray-800 rounded-xl border border-gray-200 dark:border-gray-700 p-5 opacity-0 animate-fade-in" style={{ animationDelay: '160ms' }}>
        <h3 className="text-sm font-semibold text-gray-900 dark:text-gray-100 mb-3">RPN Distribution</h3>
        <div className="flex items-center gap-4">
          {rpnRanges.map((range) => (
            <div key={range.label} className="flex items-center gap-2">
              <div className={`w-3 h-3 rounded ${range.color}`} />
              <span className="text-sm text-gray-600 dark:text-gray-400">{range.label}</span>
              <span className="text-sm font-bold text-gray-900 dark:text-gray-100">{range.count}</span>
            </div>
          ))}
        </div>
        <div className="mt-3 w-full bg-gray-100 dark:bg-gray-800 rounded-full h-3 flex overflow-hidden">
          {rpnRanges.map((range) => {
            const pct = (range.count / fmeaList.length) * 100;
            return pct > 0 ? (
              <div
                key={range.label}
                className={`h-full ${range.color} transition-all`}
                style={{ width: `${pct}%` }}
                title={`${range.label}: ${range.count}`}
              />
            ) : null;
          })}
        </div>
      </div>

      {/* Filters */}
      <div className="bg-white dark:bg-gray-800 rounded-xl border border-gray-200 dark:border-gray-700 p-4 opacity-0 animate-fade-in" style={{ animationDelay: '200ms' }}>
        <div className="flex flex-col sm:flex-row gap-3">
          {/* Search */}
          <div className="relative flex-1">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-400 dark:text-gray-500" />
            <input
              type="text"
              placeholder="Search failure modes, components, effects, or mitigations..."
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              className="w-full pl-9 pr-4 py-2 text-sm border border-gray-200 dark:border-gray-700 rounded-lg bg-white dark:bg-gray-800 text-gray-900 dark:text-gray-100 placeholder-gray-400 dark:placeholder-gray-500 focus:outline-none focus:ring-2 focus:ring-brand-500 focus:border-transparent"
            />
          </div>

          {/* RPN filter */}
          <div className="relative">
            <Filter className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-400 dark:text-gray-500" />
            <select
              value={rpnFilter}
              onChange={(e) => setRpnFilter(e.target.value)}
              className="pl-9 pr-8 py-2 text-sm border border-gray-200 dark:border-gray-700 rounded-lg focus:outline-none focus:ring-2 focus:ring-brand-500 focus:border-transparent appearance-none bg-white dark:bg-gray-800"
            >
              <option value="all">All RPN Levels</option>
              <option value="critical">Critical (≥70)</option>
              <option value="high">High (40–69)</option>
              <option value="medium">Medium (&lt;40)</option>
            </select>
          </div>

          {/* Severity filter */}
          <div className="relative">
            <Filter className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-400 dark:text-gray-500" />
            <select
              value={severityFilter}
              onChange={(e) => setSeverityFilter(e.target.value)}
              className="pl-9 pr-8 py-2 text-sm border border-gray-200 dark:border-gray-700 rounded-lg focus:outline-none focus:ring-2 focus:ring-brand-500 focus:border-transparent appearance-none bg-white dark:bg-gray-800"
            >
              <option value="all">All Severities</option>
              <option value="critical">Critical (9–10)</option>
              <option value="high">High (7–8)</option>
              <option value="medium">Medium (5–6)</option>
              <option value="low">Low (&lt;5)</option>
            </select>
          </div>

          {/* Component filter */}
          <div className="relative">
            <Filter className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-400 dark:text-gray-500" />
            <select
              value={componentFilter}
              onChange={(e) => setComponentFilter(e.target.value)}
              className="pl-9 pr-8 py-2 text-sm border border-gray-200 dark:border-gray-700 rounded-lg focus:outline-none focus:ring-2 focus:ring-brand-500 focus:border-transparent appearance-none bg-white dark:bg-gray-800"
            >
              <option value="all">All Components</option>
              {allComponents.map((c) => (
                <option key={c} value={c}>{c}</option>
              ))}
            </select>
          </div>
        </div>

        <p className="mt-3 text-xs text-gray-400 dark:text-gray-500">
          Showing {filtered.length} of {fmeaList.length} failure modes
        </p>
      </div>

      {/* FMEA Table */}
      <div className="bg-white dark:bg-gray-800 rounded-xl border border-gray-200 dark:border-gray-700 overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-gray-100 dark:border-gray-800 bg-gray-50 dark:bg-gray-900">
                <th
                  className="text-left py-3 px-3 font-medium text-gray-500 dark:text-gray-400 cursor-pointer hover:text-gray-700 dark:hover:text-gray-300 select-none"
                  onClick={() => handleSort('id')}
                >
                  ID<SortArrow col="id" />
                </th>
                <th
                  className="text-left py-3 px-3 font-medium text-gray-500 dark:text-gray-400 cursor-pointer hover:text-gray-700 dark:hover:text-gray-300 select-none"
                  onClick={() => handleSort('failureMode')}
                >
                  Failure Mode<SortArrow col="failureMode" />
                </th>
                <th
                  className="text-left py-3 px-3 font-medium text-gray-500 dark:text-gray-400 cursor-pointer hover:text-gray-700 dark:hover:text-gray-300 select-none hidden md:table-cell"
                  onClick={() => handleSort('component')}
                >
                  Component<SortArrow col="component" />
                </th>
                <th className="text-left py-3 px-3 font-medium text-gray-500 dark:text-gray-400 hidden lg:table-cell">
                  Effect
                </th>
                <th
                  className="text-center py-3 px-2 font-medium text-gray-500 dark:text-gray-400 cursor-pointer hover:text-gray-700 dark:hover:text-gray-300 select-none"
                  onClick={() => handleSort('severity')}
                >
                  S<SortArrow col="severity" />
                </th>
                <th
                  className="text-center py-3 px-2 font-medium text-gray-500 dark:text-gray-400 cursor-pointer hover:text-gray-700 dark:hover:text-gray-300 select-none"
                  onClick={() => handleSort('occurrence')}
                >
                  O<SortArrow col="occurrence" />
                </th>
                <th
                  className="text-center py-3 px-2 font-medium text-gray-500 dark:text-gray-400 cursor-pointer hover:text-gray-700 dark:hover:text-gray-300 select-none"
                  onClick={() => handleSort('detection')}
                >
                  D<SortArrow col="detection" />
                </th>
                <th
                  className="text-center py-3 px-3 font-medium text-gray-500 dark:text-gray-400 cursor-pointer hover:text-gray-700 dark:hover:text-gray-300 select-none"
                  onClick={() => handleSort('rpn')}
                >
                  RPN<SortArrow col="rpn" />
                </th>
                <th className="text-left py-3 px-3 font-medium text-gray-500 dark:text-gray-400 hidden xl:table-cell">
                  Mitigation
                </th>
                <th className="text-left py-3 px-3 font-medium text-gray-500 dark:text-gray-400">
                  Runbook
                </th>
              </tr>
            </thead>
            <tbody>
              {filtered.map((fm, i) => (
                <tr
                  key={fm.id}
                  className="border-b border-gray-50 dark:border-gray-900 hover:bg-brand-50 dark:hover:bg-brand-900/30 transition-colors opacity-0 animate-fade-in"
                  style={{ animationDelay: `${i * 40}ms` }}
                >
                  <td className="py-3 px-3">
                    <span className="font-mono text-xs font-semibold text-brand-700 dark:text-brand-400 bg-brand-50 dark:bg-brand-900/30 px-2 py-0.5 rounded">
                      {fm.id}
                    </span>
                  </td>
                  <td className="py-3 px-3">
                    <span className="font-medium text-gray-900 dark:text-gray-100 text-xs leading-snug">
                      {fm.failureMode}
                    </span>
                  </td>
                  <td className="py-3 px-3 hidden md:table-cell">
                    <span className="text-xs text-gray-500 dark:text-gray-400">{fm.component}</span>
                  </td>
                  <td className="py-3 px-3 hidden lg:table-cell">
                    <span className="text-xs text-gray-500 dark:text-gray-400 line-clamp-2">{fm.effect}</span>
                  </td>
                  <td className="py-3 px-2 text-center">
                    <SeverityBadge value={fm.severity} />
                  </td>
                  <td className="py-3 px-2 text-center">
                    <span className="text-xs font-medium text-gray-700 dark:text-gray-300">{fm.occurrence}</span>
                  </td>
                  <td className="py-3 px-2 text-center">
                    <span className="text-xs font-medium text-gray-700 dark:text-gray-300">{fm.detection}</span>
                  </td>
                  <td className="py-3 px-3 text-center">
                    <RPNBadge rpn={fm.rpn} />
                  </td>
                  <td className="py-3 px-3 hidden xl:table-cell">
                    <span className="text-xs text-gray-500 dark:text-gray-400 line-clamp-2">{fm.mitigation}</span>
                  </td>
                  <td className="py-3 px-3">
                    <div className="flex flex-wrap gap-1">
                      {fm.runbook.split(', ').map((rb) => (
                        <Link
                          key={rb}
                          to={`/runbook/${rb}`}
                          className="inline-flex items-center gap-1 px-1.5 py-0.5 text-xs font-medium text-brand-600 dark:text-brand-400 bg-brand-50 dark:bg-brand-900/30 rounded hover:bg-brand-100 transition-colors"
                        >
                          <BookOpen className="w-3 h-3" />
                          {rb}
                        </Link>
                      ))}
                    </div>
                  </td>
                </tr>
              ))}
              {filtered.length === 0 && (
                <tr>
                  <td colSpan={11} className="py-12 text-center text-gray-400 dark:text-gray-500">
                    <Search className="w-8 h-8 mx-auto mb-2 opacity-50" />
                    <p className="text-sm">No failure modes match your filters</p>
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </div>

      {/* Legend */}
      <div className="flex flex-wrap items-center gap-6 text-xs text-gray-500 dark:text-gray-400">
        <span className="font-medium text-gray-700 dark:text-gray-300">RPN:</span>
        <span className="inline-flex items-center gap-1">
          <span className="w-3 h-3 rounded bg-red-500" /> Critical (≥70)
        </span>
        <span className="inline-flex items-center gap-1">
          <span className="w-3 h-3 rounded bg-amber-500" /> High (40–69)
        </span>
        <span className="inline-flex items-center gap-1">
          <span className="w-3 h-3 rounded bg-emerald-500" /> Medium (&lt;40)
        </span>
        <span className="text-gray-300 dark:text-gray-600">|</span>
        <span className="font-medium text-gray-700 dark:text-gray-300">S = Severity</span>
        <span className="font-medium text-gray-700 dark:text-gray-300">O = Occurrence</span>
        <span className="font-medium text-gray-700 dark:text-gray-300">D = Detection</span>
        <span className="font-medium text-gray-700 dark:text-gray-300">RPN = S × O × D</span>
      </div>
    </div>
  );
}
