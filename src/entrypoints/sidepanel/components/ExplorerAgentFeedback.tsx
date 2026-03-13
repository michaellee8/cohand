export type ExplorerStep =
  | { type: 'observing'; summary?: string }
  | { type: 'screenshot' }
  | { type: 'generating' }
  | { type: 'complete' }
  | { type: 'error'; message: string };

interface ExplorerAgentFeedbackProps {
  steps: ExplorerStep[];
}

const stepConfig: Record<ExplorerStep['type'], { label: string; icon: string }> = {
  observing: { label: 'Observing page structure...', icon: 'eye' },
  screenshot: { label: 'Taking screenshot...', icon: 'camera' },
  generating: { label: 'Generating script...', icon: 'code' },
  complete: { label: 'Script ready', icon: 'check' },
  error: { label: 'Error', icon: 'x' },
};

function StepIcon({ type, isActive }: { type: string; isActive: boolean }) {
  const iconClass = `w-4 h-4 ${isActive ? 'text-blue-500' : 'text-green-500'}`;

  switch (type) {
    case 'eye':
      return (
        <svg className={iconClass} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
          <path strokeLinecap="round" strokeLinejoin="round" d="M2.036 12.322a1.012 1.012 0 0 1 0-.639C3.423 7.51 7.36 4.5 12 4.5c4.638 0 8.573 3.007 9.963 7.178.07.207.07.431 0 .639C20.577 16.49 16.64 19.5 12 19.5c-4.638 0-8.573-3.007-9.963-7.178Z" />
          <path strokeLinecap="round" strokeLinejoin="round" d="M15 12a3 3 0 1 1-6 0 3 3 0 0 1 6 0Z" />
        </svg>
      );
    case 'camera':
      return (
        <svg className={iconClass} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
          <path strokeLinecap="round" strokeLinejoin="round" d="M6.827 6.175A2.31 2.31 0 0 1 5.186 7.23c-.38.054-.757.112-1.134.175C2.999 7.58 2.25 8.507 2.25 9.574V18a2.25 2.25 0 0 0 2.25 2.25h15A2.25 2.25 0 0 0 21.75 18V9.574c0-1.067-.75-1.994-1.802-2.169a47.865 47.865 0 0 0-1.134-.175 2.31 2.31 0 0 1-1.64-1.055l-.822-1.316a2.192 2.192 0 0 0-1.736-1.039 48.774 48.774 0 0 0-5.232 0 2.192 2.192 0 0 0-1.736 1.039l-.821 1.316Z" />
          <path strokeLinecap="round" strokeLinejoin="round" d="M16.5 12.75a4.5 4.5 0 1 1-9 0 4.5 4.5 0 0 1 9 0Z" />
        </svg>
      );
    case 'code':
      return (
        <svg className={iconClass} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
          <path strokeLinecap="round" strokeLinejoin="round" d="M17.25 6.75 22.5 12l-5.25 5.25m-10.5 0L1.5 12l5.25-5.25m7.5-3-4.5 16.5" />
        </svg>
      );
    case 'check':
      return (
        <svg className={`w-4 h-4 text-green-500`} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
          <path strokeLinecap="round" strokeLinejoin="round" d="m4.5 12.75 6 6 9-13.5" />
        </svg>
      );
    case 'x':
      return (
        <svg className={`w-4 h-4 text-red-500`} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
          <path strokeLinecap="round" strokeLinejoin="round" d="M6 18 18 6M6 6l12 12" />
        </svg>
      );
    default:
      return null;
  }
}

export function ExplorerAgentFeedback({ steps }: ExplorerAgentFeedbackProps) {
  if (steps.length === 0) return null;

  return (
    <div className="flex justify-start mb-3">
      <div className="max-w-[85%] rounded-lg px-3 py-2 bg-gray-50 border border-gray-200">
        <div className="text-xs font-medium text-gray-500 mb-2">Explorer Agent</div>
        <div className="space-y-1.5">
          {steps.map((step, idx) => {
            const isLast = idx === steps.length - 1;
            const isActive = isLast && step.type !== 'complete' && step.type !== 'error';
            const config = stepConfig[step.type];

            return (
              <div key={idx} className="flex items-center gap-2">
                <StepIcon type={config.icon} isActive={isActive} />
                <span className={`text-xs ${
                  step.type === 'error'
                    ? 'text-red-600'
                    : isActive
                      ? 'text-blue-600'
                      : 'text-gray-600'
                }`}>
                  {step.type === 'error' ? step.message : config.label}
                  {step.type === 'observing' && step.summary && (
                    <span className="ml-1 text-gray-400">({step.summary})</span>
                  )}
                </span>
                {isActive && (
                  <span className="inline-block w-1.5 h-1.5 bg-blue-500 rounded-full animate-pulse" />
                )}
              </div>
            );
          })}
        </div>

        {/* Progress bar */}
        <div className="mt-2 w-full h-1 bg-gray-200 rounded-full overflow-hidden">
          <div
            className={`h-full rounded-full transition-all duration-500 ${
              steps.some(s => s.type === 'error')
                ? 'bg-red-500'
                : steps.some(s => s.type === 'complete')
                  ? 'bg-green-500'
                  : 'bg-blue-500'
            }`}
            style={{
              width: `${Math.min(100, (steps.length / 4) * 100)}%`,
            }}
          />
        </div>
      </div>
    </div>
  );
}
