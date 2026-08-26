import { ExecutionContext, ForbiddenException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { AuthenticatedUser } from '../auth/auth.service';
import { PermissionsGuard } from './permissions.guard';

function contextFor(user?: Partial<AuthenticatedUser>): ExecutionContext {
  const request = { user: user ? ({ ...user } as AuthenticatedUser) : undefined };
  return {
    getType: () => 'http',
    getHandler: () => ({}),
    getClass: () => ({}),
    switchToHttp: () => ({ getRequest: () => request }),
  } as unknown as ExecutionContext;
}

function guardRequiring(required: string[] | undefined): PermissionsGuard {
  const reflector = { getAllAndOverride: () => required } as unknown as Reflector;
  return new PermissionsGuard(reflector);
}

const userWith = (permissions: string[], isSuperAdmin = false): Partial<AuthenticatedUser> => ({
  id: 'u1',
  username: 'tester',
  permissions: new Set(permissions),
  isSuperAdmin,
});

describe('PermissionsGuard', () => {
  it('allows a route that declares no permissions', () => {
    expect(guardRequiring(undefined).canActivate(contextFor(userWith([])))).toBe(true);
    expect(guardRequiring([]).canActivate(contextFor(userWith([])))).toBe(true);
  });

  it('allows a user holding the required permission', () => {
    const guard = guardRequiring(['groups.read']);
    expect(guard.canActivate(contextFor(userWith(['groups.read'])))).toBe(true);
  });

  it('denies a user missing the required permission', () => {
    const guard = guardRequiring(['groups.bulk_update']);
    expect(() => guard.canActivate(contextFor(userWith(['groups.read'])))).toThrow(ForbiddenException);
  });

  it('ANDs multiple required permissions', () => {
    const guard = guardRequiring(['groups.read', 'groups.update']);
    expect(guard.canActivate(contextFor(userWith(['groups.read', 'groups.update'])))).toBe(true);
    expect(() => guard.canActivate(contextFor(userWith(['groups.read'])))).toThrow(ForbiddenException);
  });

  it('names every missing permission so a denial is debuggable', () => {
    const guard = guardRequiring(['a.read', 'b.write']);
    expect(() => guard.canActivate(contextFor(userWith([])))).toThrow(/a\.read, b\.write/);
  });

  it('lets a super admin through regardless', () => {
    const guard = guardRequiring(['system.emergency_stop']);
    expect(guard.canActivate(contextFor(userWith([], true)))).toBe(true);
  });

  it('fails closed when a permissioned route somehow has no user', () => {
    const guard = guardRequiring(['groups.read']);
    expect(() => guard.canActivate(contextFor(undefined))).toThrow(ForbiddenException);
  });

  it('does not intercept non-http contexts', () => {
    const reflector = { getAllAndOverride: () => ['groups.read'] } as unknown as Reflector;
    const wsContext = { getType: () => 'ws' } as unknown as ExecutionContext;
    expect(new PermissionsGuard(reflector).canActivate(wsContext)).toBe(true);
  });
});
