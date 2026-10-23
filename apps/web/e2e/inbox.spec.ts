import { expect, test } from '@playwright/test';
test.skip(process.env.CRM_E2E_INBOX!=='1'||process.env.CRM_E2E_USERNAME!=='owner','Only the isolated inbox fixture API is supported.');
test.use({screenshot:'off',trace:'off'});
for(const theme of ['light','dark'])for(const width of [375,1440]){
  test(`inbox organization ${theme} ${width}px`,async({page},testInfo)=>{
    const login=await page.request.post('/api/v1/auth/login',{data:{identifier:'owner',password:process.env.CRM_E2E_PASSWORD}});expect(login.status()).toBe(200);
    const me=await (await page.request.get('/api/v1/auth/me')).json();expect(me.email||me.user?.email).toBe('owner@example.test');
    const list=await (await page.request.get('/api/v1/conversations?search=Browser%20inbox')).json();expect(list.items.length).toBe(2);
    const target=list.items.find((row:{subject:string})=>row.subject==='Browser inbox A');const ids=list.items.map((row:{id:string})=>row.id);
    expect((await page.request.post('/api/v1/inbox/organize',{data:{conversationIds:ids,action:'UNARCHIVE'}})).ok()).toBe(true);
    expect((await page.request.post('/api/v1/inbox/pin',{data:{conversationIds:ids,action:'UNPIN'}})).ok()).toBe(true);
    expect((await page.request.post('/api/v1/inbox/organize',{data:{conversationIds:[target.id],action:'MARK_UNREAD'}})).ok()).toBe(true);
    await page.setViewportSize({width,height:960});await page.addInitScript(value=>localStorage.setItem('support-crm:theme',value),theme);
    const errors:string[]=[];page.on('pageerror',e=>errors.push(e.message));
    await page.goto(`/conversations?conversation=${target.id}`);
    if(width===375&&target.unreadCount>0){
      await expect(page.getByRole('button',{name:'Mark loaded read',exact:true})).toBeVisible();
      await page.waitForTimeout(700); // allow the visibility debounce to settle before checking offscreen history
      expect((await (await page.request.get(`/api/v1/conversations/${target.id}`)).json()).unreadCount).toBeGreaterThan(0);
    }
    await page.getByRole('button',{name:'Mark loaded read',exact:true}).click();
    await expect.poll(async()=>(await (await page.request.get(`/api/v1/conversations/${target.id}`)).json()).markedUnread).toBe(false);
    await expect.poll(async()=>(await (await page.request.get(`/api/v1/conversations/${target.id}`)).json()).unreadCount).toBe(0);
    expect(await page.evaluate(()=>document.documentElement.scrollWidth)).toBeLessThanOrEqual(width+1);
    await page.screenshot({path:testInfo.outputPath('inbox-thread.png'),fullPage:true});
    await page.getByRole('button',{name:'Mark unread',exact:true}).click();
    await expect(page.getByText('Select a contact or group',{exact:true})).toBeVisible();
    const row=page.locator('.inbox-select-row').filter({has:page.getByRole('checkbox',{name:'Select Browser inbox A',exact:true})});
    await expect(row).toContainText('Unread');
    await row.getByRole('checkbox').check();
    await page.getByRole('button',{name:'Pin',exact:true}).click();await expect(row).toContainText('Pinned');
    await row.getByRole('checkbox').check();await page.getByRole('button',{name:'Archive',exact:true}).click();await expect(row).toHaveCount(0);
    await page.getByRole('combobox',{name:'Inbox view'}).selectOption('archived');
    await row.getByRole('checkbox').check();await page.getByRole('button',{name:'Unarchive',exact:true}).click();await expect(row).toHaveCount(0);
    await page.getByRole('combobox',{name:'Inbox view'}).selectOption('active');await expect(row).toBeVisible();
    await page.screenshot({path:testInfo.outputPath('inbox.png'),fullPage:true});
    expect(await page.evaluate(()=>document.documentElement.scrollWidth)).toBeLessThanOrEqual(width+1);expect(errors).toEqual([]);
  });
}
