import type { EncryptedCodexOAuth } from './recording';

export interface StorageLocal {
  _storageSchemaVersion: number;
  settings: Settings;
  encryptedTokens: EncryptedTokens;
  domainPermissions: DomainPermission[];
  codexOAuthTokens?: EncryptedCodexOAuth;
}

export interface Settings {
  llmProvider: 'chatgpt-subscription' | 'openai' | 'anthropic' | 'gemini' | 'custom';
  llmModel: string;
  llmBaseUrl?: string;
  yoloMode: boolean;
  language: string;
}

export interface EncryptedTokens {
  oauthToken?: string;
  apiKey?: string;
}

export interface DomainPermission {
  domain: string;
  grantedAt: string; // ISO-8601
  grantedBy: 'user' | 'task_creation';
}
