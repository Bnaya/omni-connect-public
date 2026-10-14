/**
 * An append-only JSONL log of every request a session made: what was asked for, which transport
 * answered, how it was classified, how long it took.
 *
 * It is the artefact you want when a site starts blocking you a week later ("what did we do, how
 * often, and when did the first challenge appear?"). Deliberately **no bodies, no cookies, no
 * headers**: the log is safe to read in a terminal and to paste into notes.
 */
import { appendFileSync, mkdirSync, readFileSync } from "node:fs";
import { dirname } from "node:path";
import type { Verdict } from "./challenge.ts";
import type { TransportName } from "./transports.ts";

export type RequestLogEntry = {
  at: string;
  session?: string;
  host: string;
  method: string;
  url: string;
  transport: TransportName | "cache";
  status: number;
  verdict: Verdict["kind"] | "error";
  challenge?: string;
  ms: number;
  fromCache?: boolean;
  attempts?: number;
};

export class RequestLog {
  readonly file: string | null;
  #session: string | undefined;
  #entries: RequestLogEntry[] = [];
  #keepInMemory: number;

  constructor(file: string | null, opts: { session?: string; keepInMemory?: number } = {}) {
    this.file = file;
    this.#session = opts.session;
    this.#keepInMemory = opts.keepInMemory ?? 200;
  }

  append(entry: Omit<RequestLogEntry, "at" | "session"> & { at?: string }): RequestLogEntry {
    const full: RequestLogEntry = {
      at: entry.at ?? new Date().toISOString(),
      ...(this.#session ? { session: this.#session } : {}),
      ...entry,
    };
    this.#entries.push(full);
    if (this.#entries.length > this.#keepInMemory) this.#entries.shift();
    if (this.file) {
      try {
        mkdirSync(dirname(this.file), { recursive: true });
        appendFileSync(this.file, `${JSON.stringify(full)}\n`);
      } catch {
        // logging must never break a request
      }
    }
    return full;
  }

  /** Entries this process appended (most recent last). */
  recent(limit = 50): RequestLogEntry[] {
    return this.#entries.slice(-limit);
  }

  /** Read the whole file back, for a report or a "are we being polite?" check. */
  readAll(): RequestLogEntry[] {
    if (!this.file) return [...this.#entries];
    try {
      return readFileSync(this.file, "utf8")
        .split("\n")
        .filter((line) => line.trim() !== "")
        .flatMap((line) => {
          try {
            return [JSON.parse(line) as RequestLogEntry];
          } catch {
            return [];
          }
        });
    } catch {
      return [];
    }
  }
}
