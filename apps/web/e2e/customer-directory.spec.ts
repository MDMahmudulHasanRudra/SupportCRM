import { expect, test } from '@playwright/test';

// This write-capable acceptance suite is only for the dedicated local integration-test API.
test.skip(process.env.CRM_E2E_CUSTOMERS !== '1' || process.env.CRM_E2E_USERNAME !== 'owner', 'Use the isolated customer fixture API explicitly.');
test.use({ screenshot: 'off', trace: 'off' });
test.beforeEach(async ({ page }) => {
  const login = await page.request.post('/api/v1/auth/login',{data:{identifier:'owner',password:process.env.CRM_E2E_PASSWORD}});
  expect(login.status()).toBe(200);
  const me = await page.request.get('/api/v1/auth/me');
  const identity = await me.json();
  expect(identity.email || identity.user?.email).toBe('owner@example.test');
});

for (const theme of ['light','dark']) for (const width of [375,1440]) {
  test(`customer lifecycle ${theme} ${width}px`,async ({ page },testInfo)=>{
    await page.setViewportSize({width,height:960});
    await page.addInitScript(value=>localStorage.setItem('support-crm:theme',value),theme);
    const stamp=Date.now().toString(); const name=`Browser client ${stamp}`;
    const errors:string[]=[]; page.on('pageerror',e=>errors.push(e.message));
    await page.goto('/customers');
    await page.getByRole('button',{name:'+ New customer'}).click();
    const create=page.getByRole('dialog',{name:'New customer'});
    await create.getByLabel('Name',{exact:true}).fill(name);
    await create.getByLabel('Client code').fill(`QA-${stamp}`);
    await create.getByLabel('Country code').fill('bd');
    await create.getByLabel('Service / product').fill('Browser support');
    await create.getByLabel('Phone').fill('8801711999999');
    await create.getByLabel('Email').fill('browser@example.test');
    await create.getByLabel('Account owner').selectOption({label:'Owner (@owner)'});
    await create.getByRole('button',{name:'Create',exact:true}).click();
    await expect(create).toHaveCount(0);
    await expect(page.getByRole('heading',{name,exact:true})).toBeVisible();
    await page.getByRole('link',{name:/Client 360/}).click();
    await expect(page.locator('#main-content h1')).toHaveText(name);
    await expect(page.locator('.client-facts')).toContainText('Browser support');
    await page.getByRole('button',{name:'Edit profile'}).click();
    const edit=page.getByRole('dialog',{name:'Edit customer'});
    await edit.getByLabel('Country code').fill(''); await edit.getByLabel('Service / product').fill('');
    await edit.getByLabel('Account owner').selectOption('');
    await edit.getByRole('button',{name:'Save changes'}).click();
    await expect(edit).toHaveCount(0); await expect(page.locator('.client-facts')).toContainText('Unassigned');

    await page.goto('/customers');
    await page.getByRole('button',{name:'Import customers',exact:true}).click();
    const importing=page.getByRole('dialog',{name:'Import customers'});
    const prefix=`Imported QA ${stamp}`;
    const csv=`name,phone,email,country,service,ownerUsername\n${prefix} A,8801711999999,browser@example.test,BD,Plan,owner\n${prefix} B,,,,,`;
    await importing.getByLabel('UTF-8 CSV file').setInputFiles({name:'qa-customers.csv',mimeType:'text/csv',buffer:Buffer.from(csv)});
    await importing.getByRole('button',{name:'Preview file'}).click();
    const commit=importing.getByRole('button',{name:'Import 2 customers'});
    await expect(commit).toBeDisabled();
    await importing.getByRole('checkbox').check(); await expect(commit).toBeEnabled();
    await commit.click(); await expect(importing).toHaveCount(0);
    await page.getByRole('textbox',{name:'Search customers'}).fill(prefix);
    await expect(page.getByText('2 matching customers',{exact:true})).toBeVisible();
    const [download]=await Promise.all([page.waitForEvent('download'),page.getByRole('link',{name:'Export matching CSV'}).click()]);
    const stream=await download.createReadStream(); let content=''; for await(const chunk of stream!) content+=chunk.toString();
    expect(content).toContain(`${prefix} A`); expect(content).toContain(`${prefix} B`);
    expect(content.split('\r\n').filter(Boolean)).toHaveLength(3);
    await page.screenshot({path:testInfo.outputPath('customer-directory.png'),fullPage:true});
    expect(await page.evaluate(()=>document.documentElement.scrollWidth)).toBeLessThanOrEqual(width+1);
    expect(errors).toEqual([]);
  });
}
