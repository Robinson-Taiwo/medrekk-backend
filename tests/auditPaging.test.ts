import request from "supertest";
import { describe, expect, it } from "vitest";
import { buildApp } from "../src/app.js";
import type { AppConfig } from "../src/config.js";
import { createMemoryRepositories, emptyStore, seedDemoData } from "../src/database/memory.js";
import type { Repositories } from "../src/database/repositories.js";
import type { AuditType } from "../src/shared/types.js";

/**
 * The audit trail is the one list with no ceiling: a row for every view, every emergency
 * scan, every dial-in. These pin that it comes back newest first, one page at a time, and
 * that the cursor survives rows arriving while somebody is reading.
 */

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

/**
 * Rows are appended straight to the store rather than driven through /access/lookup, which
 * is rate limited to ten a minute — the limiter is correct, and fighting it would only make
 * this test about the limiter.
 */
function makeApp(): { app: ReturnType<typeof buildApp>; repos: Repositories } {
  const store = emptyStore();
  seedDemoData(store);
  const repos = createMemoryRepositories(store);
  return { app: buildApp({ config, repos, now: () => new Date("2026-10-26T09:00:00Z") }), repos };
}
type TestApp = ReturnType<typeof buildApp>;

interface AuditRow { id: string; type: string; occurredAt: string }
interface AuditPage { items: AuditRow[]; nextCursor?: string }

let written = 0;

async function makeRows(
  repos: Repositories,
  n: number,
  type: AuditType = "RECORD_VIEWED",
  day = 26,
): Promise<void> {
  for (let i = 0; i < n; i++) {
    written += 1;
    await repos.audit.append({
      id: `aud_${written}`,
      patientId: "pat_demo_amaka",
      type,
      accessType: "NORMAL",
      // A second apart, so "newest first" is checkable without relying on insertion order.
      occurredAt: new Date(Date.UTC(2026, 9, day, 9, 0, written)).toISOString(),
    });
  }
}

const page = async (app: TestApp, query = ""): Promise<AuditPage> => {
  const res = await request(app).get(`/patients/me/audit${query}`).set(patient).expect(200);
  return res.body as AuditPage;
};

describe("paging the access history", () => {
  it("returns a page and a cursor, not the whole trail", async () => {
    const { app, repos } = makeApp();
    await makeRows(repos, 12);

    const first = await page(app, "?limit=5");
    expect(first.items).toHaveLength(5);
    expect(first.nextCursor).toBe(first.items[4]?.id);
  });

  it("walks the whole trail without repeating or skipping a row", async () => {
    const { app, repos } = makeApp();
    await makeRows(repos, 12);

    const seen: string[] = [];
    let cursor: string | undefined;
    for (let guard = 0; guard < 10; guard++) {
      const p: AuditPage = await page(app, `?limit=5${cursor ? `&cursor=${cursor}` : ""}`);
      seen.push(...p.items.map((e) => e.id));
      cursor = p.nextCursor;
      if (!cursor) break;
    }
    expect(seen).toHaveLength(12);
    expect(new Set(seen).size).toBe(12);
  });

  it("is newest first", async () => {
    const { app, repos } = makeApp();
    await makeRows(repos, 4);
    const all = await page(app, "?limit=100");
    const times = all.items.map((e) => Date.parse(e.occurredAt));
    expect([...times].sort((a, b) => b - a)).toEqual(times);
  });

  it("a row added mid-read does not shift the next page", async () => {
    // The case offset paging gets wrong: with ?offset=5 a new row at the top would push one
    // the reader already saw onto the second page.
    const { app, repos } = makeApp();
    await makeRows(repos, 10);

    const first = await page(app, "?limit=5");
    await makeRows(repos, 3); // three more arrive while they read
    const second = await page(app, `?limit=5&cursor=${first.nextCursor ?? ""}`);

    const overlap = second.items.filter((e) => first.items.some((f) => f.id === e.id));
    expect(overlap).toEqual([]);
  });

  it("refuses a limit big enough to pull the whole trail", async () => {
    const { app } = makeApp();
    await request(app).get("/patients/me/audit?limit=5000").set(patient).expect(400);
    await request(app).get("/patients/me/audit?limit=0").set(patient).expect(400);
  });

  it("defaults to a page rather than everything", async () => {
    const { app, repos } = makeApp();
    await makeRows(repos, 40);
    const all = await page(app);
    expect(all.items).toHaveLength(25);
    expect(all.nextCursor).toBeTruthy();
  });

  it("stays the patient's own trail", async () => {
    const { app, repos } = makeApp();
    await makeRows(repos, 3);
    await request(app).get("/patients/me/audit").set(worker).expect(403);
    await request(app).get("/patients/me/audit").expect(401);
  });

  it("an unknown cursor returns nothing rather than starting again", async () => {
    const { app, repos } = makeApp();
    await makeRows(repos, 6);
    const p = await page(app, "?limit=5&cursor=aud_does_not_exist");
    expect(p.items).toEqual([]);
    expect(p.nextCursor).toBeUndefined();
  });
});
describe("filtering the access history", () => {
  it("narrows to one group without the caller naming event types", async () => {
    const { app, repos } = makeApp();
    await makeRows(repos, 3, "RECORD_VIEWED");
    await makeRows(repos, 2, "ACCESS_APPROVED");
    await makeRows(repos, 4, "CLAIM_VERIFIED");

    const views = await page(app, "?group=views&limit=50");
    expect(views.items).toHaveLength(3);
    expect(views.items.every((e) => e.type === "RECORD_VIEWED")).toBe(true);

    const access = await page(app, "?group=access&limit=50");
    expect(access.items).toHaveLength(2);

    const changes = await page(app, "?group=changes&limit=50");
    expect(changes.items).toHaveLength(4);
  });

  it("narrows to a date range", async () => {
    const { app, repos } = makeApp();
    await makeRows(repos, 3, "RECORD_VIEWED", 20); // older
    await makeRows(repos, 2, "RECORD_VIEWED", 26); // recent

    const recent = await page(app, "?since=2026-10-25T00:00:00.000Z&limit=50");
    expect(recent.items).toHaveLength(2);

    const old = await page(app, "?until=2026-10-25T00:00:00.000Z&limit=50");
    expect(old.items).toHaveLength(3);
  });

  it("pages a filtered trail, not the whole one", async () => {
    // The thing that breaks when filtering is bolted on after paging: page two must be the
    // next matching rows, not whatever the second page of everything happened to contain.
    const { app, repos } = makeApp();
    await makeRows(repos, 6, "RECORD_VIEWED");
    await makeRows(repos, 20, "CLAIM_VERIFIED");

    const first = await page(app, "?group=views&limit=4");
    expect(first.items).toHaveLength(4);
    const second = await page(app, `?group=views&limit=4&cursor=${first.nextCursor ?? ""}`);
    expect(second.items).toHaveLength(2);
    expect(second.items.every((e) => e.type === "RECORD_VIEWED")).toBe(true);
    expect(second.nextCursor).toBeUndefined();
  });

  it("refuses a group it does not define, rather than silently showing everything", async () => {
    const { app } = makeApp();
    await request(app).get("/patients/me/audit?group=whatever").set(patient).expect(400);
    await request(app).get("/patients/me/audit?since=last-tuesday").set(patient).expect(400);
  });
});
