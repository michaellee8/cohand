import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { UsageSummary } from '../../../lib/llm-usage';

export function UsageStats() {
  const { t } = useTranslation();
  const [summary, setSummary] = useState<UsageSummary | null>(null);
  const [error, setError] = useState(false);

  useEffect(() => {
    // Fetch via service worker message
    chrome.runtime.sendMessage({ type: 'GET_USAGE_SUMMARY', sinceDaysAgo: 30 })
      .then(response => setSummary(response.summary))
      .catch(() => setError(true));
  }, []);

  if (error) return <p className="text-xs text-red-500">{t('usage.failedToLoad')}</p>;
  if (!summary) return <p className="text-xs text-gray-400">{t('usage.loading')}</p>;

  return (
    <div className="space-y-3">
      <div className="grid grid-cols-2 gap-2">
        <div className="bg-gray-50 rounded p-2">
          <p className="text-xs text-gray-500">{t('usage.totalCalls')}</p>
          <p className="text-sm font-medium">{summary.totalCalls}</p>
        </div>
        <div className="bg-gray-50 rounded p-2">
          <p className="text-xs text-gray-500">{t('usage.estCost')}</p>
          <p className="text-sm font-medium">${summary.estimatedCostUsd.toFixed(4)}</p>
        </div>
        <div className="bg-gray-50 rounded p-2">
          <p className="text-xs text-gray-500">{t('usage.inputTokens')}</p>
          <p className="text-sm font-medium">{(summary.totalInputTokens / 1000).toFixed(1)}k</p>
        </div>
        <div className="bg-gray-50 rounded p-2">
          <p className="text-xs text-gray-500">{t('usage.outputTokens')}</p>
          <p className="text-sm font-medium">{(summary.totalOutputTokens / 1000).toFixed(1)}k</p>
        </div>
      </div>

      <div>
        <h4 className="text-xs font-medium text-gray-500 mb-1">{t('usage.byPurpose')}</h4>
        {Object.entries(summary.byPurpose).map(([purpose, data]) => (
          <div key={purpose} className="flex justify-between text-xs py-0.5">
            <span className="text-gray-600">{purpose}</span>
            <span className="text-gray-400">{t('usage.callsAndTokens', { calls: data.calls, tokens: (data.tokens / 1000).toFixed(1) })}</span>
          </div>
        ))}
      </div>
    </div>
  );
}
