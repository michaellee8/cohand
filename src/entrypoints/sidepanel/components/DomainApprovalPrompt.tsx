import { useTranslation } from 'react-i18next';
import type { DomainApprovalRequest } from '../stores/domain-session-store';

interface DomainApprovalPromptProps {
  request: DomainApprovalRequest;
  yoloMode: boolean;
  onApprove: (requestId: string) => void;
  onDeny: (requestId: string) => void;
}

export function DomainApprovalPrompt({
  request,
  yoloMode,
  onApprove,
  onDeny,
}: DomainApprovalPromptProps) {
  const { t } = useTranslation();

  if (request.status === 'approved') {
    return (
      <div className="flex justify-start mb-3">
        <div className="max-w-[85%] rounded-lg px-3 py-2 text-sm bg-green-50 border border-green-200">
          <div className="flex items-center gap-2 text-green-700">
            <svg className="w-4 h-4 shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="m4.5 12.75 6 6 9-13.5" />
            </svg>
            <span className="text-xs">
              {t('domain.accessGranted', { domain: request.domain })}
              {yoloMode && <span className="ml-1 text-amber-600">{t('domain.autoApproved')}</span>}
            </span>
          </div>
        </div>
      </div>
    );
  }

  if (request.status === 'denied') {
    return (
      <div className="flex justify-start mb-3">
        <div className="max-w-[85%] rounded-lg px-3 py-2 text-sm bg-red-50 border border-red-200">
          <div className="flex items-center gap-2 text-red-700">
            <svg className="w-4 h-4 shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M6 18 18 6M6 6l12 12" />
            </svg>
            <span className="text-xs">
              {t('domain.accessDenied', { domain: request.domain })}
            </span>
          </div>
        </div>
      </div>
    );
  }

  // Pending state
  return (
    <div className="flex justify-start mb-3">
      <div className="max-w-[85%] rounded-lg px-3 py-2 text-sm bg-amber-50 border border-amber-200">
        <div className="flex items-center gap-2 mb-2">
          <svg className="w-4 h-4 text-amber-600 shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M12 9v3.75m0-10.036A11.959 11.959 0 0 1 3.598 6 11.99 11.99 0 0 0 3 9.75c0 5.592 3.824 10.29 9 11.622 5.176-1.332 9-6.03 9-11.622 0-1.31-.21-2.571-.598-3.751h-.152c-3.196 0-6.1-1.25-8.25-3.286Z" />
          </svg>
          <span className="text-xs text-amber-800">
            {t('domain.needsAccess', { domain: request.domain })}
          </span>
        </div>
        <div className="flex gap-2">
          <button
            onClick={() => onApprove(request.id)}
            className="text-xs bg-green-500 text-white rounded px-3 py-1 hover:bg-green-600 transition-colors"
          >
            {t('domain.allow')}
          </button>
          <button
            onClick={() => onDeny(request.id)}
            className="text-xs bg-red-500 text-white rounded px-3 py-1 hover:bg-red-600 transition-colors"
          >
            {t('domain.deny')}
          </button>
        </div>
      </div>
    </div>
  );
}
