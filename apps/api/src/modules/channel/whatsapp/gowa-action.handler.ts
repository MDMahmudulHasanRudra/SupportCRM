import { Injectable, OnModuleInit } from '@nestjs/common';
import { JobProcessor, type JobItemHandler } from '../../jobs/job.processor';
import { JobType, type Job } from '../../jobs/entities/job.entity';
import type { JobItem } from '../../jobs/entities/job-item.entity';
import { GoWaToolsService } from './gowa-tools.service';
@Injectable()
export class GoWaActionHandler implements JobItemHandler, OnModuleInit {
    constructor(private readonly processor: JobProcessor, private readonly tools: GoWaToolsService) { }
    onModuleInit() { this.processor.registerHandler(JobType.WHATSAPP_ACTION, this); this.processor.registerHandler(JobType.WHATSAPP_INTEGRATION_SYNC, this); }
    handle(item: JobItem, job: Job) { return job.type === JobType.WHATSAPP_INTEGRATION_SYNC ? this.tools.syncIntegrations() : this.tools.execute(item.reference); }
}
