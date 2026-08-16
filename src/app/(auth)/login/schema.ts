import { z } from 'zod'

// Fica fora de actions.ts de propósito: um módulo marcado com 'use server'
// só pode exportar funções assíncronas.
export const credentialsSchema = z.object({
  email: z
    .string()
    .trim()
    .toLowerCase()
    .pipe(z.email('Informe um email válido.')),
  password: z.string().min(8, 'A senha precisa ter ao menos 8 caracteres.'),
})

export type AuthState = { error: string | null }
