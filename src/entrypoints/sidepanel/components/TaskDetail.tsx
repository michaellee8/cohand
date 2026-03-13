import type { Task, ScriptRun } from '../../../types';

interface TaskDetailProps {
  task: Task;
  runs: ScriptRun[];
  onClose: () => void;
  onDelete: (taskId: string) => void;
}

export function TaskDetail({ task, runs, onClose, onDelete }: TaskDetailProps) {
  return (
    <div className="p-4 space-y-4">
      <div className="flex items-center justify-between">
        <h2 className="text-base font-semibold">{task.name}</h2>
        <button onClick={onClose} className="text-gray-400 hover:text-gray-600">
          <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M6 18 18 6M6 6l12 12" />
          </svg>
        </button>
      </div>

      <p className="text-sm text-gray-600">{task.description}</p>

      <div className="space-y-1">
        <h3 className="text-sm font-medium">Details</h3>
        <div className="text-xs text-gray-500 space-y-0.5">
          <p>Domains: {task.allowedDomains.join(', ')}</p>
          <p>Active version: v{task.activeScriptVersion}</p>
          <p>Schedule: {task.schedule.type === 'interval' ? `Every ${task.schedule.intervalMinutes} minutes` : 'Manual'}</p>
          <p>Created: {new Date(task.createdAt).toLocaleDateString()}</p>
        </div>
      </div>

      <div className="space-y-2">
        <h3 className="text-sm font-medium">Recent Runs</h3>
        {runs.length === 0 ? (
          <p className="text-xs text-gray-400">No runs yet</p>
        ) : (
          <div className="space-y-1">
            {runs.map(run => (
              <div key={run.id} className="text-xs rounded bg-gray-50">
                <div className="flex items-center gap-2 p-1.5">
                  <span className={run.success ? 'text-green-500' : 'text-red-500'}>
                    {run.success ? 'Pass' : 'Fail'}
                  </span>
                  <span className="text-gray-400">v{run.version}</span>
                  <span className="text-gray-400">{run.durationMs}ms</span>
                  <span className="text-gray-400 ml-auto">
                    {new Date(run.ranAt).toLocaleTimeString()}
                  </span>
                </div>
                {!run.success && run.error && (
                  <div className="px-1.5 pb-1.5">
                    <pre className="text-[11px] font-mono text-red-600 bg-red-50 rounded px-2 py-1 whitespace-pre-wrap break-words">
                      {run.error}
                    </pre>
                  </div>
                )}
              </div>
            ))}
          </div>
        )}
      </div>

      <button
        className="text-xs text-red-500 hover:text-red-700"
        onClick={() => onDelete(task.id)}
      >
        Delete Task
      </button>
    </div>
  );
}
