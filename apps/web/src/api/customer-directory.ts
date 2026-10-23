import { api } from './client';
export interface ImportPreview {
  valid: boolean; warningCount: number; expiresAt: string; previewToken: string | null;
  rows: Array<{ record: number; values: Record<string,string>; errors: string[]; warnings: string[] }>;
}
export const customerDirectory = {
  preview: (csv: string) => api.post<ImportPreview>('/customers/directory/import/preview',{csv}),
  commit: (csv: string, previewToken: string, acknowledgeSharedContacts: boolean) => api.post<{ createdCount: number; customerIds: string[]; replayed: boolean }>('/customers/directory/import/commit',{csv,previewToken,acknowledgeSharedContacts}),
};
