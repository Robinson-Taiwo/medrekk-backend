import type {
  AccessScope, AccessSession, AuditEvent, ClinicalClaim, EmergencyProfile, Patient, SyncOperation,
} from "../shared/types.js";

export interface PatientRepository {
  findByCode(code: string): Promise<Patient | undefined>;
  findById(id: string): Promise<Patient | undefined>;
}
export interface SessionRepository {
  create(session: AccessSession): Promise<void>;
  findByTokenHash(hash: string): Promise<AccessSession | undefined>;
  findById(id: string): Promise<AccessSession | undefined>;
  update(session: AccessSession): Promise<void>;
  listForPatient(patientId: string): Promise<AccessSession[]>;
}
export interface RecordRepository {
  claimsFor(patientId: string, scope: AccessScope): Promise<ClinicalClaim[]>;
}
export interface EmergencyRepository {
  profileFor(patientId: string): Promise<EmergencyProfile | undefined>;
}
export interface AuditRepository {
  append(event: AuditEvent): Promise<void>;
  listForPatient(patientId: string): Promise<AuditEvent[]>;
}
export interface SyncRepository {
  has(operationId: string): Promise<boolean>;
  save(op: SyncOperation, actorId: string): Promise<void>;
}

export interface Repositories {
  patients: PatientRepository;
  sessions: SessionRepository;
  records: RecordRepository;
  emergency: EmergencyRepository;
  audit: AuditRepository;
  sync: SyncRepository;
}
