import request from "supertest";
import { describe, expect, it } from "vitest";
import { buildApp } from "../src/app.js";
import type { AppConfig } from "../src/config.js";

const config: AppConfig = {
  NODE_ENV: "test",
  PORT: 0,
  AUTH_MODE: "jwt",
  JWT_SECRET: "x".repeat(32),
  SEED_DEMO_DATA: false,
  CORS_ORIGIN: "http://localhost:3000",
};

const LOCAL_PHONE = "08031234567";
const DIALLED = "+2348031234567"; // what the aggregator sends for the same SIM
const GOOD_PIN = "8317";

interface Harness {
  app: ReturnType<typeof buildApp>;
  auth: { Authorization: string };
  advance: (minutes: number) => void;
}

async function patient(opts: { phone?: string; config?: AppConfig } = {}): Promise<Harness> {
  let clock = new Date("2026-10-15T10:00:00.000Z");
  const app = buildApp({ config: opts.config ?? config, now: () => clock });
  const res = await request(app)
    .post("/auth/register")
    .send({
      email: `ada-${Math.random().toString(36).slice(2)}@example.com`,
      password: "password-123",
      fullName: "Ada Obi",
      role: "PATIENT",
      ...(opts.phone === undefined ? { phone: LOCAL_PHONE } : opts.phone ? { phone: opts.phone } : {}),
    })
    .expect(201);
  return {
    app,
    auth: { Authorization: `Bearer ${res.body.token as string}` },
    advance: (minutes) => {
      clock = new Date(clock.getTime() + minutes * 60_000);
    },
  };
}

const dial = (app: Harness["app"], text: string, phoneNumber = DIALLED) =>
  request(app).post("/ussd").send({ sessionId: "ses_1", phoneNumber, text });

describe("USSD session", () => {
  it("tells an unregistered number to sign up, and closes the session", async () => {
    const { app } = await patient();
    const res = await dial(app, "", "+2348090000000").expect(200);
    expect(res.text).toMatch(/^END /);
    expect(res.text).toContain("not registered");
  });

  it("tells a registered patient with no PIN to set one in the app", async () => {
    const { app } = await patient();
    const res = await dial(app, "").expect(200);
    expect(res.text).toBe("END No USSD PIN yet. Open the MedRekk app, go to Profile and set a 4-digit USSD PIN.");
  });

  it("asks for the PIN once one is set", async () => {
    const { app, auth } = await patient();
    await request(app).patch("/patients/me/ussd-pin").set(auth).send({ pin: GOOD_PIN }).expect(200);
    const res = await dial(app, "").expect(200);
    expect(res.text).toMatch(/^CON /);
    expect(res.text).toContain("Enter your 4-digit PIN");
  });

  it("counts down remaining tries on a wrong PIN", async () => {
    const { app, auth } = await patient();
    await request(app).patch("/patients/me/ussd-pin").set(auth).send({ pin: GOOD_PIN }).expect(200);
    const first = await dial(app, "0001").expect(200);
    expect(first.text).toContain("4 tries left");
    const second = await dial(app, "0002").expect(200);
    expect(second.text).toContain("3 tries left");
  });

  it("locks the account after five wrong PINs, and lifts the lock when it expires", async () => {
    const { app, auth, advance } = await patient();
    await request(app).patch("/patients/me/ussd-pin").set(auth).send({ pin: GOOD_PIN }).expect(200);

    for (const wrong of ["0001", "0002", "0003", "0004"]) {
      expect((await dial(app, wrong).expect(200)).text).toMatch(/^CON /);
    }
    const locked = await dial(app, "0005").expect(200);
    expect(locked.text).toMatch(/^END /);
    expect(locked.text).toContain("Too many wrong PINs");

    // Still refused while the lock holds, even with the right PIN.
    const during = await dial(app, GOOD_PIN).expect(200);
    expect(during.text).toContain("Too many wrong PINs");

    advance(16);
    const after = await dial(app, "").expect(200);
    expect(after.text).toContain("Enter your 4-digit PIN");
  });

  it("shows the menu on a correct PIN and re-prompts on an unknown choice", async () => {
    const { app, auth } = await patient();
    await request(app).patch("/patients/me/ussd-pin").set(auth).send({ pin: GOOD_PIN }).expect(200);

    const menu = await dial(app, GOOD_PIN).expect(200);
    expect(menu.text).toMatch(/^CON /);
    expect(menu.text).toContain("1. My emergency card");

    const bad = await dial(app, `${GOOD_PIN}*9`).expect(200);
    expect(bad.text).toMatch(/^CON /);
    expect(bad.text).toContain("Not one of the options");

    // After a re-prompt the aggregator sends the whole trail; the last step is the answer.
    const recovered = await dial(app, `${GOOD_PIN}*9*2`).expect(200);
    expect(recovered.text).toMatch(/^END /);
    expect(recovered.text).toContain("MedRekk Code is MRK-");
  });

  it("reads back the emergency card, and nothing beyond it", async () => {
    const { app, auth } = await patient();
    await request(app).patch("/patients/me/ussd-pin").set(auth).send({ pin: GOOD_PIN }).expect(200);
    await request(app)
      .put("/patients/me/emergency-profile")
      .set(auth)
      .send({
        criticalAllergies: ["Penicillin", "Sulfa drugs"],
        bloodGroup: "O+",
        emergencyContact: { name: "Ngozi", phone: "08012345678", relationship: "Sister" },
      })
      .expect(200);

    const res = await dial(app, `${GOOD_PIN}*1`).expect(200);
    expect(res.text).toMatch(/^END /);
    expect(res.text).toContain("Blood: O+");
    expect(res.text).toContain("Penicillin");
    expect(res.text).toContain("Contact: Ngozi");
  });

  it("says the card is empty rather than printing a bare name", async () => {
    const { app, auth } = await patient();
    await request(app).patch("/patients/me/ussd-pin").set(auth).send({ pin: GOOD_PIN }).expect(200);
    const res = await dial(app, `${GOOD_PIN}*1`).expect(200);
    expect(res.text).toContain("Nothing on your emergency card yet");
  });

  it("records every USSD read in the patient's own audit log", async () => {
    const { app, auth } = await patient();
    await request(app).patch("/patients/me/ussd-pin").set(auth).send({ pin: GOOD_PIN }).expect(200);
    await dial(app, `${GOOD_PIN}*1`).expect(200);

    const log = await request(app).get("/patients/me/audit").set(auth).expect(200);
    const entries = log.body as { type: string; requesterIdentifier?: string }[];
    expect(entries.some((e) => e.type === "USSD_ACCESSED")).toBe(true);
  });
});

describe("USSD aggregator payload format", () => {
  it("accepts a form-encoded body, which is what real aggregators send", async () => {
    const { app, auth } = await patient();
    await request(app).patch("/patients/me/ussd-pin").set(auth).send({ pin: GOOD_PIN }).expect(200);
    const res = await request(app)
      .post("/ussd")
      .type("form")
      .send({ sessionId: "ses_1", phoneNumber: DIALLED, text: "" })
      .expect(200);
    expect(res.text).toContain("Enter your 4-digit PIN");
  });

  it("ignores a serviceCode it does not recognise rather than failing the session", async () => {
    const { app } = await patient();
    const res = await request(app)
      .post("/ussd")
      .type("form")
      .send({ sessionId: "ses_1", phoneNumber: DIALLED, text: "", serviceCode: "*347*123#" })
      .expect(200);
    expect(res.text).toMatch(/^END /);
  });
});

describe("USSD PIN management", () => {
  it("rejects a PIN that is four of the same digit or a run", async () => {
    const { app, auth } = await patient();
    for (const pin of ["0000", "1111", "1234", "4321"]) {
      await request(app).patch("/patients/me/ussd-pin").set(auth).send({ pin }).expect(400);
    }
    await request(app).patch("/patients/me/ussd-pin").set(auth).send({ pin: "12" }).expect(400);
    await request(app).patch("/patients/me/ussd-pin").set(auth).send({ pin: "abcd" }).expect(400);
  });

  it("refuses a PIN when the account has no phone number to dial from", async () => {
    const { app, auth } = await patient({ phone: "" });
    const res = await request(app).patch("/patients/me/ussd-pin").set(auth).send({ pin: GOOD_PIN }).expect(400);
    expect(res.body.error.code).toBe("PHONE_REQUIRED");
  });

  it("reports whether a PIN is set, and lets the patient turn USSD off", async () => {
    const { app, auth } = await patient();
    expect((await request(app).get("/patients/me/ussd-pin").set(auth).expect(200)).body.set).toBe(false);
    await request(app).patch("/patients/me/ussd-pin").set(auth).send({ pin: GOOD_PIN }).expect(200);
    expect((await request(app).get("/patients/me/ussd-pin").set(auth).expect(200)).body.set).toBe(true);

    await request(app).delete("/patients/me/ussd-pin").set(auth).expect(200);
    expect((await request(app).get("/patients/me/ussd-pin").set(auth).expect(200)).body.set).toBe(false);
    const res = await dial(app, "").expect(200);
    expect(res.text).toContain("No USSD PIN yet");
  });

  it("is a patient-only endpoint", async () => {
    const app = buildApp({ config });
    const worker = await request(app)
      .post("/auth/register")
      .send({ email: "hw@example.com", password: "password-123", fullName: "Ngozi Eze", role: "HEALTH_WORKER" })
      .expect(201);
    await request(app)
      .patch("/patients/me/ussd-pin")
      .set({ Authorization: `Bearer ${worker.body.token as string}` })
      .send({ pin: GOOD_PIN })
      .expect(403);
  });

  it("requires authentication", async () => {
    await request(buildApp({ config })).patch("/patients/me/ussd-pin").send({ pin: GOOD_PIN }).expect(401);
  });
});

describe("the dialling number", () => {
  it("can be added after sign-up, which is how an existing account turns USSD on", async () => {
    const { app, auth } = await patient({ phone: "" });
    // No number yet, so a PIN is refused.
    await request(app).patch("/patients/me/ussd-pin").set(auth).send({ pin: GOOD_PIN }).expect(400);

    const added = await request(app).patch("/auth/me/phone").set(auth).send({ phone: LOCAL_PHONE }).expect(200);
    expect(added.body.phone).toBe(DIALLED); // stored in E.164, however it was typed

    await request(app).patch("/patients/me/ussd-pin").set(auth).send({ pin: GOOD_PIN }).expect(200);
    const res = await dial(app, "").expect(200);
    expect(res.text).toContain("Enter your 4-digit PIN");
  });

  it("is found by USSD after it is changed", async () => {
    const { app, auth } = await patient();
    await request(app).patch("/patients/me/ussd-pin").set(auth).send({ pin: GOOD_PIN }).expect(200);
    await request(app).patch("/auth/me/phone").set(auth).send({ phone: "08099998888" }).expect(200);

    const old = await dial(app, "", DIALLED).expect(200);
    expect(old.text).toContain("not registered");
    const current = await dial(app, "", "+2348099998888").expect(200);
    expect(current.text).toContain("Enter your 4-digit PIN");
  });

  it("clearing it also turns off the PIN, which could no longer be dialled", async () => {
    const { app, auth } = await patient();
    await request(app).patch("/patients/me/ussd-pin").set(auth).send({ pin: GOOD_PIN }).expect(200);
    await request(app).patch("/auth/me/phone").set(auth).send({ phone: "" }).expect(200);

    expect((await request(app).get("/patients/me/ussd-pin").set(auth).expect(200)).body.set).toBe(false);
    const res = await dial(app, "").expect(200);
    expect(res.text).toContain("not registered");
  });

  it("refuses a number already on another account", async () => {
    const first = await patient();
    const second = await request(first.app)
      .post("/auth/register")
      .send({ email: "second@example.com", password: "password-123", fullName: "Bola Ade", role: "PATIENT" })
      .expect(201);
    const res = await request(first.app)
      .patch("/auth/me/phone")
      .set({ Authorization: `Bearer ${second.body.token as string}` })
      .send({ phone: LOCAL_PHONE })
      .expect(409);
    expect(res.body.error.code).toBe("PHONE_TAKEN");
  });

  it("rejects a number it cannot read", async () => {
    const { app, auth } = await patient({ phone: "" });
    await request(app).patch("/auth/me/phone").set(auth).send({ phone: "12" }).expect(400);
  });
});

describe("USSD aggregator credentials", () => {
  const guarded: AppConfig = { ...config, USSD_SHARED_SECRET: "s".repeat(24) };

  it("refuses a request without the shared secret once one is configured", async () => {
    const { app } = await patient({ config: guarded });
    await request(app).post("/ussd").send({ sessionId: "ses_1", phoneNumber: DIALLED, text: "" }).expect(401);
  });

  it("accepts the request when the secret matches", async () => {
    const { app } = await patient({ config: guarded });
    const res = await request(app)
      .post("/ussd")
      .set("x-ussd-secret", "s".repeat(24))
      .send({ sessionId: "ses_1", phoneNumber: DIALLED, text: "" })
      .expect(200);
    expect(res.text).toContain("No USSD PIN yet");
  });
});
