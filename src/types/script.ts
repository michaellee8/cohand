export interface ScriptVersion {
  id: string; // taskId:vN
  taskId: string;
  version: number;
  source: string;
  checksum: string; // SHA-256
  generatedBy: 'explorer' | 'repair' | 'user_edit';
  astValidationPassed: boolean;
  securityReviewPassed: boolean;
  reviewDetails: ReviewDetail[];
  createdAt: string;
}

export interface ReviewDetail {
  model: string;
  approved: boolean;
  issues: string[];
}

export interface ScriptRun {
  id: string;
  taskId: string;
  version: number;
  success: boolean;
  result?: unknown;
  error?: string;
  durationMs: number;
  stateHash?: string;
  stateSummary?: string;
  ranAt: string; // millisecond-precision ISO timestamp
}
