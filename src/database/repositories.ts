import type {
  Page,
  AccessScope, AccessSession, AuditEvent, AuditType, ClinicalClaim, EmergencyProfile, Evidence, Patient, SyncOperation,
  VerificationEvent,
} from "../shared/types.js";

import type { PatientProfile } from "../shared/profile.js";

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
  /** Every session a given health-worker account requested, so a grant survives sign-out. */
  listForRequester(workerUserId: string): Promise<AccessSession[]>;
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
export interface PageQuery {
  limit: number;
  /** Id of the last row the caller already has. */
  cursor?: string;
}

export interface AuditQuery extends PageQuery {
  /** Only these event types. Absent means every type. */
  types?: readonly AuditType[];
  /** Inclusive ISO lower bound on occurredAt. */
  since?: string;
  /** Exclusive ISO upper bound on occurredAt. */
  until?: string;
}
export interface AuditRepository {
  append(event: AuditEvent): Promise<void>;
  /** Newest first. The trail is append-only and unbounded, so it is never returned whole. */
  listForPatient(patientId: string, query: AuditQuery): Promise<Page<AuditEvent>>;
}
export interface SyncRepository {
  has(operationId: string): Promise<boolean>;
  save(op: SyncOperation, actorId: string): Promise<void>;
}

export interface ProfileRepository {
  get(patientId: string): Promise<PatientProfile | undefined>;
  save(patientId: string, profile: PatientProfile): Promise<void>;
}

export interface Repositories {
  profiles: ProfileRepository;
  patients: PatientRepository;
  sessions: SessionRepository;
  records: RecordRepository;
  evidence: EvidenceRepository;
  verifications: VerificationRepository;
  emergency: EmergencyRepository;
  audit: AuditRepository;
  sync: SyncRepository;
}
