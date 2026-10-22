import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { WorkspaceFrame } from './workspace-shell';

const permissions = new Set<string>();
vi.mock('../auth-context', () => ({ useAuth: () => ({ can: (key: string) => permissions.has(key) }) }));

beforeEach(() => {
  permissions.clear();
  vi.stubGlobal('matchMedia', vi.fn(() => ({ matches: false })));
  HTMLDialogElement.prototype.showModal = function () { this.setAttribute('open', ''); };
  HTMLDialogElement.prototype.close = function () { this.removeAttribute('open'); };
});
function mount() {
  return render(<MemoryRouter><WorkspaceFrame controls={<button>Theme</button>}><Routes><Route path="/" element={<h1>Dashboard content</h1>} /><Route path="/channels/whatsapp" element={<h1>WhatsApp account screen</h1>} /></Routes></WorkspaceFrame></MemoryRouter>);
}
describe('Workspace navigation', () => {
  it('filters both navigation and page search by permissions', () => {
    mount();
    const nav = screen.getByRole('navigation', { name: 'Main navigation' });
    expect(within(nav).queryByRole('link', { name: 'Billing & subscriptions' })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Find a page' }));
    const finder = screen.getByRole('dialog', { name: 'Find a page' });
    fireEvent.change(within(finder).getByRole('textbox'), { target: { value: 'billing' } });
    expect(within(finder).getByText('No matching pages')).toBeInTheDocument();
  });
  it('opens with Ctrl+K and navigates to QR/account management with Enter', () => {
    permissions.add('channels.read'); mount();
    fireEvent.keyDown(window, { key: 'k', ctrlKey: true });
    const search = screen.getByRole('textbox', { name: 'Search available pages' });
    fireEvent.change(search, { target: { value: 'scan' } });
    fireEvent.keyDown(search, { key: 'Enter' });
    expect(screen.getByRole('heading', { name: 'WhatsApp account screen' })).toBeInTheDocument();
    expect(screen.queryByRole('dialog', { name: 'Find a page' })).not.toBeInTheDocument();
  });
  it('opens mobile navigation and dismisses it after choosing a page', () => {
    vi.stubGlobal('matchMedia', vi.fn(() => ({ matches: true })));
    permissions.add('channels.read'); mount();
    fireEvent.click(screen.getByRole('button', { name: 'Toggle navigation' }));
    const drawer = screen.getByRole('dialog', { name: 'Workspace navigation' });
    fireEvent.click(within(drawer).getByRole('link', { name: 'WhatsApp accounts' }));
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'WhatsApp account screen' })).toBeInTheDocument();
  });
  it('handles native Escape cancellation and keeps the current page', () => {
    mount(); fireEvent.click(screen.getByRole('button', { name: 'Find a page' }));
    act(() => { screen.getByRole('dialog').dispatchEvent(new Event('cancel', { bubbles: true, cancelable: true })); });
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Dashboard content' })).toBeInTheDocument();
  });
});
