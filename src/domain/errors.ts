/**
 * Typed errors. Every unsupported capability surfaces as one of these; nothing in the
 * framework is allowed to "succeed" by doing nothing.
 */
export class ClError extends Error {
  code: string;
  status: number;
  details: unknown;
  constructor(code: string, message: string, status = 400, details: unknown = undefined) {
    super(message);
    this.name = new.target.name;
    this.code = code;
    this.status = status;
    this.details = details;
  }
  toJSON(): Record<string, unknown> {
    return { error: { code: this.code, message: this.message, details: this.details ?? null } };
  }
}

/** A value did not match its contract (JSON Schema or semantic validation). */
export class ValidationError extends ClError {
  problems: string[];
  constructor(what: string, problems: string[]) {
    super("validation_failed", `${what}: ${problems.slice(0, 5).join("; ")}`, 422, { problems });
    this.problems = problems;
  }
}

/** The act is reserved for an authenticated person in the app (docs/06 §2.1 "Deliberately absent"). */
export class PermissionDenied extends ClError {
  constructor(message: string, code = "human_only") {
    super(code, message, 403);
  }
}

export class NotFound extends ClError {
  constructor(what: string, id: string) {
    super("not_found", `${what} ${id} was not found`, 404, { what, id });
  }
}

export class Conflict extends ClError {
  constructor(code: string, message: string, details: unknown = undefined) {
    super(code, message, 409, details);
  }
}

/**
 * A capability this build does not provide. Callers receive an explicit, typed
 * "unavailable" - never a silent no-op.
 */
export class Unavailable extends ClError {
  capability: string;
  constructor(capability: string, message: string, details: Record<string, unknown> = {}) {
    super("unavailable", message, 501, { capability, ...details });
    this.capability = capability;
  }
}

/**
 * A Phase 2 extension point. `contract` names the function contract documented in
 * HANDOFF.md; tests assert that these stay explicit until implemented.
 */
export class NotImplementedYet extends Unavailable {
  contract: string;
  constructor(contract: string, message: string) {
    super(contract, `Not implemented in the Phase 1 scaffold: ${message}`, { contract, phase: "phase-2" });
    this.contract = contract;
  }
}

/** An internal invariant from the design would be broken; the operation is refused. */
export class InvariantViolation extends ClError {
  invariant: string;
  constructor(invariant: string, message: string) {
    super("invariant_violation", `${invariant}: ${message}`, 409, { invariant });
    this.invariant = invariant;
  }
}
