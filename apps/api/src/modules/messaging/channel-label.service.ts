import { Injectable } from '@nestjs/common';
import {DataSource} from 'typeorm';
export interface NormalizedChannelLabel {id:string;metadata?:{name?:string;color?:number;deleted?:boolean;active?:boolean};conversation?:string;applied?:boolean;at:string}
@Injectable()
export class ChannelLabelService {
 constructor(private readonly db:DataSource){}
 async apply(accountId:string,change:NormalizedChannelLabel){if(!change.id||change.id.length>64)return;const at=new Date(change.at);if(!Number.isFinite(+at))return;await this.db.transaction(async tx=>{
  if(!change.metadata)await tx.query('INSERT INTO channel_labels("accountId","externalId",metadata,"updatedAt") VALUES($1,$2,\'{}\',to_timestamp(0)) ON CONFLICT DO NOTHING',[accountId,change.id]);else await tx.query(`INSERT INTO channel_labels("accountId","externalId",metadata,"updatedAt") VALUES($1,$2,$3,$4) ON CONFLICT("accountId","externalId") DO UPDATE SET metadata=channel_labels.metadata||EXCLUDED.metadata,"updatedAt"=EXCLUDED."updatedAt" WHERE channel_labels."updatedAt"<=EXCLUDED."updatedAt"`,[accountId,change.id,JSON.stringify(change.metadata??{}),at]);
  if(change.conversation&&typeof change.applied==='boolean')await tx.query(`INSERT INTO channel_label_associations("accountId","labelId","externalConversationId",applied,"updatedAt") VALUES($1,$2,$3,$4,$5) ON CONFLICT("accountId","labelId","externalConversationId") DO UPDATE SET applied=EXCLUDED.applied,"updatedAt"=EXCLUDED."updatedAt" WHERE channel_label_associations."updatedAt"<=EXCLUDED."updatedAt"`,[accountId,change.id,change.conversation.slice(0,190),change.applied,at]);
 });}
 async list(accountId:string){const labels=await this.db.query<Array<{externalId:string;metadata:Record<string,unknown>}>>(`SELECT "externalId",metadata FROM channel_labels WHERE "accountId"=$1 AND COALESCE(metadata->>'deleted','false')<>'true' AND COALESCE(metadata->>'active','true')<>'false' ORDER BY metadata->>'name' LIMIT 1000`,[accountId]);const associations=await this.db.query<Array<{labelId:string;externalConversationId:string}>>('SELECT "labelId","externalConversationId" FROM channel_label_associations WHERE "accountId"=$1 AND applied=true LIMIT 10000',[accountId]);return {items:labels.map(label=>({id:label.externalId,...label.metadata,chats:associations.filter(a=>a.labelId===label.externalId).map(a=>a.externalConversationId)}))};}
}
