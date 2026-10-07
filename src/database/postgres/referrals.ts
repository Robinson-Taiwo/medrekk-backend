import type { Referral } from "../../shared/referralTypes.js";
import { decryptText, encryptText, sha256Hex } from "../../utils/crypto.js";
import type { ReferralRepository } from "../referralRepository.js";
import type { Db, SqlValue } from "./db.js";

type DataRow = { data: Referral };

export function createPostgresReferralRepository(db: Db, key: Buffer): ReferralRepository {
  const seal = (r: Referral): Referral => ({ ...r, shareId: encryptText(key, r.shareId) });
  const open = (r: Referral): Referral => ({ ...r, shareId: decryptText(key, r.shareId) });

  const one = async (text: string, values: SqlValue[]): Promise<Referral | undefined> => {
    const res = await db.query<DataRow>(text, values);
    const row = res.rows[0];
    return row ? open(row.data) : undefined;
  };

  return {
    create: async (r) => {
      await db.query(
        "INSERT INTO referrals (id, share_id_hash, patient_id, created_at, data) VALUES ($1, $2, $3, $4, $5::jsonb)",
        [r.id, sha256Hex(r.shareId), r.patientId, r.createdAt, JSON.stringify(seal(r))],
      );
    },
    findByShareId: (shareId) => one("SELECT data FROM referrals WHERE share_id_hash = $1", [sha256Hex(shareId)]),
    findById: (id) => one("SELECT data FROM referrals WHERE id = $1", [id]),
    update: async (r) => {
      await db.query("UPDATE referrals SET data = $2::jsonb WHERE id = $1", [r.id, JSON.stringify(seal(r))]);
    },
    listForPatient: async (patientId) => {
      const res = await db.query<DataRow>("SELECT data FROM referrals WHERE patient_id = $1 ORDER BY created_at DESC", [
        patientId,
      ]);
      return res.rows.map((row) => open(row.data));
    },
  };
}
