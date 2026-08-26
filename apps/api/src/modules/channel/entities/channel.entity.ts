import { Column, Entity, PrimaryColumn, UpdateDateColumn } from 'typeorm';

/**
 * The set of channels the platform knows about (`PROJECT_SPEC.md` §53, §139).
 *
 * WhatsApp is the only one implemented; Messenger, Facebook Pages and Instagram are seeded as
 * `isEnabled = false` placeholders. That is not a stub — it is the registry the UI reads to decide
 * what to offer, and it makes "add a channel" a matter of shipping an adapter and flipping a row,
 * rather than a schema change and a migration on a live system.
 *
 * Capabilities live on `channel_accounts`, not here: the same channel can expose different
 * capabilities per account (a WhatsApp account that is not a group admin cannot add participants),
 * and `PROJECT_SPEC.md` §174/§176 require capability to be a runtime fact, not a static assumption.
 */
export enum ChannelKey {
  WHATSAPP = 'whatsapp',
  MESSENGER = 'messenger',
  FACEBOOK_PAGE = 'facebook_page',
  INSTAGRAM = 'instagram',
}

@Entity('channels')
export class Channel {
  @PrimaryColumn({ type: 'varchar', length: 32 })
  key!: ChannelKey;

  @Column({ type: 'varchar', length: 64 })
  name!: string;

  /** False for every channel without a shipped adapter. The UI greys these out rather than hiding them. */
  @Column({ type: 'boolean', default: false })
  isEnabled!: boolean;

  /** Which adapter implements it, e.g. `openwa`. Null until an adapter exists. */
  @Column({ type: 'varchar', length: 64, nullable: true })
  adapterKey!: string | null;

  @UpdateDateColumn({ type: 'timestamptz' })
  updatedAt!: Date;
}
