import { Column, CreateDateColumn, Entity, Index, PrimaryGeneratedColumn, UpdateDateColumn } from 'typeorm';

/**
 * Long-term memory about one customer (`PROJECT_SPEC.md` §25).
 *
 * Approved, never inferred and silently kept. A fact with no approver is a suggestion and the
 * retrieval path ignores it — which is the difference between "the system remembers what we told
 * it" and "the system remembers what it decided about you".
 */
@Entity('ai_customer_facts')
@Index(['customerId', 'isActive'])
export class AICustomerFact {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ type: 'uuid' })
  customerId!: string;

  @Column({ type: 'varchar', length: 1000 })
  fact!: string;

  @Column({ type: 'varchar', length: 24, default: 'HUMAN' })
  source!: 'HUMAN' | 'AI_SUGGESTED' | 'IMPORTED';

  @Column({ type: 'uuid', nullable: true })
  approvedById!: string | null;

  @Column({ type: 'timestamptz', nullable: true })
  approvedAt!: Date | null;

  @Column({ type: 'boolean', default: true })
  isActive!: boolean;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt!: Date;

  @UpdateDateColumn({ type: 'timestamptz' })
  updatedAt!: Date;
}
