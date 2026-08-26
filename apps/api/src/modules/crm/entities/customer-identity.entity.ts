import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';
import { ChannelKey } from '../../channel/entities/channel.entity';
import { Customer } from './customer.entity';

/**
 * How confident we are that this channel identity belongs to this customer (Phase 3 brief §2).
 *
 * The states exist so that "we have seen this phone number" and "we know whose phone number this
 * is" are never the same fact. Phase 2 deliberately typed unknown group participants as `UNKNOWN`
 * rather than `CUSTOMER` for exactly this reason; this enum is where that caution becomes a
 * recorded, reviewable decision instead of a silent assumption.
 */
export enum IdentityMatchState {
  /** Seen on a channel, not linked to anyone. `customerId` MUST be null. */
  UNRESOLVED = 'UNRESOLVED',
  /** A rule or an operator proposed a customer. Linked, but not trusted yet. */
  CANDIDATE = 'CANDIDATE',
  /** A human confirmed it. The only state that may be treated as authoritative. */
  CONFIRMED = 'CONFIRMED',
  /** A human said this identity is NOT that customer. Kept so the same wrong match is not re-proposed. */
  REJECTED = 'REJECTED',
}

/** What proposed the link — the difference between "a human decided" and "a rule guessed". */
export enum IdentityMatchSource {
  MANUAL = 'MANUAL',
  /** An exact, unambiguous phone match against an existing customer. */
  EXACT_PHONE = 'EXACT_PHONE',
  IMPORT = 'IMPORT',
  /** Reserved. No Phase 3 code writes this. */
  HEURISTIC = 'HEURISTIC',
}

/**
 * One identity a customer has on one channel (Phase 3 brief §2).
 *
 * The design rule this table enforces: **an identity can exist without a customer.** `customerId`
 * is nullable, and an `UNRESOLVED` row is the normal state for every new phone number we see. That
 * is what lets the system record "someone messaged from this number" faithfully without inventing
 * a customer record that a human never approved.
 *
 * A conversation only counts as *belonging* to a customer when the identity is `CONFIRMED`. The
 * brief §2 is explicit — never automatically convert an unknown participant into a confirmed
 * customer without a safe matching rule — and `CANDIDATE` is how a rule proposes without deciding.
 *
 * `REJECTED` deliberately keeps `customerId` populated: it is the record of *which* customer this
 * identity is not, which is what stops the same wrong match being re-proposed forever.
 */
@Entity('customer_identities')
@Index(['channelKey', 'externalId'], { unique: true })
@Index(['customerId', 'matchState'])
export class CustomerIdentity {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  /** Null while UNRESOLVED. Populated from CANDIDATE onward. */
  @Column({ type: 'uuid', nullable: true })
  customerId!: string | null;

  @ManyToOne(() => Customer, (customer) => customer.identities, { onDelete: 'SET NULL', nullable: true })
  @JoinColumn({ name: 'customerId' })
  customer!: Customer | null;

  @Column({ type: 'varchar', length: 32 })
  channelKey!: ChannelKey;

  /**
   * Which account first observed this identity. Nullable and advisory: the same person can appear on
   * several of our accounts, and the identity is the person, not the account that saw them.
   */
  @Column({ type: 'uuid', nullable: true })
  channelAccountId!: string | null;

  /** The channel's own identifier — a WhatsApp JID. Unique per channel. */
  @Column({ type: 'varchar', length: 190 })
  externalId!: string;

  /** Digits only. The practical lookup key for matching. */
  @Index()
  @Column({ type: 'varchar', length: 32, nullable: true })
  phone!: string | null;

  /** As the channel reported it. Untrusted input — escape on render. */
  @Column({ type: 'varchar', length: 190, nullable: true })
  displayName!: string | null;

  @Index()
  @Column({ type: 'varchar', length: 16, default: IdentityMatchState.UNRESOLVED })
  matchState!: IdentityMatchState;

  @Column({ type: 'varchar', length: 16, default: IdentityMatchSource.MANUAL })
  matchSource!: IdentityMatchSource;

  /** Who confirmed or rejected the link, and when. Null while UNRESOLVED or CANDIDATE. */
  @Column({ type: 'uuid', nullable: true })
  resolvedById!: string | null;

  @Column({ type: 'timestamptz', nullable: true })
  resolvedAt!: Date | null;

  /** Operator's reason for confirming or rejecting. Surfaced when reviewing a disputed match. */
  @Column({ type: 'text', nullable: true })
  resolutionNote!: string | null;

  @Column({ type: 'timestamptz', nullable: true })
  lastSeenAt!: Date | null;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt!: Date;

  @UpdateDateColumn({ type: 'timestamptz' })
  updatedAt!: Date;
}
