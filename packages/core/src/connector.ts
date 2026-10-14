/**
 * The connector model. DRAFT.
 *
 *   Connector (yad2)                category: ["software", "saas", "marketplaces"]
 *     ├─ credentials it may need    (email, password…; resolved per identity)
 *     ├─ entity types it produces   (listing, seller…)
 *     └─ operations                 (search_cars, get_listing, send_message…)
 *          each with a zod input + output schema, a kind (read/action), and run()
 *
 * An operation maps 1:1 to an MCP tool (`yad2_search_cars`), a CLI command
 * (`omni yad2 search-cars --json '{…}'`) and a section in a generated SKILL.md.
 */
import type { z } from "zod";
import type { Credentials } from "./credentials.ts";
import type { Entity } from "./diff.ts";
import type { OperationResult, ResumeInput } from "./result.ts";

/**
 * - read:   no side effects in the outside world (fetch listings, read AC state).
 * - action: side effects (message a seller, turn the boiler on, transfer money).
 *           Actions require human confirmation by default (see runtime.invoke).
 */
export type OperationKind = "read" | "action";

/** How the operation reaches the real world. Informational; may be mixed per call. */
export type Backend = "api" | "browser" | "device" | "local";

export type OperationContext = {
  connector: string;
  /** Who we act as (client/project). undefined = default identity. */
  identity?: string;
  credentials: Credentials;
  /** Present when the caller is resuming after a NeedsHuman result. */
  resume?: ResumeInput;
  signal?: AbortSignal;
  now: () => Date;
  log: (message: string, data?: Record<string, unknown>) => void;
  /** Per connector+identity dirs under `.local/` (browser profile, screenshots, cache). */
  paths: { profileDir: string; screenshotsDir: string; cacheDir: string };
};

export type SnapshotSpec<I, O> = {
  /** Entity type stored in the snapshot, e.g. "listing". */
  entityType: string;
  /** The series key; e.g. `saved-search:${input.savedSearch}`. */
  scope: (input: I) => string;
  /** Pull the entities (with stable ids) out of the operation output. */
  entities: (output: O) => Entity[];
};

export type OperationDefinition<
  I extends z.ZodType = z.ZodType,
  O extends z.ZodType = z.ZodType,
> = {
  /** snake_case, unique within the connector: "search_cars". */
  name: string;
  title?: string;
  /** Written for an LLM: what it does, when to use it, cost/latency caveats. */
  description: string;
  kind: OperationKind;
  input: I;
  output: O;
  backends?: Backend[];
  /** Same input twice has no additional effect (MCP idempotentHint). */
  idempotent?: boolean;
  /** When set, successful results are recorded as a snapshot and diffed against the previous one. */
  snapshot?: SnapshotSpec<z.output<I>, z.output<O>>;
  run: (input: z.output<I>, ctx: OperationContext) => Promise<OperationResult<z.input<O>>>;
};

export type CredentialSpec = {
  /** Short name; env var becomes OMNI_<CONNECTOR>_<NAME>. */
  name: string;
  description: string;
  /** Required for at least some operations. */
  required?: boolean;
};

export type EntitySpec = {
  type: string;
  description: string;
  schema?: z.ZodType;
};

export type ConnectorDefinition = {
  /** lowercase [a-z0-9-], globally unique: "yad2". */
  id: string;
  title: string;
  description: string;
  /** Path from the root of the hierarchy, excluding the connector: ["software","saas","marketplaces"]. */
  category: string[];
  version: string;
  credentials?: CredentialSpec[];
  entities?: EntitySpec[];
  // oxlint-disable-next-line no-explicit-any -- heterogeneous list of operations
  operations: OperationDefinition<any, any>[];
};

/** Identity helper that keeps input/output inference inside `run`. */
export function defineOperation<I extends z.ZodType, O extends z.ZodType>(
  op: OperationDefinition<I, O>,
): OperationDefinition<I, O> {
  return op;
}

const ID_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const OP_RE = /^[a-z][a-z0-9]*(?:_[a-z0-9]+)*$/;

export function defineConnector(def: ConnectorDefinition): ConnectorDefinition {
  if (!ID_RE.test(def.id))
    throw new Error(`Invalid connector id "${def.id}" (lowercase, digits, hyphens)`);
  const seen = new Set<string>();
  for (const op of def.operations) {
    if (!OP_RE.test(op.name)) throw new Error(`Invalid operation name "${op.name}" (snake_case)`);
    if (seen.has(op.name)) throw new Error(`Duplicate operation "${op.name}" in ${def.id}`);
    seen.add(op.name);
  }
  return def;
}

/** MCP tool name. Uses "_" not "." because some LLM APIs only allow [a-zA-Z0-9_-] in tool names. */
export function toolName(connectorId: string, operationName: string): string {
  return `${connectorId.replaceAll("-", "_")}_${operationName}`;
}

/** CLI words: ["yad2", "search-cars"]. */
export function cliCommand(connectorId: string, operationName: string): string[] {
  return [connectorId, operationName.replaceAll("_", "-")];
}

/** In-memory registry that adapters (MCP/CLI/skill generator) iterate over. */
export class Registry {
  #connectors = new Map<string, ConnectorDefinition>();
  add(connector: ConnectorDefinition): this {
    if (this.#connectors.has(connector.id))
      throw new Error(`Connector "${connector.id}" already registered`);
    this.#connectors.set(connector.id, connector);
    return this;
  }
  get(id: string): ConnectorDefinition | undefined {
    return this.#connectors.get(id);
  }
  list(): ConnectorDefinition[] {
    return [...this.#connectors.values()].sort((a, b) => a.id.localeCompare(b.id));
  }
  /** e.g. inCategory(["software","saas"]) returns every SaaS connector. */
  inCategory(prefix: string[]): ConnectorDefinition[] {
    return this.list().filter((c) => prefix.every((part, i) => c.category[i] === part));
  }
}
