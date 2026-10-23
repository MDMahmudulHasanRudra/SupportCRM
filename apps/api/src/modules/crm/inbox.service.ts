import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { RealtimeGateway } from '../realtime/realtime.gateway';
export interface InboxMetadata { unreadCount:number; firstUnreadMessageId:string|null; markedUnread:boolean; isArchived:boolean }
export const EMPTY_INBOX:InboxMetadata={unreadCount:0,firstUnreadMessageId:null,markedUnread:false,isArchived:false};

@Injectable()
export class InboxService {
  constructor(private readonly db:DataSource,private readonly realtime:RealtimeGateway) {}
  async metadata(ids:string[],userId:string):Promise<Map<string,InboxMetadata>> {
    const map=new Map(ids.map(id=>[id,{...EMPTY_INBOX}])); if(!ids.length) return map;
    const [preferences,unread]=await Promise.all([
      this.db.query<Array<{conversationId:string;isArchived:boolean;markedUnread:boolean}>>('SELECT "conversationId","isArchived","markedUnread" FROM conversation_user_state WHERE "userId"=$1 AND "conversationId"=ANY($2::uuid[])',[userId,ids]),
      this.db.query<Array<{conversationId:string;unreadCount:number;firstUnreadMessageId:string}>>(`SELECT DISTINCT ON (m."conversationId") m."conversationId",
        (COUNT(*) OVER (PARTITION BY m."conversationId"))::int AS "unreadCount",m.id AS "firstUnreadMessageId"
        FROM messages m WHERE m."conversationId"=ANY($2::uuid[]) AND m.direction='INBOUND' AND m."contentType"<>'SYSTEM_EVENT'
        AND NOT EXISTS(SELECT 1 FROM message_user_reads r WHERE r."messageId"=m.id AND r."userId"=$1)
        ORDER BY m."conversationId",m."sentAt",m.id`,[userId,ids]),
    ]);
    for(const p of preferences) map.set(p.conversationId,{...map.get(p.conversationId)!,isArchived:p.isArchived,markedUnread:p.markedUnread});
    for(const u of unread) map.set(u.conversationId,{...map.get(u.conversationId)!,unreadCount:u.unreadCount,firstUnreadMessageId:u.firstUnreadMessageId});
    return map;
  }
  async read(conversationId:string,messageIds:string[],userId:string) {
    await this.db.transaction(async tx=>{
      const [conversation]=await tx.query('SELECT id FROM conversations WHERE id=$1',[conversationId]);
      if(!conversation) throw new NotFoundException('Conversation not found.');
      const messages=messageIds.length ? await tx.query<Array<{id:string;direction:string;contentType:string}>>('SELECT id,direction,"contentType" FROM messages WHERE "conversationId"=$1 AND id=ANY($2::uuid[])',[conversationId,messageIds]) : [];
      if(messages.length!==messageIds.length) throw new BadRequestException('Every message must belong to this conversation.');
      await tx.query(`INSERT INTO conversation_user_state ("userId","conversationId","markedUnread") VALUES ($1,$2,false)
        ON CONFLICT ("userId","conversationId") DO UPDATE SET "markedUnread"=false,"updatedAt"=now()`,[userId,conversationId]);
      const ids=messages.filter(m=>m.direction==='INBOUND' && m.contentType!=='SYSTEM_EVENT').map(m=>m.id);
      if(ids.length) await tx.query(`INSERT INTO message_user_reads ("userId","messageId") SELECT $1,unnest($2::uuid[]) ON CONFLICT DO NOTHING`,[userId,ids]);
    });
    return {conversationId,...(await this.metadata([conversationId],userId)).get(conversationId)!};
  }
  async organize(ids:string[],action:'ARCHIVE'|'UNARCHIVE'|'MARK_UNREAD'|'PIN'|'UNPIN',userId:string) {
    await this.db.transaction(async tx=>{
      const found=await tx.query<Array<{id:string}>>('SELECT id FROM conversations WHERE id=ANY($1::uuid[]) ORDER BY id FOR UPDATE',[ids]);
      if(found.length!==ids.length) throw new NotFoundException('One or more conversations no longer exist. Nothing changed.');
      if(action==='PIN' || action==='UNPIN') {
        await tx.query('UPDATE conversations SET "isPinned"=$2,"updatedAt"=now() WHERE id=ANY($1::uuid[])',[ids,action==='PIN']);
      } else if(action==='MARK_UNREAD') {
        await tx.query(`INSERT INTO conversation_user_state ("userId","conversationId","markedUnread") SELECT $1,unnest($2::uuid[]),true
          ON CONFLICT ("userId","conversationId") DO UPDATE SET "markedUnread"=true,"updatedAt"=now()`,[userId,ids]);
      } else {
        await tx.query(`INSERT INTO conversation_user_state ("userId","conversationId","isArchived") SELECT $1,unnest($2::uuid[]),$3
          ON CONFLICT ("userId","conversationId") DO UPDATE SET "isArchived"=$3,"updatedAt"=now()`,[userId,ids,action==='ARCHIVE']);
      }
    });
    if(action==='PIN' || action==='UNPIN') for(const conversationId of ids) this.realtime.emitConversationEvent('conversation.updated',{conversationId});
    return {changed:ids.length,action};
  }
}
