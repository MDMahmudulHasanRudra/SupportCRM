import { Column, CreateDateColumn, Entity, PrimaryGeneratedColumn } from 'typeorm';

/** An immutable snapshot of a profile. What was approved must stay reconstructable. */
@Entity('automation_profile_versions')
export class AutomationProfileVersion {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ type: 'uuid' })
  profileId!: string;

  @Column({ type: 'int' })
  version!: number;

  @Column({ type: 'jsonb' })
  snapshot!: Record<string, unknown>;

  @Column({ type: 'varchar', length: 500, nullable: true })
  changeSummary!: string | null;

  @Column({ type: 'uuid', nullable: true })
  createdById!: string | null;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt!: Date;
}
