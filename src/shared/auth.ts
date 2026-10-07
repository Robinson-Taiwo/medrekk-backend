import { z } from 'zod'
import type { CredentialStatus } from './types.js'
import { normalizePhone } from './phone.js'

export const RoleSchema = z.enum(['PATIENT', 'HEALTH_WORKER'])
export type Role = z.infer<typeof RoleSchema>

export const RegisterSchema = z.object({
  email: z.string().trim().toLowerCase().email(),
  password: z.string().min(8).max(128),
  fullName: z.string().trim().min(2).max(120),
  role: RoleSchema,
  facility: z.string().trim().max(160).optional(),
  phone: z
    .string()
    .trim()
    .max(32)
    .optional()
    .refine((v) => v === undefined || v === '' || normalizePhone(v) !== null, 'Enter a valid phone number.'),
})
export type RegisterInput = z.infer<typeof RegisterSchema>

export const LoginSchema = z.object({
  email: z.string().trim().toLowerCase().email(),
  password: z.string().min(1).max(128),
})
export type LoginInput = z.infer<typeof LoginSchema>

// What every authenticated request carries.
export interface AuthContext {
  userId: string
  role: Role
  patientId: string | null // set for PATIENT users only
}

export const TokenPayloadSchema = z.object({
  sub: z.string(),
  role: RoleSchema,
  pid: z.string().nullable(),
})

export interface PublicUser {
  id: string
  email: string
  fullName: string
  role: Role
  patientId: string | null
  facility: string | null
  phone: string | null
  credentialStatus: CredentialStatus | null // HEALTH_WORKER only; null for patients
}

export interface AuthResponse {
  token: string
  user: PublicUser
}
