import { create } from 'zustand';
import { addDomainPermission, getDomainPermissions, getSettings } from '../../../lib/storage';
import type { DomainPermission } from '../../../types';

export interface DomainApprovalRequest {
  id: string;
  domain: string;
  status: 'pending' | 'approved' | 'denied';
}

interface DomainSessionState {
  /** Domains approved for this chat session (ephemeral, cleared on clearChat). */
  sessionApprovedDomains: Set<string>;
  /** Globally persisted domain permissions (from chrome.storage.local). */
  persistedDomains: string[];
  /** Pending domain approval requests shown inline in chat. */
  pendingApprovals: DomainApprovalRequest[];
  /** Whether YOLO mode is active (auto-approve with warning). */
  yoloMode: boolean;

  /** Load persisted domain permissions and settings. */
  load: () => Promise<void>;
  /**
   * Check if a domain is allowed. Returns true if already approved
   * (globally or in this session). If not, creates a pending approval request
   * and returns false.
   */
  checkDomain: (domain: string) => boolean;
  /** Approve a pending domain request. Persists globally and adds to session. */
  approveDomain: (requestId: string) => Promise<void>;
  /** Deny a pending domain request. */
  denyDomain: (requestId: string) => void;
  /** Clear session state (on new chat). */
  clearSession: () => void;
  /** Get all pending approval requests. */
  getPendingApprovals: () => DomainApprovalRequest[];
}

export const useDomainSessionStore = create<DomainSessionState>((set, get) => ({
  sessionApprovedDomains: new Set<string>(),
  persistedDomains: [],
  pendingApprovals: [],
  yoloMode: false,

  load: async () => {
    const [permissions, settings] = await Promise.all([
      getDomainPermissions(),
      getSettings(),
    ]);
    set({
      persistedDomains: permissions.map(p => p.domain),
      yoloMode: settings.yoloMode,
    });
  },

  checkDomain: (domain: string) => {
    const { sessionApprovedDomains, persistedDomains, pendingApprovals, yoloMode } = get();

    // Already approved globally or in this session
    if (persistedDomains.includes(domain) || sessionApprovedDomains.has(domain)) {
      return true;
    }

    // Already has a pending request for this domain
    if (pendingApprovals.some(p => p.domain === domain && p.status === 'pending')) {
      return false;
    }

    // YOLO mode: auto-approve with warning but still add to session
    if (yoloMode) {
      const newSessionDomains = new Set(sessionApprovedDomains);
      newSessionDomains.add(domain);
      set({ sessionApprovedDomains: newSessionDomains });
      // Persist globally too
      addDomainPermission({
        domain,
        grantedAt: new Date().toISOString(),
        grantedBy: 'user',
      });
      set(state => ({
        persistedDomains: [...state.persistedDomains, domain],
        pendingApprovals: [
          ...state.pendingApprovals,
          {
            id: `da-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
            domain,
            status: 'approved' as const,
          },
        ],
      }));
      return true;
    }

    // Create a pending approval request
    set(state => ({
      pendingApprovals: [
        ...state.pendingApprovals,
        {
          id: `da-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
          domain,
          status: 'pending' as const,
        },
      ],
    }));
    return false;
  },

  approveDomain: async (requestId: string) => {
    const request = get().pendingApprovals.find(p => p.id === requestId);
    if (!request) return;

    const permission: DomainPermission = {
      domain: request.domain,
      grantedAt: new Date().toISOString(),
      grantedBy: 'user',
    };
    await addDomainPermission(permission);

    const newSessionDomains = new Set(get().sessionApprovedDomains);
    newSessionDomains.add(request.domain);

    set(state => ({
      sessionApprovedDomains: newSessionDomains,
      persistedDomains: [...state.persistedDomains, request.domain],
      pendingApprovals: state.pendingApprovals.map(p =>
        p.id === requestId ? { ...p, status: 'approved' as const } : p,
      ),
    }));
  },

  denyDomain: (requestId: string) => {
    set(state => ({
      pendingApprovals: state.pendingApprovals.map(p =>
        p.id === requestId ? { ...p, status: 'denied' as const } : p,
      ),
    }));
  },

  clearSession: () => {
    set({
      sessionApprovedDomains: new Set<string>(),
      pendingApprovals: [],
    });
  },

  getPendingApprovals: () => {
    return get().pendingApprovals.filter(p => p.status === 'pending');
  },
}));
