/**
 * Offline doubles. Everything that touches a browser or a network goes through `CliRunner` or
 * `Transport`, so the tests can drive the whole stack without either.
 */
import type { CliResult, CliRunner, CliRunOptions } from "./cli.ts";
import type {
  Transport,
  TransportName,
  TransportRequest,
  TransportResponse,
} from "./transports.ts";

export type FakeCliHandler = (args: string[]) => string | CliResult;

/** A scripted `playwright-cli`. Records every command, answers from a table of regexes. */
export class FakeCli implements CliRunner {
  readonly session: string;
  readonly calls: string[][] = [];
  #handlers: [RegExp, FakeCliHandler][] = [];
  #fallback: FakeCliHandler;

  constructor(session = "test", fallback: FakeCliHandler = () => "") {
    this.session = session;
    this.#fallback = fallback;
  }

  /** `on(/^eval/, …)` matches against the joined argument list. */
  on(pattern: RegExp, handler: FakeCliHandler): this {
    this.#handlers.push([pattern, handler]);
    return this;
  }

  /** Commands seen so far, as joined strings, for assertions. */
  get commands(): string[] {
    return this.calls.map((c) => c.join(" "));
  }

  async run(args: string[], options: CliRunOptions = {}): Promise<CliResult> {
    this.calls.push(args);
    const joined = args.join(" ");
    const handler = this.#handlers.find(([pattern]) => pattern.test(joined))?.[1] ?? this.#fallback;
    const result = handler(args);
    const full: CliResult =
      typeof result === "string"
        ? { ok: true, code: 0, stdout: result, stderr: "", output: result }
        : result;
    if (!full.ok && !options.tolerant) throw new Error(`FakeCli: ${joined} failed: ${full.output}`);
    return full;
  }
}

export type FakeResponse = Partial<TransportResponse> & { status: number; body: string };

/** A transport that answers from a queue (or one fixed response) and counts its calls. */
export class FakeTransport implements Transport {
  readonly name: TransportName;
  readonly cost: number;
  readonly requests: TransportRequest[] = [];
  #queue: (FakeResponse | Error)[];
  #last: FakeResponse | Error | undefined;

  constructor(name: TransportName, cost: number, responses: (FakeResponse | Error)[]) {
    this.name = name;
    this.cost = cost;
    this.#queue = [...responses];
  }

  get calls(): number {
    return this.requests.length;
  }

  async fetch(req: TransportRequest): Promise<TransportResponse> {
    this.requests.push(req);
    const next = this.#queue.shift() ?? this.#last;
    this.#last = next;
    if (next === undefined) throw new Error(`FakeTransport(${this.name}): no scripted response`);
    if (next instanceof Error) throw next;
    return {
      status: next.status,
      url: next.url ?? req.url,
      headers: next.headers ?? {},
      body: next.body,
      transport: this.name,
    };
  }
}
