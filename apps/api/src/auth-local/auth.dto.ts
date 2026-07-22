import { z } from 'zod';

export const SignupSchema = z.object({
  email: z.string().email('Informe um e-mail válido.').max(254),
  password: z
    .string()
    .min(8, 'A senha precisa ter pelo menos 8 caracteres.')
    .max(128, 'Senha muito longa.'),
  name: z.string().min(1, 'Informe seu nome.').max(120),
});

export type SignupInput = z.infer<typeof SignupSchema>;

export const LoginSchema = z.object({
  email: z.string().email().max(254),
  password: z.string().min(1).max(128),
});

export type LoginInput = z.infer<typeof LoginSchema>;

export const AuthSuccessSchema = z.object({
  token: z.string(),
  user: z.object({
    id: z.string(),
    email: z.string().email(),
    name: z.string().nullable(),
    picture: z.string().nullable().optional(),
    role: z.enum(['USER', 'ADMIN']),
  }),
});

export type AuthSuccess = z.infer<typeof AuthSuccessSchema>;
