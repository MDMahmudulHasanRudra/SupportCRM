import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
  SetMetadata,
  createParamDecorator,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Request } from 'express';
import type { AuthenticatedUser } from '../auth/auth.service';

export const PERMISSIONS_KEY = 'requiredPermissions';

/**
 * Declares the permissions a route needs. Multiple keys are ANDed — a route asking for
 * `['groups.read', 'groups.update']` needs both.
 *
 * `PROJECT_SPEC.md` §108. Declared next to the handler rather than centralised in a routing table,
 * so a reviewer reading the endpoint sees its authorisation without leaving the file.
 */
export const RequirePermissions = (...permissions: string[]) =>
  SetMetadata(PERMISSIONS_KEY, permissions);

/** Injects the authenticated user resolved by `SessionGuard`. */
export const CurrentUser = createParamDecorator(
  (_data: unknown, context: ExecutionContext): AuthenticatedUser | undefined =>
    context.switchToHttp().getRequest<Request>().user,
);

@Injectable()
export class PermissionsGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    if (context.getType() !== 'http') return true;

    const required = this.reflector.getAllAndOverride<string[]>(PERMISSIONS_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (!required || required.length === 0) return true;

    const user = context.switchToHttp().getRequest<Request>().user;

    // SessionGuard runs first and rejects anonymous requests, so a missing user here means a route
    // was marked @Public() AND given @RequirePermissions() — a contradiction. Fail closed and say so.
    if (!user) {
      throw new ForbiddenException(
        'This route requires permissions but no authenticated user is present',
      );
    }

    // The one bypass in the system. Without it, a permission-catalogue mistake could lock every
    // human out with no recovery path (see Role.isSuperAdmin).
    if (user.isSuperAdmin) return true;

    const missing = required.filter((permission) => !user.permissions.has(permission));
    if (missing.length > 0) {
      // Naming the missing permission is intentional: the caller is already authenticated, and an
      // admin debugging a denial needs to know which grant to add.
      throw new ForbiddenException(`Missing required permission(s): ${missing.join(', ')}`);
    }

    return true;
  }
}
