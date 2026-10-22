import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { MessageText } from './message-text';

describe('Safe customer message formatting', () => {
  it('renders formatting and opens only explicit HTTP(S) links safely', () => {
    render(<MessageText body={'*Important* _detail_ ~old~ ```code``` https://example.com/help'} />);
    expect(screen.getByText('Important').tagName).toBe('STRONG');
    const link = screen.getByRole('link');
    expect(link).toHaveAttribute('href', 'https://example.com/help');
    expect(link).toHaveAttribute('rel', 'noopener noreferrer');
  });
  it('keeps customer HTML and javascript URLs as literal text', () => {
    const { container } = render(<MessageText body={'<img src=x onerror=alert(1)> javascript:alert(1)'} />);
    expect(container.querySelector('img')).toBeNull();
    expect(container.querySelector('a')).toBeNull();
    expect(container.textContent).toContain('<img');
  });
});
