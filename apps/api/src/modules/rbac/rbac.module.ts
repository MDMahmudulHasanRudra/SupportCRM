import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Permission } from './entities/permission.entity';
import { Role } from './entities/role.entity';
import { RbacController } from './rbac.controller';

@Module({
  imports: [TypeOrmModule.forFeature([Role, Permission])],
  controllers: [RbacController],
  exports: [TypeOrmModule],
})
export class RbacModule {}
