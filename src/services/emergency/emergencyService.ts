import type { Repositories } from "../../database/repositories.js";
import { AppError } from "../../utils/errors.js";
import { newId } from "../../utils/ids.js";

export class EmergencyService {
  constructor(private readonly deps: { repos: Repositories; now: () => Date }) {}

  /** Minimal emergency profile only. Every access is audited; no patient approval required. */
  async access(code: string, ctx: { requesterIdentifier: string; reason: string }) {
    const { repos, now } = this.deps;
    const patient = await repos.patients.findByCode(code);
    const profile = patient ? await repos.emergency.profileFor(patient.id) : undefined;
    if (!patient || !profile) throw new AppError(404, "EMERGENCY_PROFILE_NOT_FOUND", "No emergency profile found.");
    const accessedAt = now().toISOString();
    await repos.audit.append({
      id: newId("aud"), patientId: patient.id, type: "EMERGENCY_ACCESSED", accessType: "EMERGENCY",
      occurredAt: accessedAt, requesterIdentifier: ctx.requesterIdentifier, reason: ctx.reason,
      informationViewed: ["EMERGENCY_PROFILE"],
    });
    const { patientId: _omit, ...fields } = profile;
    return { patientName: patient.fullName, emergencyId: patient.medrekkCode, ...fields, accessLoggedAt: accessedAt };
  }
}
