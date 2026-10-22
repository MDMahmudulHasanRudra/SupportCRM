import { api } from './client';

export interface QueueOverview { open: number; mine: number; unassigned: number; waitingForHuman: number }
export interface Invoice { id: string; number: string; customerId: string; customerName: string; description: string; currency: string; amountMinor: string; paidMinor: string; balanceMinor: string; dueDate: string; status: string }
export interface Payment { id: string; invoiceId: string; number: string; customerName: string; currency: string; amountMinor: string; reference: string; reversedAt: string | null; reversalReason: string | null; createdAt: string }
export interface Subscription { id: string; customerName: string; name: string; status: string; displayStatus: string; startsOn: string; endsOn: string }
export interface BillingOverview { invoices: Invoice[]; payments: Payment[]; subscriptions: Subscription[]; totals: Array<{ currency: string; invoicedMinor: string; paidMinor: string; balanceMinor: string }> }
export interface Person { id: string; name: string }
export interface Shift { id: string; userId: string; userName: string; startsAt: string; endsAt: string; label: string; onLeave: boolean; cancelledAt: string | null; cancellationReason: string | null }
export interface ShiftEvent { id: string; action: string; actorName: string; createdAt: string; before: Shift; after: Shift }
export interface WorkforceOverview {
  people: Person[];
  teams: Array<{ id: string; name: string; description: string; isActive: boolean; members: Array<{ id: string; userId: string; name: string }> }>;
  shifts: Shift[];
  leave: Array<{ id: string; userName: string; startsOn: string; endsOn: string; reason: string; status: string }>;
}
export interface Notification { id: string; title: string; body: string; href: string | null; readAt: string | null; createdAt: string }
export interface SavedReply { id: string; title: string; body: string }
export interface Release { id: string; version: string; title: string; body: string; status: 'DRAFT' | 'PUBLISHED' | 'ARCHIVED'; publishedAt: string | null; createdAt: string }
export interface HistoryEntry { id: string; action?: string; createdAt: string; detail?: unknown; snapshot?: unknown }

export const workspace = {
  overview: () => api.get<QueueOverview>('/workspace/overview'),
  billing: () => api.get<BillingOverview>('/workspace/billing'),
  invoice: (dto: { customerId: string; description: string; currency: string; amountMinor: number; dueDate: string }) => api.post('/workspace/billing/invoices', dto),
  pay: (dto: { invoiceId: string; amountMinor: number; reference: string; idempotencyKey: string }) => api.post('/workspace/billing/payments', dto),
  reverse: (id: string, reason: string) => api.post(`/workspace/billing/payments/${id}/reverse`, { reason }),
  subscribe: (dto: { customerId: string; name: string; status: string; startsOn: string; endsOn: string }) => api.post('/workspace/billing/subscriptions', dto),
  subscriptionAction: (id: string, action: string, endsOn?: string) => api.post(`/workspace/billing/subscriptions/${id}/action`, { action, endsOn }),
  subscriptionHistory: (id: string) => api.get<{ items: HistoryEntry[] }>(`/workspace/billing/subscriptions/${id}/history`),
  workforce: () => api.get<WorkforceOverview>('/workspace/workforce'),
  people: () => api.get<{ items: Person[] }>('/workspace/assignees'),
  team: (name: string, description: string) => api.post('/workspace/workforce/teams', { name, description }),
  disableTeam: (id: string) => api.post(`/workspace/workforce/teams/${id}/disable`),
  member: (id: string, userId: string, remove = false) => api.post(`/workspace/workforce/teams/${id}/members${remove ? '/remove' : ''}`, { userId }),
  shift: (dto: { userId: string; startsAt: string; endsAt: string; label: string }) => api.post('/workspace/workforce/shifts', dto),
  updateShift: (id: string, dto: { userId: string; startsAt: string; endsAt: string; label: string }) => api.put(`/workspace/workforce/shifts/${id}`, dto),
  cancelShift: (id: string, reason: string) => api.post(`/workspace/workforce/shifts/${id}/cancel`, { reason }),
  shiftHistory: (id: string) => api.get<{ items: ShiftEvent[] }>(`/workspace/workforce/shifts/${id}/history`),
  leave: (dto: { userId: string; startsOn: string; endsOn: string; reason: string }) => api.post('/workspace/workforce/leave', dto),
  reviewLeave: (id: string, status: string) => api.post(`/workspace/workforce/leave/${id}/review`, { status }),
  notifications: () => api.get<{ items: Notification[]; unread: number }>('/workspace/notifications'),
  readNotification: (id: string) => api.post(`/workspace/notifications/${id}/read`),
  readAll: () => api.post('/workspace/notifications/read-all'),
  replies: () => api.get<{ items: SavedReply[] }>('/workspace/saved-replies'),
  saveReply: (title: string, body: string) => api.post<SavedReply>('/workspace/saved-replies', { title, body }),
  deleteReply: (id: string) => api.del(`/workspace/saved-replies/${id}`),
  drafts: () => api.get<{ items: Array<{ destinationKey: string; body: string }> }>('/workspace/drafts'),
  draft: (destinationKey: string, body: string) => api.put('/workspace/drafts', { destinationKey, body }),
  releases: (manage = false) => api.get<{ items: Release[] }>(`/workspace/releases${manage ? '/manage' : ''}`),
  release: (dto: { version: string; title: string; body: string }) => api.post('/workspace/releases', dto),
  updateRelease: (id: string, dto: { version: string; title: string; body: string; status: string }) => api.put(`/workspace/releases/${id}`, dto),
  releaseHistory: (id: string) => api.get<{ items: HistoryEntry[] }>(`/workspace/releases/${id}/history`),
  restoreRelease: (id: string, versionId: string) => api.post(`/workspace/releases/${id}/restore`, { versionId }),
};

/** Exact integer minor units. Currency exponent is provided by Intl, including JPY and KWD. */
export function currencyDigits(currency: string): number {
  return new Intl.NumberFormat('en', { style: 'currency', currency }).resolvedOptions().maximumFractionDigits ?? 2;
}
export function money(value: string | number, currency: string): string {
  const minor = BigInt(value); const digits = currencyDigits(currency); const scale = 10n ** BigInt(digits);
  const whole = minor / scale; const remainder = (minor < 0n ? -minor : minor) % scale;
  const formatter = new Intl.NumberFormat('en', { style: 'currency', currency });
  return formatter.formatToParts(minor < 0n && whole === 0n ? -0 : whole)
    .map(p => p.type === 'fraction' ? remainder.toString().padStart(digits, '0') : p.value).join('');
}
export function toMinor(value: string, currency: string): number {
  const digits = currencyDigits(currency);
  const pattern = digits ? new RegExp(`^\\d+(?:\\.\\d{1,${digits}})?$`) : /^\d+$/;
  if (!pattern.test(value)) throw new Error(`Enter an amount with at most ${digits} decimal places.`);
  const [whole, fraction = ''] = value.split('.');
  const minor = Number(BigInt(whole) * 10n ** BigInt(digits) + BigInt(fraction.padEnd(digits, '0') || '0'));
  if (!Number.isSafeInteger(minor) || minor < 1 || minor > 100000000000) throw new Error('Enter an amount greater than zero and within the supported limit.');
  return minor;
}
export const shortDate = (value: string) => new Date(value).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'Asia/Dhaka' });
