import { createHash, randomBytes, randomInt, randomUUID } from "node:crypto";

// No 0/O/1/I/L so codes are easy to read aloud.
const ALPHABET = "23456789ABCDEFGHJKMNPQRSTUVWXYZ";

export function generateMedRekkCode(): string {
  let suffix = "";
  for (let i = 0; i < 6; i++) suffix += ALPHABET.charAt(randomInt(ALPHABET.length));
  return `MRK-${suffix}`;
}

export const newId = (prefix: string): string => `${prefix}_${randomUUID()}`;
export const newAccessToken = (): string => randomBytes(32).toString("base64url");
export const hashToken = (token: string): string => createHash("sha256").update(token).digest("hex");

export function normalizeName(name: string): string {
  return name.normalize("NFKD").replace(/\p{M}/gu, "").toLowerCase().replace(/\s+/g, " ").trim();
}
