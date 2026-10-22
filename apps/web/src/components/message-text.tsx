import type { ReactNode } from 'react';

/** Render a small WhatsApp formatting subset as React nodes. Never interpret customer HTML. */
export function MessageText({ body }: { body: string }) {
  const nodes: ReactNode[] = [];
  const tokens = /(https?:\/\/[^\s<>]+|```[\s\S]*?```|\*[^*\n]+\*|_[^_\n]+_|~[^~\n]+~)/g;
  let start = 0;
  for (const match of body.matchAll(tokens)) {
    if (match.index > start) nodes.push(body.slice(start, match.index));
    const value = match[0]; const key = match.index;
    if (/^https?:\/\//.test(value)) nodes.push(<a href={value} target="_blank" rel="noopener noreferrer" key={key}>{value}</a>);
    else if (value.startsWith('```')) nodes.push(<code key={key}>{value.slice(3, -3)}</code>);
    else if (value.startsWith('*')) nodes.push(<strong key={key}>{value.slice(1, -1)}</strong>);
    else if (value.startsWith('_')) nodes.push(<em key={key}>{value.slice(1, -1)}</em>);
    else nodes.push(<s key={key}>{value.slice(1, -1)}</s>);
    start = match.index + value.length;
  }
  nodes.push(body.slice(start));
  return <span className="message-rich-text">{nodes}</span>;
}
