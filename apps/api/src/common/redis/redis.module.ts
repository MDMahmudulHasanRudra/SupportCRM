import { Global, Module } from '@nestjs/common';
import { LockService } from './lock.service';
import { RateLimitService } from './rate-limit.service';
import { RedisService } from './redis.service';

/** Global: locks, rate limits and dedupe are cross-cutting concerns for every domain module. */
@Global()
@Module({
  providers: [RedisService, LockService, RateLimitService],
  exports: [RedisService, LockService, RateLimitService],
})
export class RedisModule {}
