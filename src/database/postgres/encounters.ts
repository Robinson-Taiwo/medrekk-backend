import type { EncounterRepository } from "../encounterRepository.js";
import type { Encounter } from "../../shared/encounterTypes.js";
import type { Db } from "./db.js";

export function createPostgresEncounterRepository(db: Db): EncounterRepository {
  return {
    create: async (e) => {
      await db.query(
        "INSERT INTO encounters (id, patient_id, worker_user_id, data) VALUES ($1, $2, $3, $4::jsonb)",
        [e.id, e.patientId, e.workerUserId, JSON.stringify(e)],
      );
    },
    findById: async (id) => {
      const res = await db.query<{ data: Encounter }>("SELECT data FROM encounters WHERE id = $1", [id]);
      return res.rows[0]?.data;
    },
    update: async (e) => {
      await db.query("UPDATE encounters SET data = $2::jsonb WHERE id = $1", [e.id, JSON.stringify(e)]);
    },
    listForPatient: async (patientId) => {
      const res = await db.query<{ data: Encounter }>(
        "SELECT data FROM encounters WHERE patient_id = $1 ORDER BY seq DESC",
        [patientId],
      );
      return res.rows.map((r) => r.data);
    },
  };
}
