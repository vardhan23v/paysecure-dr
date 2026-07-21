import { useState, useEffect } from 'react';
import { useParams, Link } from 'react-router-dom';
import ReactMarkdown from 'react-markdown';
import {
  ArrowLeft,
  Clock,
  User,
  ShieldCheck,
  AlertTriangle,
  Loader2,
} from 'lucide-react';
import runbooks from '../data/runbooks.json';

interface Runbook {
  id: string;
  title: string;
  tags: string[];
  owner: string;
  eta: string;
  classification: string;
  complianceFrameworks: string[];
  file: string;
}

const runbookList = runbooks as Runbook[];

export default function RunbookDetail() {
  const { id } = useParams();
  const [markdown, setMarkdown] = useState('');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  const meta = runbookList.find((rb) => rb.id === id);

  useEffect(() => {
    if (!meta) {
      setError(`Runbook "${id}" not found.`);
      setLoading(false);
      return;
    }

    fetch(`/content/runbooks/${meta.file}`)
      .then((res) => {
        if (!res.ok) throw new Error(`Failed to load: ${res.status}`);
        return res.text();
      })
      .then((text) => {
        setMarkdown(text);
        setLoading(false);
      })
      .catch((err: Error) => {
        setError(err.message);
        setLoading(false);
      });
  }, [id, meta]);

  if (!meta) {
    return (
      <div className="p-6">
        <Link
          to="/runbooks"
          className="inline-flex items-center gap-2 text-sm text-brand-600 hover:text-brand-700 mb-6"
        >
          <ArrowLeft className="w-4 h-4" />
          Back to Runbooks
        </Link>
        <div className="bg-white rounded-xl border border-gray-200 p-12 text-center">
          <AlertTriangle className="w-12 h-12 text-amber-400 mx-auto mb-4" />
          <h2 className="text-lg font-semibold text-gray-900 mb-2">Runbook Not Found</h2>
          <p className="text-gray-500">No runbook with ID &quot;{id}&quot; exists.</p>
        </div>
      </div>
    );
  }

  return (
    <div className="p-6 space-y-6 opacity-0 animate-fade-in" key={id}>
      {/* Back link */}
      <Link
        to="/runbooks"
        className="inline-flex items-center gap-2 text-sm text-brand-600 hover:text-brand-700"
      >
        <ArrowLeft className="w-4 h-4" />
        Back to Runbooks
      </Link>

      {/* Meta header */}
      <div className="bg-white rounded-xl border border-gray-200 p-6">
        <h1 className="text-2xl font-bold text-gray-900">{meta.title}</h1>
        <div className="flex flex-wrap items-center gap-4 mt-4 text-sm text-gray-600">
          <span className="inline-flex items-center gap-1.5">
            <AlertTriangle className="w-4 h-4 text-gray-400" />
            <span className="font-medium">{meta.classification}</span>
          </span>
          <span className="inline-flex items-center gap-1.5">
            <User className="w-4 h-4 text-gray-400" />
            {meta.owner}
          </span>
          <span className="inline-flex items-center gap-1.5">
            <Clock className="w-4 h-4 text-gray-400" />
            ETA: {meta.eta}
          </span>
        </div>
        {meta.complianceFrameworks.length > 0 && (
          <div className="flex flex-wrap items-center gap-2 mt-3">
            <ShieldCheck className="w-4 h-4 text-gray-400" />
            {meta.complianceFrameworks.map((fw) => (
              <span
                key={fw}
                className="inline-block px-2 py-0.5 text-xs font-medium text-emerald-700 bg-emerald-50 border border-emerald-200 rounded-full"
              >
                {fw}
              </span>
            ))}
          </div>
        )}
        <div className="flex flex-wrap gap-1.5 mt-3">
          {meta.tags.map((tag) => (
            <span
              key={tag}
              className="inline-block px-2 py-0.5 text-xs font-medium text-gray-500 bg-gray-100 rounded"
            >
              {tag}
            </span>
          ))}
        </div>
      </div>

      {/* Markdown content */}
      <div className="bg-white rounded-xl border border-gray-200 p-6 md:p-8">
        {loading && (
          <div className="flex items-center justify-center py-16">
            <Loader2 className="w-6 h-6 text-brand-500 animate-spin" />
            <span className="ml-3 text-sm text-gray-500">Loading runbook...</span>
          </div>
        )}

        {error && (
          <div className="bg-red-50 border border-red-200 rounded-lg p-4 text-sm text-red-700">
            {error}
          </div>
        )}

        {!loading && !error && (
          <article className="prose prose-gray max-w-none
            prose-headings:text-gray-900
            prose-h1:text-2xl prose-h1:font-bold prose-h1:mt-8 prose-h1:mb-4
            prose-h2:text-xl prose-h2:font-semibold prose-h2:mt-8 prose-h2:mb-3 prose-h2:pb-2 prose-h2:border-b prose-h2:border-gray-100
            prose-h3:text-lg prose-h3:font-semibold prose-h3:mt-6 prose-h3:mb-2
            prose-p:text-gray-700 prose-p:leading-relaxed
            prose-code:text-sm prose-code:bg-gray-100 prose-code:px-1.5 prose-code:py-0.5 prose-code:rounded prose-code:font-mono prose-code:text-brand-700
            prose-pre:bg-gray-900 prose-pre:text-gray-100 prose-pre:rounded-lg prose-pre:p-4 prose-pre:text-sm
            prose-table:text-sm prose-th:font-medium prose-th:text-gray-600 prose-td:text-gray-700
            prose-a:text-brand-600 prose-a:no-underline hover:prose-a:underline
            prose-strong:text-gray-900
            prose-li:text-gray-700
            prose-blockquote:border-l-brand-400 prose-blockquote:bg-brand-50/50 prose-blockquote:py-1 prose-blockquote:px-4 prose-blockquote:rounded-r-lg
            prose-hr:border-gray-100
          ">
            <ReactMarkdown>{markdown}</ReactMarkdown>
          </article>
        )}
      </div>
    </div>
  );
}
