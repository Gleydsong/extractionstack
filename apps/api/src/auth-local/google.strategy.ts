import { Injectable, Logger } from '@nestjs/common';
import { PassportStrategy } from '@nestjs/passport';
import { Strategy, type VerifyCallback } from 'passport-google-oauth20';
import { loadRuntimeEnv } from '../common/runtime-env.js';

export interface GoogleProfile {
  googleSub: string;
  email: string;
  name: string | null;
  picture: string | null;
  emailVerified: boolean;
}

/**
 * Google OAuth strategy. When GOOGLE_CLIENT_ID is missing, the strategy is
 * effectively a no-op (the controller refuses to start the flow), so it is
 * always safe to register in environments without Google configured.
 */
@Injectable()
export class GoogleStrategy extends PassportStrategy(Strategy, 'google') {
  private readonly logger = new Logger(GoogleStrategy.name);
  readonly enabled: boolean;

  constructor() {
    const env = loadRuntimeEnv(process.env);
    const id = env.GOOGLE_CLIENT_ID?.trim();
    const secret = env.GOOGLE_CLIENT_SECRET?.trim();
    const enabled = Boolean(id && secret);
    super({
      // Use non-empty placeholders so passport-oauth2 doesn't throw. The
      // controller still refuses to start the flow when `enabled` is false.
      clientID: id && secret ? id : 'disabled-client-id',
      clientSecret: id && secret ? secret : 'disabled-client-secret',
      callbackURL: env.GOOGLE_REDIRECT_URI,
      scope: ['openid', 'email', 'profile'],
      passReqToCallback: false,
    });
    this.enabled = enabled;
    if (!enabled) {
      this.logger.warn(
        'GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET not set — Google login will be disabled.',
      );
    }
  }

  validate(
    _accessToken: string,
    _refreshToken: string,
    profile: {
      id: string;
      emails?: Array<{ value: string; verified?: boolean }>;
      displayName?: string;
      name?: { givenName?: string; familyName?: string };
      photos?: Array<{ value: string }>;
    },
    done: VerifyCallback,
  ): void {
    const email = profile.emails?.[0]?.value;
    if (!email) {
      done(new Error('Google account did not provide an email address.'), undefined);
      return;
    }
    const fullName = [profile.name?.givenName, profile.name?.familyName].filter(Boolean).join(' ');
    const result: GoogleProfile = {
      googleSub: profile.id,
      email,
      name: profile.displayName || fullName || null,
      picture: profile.photos?.[0]?.value ?? null,
      emailVerified: Boolean(profile.emails?.[0]?.verified),
    };
    done(null, result);
  }
}
