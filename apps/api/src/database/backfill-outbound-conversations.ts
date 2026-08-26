import 'reflect-metadata';
import { config as loadEnv } from 'dotenv';
import { DataSource, IsNull } from 'typeorm';
import { dataSourceOptions } from './data-source';
import { ConversationResolverService } from '../modules/crm/conversation-resolver.service';
import { Conversation } from '../modules/crm/entities/conversation.entity';
import { ConversationParticipant } from '../modules/crm/entities/conversation-participant.entity';
import { CustomerIdentity } from '../modules/crm/entities/customer-identity.entity';
import { ChannelAccount } from '../modules/channel/entities/channel-account.entity';
import { Group } from '../modules/groups/entities/group.entity';
import { TeamMemberIdentity } from '../modules/team/entities/team-member-identity.entity';
import { Message } from '../modules/messaging/entities/message.entity';
import { MessageDirection } from '../modules/messaging/message-types';

loadEnv();

/**
 * One-off repair: attaches outbound messages that were logged before a conversation existed.
 *
 * ## Why this exists
 *
 * `OutboundProcessor.recordSent()` used to insert the `messages` row without resolving a
 * conversation, so a message an operator sent to a destination with no prior history reached
 * WhatsApp, was logged, and then belonged to nothing — invisible in the inbox forever. The send path
 * now resolves the conversation; this repairs the rows written before it did.
 *
 * ## Deliberately not a background job
 *
 * It is a finite, historical defect with a known cause. A permanent sweeper would keep scanning for
 * a condition the code can no longer produce, and would quietly mask a regression if it ever came
 * back. Run it once and delete nothing.
 *
 * ## Why it instantiates the resolver rather than booting Nest
 *
 * It uses the real `ConversationResolverService` — the same class, the same find-or-create, the same
 * group-table lookup and the same 23505 handling as the live outbound path — constructed over a
 * plain DataSource, following `migrate.ts` and `seed.ts`. Booting the full module graph would
 * connect Redis and register the queue processors, so a repair script would start consuming jobs.
 * The two collaborators it does not need are stubbed: there is nobody watching a websocket during a
 * batch repair, and no metrics endpoint is serving.
 *
 * ## Safety
 *
 * Dry run by default. Pass `--apply` to write. It only ever touches rows matching
 * `direction = OUTBOUND AND conversationId IS NULL`, so it cannot disturb a linked message, and
 * re-running finds nothing left to do.
 */
async function backfill(): Promise<void> {
  const apply = process.argv.includes('--apply');
  const dataSource = new DataSource(dataSourceOptions);
  await dataSource.initialize();

  try {
    const messages = dataSource.getRepository(Message);
    const conversations = dataSource.getRepository(Conversation);
    const accounts = dataSource.getRepository(ChannelAccount);

    // The real resolver, over real repositories.
    const resolver = new ConversationResolverService(
      conversations,
      dataSource.getRepository(ConversationParticipant),
      dataSource.getRepository(CustomerIdentity),
      dataSource.getRepository(TeamMemberIdentity),
      dataSource.getRepository(Group),
      { emitConversationEvent: () => undefined } as never,
      { increment: () => undefined } as never,
    );

    const orphans = await messages.find({
      where: { direction: MessageDirection.OUTBOUND, conversationId: IsNull() },
      order: { sentAt: 'ASC' },
    });

    console.log(`[backfill] outbound messages with no conversation: ${orphans.length}`);
    if (orphans.length === 0) {
      console.log('[backfill] nothing to repair');
      return;
    }

    if (!apply) {
      console.log('[backfill] DRY RUN — pass --apply to write. Planned work:');
    }

    // Grouped by destination so one conversation is resolved per chat, not per message.
    const byDestination = new Map<string, Message[]>();
    for (const message of orphans) {
      const key = `${message.channelAccountId}:${message.externalConversationId}`;
      const bucket = byDestination.get(key);
      if (bucket) bucket.push(message);
      else byDestination.set(key, [message]);
    }

    let repaired = 0;
    let createdConversations = 0;
    let skipped = 0;

    for (const [key, batch] of byDestination) {
      const first = batch[0];
      const account = await accounts.findOne({ where: { id: first.channelAccountId } });

      if (!account) {
        // The account row is gone. Leave the messages alone rather than inventing a home for them.
        console.warn(`[backfill] skipping ${batch.length} message(s) — channel account missing (${key})`);
        skipped += batch.length;
        continue;
      }

      if (!apply) {
        console.log(`[backfill]   ${key} → ${batch.length} message(s)`);
        continue;
      }

      const { conversation, created } = await resolver.resolveForOutbound(
        account,
        first.externalConversationId,
      );
      if (created) createdConversations += 1;

      for (const message of batch) {
        await messages.update(message.id, {
          conversationId: conversation.id,
          // Mirrors what the live send path now writes, so a repaired row is indistinguishable
          // from one written correctly in the first place.
          groupId: conversation.groupId,
          externalGroupId: conversation.groupId ? message.externalConversationId : message.externalGroupId,
        });
        repaired += 1;
      }

      /*
       * Counters, maintained explicitly rather than through `recordActivity`.
       *
       * `recordActivity` assigns `lastMessageAt` unconditionally, which is right for a live message
       * (it is always the newest) and wrong here: a repaired message can be older than activity the
       * conversation has already recorded, and assigning it would drag the inbox ordering backwards.
       * So the timestamp only ever moves forward, and the count rises by exactly what was attached.
       */
      const newest = batch.reduce<Date>(
        (latest, message) => (message.sentAt > latest ? message.sentAt : latest),
        batch[0].sentAt,
      );
      const current = await conversations.findOneOrFail({ where: { id: conversation.id } });
      const patch: Partial<Conversation> = {};
      if (!current.lastMessageAt || newest > current.lastMessageAt) patch.lastMessageAt = newest;
      if (!current.lastOutboundAt || newest > current.lastOutboundAt) patch.lastOutboundAt = newest;
      if (Object.keys(patch).length > 0) await conversations.update(conversation.id, patch);
      await conversations.increment({ id: conversation.id }, 'messageCount', batch.length);

      console.log(
        `[backfill] ${key} → conversation ${conversation.id} (${conversation.kind}${
          created ? ', created' : ', existing'
        }), ${batch.length} message(s) attached`,
      );
    }

    if (apply) {
      console.log(
        `[backfill] repaired ${repaired} message(s); conversations created ${createdConversations}; skipped ${skipped}`,
      );
    } else {
      console.log(
        `[backfill] DRY RUN complete — ${orphans.length} message(s) across ${byDestination.size} destination(s) would be repaired`,
      );
    }
  } finally {
    await dataSource.destroy();
  }
}

backfill().catch((error) => {
  console.error('[backfill] failed', error);
  process.exit(1);
});
