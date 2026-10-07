import type { User, UserRepository } from "../../auth/userRepository.js";
import type { CredentialStatus } from "../../shared/types.js";
import { AppError } from "../../utils/errors.js";
import { newId } from "../../utils/ids.js";

export interface AdminDeps {
  users: UserRepository;
  adminEmails: readonly string[];
  now: () => Date;
}

export interface HealthWorkerSummary {
  id: string;
  fullName: string;
  email: string;
  facility: string | null;
  credentialStatus: CredentialStatus;
  createdAt: string;
}

export interface CredentialChange {
  id: string;
  adminUserId: string;
  adminEmail: string;
  targetUserId: string;
  targetName: string;
  previousStatus: CredentialStatus;
  newStatus: CredentialStatus;
  changedAt: string;
}

const toSummary = (u: User): HealthWorkerSummary => ({
  id: u.id,
  fullName: u.fullName,
  email: u.email,
  facility: u.facility,
  credentialStatus: u.credentialStatus ?? "PENDING",
  createdAt: u.createdAt,
});

export class AdminService {
  // In memory for now, like everything else. Replace with a persistent adapter later.
  private readonly changes: CredentialChange[] = [];

  constructor(private readonly deps: AdminDeps) {}

  private async assertAdmin(userId: string): Promise<User> {
    const admin = await this.deps.users.findById(userId);
    if (!admin || !this.deps.adminEmails.includes(admin.email.toLowerCase())) {
      throw new AppError(403, "FORBIDDEN", "Admin access required.");
    }
    return admin;
  }

  async listHealthWorkers(adminUserId: string, status?: CredentialStatus): Promise<HealthWorkerSummary[]> {
    await this.assertAdmin(adminUserId);
    const workers = (await this.deps.users.listByRole("HEALTH_WORKER")).map(toSummary);
    return status ? workers.filter((w) => w.credentialStatus === status) : workers;
  }

  async setCredential(adminUserId: string, targetUserId: string, status: CredentialStatus): Promise<HealthWorkerSummary> {
    const admin = await this.assertAdmin(adminUserId);
    const target = await this.deps.users.findById(targetUserId);
    if (!target) throw new AppError(404, "USER_NOT_FOUND", "User not found.");
    if (target.role !== "HEALTH_WORKER") {
      throw new AppError(400, "NOT_A_HEALTH_WORKER", "Only health worker accounts have a credential status.");
    }
    const previous: CredentialStatus = target.credentialStatus ?? "PENDING";
    const updated: User = { ...target, credentialStatus: status };
    if (previous !== status) {
      await this.deps.users.update(updated);
      this.changes.push({
        id: newId("crd"),
        adminUserId: admin.id,
        adminEmail: admin.email,
        targetUserId: target.id,
        targetName: target.fullName,
        previousStatus: previous,
        newStatus: status,
        changedAt: this.deps.now().toISOString(),
      });
    }
    return toSummary(updated);
  }

  async credentialLog(adminUserId: string): Promise<CredentialChange[]> {
    await this.assertAdmin(adminUserId);
    return [...this.changes];
  }
}
