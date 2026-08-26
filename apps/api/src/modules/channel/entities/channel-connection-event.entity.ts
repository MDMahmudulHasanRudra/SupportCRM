import { Column, CreateDateColumn, Entity, Index, PrimaryGeneratedColumn } from 'typeorm';
import { ChannelConnectionState, ConnectionEventSource } from '../channel-connection';

/**
 * Append-only history of connection state transitions.
 *
 * `channel_accounts.status` answers "what is it now"; this table answers "how did it get there and
 * who did it" — the question that actually matters at 3am when a session has been flapping. It is
 * also the evidence trail for `PROJECT_SPEC.md` §130 health monitoring.
 *
 * Separate from `audit_logs` on purpose: audit records deliberate human actions on business
 * resources, whereas most rows here are the gateway telling us something. Mixing high-frequency
 * machine events into the audit trail would bury the human ones.
 */
@Entity('channel_connection_events')
@Index(['channelAccountId', 'createdAt'])
export class ChannelConnectionEvent {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ type: 'uuid' })
  channelAccountId!: string;

  /** Null for the very first observation of an account. */
  @Column({ type: 'varchar', length: 24, nullable: true })
  previousState!: ChannelConnectionState | null;

  @Column({ type: 'varchar', length: 24 })
  state!: ChannelConnectionState;

  @Column({ type: 'varchar', length: 24 })
  source!: ConnectionEventSource;

  /**
   * The gateway's own state string, kept verbatim for diagnosis. Its presence here is precisely why
   * no other table needs it: an unmapped value shows up as `state = UNKNOWN` with the raw string
   * recorded, which is enough to fix the mapper.
   */
  @Column({ type: 'varchar', length: 64, nullable: true })
  rawState!: string | null;

  /** Truncated before persistence — gateway errors can carry very long payload dumps. */
  @Column({ type: 'text', nullable: true })
  detail!: string | null;

  /** Set when an operator triggered the transition. Null for gateway-driven changes. */
  @Column({ type: 'uuid', nullable: true })
  actorId!: string | null;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt!: Date;
}
