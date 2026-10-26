import type { CredentialDocumentRepository, User, UserRepository } from "../../auth/userRepository.js";
import type { CredentialDocument } from "../../shared/types.js";
import { AppError } from "../../utils/errors.js";
import type { Db, SqlValue } from "./db.js";

type DataRow<T> = { data: T };

function conflictError(e: Error): AppError | null {
  if (!("code" in e) || e.code !== "23505" || !("constraint" in e)) return null;
  if (e.constraint === "users_email_unique") {
    return new AppError(409, "EMAIL_TAKEN", "An account with this email already exists.");
  }
  if (e.constraint === "users_phone_unique") {
    return new AppError(409, "PHONE_TAKEN", "An account with this phone number already exists.");
  }
  return null;
}

async function write(db: Db, text: string, values: SqlValue[]): Promise<void> {
  try {
    await db.query(text, values);
  } catch (e) {
    if (e instanceof Error) {
      const mapped = conflictError(e);
      if (mapped) throw mapped;
    }
    throw e;
  }
}

async function selectOne(db: Db, text: string, values: SqlValue[]): Promise<User | null> {
  const res = await db.query<DataRow<User>>(text, values);
  return res.rows[0]?.data ?? null;
}

export function createPostgresUserRepository(db: Db): UserRepository {
  return {
    findByEmail: (email) => selectOne(db, "SELECT data FROM users WHERE email = $1", [email]),
    findByPhone: (phone) => selectOne(db, "SELECT data FROM users WHERE phone = $1", [phone]),
    findById: (id) => selectOne(db, "SELECT data FROM users WHERE id = $1", [id]),
    create: (user) =>
      write(db, "INSERT INTO users (id, email, phone, role, data) VALUES ($1, $2, $3, $4, $5::jsonb)", [
        user.id,
        user.email,
        user.phone ?? null,
        user.role,
        JSON.stringify(user),
      ]),
    update: (user) =>
      write(db, "UPDATE users SET email = $2, phone = $3, role = $4, data = $5::jsonb WHERE id = $1", [
        user.id,
        user.email,
        user.phone ?? null,
        user.role,
        JSON.stringify(user),
      ]),
    findByPatientId: async (patientId) => {
      const res = await db.query<DataRow<User>>("SELECT data FROM users WHERE data->>'patientId' = $1", [patientId]);
      return res.rows[0]?.data ?? null;
    },
    listByRole: async (role) => {
      const res = await db.query<DataRow<User>>("SELECT data FROM users WHERE role = $1 ORDER BY data->>'createdAt'", [role]);
      return res.rows.map((r) => r.data);
    },
  };
}

/**
 * Photographs of licences. A separate table so that reading a user — which happens on every
 * authenticated request — never drags an image along with it.
 */
export function createPostgresCredentialDocumentRepository(db: Db): CredentialDocumentRepository {
  return {
    put: (doc) =>
      write(
        db,
        `INSERT INTO credential_documents (user_id, data) VALUES ($1, $2::jsonb)
         ON CONFLICT (user_id) DO UPDATE SET data = EXCLUDED.data`,
        [doc.userId, JSON.stringify(doc)],
      ),
    findByUserId: async (userId) => {
      const res = await db.query<DataRow<CredentialDocument>>(
        "SELECT data FROM credential_documents WHERE user_id = $1",
        [userId],
      );
      return res.rows[0]?.data ?? null;
    },
  };
}
