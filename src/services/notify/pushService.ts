/**
 * Telling somebody their record was asked for, while they are not looking at the app.
 *
 * The whole consent model assumes a patient notices a request inside the few minutes it stays
 * open. Before this they only found out by opening the app and looking, so a worker standing
 * in front of them had to say "check your phone now" — which works in a demo and not in a
 * clinic.
 *
 * Deliberately an interface with a no-op default. Tests, and any deployment with no push
 * credentials, run the real code paths and send nothing, rather than every call site having
 * to know whether notifications exist.
 */

export interface PushMessage {
  title: string;
  body: string;
  /** Carried to the app so a tap can open the right screen. */
  data?: Record<string, string>;
}

export interface PushSender {
  send(tokens: readonly string[], message: PushMessage): Promise<void>;
}

export class NoopPushSender implements PushSender {
  async send(): Promise<void> {
    /* nothing configured, which is a normal state rather than a fault */
  }
}

const EXPO_ENDPOINT = "https://exp.host/--/api/v2/push/send";
const BATCH = 100; // Expo's documented limit per request

/**
 * Sends through Expo's push service, which forwards to FCM and APNs. Failures are logged and
 * swallowed: a notification that does not arrive must never fail the request that triggered
 * it — the access request is the thing that matters, and the patient can still open the app.
 */
export class ExpoPushSender implements PushSender {
  constructor(private readonly fetchImpl: typeof fetch = fetch) {}

  async send(tokens: readonly string[], message: PushMessage): Promise<void> {
    const valid = [...new Set(tokens)].filter(
      (t) => t.startsWith("ExponentPushToken") || t.startsWith("ExpoPushToken"),
    );
    if (valid.length === 0) return;

    for (let i = 0; i < valid.length; i += BATCH) {
      const chunk = valid.slice(i, i + BATCH).map((to) => ({
        to,
        title: message.title,
        body: message.body,
        sound: "default" as const,
        priority: "high" as const,
        ...(message.data ? { data: message.data } : {}),
      }));
      try {
        const res = await this.fetchImpl(EXPO_ENDPOINT, {
          method: "POST",
          headers: { "Content-Type": "application/json", Accept: "application/json" },
          body: JSON.stringify(chunk),
        });
        if (!res.ok) console.warn(`[push] Expo returned ${res.status}`);
      } catch (e) {
        console.warn(`[push] could not reach Expo: ${e instanceof Error ? e.message : "unknown"}`);
      }
    }
  }
}
