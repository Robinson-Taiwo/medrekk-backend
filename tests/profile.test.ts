import { describe, expect, it } from "vitest";
import { AuthService } from "../src/auth/authService.js";
import { InMemoryUserRepository } from "../src/auth/userRepository.js";
import { createMemoryRepositories, emptyStore } from "../src/database/memory.js";
import { PatientService } from "../src/services/patient/patientService.js";
import { RegisterSchema } from "../src/shared/auth.js";
import { normalizePhone } from "../src/shared/phone.js";
import { ProfileUpdateSchema } from "../src/shared/profile.js";

const NOW = new Date("2026-10-07T10:00:00Z");

function setup() {
  const patients = new PatientService(createMemoryRepositories(emptyStore()), () => NOW);
  const auth = new AuthService(new InMemoryUserRepository(), "x".repeat(32), patients);
  return { patients, auth };
}

const registration = (email: string, phone?: string) =>
  RegisterSchema.parse({
    email,
    password: "password-123",
    fullName: "Test Person",
    role: "PATIENT",
    ...(phone ? { phone } : {}),
  });

async function newPatientId(auth: AuthService): Promise<string> {
  const res = await auth.register(registration("p@example.com"));
  if (!res.user.patientId) throw new Error("expected a patient id");
  return res.user.patientId;
}

describe("normalizePhone", () => {
  it("turns common Nigerian formats into one canonical number", () => {
    expect(normalizePhone("0803 123 4567")).toBe("+2348031234567");
    expect(normalizePhone("(0803) 123-4567")).toBe("+2348031234567");
    expect(normalizePhone("+234 803 123 4567")).toBe("+2348031234567");
    expect(normalizePhone("2348031234567")).toBe("+2348031234567");
    expect(normalizePhone("0044 20 7946 0958")).toBe("+442079460958");
  });
  it("rejects numbers it cannot place", () => {
    expect(normalizePhone("abc")).toBeNull();
    expect(normalizePhone("803")).toBeNull();
    expect(normalizePhone("8031234567")).toBeNull();
  });
});

describe("phone at registration", () => {
  it("stores the normalised number", async () => {
    const { auth } = setup();
    const res = await auth.register(registration("a@example.com", "0803 123 4567"));
    expect(res.user.phone).toBe("+2348031234567");
  });
  it("rejects the same number in a different format", async () => {
    const { auth } = setup();
    await auth.register(registration("a@example.com", "0803 123 4567"));
    await expect(auth.register(registration("b@example.com", "+2348031234567"))).rejects.toThrow(
      /phone number already exists/,
    );
  });
  it("stays optional", async () => {
    const { auth } = setup();
    const res = await auth.register(registration("a@example.com"));
    expect(res.user.phone).toBeNull();
  });
  it("is rejected by the schema when it is not a phone number", () => {
    const bad = RegisterSchema.safeParse({
      email: "a@example.com",
      password: "password-123",
      fullName: "Test Person",
      role: "PATIENT",
      phone: "not a number",
    });
    expect(bad.success).toBe(false);
  });
});

describe("patient profile", () => {
  it("saves and merges date of birth and gender", async () => {
    const { auth, patients } = setup();
    const id = await newPatientId(auth);
    expect(await patients.getProfile(id)).toEqual({ dateOfBirth: null, gender: null });
    await patients.updateProfile(id, { dateOfBirth: "1990-05-20" });
    const merged = await patients.updateProfile(id, { gender: "FEMALE" });
    expect(merged).toEqual({ dateOfBirth: "1990-05-20", gender: "FEMALE" });
  });
  it("rejects a date of birth in the future", async () => {
    const { auth, patients } = setup();
    const id = await newPatientId(auth);
    await expect(patients.updateProfile(id, { dateOfBirth: "2999-01-01" })).rejects.toThrow(/past date/);
  });
  it("is validated by the schema", () => {
    expect(ProfileUpdateSchema.safeParse({}).success).toBe(false);
    expect(ProfileUpdateSchema.safeParse({ dateOfBirth: "1990-02-30" }).success).toBe(false);
    expect(ProfileUpdateSchema.safeParse({ gender: "ROBOT" }).success).toBe(false);
    expect(ProfileUpdateSchema.safeParse({ dateOfBirth: "1990-02-20", gender: "MALE" }).success).toBe(true);
  });
});
