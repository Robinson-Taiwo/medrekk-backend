import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";

const VERSION = "v1";

export function parseKey(base64: string): Buffer {
  const key = Buffer.from(base64, "base64");
  if (key.length !== 32) {
    throw new Error("DATA_ENCRYPTION_KEY must be 32 random bytes encoded as base64 (openssl rand -base64 32).");
  }
  return key;
}

export function encryptText(key: Buffer, plain: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const body = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [VERSION, iv.toString("base64"), tag.toString("base64"), body.toString("base64")].join(".");
}

export function decryptText(key: Buffer, stored: string): string {
  const parts = stored.split(".");
  const [version, iv, tag, body] = parts;
  if (parts.length !== 4 || version !== VERSION || !iv || !tag || !body) {
    throw new Error("Unrecognised encrypted value.");
  }
  const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(iv, "base64"));
  decipher.setAuthTag(Buffer.from(tag, "base64"));
  return Buffer.concat([decipher.update(Buffer.from(body, "base64")), decipher.final()]).toString("utf8");
}

export const sha256Hex = (value: string): string => createHash("sha256").update(value).digest("hex");
