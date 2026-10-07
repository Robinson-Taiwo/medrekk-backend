import type {
  AccessScope, AccessSession, AuditEvent, ClinicalClaim, EmergencyProfile, Patient, SyncOperation,
} from "../shared/types.js";
import type { Repositories } from "./repositories.js";

export interface MemoryStore {
  patients: Map<string, Patient>;
  claims: ClinicalClaim[];
  emergency: Map<string, EmergencyProfile>;
}

/** In-memory adapter used for development/tests/hackathon demo. Swap for a persistent adapter later. */
export function createMemoryRepositories(store: MemoryStore): Repositories {
  const sessions = new Map<string, AccessSession>();
  const audit: AuditEvent[] = [];
  const syncOps = new Map<string, { op: SyncOperation; actorId: string }>();

  return {
    patients: {
      findByCode: async (code) => [...store.patients.values()].find((p) => p.medrekkCode === code),
      findById: async (id) => store.patients.get(id),
      create: async (p) => void store.patients.set(p.id, p),
    },
    sessions: {
      create: async (s) => void sessions.set(s.id, s),
      findByTokenHash: async (hash) => [...sessions.values()].find((s) => s.tokenHash === hash),
      findById: async (id) => sessions.get(id),
      update: async (s) => void sessions.set(s.id, s),
      listForPatient: async (patientId) => [...sessions.values()].filter((s) => s.patientId === patientId),
    },
    records: {
      claimsFor: async (patientId: string, scope: AccessScope) =>
        store.claims.filter((c) => c.patientId === patientId && c.category === scope),
      allFor: async (patientId: string) => store.claims.filter((c) => c.patientId === patientId),
      add: async (claim) => void store.claims.push(claim),
    },
    emergency: {
      profileFor: async (patientId) => store.emergency.get(patientId),
      save: async (profile) => void store.emergency.set(profile.patientId, profile),
    },
    audit: {
      append: async (e) => void audit.push(e),
      listForPatient: async (patientId) => audit.filter((e) => e.patientId === patientId),
    },
    sync: {
      has: async (id) => syncOps.has(id),
      save: async (op, actorId) => void syncOps.set(op.operationId, { op, actorId }),
    },
  };
}

export function emptyStore(): MemoryStore {
  return { patients: new Map(), claims: [], emergency: new Map() };
}

export function seedDemoData(store: MemoryStore): void {
  const patientId = "pat_demo_amaka";
  const now = new Date().toISOString();
  store.patients.set(patientId, {
    id: patientId, medrekkCode: "MRK-82941", fullName: "Amaka Okafor", createdAt: now,
  });
  const claim = (
    id: string, category: AccessScope, value: string, status: ClinicalClaim["status"], source: string,
  ): ClinicalClaim => ({ id, patientId, category, value, status, source, lastConfirmedAt: now });
  store.claims.push(
    claim("clm_1", "ALLERGIES", "Penicillin", "CLINICALLY_VERIFIED", "Clinic encounter"),
    claim("clm_2", "CURRENT_MEDICATIONS", "Metformin 500 mg twice daily", "EVIDENCE_BACKED", "Prescription"),
    claim("clm_3", "RECENT_ENCOUNTERS", "Cough for 3 days; reviewed at community clinic", "CLINICALLY_VERIFIED", "Clinic encounter"),
    claim("clm_4", "PAST_MEDICAL_HISTORY", "Type 2 diabetes (2021)", "SELF_REPORTED", "Patient"),
  );
  store.emergency.set(patientId, {
    patientId,
    criticalAllergies: ["Penicillin"],
    criticalConditions: ["Type 2 diabetes"],
    criticalMedications: ["Metformin"],
    implantedDevices: [],
    bloodGroup: "O+",
    importantWarnings: ["Diabetic - check blood glucose"],
    emergencyContact: { name: "Chidi Okafor", phone: "+2348000000000", relationship: "Brother" },
    verificationStatus: "EVIDENCE_BACKED",
    lastConfirmedAt: now,
  });
}