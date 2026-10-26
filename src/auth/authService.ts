import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import { randomUUID } from "node:crypto";
import {
  TokenPayloadSchema,
  type AuthContext,
  type AuthResponse,
  type LoginInput,
  type PublicUser,
  type CredentialSubmissionInput,
  type RegisterInput,
} from "../shared/auth.js";
import type { Patient } from "../shared/types.js";
import { AppError } from "../utils/errors.js";
import type { CredentialDocumentRepository, User, UserRepository } from "./userRepository.js";
import { normalizePhone } from "../shared/phone.js";

const TOKEN_TTL = "12h"; // TODO: short-lived access token + refresh token later
const BCRYPT_ROUNDS = 10;

// Compared against when the email is unknown, so login timing doesn't reveal which emails exist.
const DUMMY_HASH = bcrypt.hashSync("not-a-real-password", BCRYPT_ROUNDS);

export interface PatientProvisioner {
  provision(fullName: string): Promise<Patient>;
}

function toPublic(user: User): PublicUser {
  return {
    id: user.id,
    email: user.email,
    fullName: user.fullName,
    role: user.role,
    patientId: user.patientId,
    facility: user.facility,
    credentialStatus: user.credentialStatus,
    phone: user.phone ?? null,
    ...(user.licence ? { licence: user.licence, hasLicenceDocument: user.licence.documentId !== null } : {}),
  };
}

export class AuthService {
  constructor(
    private readonly users: UserRepository,
    private readonly secret: string,
    private readonly provisioner: PatientProvisioner,
    private readonly documents?: CredentialDocumentRepository,
  ) {
    if (secret.length < 32) throw new Error("JWT_SECRET must be at least 32 characters");
  }

  private issue(user: User): AuthResponse {
    const token = jwt.sign({ role: user.role, pid: user.patientId }, this.secret, {
      algorithm: "HS256",
      subject: user.id,
      expiresIn: TOKEN_TTL,
    });
    return { token, user: toPublic(user) };
  }

  async register(input: RegisterInput): Promise<AuthResponse> {
    if (await this.users.findByEmail(input.email)) {
      throw new AppError(409, "EMAIL_TAKEN", "An account with this email already exists.");
    }
    const phone = input.phone ? normalizePhone(input.phone) : null;
    if (input.phone && !phone) throw new AppError(400, "INVALID_PHONE", "Enter a valid phone number.");
    if (phone && (await this.users.findByPhone(phone))) {
      throw new AppError(409, "PHONE_TAKEN", "An account with this phone number already exists.");
    }
    // A patient is fully functional alone: registration creates the real record, code and emergency profile.
    const patient = input.role === "PATIENT" ? await this.provisioner.provision(input.fullName) : null;
    const user: User = {
      id: `usr_${randomUUID()}`,
      email: input.email,
      passwordHash: await bcrypt.hash(input.password, BCRYPT_ROUNDS),
      fullName: input.fullName,
      role: input.role,
      patientId: patient ? patient.id : null,
      facility: input.facility ?? null,
      // Anyone can register as a health worker, but cannot clinically verify until approved.
      credentialStatus: input.role === "HEALTH_WORKER" ? "PENDING" : null,
      createdAt: new Date().toISOString(),
      ...(phone ? { phone } : {}),
    };
    await this.users.create(user);
    return this.issue(user);
  }

  /**
   * A health worker saying which register they are on, and showing the licence.
   *
   * Nothing here is checked automatically — there is no public API to check a Nigerian
   * registration against, and pretending otherwise would be worse than not trying. What this
   * does is give the person approving something to check: a named register, a number to look
   * up on it, and a photograph to compare. An approval is a human judgement, and this is the
   * material for it.
   *
   * Submitting again always returns the account to PENDING. An approval refers to the
   * document it was given, so letting a worker swap the photograph afterwards while keeping
   * the tick would make the tick meaningless.
   */
  async submitCredential(userId: string, input: CredentialSubmissionInput): Promise<PublicUser> {
    const user = await this.users.findById(userId);
    if (!user) throw new AppError(404, "USER_NOT_FOUND", "Account not found.");
    if (user.role !== "HEALTH_WORKER") {
      throw new AppError(403, "NOT_A_HEALTH_WORKER", "Only health worker accounts have a credential.");
    }

    let documentId: string | null = user.licence?.documentId ?? null;
    if (input.image) {
      if (!this.documents) {
        throw new AppError(503, "DOCUMENTS_UNAVAILABLE", "Licence photographs cannot be stored right now.");
      }
      const docId = `crd_${randomUUID()}`;
      documentId = docId;
      await this.documents.put({
        id: docId,
        userId: user.id,
        mime: input.image.mime,
        base64: input.image.base64,
        createdAt: new Date().toISOString(),
      });
    }

    const updated: User = {
      ...user,
      licence: {
        body: input.body,
        number: input.number,
        profession: input.profession,
        submittedAt: new Date().toISOString(),
        documentId,
      },
      credentialStatus: "PENDING",
    };
    await this.users.update(updated);
    return toPublic(updated);
  }

  /**
   * A health worker turning on their own record.
   *
   * Clinicians are patients too, and one email could only ever be one of the two: the account
   * row carries a single role and a patient record was created only at registration, so a
   * doctor who wanted their own record had to register again with a different address.
   *
   * The account keeps its role; what changes is that it gains a patientId. A fresh token is
   * returned because the old one was minted without one, and the patient endpoints read the
   * patient from the token.
   */
  async addOwnRecord(userId: string): Promise<AuthResponse> {
    const user = await this.users.findById(userId);
    if (!user) throw new AppError(404, "USER_NOT_FOUND", "Account not found.");
    if (user.patientId) return this.issue(user);

    const patient = await this.provisioner.provision(user.fullName);
    const updated: User = { ...user, patientId: patient.id };
    await this.users.update(updated);
    return this.issue(updated);
  }

  async login(input: LoginInput): Promise<AuthResponse> {
    const user = await this.users.findByEmail(input.email);
    const ok = await bcrypt.compare(input.password, user?.passwordHash ?? DUMMY_HASH);
    if (!user || !ok) throw new AppError(401, "INVALID_CREDENTIALS", "Invalid email or password.");
    return this.issue(user);
  }

  /**
   * Sets or clears the number USSD identifies this account by. Normalised to E.164 so the
   * number the aggregator reports matches what is stored, however the patient typed it.
   * Clearing it also clears the USSD PIN, which would otherwise be unreachable.
   */
  async setPhone(userId: string, raw: string): Promise<PublicUser> {
    const user = await this.users.findById(userId);
    if (!user) throw new AppError(401, "UNAUTHENTICATED", "Account no longer exists.");

    if (raw.trim() === "") {
      await this.users.update({
        ...user,
        phone: undefined,
        ussdPinHash: undefined,
        ussdPinFailures: 0,
        ussdLockedUntil: undefined,
      });
      return toPublic({ ...user, phone: undefined });
    }

    const phone = normalizePhone(raw);
    if (!phone) throw new AppError(400, "INVALID_PHONE", "Enter a valid phone number.");
    const existing = await this.users.findByPhone(phone);
    if (existing && existing.id !== user.id) {
      throw new AppError(409, "PHONE_TAKEN", "An account with this phone number already exists.");
    }
    const updated: User = { ...user, phone };
    await this.users.update(updated);
    return toPublic(updated);
  }

  async me(userId: string): Promise<PublicUser> {
    const user = await this.users.findById(userId);
    if (!user) throw new AppError(401, "UNAUTHENTICATED", "Account no longer exists.");
    return toPublic(user);
  }

  // Returns null for any invalid, expired or malformed token.
  verify(token: string): AuthContext | null {
    try {
      const decoded = jwt.verify(token, this.secret, { algorithms: ["HS256"] });
      const parsed = TokenPayloadSchema.safeParse(decoded);
      if (!parsed.success) return null;
      return { userId: parsed.data.sub, role: parsed.data.role, patientId: parsed.data.pid };
    } catch {
      return null;
    }
  }
}
