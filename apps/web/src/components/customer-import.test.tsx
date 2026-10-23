import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, expect, it, vi } from 'vitest';
import { ApiError } from '../api/client';
import { customerDirectory, type ImportPreview } from '../api/customer-directory';
import { CustomerImportDialog } from './customer-import';

vi.mock('./ui',async()=>({...await vi.importActual('./ui'),useToast:()=>({success:vi.fn(),error:vi.fn()})}));
const preview: ImportPreview={valid:true,warningCount:1,expiresAt:new Date(Date.now()+900000).toISOString(),previewToken:'signed-preview',rows:[{record:2,values:{name:'Separate client'},errors:[],warnings:['Shared phone: creates a separate customer.']}]};
beforeEach(()=>{
  vi.restoreAllMocks();
  HTMLDialogElement.prototype.showModal=function(){this.setAttribute('open','');};
  HTMLDialogElement.prototype.close=function(){this.removeAttribute('open');};
  vi.spyOn(customerDirectory,'preview').mockResolvedValue(preview);
});
function choose(text:string,name='clients.csv') {
  const file=new File([text],name,{type:'text/csv'});
  Object.defineProperty(file,'arrayBuffer',{value:async()=>new TextEncoder().encode(text).buffer});
  fireEvent.change(screen.getByLabelText('UTF-8 CSV file'),{target:{files:[file]}});
}
async function review() {
  await waitFor(()=>expect(screen.getByRole('button',{name:'Preview file'})).toBeEnabled());
  fireEvent.click(screen.getByRole('button',{name:'Preview file'}));
  await screen.findByText('Separate client');
}
it('previews before writing and requires explicit shared-contact acknowledgment',async()=>{
  const commit=vi.spyOn(customerDirectory,'commit').mockResolvedValue({createdCount:1,customerIds:['client'],replayed:false});
  const done=vi.fn(); render(<CustomerImportDialog onClose={vi.fn()} onImported={done} />);
  choose('name\nSeparate client'); await review();
  expect(commit).not.toHaveBeenCalled();
  const action=screen.getByRole('button',{name:'Import 1 customers'}); expect(action).toBeDisabled();
  fireEvent.click(screen.getByRole('checkbox')); fireEvent.click(action); fireEvent.click(action);
  await waitFor(()=>expect(done).toHaveBeenCalledOnce());
  expect(commit).toHaveBeenCalledOnce(); expect(commit).toHaveBeenCalledWith('name\nSeparate client','signed-preview',true);
});
it('reuses the same preview after a network failure so retries are idempotent',async()=>{
  const commit=vi.spyOn(customerDirectory,'commit').mockRejectedValueOnce(new ApiError(0,'Connection lost')).mockResolvedValueOnce({createdCount:1,customerIds:['client'],replayed:true});
  render(<CustomerImportDialog onClose={vi.fn()} onImported={vi.fn()} />);
  choose('name\nSeparate client'); await review(); fireEvent.click(screen.getByRole('checkbox'));
  fireEvent.click(screen.getByRole('button',{name:'Import 1 customers'})); await screen.findByText('Connection lost');
  fireEvent.click(screen.getByRole('button',{name:'Import 1 customers'}));
  await waitFor(()=>expect(commit).toHaveBeenCalledTimes(2));
  expect(commit.mock.calls[0]).toEqual(commit.mock.calls[1]);
});
it('invalidates review when the file changes and requires re-preview after conflicts',async()=>{
  vi.spyOn(customerDirectory,'commit').mockRejectedValue(new ApiError(409,'Preview again'));
  render(<CustomerImportDialog onClose={vi.fn()} onImported={vi.fn()} />);
  choose('name\nSeparate client'); await review(); fireEvent.click(screen.getByRole('checkbox'));
  fireEvent.click(screen.getByRole('button',{name:'Import 1 customers'})); await screen.findByText('Preview again');
  expect(screen.queryByRole('button',{name:'Import 1 customers'})).not.toBeInTheDocument();
  choose('name\nReplacement','replacement.csv'); await review(); choose('name\nLatest','latest.csv');
  await waitFor(()=>expect(screen.getByRole('button',{name:'Preview file'})).toBeEnabled());
  expect(screen.queryByText('Separate client')).not.toBeInTheDocument();
  expect(screen.queryByRole('button',{name:'Import 1 customers'})).not.toBeInTheDocument();
});
