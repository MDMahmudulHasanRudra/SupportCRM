import { Column, CreateDateColumn, Entity, Index, PrimaryGeneratedColumn, UpdateDateColumn } from 'typeorm';
import { AIProviderKind } from '../ai-types';

/**
 * A configured generation endpoint (`PROJECT_SPEC.md` §21, §22, §177).
 *
 * The credential lives here as an AES-256-GCM envelope bound to this row's id, so a row copied to
 * another id does not decrypt. Nothing in this application returns it: the API exposes whether a
 * key is set, never the key.
 *
 * `priority` is the fallback order of §123. A provider that fails is skipped by the circuit breaker
 * rather than hammered, and the next one down is tried; when none answers, the decision escalates
 * to a human instead of inventing something.
 */
@Entity('ai_providers')
@Index(['isActive', 'priority'])
export class AIProviderConfig {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ type: 'varchar', length: 120 })
  name!: string;

  @Column({ type: 'varchar', length: 24 })
  kind!: AIProviderKind;

  @Column({ type: 'varchar', length: 500, nullable: true })
  baseUrl!: string | null;

  /** The envelope. Never logged, never serialized, never sent to a browser. */
  @Column({ type: 'text', nullable: true })
  apiKeyEncrypted!: string | null;

  @Column({ type: 'varchar', length: 160, nullable: true })
  defaultModel!: string | null;

  @Column({ type: 'int', default: 45_000 })
  timeoutMs!: number;

  @Column({ type: 'boolean', default: false })
  isActive!: boolean;

  @Column({ type: 'int', default: 100 })
  priority!: number;

  @Column({ type: 'timestamptz', nullable: true })
  lastCheckedAt!: Date | null;

  /** The last failure, already reduced to something safe to show. Never a response body. */
  @Column({ type: 'varchar', length: 500, nullable: true })
  lastError!: string | null;

  @Column({ type: 'uuid', nullable: true })
  createdById!: string | null;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt!: Date;

  @UpdateDateColumn({ type: 'timestamptz' })
  updatedAt!: Date;
}
