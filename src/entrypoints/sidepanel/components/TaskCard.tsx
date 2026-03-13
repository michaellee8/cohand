import type { Task, ScriptRun } from '../../../types';

interface TaskCardProps {
  task: Task;
  isSelected: boolean;
  lastRun?: ScriptRun;
  isRunning?: boolean;
  onSelect: (taskId: string) => void;
  onRun: (taskId: string) => void;
}

export function TaskCard({ task, isSelected, lastRun, isRunning, onSelect, onRun }: TaskCardProps) {
  return (
    <div
      className={`p-3 rounded-lg border cursor-pointer transition-colors ${
        isSelected ? 'border-blue-500 bg-blue-50' : 'border-gray-200 hover:border-gray-300'
      } ${task.disabled ? 'opacity-50' : ''}`}
      onClick={() => onSelect(task.id)}
    >
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-medium truncate flex-1">{task.name}</h3>
        <div className="flex items-center gap-2 ml-2">
          {task.schedule.type === 'interval' && (
            <span className="text-xs text-gray-400">
              every {task.schedule.intervalMinutes}m
            </span>
          )}
          <button
            className="text-xs bg-blue-500 text-white rounded px-2 py-0.5 hover:bg-blue-600 transition-colors disabled:opacity-50 disabled:cursor-not-allowed min-w-[52px] text-center"
            onClick={(e) => { e.stopPropagation(); onRun(task.id); }}
            disabled={task.disabled || isRunning}
          >
            {isRunning ? (
              <span className="flex items-center gap-1">
                <span className="inline-block w-3 h-3 border-2 border-white border-t-transparent rounded-full animate-spin" />
                Running
              </span>
            ) : task.disabled ? 'Disabled' : 'Run'}
          </button>
        </div>
      </div>
      <p className="text-xs text-gray-500 mt-1 truncate">{task.description}</p>
      <div className="flex items-center gap-2 mt-1.5 text-xs text-gray-400">
        <span>v{task.activeScriptVersion}</span>
        <span>{task.allowedDomains.join(', ')}</span>
        {lastRun && (
          <>
            <span className="ml-auto flex items-center gap-1">
              <span
                className={`inline-block w-2 h-2 rounded-full ${
                  lastRun.success ? 'bg-green-500' : 'bg-red-500'
                }`}
              />
              <span className={lastRun.success ? 'text-green-600' : 'text-red-600'}>
                {lastRun.success ? 'Pass' : 'Fail'}
              </span>
            </span>
            <span>{formatRelativeTime(lastRun.ranAt)}</span>
          </>
        )}
      </div>
    </div>
  );
}

function formatRelativeTime(isoString: string): string {
  const diff = Date.now() - new Date(isoString).getTime();
  const seconds = Math.floor(diff / 1000);
  if (seconds < 60) return 'just now';
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}
