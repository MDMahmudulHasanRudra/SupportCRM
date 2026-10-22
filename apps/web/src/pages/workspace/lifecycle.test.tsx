import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, expect, it, vi } from 'vitest';
import { workspace, type Shift } from '../../api/workspace';
import { ReleasesPage } from './releases';
import { TeamWorkspacePage } from './team';

vi.mock('../../auth-context', () => ({ useAuth: () => ({ can: () => true }) }));
vi.mock('../../components/ui', async () => ({
  ...await vi.importActual('../../components/ui'),
  useToast: () => ({ success: vi.fn(), error: vi.fn() }),
}));
beforeEach(() => {
  vi.restoreAllMocks();
  HTMLDialogElement.prototype.showModal = function () { this.setAttribute('open', ''); };
  HTMLDialogElement.prototype.close = function () { this.removeAttribute('open'); };
});
const shift: Shift = {
  id: 'shift-1', userId: 'person-1', userName: 'Mina', label: 'Morning',
  startsAt: new Date(Date.now()+86400000).toISOString(), endsAt: new Date(Date.now()+90000000).toISOString(),
  cancelledAt: null, cancellationReason: null, onLeave: false,
};
function roster(value = shift) {
  vi.spyOn(workspace, 'workforce').mockResolvedValue({ people: [{ id: 'person-1', name: 'Mina' }], teams: [], leave: [], shifts: [value] });
  render(<TeamWorkspacePage />);
}

it('edits a future schedule using its existing owner and prefilled dates', async () => {
  const save = vi.spyOn(workspace, 'updateShift').mockResolvedValue({});
  roster();
  fireEvent.click(await screen.findByRole('button', { name: 'Edit shift' }));
  const dialog = screen.getByRole('dialog', { name: 'Edit upcoming shift' });
  fireEvent.change(within(dialog).getByLabelText('Shift label'), { target: { value: 'Afternoon' } });
  fireEvent.submit(within(dialog).getByRole('button', { name: 'Save' }).closest('form')!);
  await waitFor(() => expect(save).toHaveBeenCalledWith('shift-1', expect.objectContaining({ userId: 'person-1', label: 'Afternoon' })));
});

it('requires a cancellation reason and keeps cancelled coverage out of on-duty totals', async () => {
  const cancel = vi.spyOn(workspace, 'cancelShift').mockResolvedValue({});
  roster();
  fireEvent.click(await screen.findByRole('button', { name: 'Cancel shift' }));
  const dialog = screen.getByRole('dialog', { name: 'Cancel shift' });
  const reason = within(dialog).getByLabelText('Cancellation reason');
  expect(reason).toBeRequired();
  fireEvent.change(reason, { target: { value: 'Replacement coverage' } });
  fireEvent.submit(within(dialog).getByRole('button', { name: 'Save' }).closest('form')!);
  await waitFor(() => expect(cancel).toHaveBeenCalledWith('shift-1', 'Replacement coverage'));
});

it('shows cancelled schedules only on request and excludes them from current coverage', async () => {
  roster({ ...shift, startsAt: new Date(Date.now()-3600000).toISOString(), endsAt: new Date(Date.now()+3600000).toISOString(), cancelledAt: new Date().toISOString(), cancellationReason: 'Moved' });
  const metric = await screen.findByText('On duty now');
  expect(metric.parentElement?.querySelector('strong')).toHaveTextContent('0');
  expect(screen.queryByText('Morning')).not.toBeInTheDocument();
  fireEvent.click(screen.getByLabelText('Show cancelled'));
  expect(screen.getByText('Cancelled', { exact: true })).toBeInTheDocument();
  expect(screen.queryByRole('button', { name: 'Cancel shift' })).not.toBeInTheDocument();
});

it('previews a release snapshot and restores it only after explicit confirmation', async () => {
  vi.spyOn(workspace, 'releases').mockResolvedValue({ items: [{ id: 'release-1', version: 'v2', title: 'Current', body: 'Current notes', status: 'PUBLISHED', publishedAt: null, createdAt: new Date().toISOString() }] });
  vi.spyOn(workspace, 'releaseHistory').mockResolvedValue({ items: [{ id: 'history-1', createdAt: new Date().toISOString(), snapshot: { version: 'v1', title: 'Previous', body: 'Old notes' } }] });
  const restore = vi.spyOn(workspace, 'restoreRelease').mockResolvedValue({});
  render(<ReleasesPage />);
  fireEvent.click(await screen.findByRole('button', { name: 'Edit history' }));
  expect(await screen.findByText('Old notes')).toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: 'Restore as draft' }));
  expect(restore).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('button', { name: 'Confirm restore as draft' }));
  await waitFor(() => expect(restore).toHaveBeenCalledWith('release-1', 'history-1'));
});
