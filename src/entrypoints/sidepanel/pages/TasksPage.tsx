export function TasksPage() {
  return (
    <div className="p-4">
      <div className="flex items-center justify-between mb-4">
        <h2 className="text-base font-semibold">Tasks</h2>
        <button className="bg-blue-500 text-white rounded-lg px-3 py-1.5 text-sm font-medium hover:bg-blue-600 transition-colors">
          + New Task
        </button>
      </div>
      <div className="text-center text-gray-400 mt-12">
        <p className="text-sm">No tasks yet</p>
        <p className="text-xs mt-1">Create your first automation task</p>
      </div>
    </div>
  );
}
