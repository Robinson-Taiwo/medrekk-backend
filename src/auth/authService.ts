import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import { randomUUID } from "node:crypto";
import {
  TokenPayloadSchema,
  type AuthContext,
  type AuthResponse,
  type LoginInput,
  type PublicUser,
  type RegisterInput,
} from "../shared/auth.js";
import type { Patient } from "../shared/types.js";
import { AppError } from "../utils/errors.js";
import type { User, UserRepository } from "./userRepository.js";

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
  };
}

export class AuthService {
  constructor(
    private readonly users: UserRepository,
    private readonly secret: string,
    private readonly provisioner: PatientProvisioner,
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
    };
    await this.users.create(user);
    return this.issue(user);
  }

  async login(input: LoginInput): Promise<AuthResponse> {
    const user = await this.users.findByEmail(input.email);
    const ok = await bcrypt.compare(input.password, user?.passwordHash ?? DUMMY_HASH);
    if (!user || !ok) throw new AppError(401, "INVALID_CREDENTIALS", "Invalid email or password.");
    return this.issue(user);
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
