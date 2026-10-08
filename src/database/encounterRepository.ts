import type { Encounter } from "../shared/encounterTypes.js";

export interface EncounterRepository {
  create(encounter: Encounter): Promise<void>;
  findById(id: string): Promise<Encounter | undefined>;
  update(encounter: Encounter): Promise<void>;
  listForPatient(patientId: string): Promise<Encounter[]>;
}

export function createMemoryEncounterRepository(): EncounterRepository {
  const rows = new Map<string, Encounter>();
  return {
    create: async (e) => void rows.set(e.id, e),
    findById: async (id) => rows.get(id),
    update: async (e) => void rows.set(e.id, e),
    listForPatient: async (patientId) =>
      [...rows.values()]
        .filter((e) => e.patientId === patientId)
        .sort((a, b) => b.createdAt.localeCompare(a.createdAt)),
  };
}
