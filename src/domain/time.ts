/** All inputs that depend on time take an explicit clock (docs/03 §7: the engine never reads the wall clock). */
export interface Clock {
  now(): Date;
}

export const systemClock: Clock = { now: () => new Date() };

/** A settable clock for tests and for the DEMO seed (which replays illustrative dates). */
export class FixedClock implements Clock {
  private current: Date;
  constructor(start: string | Date) {
    this.current = new Date(start);
  }
  now(): Date {
    return new Date(this.current);
  }
  set(at: string | Date): void {
    this.current = new Date(at);
  }
  advance(seconds: number): void {
    this.current = new Date(this.current.getTime() + seconds * 1000);
  }
}

/** UTC, RFC 3339, second precision, "Z" suffix (schemas/README.md conventions). */
export function ts(date: Date): string {
  return date.toISOString().replace(/\.\d{3}Z$/, "Z");
}

export const TS_RE = /^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}Z$/;

export function parseTs(value: string): Date {
  if (!TS_RE.test(value)) throw new RangeError(`not a UTC second-precision timestamp: ${value}`);
  return new Date(value);
}

export function addSeconds(value: string, seconds: number): string {
  return ts(new Date(parseTs(value).getTime() + seconds * 1000));
}

export function addDays(value: string, days: number): string {
  return addSeconds(value, days * 86400);
}

export function daysBetween(from: string, to: string): number {
  return Math.floor((parseTs(to).getTime() - parseTs(from).getTime()) / 86400000);
}

/** Display helper: local time in an IANA zone, with the zone named. Stored values stay UTC. */
export function displayTime(value: string, tz: string): string {
  try {
    const fmt = new Intl.DateTimeFormat("en-GB", {
      timeZone: tz, day: "2-digit", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit", hour12: false,
    });
    return `${fmt.format(new Date(value))} (${tz})`;
  } catch {
    return `${value} (UTC)`;
  }
}
