import {
  Injectable,
  Logger,
  HttpException,
  HttpStatus,
  UnauthorizedException,
  ConflictException,
} from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import bcrypt from 'bcrypt';
import type { User } from '@prisma/client';
import { PrismaClient } from '@prisma/client';
import { loadRuntimeEnv } from '../common/runtime-env.js';
import type { AuthSuccess, LoginInput, SignupInput } from './auth.dto.js';

const BCRYPT_ROUNDS = 12;
const DEV_SUB = 'dev|local';

@Injectable()
export class AuthLocalService {
  private readonly logger = new Logger(AuthLocalService.name);
  private readonly env = loadRuntimeEnv(process.env);

  constructor(
    private readonly prisma: PrismaClient,
    private readonly jwt: JwtService,
  ) {}

  async signup(input: SignupInput): Promise<AuthSuccess> {
    const email = input.email.trim().toLowerCase();
    const existing = await this.prisma.user.findUnique({ where: { email } });
    if (existing) {
      throw new HttpException(
        { code: 'CONFLICT', message: 'E-mail já cadastrado. Tente fazer login.' },
        HttpStatus.CONFLICT,
      );
    }
    const passwordHash = await bcrypt.hash(input.password, BCRYPT_ROUNDS);
    const user = await this.prisma.user.create({
      data: {
        email,
        name: input.name.trim(),
        passwordHash,
        emailVerified: false,
        role: 'USER',
      },
    });
    return this.issueToken(user, 'local');
  }

  async login(input: LoginInput): Promise<AuthSuccess> {
    const email = input.email.trim().toLowerCase();
    const user = await this.prisma.user.findUnique({ where: { email } });
    if (!user || !user.passwordHash) {
      throw new HttpException(
        { code: 'UNAUTHENTICATED', message: 'E-mail ou senha inválidos.' },
        HttpStatus.UNAUTHORIZED,
      );
    }
    const ok = await bcrypt.compare(input.password, user.passwordHash);
    if (!ok) {
      throw new HttpException(
        { code: 'UNAUTHENTICATED', message: 'E-mail ou senha inválidos.' },
        HttpStatus.UNAUTHORIZED,
      );
    }
    return this.issueToken(user, 'local');
  }

  /**
   * Ensures a User exists for the given Google profile (creates one on first
   * login). Returns a signed local JWT for the user.
   */
  async loginOrCreateFromGoogle(profile: {
    googleSub: string;
    email: string;
    name?: string | null;
    picture?: string | null;
    emailVerified: boolean;
  }): Promise<AuthSuccess> {
    const email = profile.email.trim().toLowerCase();
    let user = await this.prisma.user.findFirst({
      where: { OR: [{ googleSub: profile.googleSub }, { email }] },
    });
    if (!user) {
      user = await this.prisma.user.create({
        data: {
          email,
          googleSub: profile.googleSub,
          name: profile.name?.trim() || email.split('@')[0]!,
          picture: profile.picture,
          emailVerified: profile.emailVerified,
          role: 'USER',
        },
      });
    } else {
      // Backfill Google linkage if the user signed up with email/password first.
      user = await this.prisma.user.update({
        where: { id: user.id },
        data: {
          googleSub: user.googleSub ?? profile.googleSub,
          picture: user.picture ?? profile.picture,
          emailVerified: user.emailVerified || profile.emailVerified,
          name: user.name ?? profile.name,
        },
      });
    }
    return this.issueToken(user, 'google');
  }

  /**
   * Returns a synthetic dev token when AUTH_DEV_MODE is enabled. Returns null
   * otherwise so the controller can return 404.
   */
  async devLogin(): Promise<AuthSuccess | null> {
    if (!this.env.AUTH_DEV_MODE) return null;
    const email = 'dev@local';
    let user = await this.prisma.user.findUnique({ where: { email } });
    if (!user) {
      user = await this.prisma.user.create({
        data: {
          email,
          auth0Sub: DEV_SUB,
          name: 'dev',
          role: 'ADMIN',
          emailVerified: true,
        },
      });
    }
    return this.issueToken(user, 'auth0');
  }

  private issueToken(user: User, provider: 'local' | 'google' | 'auth0'): AuthSuccess {
    const token = this.jwt.sign(
      {
        sub: user.id,
        email: user.email,
        name: user.name,
        role: user.role,
        provider,
      },
      {
        expiresIn: this.env.LOCAL_JWT_TTL_SECONDS,
      },
    );
    return {
      token,
      user: {
        id: user.id,
        email: user.email,
        name: user.name,
        picture: user.picture,
        role: user.role,
      },
    };
  }
}
