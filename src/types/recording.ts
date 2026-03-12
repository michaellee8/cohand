// src/types/recording.ts

export interface A11yNode {
  role: string;
  name?: string;
  children?: A11yNode[];
  [key: string]: unknown;
}

export interface RawRecordingAction {
  action: 'click' | 'type' | 'navigate';
  timestamp: number;
  selector?: string;
  elementTag?: string;
  elementText?: string;
  elementAttributes?: Record<string, string>;
  elementRole?: string;
  a11ySubtree?: A11yNode;
  typedText?: string;
  url?: string;
  pageTitle?: string;
  viewportDimensions?: { width: number; height: number };
  clickPositionHint?: { x: number; y: number };
}

export interface RecordingStep {
  id: string;
  recordingId: string;
  sequenceIndex: number;
  status: 'raw' | 'enriched' | 'described';
  action: 'click' | 'type' | 'navigate' | 'narration';
  selector?: string;
  elementTag?: string;
  elementText?: string;
  elementAttributes?: Record<string, string>;
  elementRole?: string;
  a11ySubtree?: A11yNode;
  typedText?: string;
  url?: string;
  pageTitle?: string;
  viewportDimensions?: { width: number; height: number };
  clickPositionHint?: { x: number; y: number };
  screenshot?: string;
  speechTranscript?: string;
  description?: string;
}

export interface RecordingSession {
  id: string;
  startedAt: string;
  completedAt?: string;
  activeTabId: number;
  trackedTabs: number[];
  pageSnapshots: Record<string, A11yNode>;
  steps: RecordingStep[];
  generatedTaskId?: string;
}

export interface RecordingRecord {
  id: string;
  startedAt: string;
  completedAt?: string;
  activeTabId: number;
  trackedTabs: number[];
  stepCount: number;
  generatedTaskId?: string;
}

export interface RecordingStepRecord {
  id: string;
  recordingId: string;
  sequenceIndex: number;
  timestamp: number;
  action: 'click' | 'type' | 'navigate' | 'narration';
  selector?: string;
  elementTag?: string;
  elementText?: string;
  elementAttributes?: Record<string, string>;
  elementRole?: string;
  a11ySubtree?: unknown;
  typedText?: string;
  url?: string;
  pageTitle?: string;
  viewportDimensions?: { width: number; height: number };
  clickPositionHint?: { x: number; y: number };
  speechTranscript?: string;
  description?: string;
}

export interface RecordingPageSnapshot {
  id: string;
  recordingId: string;
  snapshotKey: string;
  url: string;
  tree: unknown;
  capturedAt: string;
}
