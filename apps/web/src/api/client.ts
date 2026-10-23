/**
 * The one way this application talks to a server.
 *
 * Every call goes to the Support CRM API. The WhatsApp gateway has no client here — no base URL,
 * no API key, no session UUID — because the browser has no business knowing a gateway exists
 * (`docs/WHATSAPP_UX_ARCHITECTURE.md` §2, §9).
 *
 * Authentication is the API's `httpOnly` session cookie. There is deliberately no token in
 * `localStorage`: a token the JavaScript can read is a token an XSS payload can steal.
 */

/**
 * Where the API lives.
 *
 * In production the console is served by the same origin that proxies `/api`, so the base is empty
 * and every request is relative — which is what makes the deployment work behind any hostname
 * without a rebuild. The `localhost:4000` fallback applies only to `vite dev`, where the console is
 * on :3000 and the API on :4000.
 *
 * `VITE_API_URL` overrides both, for the case where the API genuinely lives elsewhere.
 */
export const API_URL: string =
  import.meta.env.VITE_API_URL ?? (import.meta.env.DEV ? 'http://localhost:4000' : '');

/** An error already phrased for a human by the API. */
export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

async function call<T>(method: string, path: string, body?: unknown): Promise<T> {
  let response: Response;

  try {
    response = await fetch(`${API_URL}/api/v1${path}`, {
      method,
      credentials: 'include',
      headers: body === undefined ? {} : { 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch {
    // A network-level failure. The user gets a sentence, not a TypeError.
    throw new ApiError(0, 'Cannot reach Support CRM. Check your connection and try again.');
  }

  if (response.status === 204) return undefined as T;

  const payload: unknown = await response.json().catch(() => null);

  if (!response.ok) {
    if (response.status === 401) {
      // Announced rather than handled here: this module must not import the auth context, and the
      // context must not poll. One event, one listener, and the app renders the login screen.
      globalThis.dispatchEvent(new CustomEvent('support-crm:unauthenticated'));
    }
    throw new ApiError(response.status, messageFrom(payload, response.status));
  }

  return payload as T;
}

/**
 * The API already shapes its WhatsApp failures into operator-readable sentences, so the message is
 * used as-is when there is one. The fallbacks cover the framework's own responses.
 */
function messageFrom(payload: unknown, status: number): string {
  const message = (payload as { message?: unknown } | null)?.message;

  if (typeof message === 'string' && message.length > 0) return message;
  if (Array.isArray(message) && typeof message[0] === 'string') return message.join(', ');

  if (status === 401) return 'Your session has expired. Please sign in again.';
  if (status === 403) return 'You do not have permission to do this.';
  if (status === 409) return 'Another operation is already running. Try again in a moment.';
  // A gateway timeout is usually a WhatsApp session taking too long to boot — each one starts a
  // browser, and starting several at once is what makes it time out. Saying so turns "something
  // went wrong" into something the operator can act on.
  if (status === 504) return 'The WhatsApp gateway timed out starting this session. Finish linking any session already waiting for a scan, then try again.';
  if (status === 502 || status === 503) return 'The WhatsApp gateway is not responding. Check that it is running, then try again.';

  return 'Something went wrong. Please try again.';
}

export const api = {
  get: <T>(path: string) => call<T>('GET', path),
  post: <T>(path: string, body?: unknown) => call<T>('POST', path, body),
  put: <T>(path: string, body?: unknown) => call<T>('PUT', path, body),
  patch: <T>(path: string, body?: unknown) => call<T>('PATCH', path, body),
  del: <T>(path: string) => call<T>('DELETE', path),
};

// === types ========================================================================================

export interface SessionUser {
  id: string;
  username: string;
  email: string;
  name: string;
  roles: string[];
  permissions: string[];
  isSuperAdmin?: boolean;
}

/**
 * How Support CRM presents a WhatsApp connection.
 *
 * `RECONNECTING` and `AUTH_FAILURE` are derived by the API rather than stored — see
 * `whatsapp-presentation.ts`. The client never derives them itself, so there is exactly one place
 * that decides what an operator is told.
 */
export type ConnectionState =
  | 'DISCONNECTED'
  | 'CONNECTING'
  | 'QR_REQUIRED'
  | 'CONNECTED'
  | 'DISCONNECTING'
  | 'RECONNECTING'
  | 'RECOVERY_FAILED'
  | 'AUTH_FAILURE'
  | 'SESSION_ERROR'
  | 'UNKNOWN';

export interface WhatsAppAccount {
  id: string;
  name: string;
  sessionName: string;
  phoneNumber: string | null;
  displayName: string | null;
  state: ConnectionState;
  statusText: string;
  canConnect: boolean;
  isPrimary: boolean;
  ownershipEnabled: boolean;
  connected: boolean;
  lastConnectedAt: string | null;
  lastHeartbeatAt: string | null;
  lastActivityAt: string | null;
  groupCount: number;
}

/** How a pairing code should be shown. The API decides; the client only renders. */
export type PairingFormat = 'image' | 'text';

export interface QrPayload {
  accountId: string;
  state: ConnectionState;
  qr: string | null;
  /** `image` — already a rendered `data:` image. `text` — a raw payload to encode into a QR. */
  format: PairingFormat;
  available: boolean;
  expiresAt: string | null;
}

export const whatsapp = {
  overview: () => api.get<{ items: WhatsAppAccount[] }>('/channels/whatsapp/accounts/overview'),

  /** "+ Connect WhatsApp" — register and start the session in one call. */
  connect: (sessionId: string, label: string) =>
    api.post<{ id: string; state: ConnectionState; statusText: string }>(
      '/channels/whatsapp/accounts/connect',
      { sessionId, label },
    ),

  /** Restarts an existing account. Never re-pairs, so the operator does not rescan. */
  reconnect: (id: string) => api.post<unknown>(`/channels/whatsapp/accounts/${id}/reconnect`),

  disconnect: (id: string) => api.post<unknown>(`/channels/whatsapp/accounts/${id}/disconnect`),
  logoutAccount: (id: string) => api.post<unknown>(`/channels/whatsapp/accounts/${id}/logout`, { confirm: 'LOGOUT' }),
  setPrimary: (id: string) => api.post<unknown>(`/channels/whatsapp/accounts/${id}/primary`),

  /** The current pairing code, for a client that opened the dialog after the push went out. */
  qr: (id: string) => api.get<QrPayload>(`/channels/whatsapp/accounts/${id}/qr`),

  /** Our stored state, the gateway's live state, and the automation safety check, in one call. */
  health: (id: string) => api.get<WhatsAppAccountHealth>(`/channels/whatsapp/accounts/${id}/health`),

  /** Connection state history — the account's own activity log. */
  connectionEvents: (id: string) =>
    api.get<{ items: ConnectionEvent[]; total: number }>(`/channels/whatsapp/accounts/${id}/connection-events`),

  /**
   * Hands the account back, or takes it over.
   *
   * Disabling stops sending, syncing and inbound processing while keeping every row — it is not a
   * delete, and nothing about the conversation history changes.
   */
  setOwnership: (id: string, enabled: boolean) =>
    api.post<unknown>(`/channels/whatsapp/accounts/${id}/ownership`, { enabled }),
};

export interface WhatsAppAccountHealth {
  channelAccountId: string;
  storedState: string;
  ownershipEnabled: boolean;
  webhookRegistered: boolean;
  lastHeartbeatAt: string | null;
  lastConnectedAt: string | null;
  gateway: { reachable: boolean; state: string; displayIdentity: string | null };
  /** `safe: false` means the session must not be used until the operator acts. */
  gatewayAutomation: {
    safe: boolean;
    activeRuleCount: number;
    ruleNames: string[];
    detail: string | null;
  };
}

export interface ConnectionEvent {
  id: string;
  channelAccountId: string;
  previousState: string | null;
  state: string;
  source: string;
  rawState: string | null;
  detail: string | null;
  actorId: string | null;
  createdAt: string;
}

export interface GroupParticipant {
  id: string;
  groupId: string;
  externalId: string;
  phone: string | null;
  displayName: string | null;
  participantType: string;
  isAdmin: boolean;
  isActive: boolean;
}

export interface WhatsAppGroup {
  id: string;
  externalId: string;
  channelAccountId: string;
  name: string | null;
  description: string | null;
  participantCount: number | null;
  isActive: boolean;
  monitoringState: string;
  lastSyncedAt: string | null;
  participantsSyncedAt: string | null;
  lastMessageAt: string | null;
}

export const groups = {
  list: (channelAccountId: string) =>
    api.get<{ items: WhatsAppGroup[]; total: number }>(
      `/groups?channelAccountId=${encodeURIComponent(channelAccountId)}&limit=200`,
    ),

  /** One group, including the automation and AI flags that sit above a conversation. */
  get: (id: string) => api.get<WhatsAppGroup & { aiEnabled: boolean; automationEnabled: boolean }>(`/groups/${id}`),

  /** Groups across every account, or one account, searchable — the inbox's group directory. */
  directory: (params: { channelAccountId?: string; search?: string; limit?: number } = {}) => {
    const query = new URLSearchParams();
    if (params.channelAccountId) query.set('channelAccountId', params.channelAccountId);
    if (params.search) query.set('search', params.search);
    query.set('limit', String(params.limit ?? 100));
    return api.get<{ items: WhatsAppGroup[]; total: number }>(`/groups?${query.toString()}`);
  },

  participants: (groupId: string) =>
    api.get<{ items: GroupParticipant[]; total: number }>(`/groups/${groupId}/participants`),

  /** Refreshes the group LIST — names and membership of the account, not who is in each group. */
  syncGroups: (channelAccountId: string) =>
    api.post<{ discovered: number; created: number; deactivated: number }>('/groups/sync', {
      channelAccountId,
    }),

  /**
   * Refreshes the participants of ONE group.
   *
   * Deliberately per-group. Pulling every participant of every group imports a large number of
   * other people's phone numbers, and that should be a decision an operator makes about a specific
   * group — never a side effect of clicking something on an account.
   */
  syncParticipants: (groupId: string, channelAccountId: string) =>
    api.post<{ groupId: string; active: number; deactivated: number }>(
      `/groups/${groupId}/sync-participants`,
      { channelAccountId },
    ),

  /** One group with every flag the detail screen shows, plus its live participant count. */
  detail: (id: string) => api.get<GroupDetail>(`/groups/${id}`),

  /**
   * Why AI can or cannot reply in this group.
   *
   * Diagnosis, not permission. The backend composes the real gate per message; this reports the
   * same composition so the console can name the switch instead of showing a dead toggle.
   */
  aiStatus: (id: string) => api.get<GroupAiStatus>(`/groups/${id}/ai-status`),

  /** Everything the detail screen shows, in one call. All figures aggregated in SQL. */
  stats: (id: string) => api.get<GroupStats>(`/groups/${id}/stats`),

  /**
   * Changes one group's flags.
   *
   * Send only what is changing — the endpoint patches, and omitting a field leaves it alone. That
   * matters because two operators on the same group would otherwise overwrite each other's toggles
   * by replaying stale values they happened to have on screen.
   */
  updateConfig: (
    id: string,
    patch: Partial<{
      monitoringState: GroupMonitoringStateValue;
      aiEnabled: boolean;
      automationEnabled: boolean;
      patternAnalysisEnabled: boolean;
      knowledgeContributionEnabled: boolean;
    }>,
  ) => api.patch<GroupDetail>(`/groups/${id}/config`, patch),
};

export type AiBlocker =
  | 'EMERGENCY_STOP'
  | 'AI_DISABLED_GROUP'
  | 'AI_DISABLED_PROFILE'
  | 'MONITORING_DISABLED'
  | 'AUTOMATION_DISABLED'
  | 'SESSION_NOT_READY';

export interface GroupAiStatus {
  groupId: string;
  /** What the answer covers — `canReply` is not a per-conversation guarantee. */
  scope: string;
  monitoring: { state: string; collecting: boolean };
  group: { aiEnabled: boolean; automationEnabled: boolean; patternAnalysisEnabled: boolean };
  profile: { id: string; name: string; aiEnabled: boolean; automationEnabled: boolean } | null;
  system: { aiPaused: boolean; automationPaused: boolean };
  session: { status: string; ready: boolean };
  knowledge: { profileId: string | null };
  canReply: boolean;
  blockedBy: AiBlocker[];
  primaryBlocker: AiBlocker | null;
  explanation: string;
}

export type GroupMonitoringStateValue = 'UNMONITORED' | 'MONITORED' | 'IGNORED' | 'PENDING';

export interface GroupDetail {
  id: string;
  channelKey: string;
  channelAccountId: string;
  externalId: string;
  name: string;
  description: string | null;
  participantCount: number | null;
  activeParticipants: number;
  isActive: boolean;
  isAnnounceOnly: boolean;
  monitoringState: GroupMonitoringStateValue;
  aiEnabled: boolean;
  automationEnabled: boolean;
  patternAnalysisEnabled: boolean;
  knowledgeContributionEnabled: boolean;
  knowledgeProfileId: string | null;
  lastSyncedAt: string | null;
  participantsSyncedAt: string | null;
  lastMessageAt: string | null;
}

export type MessageClassificationValue =
  | 'CUSTOMER_MESSAGE'
  | 'TEAM_MESSAGE'
  | 'BOT_MESSAGE'
  | 'SYSTEM_EVENT'
  | 'UNKNOWN';

export interface InspectedMessage {
  id: string;
  channelAccountId: string;
  externalId: string | null;
  externalConversationId: string;
  groupId: string | null;
  direction: MessageDirectionValue;
  /** The sender's stable provider id. Survives display-name changes; the name does not. */
  senderExternalId: string | null;
  senderPhone: string | null;
  senderDisplayName: string | null;
  contentType: string;
  bodyPreview: string | null;
  classification: MessageClassificationValue;
  fromAccount: boolean;
  sentAt: string;
  processingStatus: string | null;
  deliveryStatus: string | null;
}

// === operations analytics (Phase 2) ===============================================================

export interface CoverageSummary {
  totalGroups: number;
  monitored: number;
  /**
   * Groups whose own AI switch is on.
   *
   * Deliberately *not* "AI will reply here" — a profile, the monitoring state, an emergency stop or
   * a disconnected session can each still withhold it. The per-group screen has the effective answer.
   */
  aiConfigured: number;
  aiDisabled: number;
  automationConfigured: number;
  patternAnalysis: number;
}

/** Replies are messages sent; groups are the distinct groups reached. Never interchangeable. */
export interface SupportTotals {
  replies: number;
  groups: number;
}

export interface AiVsHumanDay {
  day: string;
  aiReplies: number;
  aiGroups: number;
  humanReplies: number;
  humanGroups: number;
}

export interface ActiveGroupRow {
  groupId: string;
  name: string | null;
  messages: number;
  aiReplies: number;
  humanSupport: number;
  lastMessageAt: string | null;
}

export interface OperationsDashboard {
  coverage: CoverageSummary;
  today: { ai: SupportTotals; human: SupportTotals };
  window: { days: number; ai: SupportTotals; human: SupportTotals };
  daily: AiVsHumanDay[];
  topGroups: ActiveGroupRow[];
}

export const operationsReports = {
  /** Everything the operations section of the dashboard needs, in one request. */
  dashboard: (days = 14) => api.get<OperationsDashboard>(`/reports/operations?days=${days}`),
  aiVsHuman: (days = 30) => api.get<{ items: AiVsHumanDay[] }>(`/reports/ai-vs-human?days=${days}`),
  coverage: () => api.get<CoverageSummary>('/reports/group-coverage'),
};

export interface GroupStats {
  groupId: string;
  activity: {
    totalMessages: number;
    messagesToday: number;
    messagesThisWeek: number;
    messagesThisMonth: number;
    firstMessageAt: string | null;
    lastMessageAt: string | null;
  };
  ai: {
    replies: number;
    repliesToday: number;
    repliesThisMonth: number;
    lastReplyAt: string | null;
    /** Recorded decisions where the engine declined — real rows, not inference. */
    blocks: Array<{ reasonCode: string; events: number; lastAt: string | null }>;
  };
  support: {
    messages: number;
    messagesToday: number;
    messagesThisMonth: number;
    /** Distinct people, not messages. */
    uniqueMembers: number;
    lastSupportAt: string | null;
    members: Array<{ identityId: string; displayName: string; messages: number; lastAt: string | null }>;
  };
  patterns: {
    detected: number;
    pending: number;
    lastDetectedAt: string | null;
    items: Array<{ candidateId: string; title: string; occurrences: number; status: string; detectedAt: string }>;
  };
}

/** A point in a daily or monthly series. `messages` and `uniqueGroups` are never interchangeable. */
export interface ActivityPoint {
  /** `YYYY-MM-DD` daily, `YYYY-MM` monthly. */
  bucket: string;
  messages: number;
  uniqueGroups: number;
  conversations: number;
}

export interface SupportActivityPoint extends ActivityPoint {
  activeMembers: number;
}

export interface AiBlockRow {
  reasonCode: string;
  outcome: string;
  events: number;
  uniqueGroups: number;
  lastAt: string | null;
}

export interface PatternRow {
  candidateId: string;
  title: string;
  occurrences: number;
  status: string;
  scopeType: string | null;
  groupId: string | null;
  groupName: string | null;
  detectedAt: string;
}

/**
 * Activity analytics.
 *
 * Under `/reports` rather than a separate `/analytics` namespace — that module is already the
 * read-only aggregation surface, and a parallel one would be a second API style.
 *
 * `channelAccountId` scopes every figure to one WhatsApp account. Omitting it spans the estate;
 * groups are unique per account, so nothing is ever merged across them either way.
 */
export const activityAnalytics = {
  aiDaily: (periods = 30, channelAccountId?: string) =>
    api.get<{ items: ActivityPoint[] }>(`/reports/ai/daily?${accountQuery(periods, channelAccountId)}`),
  aiMonthly: (periods = 12, channelAccountId?: string) =>
    api.get<{ items: ActivityPoint[] }>(`/reports/ai/monthly?${accountQuery(periods, channelAccountId)}`),
  supportDaily: (periods = 30, channelAccountId?: string) =>
    api.get<{ items: SupportActivityPoint[] }>(`/reports/support/daily?${accountQuery(periods, channelAccountId)}`),
  supportMonthly: (periods = 12, channelAccountId?: string) =>
    api.get<{ items: SupportActivityPoint[] }>(`/reports/support/monthly?${accountQuery(periods, channelAccountId)}`),
  aiBlocks: (periods = 30, channelAccountId?: string) =>
    api.get<{ from: string; to: string; items: AiBlockRow[] }>(
      `/reports/ai/blocks?${accountQuery(periods, channelAccountId)}`,
    ),
  patterns: (limit = 50, channelAccountId?: string) => {
    const query = new URLSearchParams({ limit: String(limit) });
    if (channelAccountId) query.set('channelAccountId', channelAccountId);
    return api.get<{
      summary: {
        total: number;
        pending: number;
        published: number;
        rejected: number;
        groupsWithPatterns: number;
        groupsContributing: number;
        lastDetectedAt: string | null;
      };
      items: PatternRow[];
    }>(`/reports/patterns?${query.toString()}`);
  },
};

function accountQuery(periods: number, channelAccountId?: string): string {
  const query = new URLSearchParams({ periods: String(periods) });
  if (channelAccountId) query.set('channelAccountId', channelAccountId);
  return query.toString();
}

// === support members (Phase 2) ====================================================================

/**
 * Support members are `team_member_identities` rows.
 *
 * The console calls them support members; the database calls them team member identities, and they
 * are the same records that decide whether an inbound message is classified `TEAM_MESSAGE`. There
 * is deliberately no second entity — two lists of the same people would eventually disagree about
 * who is on the team, and the classifier would keep following the other one.
 */
export interface TeamIdentity {
  id: string;
  channelKey: string;
  externalId: string;
  phone: string;
  displayName: string;
  jobRole: string | null;
  userId: string | null;
  isActive: boolean;
  createdAt: string;
}

export interface SupportMemberRow {
  id: string;
  displayName: string;
  phone: string;
  jobRole: string | null;
  isActive: boolean;
  channelKey: string;
  /** Replies sent. A count of messages. */
  repliesToday: number;
  replies7d: number;
  replies30d: number;
  /** Distinct groups replied in. Never the same figure as replies, and never shown as if it were. */
  groupsToday: number;
  groups7d: number;
  groups30d: number;
  lastReplyAt: string | null;
}

export interface SupportDay {
  day: string;
  replies: number;
  groups: number;
}

export interface SupportTeamDay extends SupportDay {
  activeMembers: number;
}

export interface SupportGroupBreakdown {
  groupId: string | null;
  groupName: string;
  replies: number;
  lastReplyAt: string | null;
}

export interface SupportDayDetail {
  day: string;
  totalMessages: number;
  /** Distinct groups helped that day — never the message count. */
  groupCount: number;
  groups: Array<{
    groupId: string | null;
    groupName: string;
    messages: number;
    firstAt: string | null;
    lastAt: string | null;
  }>;
}

export interface SupportDayMember {
  identityId: string;
  displayName: string;
  replies: number;
  groups: string[];
}

export const team = {
  identities: (includeInactive = false) =>
    api.get<{ items: TeamIdentity[]; total: number }>(
      `/team/identities${includeInactive ? '?includeInactive=true' : ''}`,
    ),

  /**
   * Registers a colleague's WhatsApp number as a support member.
   *
   * This changes how future messages are classified. It is not retroactive — messages already
   * stored keep the classification they were given when they arrived, so registering somebody today
   * does not rewrite yesterday's history or yesterday's figures.
   */
  register: (input: { channelKey: string; phone: string; displayName: string; jobRole?: string }) =>
    api.post<TeamIdentity>('/team/identities', input),

  update: (id: string, patch: Partial<{ displayName: string; jobRole: string; isActive: boolean }>) =>
    api.patch<TeamIdentity>(`/team/identities/${id}`, patch),

  deactivate: (id: string) => api.post<TeamIdentity>(`/team/identities/${id}/deactivate`, {}),
};

export const support = {
  members: (includeInactive = false) =>
    api.get<{ items: SupportMemberRow[] }>(
      `/support/members${includeInactive ? '?includeInactive=true' : ''}`,
    ),

  memberDaily: (id: string, days = 30) =>
    api.get<{ items: SupportDay[] }>(`/support/members/${id}/daily?days=${days}`),

  memberGroups: (id: string, days = 30) =>
    api.get<{ items: SupportGroupBreakdown[] }>(`/support/members/${id}/groups?days=${days}`),

  activity: (days = 30) => api.get<{ items: SupportTeamDay[] }>(`/support/activity?days=${days}`),

  /** Who replied on one calendar day, and in which groups by name. */
  activityDay: (day: string) => api.get<{ items: SupportDayMember[] }>(`/support/activity/${day}`),

  /**
   * One member day by day, with the groups named.
   *
   * Answers "which executive supported how many groups on which day". Dates are `YYYY-MM-DD` in the
   * server's configured timezone, which is the same day the aggregates bucket on.
   */
  memberActivity: (id: string, range: { from?: string; to?: string } = {}) => {
    const query = new URLSearchParams();
    if (range.from) query.set('from', range.from);
    if (range.to) query.set('to', range.to);
    return api.get<{ items: SupportDayDetail[]; from: string; to: string }>(
      `/support/members/${id}/activity?${query.toString()}`,
    );
  },
};

export const knowledgeHarvest = {
  /** Proposes knowledge candidates from groups that opted in. Creates candidates, never articles. */
  fromGroups: (input: { sinceDays?: number; limit?: number } = {}) =>
    api.post<{ groupsConsidered: number; questionsFound: number; created: number; updated: number }>(
      '/knowledge/candidates/harvest-groups',
      input,
    ),
};

// === knowledge (Phase 4) ==========================================================================

export type KnowledgeStatus = 'DRAFT' | 'REVIEW' | 'PUBLISHED' | 'ARCHIVED';
export type KnowledgeScopeType = 'GLOBAL' | 'GROUP' | 'CUSTOMER' | 'PRODUCT';
export type DocumentStatus = 'PENDING' | 'PROCESSING' | 'INDEXED' | 'INDEXED_WITHOUT_VECTORS' | 'FAILED';

export interface KnowledgeArticle {
  id: string;
  title: string;
  slug: string;
  summary: string | null;
  body?: string;
  categoryId: string;
  status: KnowledgeStatus;
  currentVersion: number;
  scopeType: KnowledgeScopeType;
  scopeId: string | null;
  language: string;
  publishedAt: string | null;
  updatedAt: string;
  links?: KnowledgeLink[];
  attachments?: Array<{ id: string; documentId: string; caption: string | null }>;
}

export interface KnowledgeLink {
  id: string;
  kind: 'LINK' | 'YOUTUBE';
  url: string;
  title: string | null;
  note: string | null;
  externalRef: string | null;
}

export interface KnowledgeCategory {
  id: string;
  key: string;
  name: string;
  isSystem: boolean;
}

export interface KnowledgeDocumentRow {
  id: string;
  filename: string;
  mimeType: string;
  sizeBytes: number;
  categoryId: string;
  status: DocumentStatus;
  statusDetail: string | null;
  chunkCount: number;
  pageCount: number | null;
  indexedAt: string | null;
  createdAt: string;
}

export interface KnowledgeVersion {
  id: string;
  version: number;
  title: string;
  summary: string | null;
  body: string;
  status: KnowledgeStatus;
  changeSummary: string | null;
  createdAt: string;
}

export interface KnowledgeCandidate {
  id: string;
  question: string;
  context: string | null;
  sourceType: 'MANUAL' | 'AI_ESCALATION';
  occurrences: number;
  status: 'OPEN' | 'CONVERTED' | 'DISMISSED';
  convertedArticleId: string | null;
  createdAt: string;
}

export interface RetrievedChunk {
  chunkId: string;
  articleId: string | null;
  documentId: string | null;
  title: string | null;
  heading: string | null;
  content: string;
  scopeType: KnowledgeScopeType;
  scopeId: string | null;
  version: number | null;
  score: number;
  matchedBy: 'keyword' | 'semantic' | 'hybrid';
}

export interface KnowledgeStatusReport {
  articles: { total: number; published: number };
  documents: { total: number; indexed: number; failed: number };
  /** Whether semantic search is on. Carries the provider name and model — never a credential. */
  embedding: { available: boolean; provider: string; model: string | null; dimensions: number };
}

export interface KnowledgeProfile {
  id: string;
  name: string;
  description: string | null;
  categoryIds: string[];
  isActive: boolean;
}

export const knowledge = {
  /** The profiles a group can be pointed at, for the operations filter and the bulk assign. */
  profiles: () => api.get<{ items: KnowledgeProfile[] }>('/knowledge/profiles'),

  status: () => api.get<KnowledgeStatusReport>('/knowledge/status'),

  categories: () => api.get<{ items: KnowledgeCategory[] }>('/knowledge/categories'),
  createCategory: (name: string) => api.post<KnowledgeCategory>('/knowledge/categories', { name }),

  listArticles: (params: { status?: string; categoryId?: string; search?: string } = {}) => {
    const query = new URLSearchParams();
    if (params.status) query.set('status', params.status);
    if (params.categoryId) query.set('categoryId', params.categoryId);
    if (params.search) query.set('search', params.search);
    return api.get<{ items: KnowledgeArticle[]; total: number }>(`/knowledge/articles?${query.toString()}`);
  },
  getArticle: (id: string) => api.get<KnowledgeArticle>(`/knowledge/articles/${id}`),
  createArticle: (input: { title: string; body?: string; summary?: string; categoryId: string; scopeType?: KnowledgeScopeType; scopeId?: string }) =>
    api.post<KnowledgeArticle>('/knowledge/articles', input),
  updateArticle: (id: string, input: Record<string, unknown>) =>
    api.patch<KnowledgeArticle>(`/knowledge/articles/${id}`, input),
  setStatus: (id: string, status: KnowledgeStatus, note?: string) =>
    api.post<KnowledgeArticle>(`/knowledge/articles/${id}/status`, { status, note }),
  versions: (id: string) => api.get<{ items: KnowledgeVersion[] }>(`/knowledge/articles/${id}/versions`),
  diff: (id: string, from: number, to: number) =>
    api.get<{ body: Array<{ type: 'same' | 'added' | 'removed'; text: string }> }>(
      `/knowledge/articles/${id}/diff?from=${from}&to=${to}`,
    ),
  rollback: (id: string, version: number) =>
    api.post<KnowledgeArticle>(`/knowledge/articles/${id}/rollback`, { version }),
  deleteArticle: (id: string) => api.del<{ deleted: boolean }>(`/knowledge/articles/${id}`),

  addLink: (id: string, input: { url: string; title?: string; note?: string }) =>
    api.post<KnowledgeLink>(`/knowledge/articles/${id}/links`, input),
  removeLink: (id: string, linkId: string) => api.del<{ deleted: boolean }>(`/knowledge/articles/${id}/links/${linkId}`),

  documents: (params: { status?: string; categoryId?: string } = {}) => {
    const query = new URLSearchParams();
    if (params.status) query.set('status', params.status);
    if (params.categoryId) query.set('categoryId', params.categoryId);
    return api.get<{ items: KnowledgeDocumentRow[] }>(`/knowledge/documents?${query.toString()}`);
  },
  reprocess: (id: string) => api.post<{ jobId: string | null }>(`/knowledge/documents/${id}/reprocess`),
  deleteDocument: (id: string) => api.del<{ deleted: boolean }>(`/knowledge/documents/${id}`),
  downloadUrl: (id: string) => `${API_URL}/api/v1/knowledge/documents/${id}/download`,
  attach: (articleId: string, documentId: string, caption?: string) =>
    api.post<unknown>(`/knowledge/articles/${articleId}/attachments/${documentId}`, { caption }),

  /**
   * Uploads one document.
   *
   * `XMLHttpRequest` rather than `fetch` for one reason: it reports upload progress, and a 25 MB
   * PDF on a slow link with no progress bar looks like a hung page.
   */
  upload: (
    file: File,
    meta: { categoryId: string; articleId?: string; scopeType?: KnowledgeScopeType; scopeId?: string },
    onProgress?: (percent: number) => void,
  ) =>
    new Promise<{ document: KnowledgeDocumentRow; jobId: string | null; duplicate: boolean }>((resolve, reject) => {
      const form = new FormData();
      form.append('file', file);
      form.append('categoryId', meta.categoryId);
      if (meta.articleId) form.append('articleId', meta.articleId);
      if (meta.scopeType) form.append('scopeType', meta.scopeType);
      if (meta.scopeId) form.append('scopeId', meta.scopeId);

      const xhr = new XMLHttpRequest();
      xhr.open('POST', `${API_URL}/api/v1/knowledge/documents`);
      xhr.withCredentials = true;

      xhr.upload.onprogress = (event) => {
        if (event.lengthComputable && onProgress) onProgress(Math.round((event.loaded / event.total) * 100));
      };
      xhr.onload = () => {
        let payload: unknown = null;
        try {
          payload = JSON.parse(xhr.responseText);
        } catch {
          payload = null;
        }
        if (xhr.status >= 200 && xhr.status < 300) {
          resolve(payload as { document: KnowledgeDocumentRow; jobId: string | null; duplicate: boolean });
        } else {
          const message = (payload as { message?: string } | null)?.message;
          reject(new ApiError(xhr.status, message ?? 'That file could not be uploaded.'));
        }
      };
      xhr.onerror = () => reject(new ApiError(0, 'Cannot reach Support CRM. Check your connection and try again.'));
      xhr.send(form);
    }),

  search: (input: { query: string; groupId?: string; customerId?: string; includeUnpublished?: boolean; limit?: number }) =>
    api.post<{
      chunks: RetrievedChunk[];
      totalCharacters: number;
      strategies: { keyword: boolean; semantic: boolean };
      semanticAvailable: boolean;
    }>('/knowledge/search', input),

  candidates: (status?: string) =>
    api.get<{ items: KnowledgeCandidate[]; total: number }>(
      `/knowledge/candidates${status ? `?status=${status}` : ''}`,
    ),
  createCandidate: (input: { question: string; context?: string }) =>
    api.post<KnowledgeCandidate>('/knowledge/candidates', input),
  convertCandidate: (id: string, categoryId: string, title?: string) =>
    api.post<{ article: KnowledgeArticle }>(`/knowledge/candidates/${id}/convert`, { categoryId, title }),
  dismissCandidate: (id: string, note?: string) =>
    api.post<KnowledgeCandidate>(`/knowledge/candidates/${id}/dismiss`, { note }),
};

export const auth = {
  login: (identifier: string, password: string) =>
    api.post<{ user: SessionUser }>('/auth/login', { identifier, password }),
  me: () => api.get<SessionUser>('/auth/me'),
  logout: () => api.post<unknown>('/auth/logout'),
};

// === automation, decisions, escalations, bulk, broadcasts (Phase 5) ===============================

export type AutomationStatusValue = 'DRAFT' | 'REVIEW' | 'ACTIVE' | 'PAUSED' | 'ARCHIVED';
export type RuleScopeType = 'CONVERSATION' | 'CUSTOMER' | 'GROUP' | 'GLOBAL';

export type ConditionType =
  | 'EXACT'
  | 'NORMALIZED'
  | 'CONTAINS'
  | 'PREFIX'
  | 'SUFFIX'
  | 'REGEX'
  | 'MESSAGE_TYPE'
  | 'HAS_ATTACHMENT'
  | 'CONVERSATION_STATE'
  | 'CUSTOMER_TAG'
  | 'BUSINESS_HOURS'
  | 'TIME_WINDOW';

export type ActionType =
  | 'SEND_MESSAGE'
  | 'ESCALATE'
  | 'IGNORE'
  | 'ADD_TAG'
  | 'REMOVE_TAG'
  | 'SET_CONVERSATION_STATE'
  | 'ASSIGN_TEAM'
  | 'ASSIGN_AGENT'
  | 'TRIGGER_KNOWLEDGE_AI';

export interface RuleCondition {
  type: ConditionType;
  value?: string;
  values?: string[];
  negate?: boolean;
  from?: string;
  to?: string;
}

export interface RuleConditionSet {
  match: 'ALL' | 'ANY';
  conditions: RuleCondition[];
}

export interface RuleAction {
  type: ActionType;
  value?: string;
  targetId?: string;
}

export interface AutomationRule {
  id: string;
  profileId: string | null;
  name: string;
  description: string | null;
  status: AutomationStatusValue;
  currentVersion: number;
  priority: number;
  scopeType: RuleScopeType;
  scopeId: string | null;
  conditions: RuleConditionSet;
  actions: RuleAction[];
  cooldownSeconds: number;
  maxExecutions: number | null;
  executionCount: number;
  lastMatchedAt: string | null;
  origin: 'HUMAN' | 'AI_SUGGESTED' | 'IMPORTED';
  approvedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface AutomationRuleVersion {
  id: string;
  version: number;
  name: string;
  status: AutomationStatusValue;
  changeSummary: string | null;
  createdAt: string;
}

export interface AutomationProfile {
  id: string;
  name: string;
  description: string | null;
  status: AutomationStatusValue;
  aiEnabled: boolean;
  automationEnabled: boolean;
  knowledgeProfileId: string | null;
  autoReplyMinConfidence: string | null;
  escalateBelowConfidence: string | null;
  midConfidencePolicy: string | null;
  humanTakeoverMinutes: number | null;
  assignedTeamId: string | null;
}

export interface DryRunResult {
  evaluatedAt: string;
  rulesConsidered: number;
  /** The run raised a draft's status to show what it *would* do. Never what happens today. */
  testedAsIfActive?: boolean;
  matched: Array<{
    id: string;
    name: string;
    priority: number;
    scopeType: RuleScopeType;
    won: boolean;
    skipped: string | null;
    actions: ActionType[];
    status: AutomationStatusValue;
  }>;
  winner: { id: string; name: string; version: number } | null;
  wouldSend: string | null;
  wouldEscalate: boolean;
  aiWouldRun: boolean;
  /** Always false. A dry run cannot send, and says so rather than leaving it to be assumed. */
  sent: false;
  knowledge?: Array<{
    chunkId: string;
    articleId: string | null;
    title: string | null;
    score: number;
    matchedBy: string;
    preview: string;
  }>;
  ai?: {
    available: boolean;
    provider?: string;
    model?: string;
    answer?: string;
    confidence?: number | null;
    confidenceCalibrated?: boolean;
    knowledgeSufficient?: boolean;
    needsHuman?: boolean;
    failed?: boolean;
    error?: string;
    note?: string;
  };
  thresholds?: { autoReplyMin: number; escalateBelow: number; midPolicy: string };
  finalOutcome?: DecisionOutcome;
  finalReason?: string;
}

export const automation = {
  listRules: (params: { status?: string; scopeType?: string; profileId?: string } = {}) => {
    const query = new URLSearchParams();
    if (params.status) query.set('status', params.status);
    if (params.scopeType) query.set('scopeType', params.scopeType);
    if (params.profileId) query.set('profileId', params.profileId);
    return api.get<{ items: AutomationRule[]; total: number }>(`/automation/rules?${query.toString()}`);
  },
  getRule: (id: string) => api.get<AutomationRule>(`/automation/rules/${id}`),
  createRule: (input: Record<string, unknown>) => api.post<AutomationRule>('/automation/rules', input),
  updateRule: (id: string, input: Record<string, unknown>) =>
    api.patch<AutomationRule>(`/automation/rules/${id}`, input),
  setRuleStatus: (id: string, status: AutomationStatusValue, note?: string) =>
    api.post<AutomationRule>(`/automation/rules/${id}/status`, { status, note }),
  ruleVersions: (id: string) =>
    api.get<{ items: AutomationRuleVersion[] }>(`/automation/rules/${id}/versions`),
  rollbackRule: (id: string, version: number) =>
    api.post<AutomationRule>(`/automation/rules/${id}/rollback`, { version }),
  deleteRule: (id: string) => api.del<{ deleted: boolean }>(`/automation/rules/${id}`),

  profiles: () => api.get<{ items: AutomationProfile[] }>('/automation/profiles'),
  createProfile: (input: Record<string, unknown>) =>
    api.post<AutomationProfile>('/automation/profiles', input),
  updateProfile: (id: string, input: Record<string, unknown>) =>
    api.patch<AutomationProfile>(`/automation/profiles/${id}`, input),
};

export type DecisionOutcome =
  | 'IGNORE'
  | 'RULE_REPLY'
  | 'AI_REPLY'
  | 'HUMAN_HANDOFF'
  | 'HUMAN_HANDLING'
  | 'NO_RESPONSE'
  | 'SUPPRESSED'
  | 'FAILED';

export interface DecisionLog {
  id: string;
  messageId: string;
  conversationId: string | null;
  groupId: string | null;
  customerId: string | null;
  status: string;
  outcome: DecisionOutcome | null;
  reasonCode: string | null;
  reason: string | null;
  ruleId: string | null;
  ruleVersion: number | null;
  candidateRuleIds: string[] | null;
  aiProvider: string | null;
  aiModel: string | null;
  confidence: string | null;
  /** Always false today. Rendered as a caveat, never as a number to be trusted on its own. */
  confidenceCalibrated: boolean;
  knowledgeUsed: boolean;
  knowledgeArticleIds: string[] | null;
  knowledgeChunkIds: string[] | null;
  escalationReason: string | null;
  humanRequired: boolean;
  responseMessageId: string | null;
  processingTimeMs: number | null;
  error: string | null;
  createdAt: string;
  completedAt: string | null;
}

export interface DecisionTrace {
  decision: DecisionLog;
  rule: { id: string; name: string; scopeType: RuleScopeType; priority: number } | null;
  candidateRules: Array<{
    id: string;
    name: string;
    scopeType: RuleScopeType;
    priority: number;
    won: boolean;
  }>;
  executions: Array<{
    id: string;
    ruleId: string;
    ruleVersion: number;
    outcome: string;
    detail: string | null;
    createdAt: string;
  }>;
  aiRun: {
    id: string;
    provider: string;
    model: string;
    status: string;
    promptTokens: number | null;
    completionTokens: number | null;
    latencyMs: number | null;
    confidence: string | null;
    error: string | null;
  } | null;
  escalation: { id: string; reason: string; status: string; createdAt: string } | null;
}

export const decisions = {
  status: () =>
    api.get<{
      ai: { available: boolean; provider: string; model: string | null };
      /** The values in force right now — a stored setting if there is one, the default otherwise. */
      thresholds: { autoReplyMin: number; escalateBelow: number; midPolicy: string };
    }>('/decisions/status'),
  list: (params: { conversationId?: string; outcome?: string; limit?: number; offset?: number } = {}) => {
    const query = new URLSearchParams();
    if (params.conversationId) query.set('conversationId', params.conversationId);
    if (params.outcome) query.set('outcome', params.outcome);
    query.set('limit', String(params.limit ?? 50));
    if (params.offset) query.set('offset', String(params.offset));
    return api.get<{ items: DecisionLog[]; total: number }>(`/decisions?${query.toString()}`);
  },
  trace: (id: string) => api.get<DecisionTrace>(`/decisions/${id}`),
  forMessage: (messageId: string) =>
    api.get<DecisionTrace | { decision: null; note: string }>(`/decisions/message/${messageId}`),
  dryRun: (input: Record<string, unknown>) => api.post<DryRunResult>('/decisions/dry-run', input),
};

export interface Escalation {
  id: string;
  conversationId: string;
  messageId: string | null;
  decisionId: string | null;
  reason: string;
  detail: string | null;
  confidence: string | null;
  status: 'OPEN' | 'ASSIGNED' | 'RESOLVED' | 'DISMISSED';
  assignedToUserId: string | null;
  assignedToTeamId: string | null;
  resolvedAt: string | null;
  resolutionNote: string | null;
  createdAt: string;
}

export const escalations = {
  list: (status?: string) =>
    api.get<{ items: Escalation[]; total: number }>(`/escalations${status ? `?status=${status}` : ''}`),
  get: (id: string) => api.get<Escalation>(`/escalations/${id}`),
  assign: (id: string, input: { userId?: string; teamId?: string }) =>
    api.post<Escalation>(`/escalations/${id}/assign`, input),
  resolve: (id: string, input: { note?: string; releaseToAutomation?: boolean; dismiss?: boolean }) =>
    api.post<Escalation>(`/escalations/${id}/resolve`, input),
};

export type BulkOperation =
  | 'ENABLE_PATTERN_ANALYSIS'
  | 'DISABLE_PATTERN_ANALYSIS'
  | 'ENABLE_AUTOMATION'
  | 'DISABLE_AUTOMATION'
  | 'ENABLE_AI'
  | 'DISABLE_AI'
  | 'ENABLE_MONITORING'
  | 'DISABLE_MONITORING'
  | 'ASSIGN_AUTOMATION_PROFILE'
  | 'CLEAR_AUTOMATION_PROFILE'
  | 'ASSIGN_KNOWLEDGE_PROFILE'
  | 'CLEAR_KNOWLEDGE_PROFILE'
  | 'ENABLE_KNOWLEDGE_COLLECTION'
  | 'DISABLE_KNOWLEDGE_COLLECTION';

export interface BulkRequest {
  operation: BulkOperation;
  groupIds?: string[];
  filter?: { channelAccountId?: string; monitoringState?: string };
  targetId?: string;
}

export interface GroupOperationsRow {
  id: string;
  externalId: string;
  channelAccountId: string;
  name: string | null;
  participantCount: number | null;
  isActive: boolean;
  monitoringState: string;
  aiEnabled: boolean;
  automationEnabled: boolean;
  patternAnalysisEnabled: boolean;
  knowledgeContributionEnabled: boolean;
  knowledgeProfileId: string | null;
  lastMessageAt: string | null;
  /**
   * Activity since midnight.
   *
   * Today rather than all time: an all-time per-group count has to touch every message the group
   * has ever received, and Postgres computes it for every matching group before applying LIMIT.
   * All-time figures live on the group detail screen, where the scope is one group.
   */
  messagesToday: number;
  aiRepliesToday: number;
  humanSupportToday: number;
  /** The same three since the first of the month — one scan, two windows. */
  messagesThisMonth: number;
  aiRepliesThisMonth: number;
  humanSupportThisMonth: number;
  createdAt: string | null;
  /** All-time maxima, computed for the page's rows only. */
  lastAiActivityAt: string | null;
  lastSupportActivityAt: string | null;
}

export interface GroupOperationsSummary {
  total: number;
  aiMonitored: number;
  aiDisabled: number;
  collecting: number;
  /** Counted directly — a group may be PENDING or IGNORED, not merely "not MONITORED". */
  notCollecting: number;
  automationEnabled: number;
  patternAnalysis: number;
  activeToday: number;
  aiSupportedToday: number;
  humanSupportedToday: number;
}

/** Every filter here is applied in SQL. Nothing is narrowed in the browser. */
export interface GroupOperationsFilter {
  channelAccountId?: string;
  monitoringState?: string;
  aiEnabled?: boolean;
  automationEnabled?: boolean;
  patternAnalysisEnabled?: boolean;
  knowledgeContributionEnabled?: boolean;
  /** Groups that have ever received an AI reply. */
  hasAiActivity?: boolean;
  /** Groups a registered support member has ever replied in. */
  hasSupportActivity?: boolean;
  isActive?: boolean;
  /** Groups that received a message since midnight. */
  activeToday?: boolean;
  /** A knowledge profile id, or the literal `none` for groups without one. */
  knowledgeProfileId?: string;
  search?: string;
}

function groupFilterQuery(filter: GroupOperationsFilter): URLSearchParams {
  const query = new URLSearchParams();
  if (filter.channelAccountId) query.set('channelAccountId', filter.channelAccountId);
  if (filter.monitoringState) query.set('monitoringState', filter.monitoringState);
  if (filter.aiEnabled !== undefined) query.set('aiEnabled', String(filter.aiEnabled));
  if (filter.automationEnabled !== undefined) query.set('automationEnabled', String(filter.automationEnabled));
  if (filter.patternAnalysisEnabled !== undefined) {
    query.set('patternAnalysisEnabled', String(filter.patternAnalysisEnabled));
  }
  if (filter.isActive !== undefined) query.set('isActive', String(filter.isActive));
  if (filter.activeToday !== undefined) query.set('activeToday', String(filter.activeToday));
  if (filter.knowledgeContributionEnabled !== undefined) {
    query.set('knowledgeContributionEnabled', String(filter.knowledgeContributionEnabled));
  }
  if (filter.hasAiActivity !== undefined) query.set('hasAiActivity', String(filter.hasAiActivity));
  if (filter.hasSupportActivity !== undefined) {
    query.set('hasSupportActivity', String(filter.hasSupportActivity));
  }
  if (filter.knowledgeProfileId) query.set('knowledgeProfileId', filter.knowledgeProfileId);
  if (filter.search) query.set('search', filter.search);
  return query;
}

export const groupOperations = {
  list: (
    filter: GroupOperationsFilter,
    page: { limit: number; offset: number; sort: string; direction: 'ASC' | 'DESC' },
  ) => {
    const query = groupFilterQuery(filter);
    query.set('limit', String(page.limit));
    query.set('offset', String(page.offset));
    query.set('sort', page.sort);
    query.set('direction', page.direction);
    return api.get<{ items: GroupOperationsRow[]; total: number; limit: number; offset: number }>(
      `/groups/operations/list?${query.toString()}`,
    );
  },

  summary: (since?: string) =>
    api.get<GroupOperationsSummary>(`/groups/operations/summary${since ? `?since=${encodeURIComponent(since)}` : ''}`),

  /**
   * Every id a filter matches, for "select all matching".
   *
   * Resolved on the server so a selection spanning sixty pages never depends on what the browser
   * happens to have loaded.
   */
  matchingIds: (filter: GroupOperationsFilter) =>
    api.get<{ ids: string[]; total: number }>(`/groups/operations/matching-ids?${groupFilterQuery(filter).toString()}`),
};

export const bulk = {
  preview: (input: BulkRequest) =>
    api.post<{ total: number; sample: Array<{ id: string; name: string | null }> }>(
      '/bulk/groups/preview',
      input,
    ),
  apply: (input: BulkRequest) =>
    api.post<{ jobId: string; totalItems: number; operation: BulkOperation }>('/bulk/groups/apply', input),
};

export interface Broadcast {
  id: string;
  name: string;
  body: string;
  channelAccountId: string;
  target: { groupIds?: string[]; conversationIds?: string[] };
  status: 'DRAFT' | 'SCHEDULED' | 'RUNNING' | 'COMPLETED' | 'CANCELLED' | 'FAILED';
  jobId: string | null;
  scheduledAt: string | null;
  startedAt: string | null;
  completedAt: string | null;
  totalCount: number;
  successCount: number;
  failureCount: number;
  cancelledCount: number;
  skippedCount: number;
  /** When somebody last sent themselves a copy — so "did anyone check this?" is answerable. */
  testSentAt: string | null;
  createdAt: string;
}

export const broadcasts = {
  list: (status?: string) =>
    api.get<{ items: Broadcast[] }>(`/broadcasts${status ? `?status=${status}` : ''}`),
  get: (id: string) => api.get<Broadcast>(`/broadcasts/${id}`),
  create: (input: {
    name: string;
    body: string;
    channelAccountId: string;
    target: { groupIds?: string[]; conversationIds?: string[] };
  }) => api.post<Broadcast>('/broadcasts', input),
  start: (id: string) => api.post<Broadcast>(`/broadcasts/${id}/start`),
  cancel: (id: string) => api.post<Broadcast>(`/broadcasts/${id}/cancel`),
};

export interface SettingRow {
  key: string;
  value: unknown;
  valueType: string;
  category: string | null;
  description: string | null;
  isSecret?: boolean;
}

export const settings = {
  list: () => api.get<{ items: SettingRow[] }>('/settings'),
  set: (key: string, value: unknown, valueType?: string, category?: string) =>
    api.put<unknown>(`/settings/${key}`, { value, valueType, category }),
  /** Feature flags and emergency stops with the values actually in force. */
  featureFlags: () =>
    api.get<{ featureFlags: Record<string, boolean>; emergencyStops: Record<string, boolean> }>(
      '/settings/feature-flags',
    ),
};

export interface RoleRow {
  id: string;
  key: string;
  name: string;
  description: string | null;
  isSuperAdmin: boolean;
  permissions: string[];
}

export interface PermissionRow {
  id: string;
  key: string;
  label: string;
  category: string;
  description?: string | null;
}

export const rbac = {
  roles: () => api.get<{ items: RoleRow[] }>('/rbac/roles'),
  permissions: () => api.get<{ items: PermissionRow[]; total: number }>('/rbac/permissions'),
};

export interface JobRow {
  id: string;
  type: string;
  status: 'QUEUED' | 'RUNNING' | 'COMPLETED' | 'COMPLETED_WITH_ERRORS' | 'FAILED' | 'CANCELLED';
  name: string;
  totalItems: number;
  completedItems: number;
  failedItems: number;
  progressPercent: number;
  error: string | null;
  cancelRequested: boolean;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
}

export interface JobItemRow {
  id: string;
  reference: string | null;
  status: string;
  error: string | null;
  attempts: number;
}

/**
 * The Job Center, read-only from here.
 *
 * Bulk changes and broadcasts both return a job id rather than doing the work in the request, so
 * every screen that starts one needs a way to follow it.
 */
export const jobs = {
  get: (id: string) => api.get<JobRow>(`/jobs/${id}`),
  items: (id: string, status?: string) =>
    api.get<{ items: JobItemRow[]; total: number }>(
      `/jobs/${id}/items?limit=50${status ? `&status=${status}` : ''}`,
    ),
  retry: (id: string) => api.post<JobRow>(`/jobs/${id}/retry`),
  cancel: (id: string) => api.post<JobRow>(`/jobs/${id}/cancel`),
};

// === AI providers and configuration (Phase 6) ====================================================

export type AIProviderKind = 'openai' | 'anthropic' | 'gemini' | 'openrouter' | 'compatible';
export type AIJobSlot = 'DECISION' | 'SUMMARY' | 'CLASSIFY';
export type AIConfigScope = 'GLOBAL' | 'PROFILE' | 'GROUP';

export interface AIProviderRow {
  id: string;
  name: string;
  kind: AIProviderKind;
  baseUrl: string | null;
  defaultModel: string | null;
  timeoutMs: number;
  isActive: boolean;
  priority: number;
  /** Whether a credential is stored. The credential itself is never sent to this browser. */
  hasApiKey: boolean;
  lastCheckedAt: string | null;
  lastError: string | null;
  createdAt: string;
}

export interface AIConfigurationRow {
  id: string;
  scopeType: AIConfigScope;
  scopeId: string | null;
  jobSlot: AIJobSlot;
  providerId: string | null;
  model: string | null;
  temperature: string | null;
  maxTokens: number | null;
  tone: string | null;
  language: string | null;
  answerLength: string | null;
  emojiLevel: string | null;
  technicalLevel: string | null;
  systemInstructions: string | null;
}

export interface AITurn {
  id: string;
  decisionId: string | null;
  role: 'SYSTEM' | 'CUSTOMER' | 'ASSISTANT' | 'SUMMARY';
  content: string | null;
  provider: string | null;
  model: string | null;
  jobSlot: AIJobSlot;
  promptTokens: number | null;
  completionTokens: number | null;
  latencyMs: number | null;
  decision: string | null;
  confidence: string | null;
  knowledgeSufficient: boolean | null;
  needsHuman: boolean | null;
  citedIds: string[] | null;
  error: string | null;
  createdAt: string;
}

export const ai = {
  providers: () => api.get<{ items: AIProviderRow[] }>('/ai/providers'),
  createProvider: (input: Record<string, unknown>) => api.post<AIProviderRow>('/ai/providers', input),
  updateProvider: (id: string, input: Record<string, unknown>) =>
    api.patch<AIProviderRow>(`/ai/providers/${id}`, input),
  testProvider: (id: string) => api.post<{ ok: boolean; detail: string }>(`/ai/providers/${id}/test`),
  deleteProvider: (id: string) => api.del<{ deleted: boolean }>(`/ai/providers/${id}`),

  configurations: () => api.get<{ items: AIConfigurationRow[] }>('/ai/configurations'),
  effective: (params: { groupId?: string; profileId?: string } = {}) => {
    const query = new URLSearchParams();
    if (params.groupId) query.set('groupId', params.groupId);
    if (params.profileId) query.set('profileId', params.profileId);
    return api.get<Record<string, unknown>>(`/ai/configurations/effective?${query.toString()}`);
  },
  saveConfiguration: (input: Record<string, unknown>) =>
    api.post<AIConfigurationRow>('/ai/configurations', input),
  deleteConfiguration: (id: string) => api.del<{ deleted: boolean }>(`/ai/configurations/${id}`),

  turns: (conversationId: string) => api.get<{ items: AITurn[] }>(`/ai/conversations/${conversationId}/turns`),
  feedback: (input: Record<string, unknown>) => api.post<unknown>('/ai/feedback', input),
  listFeedback: (verdict?: string) =>
    api.get<{ items: Array<{ id: string; verdict: string; note: string | null; createdAt: string }>; total: number }>(
      `/ai/feedback${verdict ? `?verdict=${verdict}` : ''}`,
    ),
};

// === reports, copilot, candidates, rate limits, escalation config (Phases 9–11) ==================

export interface DashboardReport {
  window: { from: string; to: string };
  conversations: { total: number; byStatus: Record<string, number>; humanHandled: number };
  decisions: {
    total: number;
    byOutcome: Record<string, number>;
    answeredAutomatically: number;
    /** Null when nothing has happened yet — not zero per cent. */
    automationRate: number | null;
  };
  escalations: { total: number; byReason: Record<string, number>; openNow: number };
  timing: { firstResponseSeconds: number | null; resolutionSeconds: number | null };
  health: { monitoredGroups: number; failedJobs: number; failedOutbound: number };
}

export interface TeamPerformanceRow {
  userId: string | null;
  name: string | null;
  conversations: number;
  resolved: number;
  groupsSupported: number;
  uniqueCustomers: number;
  activeDays: number;
}

export interface BroadcastReportRow {
  id: string;
  name: string;
  status: string;
  startedAt: string | null;
  total: number;
  sent: number;
  failed: number;
  skipped: number;
  successRate: number | null;
}

export interface AiPerformanceReport {
  byOutcome: Record<string, { count: number; averageMs: number | null }>;
  humanVerdicts: Record<string, number>;
  note: string;
}

function windowQuery(params: { from?: string; to?: string } = {}): string {
  const query = new URLSearchParams();
  if (params.from) query.set('from', params.from);
  if (params.to) query.set('to', params.to);
  return query.toString();
}

export interface ActivityTrendPoint {
  day: string;
  conversations: number;
  automated: number;
  escalations: number;
}

export const reports = {
  dashboard: (params?: { from?: string; to?: string }) =>
    api.get<DashboardReport>(`/reports/dashboard?${windowQuery(params)}`),
  activityTrend: (params?: { from?: string; to?: string }) =>
    api.get<{ items: ActivityTrendPoint[] }>(`/reports/activity-trend?${windowQuery(params)}`),
  team: (params?: { from?: string; to?: string }) =>
    api.get<{ items: TeamPerformanceRow[] }>(`/reports/team-performance?${windowQuery(params)}`),
  topIssues: (params?: { from?: string; to?: string }) =>
    api.get<{ items: Array<{ reason: string; count: number }> }>(`/reports/top-issues?${windowQuery(params)}`),
  knowledgeGaps: (params?: { from?: string; to?: string }) =>
    api.get<{ items: Array<{ detail: string | null; count: number }> }>(
      `/reports/knowledge-gaps?${windowQuery(params)}`,
    ),
  broadcasts: (params?: { from?: string; to?: string }) =>
    api.get<{ items: BroadcastReportRow[] }>(`/reports/broadcasts?${windowQuery(params)}`),
  aiPerformance: (params?: { from?: string; to?: string }) =>
    api.get<AiPerformanceReport>(`/reports/ai-performance?${windowQuery(params)}`),
  /** A download URL rather than a fetch: the browser handles the file, and the cookie goes with it. */
  exportUrl: (report: string, params?: { from?: string; to?: string }) =>
    `${API_URL}/api/v1/reports/export/${report}?${windowQuery(params)}`,
};

export interface CopilotTool {
  name: string;
  kind: 'READ' | 'WRITE';
  description: string;
  permission: string;
  parameters: Array<{ name: string; type: string; required: boolean }>;
}

export interface CopilotAction {
  id: string;
  prompt: string;
  tool: string | null;
  arguments: Record<string, unknown> | null;
  kind: 'READ' | 'WRITE';
  status: 'PROPOSED' | 'EXECUTED' | 'CONFIRMED' | 'REJECTED' | 'FAILED' | 'EXPIRED';
  /** Stated before a write is confirmed: "this affects 500 groups". */
  blastRadius: string | null;
  result: string | null;
  error: string | null;
  createdAt: string;
}

export interface CopilotAnswer {
  answered: boolean;
  message: string;
  action?: CopilotAction;
  suggestions: Array<{ name: string; description: string }>;
}

export const copilot = {
  tools: () => api.get<{ items: CopilotTool[] }>('/copilot/tools'),
  ask: (question: string) => api.post<CopilotAnswer>('/copilot/ask', { question }),
  invoke: (input: { prompt: string; tool: string; arguments?: Record<string, unknown> }) =>
    api.post<CopilotAction>('/copilot/invoke', input),
  confirm: (id: string) => api.post<CopilotAction>(`/copilot/${id}/confirm`, {}),
  reject: (id: string) => api.post<CopilotAction>(`/copilot/${id}/reject`, {}),
  history: () => api.get<{ items: CopilotAction[]; total: number }>('/copilot/history'),
};

export interface AutomationCandidate {
  id: string;
  title: string;
  rationale: string | null;
  source: 'PATTERN' | 'AI_SUGGESTED' | 'FEEDBACK' | 'MANUAL';
  proposedConditions: RuleConditionSet | null;
  proposedActions: RuleAction[] | null;
  occurrences: number;
  sampleMessageIds: string[] | null;
  status: 'PENDING' | 'APPROVED' | 'REJECTED' | 'PUBLISHED';
  publishedRuleId: string | null;
  reviewNote: string | null;
  createdAt: string;
}

export const candidates = {
  list: (status?: string) =>
    api.get<{ items: AutomationCandidate[]; total: number }>(
      `/automation/candidates${status ? `?status=${status}` : ''}`,
    ),
  detect: (input: { sinceDays?: number; limit?: number } = {}) =>
    api.post<{ examined: number; created: number; updated: number }>('/automation/candidates/detect', input),
  evidence: (id: string) =>
    api.get<{ items: Array<{ id: string; body: string | null; sentAt: string }> }>(
      `/automation/candidates/${id}/evidence`,
    ),
  publish: (id: string, input: { title?: string; note?: string; conditions?: unknown; actions?: unknown }) =>
    api.post<{ candidateId: string; rule: AutomationRule }>(`/automation/candidates/${id}/publish`, input),
  reject: (id: string, note?: string) =>
    api.post<AutomationCandidate>(`/automation/candidates/${id}/reject`, { note }),
};

export type RateLimitScope =
  | 'SESSION'
  | 'GROUP'
  | 'DESTINATION'
  | 'BROADCAST'
  | 'AUTOMATION'
  | 'AI'
  | 'API';

export interface EffectiveRateLimit {
  scope: RateLimitScope;
  limit: number;
  windowSeconds: number;
  source: 'policy' | 'default';
}

export const rateLimits = {
  effective: () =>
    api.get<{
      items: EffectiveRateLimit[];
      overrides: Array<{ id: string; scope: RateLimitScope; scopeId: string | null; limit: number; windowSeconds: number; note: string | null }>;
    }>('/settings/rate-limits'),
  set: (input: { scope: RateLimitScope; scopeId?: string; limit: number; windowSeconds: number; note?: string }) =>
    api.post<unknown>('/settings/rate-limits', input),
};

export interface EscalationPolicy {
  internalGroupId?: string | null;
  primaryExecutiveUserId?: string | null;
  secondaryExecutiveUserId?: string | null;
  notifyInternalGroup?: boolean;
  notifyExecutives?: boolean;
  notifyCustomer?: boolean;
  customerNotice?: string | null;
  maxAiAttempts?: number;
  maxAiReplies?: number;
  maxConsecutiveAiReplies?: number;
  humanReplyCooldownSeconds?: number;
  escalationScoreThreshold?: number;
  guidance?: string | null;
}

export const escalationConfig = {
  defaults: () => api.get<EscalationPolicy>('/escalations/config/defaults'),
  global: () => api.get<{ stored: EscalationPolicy; effective: EscalationPolicy }>('/escalations/config/global'),
  setGlobal: (policy: EscalationPolicy) =>
    api.put<{ stored: EscalationPolicy; effective: EscalationPolicy }>('/escalations/config/global', policy),
  effective: (groupId?: string) =>
    api.get<{
      layers: {
        defaults: EscalationPolicy;
        global: EscalationPolicy;
        profile: EscalationPolicy | null;
        group: EscalationPolicy | null;
      };
      effective: EscalationPolicy;
    }>(`/escalations/config/effective${groupId ? `?groupId=${groupId}` : ''}`),
  setGroup: (groupId: string, policy: EscalationPolicy) =>
    api.put<unknown>(`/escalations/config/group/${groupId}`, policy),
  events: (escalationId: string) =>
    api.get<{ items: Array<{ id: string; kind: string; target: string; status: string; detail: string | null; sentAt: string | null }> }>(
      `/escalations/config/${escalationId}/events`,
    ),
};

export interface OnboardingRule {
  id: string;
  name: string;
  nameContains: string | null;
  channelAccountId: string | null;
  priority: number;
  isActive: boolean;
  automationProfileId: string | null;
  monitoringState: string | null;
  automationEnabled: boolean | null;
  aiEnabled: boolean | null;
  matchCount: number;
  lastMatchedAt: string | null;
}

export const onboarding = {
  list: () => api.get<{ items: OnboardingRule[] }>('/groups/onboarding-rules'),
  preview: (input: { nameContains?: string; channelAccountId?: string }) =>
    api.post<{ total: number; sample: Array<{ id: string; name: string | null }> }>(
      '/groups/onboarding-rules/preview',
      { name: 'preview', ...input },
    ),
  create: (input: Record<string, unknown>) => api.post<OnboardingRule>('/groups/onboarding-rules', input),
  update: (id: string, input: Record<string, unknown>) =>
    api.patch<OnboardingRule>(`/groups/onboarding-rules/${id}`, input),
  remove: (id: string) => api.del<{ deleted: boolean }>(`/groups/onboarding-rules/${id}`),
};

export interface EmergencySwitch {
  key: string;
  label: string;
  description: string;
  engaged: boolean;
}

export const emergency = {
  list: () => api.get<{ items: EmergencySwitch[]; pendingOutbound: number }>('/emergency'),
  set: (key: string, engaged: boolean, confirm: string) =>
    api.post<{ engaged: boolean; cancelled: number }>('/emergency', { key, engaged, confirm }),
};

export interface BroadcastRecipient {
  id: string;
  externalConversationId: string;
  displayName: string | null;
  status: 'PENDING' | 'QUEUED' | 'SENT' | 'DELIVERED' | 'FAILED' | 'SKIPPED' | 'CANCELLED';
  failureReason: string | null;
  skippedReason: string | null;
  sentAt: string | null;
}

export const broadcastExtras = {
  preview: (id: string) =>
    api.get<{
      total: number;
      sample: Array<{ externalConversationId: string; displayName: string | null }>;
      exclusions: Array<{ reason: string; count: number }>;
    }>(`/broadcasts/${id}/preview`),
  recipients: (id: string, status?: string) =>
    api.get<{ items: BroadcastRecipient[]; total: number }>(
      `/broadcasts/${id}/recipients${status ? `?status=${status}` : ''}`,
    ),
  test: (id: string, externalConversationId: string) =>
    api.post<Broadcast>(`/broadcasts/${id}/test`, { externalConversationId }),
};

export interface AiCustomerFact {
  id: string;
  fact: string;
  source: string;
  approvedAt: string | null;
  isActive: boolean;
  createdAt: string;
}

export const aiMemory = {
  conversation: (conversationId: string) =>
    api.get<{ conversationId: string; summary: string | null; turnCount: number; lastTurnAt?: string | null }>(
      `/ai/conversations/${conversationId}/memory`,
    ),
  facts: (customerId: string) => api.get<{ items: AiCustomerFact[] }>(`/ai/customers/${customerId}/facts`),
  addFact: (customerId: string, fact: string) =>
    api.post<AiCustomerFact>(`/ai/customers/${customerId}/facts`, { fact }),
  approveFact: (id: string) => api.post<AiCustomerFact>(`/ai/facts/${id}/approve`, {}),
  retireFact: (id: string) => api.post<AiCustomerFact>(`/ai/facts/${id}/retire`, {}),
};

// === conversations, messages, customers (Phase 3) =================================================

export type ConversationStatusValue = 'OPEN' | 'PENDING' | 'WAITING_FOR_CUSTOMER' | 'WAITING_FOR_HUMAN' | 'RESOLVED' | 'CLOSED';
export type ConversationControlStateValue = 'AUTOMATION_ACTIVE' | 'AI_ACTIVE' | 'HUMAN_ACTIVE' | 'PAUSED';
export type ConversationKindValue = 'DIRECT' | 'GROUP';
export type ConversationPriorityValue = 'LOW' | 'NORMAL' | 'HIGH' | 'URGENT';
export type SpecConversationState =
  | 'AUTOMATION_ACTIVE'
  | 'AI_ACTIVE'
  | 'HUMAN_ACTIVE'
  | 'HUMAN_REQUIRED'
  | 'PAUSED'
  | 'WAITING_CUSTOMER'
  | 'RESOLVED';

export interface Conversation {
  id: string;
  channelKey: string;
  channelAccountId: string;
  externalConversationId: string;
  kind: ConversationKindValue;
  groupId: string | null;
  customerId: string | null;
  subject: string | null;
  status: ConversationStatusValue;
  priority: ConversationPriorityValue;
  controlState: ConversationControlStateValue;
  aiEnabled: boolean;
  automationEnabled: boolean;
  pausedUntil: string | null;
  takeoverByUserId: string | null;
  takeoverReason: string | null;
  takeoverAt: string | null;
  assignedToUserId: string | null;
  assignedToTeamId: string | null;
  lastMessageAt: string | null;
  lastInboundAt: string | null;
  lastOutboundAt: string | null;
  messageCount: number;
  isPinned: boolean;
  resolvedAt: string | null;
  specState: SpecConversationState;
  createdAt: string;
  updatedAt: string;
  /** Present on the inbox list only — the newest message, truncated server-side. */
  lastMessagePreview?: string | null;
  lastMessageDirection?: MessageDirectionValue | null;
  unreadCount?: number;
  firstUnreadMessageId?: string | null;
  markedUnread?: boolean;
  isArchived?: boolean;
}

export interface ConversationWithTags extends Conversation {
  tags: Array<{ id: string; key: string; label: string; color: string | null }>;
}

export type MessageDirectionValue = 'INBOUND' | 'OUTBOUND';

export interface ConversationMessage {
  presentation?:{[key:string]:unknown;kind?:string;details?:Record<string,unknown>;editedBody?:string;editedAt?:string;revokedAt?:string;deletedAt?:string;starred?:boolean;reactions?:Record<string,string>;pollVotes?:Record<string,string[]>;forwarded?:boolean;viewOnce?:boolean};
  id: string;
  externalId: string;
  quotedExternalId?: string | null;
  quotedMessageId?:string|null;
  direction: MessageDirectionValue;
  contentType: string;
  body: string | null;
  senderDisplayName: string | null;
  senderPhone: string | null;
  fromAccount: boolean;
  sentAt: string;
  deliveryStatus: string | null;
}

export const conversations = {
  list: (
    params: {
      status?: ConversationStatusValue;
      kind?: ConversationKindValue;
      search?: string;
      channelAccountId?: string;
      unassignedOnly?: boolean;
      limit?: number;
      offset?: number;
    } = {},
  ) => {
    const query = new URLSearchParams();
    if (params.status) query.set('status', params.status);
    if (params.kind) query.set('kind', params.kind);
    if (params.search) query.set('search', params.search);
    if (params.channelAccountId) query.set('channelAccountId', params.channelAccountId);
    if (params.unassignedOnly) query.set('unassignedOnly', 'true');
    query.set('limit', String(params.limit ?? 50));
    if (params.offset) query.set('offset', String(params.offset));
    return api.get<{ items: Conversation[]; total: number }>(`/conversations?${query.toString()}`);
  },
  get: (id: string) => api.get<ConversationWithTags>(`/conversations/${id}`),
  messages: (id: string, params: { limit?: number; before?: string; beforeId?: string } = {}) => {
    const query = new URLSearchParams();
    query.set('limit', String(params.limit ?? 50));
    if (params.before) query.set('before', params.before);
    if (params.beforeId) query.set('beforeId', params.beforeId);
    return api.get<{ items: ConversationMessage[]; hasMore: boolean; nextCursor: string | null; nextCursorId: string | null }>(
      `/conversations/${id}/messages?${query.toString()}`,
    );
  },
  setStatus: (id: string, status: ConversationStatusValue, reason?: string) =>
    api.post<Conversation>(`/conversations/${id}/status`, { status, reason }),
  takeover: (id: string, input: { reason?: string; expiresInMinutes?: number } = {}) =>
    api.post<Conversation>(`/conversations/${id}/takeover`, input),
  release: (id: string, input: { releaseTo?: ConversationControlStateValue; reason?: string } = {}) =>
    api.post<Conversation>(`/conversations/${id}/release`, input),
  addTag: (id: string, tagKey: string) => api.post(`/conversations/${id}/tags`, { tagKey }),
};

export const messages = {
  /**
   * Reads persisted messages. Inspection only — this cannot cause a send.
   *
   * Filtering happens in Postgres against indexed columns, so a group with a long history costs the
   * same as a quiet one. `classification` is what separates "what the AI answered" from "what a
   * person answered" without a second endpoint for each.
   */
  list: (
    params: {
      groupId?: string;
      channelAccountId?: string;
      classification?: MessageClassificationValue;
      direction?: MessageDirectionValue;
      /** A sender's stable provider id — never their display name, which they can change. */
      senderExternalId?: string;
      /** Half-open window: `>= sentAfter AND < sentBefore`. */
      sentAfter?: string;
      sentBefore?: string;
      search?: string;
      limit?: number;
      offset?: number;
    } = {},
  ) => {
    const query = new URLSearchParams();
    if (params.groupId) query.set('groupId', params.groupId);
    if (params.channelAccountId) query.set('channelAccountId', params.channelAccountId);
    if (params.classification) query.set('classification', params.classification);
    if (params.direction) query.set('direction', params.direction);
    if (params.senderExternalId) query.set('senderExternalId', params.senderExternalId);
    if (params.sentAfter) query.set('sentAfter', params.sentAfter);
    if (params.sentBefore) query.set('sentBefore', params.sentBefore);
    if (params.search) query.set('search', params.search);
    query.set('limit', String(params.limit ?? 50));
    query.set('offset', String(params.offset ?? 0));
    return api.get<{ items: InspectedMessage[]; total: number; limit: number; offset: number }>(
      `/messages?${query.toString()}`,
    );
  },

  send: (input: {
    channelAccountId: string;
    externalConversationId: string;
    body: string;
    quotedExternalId?: string;
    idempotencyKey?: string;
  }) => api.post<{ id: string; status: string }>('/messages', input),
};

export type CustomerStatusValue = 'ACTIVE' | 'INACTIVE' | 'PROSPECT';

export interface Customer {
  id: string;
  code: string;
  country: string | null;
  serviceName: string | null;
  accountOwnerId: string | null;
  accountOwner?: { id: string; name: string; username: string; isActive: boolean } | null;
  displayName: string;
  primaryPhone: string | null;
  email: string | null;
  company: string | null;
  status: CustomerStatusValue;
  source: 'MANUAL' | 'IMPORT' | 'CHANNEL';
  createdAt: string;
  updatedAt: string;
}

export interface CustomerWithTags extends Customer {
  tags: Array<{ id: string; key: string; label: string; color: string | null }>;
}

export interface CustomerIdentity {
  id: string;
  channelKey: string;
  externalId: string;
  phone: string;
  displayName: string | null;
  customerId: string | null;
  matchState: 'UNRESOLVED' | 'CANDIDATE' | 'CONFIRMED' | 'REJECTED';
  lastSeenAt: string | null;
}

export interface CustomerNote {
  id: string;
  customerId: string;
  body: string;
  authorId: string | null;
  authorUsername: string | null;
  isPinned: boolean;
  createdAt: string;
}

export interface CustomerInput { displayName: string; code?: string; primaryPhone?: string | null; email?: string | null; company?: string | null; country?: string | null; serviceName?: string | null; accountOwnerId?: string | null; status?: CustomerStatusValue }
export interface CustomerQuery { search?: string; status?: CustomerStatusValue; limit?: number; offset?: number; country?: string; accountOwnerId?: string; unassigned?: string }
function customerQuery(params: CustomerQuery) {
    const query = new URLSearchParams();
    if (params.search) query.set('search', params.search);
    if (params.status) query.set('status', params.status);
    if (params.country) query.set('country', params.country);
    if (params.accountOwnerId) query.set('accountOwnerId', params.accountOwnerId);
    if (params.unassigned) query.set('unassigned',params.unassigned);
    query.set('limit', String(params.limit ?? 50));
    if (params.offset) query.set('offset', String(params.offset));
    return query.toString();
}
export const customers = {
  list: (params: CustomerQuery = {}) => api.get<{ items: Customer[]; total: number }>(`/customers?${customerQuery(params)}`),
  exportUrl: (params: CustomerQuery = {}) => `${API_URL}/api/v1/customers/directory/export?${customerQuery(params)}`,
  templateUrl: `${API_URL}/api/v1/customers/directory/template`,
  owners: () => api.get<{ items: Array<{ id: string; name: string; username: string }> }>('/customers/directory/owners'),
  get: (id: string) => api.get<CustomerWithTags>(`/customers/${id}`),
  create: (input: CustomerInput) =>
    api.post<Customer>('/customers', input),
  update: (
    id: string,
    input: Partial<Omit<CustomerInput,'code'>>,
  ) => api.patch<Customer>(`/customers/${id}`, input),
  identities: (customerId: string) =>
    api.get<{ items: CustomerIdentity[]; total: number }>(`/customers/identities/list?customerId=${customerId}`),
  /**
   * Every channel identity Support CRM has seen, newest activity first.
   *
   * This is the WhatsApp contact directory: one row per phone number the system has encountered,
   * whether or not anybody has attributed it to a customer yet.
   */
  allIdentities: (params: { search?: string; limit?: number } = {}) => {
    const query = new URLSearchParams();
    if (params.search) query.set('search', params.search);
    query.set('limit', String(params.limit ?? 100));
    return api.get<{ items: CustomerIdentity[]; total: number }>(`/customers/identities/list?${query.toString()}`);
  },
  notes: (customerId: string) => api.get<{ items: CustomerNote[]; total: number }>(`/customers/${customerId}/notes`),
  addNote: (customerId: string, body: string, isPinned = false) =>
    api.post<CustomerNote>(`/customers/${customerId}/notes`, { body, isPinned }),
  addTag: (customerId: string, tagKey: string) => api.post(`/customers/${customerId}/tags`, { tagKey }),
  removeTag: (customerId: string, tagKey: string) => api.post(`/customers/${customerId}/tags/remove`, { tagKey }),
};

// === system health and audit ======================================================================

export type ComponentStatus = 'HEALTHY' | 'WARNING' | 'CRITICAL';

export interface HealthComponent {
  status: ComponentStatus;
  detail?: string;
  latencyMs?: number;
}

export interface HealthReport {
  status: ComponentStatus;
  uptimeSeconds: number;
  components: Record<string, HealthComponent>;
}

export const health = {
  /** The real dependency states — the same values the container healthchecks read. */
  full: () => api.get<HealthReport>('/health'),
};

export interface AuditEntry {
  id: string;
  actorId: string | null;
  actorUsername: string | null;
  action: string;
  resource: string;
  resourceId: string | null;
  success: boolean;
  createdAt: string;
}

export const audit = {
  list: (params: { limit?: number; offset?: number; resource?: string } = {}) => {
    const query = new URLSearchParams();
    query.set('limit', String(params.limit ?? 50));
    if (params.offset) query.set('offset', String(params.offset));
    if (params.resource) query.set('resource', params.resource);
    return api.get<{ items: AuditEntry[]; total: number }>(`/audit?${query.toString()}`);
  },
};
