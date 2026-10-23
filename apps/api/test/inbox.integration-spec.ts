import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { CryptoService } from '../src/common/crypto/crypto.service';
import { User } from '../src/modules/auth/entities/user.entity';
import { SecuritySettings, SECURITY_SETTINGS_ID } from '../src/modules/auth/entities/security-settings.entity';
import { Role } from '../src/modules/rbac/entities/role.entity';
import { Permission } from '../src/modules/rbac/entities/permission.entity';
import { Channel, ChannelKey } from '../src/modules/channel/entities/channel.entity';
import { ChannelAccount } from '../src/modules/channel/entities/channel-account.entity';
import { Conversation } from '../src/modules/crm/entities/conversation.entity';
import { ConversationKind } from '../src/modules/crm/conversation-states';
import { Message } from '../src/modules/messaging/entities/message.entity';
import { MessageContentType, MessageDirection } from '../src/modules/messaging/message-types';
import { closeTestApp, createTestApp, resetDatabase, type TestContext } from './setup';
import { InboxReading1788400003000 } from '../src/database/migrations/1788400003000-InboxReading';
import { CustomerDirectory1788400002000 } from '../src/database/migrations/1788400002000-CustomerDirectory';

describe('Private inbox organization and exact-message reads',()=>{
  let ctx:TestContext; let owner:string; let reader:string; let conversation:Conversation; let other:Conversation; let accountId:string;
  beforeAll(async()=>{ctx=await createTestApp();});
  afterAll(async()=>{if(ctx)await closeTestApp(ctx);});
  beforeEach(async()=>{
    await resetDatabase(ctx.dataSource);
    await ctx.dataSource.getRepository(SecuritySettings).save({id:SECURITY_SETTINGS_ID});
    const admin=await ctx.dataSource.getRepository(Role).save({key:'super_admin',name:'Admin',isSuperAdmin:true,permissions:[]});
    const permissions=await ctx.dataSource.getRepository(Permission).save(['conversations.read','messages.read'].map(key=>({key,label:key,category:'CRM'})));
    const role=await ctx.dataSource.getRepository(Role).save({key:'reader',name:'Reader',permissions});
    const passwordHash=ctx.app.get(CryptoService).hashPassword('LocalTest!123');
    for(const [username,roles] of [['owner',[admin]],['reader',[role]]] as const){
      await ctx.dataSource.getRepository(User).save({username,name:username,email:`${username}@example.test`,passwordHash,roles:[...roles],isActive:true});
      const login=await request(ctx.app.getHttpServer()).post('/api/v1/auth/login').send({identifier:username,password:'LocalTest!123'}).expect(200);
      const cookie=String(login.headers['set-cookie'][0]).split(';')[0]; if(username==='owner')owner=cookie;else reader=cookie;
    }
    await ctx.dataSource.getRepository(Channel).save({key:ChannelKey.WHATSAPP,name:'WhatsApp',adapterKey:'openwa',isEnabled:true});
    const account=await ctx.dataSource.getRepository(ChannelAccount).save({channelKey:ChannelKey.WHATSAPP,externalName:'inbox-fixture',label:'Inbox fixture'});accountId=account.id;
    const repo=ctx.dataSource.getRepository(Conversation);
    [conversation,other]=await repo.save(['Fixture conversation','Other conversation'].map((subject,i)=>repo.create({channelKey:ChannelKey.WHATSAPP,channelAccountId:accountId,externalConversationId:`fixture-${i}`,kind:ConversationKind.DIRECT,subject})));
  });
  const post=(path:string,body:object,auth=owner)=>request(ctx.app.getHttpServer()).post(`/api/v1/inbox${path}`).set('Cookie',auth).send(body);
  const detail=(id=conversation.id,auth=owner)=>request(ctx.app.getHttpServer()).get(`/api/v1/conversations/${id}`).set('Cookie',auth);
  async function message(options:Partial<Message>={}){
    return ctx.dataSource.getRepository(Message).save({channelKey:ChannelKey.WHATSAPP,channelAccountId:accountId,externalId:randomUUID(),externalConversationId:conversation.externalConversationId,conversationId:conversation.id,senderExternalId:'fixture-sender',direction:MessageDirection.INBOUND,contentType:MessageContentType.TEXT,sentAt:new Date('2026-10-23T00:00:00Z'),body:'Fixture inbound',...options});
  }
  it('counts inbound messages per user and never infers reads from equal or earlier timestamps',async()=>{
    const a=await message(); const b=await message();
    await message({direction:MessageDirection.OUTBOUND});await message({contentType:MessageContentType.SYSTEM_EVENT});
    expect((await detail()).body.unreadCount).toBe(2);
    await post(`/conversations/${conversation.id}/read`,{messageIds:[a.id]}).expect(201);
    expect((await detail()).body).toMatchObject({unreadCount:1,firstUnreadMessageId:b.id});
    expect((await detail(conversation.id,reader)).body.unreadCount).toBe(2);
    await message({sentAt:new Date('2025-01-01T00:00:00Z')});
    expect((await detail()).body.unreadCount).toBe(2);
    await post(`/conversations/${conversation.id}/read`,{messageIds:[a.id,b.id]}).expect(201);
    expect((await detail()).body.unreadCount).toBe(1);
    expect((await ctx.dataSource.query('SELECT * FROM message_user_reads')).length).toBe(2);
  });
  it('validates every message before committing, ignores outbound/system reads and rejects malformed/big inputs',async()=>{
    const a=await message();const foreign=await message({conversationId:other.id});
    await post(`/conversations/${conversation.id}/read`,{messageIds:[a.id,foreign.id]}).expect(400);
    expect((await detail()).body.unreadCount).toBe(1);
    await post(`/conversations/${conversation.id}/read`,{messageIds:[a.id,a.id]}).expect(400);
    await post('/conversations/not-a-uuid/read',{messageIds:[]}).expect(400);
    await post(`/conversations/${conversation.id}/read`,{messageIds:Array.from({length:201},()=>randomUUID())}).expect(400);
    const outbound=await message({direction:MessageDirection.OUTBOUND});const system=await message({contentType:MessageContentType.SYSTEM_EVENT});
    await post(`/conversations/${conversation.id}/read`,{messageIds:[outbound.id,system.id]}).expect(201);
    expect((await ctx.dataSource.query('SELECT * FROM message_user_reads')).length).toBe(0);
  });
  it('keeps manual unread distinct from actual counts and clears it explicitly without changing archive',async()=>{
    await post('/organize',{conversationIds:[conversation.id],action:'ARCHIVE'}).expect(201);
    await post('/organize',{conversationIds:[conversation.id],action:'MARK_UNREAD'}).expect(201);
    expect((await detail()).body).toMatchObject({markedUnread:true,unreadCount:0,isArchived:true});
    await post(`/conversations/${conversation.id}/read`,{messageIds:[]}).expect(201);
    expect((await detail()).body).toMatchObject({markedUnread:false,unreadCount:0,isArchived:true});
  });
  it('archives privately while preserving lifecycle, automation and later incoming messages',async()=>{
    const before=(await detail()).body;
    await post('/organize',{conversationIds:[conversation.id,other.id],action:'ARCHIVE'},reader).expect(201);
    await message();
    expect((await detail(conversation.id,reader)).body).toMatchObject({isArchived:true,unreadCount:1,status:before.status,controlState:before.controlState,aiEnabled:before.aiEnabled,automationEnabled:before.automationEnabled});
    expect((await detail()).body.isArchived).toBe(false);
    await post('/organize',{conversationIds:[conversation.id],action:'UNARCHIVE'},reader).expect(201);
    expect((await detail(conversation.id,reader)).body.isArchived).toBe(false);
  });
  it('enforces shared-pin permission and atomic bounded bulk updates',async()=>{
    await post('/pin',{conversationIds:[conversation.id],action:'PIN'},reader).expect(403);
    await post('/organize',{conversationIds:[conversation.id],action:'PIN'},reader).expect(400);
    await post('/organize',{conversationIds:[conversation.id,randomUUID()],action:'ARCHIVE'}).expect(404);
    expect((await detail()).body.isArchived).toBe(false);
    await post('/organize',{conversationIds:[conversation.id,conversation.id],action:'ARCHIVE'}).expect(400);
    await post('/organize',{conversationIds:Array.from({length:51},()=>randomUUID()),action:'ARCHIVE'}).expect(400);
    await post('/pin',{conversationIds:[conversation.id,other.id],action:'PIN'}).expect(201);
    expect((await detail(conversation.id,reader)).body.isPinned).toBe(true);
    const list=await request(ctx.app.getHttpServer()).get('/api/v1/conversations').set('Cookie',reader).expect(200);
    expect(list.body.items.every((row:{isPinned:boolean;unreadCount:number})=>row.isPinned&&row.unreadCount===0)).toBe(true);
    await post('/pin',{conversationIds:[conversation.id],action:'UNPIN'}).expect(201);
    expect((await detail()).body.isPinned).toBe(false);
  });
  it('requires authentication and audits organization without customer message content',async()=>{
    await request(ctx.app.getHttpServer()).post('/api/v1/inbox/organize').send({conversationIds:[conversation.id],action:'ARCHIVE'}).expect(401);
    await post('/organize',{conversationIds:[conversation.id],action:'ARCHIVE'}).expect(201);
    const [audit]=await ctx.dataSource.query("SELECT metadata FROM audit_logs WHERE action='inbox.archive'");
    expect(audit.metadata).toEqual({count:1});
  });
  it('can roll back and reapply both additive migrations on the isolated schema',async()=>{
    const q=ctx.dataSource.createQueryRunner();await q.connect();await q.startTransaction();
    try {
      const inbox=new InboxReading1788400003000();const directory=new CustomerDirectory1788400002000();
      await inbox.down(q);await directory.down(q);await directory.up(q);await inbox.up(q);
      const [row]=await q.query("SELECT to_regclass('message_user_reads')::text AS reads,to_regclass('customer_import_receipts')::text AS receipts");
      expect(row).toEqual({reads:'message_user_reads',receipts:'customer_import_receipts'});
    }finally {await q.rollbackTransaction();await q.release();}
  });
});
