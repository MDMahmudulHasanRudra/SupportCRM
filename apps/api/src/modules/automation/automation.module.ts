import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { AuditModule } from '../audit/audit.module';
import { AutomationController } from './automation.controller';
import { AutomationRuleService } from './automation-rule.service';
import { AutomationExecution } from './entities/automation-execution.entity';
import { AutomationProfile } from './entities/automation-profile.entity';
import { AutomationProfileVersion } from './entities/automation-profile-version.entity';
import { AutomationRule } from './entities/automation-rule.entity';
import { AutomationRuleVersion } from './entities/automation-rule-version.entity';
import { RuleEvaluator } from './rule-evaluator';

/**
 * Deterministic automation (`PROJECT_SPEC.md` §76–§80, §199).
 *
 * Channel agnostic and decision agnostic: this module owns rules as *data* and the pure function
 * that evaluates them. It does not decide anything and it cannot send — the Decision Engine calls
 * the evaluator, and only `DecisionService` acts on the result.
 */
@Module({
  imports: [
    TypeOrmModule.forFeature([
      AutomationRule,
      AutomationRuleVersion,
      AutomationProfile,
      AutomationProfileVersion,
      AutomationExecution,
    ]),
    AuditModule,
  ],
  controllers: [AutomationController],
  providers: [RuleEvaluator, AutomationRuleService],
  exports: [RuleEvaluator, AutomationRuleService, TypeOrmModule],
})
export class AutomationModule {}
