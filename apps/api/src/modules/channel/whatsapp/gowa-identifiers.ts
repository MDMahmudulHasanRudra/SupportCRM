/** Keep the CRM's established contact addresses stable across the transport replacement. */
export const crmJid = (value: unknown): string => typeof value === 'string' ? value.replace(/@s\.whatsapp\.net$/, '@c.us') : '';
export const providerJid = (value: string): string => value.replace(/@c\.us$/, '@s.whatsapp.net');
export const providerMessageId = (value: string | undefined): string | undefined => value?.replace(/^(?:true|false)_[^_]+_(.+)$/, '$1');
