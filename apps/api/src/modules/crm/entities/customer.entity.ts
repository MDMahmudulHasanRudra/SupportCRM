import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  OneToMany,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';
import { CustomerIdentity } from './customer-identity.entity';
import { User } from '../../auth/entities/user.entity';

export enum CustomerStatus {
  ACTIVE = 'ACTIVE',
  /** Retained for history but no longer a live account. Never deleted. */
  INACTIVE = 'INACTIVE',
  /** Created by matching but not yet confirmed by a human. */
  PROSPECT = 'PROSPECT',
}

/** How this customer record came into being — useful when auditing a bad match later. */
export enum CustomerSource {
  MANUAL = 'MANUAL',
  IMPORT = 'IMPORT',
  /** Created from an inbound channel identity that a human then confirmed. */
  CHANNEL = 'CHANNEL',
}

/**
 * A customer — the business entity, deliberately **not** a WhatsApp contact.
 *
 * The Phase 3 brief §1 makes that distinction the first requirement, and it is the whole reason
 * this table exists separately from `customer_identities`. One customer is one business
 * relationship; they may reach us from two phones, later from Messenger, and from inside three
 * different groups. Modelling the customer as "a phone number" would make all of that either
 * duplicate records or lost history.
 *
 * Deliberately small. The brief says not to over-design a full CRM contact system yet: no company
 * hierarchy, no custom fields, no addresses. Those attach in later phases when something actually
 * reads them.
 *
 * `primaryPhone` is a convenience for display and search only — it is **not** the identity. The
 * authoritative mapping from a channel identity to a customer lives in `customer_identities`, which
 * is the only place a match is recorded and the only place it can be audited.
 */
@Entity('customers')
@Index(['status'])
export class Customer {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Index({ unique: true })
  @Column({ type: 'varchar', length: 40, default: () => "('CL-' || nextval('customer_code_seq')::text)" })
  code!: string;

  @Column({ type: 'varchar', length: 2, nullable: true })
  country!: string | null;

  @Column({ type: 'varchar', length: 160, nullable: true })
  serviceName!: string | null;

  @Column({ type: 'uuid', nullable: true })
  accountOwnerId!: string | null;

  @ManyToOne(() => User, { nullable: true, onDelete: 'SET NULL' })
  @JoinColumn({ name: 'accountOwnerId' })
  accountOwner?: Pick<User, 'id' | 'name' | 'username' | 'isActive'> | null;

  @Column({ type: 'varchar', length: 190 })
  displayName!: string;

  /**
   * Digits only. Denormalised for search and display; the identity table is authoritative.
   * Not unique: two customers can legitimately share a number (a shared office line), and enforcing
   * uniqueness here would block a real case to protect a convenience field.
   */
  @Index()
  @Column({ type: 'varchar', length: 32, nullable: true })
  primaryPhone!: string | null;

  @Column({ type: 'varchar', length: 255, nullable: true })
  email!: string | null;

  /** Free-text company or account label. Not a foreign key — organisations arrive later if needed. */
  @Column({ type: 'varchar', length: 190, nullable: true })
  company!: string | null;

  @Column({ type: 'varchar', length: 16, default: CustomerStatus.ACTIVE })
  status!: CustomerStatus;

  @Column({ type: 'varchar', length: 16, default: CustomerSource.MANUAL })
  source!: CustomerSource;

  @OneToMany(() => CustomerIdentity, (identity) => identity.customer)
  identities!: CustomerIdentity[];

  @Column({ type: 'uuid', nullable: true })
  createdById!: string | null;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt!: Date;

  @UpdateDateColumn({ type: 'timestamptz' })
  updatedAt!: Date;
}
