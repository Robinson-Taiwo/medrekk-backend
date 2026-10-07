import { z } from 'zod'

export const RoleSchema = z.enum(['PATIENT', 'HEALTH_WORKER'])
export type Role = z.infer<typeof RoleSchema>

export const RegisterSchema = z.object({
  email: z.string().trim().toLowerCase().email(),
  password: z.string().min(8).max(128),
  fullName: z.string().trim().min(2).max(120),
  role: RoleSchema,
  facility: z.string().trim().max(160).optional(),
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
}

export interface AuthResponse {
  token: string
  user: PublicUser
}