import { z } from "zod";

/**
 * What a USSD aggregator POSTs for each step of a session. `text` accumulates every
 * input the caller has typed so far, joined by "*", so the first request carries "".
 */
export const UssdRequestSchema = z.object({
  sessionId: z.string().trim().min(1).max(128),
  phoneNumber: z.string().trim().min(1).max(32),
  // Long enough to survive several re-prompts in one session without rejecting a real caller.
  text: z.string().max(512).default(""),
  serviceCode: z.string().trim().max(32).optional(),
});
export type UssdRequest = z.infer<typeof UssdRequestSchema>;

/**
 * A four-digit PIN has only 10,000 possibilities, so the guessing is held off by the
 * lockout in UssdService rather than by the PIN's own strength. Rejecting the handful of
 * PINs an attacker would try first still removes the cheapest guesses.
 */
export function isWeakPin(pin: string): boolean {
  if (!/^\d{4}$/.test(pin)) return false; // shape is the schema's job, not this function's
  if (/^(\d)\1{3}$/.test(pin)) return true; // 0000, 1111, 9999
  const digits = [...pin].map(Number);
  const step = (by: number): boolean => digits.every((n, i) => i === 0 || n === digits[i - 1]! + by);
  return step(1) || step(-1); // 1234, 4321
}

export const UssdPinSchema = z.object({
  pin: z
    .string()
    .trim()
    .regex(/^\d{4}$/, "The PIN must be exactly 4 digits.")
    .refine((pin) => !isWeakPin(pin), "Pick a PIN that isn't four of the same digit or a run like 1234."),
});
export type UssdPinInput = z.infer<typeof UssdPinSchema>;
