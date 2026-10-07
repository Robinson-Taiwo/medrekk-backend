import type {
  AccessScope, AccessSession, AuditEvent, ClinicalClaim, EmergencyProfile, Evidence, Patient, SyncOperation,
  VerificationEvent,
} from "../shared/types.js";

export interface PatientRepository {
  findByCode(code: string): Promise<Patient | undefined>;
  findById(id: string): Promise<Patient | undefined>;
  create(patient: Patient): Promise<void>;
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
  allFor(patientId: string): Promise<ClinicalClaim[]>;
  findById(claimId: string): Promise<ClinicalClaim | undefined>;
  add(claim: ClinicalClaim): Promise<void>;
  update(claim: ClinicalClaim): Promise<void>;
}
export interface EvidenceRepository {
  add(evidence: Evidence): Promise<void>;
  listForClaim(claimId: string): Promise<Evidence[]>;
}
export interface VerificationRepository {
  append(event: VerificationEvent): Promise<void>;
  listForPatient(patientId: string): Promise<VerificationEvent[]>;
}
export interface EmergencyRepository {
  profileFor(patientId: string): Promise<EmergencyProfile | undefined>;
  save(profile: EmergencyProfile): Promise<void>;
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
  evidence: EvidenceRepository;
  verifications: VerificationRepository;
  emergency: EmergencyRepository;
  audit: AuditRepository;
  sync: SyncRepository;
}
