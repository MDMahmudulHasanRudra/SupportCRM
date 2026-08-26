import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Phase 13 — per-group control over whether messages may become knowledge candidates.
 *
 * ## Why this is separate from pattern analysis
 *
 * `patternAnalysisEnabled` already decides whether a group's messages are mined for *repeated
 * questions*. That is a detection signal: it counts how often something is asked. This new column
 * decides something different and stronger — whether the content of those messages may be put
 * forward as a candidate answer for a person to review.
 *
 * Collapsing the two would be convenient and wrong. An operator may reasonably want to know that a
 * question keeps coming up in a group without that group's chat being proposed as the source of the
 * answer, and the reverse is true for a curated internal channel. Two questions, two switches.
 *
 * ## Default is OFF, and that is deliberate
 *
 * Every other flag in this table defaults to preserving existing behaviour. This one defaults to
 * `false` because there *is* no existing behaviour to preserve — no group currently contributes
 * message content to knowledge, and defaulting to true would silently begin routing customer
 * conversations into a knowledge pipeline on deploy. That is precisely the kind of change that must
 * be chosen rather than inherited.
 *
 * Nothing here makes a message authoritative. The column gates entry to the existing candidate →
 * review → approve workflow; a candidate still cannot become trusted knowledge without a person
 * accepting it.
 *
 * ## Safety
 *
 * Additive and reversible. One nullable-free boolean with a default, no data rewritten, no existing
 * column touched. `down` drops only what `up` added.
 */
export class Phase13KnowledgeContribution1788300000000 implements MigrationInterface {
  name = 'Phase13KnowledgeContribution1788300000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "groups"
        ADD COLUMN IF NOT EXISTS "knowledgeContributionEnabled" boolean NOT NULL DEFAULT false
    `);

    // Partial: the interesting set is the small minority that opted in, and that is what both the
    // operations filter and the candidate pipeline look for.
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "IDX_groups_knowledge_contribution"
        ON "groups" ("knowledgeContributionEnabled")
        WHERE "knowledgeContributionEnabled" = true
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX IF EXISTS "IDX_groups_knowledge_contribution"`);
    await queryRunner.query(`ALTER TABLE "groups" DROP COLUMN IF EXISTS "knowledgeContributionEnabled"`);
  }
}
