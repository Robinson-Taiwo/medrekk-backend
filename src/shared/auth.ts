import { z } from 'zod'
import { LICENCE_BODIES, type CredentialStatus, type LicenceClaim } from './types.js'
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

/** Setting the number USSD will recognise. An empty string removes it. */
export const PhoneUpdateSchema = z.object({
  phone: z
    .string()
    .trim()
    .max(32)
    .refine((v) => v === '' || normalizePhone(v) !== null, 'Enter a valid phone number.'),
})
export type PhoneUpdateInput = z.infer<typeof PhoneUpdateSchema>

/**
 * What a health worker submits so somebody can decide whether to approve them.
 *
 * Asked for after registration rather than during it: a worker can look for a patient and
 * record a visit straight away, and only needs this before anything they record can be
 * marked clinically verified. Putting it in the sign-up form would have been a wall in front
 * of the useful part of the product for the sake of a step most people will do once.
 *
 * The image cap keeps a submission inside the 1mb request body limit with room to spare;
 * base64 is about a third larger than the bytes it carries.
 */
export const CredentialSubmissionSchema = z.object({
  body: z.enum(LICENCE_BODIES),
  number: z.string().trim().min(3).max(40),
  profession: z.string().trim().min(2).max(80),
  image: z
    .object({
      mime: z.enum(['image/jpeg', 'image/png']),
      base64: z.string().min(100).max(700_000),
    })
    .optional(),
})
export type CredentialSubmissionInput = z.infer<typeof CredentialSubmissionSchema>

/** One handset. Expo mints these, and the prefix is what the sender filters on. */
export const PushTokenSchema = z.object({
  token: z.string().trim().min(10).max(200),
})
export type PushTokenInput = z.infer<typeof PushTokenSchema>

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
  /** HEALTH_WORKER only. Present once they have submitted their registration details. */
  licence?: LicenceClaim
  /** True when a photograph of the licence is on file for an approver to look at. */
  hasLicenceDocument?: boolean
}

export interface AuthResponse {
  token: string
  user: PublicUser
}
