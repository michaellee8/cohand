export function ChatPage() {
  return (
    <div className="flex flex-col h-full">
      <div className="flex-1 p-4 overflow-y-auto">
        <div className="text-center text-gray-400 mt-8">
          <p className="text-lg font-medium">Welcome to Cohand</p>
          <p className="text-sm mt-1">Describe what you want to automate</p>
        </div>
      </div>
      <div className="p-3 border-t border-gray-200">
        <div className="flex gap-2">
          <input
            type="text"
            placeholder="Describe your task..."
            className="flex-1 rounded-lg border border-gray-300 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent"
          />
          <button className="bg-blue-500 text-white rounded-lg px-4 py-2 text-sm font-medium hover:bg-blue-600 transition-colors">
            Send
          </button>
        </div>
      </div>
    </div>
  );
}
