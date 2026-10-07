import { z } from "zod";

export const GENDERS = ["FEMALE", "MALE", "OTHER", "PREFER_NOT_TO_SAY"] as const;
export type Gender = (typeof GENDERS)[number];

export interface PatientProfile {
  dateOfBirth?: string;
  gender?: Gender;
  updatedAt: string;
}

const isoDate = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, "Use the format YYYY-MM-DD.")
  .refine((v) => {
    const d = new Date(v + "T00:00:00Z");
    return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === v;
  }, "That is not a real date.");

export const ProfileUpdateSchema = z
  .object({
    dateOfBirth: isoDate.optional(),
    gender: z.enum(GENDERS).optional(),
  })
  .strict()
  .refine((v) => v.dateOfBirth !== undefined || v.gender !== undefined, "Provide dateOfBirth or gender.");
export type ProfileUpdateInput = z.infer<typeof ProfileUpdateSchema>;
