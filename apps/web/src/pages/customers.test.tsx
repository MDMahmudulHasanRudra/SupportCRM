import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, expect, it, vi } from 'vitest';
import { customers, type CustomerWithTags } from '../api/client';
import { CustomersPage } from './customers';

vi.mock('../auth-context',()=>({useAuth:()=>({can:()=>true})}));
vi.mock('../components/ui',async()=>({...await vi.importActual('../components/ui'),useToast:()=>({success:vi.fn(),error:vi.fn()})}));
const client=(id:string):CustomerWithTags=>({id,code:`TEST-${id}`,displayName:`Client ${id}`,country:'BD',serviceName:'Plan',accountOwnerId:null,primaryPhone:null,email:null,company:null,status:'ACTIVE',source:'MANUAL',createdAt:new Date().toISOString(),updatedAt:new Date().toISOString(),tags:[]});
beforeEach(()=>{
  vi.restoreAllMocks(); vi.spyOn(customers,'owners').mockResolvedValue({items:[]});
  vi.spyOn(customers,'identities').mockResolvedValue({items:[],total:0}); vi.spyOn(customers,'notes').mockResolvedValue({items:[],total:0});
});
it('paginates the directory and resets to page one when search changes',async()=>{
  const list=vi.spyOn(customers,'list').mockImplementation(async q=>({items:[client(q?.offset?'second':'first')],total:75}));
  render(<MemoryRouter><CustomersPage /></MemoryRouter>);
  await screen.findByText('Client first'); fireEvent.click(screen.getByRole('button',{name:'Next'}));
  await screen.findByText('Client second'); expect(list).toHaveBeenLastCalledWith(expect.objectContaining({offset:50}));
  fireEvent.change(screen.getByRole('textbox',{name:'Search customers'}),{target:{value:'Specific'}});
  await screen.findByText('Client first'); expect(list).toHaveBeenLastCalledWith(expect.objectContaining({offset:0,search:'Specific'}));
});
it('keeps the latest selected customer when an older detail request arrives late',async()=>{
  vi.spyOn(customers,'list').mockResolvedValue({items:[client('A'),client('B')],total:2});
  let resolveA!:(value:CustomerWithTags)=>void;
  vi.spyOn(customers,'get').mockImplementation(id=>id==='A'?new Promise(r=>{resolveA=r;}):Promise.resolve(client('B')));
  render(<MemoryRouter><CustomersPage /></MemoryRouter>);
  fireEvent.click(await screen.findByRole('button',{name:/Client A/}));
  fireEvent.click(screen.getByRole('button',{name:/Client B/}));
  await screen.findByRole('heading',{name:'Client B'});
  await act(async()=>{resolveA(client('A'));});
  expect(screen.queryByRole('heading',{name:'Client A'})).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole('button',{name:/Client B/}));
  await waitFor(()=>expect(screen.getByRole('heading',{name:'Client B'})).toBeInTheDocument());
});
