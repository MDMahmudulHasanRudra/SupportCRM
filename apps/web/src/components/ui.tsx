import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';

/**
 * The shared pieces every screen is built from.
 *
 * One file rather than one per component: they are small, they are used together, and a folder of
 * fifteen four-line files is harder to keep consistent than a single place where the whole
 * vocabulary is visible at once.
 *
 * The rule these encode: a screen is never blank and never lies. Every list has a loading state, an
 * empty state and an error state, and each says something specific — "no rules yet" and "could not
 * load rules" look nothing alike to a user trying to work out whether the system is broken.
 */

// === notifications ===============================================================================

type ToastTone = 'success' | 'error' | 'info';
interface Toast {
  id: number;
  tone: ToastTone;
  message: string;
}

interface ToastApi {
  success: (message: string) => void;
  error: (message: string) => void;
  info: (message: string) => void;
}

const ToastContext = createContext<ToastApi | null>(null);

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);

  const push = useCallback((tone: ToastTone, message: string) => {
    const id = Date.now() + Math.random();
    setToasts((current) => [...current, { id, tone, message }]);
    // Errors linger: a failure a user missed is a failure they will hit again.
    window.setTimeout(() => setToasts((current) => current.filter((toast) => toast.id !== id)), tone === 'error' ? 8000 : 4000);
  }, []);

  const api = useMemo<ToastApi>(
    () => ({
      success: (message) => push('success', message),
      error: (message) => push('error', message),
      info: (message) => push('info', message),
    }),
    [push],
  );

  return (
    <ToastContext.Provider value={api}>
      {children}
      <div className="toast-stack" role="status" aria-live="polite">
        {toasts.map((toast) => (
          <div key={toast.id} className={`toast toast-${toast.tone}`}>
            {toast.message}
            <button
              type="button"
              className="toast-close"
              aria-label="Dismiss"
              onClick={() => setToasts((current) => current.filter((t) => t.id !== toast.id))}
            >
              ×
            </button>
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  );
}

export function useToast(): ToastApi {
  const context = useContext(ToastContext);
  // A no-op fallback rather than a throw: a component rendered in a test without the provider
  // should still render, not explode.
  return context ?? { success: () => undefined, error: () => undefined, info: () => undefined };
}

/** Turns any thrown value into something worth showing a person. */
export function errorMessage(failure: unknown, fallback: string): string {
  return failure instanceof Error && failure.message ? failure.message : fallback;
}

// === page furniture ==============================================================================

export function PageHeader({
  title,
  description,
  actions,
}: {
  title: string;
  description?: string;
  actions?: ReactNode;
}) {
  return (
    <>
      <div className="page-head">
        <h1>{title}</h1>
        {actions && <div className="row">{actions}</div>}
      </div>
      {description && <p className="page-sub">{description}</p>}
    </>
  );
}

export function Loading({ label = 'Loading…' }: { label?: string }) {
  return (
    <div className="progress">
      <span className="spinner" aria-hidden="true" />
      <span className="muted">{label}</span>
    </div>
  );
}

/**
 * The empty state.
 *
 * Takes a sentence explaining *why* it is empty and what to do, not the word "None". An empty
 * screen with no explanation is the most common way a working feature looks broken.
 */
export function Empty({
  title,
  hint,
  action,
  icon,
}: {
  title: string;
  hint?: string;
  action?: ReactNode;
  icon?: ReactNode;
}) {
  return (
    <div className="empty">
      {icon && <div className="empty-icon" aria-hidden="true">{icon}</div>}
      <h2>{title}</h2>
      {hint && <p className="muted">{hint}</p>}
      {action && <div className="row" style={{ justifyContent: 'center', marginTop: 12 }}>{action}</div>}
    </div>
  );
}

/** A failure, with a way out of it. A dead end is worse than an error. */
export function ErrorState({
  message,
  onRetry,
  icon,
}: {
  message: string;
  onRetry?: () => void;
  icon?: ReactNode;
}) {
  return (
    <div className="error-state">
      {icon && <div className="error-state-icon" aria-hidden="true">{icon}</div>}
      <p>{message}</p>
      {onRetry && (
        <button type="button" className="link" onClick={onRetry} style={{ padding: 0 }}>
          Try again
        </button>
      )}
    </div>
  );
}

/**
 * Pulsing placeholder bars for a list that's still loading — for the busiest lists only (the
 * conversations inbox, the groups table, the customers list), not a blanket replacement for
 * `Loading`: most panels are small enough that a spinner reads faster than a fake shape of one.
 */
export function Skeleton({ lines = 3, height }: { lines?: number; height?: number }) {
  return (
    <div className="skeleton" aria-hidden="true">
      {Array.from({ length: lines }, (_, index) => (
        <div key={index} className="skeleton-line" style={height ? { height } : undefined} />
      ))}
    </div>
  );
}

export function Card({ title, children, actions }: { title?: string; children: ReactNode; actions?: ReactNode }) {
  return (
    <div className="card card-pad stack">
      {(title || actions) && (
        <div className="row" style={{ justifyContent: 'space-between' }}>
          {title && <strong>{title}</strong>}
          {actions}
        </div>
      )}
      {children}
    </div>
  );
}

export function Field({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: ReactNode;
}) {
  return (
    <label className="field">
      <span className="field-label">{label}</span>
      {children}
      {hint && <span className="field-hint">{hint}</span>}
    </label>
  );
}

// === status ======================================================================================

export type Tone = 'ok' | 'warn' | 'bad' | 'busy' | 'neutral';

export function Badge({ tone = 'neutral', children, title }: { tone?: Tone; children: ReactNode; title?: string }) {
  return (
    <span className="badge" title={title}>
      <span className={`dot ${tone === 'neutral' ? '' : tone}`} aria-hidden="true" />
      {children}
    </span>
  );
}

/** Sentence-cases an enum for display without inventing a label table for every one. */
export function humanise(value: string | null | undefined): string {
  if (!value) return '—';
  const lower = value.toLowerCase().replace(/_/g, ' ');
  return lower.charAt(0).toUpperCase() + lower.slice(1);
}

export function RelativeTime({ value }: { value: string | Date | null | undefined }) {
  if (!value) return <span className="muted">—</span>;

  const date = typeof value === 'string' ? new Date(value) : value;
  if (Number.isNaN(date.getTime())) return <span className="muted">—</span>;

  const seconds = Math.round((Date.now() - date.getTime()) / 1000);
  const label =
    seconds < 60
      ? 'just now'
      : seconds < 3600
        ? `${Math.floor(seconds / 60)}m ago`
        : seconds < 86_400
          ? `${Math.floor(seconds / 3600)}h ago`
          : date.toLocaleDateString();

  return <span title={date.toLocaleString()}>{label}</span>;
}

// === dangerous actions ===========================================================================

/**
 * The confirmation dialog for anything that cannot be undone.
 *
 * `confirmWord` makes it a deliberate act rather than a reflex: for the destructive end of the
 * range, clicking through a dialog is muscle memory, and typing the word is not.
 */
export function ConfirmDialog({
  title,
  body,
  confirmLabel = 'Confirm',
  confirmWord,
  tone = 'danger',
  busy,
  onConfirm,
  onCancel,
}: {
  title: string;
  body: ReactNode;
  confirmLabel?: string;
  confirmWord?: string;
  tone?: 'danger' | 'normal';
  busy?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  const [typed, setTyped] = useState('');
  const ready = !confirmWord || typed.trim().toUpperCase() === confirmWord.toUpperCase();

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onCancel();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onCancel]);

  return (
    <div className="backdrop" role="dialog" aria-modal="true" aria-label={title}>
      <div className="dialog">
        <div className="dialog-head">
          <h2>{title}</h2>
        </div>
        <div className="dialog-body stack">
          {typeof body === 'string' ? <p>{body}</p> : body}
          {confirmWord && (
            <Field label={`Type ${confirmWord} to confirm`}>
              <input value={typed} autoFocus onChange={(event) => setTyped(event.target.value)} />
            </Field>
          )}
        </div>
        <div className="dialog-foot">
          <button type="button" onClick={onCancel} disabled={busy}>
            Cancel
          </button>
          <button
            type="button"
            className={tone === 'danger' ? 'danger' : 'primary'}
            disabled={!ready || busy}
            onClick={onConfirm}
          >
            {busy ? 'Working…' : confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}

// === tables ======================================================================================

export function TableWrap({ children }: { children: ReactNode }) {
  return <div className="table-wrap">{children}</div>;
}

/**
 * Pagination.
 *
 * Shows the range rather than only the page number: "41–60 of 312" tells somebody where they are,
 * and "page 3" does not.
 */
export function Pagination({
  offset,
  limit,
  total,
  onChange,
}: {
  offset: number;
  limit: number;
  total: number;
  onChange: (offset: number) => void;
}) {
  if (total <= limit) return null;

  const from = offset + 1;
  const to = Math.min(offset + limit, total);

  return (
    <div className="row pagination">
      <span className="muted small">
        {from}–{to} of {total}
      </span>
      <button type="button" disabled={offset === 0} onClick={() => onChange(Math.max(0, offset - limit))}>
        Previous
      </button>
      <button type="button" disabled={to >= total} onClick={() => onChange(offset + limit)}>
        Next
      </button>
    </div>
  );
}

export type IconColor = 'accent' | 'blue' | 'orange' | 'ok' | 'warn' | 'bad';

/** A labelled figure, for dashboards. */
export function Stat({
  label,
  value,
  hint,
  tone,
  icon,
  iconColor,
}: {
  label: string;
  value: string | number | null;
  hint?: string;
  tone?: Tone;
  icon?: ReactNode;
  /** The icon chip's colour. Purely decorative unless it matches `tone` — a count is not a verdict,
   * so it may take any colour in the family without implying one. Defaults to the accent colour. */
  iconColor?: IconColor;
}) {
  const toneClass = tone && tone !== 'neutral' && tone !== 'busy' ? `stat-${tone}` : '';
  const iconClass = iconColor && iconColor !== 'accent' ? `stat-${iconColor}` : toneClass;
  return (
    <div className={`stat ${toneClass}`}>
      {icon && <div className={`stat-icon ${iconClass}`}>{icon}</div>}
      <div className="stat-body">
        <div className="stat-label">{label}</div>
        {/* Null means "not measurable", which is different from zero and must not render as it. */}
        <div className="stat-value">{value === null ? '—' : value}</div>
        {hint && <div className="stat-hint">{hint}</div>}
      </div>
    </div>
  );
}

export function StatGrid({ children }: { children: ReactNode }) {
  return <div className="stat-grid">{children}</div>;
}

// === charts ======================================================================================

const DONUT_PALETTE = ['#3b82f6', '#22c55e', '#f59e0b', '#8b5cf6', '#ef4444', '#64748b'];

/**
 * A ring chart for a breakdown that already exists as counted data — e.g. decisions by outcome.
 *
 * Never for a series the API does not compute (a time-of-day trend, a forecast): a chart is still a
 * number, and an invented one is still a lie, just a rounder-looking one.
 */
export function Donut({
  segments,
  centerLabel,
}: {
  segments: Array<{ label: string; value: number }>;
  centerLabel?: string;
}) {
  const total = segments.reduce((sum, s) => sum + s.value, 0);
  const size = 108;
  const stroke = 16;
  const radius = (size - stroke) / 2;
  const circumference = 2 * Math.PI * radius;

  let offset = 0;
  const arcs = segments
    .filter((s) => s.value > 0)
    .map((segment, index) => {
      const fraction = total > 0 ? segment.value / total : 0;
      const dash = fraction * circumference;
      const arc = (
        <circle
          key={segment.label}
          cx={size / 2}
          cy={size / 2}
          r={radius}
          fill="none"
          stroke={DONUT_PALETTE[index % DONUT_PALETTE.length]}
          strokeWidth={stroke}
          strokeDasharray={`${dash} ${circumference - dash}`}
          strokeDashoffset={-offset}
          transform={`rotate(-90 ${size / 2} ${size / 2})`}
        />
      );
      offset += dash;
      return arc;
    });

  return (
    <div className="donut-row">
      <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} role="img" aria-label={centerLabel ?? 'Breakdown'}>
        <circle cx={size / 2} cy={size / 2} r={radius} fill="none" stroke="var(--surface-2)" strokeWidth={stroke} />
        {arcs}
        <text x="50%" y="47%" textAnchor="middle" className="donut-center-value" fill="var(--text)">
          {total}
        </text>
        {centerLabel && (
          <text x="50%" y="63%" textAnchor="middle" className="donut-center-label" fill="var(--text-faint)">
            {centerLabel}
          </text>
        )}
      </svg>
      <div className="donut-legend">
        {segments.map((segment, index) => (
          <div key={segment.label} className="donut-legend-row">
            <span className="donut-legend-dot" style={{ background: DONUT_PALETTE[index % DONUT_PALETTE.length] }} />
            <span className="donut-legend-label">{segment.label}</span>
            <span className="donut-legend-value">
              {segment.value}
              {total > 0 && <span className="donut-legend-pct">({Math.round((segment.value / total) * 100)}%)</span>}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}

/**
 * A multi-series line chart over counted daily rows.
 *
 * Every point is a real count for a real day — the API fills every day in the window, so a flat
 * stretch is a flat stretch and not a gap being drawn through. There is no smoothing, no
 * interpolation and no projection: a curve that implies a shape the data does not have is the
 * chart equivalent of inventing a number.
 */
export function TrendChart({
  points,
  series,
  height = 190,
}: {
  points: Array<Record<string, string | number>>;
  series: Array<{ key: string; label: string; color: string }>;
  height?: number;
}) {
  const width = 640;
  const padLeft = 34;
  const padRight = 8;
  const padTop = 10;
  const padBottom = 24;

  const values = points.flatMap((point) => series.map((s) => Number(point[s.key]) || 0));
  // A zero ceiling would divide by zero; 1 keeps every line honestly pinned to the baseline.
  const max = Math.max(1, ...values);

  const plotWidth = width - padLeft - padRight;
  const plotHeight = height - padTop - padBottom;

  const x = (index: number) =>
    points.length <= 1 ? padLeft + plotWidth / 2 : padLeft + (index * plotWidth) / (points.length - 1);
  const y = (value: number) => padTop + plotHeight - (value / max) * plotHeight;

  const dayLabel = (raw: string | number) => {
    const date = new Date(String(raw));
    return Number.isNaN(date.getTime())
      ? String(raw)
      : date.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
  };

  const ticks = [0, Math.round(max / 2), max].filter((value, index, all) => all.indexOf(value) === index);
  const labelIndexes = points.length <= 1 ? [0] : [0, Math.floor((points.length - 1) / 2), points.length - 1];

  return (
    <div className="stack" style={{ gap: 10 }}>
      <div className="trend-legend">
        {series.map((s) => (
          <span key={s.key} className="trend-legend-item">
            <span className="trend-swatch" style={{ background: s.color }} />
            {s.label}
          </span>
        ))}
      </div>

      <svg className="trend-svg" viewBox={`0 0 ${width} ${height}`} role="img" aria-label="Daily activity">
        {ticks.map((tick) => (
          <g key={tick}>
            <line className="trend-grid-line" x1={padLeft} x2={width - padRight} y1={y(tick)} y2={y(tick)} />
            <text className="trend-axis-text" x={padLeft - 6} y={y(tick) + 3} textAnchor="end">
              {tick}
            </text>
          </g>
        ))}

        {series.map((s) => (
          <polyline
            key={s.key}
            fill="none"
            stroke={s.color}
            strokeWidth={2}
            strokeLinejoin="round"
            strokeLinecap="round"
            points={points.map((point, index) => `${x(index)},${y(Number(point[s.key]) || 0)}`).join(' ')}
          />
        ))}

        {labelIndexes.map((index) => (
          <text
            key={index}
            className="trend-axis-text"
            x={x(index)}
            y={height - 6}
            textAnchor={index === 0 ? 'start' : index === points.length - 1 ? 'end' : 'middle'}
          >
            {dayLabel(points[index]?.day ?? '')}
          </text>
        ))}
      </svg>
    </div>
  );
}
