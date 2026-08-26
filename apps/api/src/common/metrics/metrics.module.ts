import { Global, Module } from '@nestjs/common';
import { MetricsService } from './metrics.service';

/** Global: every module records metrics, and threading an import through each would be noise. */
@Global()
@Module({
  providers: [MetricsService],
  exports: [MetricsService],
})
export class MetricsModule {}
