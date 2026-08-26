import {
  CanActivate,
  ExecutionContext,
  Injectable,
  SetMetadata,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Reflector } from '@nestjs/core';
import type { Request } from 'express';
import { AuthService, type AuthenticatedUser } from './auth.service';

export const IS_PUBLIC_KEY = 'isPublic';

/**
 * Marks a route as reachable without a session.
 *
 * Opt-OUT rather than opt-in: `SessionGuard` is registered globally, so a new controller is
 * protected by default and a developer must consciously write `@Public()` to expose it. The reverse
 * (remembering to add a guard) is the failure mode that produces unprotected admin APIs
 * (`PROJECT_SPEC.md` §201).
 */
export const Public = () => SetMetadata(IS_PUBLIC_KEY, true);

declare module 'express' {
  interface Request {
    user?: AuthenticatedUser;
  }
}

@Injectable()
export class SessionGuard implements CanActivate {
  constructor(
    private readonly auth: AuthService,
    private readonly reflector: Reflector,
    private readonly config: ConfigService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    // WebSocket and other non-HTTP contexts authenticate separately (see RealtimeGateway).
    if (context.getType() !== 'http') return true;

    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (isPublic) return true;

    const request = context.switchToHttp().getRequest<Request>();
    const cookieName = this.config.getOrThrow<string>('security.sessionCookieName');
    const secret = (request.cookies as Record<string, string> | undefined)?.[cookieName];

    if (!secret) throw new UnauthorizedException('Authentication required');

    const user = await this.auth.resolveSession(secret);
    if (!user) throw new UnauthorizedException('Session expired or revoked');

    request.user = user;
    return true;
  }
}
