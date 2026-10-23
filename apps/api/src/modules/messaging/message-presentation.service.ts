import { Injectable } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { RealtimeGateway } from '../realtime/realtime.gateway';
import { Message } from './entities/message.entity';
export interface MessageMutation {externalId:string;conversation?:string;at:string;kind:'edit'|'revoke'|'delete'|'reaction'|'star'|'poll';poll?:Record<string,unknown>;body?:string;actor?:string;emoji?:string;starred?:boolean}
@Injectable()
export class MessagePresentationService {
 constructor(private readonly db:DataSource,private readonly realtime:RealtimeGateway){}
 async apply(accountId:string,change:MessageMutation){
  const changed=await this.db.transaction(async tx=>{
   const qb=tx.getRepository(Message).createQueryBuilder('m').where('m.channelAccountId=:accountId',{accountId}).andWhere('(m.externalId=:id OR m.externalId LIKE :legacy)',{id:change.externalId,legacy:`%_${change.externalId.replace(/[%_\\]/g,'\\$&')}`});if(change.conversation)qb.andWhere('m.externalConversationId=:chat',{chat:change.conversation});
   const row=await qb.setLock('pessimistic_write').getOne();if(!row)return;const p={...row.presentation};const clocks={...((p.clocks??{}) as Record<string,string>)};const key=change.kind==='reaction'||change.kind==='poll'?`${change.kind}:${change.actor}`:change.kind;
   const date=new Date(change.at);if(!Number.isFinite(+date))return;if(clocks[key]&&clocks[key]>date.toISOString())return;clocks[key]=date.toISOString();p.clocks=clocks;
   if(change.kind==='poll'&&change.poll){const update=change.poll;const existing=(p.poll??{}) as Record<string,unknown>;p.poll={...existing,...(update.question?{question:update.question}:{}),...(Array.isArray(update.options)?{options:update.options}:{}),poll_id:change.externalId};if(update.type==='vote'&&['resolved','partially_resolved'].includes(String(update.resolution_status))&&Array.isArray(update.selected_options)&&change.actor){const votes={...((p.pollVotes??{}) as Record<string,unknown>)};votes[change.actor]=update.selected_options;p.pollVotes=Object.fromEntries(Object.entries(votes).slice(-1000));}}
   if(change.kind==='edit'){p.editedBody=change.body?.slice(0,16000)??'';p.editedAt=date.toISOString();}
   if(change.kind==='revoke')p.revokedAt=date.toISOString();if(change.kind==='delete')p.deletedAt=date.toISOString();if(change.kind==='star')p.starred=change.starred;
   if(change.kind==='reaction'&&change.actor){const reactions={...((p.reactions??{}) as Record<string,string>)};if(change.emoji)reactions[change.actor.slice(0,190)]=change.emoji.slice(0,32);else delete reactions[change.actor];p.reactions=Object.fromEntries(Object.entries(reactions).slice(-512));}
   await tx.query('UPDATE messages SET presentation=$2,"updatedAt"=now() WHERE id=$1',[row.id,JSON.stringify(p)]);return {conversationId:row.conversationId,messageId:row.id,externalConversationId:row.externalConversationId};
  });
  if(changed){this.realtime.emitConversationEvent('conversation.updated',{conversationId:changed.conversationId});this.realtime.emitWhatsAppEvent('whatsapp.message.received',{channelAccountId:accountId,messageId:changed.messageId,externalConversationId:changed.externalConversationId});}
 }
}
