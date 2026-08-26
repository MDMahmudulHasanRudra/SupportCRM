import { Body, Controller, Get, HttpCode, HttpStatus, Post, Req, Res } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import type { CookieOptions, Request, Response } from 'express';
import { AuditService } from '../audit/audit.service';
import { CurrentUser } from '../rbac/permissions.guard';
import { AuthService, type AuthenticatedUser } from './auth.service';
import { LoginDto, SessionUserDto } from './dto/auth.dto';
import { Public } from './session.guard';

@ApiTags('auth')
@Controller('auth')
export class AuthController {
  constructor(
    private readonly auth: AuthService,
    private readonly audit: AuditService,
    private readonly config: ConfigService,
  ) {}

  @Public()
  @Post('login')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Sign in and receive an httpOnly session cookie' })
  async login(
    @Body() dto: LoginDto,
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
  ): Promise<{ user: SessionUserDto; expiresAt: string }> {
    try {
      const result = await this.auth.login(dto.identifier, dto.password, {
        ipAddress: request.ip,
        userAgent: request.headers['user-agent'] ?? null,
      });

      response.cookie(
        this.config.getOrThrow<string>('security.sessionCookieName'),
        result.sessionSecret,
        this.cookieOptions(result.expiresAt),
      );

      await this.audit.record(
        { action: 'auth.login', resource: 'user', resourceId: result.user.id },
        this.audit.actorFromRequest(request, result.user),
      );

      return { user: toDto(result.user), expiresAt: result.expiresAt.toISOString() };
    } catch (error) {
      // A failed sign-in is worth auditing — repeated rows against one identifier are the signal
      // an operator investigating a brute-force attempt needs (PROJECT_SPEC.md §107).
      // The identifier is recorded; the password never is, and never reaches this line.
      await this.audit.record(
        {
          action: 'auth.login_failed',
          resource: 'user',
          success: false,
          metadata: { identifier: dto.identifier },
        },
        this.audit.actorFromRequest(request),
      );
      throw error;
    }
  }

  @Post('logout')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Revoke the current session server-side and clear the cookie' })
  async logout(
    @CurrentUser() user: AuthenticatedUser,
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
  ): Promise<void> {
    await this.auth.logout(user.sessionId);
    response.clearCookie(this.config.getOrThrow<string>('security.sessionCookieName'), {
      ...this.cookieOptions(new Date(0)),
      maxAge: undefined,
      expires: undefined,
    });
    await this.audit.record(
      { action: 'auth.logout', resource: 'user', resourceId: user.id },
      this.audit.actorFromRequest(request, user),
    );
  }

  @Get('me')
  @ApiOperation({ summary: 'The signed-in user, their roles and their effective permissions' })
  me(@CurrentUser() user: AuthenticatedUser): SessionUserDto {
    return toDto(user);
  }

  /**
   * `httpOnly` is non-negotiable — it is what stops an XSS payload from reading the session secret.
   * `sameSite: 'lax'` blocks the cross-site POST shape of CSRF while keeping ordinary navigation
   * working. `secure` follows configuration and is forced true in production by env validation.
   */
  private cookieOptions(expiresAt: Date): CookieOptions {
    return {
      httpOnly: true,
      secure: this.config.getOrThrow<boolean>('security.sessionCookieSecure'),
      sameSite: 'lax',
      path: '/',
      expires: expiresAt,
    };
  }
}

function toDto(user: AuthenticatedUser): SessionUserDto {
  return {
    id: user.id,
    username: user.username,
    email: user.email,
    name: user.name,
    roles: user.roleKeys,
    permissions: [...user.permissions].sort(),
    isSuperAdmin: user.isSuperAdmin,
  };
}
