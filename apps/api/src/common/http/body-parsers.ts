import type { INestApplication } from '@nestjs/common';
import { json } from 'express';
import type { Request } from 'express';

/** Bounds an oversized-body attack. A webhook carrying media metadata is kilobytes, not megabytes. */
const MAX_BODY_SIZE = '1mb';

/** The one route that needs its raw bytes preserved for HMAC verification. */
const WEBHOOK_PATH = '/api/v1/channels/whatsapp/webhook';

/**
 * Registers body parsers, including raw-body capture for gateway webhooks.
 *
 * Extracted into a shared function rather than written inline in `main.ts` because the integration
 * harness must apply exactly the same wiring. When it did not, every signed webhook was rejected
 * with a 400 — the parser was the difference between the test environment and production, which is
 * precisely the class of drift a test suite is supposed to catch rather than contain.
 *
 * The signature covers the EXACT bytes the gateway sent. Re-serializing a parsed object produces
 * different bytes for the same logical payload (key order, whitespace, unicode escaping), so
 * verifying against `JSON.stringify(req.body)` would reject every legitimate delivery. `verify`
 * stashes the untouched buffer for the ingestion service.
 */
export function applyBodyParsers(app: INestApplication): void {
  app.use(
    WEBHOOK_PATH,
    json({
      limit: MAX_BODY_SIZE,
      verify: (req, _res, buf) => {
        (req as Request & { rawBody?: Buffer }).rawBody = Buffer.from(buf);
      },
    }),
  );

  // Everything else keeps the ordinary parser with the same bound.
  app.use(json({ limit: MAX_BODY_SIZE }));
}
