const DEFAULT_COUNTRY_CODE = "234";

/** Returns the number in E.164 (the international phone number format), or null if it can't be read. */
export function normalizePhone(raw: string): string | null {
  const trimmed = raw.trim();
  const digits = trimmed.replace(/\D/g, "");
  if (digits.length === 0) return null;
  let full: string;
  if (trimmed.startsWith("+")) full = digits;
  else if (digits.startsWith("00")) full = digits.slice(2);
  else if (digits.startsWith("0")) full = DEFAULT_COUNTRY_CODE + digits.slice(1);
  else if (digits.startsWith(DEFAULT_COUNTRY_CODE)) full = digits;
  else return null;
  return /^[1-9]\d{7,14}$/.test(full) ? "+" + full : null;
}
