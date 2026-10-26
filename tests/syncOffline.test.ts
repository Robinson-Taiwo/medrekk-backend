import request from "supertest";
import { describe, expect, it } from "vitest";
import { buildApp } from "../src/app.js";
import type { AppConfig } from "../src/config.js";

const config: AppConfig = {
  NODE_ENV: "test",
  PORT: 0,
  AUTH_MODE: "dev",
  JWT_SECRET: "x".repeat(32),
  SEED_DEMO_DATA: true,
  CORS_ORIGIN: "http://localhost:3000",
  EXPO_PUSH_ENABLED: false,
};

const patient = { "x-actor-id": "pat_demo_amaka", "x-actor-role": "PATIENT" };
const worker = { "x-actor-id": "hw_1", "x-actor-role": "HEALTH_WORKER" };
const lookup = { medrekkCode: "MRK-82941", patientName: "Amaka Okafor" };

const makeApp = () => buildApp({ config, now: () => new Date("2026-10-17T09:00:00Z") });
type TestApp = ReturnType<typeof makeApp>;

async function approved(app: TestApp): Promise<string> {
  const { body } = await request(app).post("/access/lookup").send(lookup).expect(201);
  await request(app)
    .post(`/access/${body.session}/request`)
    .set(worker)
    .send({
      requesterName: "Nurse Ada",
      requesterRole: "NURSE",
      reason: "Clinic visit",
      scopes: ["RECENT_ENCOUNTERS", "ALLERGIES"],
      durationMinutes: 120,
    })
    .expect(202);
  const pending = await request(app).get("/patients/me/access-requests").set(patient).expect(200);
  await request(app)
    .post(`/patients/me/access-requests/${pending.body[0].id as string}/decision`)
    .set(patient)
    .send({ decision: "APPROVE" })
    .expect(200);
  return body.session as string;
}

/** What a handset builds while it has no connection. */
function queued(accessToken: string, encounterId: string, operationId: string) {
  return {
    operationId,
    entityType: "encounters",
    entityId: encounterId,
    operation: "CREATE",
    payload: {
      accessToken,
      rawInput: "Patient says she is allergic to penicillin and has coughed for three days.",
      captureMethod: "VOICE",
      items: [
        { category: "ALLERGIES", value: "Penicillin", excerpt: "allergic to penicillin" },
        { category: "RECENT_ENCOUNTERS", value: "Cough for three days" },
      ],
    },
    createdAt: "2026-10-17T08:30:00Z",
  };
}

const countClaims = async (app: TestApp): Promise<number> => {
  const { body } = await request(app).get("/patients/me/claims").set(patient).expect(200);
  return (body as unknown[]).length;
};

describe("a visit captured with no connection", () => {
  it("reaches the record once it syncs", async () => {
    const app = makeApp();
    const token = await approved(app);
    const before = await countClaims(app);

    const res = await request(app)
      .post("/sync/push")
      .set(worker)
      .send({ operations: [queued(token, "enc_offline-aaaa-1111-bbbb", "op_offline_0001")] })
      .expect(200);

    expect(res.body.results[0].status).toBe("SYNCED");

    // The real test is the record, not the response.
    expect(await countClaims(app)).toBe(before + 2);

    const encounter = await request(app)
      .get(`/access/${token}/encounters/enc_offline-aaaa-1111-bbbb`)
      .set(worker)
      .expect(200);
    expect(encounter.body.status).toBe("REVIEWED");
    expect(encounter.body.rawInput).toContain("penicillin");
  });

  it("does not write the visit twice when the queue is replayed", async () => {
    const app = makeApp();
    const token = await approved(app);
    const before = await countClaims(app);
    const op = queued(token, "enc_offline-aaaa-2222-bbbb", "op_offline_0002");

    await request(app).post("/sync/push").set(worker).send({ operations: [op] }).expect(200);
    const after = await countClaims(app);

    const replay = await request(app)
      .post("/sync/push")
      .set(worker)
      .send({ operations: [op] })
      .expect(200);

    expect(replay.body.results[0].status).toBe("DUPLICATE");
    expect(await countClaims(app)).toBe(after);
    expect(after).toBe(before + 2);
  });

  it("writes the visit once even if the same encounter arrives under a new operation id", async () => {
    const app = makeApp();
    const token = await approved(app);
    const before = await countClaims(app);
    const id = "enc_offline-aaaa-3333-bbbb";

    await request(app).post("/sync/push").set(worker).send({ operations: [queued(token, id, "op_offline_0003")] });
    const after = await countClaims(app);

    // A handset that lost the reply and re-queued under a fresh operation id.
    const again = await request(app)
      .post("/sync/push")
      .set(worker)
      .send({ operations: [queued(token, id, "op_offline_0003_retry")] })
      .expect(200);

    expect(again.body.results[0].status).toBe("SYNCED");
    expect(await countClaims(app)).toBe(after);
  });

  it("reports FAILED rather than silently dropping an entity it cannot apply", async () => {
    const app = makeApp();
    const token = await approved(app);

    const res = await request(app)
      .post("/sync/push")
      .set(worker)
      .send({
        operations: [
          { ...queued(token, "enc_offline-aaaa-4444-bbbb", "op_offline_0004"), entityType: "vitals" },
        ],
      })
      .expect(200);

    expect(res.body.results[0].status).toBe("FAILED");
  });

  it("refuses an operation whose access grant is not the worker's", async () => {
    const app = makeApp();
    await approved(app);

    const res = await request(app)
      .post("/sync/push")
      .set(worker)
      .send({ operations: [queued("tok_" + "z".repeat(28), "enc_offline-aaaa-5555-bbbb", "op_offline_0005")] })
      .expect(200);

    expect(res.body.results[0].status).toBe("FAILED");
  });
});
