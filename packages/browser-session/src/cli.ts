/**
 * The thinnest useful wrapper around the Playwright CLI: one process per command, a fixed
 * `-s=<session>` prefix and a fixed cwd (so the CLI's output dir stays inside
 * `.local/captures/<name>/`). Everything above this file talks to `CliRunner`, which the tests
 * replace with a scripted fake.
 *
 * `close-all` / `kill-all` are deliberately absent: other agents share this machine
 * (CLAUDE.md, guide §3).
 */
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export type CliResult = {
  ok: boolean;
  code: number;
  stdout: string;
  stderr: string;
  /** stdout + stderr, which is what you want when probing a failing command. */
  output: string;
};

export type CliRunOptions = {
  /** A non-zero exit returns its output instead of throwing. */
  tolerant?: boolean;
  signal?: AbortSignal;
  timeoutMs?: number;
};

export interface CliRunner {
  readonly session: string;
  run(args: string[], options?: CliRunOptions): Promise<CliResult>;
}

export class CliError extends Error {
  override name = "CliError";
  result: CliResult;
  constructor(args: string[], result: CliResult) {
    super(
      `playwright-cli ${args.join(" ")} failed (exit ${result.code}): ${result.output.trim().slice(0, 500)}`,
    );
    this.result = result;
  }
}

export function resolveCliBinary(root: string): string {
  const local = join(root, "node_modules", ".bin", "playwright-cli");
  return process.env.OMNI_PLAYWRIGHT_CLI ?? (existsSync(local) ? local : "playwright-cli");
}

/** The CLI's way of saying "there is no browser for this session". */
export const NOT_OPEN_RE =
  /is not open|not open|no browser|is not running|unknown session|no such session/i;

export type PlaywrightCliOptions = {
  session: string;
  /** cwd for every command. */
  cwd: string;
  bin?: string;
  root?: string;
  timeoutMs?: number;
  log?: (message: string, data?: Record<string, unknown>) => void;
};

export class PlaywrightCli implements CliRunner {
  readonly session: string;
  readonly cwd: string;
  readonly bin: string;
  #timeoutMs: number;
  #log: (message: string, data?: Record<string, unknown>) => void;

  constructor(opts: PlaywrightCliOptions) {
    this.session = opts.session;
    this.cwd = opts.cwd;
    this.bin = opts.bin ?? resolveCliBinary(opts.root ?? opts.cwd);
    this.#timeoutMs = opts.timeoutMs ?? 120_000;
    this.#log = opts.log ?? (() => {});
  }

  async run(args: string[], options: CliRunOptions = {}): Promise<CliResult> {
    await mkdir(this.cwd, { recursive: true });
    const full = [`-s=${this.session}`, ...args];
    // Never log `fill`'s value: it may be a secret (guide §6).
    this.#log(`playwright-cli ${args[0] ?? ""}`, { session: this.session });
    try {
      const { stdout, stderr } = await execFileAsync(this.bin, full, {
        cwd: this.cwd,
        maxBuffer: 64 * 1024 * 1024,
        timeout: options.timeoutMs ?? this.#timeoutMs,
        ...(options.signal ? { signal: options.signal } : {}),
      });
      return { ok: true, code: 0, stdout, stderr, output: stdout + stderr };
    } catch (err) {
      const e = err as { stdout?: string; stderr?: string; code?: number | string };
      const result: CliResult = {
        ok: false,
        code: typeof e.code === "number" ? e.code : 1,
        stdout: e.stdout ?? "",
        stderr: e.stderr ?? (err instanceof Error ? err.message : String(err)),
        output:
          `${e.stdout ?? ""}${e.stderr ?? ""}` ||
          (err instanceof Error ? err.message : String(err)),
      };
      if (options.tolerant) return result;
      throw new CliError(full, result);
    }
  }
}

/**
 * Decode what `--raw` printed. The CLI prints `JSON.stringify(value)`; page code in this package
 * returns a JSON *string* (the safest thing to get out of `eval`), so one more parse is tried.
 */
export function parseRawValue<T>(stdout: string, { nested = true } = {}): T {
  const text = stdout.trim();
  if (text === "") throw new SyntaxError("playwright-cli --raw printed nothing");
  let value: unknown = JSON.parse(text);
  if (nested && typeof value === "string") {
    const head = value.trimStart()[0];
    if (head === "{" || head === "[") {
      try {
        value = JSON.parse(value);
      } catch {
        // a plain string that happens to start with a bracket
      }
    }
  }
  return value as T;
}
