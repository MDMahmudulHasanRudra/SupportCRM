import {
  BadRequestException,
  Controller,
  Headers,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  Req,
  UnauthorizedException,
} from '@nestjs/common';
import { ApiExcludeEndpoint, ApiTags } from '@nestjs/swagger';
import type { Request } from 'express';
import { Public } from '../auth/session.guard';
import { ChannelKey } from '../channel/entities/channel.entity';
import { WebhookVerificationError } from '../channel/webhook.types';
import { IngestionService } from './ingestion.service';

/**
 * The gateway's webhook endpoint (Phase 2 brief §4).
 *
 * `@Public()` because the caller is a machine that authenticates with an HMAC signature over the
 * body, not with a session cookie. That is the ONLY authentication here, which is why every path
 * through `IngestionService.ingest()` fails closed.
 *
 * The handler does the least possible work: verify, dedupe, persist, enqueue, 200. The gateway
 * retries a delivery that does not answer promptly, so slow processing here would not merely be
 * slow — it would manufacture the duplicates the whole design is built to prevent
 * (`PROJECT_SPEC.md` §6).
 *
 * The `:channelAccountId` path segment is ADVISORY. The account is resolved from the SIGNED body's
 * `sessionId`, never from the URL — a path segment is attacker-controlled and a signature is not.
 * The parameter is kept because it makes the gateway's own delivery logs legible per account, and
 * because a leaked URL for one session reveals nothing about the others.
 *
 * **This route requires the raw body.** The signature covers the exact bytes the gateway sent, and
 * re-serializing a parsed object produces different bytes for the same logical payload. `main.ts`
 * registers a raw body parser for this path specifically.
 */
@ApiTags('channels')
@Controller('channels/whatsapp/webhook')
export class WebhookController {
  constructor(private readonly ingestion: IngestionService) {}

  /**
   * Always answers 200 for an accepted delivery, including a duplicate.
   *
   * A duplicate is a *success* from the gateway's point of view — it asked us to process an event
   * and the event is processed. Returning an error would make it retry forever.
   *
   * Excluded from the OpenAPI document: it is not part of the operator API surface, and publishing
   * its shape only helps someone probing it.
   */
  @Public()
  @Post(':channelAccountId')
  @HttpCode(HttpStatus.OK)
  @ApiExcludeEndpoint()
  async receive(
    @Param('channelAccountId') channelAccountId: string,
    @Req() request: Request,
    @Headers() headers: Record<string, string | string[] | undefined>,
  ): Promise<{ received: true; duplicate: boolean }> {
    const rawBody = (request as Request & { rawBody?: Buffer }).rawBody;

    // A missing raw body means the parser is misconfigured. Failing loudly is right: silently
    // verifying against re-serialized bytes would reject every legitimate delivery, and verifying
    // against nothing would accept every forged one.
    if (!Buffer.isBuffer(rawBody) || rawBody.length === 0) {
      throw new BadRequestException('Expected a raw request body');
    }

    try {
      const result = await this.ingestion.ingest(rawBody, headers, ChannelKey.WHATSAPP);
      return { received: true, duplicate: result.duplicate };
    } catch (error) {
      if (error instanceof WebhookVerificationError) {
        // One opaque response for every verification failure. Distinguishing "no such account"
        // from "bad signature" would let an unauthenticated caller enumerate the customer's
        // sessions; the real reason is in the security log (brief §21).
        throw new UnauthorizedException('Webhook verification failed');
      }
      throw error;
    }
  }
}
