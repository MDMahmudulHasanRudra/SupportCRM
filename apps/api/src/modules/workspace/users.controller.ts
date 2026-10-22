import { BadRequestException, Body, ConflictException, Controller, ForbiddenException, Get, Param, ParseUUIDPipe, Patch, Post, Req } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { ArrayMaxSize, ArrayUnique, IsArray, IsBoolean, IsEmail, IsOptional, IsString, IsUUID, Matches, MaxLength, MinLength } from 'class-validator';
import type { Request } from 'express';
import { DataSource, In } from 'typeorm';
import { CryptoService } from '../../common/crypto/crypto.service';
import { AuditService } from '../audit/audit.service';
import type { AuthenticatedUser } from '../auth/auth.service';
import { User } from '../auth/entities/user.entity';
import { UserSession } from '../auth/entities/user-session.entity';
import { Role } from '../rbac/entities/role.entity';
import { CurrentUser, RequirePermissions } from '../rbac/permissions.guard';

class CreateUserDto {
  @Matches(/^[a-zA-Z0-9_.-]{3,64}$/) username!: string;
  @IsEmail() @MaxLength(255) email!: string;
  @IsString() @Matches(/\S/) @MaxLength(160) name!: string;
  @IsString() @MinLength(12) @MaxLength(128) password!: string;
  @IsArray() @ArrayUnique() @ArrayMaxSize(20) @IsUUID('all', { each: true }) roleIds!: string[];
}
class UpdateUserDto {
  @IsOptional() @IsString() @Matches(/\S/) @MaxLength(160) name?: string;
  @IsOptional() @IsEmail() @MaxLength(255) email?: string;
  @IsOptional() @IsBoolean() isActive?: boolean;
  @IsOptional() @IsArray() @ArrayUnique() @ArrayMaxSize(20) @IsUUID('all', { each: true }) roleIds?: string[];
}
class PasswordDto { @IsString() @MinLength(12) @MaxLength(128) password!: string; }

@ApiTags('users')
@Controller('users')
export class UsersController {
  constructor(private readonly db: DataSource, private readonly crypto: CryptoService, private readonly audit: AuditService) {}
  private serialize(u: User) { return { id: u.id, username: u.username, email: u.email, name: u.name, isActive: u.isActive, lastLoginAt: u.lastLoginAt, createdAt: u.createdAt, roles: u.roles.map(r => ({ id: r.id, name: r.name, key: r.key })) }; }
  private async grantedRoles(ids: string[], actor: AuthenticatedUser) {
    const roles = ids.length ? await this.db.getRepository(Role).find({ where: { id: In(ids) }, relations: ['permissions'] }) : [];
    if (roles.length !== ids.length) throw new BadRequestException('One or more roles do not exist.');
    if (!actor.isSuperAdmin && roles.some(r => r.isSuperAdmin || r.permissions.some(p => !actor.permissions.has(p.key)))) throw new ForbiddenException('You can only grant permissions that you hold. Super Admin can only be granted by another Super Admin.');
    return roles;
  }
  @Get() @RequirePermissions('users.read')
  async list() {
    const [items,total] = await this.db.getRepository(User).findAndCount({ order: { name: 'ASC' }, take: 100 });
    return { items: items.map(u => this.serialize(u)), total };
  }
  @Post() @RequirePermissions('users.manage','roles.manage')
  async create(@Body() dto: CreateUserDto, @CurrentUser() actor: AuthenticatedUser, @Req() req: Request) {
    const roles = await this.grantedRoles(dto.roleIds, actor);
    try {
      const repo = this.db.getRepository(User);
      const user = await repo.save(repo.create({ username: dto.username.toLowerCase(), email: dto.email.toLowerCase(), name: dto.name.trim(), passwordHash: this.crypto.hashPassword(dto.password), roles, isActive: true }));
      await this.audit.record({ action: 'users.created', resource: 'user', resourceId: user.id, after: { username: user.username, roleIds: roles.map(r => r.id) } }, this.audit.actorFromRequest(req, actor));
      return this.serialize(user);
    } catch (e) { if ((e as { code?: string }).code === '23505') throw new ConflictException('Username or email is already in use.'); throw e; }
  }
  @Patch(':id') @RequirePermissions('users.manage','roles.manage')
  async update(@Param('id', ParseUUIDPipe) id: string, @Body() dto: UpdateUserDto, @CurrentUser() actor: AuthenticatedUser, @Req() req: Request) {
    if (id === actor.id && (dto.isActive === false || dto.roleIds !== undefined)) throw new BadRequestException('Use another administrator to change your own access.');
    const roles = dto.roleIds ? await this.grantedRoles(dto.roleIds, actor) : undefined;
    const user = await this.db.getRepository(User).findOne({ where: { id }, relations: ['roles.permissions'] });
    if (!user) throw new BadRequestException('User not found.');
    if (!actor.isSuperAdmin && user.roles.some(r => r.isSuperAdmin)) throw new ForbiddenException('Only a Super Admin may change this user.');
    if (!actor.isSuperAdmin && user.roles.some(r => r.permissions.some(p => !actor.permissions.has(p.key)))) throw new ForbiddenException('You cannot change a user who holds permissions you do not have.');
    if (dto.name !== undefined) user.name = dto.name.trim();
    if (dto.email !== undefined) user.email = dto.email.toLowerCase();
    if (dto.isActive !== undefined) user.isActive = dto.isActive;
    if (roles) user.roles = roles;
    try { await this.db.getRepository(User).save(user); }
    catch (e) { if ((e as { code?: string }).code === '23505') throw new ConflictException('This email is already in use.'); throw e; }
    await this.audit.record({ action: 'users.updated', resource: 'user', resourceId: id, after: { isActive: user.isActive, roleIds: user.roles.map(r => r.id) } }, this.audit.actorFromRequest(req, actor));
    return this.serialize(user);
  }
  @Post(':id/password') @RequirePermissions('users.manage')
  async password(@Param('id', ParseUUIDPipe) id: string, @Body() dto: PasswordDto, @CurrentUser() actor: AuthenticatedUser, @Req() req: Request) {
    await this.db.transaction(async tx => {
      const user = await tx.findOne(User, { where: { id }, relations: ['roles.permissions'] });
      if (!user) throw new BadRequestException('User not found.');
      if (!actor.isSuperAdmin && user.roles.some(r => r.isSuperAdmin)) throw new ForbiddenException('Only a Super Admin may reset this password.');
      if (!actor.isSuperAdmin && user.roles.some(r => r.permissions.some(p => !actor.permissions.has(p.key)))) throw new ForbiddenException('You cannot reset the password of a user with greater access.');
      await tx.update(User, id, { passwordHash: this.crypto.hashPassword(dto.password), failedLoginAttempts: 0, lockedUntil: null });
      await tx.delete(UserSession, { userId: id });
    });
    await this.audit.record({ action: 'users.password_reset', resource: 'user', resourceId: id }, this.audit.actorFromRequest(req, actor));
    return { success: true };
  }
  @Get(':id/sessions') @RequirePermissions('users.read')
  async sessions(@Param('id', ParseUUIDPipe) id: string) {
    return { items: await this.db.query('SELECT id,"createdAt","expiresAt","lastUsedAt","revokedAt" FROM user_sessions WHERE "userId"=$1 ORDER BY "createdAt" DESC LIMIT 100', [id]) };
  }
  @Post(':id/revoke-sessions') @RequirePermissions('users.manage')
  async revoke(@Param('id', ParseUUIDPipe) id: string, @CurrentUser() actor: AuthenticatedUser, @Req() req: Request) {
    const user = await this.db.getRepository(User).findOne({ where: { id } });
    if (!user) throw new BadRequestException('User not found.');
    if (!actor.isSuperAdmin && user.roles.some(r => r.isSuperAdmin)) throw new ForbiddenException('Only a Super Admin may revoke these sessions.');
    await this.db.getRepository(UserSession).delete({ userId: id });
    await this.audit.record({ action: 'users.sessions_revoked', resource: 'user', resourceId: id }, this.audit.actorFromRequest(req, actor));
    return { success: true };
  }
}
