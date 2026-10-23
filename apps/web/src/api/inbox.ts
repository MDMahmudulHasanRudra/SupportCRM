import { api } from './client';
export interface InboxMetadata { conversationId:string; unreadCount:number; firstUnreadMessageId:string|null; markedUnread:boolean; isArchived:boolean }
export type InboxAction='ARCHIVE'|'UNARCHIVE'|'MARK_UNREAD'|'PIN'|'UNPIN';
export const inbox={
  read:(id:string,messageIds:string[])=>api.post<InboxMetadata>(`/inbox/conversations/${id}/read`,{messageIds}),
  organize:(conversationIds:string[],action:InboxAction)=>api.post<{changed:number;action:InboxAction}>(`/inbox/${action==='PIN'||action==='UNPIN'?'pin':'organize'}`,{conversationIds,action}),
};
