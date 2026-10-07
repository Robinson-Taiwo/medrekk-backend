import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import { decryptText, encryptText, parseKey, sha256Hex } from "../src/utils/crypto.js";

const key = parseKey(randomBytes(32).toString("base64"));

describe("encryption helpers", () => {
  it("round-trips text", () => {
    expect(decryptText(key, encryptText(key, "share-id-123"))).toBe("share-id-123");
  });
  it("uses a fresh IV every time", () => {
    expect(encryptText(key, "same")).not.toBe(encryptText(key, "same"));
  });
  it("fails with the wrong key or tampered data", () => {
    const sealed = encryptText(key, "secret");
    const other = parseKey(randomBytes(32).toString("base64"));
    expect(() => decryptText(other, sealed)).toThrow();
    expect(() => decryptText(key, sealed.slice(0, -2) + "AA")).toThrow();
  });
  it("rejects keys that are not 32 bytes and hashes deterministically", () => {
    expect(() => parseKey("c2hvcnQ=")).toThrow(/32 random bytes/);
    expect(sha256Hex("a")).toBe(sha256Hex("a"));
    expect(sha256Hex("a")).not.toBe(sha256Hex("b"));
  });
});
