import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
} from 'typeorm';
import { Message } from './message.entity';

/**
 * Media metadata for a message. **Metadata only — never the bytes.**
 *
 * Phase 2 stores what the provider told us about an attachment and does not download it. That is a
 * deliberate boundary: media storage needs the validated upload pipeline, size limits, MIME
 * sniffing and non-executable storage paths that `PROJECT_SPEC.md` §126/§179 require, and that
 * arrives with the knowledge/storage work. Persisting a base64 blob into a jsonb column in the
 * meantime would be the wrong thing made permanent.
 *
 * Every field here is attacker-controlled. A filename can contain path traversal, a MIME type can
 * lie about the content, and a declared size can disagree with reality — so all three are sanitised
 * on the way in and none may be trusted on the way out.
 */
@Entity('message_attachments')
@Index(['messageId'])
export class MessageAttachment {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ type: 'uuid' })
  messageId!: string;

  @ManyToOne(() => Message, (message) => message.attachments, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'messageId' })
  message!: Message;

  /** As declared by the provider. Sanitised to a `type/subtype` shape; never used to pick a handler. */
  @Column({ type: 'varchar', length: 128 })
  mimeType!: string;

  /** Basename only — any directory component is stripped before persistence. */
  @Column({ type: 'varchar', length: 255, nullable: true })
  filename!: string | null;

  /** As declared by the provider, clamped to a sane range. Not verified against real bytes. */
  @Column({ type: 'bigint', nullable: true })
  sizeBytes!: string | null;

  /**
   * True when the provider deliberately omitted the payload (over its size cap, timed out, or
   * concurrency-saturated). Not an error — but the UI must say "media not retrieved" rather than
   * showing a broken thumbnail.
   */
  @Column({ type: 'boolean', default: false })
  omittedByProvider!: boolean;

  /** Storage key once media download exists. Always null in Phase 2. */
  @Column({ type: 'varchar', length: 512, nullable: true })
  storageRef!: string | null;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt!: Date;
}
