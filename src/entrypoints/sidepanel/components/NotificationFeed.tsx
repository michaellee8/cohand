import type { TaskNotification } from '../../../types';

interface NotificationFeedProps {
  notifications: TaskNotification[];
  onMarkRead: (id: string) => void;
}

export function NotificationFeed({ notifications, onMarkRead }: NotificationFeedProps) {
  if (notifications.length === 0) {
    return <p className="text-xs text-gray-400 p-4">No notifications</p>;
  }

  return (
    <div className="space-y-1 p-2">
      {notifications.map(notif => (
        <div
          key={notif.id}
          className={`p-2 rounded text-xs transition-colors ${notif.isRead ? 'bg-white' : 'bg-blue-50 cursor-pointer hover:bg-blue-100'}`}
          onClick={() => !notif.isRead && onMarkRead(notif.id)}
          role={notif.isRead ? undefined : 'button'}
          tabIndex={notif.isRead ? undefined : 0}
          onKeyDown={(e) => { if (!notif.isRead && e.key === 'Enter') onMarkRead(notif.id); }}
        >
          <p className={notif.isRead ? 'text-gray-500' : 'text-gray-700'}>{notif.message}</p>
          <span className="text-gray-400 text-[10px]">
            {new Date(notif.createdAt).toLocaleString()}
          </span>
        </div>
      ))}
    </div>
  );
}
