import {
  Body,
  Controller,
  Get,
  Logger,
  NotFoundException,
  Post,
  Req,
  Res,
  ServiceUnavailableException,
  UseGuards,
} from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';
import { ZodValidationPipe } from '../common/zod-validation.pipe.js';
import { AuthLocalService } from './auth-local.service.js';
import { GoogleStrategy, type GoogleProfile } from './google.strategy.js';
import { LoginSchema, SignupSchema, type LoginInput, type SignupInput } from './auth.dto.js';
import { JwtAuthGuard } from '../auth/jwt-auth.guard.js';
import { CurrentUser } from './current-user.decorator.js';
import type { Auth0User } from '@extractionstack/shared';
import { loadRuntimeEnv } from '../common/runtime-env.js';
import type { Request, Response } from 'express';

const ZLogin = new ZodValidationPipe(LoginSchema);
const ZSignup = new ZodValidationPipe(SignupSchema);

@Controller('auth')
export class AuthLocalController {
  private readonly logger = new Logger(AuthLocalController.name);

  constructor(
    private readonly auth: AuthLocalService,
    private readonly googleStrategy: GoogleStrategy,
  ) {}

  @Post('signup')
  async signup(@Body(ZSignup) body: SignupInput) {
    return this.auth.signup(body);
  }

  @Post('login')
  async login(@Body(ZLogin) body: LoginInput) {
    return this.auth.login(body);
  }

  @Get('me')
  @UseGuards(JwtAuthGuard)
  me(@CurrentUser() user: Auth0User) {
    return user;
  }

  /**
   * Lists the auth providers currently available, so the UI can adapt.
   */
  @Get('providers')
  providers() {
    const env = loadRuntimeEnv(process.env);
    const enabled = env.AUTH_PROVIDERS.split(',').map((p) => p.trim().toLowerCase());
    return {
      local: enabled.includes('local'),
      google: this.googleStrategy.enabled && enabled.includes('google'),
      dev: env.AUTH_DEV_MODE,
    };
  }

  /**
   * Dev-only synthetic login. Returns 404 when AUTH_DEV_MODE is disabled.
   */
  @Post('dev')
  async dev() {
    const result = await this.auth.devLogin();
    if (!result) throw new NotFoundException('dev auth disabled');
    return result;
  }

  /**
   * Starts the Google OAuth flow. Redirects to Google's consent screen.
   * Returns 503 when Google is not configured.
   */
  @Get('google')
  @UseGuards(AuthGuard('google'))
  startGoogle(): void {
    /* passport will redirect */
  }

  @Get('google/callback')
  @UseGuards(AuthGuard('google'))
  async googleCallback(
    @Req() req: Request & { user?: GoogleProfile },
    @Res() res: Response,
  ): Promise<void> {
    if (!this.googleStrategy.enabled) {
      throw new ServiceUnavailableException('Google login is not configured.');
    }
    const profile = req.user;
    if (!profile) {
      throw new ServiceUnavailableException('Google profile missing.');
    }
    const result = await this.auth.loginOrCreateFromGoogle(profile);
    const env = loadRuntimeEnv(process.env);
    const params = new URLSearchParams({
      token: result.token,
      email: result.user.email,
      name: result.user.name ?? '',
      role: result.user.role,
    });
    this.logger.log(`google login: ${result.user.email}`);
    res.redirect(`${env.WEB_ORIGIN}/auth/callback?${params.toString()}`);
  }
}
