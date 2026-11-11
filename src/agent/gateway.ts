/**
 * Message gateway. The only implementation here is a simulation: no message
 * leaves the machine. A real SMS or WhatsApp provider would sit behind the
 * same interface and must honour the idempotency key.
 */
export interface OutboundMessage {
  to: string;
  channel: "sms" | "whatsapp";
  body: string;
}
export interface Gateway {
  readonly simulated: boolean;
  send(msg: OutboundMessage, idemKey: string, signal: AbortSignal): Promise<{ ref: string }>;
}

export class CrashError extends Error {
  constructor() {
    super("Simulated process crash");
  }
}

export interface Faults {
  /** These call numbers (1-based) hang until the caller's timeout fires. */
  hangOnCalls?: number[];
  /** On these calls the provider accepts the message but the reply is lost. */
  loseReplyOnCalls?: number[];
  /** These calls fail with a provider error. */
  failOnCalls?: number[];
  /** Throw a crash after this many successful deliveries, to test restarts. */
  crashAfterDeliveries?: number;
}

export class SimulatedGateway implements Gateway {
  readonly simulated = true;
  calls = 0;
  /** Messages the pretend provider accepted, keyed by idempotency key. */
  delivered = new Map<string, { ref: string; msg: OutboundMessage }>();
  constructor(private faults: Faults = {}) {}

  async send(msg: OutboundMessage, idemKey: string, signal: AbortSignal) {
    this.calls += 1;
    const n = this.calls;
    if (this.faults.hangOnCalls?.includes(n)) {
      await new Promise((_, reject) => signal.addEventListener("abort", () => reject(new Error("timeout"))));
    }
    if (this.faults.failOnCalls?.includes(n)) throw new Error("provider error 503");
    const prior = this.delivered.get(idemKey);
    if (prior) return { ref: prior.ref };
    const ref = `sim-${this.delivered.size + 1}`;
    this.delivered.set(idemKey, { ref, msg });
    if (this.faults.crashAfterDeliveries !== undefined && this.delivered.size >= this.faults.crashAfterDeliveries) {
      this.faults.crashAfterDeliveries = undefined;
      throw new CrashError();
    }
    if (this.faults.loseReplyOnCalls?.includes(n)) throw new Error("timeout");
    return { ref };
  }
}
