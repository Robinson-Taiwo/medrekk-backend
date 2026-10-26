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
  EXPO_PUSH_ENABLED: false,
};

const LOCAL_PHONE = "08031234567";
const DIALLED = "+2348031234567"; // what the aggregator sends for the same SIM
const STRANGER = "+2348090000001"; // a responder's handset, with no MedRekk account
const GOOD_PIN = "8317";

interface Harness {
  app: ReturnType<typeof buildApp>;
  auth: { Authorization: string };
  advance: (minutes: number) => void;
}

async function patient(opts: { phone?: string; config?: AppConfig } = {}): Promise<Harness> {
  let clock = new Date("2026-10-16T10:00:00.000Z");
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

async function withPin(opts: { phone?: string } = {}): Promise<Harness> {
  const h = await patient(opts);
  await request(h.app).patch("/patients/me/ussd-pin").set(h.auth).send({ pin: GOOD_PIN }).expect(200);
  return h;
}

const addClaim = (h: Harness, category: string, value: string) =>
  request(h.app).post("/patients/me/claims").set(h.auth).send({ category, value }).expect(201);

describe("the first menu", () => {
  it("offers both branches before asking anything, including to an unregistered number", async () => {
    const { app } = await patient();
    const res = await dial(app, "", STRANGER).expect(200);
    expect(res.text).toMatch(/^CON /);
    expect(res.text).toContain("1. My record");
    expect(res.text).toContain("2. Emergency lookup");
  });

  it("re-shows the menu on an unknown choice", async () => {
    const { app } = await patient();
    const res = await dial(app, "9").expect(200);
    expect(res.text).toMatch(/^CON /);
    expect(res.text).toContain("Not one of the options");
  });
});

describe("branch 1: the patient's own record", () => {
  it("tells an unregistered number to sign up", async () => {
    const { app } = await patient();
    const res = await dial(app, "1", "+2348090000009").expect(200);
    expect(res.text).toMatch(/^END /);
    expect(res.text).toContain("not registered");
  });

  it("tells a registered patient with no PIN to set one in the app", async () => {
    const { app } = await patient();
    const res = await dial(app, "1").expect(200);
    expect(res.text).toContain("No USSD PIN yet");
  });

  it("asks for the PIN, then shows the record menu", async () => {
    const { app } = await withPin();
    expect((await dial(app, "1").expect(200)).text).toContain("Enter your 4-digit PIN");

    const menu = await dial(app, `1*${GOOD_PIN}`).expect(200);
    expect(menu.text).toMatch(/^CON /);
    expect(menu.text).toContain("1. Medicines");
    expect(menu.text).toContain("5. Recent visits");
  });

  it("counts down tries, locks after five, and lifts the lock when it expires", async () => {
    const h = await withPin();
    expect((await dial(h.app, "1*0001").expect(200)).text).toContain("4 tries left");
    for (const wrong of ["0002", "0003", "0004"]) {
      expect((await dial(h.app, `1*${wrong}`).expect(200)).text).toMatch(/^CON /);
    }
    const locked = await dial(h.app, "1*0005").expect(200);
    expect(locked.text).toMatch(/^END /);
    expect(locked.text).toContain("Too many wrong PINs");

    // Refused even with the right PIN while the lock holds.
    expect((await dial(h.app, `1*${GOOD_PIN}`).expect(200)).text).toContain("Too many wrong PINs");

    h.advance(16);
    expect((await dial(h.app, "1").expect(200)).text).toContain("Enter your 4-digit PIN");
  });

  it("reads back medicines and allergies, not just the emergency card", async () => {
    const h = await withPin();
    await addClaim(h, "CURRENT_MEDICATIONS", "Artemether-lumefantrine");
    await addClaim(h, "ALLERGIES", "Penicillin");

    const meds = await dial(h.app, `1*${GOOD_PIN}*1`).expect(200);
    expect(meds.text).toContain("Artemether-lumefantrine");

    const allergies = await dial(h.app, `1*${GOOD_PIN}*2`).expect(200);
    expect(allergies.text).toContain("Penicillin");
  });

  it("pages a long list instead of dropping entries", async () => {
    const h = await withPin();
    for (const value of ["Penicillin", "Sulfa drugs", "Peanuts", "Aspirin"]) {
      await addClaim(h, "ALLERGIES", value);
    }

    const first = await dial(h.app, `1*${GOOD_PIN}*2`).expect(200);
    expect(first.text).toMatch(/^CON /); // stays open so More can be pressed
    expect(first.text).toContain("0. More");
    expect(first.text).toContain("of 4");

    const second = await dial(h.app, `1*${GOOD_PIN}*2*0`).expect(200);
    expect(second.text).toMatch(/^END /);
    expect(second.text).not.toContain("0. More");

    // The invariant that matters: paging loses nothing. Every allergy appears on
    // one page or the other, however the equal timestamps happen to sort.
    const both = `${first.text}\n${second.text}`;
    for (const value of ["Penicillin", "Sulfa drugs", "Peanuts", "Aspirin"]) {
      expect(both).toContain(value);
    }
  });

  it("says plainly when a category is empty", async () => {
    const { app } = await withPin();
    const res = await dial(app, `1*${GOOD_PIN}*3`).expect(200);
    expect(res.text).toContain("Nothing recorded under tests");
  });

  it("still serves the emergency card and the MedRekk Code", async () => {
    const h = await withPin();
    await request(h.app)
      .put("/patients/me/emergency-profile")
      .set(h.auth)
      .send({ criticalAllergies: ["Penicillin"], bloodGroup: "O+" })
      .expect(200);

    const card = await dial(h.app, `1*${GOOD_PIN}*6`).expect(200);
    expect(card.text).toContain("Blood: O+");

    const code = await dial(h.app, `1*${GOOD_PIN}*7`).expect(200);
    expect(code.text).toContain("MedRekk Code is MRK-");
  });

  it("explains an empty visit list rather than showing nothing", async () => {
    const h = await withPin();
    await addClaim(h, "ALLERGIES", "Penicillin"); // self-entered, so no encounter
    const res = await dial(h.app, `1*${GOOD_PIN}*5`).expect(200);
    expect(res.text).toContain("No visits recorded yet");
  });

  it("records which categories were read in the patient's audit log", async () => {
    const h = await withPin();
    await addClaim(h, "ALLERGIES", "Penicillin");
    await dial(h.app, `1*${GOOD_PIN}*2`).expect(200);

    const log = await request(h.app).get("/patients/me/audit").set(h.auth).expect(200);
    const entries = log.body as { type: string; informationViewed?: string[] }[];
    const ussd = entries.find((e) => e.type === "USSD_ACCESSED");
    expect(ussd).toBeDefined();
    expect(ussd?.informationViewed).toContain("ALLERGIES");
  });
});

describe("branch 2: emergency lookup by code", () => {
  it("works from a handset with no MedRekk account, and shows the card only", async () => {
    const h = await withPin();
    await request(h.app)
      .put("/patients/me/emergency-profile")
      .set(h.auth)
      .send({ criticalAllergies: ["Penicillin"], bloodGroup: "O+" })
      .expect(200);
    const me = await request(h.app).get("/patients/me").set(h.auth).expect(200);
    const code = me.body.medrekkCode as string;

    expect((await dial(h.app, "2", STRANGER).expect(200)).text).toContain("MedRekk Code");

    const card = await dial(h.app, `2*${code}`, STRANGER).expect(200);
    expect(card.text).toMatch(/^END /);
    expect(card.text).toContain("Blood: O+");
    expect(card.text).toContain("Penicillin");
  });

  it("does not expose anything beyond the emergency card", async () => {
    const h = await withPin();
    await addClaim(h, "PAST_MEDICAL_HISTORY", "Appendectomy 2019");
    const me = await request(h.app).get("/patients/me").set(h.auth).expect(200);

    const card = await dial(h.app, `2*${me.body.medrekkCode as string}`, STRANGER).expect(200);
    expect(card.text).not.toContain("Appendectomy");
  });

  it("refuses an unknown code without saying whether the patient exists", async () => {
    const { app } = await patient();
    const res = await dial(app, "2*MRK-ZZZZZZ", STRANGER).expect(200);
    expect(res.text).toMatch(/^END /);
    expect(res.text).toContain("No emergency card found");
  });

  it("writes the dialling number into the patient's audit log", async () => {
    const h = await withPin();
    const me = await request(h.app).get("/patients/me").set(h.auth).expect(200);
    await dial(h.app, `2*${me.body.medrekkCode as string}`, STRANGER).expect(200);

    const log = await request(h.app).get("/patients/me/audit").set(h.auth).expect(200);
    const entries = log.body as { type: string; requesterIdentifier?: string }[];
    const hit = entries.find((e) => e.type === "EMERGENCY_ACCESSED");
    expect(hit?.requesterIdentifier).toContain(STRANGER);
  });
});

describe("USSD aggregator payload format", () => {
  it("accepts a form-encoded body, which is what real aggregators send", async () => {
    const { app } = await patient();
    const res = await request(app)
      .post("/ussd")
      .type("form")
      .send({ sessionId: "ses_1", phoneNumber: DIALLED, text: "" })
      .expect(200);
    expect(res.text).toContain("1. My record");
  });

  it("ignores extra fields an aggregator adds, such as networkCode", async () => {
    const { app } = await patient();
    const res = await request(app)
      .post("/ussd")
      .type("form")
      .send({ sessionId: "s", phoneNumber: DIALLED, text: "", serviceCode: "*384*74161#", networkCode: "63902" })
      .expect(200);
    expect(res.text).toMatch(/^CON /);
  });
});

describe("the dialling number", () => {
  it("can be added after sign-up, which is how an existing account turns USSD on", async () => {
    const { app, auth } = await patient({ phone: "" });
    await request(app).patch("/patients/me/ussd-pin").set(auth).send({ pin: GOOD_PIN }).expect(400);

    const added = await request(app).patch("/auth/me/phone").set(auth).send({ phone: LOCAL_PHONE }).expect(200);
    expect(added.body.phone).toBe(DIALLED);

    await request(app).patch("/patients/me/ussd-pin").set(auth).send({ pin: GOOD_PIN }).expect(200);
    expect((await dial(app, "1").expect(200)).text).toContain("Enter your 4-digit PIN");
  });

  it("is found by USSD after it is changed", async () => {
    const { app, auth } = await withPin();
    await request(app).patch("/auth/me/phone").set(auth).send({ phone: "08099998888" }).expect(200);

    expect((await dial(app, "1", DIALLED).expect(200)).text).toContain("not registered");
    expect((await dial(app, "1", "+2348099998888").expect(200)).text).toContain("Enter your 4-digit PIN");
  });

  it("clearing it also turns off the PIN, which could no longer be dialled", async () => {
    const { app, auth } = await withPin();
    await request(app).patch("/auth/me/phone").set(auth).send({ phone: "" }).expect(200);

    expect((await request(app).get("/patients/me/ussd-pin").set(auth).expect(200)).body.set).toBe(false);
    expect((await dial(app, "1").expect(200)).text).toContain("not registered");
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
    expect((await dial(app, "1").expect(200)).text).toContain("No USSD PIN yet");
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

describe("USSD aggregator credentials", () => {
  const guarded: AppConfig = { ...config, USSD_SHARED_SECRET: "s".repeat(24) };

  it("refuses a request without the shared secret once one is configured", async () => {
    const { app } = await patient({ config: guarded });
    await request(app).post("/ussd").send({ sessionId: "s", phoneNumber: DIALLED, text: "" }).expect(401);
  });

  it("accepts the request when the secret matches", async () => {
    const { app } = await patient({ config: guarded });
    const res = await request(app)
      .post("/ussd")
      .set("x-ussd-secret", "s".repeat(24))
      .send({ sessionId: "s", phoneNumber: DIALLED, text: "" })
      .expect(200);
    expect(res.text).toContain("1. My record");
  });
});
