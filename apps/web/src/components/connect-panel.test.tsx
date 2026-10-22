import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ConnectPanel } from './connect-panel';

const mocks = vi.hoisted(() => ({ connect: vi.fn(), qr: vi.fn(), status: null as null | ((event: { channelAccountId: string; state: string }) => void) }));
vi.mock('../api/client', async original => ({ ...(await original<typeof import('../api/client')>()), whatsapp: { connect: mocks.connect, qr: mocks.qr } }));
vi.mock('../api/realtime', () => ({ onPairingCode: () => () => undefined, onChannelStatus: (callback: typeof mocks.status) => { mocks.status = callback; return () => { mocks.status = null; }; } }));
beforeEach(() => {
  mocks.connect.mockReset().mockResolvedValue({ id: 'account-1' });
  mocks.qr.mockReset().mockResolvedValue({ accountId: 'account-1', state: 'QR_REQUIRED', qr: 'data:image/png;base64,dGVzdA==', format: 'image', available: true, expiresAt: new Date(Date.now() + 20000).toISOString() });
});
describe('In-app WhatsApp pairing panel', () => {
  it('creates only after submission, displays provider QR, then confirms real connection state', async () => {
    render(<ConnectPanel account={null} onChanged={vi.fn()} onDone={vi.fn()} />);
    expect(mocks.connect).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: 'Get QR code' })).toBeDisabled();
    fireEvent.change(screen.getByLabelText('Account name', { exact: false }), { target: { value: 'Support Team' } });
    fireEvent.click(screen.getByRole('button', { name: 'Get QR code' }));
    await waitFor(() => expect(mocks.connect).toHaveBeenCalledWith('support-team', 'Support Team'));
    expect(mocks.connect).toHaveBeenCalledTimes(1);
    expect(await screen.findByAltText('WhatsApp pairing code')).toHaveAttribute('src', 'data:image/png;base64,dGVzdA==');
    expect(screen.queryByRole('button', { name: 'Done' })).not.toBeInTheDocument();
    act(() => { mocks.status?.({ channelAccountId: 'account-1', state: 'CONNECTED' }); });
    expect(await screen.findByRole('button', { name: 'Done' })).toBeInTheDocument();
  });
  it('shows a recoverable connection failure without pretending to be paired', async () => {
    mocks.connect.mockRejectedValueOnce(new Error('Connection service unavailable'));
    render(<ConnectPanel account={null} onChanged={vi.fn()} onDone={vi.fn()} />);
    fireEvent.change(screen.getByLabelText('Account name', { exact: false }), { target: { value: 'Support' } });
    fireEvent.click(screen.getByRole('button', { name: 'Get QR code' }));
    expect(await screen.findByText('Connection service unavailable')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Try again' })).toBeInTheDocument();
    expect(screen.queryByAltText('WhatsApp pairing code')).not.toBeInTheDocument();
  });
});
