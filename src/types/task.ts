export interface Task {
  id: string;
  name: string;
  description: string;
  allowedDomains: string[];
  schedule: TaskSchedule;
  activeScriptVersion: number;
  lastKnownGoodVersion?: number;
  disabled: boolean;
  createdAt: string; // ISO-8601
  updatedAt: string;
}

export type TaskSchedule =
  | { type: 'manual' }
  | { type: 'interval'; intervalMinutes: number };
