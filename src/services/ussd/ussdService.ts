import bcrypt from "bcryptjs";

import type { User, UserRepository } from "../../auth/userRepository.js";
import type { Repositories } from "../../database/repositories.js";
import { normalizePhone } from "../../shared/phone.js";
import { isWeakPin, type UssdRequest } from "../../shared/ussd.js";
import type { AccessScope, ClinicalClaim, EmergencyProfile } from "../../shared/types.js";
import { AppError } from "../../utils/errors.js";
import { newId } from "../../utils/ids.js";

const MAX_ATTEMPTS = 5;
const LOCK_MINUTES = 15;
/** Matches the cost used for account passwords elsewhere in this codebase. */
const BCRYPT_COST = 10;
/** A single USSD page is about 182 characters, so a page shows few items and offers More. */
const PAGE_SIZE = 3;
/** Used where a line has to summarise a list rather than page through it. */
const MAX_INLINE_ITEMS = 3;

export interface UssdReply {
  /** true sends END (the session closes), false sends CON (the network waits for more input). */
  done: boolean;
  message: string;
}

const con = (message: string): UssdReply => ({ done: false, message });
const end = (message: string): UssdReply => ({ done: true, message });

/**
 * The first choice decides who is asking, because that decides what may be read.
 * Branch 1 is the patient on their own SIM behind their own PIN, and shows their record.
 * Branch 2 is somebody else holding a MedRekk Code, and shows the emergency card only.
 */
const TOP_MENU = ["MedRekk", "1. My record", "2. Emergency lookup"].join("\n");

const RECORD_MENU = [
  "MedRekk",
  "1. Medicines",
  "2. Allergies",
  "3. Test results",
  "4. Past conditions",
  "5. Recent visits",
  "6. Emergency card",
  "7. My code",
].join("\n");

const SHORT_LABEL: Record<AccessScope, string> = {
  ALLERGIES: "Allergies",
  CURRENT_MEDICATIONS: "Medicines",
  RECENT_ENCOUNTERS: "Notes",
  PAST_MEDICAL_HISTORY: "History",
  LAB_RESULTS: "Tests",
  REFERRALS: "Referrals",
  EMERGENCY_INFORMATION: "Emergency",
};

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** Deterministic and short, rather than depending on the server's locale. */
function shortDate(iso: string | undefined): string {
  if (!iso) return "date not recorded";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "date not recorded";
  return `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()}`;
}

/** Shows the first few entries and says how many are left, rather than silently dropping any. */
function inlineList(label: string, values: string[]): string | null {
  if (values.length === 0) return null;
  const shown = values.slice(0, MAX_INLINE_ITEMS).join(", ");
  const rest = values.length - MAX_INLINE_ITEMS;
  return rest > 0 ? `${label}: ${shown} (+${rest} more)` : `${label}: ${shown}`;
}

/**
 * Reads a navigation tail. Each "0" is a More press, so the page number is the count of
 * leading zeros and the token after them, if any, is the selection on that page.
 */
function readPage(tail: string[]): { page: number; choice?: string } {
  let page = 0;
  let i = 0;
  while (tail[i] === "0") {
    page += 1;
    i += 1;
  }
  return { page, choice: tail[i] };
}

const newestFirst = (a: ClinicalClaim, b: ClinicalClaim): number =>
  (b.lastConfirmedAt ?? "").localeCompare(a.lastConfirmedAt ?? "");

interface Visit {
  encounterId: string;
  at?: string;
  source: string;
  claims: ClinicalClaim[];
}

export class UssdService {
  constructor(
    private readonly deps: { repos: Repositories; users: UserRepository; now: () => Date },
  ) {}

  private iso(): string {
    return this.deps.now().toISOString();
  }

  private lockedFor(user: User): number {
    if (!user.ussdLockedUntil) return 0;
    const msLeft = new Date(user.ussdLockedUntil).getTime() - this.deps.now().getTime();
    return msLeft > 0 ? Math.ceil(msLeft / 60_000) : 0;
  }

  /**
   * One step of a USSD session.
   *
   * A dialling number says which account is being asked about; the PIN is what
   * authenticates, because a SIM can be swapped or a handset borrowed. A PIN can only be
   * set from the signed-in app, never over USSD — otherwise whoever is holding the phone
   * could claim the account.
   *
   * A patient reading their own record sees all of it, within what a handset can show.
   * Approval protects a record from other people, not from its owner. What a dialled code
   * cannot carry is the explanation layer, which runs to paragraphs; USSD shows what was
   * recorded. The transit is unencrypted and the screen is visible to bystanders, which
   * the app says plainly on its USSD screen.
   */
  async handle(req: UssdRequest): Promise<UssdReply> {
    const steps = req.text.length === 0 ? [] : req.text.split("*");
    if (steps.length === 0) return con(TOP_MENU);

    const branch = steps[0];
    if (branch === "2") return await this.emergencyLookup(req, steps.slice(1));
    if (branch === "1") return await this.ownRecord(req, steps.slice(1));
    return con(`Not one of the options.\n${TOP_MENU}`);
  }

  // ---- Branch 2: somebody else, by MedRekk Code, no PIN ----

  /**
   * Deliberately open, exactly like the web emergency page: a responder will not have the
   * patient's PIN and may not have a MedRekk account at all. It shows the emergency card
   * and nothing else, and the dialling number goes into the patient's audit log.
   */
  private async emergencyLookup(req: UssdRequest, tail: string[]): Promise<UssdReply> {
    if (tail.length === 0) return con("Enter the patient's MedRekk Code:");

    const code = (tail[0] ?? "").trim().toUpperCase();
    const patient = await this.deps.repos.patients.findByCode(code);
    const profile = patient ? await this.deps.repos.emergency.profileFor(patient.id) : undefined;
    if (!patient || !profile) return end("No emergency card found for that code. Check it and try again.");

    await this.deps.repos.audit.append({
      id: newId("aud"),
      patientId: patient.id,
      type: "EMERGENCY_ACCESSED",
      accessType: "EMERGENCY",
      occurredAt: this.iso(),
      requesterIdentifier: `Phone ${normalizePhone(req.phoneNumber) ?? req.phoneNumber}`,
      reason: "Emergency lookup by dialled code",
      informationViewed: ["EMERGENCY_PROFILE"],
    });

    return end(this.emergencyLines(patient.fullName, profile));
  }

  // ---- Branch 1: the patient, on their own SIM, behind their own PIN ----

  private async ownRecord(req: UssdRequest, tail: string[]): Promise<UssdReply> {
    const phone = normalizePhone(req.phoneNumber);
    if (!phone) return end("We could not read that phone number.");

    const user = await this.deps.users.findByPhone(phone);
    if (!user || !user.patientId) {
      return end("This number is not registered with MedRekk. Sign up in the app first.");
    }
    if (!user.ussdPinHash) {
      return end("No USSD PIN yet. Open the MedRekk app, go to Profile and set a 4-digit USSD PIN.");
    }

    const minutes = this.lockedFor(user);
    if (minutes > 0) {
      return end(`Too many wrong PINs. Try again in ${minutes} minute${minutes === 1 ? "" : "s"}.`);
    }

    let active = user;
    if (active.ussdLockedUntil) {
      // The lock has run out. Clear the count too, so the next wrong PIN does not
      // trip the limit again on its own and lock the account straight back up.
      active = { ...active, ussdPinFailures: 0, ussdLockedUntil: undefined };
      await this.deps.users.update(active);
    }

    if (tail.length === 0) return con("Enter your 4-digit PIN:");

    const ok = await bcrypt.compare(tail[0] ?? "", active.ussdPinHash!);
    if (!ok) return await this.recordFailure(active);
    await this.clearFailures(active);

    const rest = tail.slice(1);
    if (rest.length === 0) return con(RECORD_MENU);

    // Narrowed to a string by the guard above; `active` only differs in its PIN fields.
    const patientId = user.patientId;
    const choice = rest[0];
    const nav = rest.slice(1);

    switch (choice) {
      case "1":
        return await this.categoryPage(patientId, "CURRENT_MEDICATIONS", nav);
      case "2":
        return await this.categoryPage(patientId, "ALLERGIES", nav);
      case "3":
        return await this.categoryPage(patientId, "LAB_RESULTS", nav);
      case "4":
        return await this.categoryPage(patientId, "PAST_MEDICAL_HISTORY", nav);
      case "5":
        return await this.visits(patientId, nav);
      case "6":
        return end(await this.emergencyCard(active));
      case "7":
        return end(await this.codeSummary(active));
      default:
        return con(`Not one of the options.\n${RECORD_MENU}`);
    }
  }

  // ---- Reading the record ----

  /** One page of a single category. Pages rather than truncating: a dropped medicine is a hazard. */
  private async categoryPage(patientId: string, scope: AccessScope, nav: string[]): Promise<UssdReply> {
    const { page } = readPage(nav);
    const claims = (await this.deps.repos.records.allFor(patientId))
      .filter((c) => c.category === scope)
      .sort(newestFirst);

    const label = SHORT_LABEL[scope];
    if (claims.length === 0) return end(`Nothing recorded under ${label.toLowerCase()}.`);

    const start = page * PAGE_SIZE;
    if (start >= claims.length) return end(`No more ${label.toLowerCase()}.`);

    const shown = claims.slice(start, start + PAGE_SIZE);
    const more = claims.length > start + PAGE_SIZE;
    await this.audit(patientId, [scope]);

    const lines = [
      `${label} (${start + 1}-${start + shown.length} of ${claims.length})`,
      ...shown.map((c) => `${c.value} - ${shortDate(c.lastConfirmedAt)}`),
    ];
    if (more) lines.push("0. More");
    return more ? con(lines.join("\n")) : end(lines.join("\n"));
  }

  /** Visits are claims that share an encounter, which is how the app groups them too. */
  private async visits(patientId: string, nav: string[]): Promise<UssdReply> {
    const { page, choice } = readPage(nav);
    const claims = await this.deps.repos.records.allFor(patientId);

    const byEncounter = new Map<string, Visit>();
    for (const claim of claims.sort(newestFirst)) {
      if (!claim.encounterId) continue;
      const existing = byEncounter.get(claim.encounterId);
      if (existing) {
        existing.claims.push(claim);
      } else {
        byEncounter.set(claim.encounterId, {
          encounterId: claim.encounterId,
          at: claim.lastConfirmedAt,
          source: claim.source,
          claims: [claim],
        });
      }
    }

    const all = [...byEncounter.values()];
    if (all.length === 0) {
      return end("No visits recorded yet. Items you entered yourself are under the other options.");
    }

    const start = page * PAGE_SIZE;
    const shown = all.slice(start, start + PAGE_SIZE);
    if (shown.length === 0) return end("No more visits.");

    if (choice !== undefined) {
      const picked = shown[Number(choice) - 1];
      if (!picked) return con(`Not one of the options.\n${this.visitList(shown, start, all.length)}`);
      return end(await this.visitDetail(patientId, picked));
    }

    return con(this.visitList(shown, start, all.length));
  }

  private visitList(shown: Visit[], start: number, total: number): string {
    const lines = [
      `Visits (${start + 1}-${start + shown.length} of ${total})`,
      ...shown.map((v, i) => `${i + 1}. ${shortDate(v.at)} - ${v.claims.length} item${v.claims.length === 1 ? "" : "s"}`),
    ];
    if (total > start + shown.length) lines.push("0. More");
    return lines.join("\n");
  }

  private async visitDetail(patientId: string, visit: Visit): Promise<UssdReply["message"]> {
    const scopes = [...new Set(visit.claims.map((c) => c.category))];
    await this.audit(patientId, scopes);

    const grouped = scopes
      .map((scope) => inlineList(SHORT_LABEL[scope], visit.claims.filter((c) => c.category === scope).map((c) => c.value)))
      .filter((line): line is string => line !== null);

    return [`${shortDate(visit.at)}`, `Recorded by ${visit.source}`, ...grouped].join("\n");
  }

  private async emergencyCard(user: User): Promise<string> {
    const patientId = user.patientId!;
    const profile = await this.deps.repos.emergency.profileFor(patientId);
    await this.audit(patientId, ["EMERGENCY_INFORMATION"]);
    if (!profile) return "Nothing on your emergency card yet. Add it in the MedRekk app.";
    return this.emergencyLines(user.fullName, profile);
  }

  private emergencyLines(name: string, profile: EmergencyProfile): string {
    const contact = profile.emergencyContact;
    const lines = [
      `MedRekk — ${name}`,
      profile.bloodGroup ? `Blood: ${profile.bloodGroup}` : null,
      inlineList("Allergies", profile.criticalAllergies),
      inlineList("Conditions", profile.criticalConditions),
      inlineList("Medicines", profile.criticalMedications),
      contact ? `Contact: ${contact.name} ${contact.phone}` : null,
    ].filter((line): line is string => line !== null);

    if (lines.length === 1) return "Nothing on this emergency card yet.";
    return lines.join("\n");
  }

  private async codeSummary(user: User): Promise<string> {
    const patientId = user.patientId!;
    const patient = await this.deps.repos.patients.findById(patientId);
    if (!patient) return "We could not find your record. Please try the app.";
    await this.audit(patientId, ["MEDREKK_CODE"]);
    return `Your MedRekk Code is ${patient.medrekkCode}. Give it to a clinician so they can request access.`;
  }

  // ---- PIN attempts ----

  private async recordFailure(user: User): Promise<UssdReply> {
    const failures = (user.ussdPinFailures ?? 0) + 1;
    if (failures >= MAX_ATTEMPTS) {
      const until = new Date(this.deps.now().getTime() + LOCK_MINUTES * 60_000).toISOString();
      await this.deps.users.update({ ...user, ussdPinFailures: failures, ussdLockedUntil: until });
      return end(`Too many wrong PINs. Try again in ${LOCK_MINUTES} minutes.`);
    }
    await this.deps.users.update({ ...user, ussdPinFailures: failures, ussdLockedUntil: undefined });
    const left = MAX_ATTEMPTS - failures;
    return con(`Wrong PIN. ${left} ${left === 1 ? "try" : "tries"} left.\nEnter your 4-digit PIN:`);
  }

  /** Only writes when there is something to reset, so a normal session costs no write. */
  private async clearFailures(user: User): Promise<void> {
    if (!user.ussdPinFailures && !user.ussdLockedUntil) return;
    await this.deps.users.update({ ...user, ussdPinFailures: 0, ussdLockedUntil: undefined });
  }

  private async audit(patientId: string, viewed: string[]): Promise<void> {
    await this.deps.repos.audit.append({
      id: newId("aud"),
      patientId,
      type: "USSD_ACCESSED",
      accessType: "NORMAL",
      occurredAt: this.iso(),
      requesterIdentifier: "You, by USSD",
      informationViewed: viewed,
    });
  }

  // ---- PIN management, from the signed-in app only ----

  async pinStatus(userId: string): Promise<{ set: boolean; phone: string | null; lockedUntil?: string }> {
    const user = await this.requireUser(userId);
    return {
      set: Boolean(user.ussdPinHash),
      phone: user.phone ?? null,
      ...(this.lockedFor(user) > 0 ? { lockedUntil: user.ussdLockedUntil } : {}),
    };
  }

  async setPin(userId: string, pin: string): Promise<{ set: true }> {
    if (isWeakPin(pin)) {
      throw new AppError(400, "WEAK_PIN", "Pick a PIN that isn't four of the same digit or a run like 1234.");
    }
    const user = await this.requireUser(userId);
    // USSD finds the account by the number that dialled, so a PIN without a phone number
    // on the account could never be used.
    if (!user.phone) {
      throw new AppError(400, "PHONE_REQUIRED", "Add your phone number to your profile before setting a USSD PIN.");
    }
    await this.deps.users.update({
      ...user,
      ussdPinHash: await bcrypt.hash(pin, BCRYPT_COST),
      ussdPinFailures: 0,
      ussdLockedUntil: undefined,
    });
    return { set: true };
  }

  /** Turning USSD off is the patient's call, like every other access decision in MedRekk. */
  async clearPin(userId: string): Promise<{ set: false }> {
    const user = await this.requireUser(userId);
    await this.deps.users.update({
      ...user,
      ussdPinHash: undefined,
      ussdPinFailures: 0,
      ussdLockedUntil: undefined,
    });
    return { set: false };
  }

  private async requireUser(userId: string): Promise<User> {
    const user = await this.deps.users.findById(userId);
    if (!user) throw new AppError(404, "USER_NOT_FOUND", "Account not found.");
    return user;
  }
}
