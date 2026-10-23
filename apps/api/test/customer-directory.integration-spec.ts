import request from 'supertest';
import { CryptoService } from '../src/common/crypto/crypto.service';
import { User } from '../src/modules/auth/entities/user.entity';
import { SecuritySettings, SECURITY_SETTINGS_ID } from '../src/modules/auth/entities/security-settings.entity';
import { Role } from '../src/modules/rbac/entities/role.entity';
import { Permission } from '../src/modules/rbac/entities/permission.entity';
import { Customer } from '../src/modules/crm/entities/customer.entity';
import { closeTestApp, createTestApp, resetDatabase, type TestContext } from './setup';

describe('Customer directory with real database, sessions and CSV transfers', () => {
  let ctx: TestContext; let cookie: string; let otherCookie: string; let userId: string;
  const base='/api/v1/customers';
  beforeAll(async()=>{ctx=await createTestApp();});
  afterAll(async()=>{if(ctx) await closeTestApp(ctx);});
  beforeEach(async()=>{
    await resetDatabase(ctx.dataSource);
    await ctx.dataSource.getRepository(SecuritySettings).save({id:SECURITY_SETTINGS_ID});
    const admin=await ctx.dataSource.getRepository(Role).save({key:'super_admin',name:'Admin',isSuperAdmin:true,permissions:[]});
    const permissions=await ctx.dataSource.getRepository(Permission).save(['customers.read','customers.manage'].map(key=>({key,label:key,category:'CRM'})));
    const reader=await ctx.dataSource.getRepository(Role).save({key:'operator',name:'Operator',permissions});
    const passwordHash=ctx.app.get(CryptoService).hashPassword('LocalTest!123');
    const user=await ctx.dataSource.getRepository(User).save({username:'owner',name:'Owner',email:'owner@example.test',passwordHash,roles:[admin],isActive:true}); userId=user.id;
    await ctx.dataSource.getRepository(User).save({username:'other',name:'Other',email:'other@example.test',passwordHash,roles:[reader],isActive:true});
    for(const name of ['owner','other']) {
      const response=await request(ctx.app.getHttpServer()).post('/api/v1/auth/login').send({identifier:name,password:'LocalTest!123'}).expect(200);
      const value=String(response.headers['set-cookie'][0]).split(';')[0]; if(name==='owner') cookie=value; else otherCookie=value;
    }
  });
  const post=(path:string,body:object,auth=cookie)=>request(ctx.app.getHttpServer()).post(`${base}${path}`).set('Cookie',auth).send(body);
  const get=(path:string,auth=cookie)=>request(ctx.app.getHttpServer()).get(`${base}${path}`).set('Cookie',auth);
  const preview=(csv:string)=>post('/directory/import/preview',{csv});
  const commit=(csv:string,previewToken:string,acknowledgeSharedContacts=false,auth=cookie)=>post('/directory/import/commit',{csv,previewToken,acknowledgeSharedContacts},auth);

  it('creates immutable unique codes, business context and safe owner summaries; clears optional fields',async()=>{
    const created=await post('',{displayName:'Client',code:'ACME-1',country:'BD',serviceName:'Support',accountOwnerId:userId,email:'client@example.test'}).expect(201);
    await post('',{displayName:'Duplicate',code:'ACME-1'}).expect(409);
    await post('',{displayName:'Automatic reserved',code:'CL-999'}).expect(400);
    const auto=await post('',{displayName:'Automatic'}).expect(201); expect(auto.body.code).toMatch(/^CL-\d+$/);
    const detail=await get(`/${created.body.id}`).expect(200);
    expect(detail.body.accountOwner).toEqual({id:userId,name:'Owner',username:'owner',isActive:true});
    const patch=(body:object)=>request(ctx.app.getHttpServer()).patch(`${base}/${created.body.id}`).set('Cookie',cookie).send(body);
    await patch({code:'CHANGED'}).expect(400); await patch({displayName:'  '}).expect(400);
    const updated=await patch({country:null,serviceName:'  ',accountOwnerId:null,email:''}).expect(200);
    expect(updated.body).toMatchObject({country:null,serviceName:null,accountOwnerId:null,email:null,code:'ACME-1'});
  });
  it('filters by context and pages with no 50-record ceiling',async()=>{
    const repo=ctx.dataSource.getRepository(Customer);
    await repo.save(Array.from({length:115},(_,i)=>repo.create({displayName:`Client ${i}`,serviceName:i===0?'Special plan':null,country:i<60?'BD':'IN',accountOwnerId:i<60?userId:null})));
    const first=await get('?limit=50&offset=0&country=BD').expect(200);
    const next=await get('?limit=50&offset=50&country=BD').expect(200);
    expect(first.body.total).toBe(60); expect(next.body.items).toHaveLength(10);
    expect(new Set([...first.body.items,...next.body.items].map((c:{id:string})=>c.id)).size).toBe(60);
    expect((await get('?search=Special')).body.items).toHaveLength(1);
    expect((await get('?unassigned=true')).body.total).toBe(55);
    expect((await get(`?accountOwnerId=${userId}`)).body.total).toBe(60);
  });
  it('rejects newly assigning inactive owners while retaining existing owner history',async()=>{
    const other=await ctx.dataSource.getRepository(User).findOneByOrFail({username:'other'});
    const created=await post('',{displayName:'Owned client',accountOwnerId:other.id}).expect(201);
    await ctx.dataSource.getRepository(User).update(other.id,{isActive:false});
    await post('',{displayName:'Invalid owner',accountOwnerId:other.id}).expect(400);
    const updated=await request(ctx.app.getHttpServer()).patch(`${base}/${created.body.id}`).set('Cookie',cookie).send({displayName:'Renamed',accountOwnerId:other.id}).expect(200);
    expect(updated.body.accountOwner.isActive).toBe(false);
    const p=await preview('name,ownerUsername\nImported,other').expect(201); expect(p.body.valid).toBe(false);
  });
  it('requires transfer permissions separately from ordinary viewing/managing',async()=>{
    await request(ctx.app.getHttpServer()).get(`${base}/directory/export`).expect(401);
    await get('/directory/export',otherCookie).expect(403);
    await preview('name\nClient').expect(201);
    await post('/directory/import/preview',{csv:'name\nClient'},otherCookie).expect(403);
    const template=await get('/directory/template').expect(200); expect(template.text).toContain('ownerUsername');
  });
  it('reports invalid rows, inactive owners and duplicate codes without any writes',async()=>{
    const file='code,name,email,country,ownerUsername\nX-1,Valid,bad-email,ZZ,nobody\nX-1,,,BD,owner';
    const p=await preview(file).expect(201);
    expect(p.body.valid).toBe(false); expect(p.body.previewToken).toBeNull();
    expect(p.body.rows.every((r:{errors:string[]})=>r.errors.length>0)).toBe(true);
    expect(await ctx.dataSource.getRepository(Customer).count()).toBe(0);
    await preview('name,unknown\nClient,x').expect(400);
  });
  it('commits normalized create-only rows and replays concurrent retries exactly once',async()=>{
    const file='name,phone,country,service,ownerUsername,status\nFirst,+880 1711-223344,bd,Plan,owner,PROSPECT\nSecond,,,,,ACTIVE';
    const p=await preview(file).expect(201); expect(p.body.valid).toBe(true);
    const results=await Promise.all([commit(file,p.body.previewToken),commit(file,p.body.previewToken)]);
    expect(results.map(r=>r.status)).toEqual([201,201]);
    expect(results[0].body.customerIds).toEqual(results[1].body.customerIds);
    expect(results.map(r=>r.body.replayed).sort()).toEqual([false,true]);
    const rows=await ctx.dataSource.getRepository(Customer).find({order:{displayName:'ASC'}});
    expect(rows).toHaveLength(2); expect(rows[0]).toMatchObject({primaryPhone:'8801711223344',country:'BD',serviceName:'Plan',accountOwnerId:userId,status:'PROSPECT',source:'IMPORT'});
    const [{count}]=await ctx.dataSource.query<Array<{count:number}>>('SELECT COUNT(*)::int AS count FROM customer_identities'); expect(count).toBe(0);
  });
  it('binds preview to file/operator, rejects tampering/expiry and never partially imports',async()=>{
    const file='name\nOne\nTwo'; const p=await preview(file).expect(201);
    await commit(file+'\nThree',p.body.previewToken).expect(400);
    await commit(file,p.body.previewToken+'x').expect(400);
    const crypto=ctx.app.get(CryptoService);
    const claim=JSON.parse(crypto.decryptSecret(p.body.previewToken,`customer-import:${userId}`));
    const expired=crypto.encryptSecret(JSON.stringify({...claim,expiresAt:Date.now()-1000}),`customer-import:${userId}`);
    await commit(file,expired).expect(409);
    const other=await ctx.dataSource.getRepository(User).findOneByOrFail({username:'other'});
    const admin=await ctx.dataSource.getRepository(Role).findOneByOrFail({key:'super_admin'}); other.roles=[admin]; await ctx.dataSource.getRepository(User).save(other);
    await commit(file,p.body.previewToken,false,otherCookie).expect(400);
    expect(await ctx.dataSource.getRepository(Customer).count()).toBe(0);
  });
  it('requires shared-contact acknowledgment and demands new preview after validation changes',async()=>{
    await post('',{displayName:'Existing',primaryPhone:'8801711223344'}).expect(201);
    const file='name,phone\nSeparate,8801711223344'; const p=await preview(file).expect(201);
    expect(p.body.warningCount).toBe(1); await commit(file,p.body.previewToken).expect(400);
    await commit(file,p.body.previewToken,true).expect(201);
    const pending=await preview('code,name\nRACE-1,Pending').expect(201);
    await post('',{code:'RACE-1',displayName:'Manual winner'}).expect(201);
    await commit('code,name\nRACE-1,Pending',pending.body.previewToken).expect(409);
    expect(await ctx.dataSource.getRepository(Customer).count()).toBe(3);
  });
  it('exports every matching record across batches, applies filters and neutralizes formulas',async()=>{
    const repo=ctx.dataSource.getRepository(Customer);
    await repo.save(Array.from({length:515},(_,i)=>repo.create({displayName:i===0?' =HYPERLINK("https://example.test")':`Export ${i}`,country:i<510?'BD':'IN'})));
    const all=await get('/directory/export?country=BD&limit=1').expect(200);
    expect(all.text.split('\r\n').filter(Boolean)).toHaveLength(511);
    expect(all.text).toContain("' =HYPERLINK"); expect(all.headers['cache-control']).toBe('no-store');
    const audit=await ctx.dataSource.query<Array<{metadata:{count:number}}>>("SELECT metadata FROM audit_logs WHERE action='customers.exported' ORDER BY \"createdAt\" DESC LIMIT 1");
    expect(audit[0].metadata.count).toBe(510);
  });
});
