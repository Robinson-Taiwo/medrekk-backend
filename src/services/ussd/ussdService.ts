import bcrypt from "bcryptjs";

import type { User, UserRepository } from "../../auth/userRepository.js";
import type { Repositories } from "../../database/repositories.js";
import { normalizePhone } from "../../shared/phone.js";
import { isWeakPin, type UssdRequest } from "../../shared/ussd.js";
import type { EmergencyProfile } from "../../shared/types.js";
import { AppError } from "../../utils/errors.js";
import { newId } from "../../utils/ids.js";

const MAX_ATTEMPTS = 5;
const LOCK_MINUTES = 15;
/** Matches the cost used for account passwords elsewhere in this codebase. */
const BCRYPT_COST = 10;
/** A single USSD page on most handsets. Longer replies get cut off by the network, not by us. */
const MAX_LIST_ITEMS = 3;

export interface UssdReply {
  /** true sends END (the session closes), false sends CON (the network waits for more input). */
  done: boolean;
  message: string;
}

const con = (message: string): UssdReply => ({ done: false, message });
const end = (message: string): UssdReply => ({ done: true, message });

const MENU = ["MedRekk", "1. My emergency card", "2. My MedRekk Code", "0. Exit"].join("\n");

/** Shows the first few entries and says how many are left, rather than silently dropping any. */
function list(label: string, values: string[]): string | null {
  if (values.length === 0) return null;
  const shown = values.slice(0, MAX_LIST_ITEMS).join(", ");
  const rest = values.length - MAX_LIST_ITEMS;
  return rest > 0 ? `${label}: ${shown} (+${rest} more)` : `${label}: ${shown}`;
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
   * The phone number only says which account is being asked about; the PIN is what
   * authenticates, because a SIM can be swapped or a handset borrowed. A PIN can only be
   * set from the signed-in app, never over USSD — otherwise whoever is holding the phone
   * could claim the account.
   *
   * Only the emergency card and the MedRekk Code are readable here. USSD text crosses the
   * aggregator and the mobile network in the clear and the handset screen is visible to
   * anyone nearby, so the full record stays behind the app's approval flow.
   */
  async handle(req: UssdRequest): Promise<UssdReply> {
    const phone = normalizePhone(req.phoneNumber);
    if (!phone) return end("We could not read that phone number.");

    const user = await this.deps.users.findByPhone(phone);
    // Saying which of these it is tells the caller what to do next, at the cost of
    // revealing whether a number has an account. USSD_SHARED_SECRET is what keeps that
    // from being an open enumeration endpoint; see routes/ussd.ts.
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

    const steps = req.text.length === 0 ? [] : req.text.split("*");
    if (steps.length === 0) return con("MedRekk\nEnter your 4-digit PIN:");

    const entered = steps[0] ?? "";
    const ok = await bcrypt.compare(entered, active.ussdPinHash!);
    if (!ok) return await this.recordFailure(active);
    await this.clearFailures(active);

    // The last step is the current answer: after a re-prompt the text is "pin*bad*choice".
    const choice = steps.length >= 2 ? steps[steps.length - 1] : undefined;
    if (choice === undefined) return con(MENU);

    switch (choice) {
      case "1":
        return end(await this.emergencySummary(active));
      case "2":
        return end(await this.codeSummary(active));
      case "0":
        return end("Goodbye.");
      default:
        return con(`Not one of the options.\n${MENU}`);
    }
  }

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

  private async emergencySummary(user: User): Promise<string> {
    const patientId = user.patientId!;
    const profile = await this.deps.repos.emergency.profileFor(patientId);
    await this.audit(patientId, ["EMERGENCY_PROFILE"]);

    if (!profile) return "Nothing on your emergency card yet. Add it in the MedRekk app.";

    const lines = [
      `MedRekk — ${user.fullName}`,
      profile.bloodGroup ? `Blood: ${profile.bloodGroup}` : null,
      list("Allergies", profile.criticalAllergies),
      list("Conditions", profile.criticalConditions),
      list("Medicines", profile.criticalMedications),
      this.contactLine(profile),
    ].filter((line): line is string => line !== null);

    if (lines.length === 1) {
      return "Nothing on your emergency card yet. Add it in the MedRekk app.";
    }
    return lines.join("\n");
  }

  private contactLine(profile: EmergencyProfile): string | null {
    const contact = profile.emergencyContact;
    return contact ? `Contact: ${contact.name} ${contact.phone}` : null;
  }

  private async codeSummary(user: User): Promise<string> {
    const patientId = user.patientId!;
    const patient = await this.deps.repos.patients.findById(patientId);
    if (!patient) return "We could not find your record. Please try the app.";
    await this.audit(patientId, ["MEDREKK_CODE"]);
    return `Your MedRekk Code is ${patient.medrekkCode}. Give it to a clinician so they can request access.`;
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
