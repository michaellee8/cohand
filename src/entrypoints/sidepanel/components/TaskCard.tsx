import type { Task } from '../../../types';

interface TaskCardProps {
  task: Task;
  isSelected: boolean;
  onSelect: (taskId: string) => void;
  onRun: (taskId: string) => void;
}

export function TaskCard({ task, isSelected, onSelect, onRun }: TaskCardProps) {
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
            className="text-xs bg-blue-500 text-white rounded px-2 py-0.5 hover:bg-blue-600 transition-colors"
            onClick={(e) => { e.stopPropagation(); onRun(task.id); }}
            disabled={task.disabled}
          >
            Run
          </button>
        </div>
      </div>
      <p className="text-xs text-gray-500 mt-1 truncate">{task.description}</p>
      <div className="flex items-center gap-2 mt-1.5 text-xs text-gray-400">
        <span>v{task.activeScriptVersion}</span>
        <span>{task.allowedDomains.join(', ')}</span>
      </div>
    </div>
  );
}
