import { useEffect, useState } from 'react';
import type { UsageSummary } from '../../../lib/llm-usage';

export function UsageStats() {
  const [summary, setSummary] = useState<UsageSummary | null>(null);

  useEffect(() => {
    // Fetch via service worker message
    chrome.runtime.sendMessage({ type: 'GET_USAGE_SUMMARY', days: 30 })
      .then(response => setSummary(response.summary))
      .catch(() => {});
  }, []);

  if (!summary) return <p className="text-xs text-gray-400">Loading usage...</p>;

  return (
    <div className="space-y-3">
      <div className="grid grid-cols-2 gap-2">
        <div className="bg-gray-50 rounded p-2">
          <p className="text-xs text-gray-500">Total Calls</p>
          <p className="text-sm font-medium">{summary.totalCalls}</p>
        </div>
        <div className="bg-gray-50 rounded p-2">
          <p className="text-xs text-gray-500">Est. Cost</p>
          <p className="text-sm font-medium">${summary.estimatedCostUsd.toFixed(4)}</p>
        </div>
        <div className="bg-gray-50 rounded p-2">
          <p className="text-xs text-gray-500">Input Tokens</p>
          <p className="text-sm font-medium">{(summary.totalInputTokens / 1000).toFixed(1)}k</p>
        </div>
        <div className="bg-gray-50 rounded p-2">
          <p className="text-xs text-gray-500">Output Tokens</p>
          <p className="text-sm font-medium">{(summary.totalOutputTokens / 1000).toFixed(1)}k</p>
        </div>
      </div>

      <div>
        <h4 className="text-xs font-medium text-gray-500 mb-1">By Purpose</h4>
        {Object.entries(summary.byPurpose).map(([purpose, data]) => (
          <div key={purpose} className="flex justify-between text-xs py-0.5">
            <span className="text-gray-600">{purpose}</span>
            <span className="text-gray-400">{data.calls} calls, {(data.tokens / 1000).toFixed(1)}k tokens</span>
          </div>
        ))}
      </div>
    </div>
  );
}
