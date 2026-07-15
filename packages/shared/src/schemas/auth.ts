import { z } from 'zod';

export const UserRoleSchema = z.enum(['user', 'admin']);
export type UserRole = z.infer<typeof UserRoleSchema>;

export const Auth0UserSchema = z.object({
  sub: z.string(),
  email: z.string().email().optional(),
  name: z.string().optional(),
  roles: z.array(UserRoleSchema).default(['user']),
});
export type Auth0User = z.infer<typeof Auth0UserSchema>;
