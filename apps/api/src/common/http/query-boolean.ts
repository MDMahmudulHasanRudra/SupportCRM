import { Transform } from 'class-transformer';

/**
 * Parses a boolean out of a query string.
 *
 * `@Type(() => Boolean)` cannot do this, and fails in the worst possible direction: it calls
 * `Boolean(value)`, and `Boolean('false')` is `true`. So `?aiEnabled=false` arrives as `true` and
 * the endpoint answers a question nobody asked — silently, with a 200 and a plausible-looking body.
 *
 * Observed exactly that way: filtering the groups console for AI-disabled groups returned none,
 * while every group in the database had AI switched off.
 *
 * `undefined` survives as `undefined` rather than collapsing to `false`, because for a tri-state
 * filter "either" is a real third answer and must not be confused with "no".
 */
export function parseQueryBoolean(value: unknown): boolean | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  if (typeof value === 'boolean') return value;

  const text = String(value).toLowerCase();
  if (text === 'true' || text === '1') return true;
  if (text === 'false' || text === '0') return false;
  return undefined;
}

/**
 * The decorator form, for DTO properties.
 *
 * Use in place of `@Type(() => Boolean)` on anything that arrives in a query string:
 *
 * ```ts
 * \@IsOptional() \@QueryBoolean() \@IsBoolean() includeInactive?: boolean;
 * ```
 */
export const QueryBoolean = () => Transform(({ value }) => parseQueryBoolean(value));
