import { Body, Controller, Get, Param, Put, Req } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { ArrayUnique, IsArray, IsString } from 'class-validator';
import type { Request } from 'express';
import { In, Repository } from 'typeorm';
import { BadRequestException, NotFoundException } from '@nestjs/common';
import { AuditService } from '../audit/audit.service';
import type { AuthenticatedUser } from '../auth/auth.service';
import { Permission } from './entities/permission.entity';
import { Role } from './entities/role.entity';
import { CurrentUser, RequirePermissions } from './permissions.guard';

export class UpdateRolePermissionsDto {
  @IsArray()
  @ArrayUnique()
  @IsString({ each: true })
  permissionKeys!: string[];
}

@ApiTags('rbac')
@Controller('rbac')
export class RbacController {
  constructor(
    @InjectRepository(Role) private readonly roles: Repository<Role>,
    @InjectRepository(Permission) private readonly permissions: Repository<Permission>,
    private readonly audit: AuditService,
  ) {}

  @Get('permissions')
  @RequirePermissions('roles.read')
  @ApiOperation({ summary: 'The full permission catalogue, grouped by category' })
  async listPermissions() {
    const all = await this.permissions.find({ order: { category: 'ASC', key: 'ASC' } });
    return { items: all, total: all.length };
  }

  @Get('roles')
  @RequirePermissions('roles.read')
  @ApiOperation({ summary: 'Every role with its granted permissions' })
  async listRoles() {
    const all = await this.roles.find({ relations: ['permissions'], order: { name: 'ASC' } });
    return {
      items: all.map((role) => ({
        id: role.id,
        key: role.key,
        name: role.name,
        description: role.description,
        isSystem: role.isSystem,
        isSuperAdmin: role.isSuperAdmin,
        permissions: role.permissions.map((p) => p.key).sort(),
      })),
      total: all.length,
    };
  }

  @Put('roles/:id/permissions')
  @RequirePermissions('roles.manage')
  @ApiOperation({ summary: 'Replace a role’s permission set' })
  async updateRolePermissions(
    @Param('id') id: string,
    @Body() dto: UpdateRolePermissionsDto,
    @CurrentUser() user: AuthenticatedUser,
    @Req() request: Request,
  ) {
    const role = await this.roles.findOne({ where: { id }, relations: ['permissions'] });
    if (!role) throw new NotFoundException(`Role ${id} not found`);

    if (role.isSuperAdmin) {
      // Editing the super-admin role is meaningless (it bypasses checks) and dangerous to allow —
      // it invites the false belief that its permissions are what actually govern access.
      throw new BadRequestException(
        'The super admin role bypasses permission checks; its permission set cannot be edited.',
      );
    }

    const resolved = await this.permissions.find({ where: { key: In(dto.permissionKeys) } });
    if (resolved.length !== dto.permissionKeys.length) {
      // Fail closed on an unknown key rather than silently granting the subset that resolved —
      // a caller who mistyped one permission should hear about it, not get a partial grant.
      const found = new Set(resolved.map((p) => p.key));
      const unknown = dto.permissionKeys.filter((k) => !found.has(k));
      throw new BadRequestException(`Unknown permission key(s): ${unknown.join(', ')}`);
    }

    const before = role.permissions.map((p) => p.key).sort();
    role.permissions = resolved;
    await this.roles.save(role);
    const after = resolved.map((p) => p.key).sort();

    await this.audit.record(
      {
        action: 'rbac.role_permissions_updated',
        resource: 'role',
        resourceId: role.id,
        before: { permissions: before },
        after: { permissions: after },
        metadata: { roleKey: role.key },
      },
      this.audit.actorFromRequest(request, user),
    );

    return { id: role.id, key: role.key, permissions: after };
  }
}
