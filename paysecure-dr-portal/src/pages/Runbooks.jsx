import { useState, useMemo } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  Search,
  Filter,
  ArrowUpRight,
  Clock,
  User,
  Tag,
  AlertTriangle,
  ChevronRight,
} from 'lucide-react';
import runbooks from '../data/runbooks.json';

const severityOrder = { 'P0': 0, 'P1': 1, 'P2': 2 };

function SeverityBadge({ classification }) {
  const isP0 = classification.startsWith('P0');
  const isP1 = classification.startsWith('P1');
  const isP2 = classification.startsWith('P2');

  const colors = isP0
    ? 'bg-red-50 dark:bg-red-900/30 text-red-700 border-red-200 dark:border-red-800'
    : isP1
    ? 'bg-amber-50 dark:bg-amber-900/30 text-amber-700 border-amber-200 dark:border-amber-800'
    : isP2
    ? 'bg-blue-50 dark:bg-blue-900/30 text-blue-700 border-blue-200 dark:border-blue-800'
    : 'bg-gray-50 dark:bg-gray-900 text-gray-600 dark:text-gray-400 border-gray-200 dark:border-gray-700';

  return (
    <span className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-semibold border ${colors}`}>
      {isP0 && <AlertTriangle className="w-3 h-3" />}
      {classification}
    </span>
  );
}

export default function Runbooks() {
  const navigate = useNavigate();
  const [search, setSearch] = useState('');
  const [severityFilter, setSeverityFilter] = useState('all');
  const [tagFilter, setTagFilter] = useState('all');

  const allTags = useMemo(() => {
    const tagSet = new Set();
    runbooks.forEach((rb) => rb.tags.forEach((t) => tagSet.add(t)));
    return [...tagSet].sort();
  }, []);

  const filtered = useMemo(() => {
    return runbooks.filter((rb) => {
      const matchesSearch =
        !search ||
        rb.id.toLowerCase().includes(search.toLowerCase()) ||
        rb.title.toLowerCase().includes(search.toLowerCase()) ||
        rb.owner.toLowerCase().includes(search.toLowerCase()) ||
        rb.tags.some((t) => t.toLowerCase().includes(search.toLowerCase()));

      const matchesSeverity =
        severityFilter === 'all' || rb.classification.startsWith(severityFilter);

      const matchesTag =
        tagFilter === 'all' || rb.tags.includes(tagFilter);

      return matchesSearch && matchesSeverity && matchesTag;
    });
  }, [search, severityFilter, tagFilter]);

  return (
    <div className="p-6 space-y-6">
      {/* Header */}
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold text-gray-900 dark:text-gray-100">Runbooks</h1>
          <p className="text-sm text-gray-500 dark:text-gray-400 mt-1">
            {runbooks.length} production-ready DR runbooks
          </p>
        </div>
      </div>

      {/* Filters */}
      <div className="bg-white dark:bg-gray-800 rounded-xl border border-gray-200 dark:border-gray-700 p-4 opacity-0 animate-fade-in">
        <div className="flex flex-col sm:flex-row gap-3">
          {/* Search */}
          <div className="relative flex-1">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-400 dark:text-gray-500" />
            <input
              type="text"
              placeholder="Search by ID, title, owner, or tag..."
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              className="w-full pl-9 pr-4 py-2 text-sm border border-gray-200 dark:border-gray-700 rounded-lg bg-white dark:bg-gray-800 text-gray-900 dark:text-gray-100 placeholder-gray-400 dark:placeholder-gray-500 focus:outline-none focus:ring-2 focus:ring-brand-500 focus:border-transparent"
            />
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
              <option value="P0">P0 — Sev 0</option>
              <option value="P1">P1 — Sev 1</option>
              <option value="P2">P2 — Planned</option>
            </select>
          </div>

          {/* Tag filter */}
          <div className="relative">
            <Tag className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-400 dark:text-gray-500" />
            <select
              value={tagFilter}
              onChange={(e) => setTagFilter(e.target.value)}
              className="pl-9 pr-8 py-2 text-sm border border-gray-200 dark:border-gray-700 rounded-lg focus:outline-none focus:ring-2 focus:ring-brand-500 focus:border-transparent appearance-none bg-white dark:bg-gray-800"
            >
              <option value="all">All Tags</option>
              {allTags.map((tag) => (
                <option key={tag} value={tag}>{tag}</option>
              ))}
            </select>
          </div>
        </div>

        {/* Results count */}
        <p className="mt-3 text-xs text-gray-400 dark:text-gray-500">
          Showing {filtered.length} of {runbooks.length} runbooks
        </p>
      </div>

      {/* Table */}
      <div className="bg-white dark:bg-gray-800 rounded-xl border border-gray-200 dark:border-gray-700 overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-gray-100 dark:border-gray-800 bg-gray-50 dark:bg-gray-900">
                <th className="text-left py-3 px-4 font-medium text-gray-500 dark:text-gray-400">ID</th>
                <th className="text-left py-3 px-4 font-medium text-gray-500 dark:text-gray-400">Title</th>
                <th className="text-left py-3 px-4 font-medium text-gray-500 dark:text-gray-400">Severity</th>
                <th className="text-left py-3 px-4 font-medium text-gray-500 dark:text-gray-400">Owner</th>
                <th className="text-left py-3 px-4 font-medium text-gray-500 dark:text-gray-400">ETA</th>
                <th className="text-left py-3 px-4 font-medium text-gray-500 dark:text-gray-400">Tags</th>
                <th className="text-right py-3 px-4 font-medium text-gray-500 dark:text-gray-400"></th>
              </tr>
            </thead>
            <tbody>
              {filtered.map((rb, i) => (
                <tr
                  key={rb.id}
                  onClick={() => navigate(`/runbook/${rb.id}`)}
                  className="border-b border-gray-50 dark:border-gray-900 hover:bg-brand-50 dark:hover:bg-brand-900/30 cursor-pointer transition-colors group opacity-0 animate-fade-in"
                  style={{ animationDelay: `${i * 40}ms` }}
                >
                  <td className="py-3 px-4">
                    <span className="font-mono text-xs font-semibold text-brand-700 dark:text-brand-400 bg-brand-50 dark:bg-brand-900/30 px-2 py-0.5 rounded">
                      {rb.id}
                    </span>
                  </td>
                  <td className="py-3 px-4">
                    <span className="font-medium text-gray-900 dark:text-gray-100 group-hover:text-brand-700 transition-colors">
                      {rb.title}
                    </span>
                  </td>
                  <td className="py-3 px-4">
                    <SeverityBadge classification={rb.classification} />
                  </td>
                  <td className="py-3 px-4">
                    <div className="flex items-center gap-1.5 text-gray-600 dark:text-gray-400">
                      <User className="w-3.5 h-3.5 text-gray-400 dark:text-gray-500" />
                      <span>{rb.owner}</span>
                    </div>
                  </td>
                  <td className="py-3 px-4">
                    <div className="flex items-center gap-1.5 text-gray-600 dark:text-gray-400">
                      <Clock className="w-3.5 h-3.5 text-gray-400 dark:text-gray-500" />
                      <span>{rb.eta}</span>
                    </div>
                  </td>
                  <td className="py-3 px-4">
                    <div className="flex flex-wrap gap-1">
                      {rb.tags.slice(0, 3).map((tag) => (
                        <span
                          key={tag}
                          className="inline-block px-1.5 py-0.5 text-xs font-medium text-gray-500 dark:text-gray-400 bg-gray-100 dark:bg-gray-800 rounded"
                        >
                          {tag}
                        </span>
                      ))}
                      {rb.tags.length > 3 && (
                        <span className="inline-block px-1.5 py-0.5 text-xs text-gray-400 dark:text-gray-500">
                          +{rb.tags.length - 3}
                        </span>
                      )}
                    </div>
                  </td>
                  <td className="py-3 px-4 text-right">
                    <ChevronRight className="w-4 h-4 text-gray-300 dark:text-gray-600 group-hover:text-brand-500 transition-colors inline-block" />
                  </td>
                </tr>
              ))}
              {filtered.length === 0 && (
                <tr>
                  <td colSpan={7} className="py-12 text-center text-gray-400 dark:text-gray-500">
                    <Search className="w-8 h-8 mx-auto mb-2 opacity-50" />
                    <p className="text-sm">No runbooks match your filters</p>
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}