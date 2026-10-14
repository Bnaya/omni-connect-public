/**
 * Consumer-agnostic runtime. DRAFT.
 *
 * Every adapter (MCP server, CLI, skill scripts, daemon/poller) calls `invoke`
 * and `describeConnector`; none of them call `op.run` directly. That keeps
 * validation, credential handling, confirmation of side effects, handoffs and
 * snapshots identical no matter how the connector is exposed.
 */
import { join } from "node:path";
import { z } from "zod";
import type { ConnectorDefinition, OperationContext, OperationDefinition } from "./connector.ts";
import { cliCommand, toolName } from "./connector.ts";
import type { CredentialProvider } from "./credentials.ts";
import { MissingCredentialError, scopedCredentials } from "./credentials.ts";
import type { OperationResult, ResumeInput } from "./result.ts";
import { HandoffRequired, failed, needsHuman, ok } from "./result.ts";
import type { JsonSchema } from "./schema.ts";
import { toJsonSchema } from "./schema.ts";
import type { SnapshotStore } from "./snapshot-store.ts";

export type InvokeOptions = {
  credentials: CredentialProvider;
  identity?: string;
  /** When given, operations with a `snapshot` spec are recorded and diffed. */
  store?: SnapshotStore;
  resume?: ResumeInput;
  signal?: AbortSignal;
  /**
   * Require a human "accept" (via resume) before running `kind: "action"` operations.
   * Default true. A CLI where the human typed the command may pass false.
   */
  confirmActions?: boolean;
  /** Root for runtime state; default ".local". */
  localRoot?: string;
  now?: () => Date;
  log?: (message: string, data?: Record<string, unknown>) => void;
};

export async function invoke(
  connector: ConnectorDefinition,
  operationName: string,
  rawInput: unknown,
  options: InvokeOptions,
): Promise<OperationResult<unknown>> {
  const op = connector.operations.find((o) => o.name === operationName);
  if (!op)
    return failed("unknown_operation", `${connector.id} has no operation "${operationName}"`);

  const parsed = op.input.safeParse(rawInput ?? {});
  if (!parsed.success)
    return failed("invalid_input", z.prettifyError(parsed.error), { details: parsed.error.issues });

  const confirm = options.confirmActions ?? true;
  if (op.kind === "action" && confirm && options.resume?.action !== "accept") {
    if (options.resume) {
      return failed("declined", "The human declined this action.");
    }
    return needsHuman({
      kind: "confirm",
      message: `Confirm ${connector.title}: ${op.title ?? op.name} with ${JSON.stringify(parsed.data)}`,
    });
  }

  const ctx = makeContext(connector, options);
  let result: OperationResult<unknown>;
  try {
    result = await op.run(parsed.data, ctx);
  } catch (err) {
    if (err instanceof HandoffRequired) return needsHuman(err.handoff);
    if (err instanceof MissingCredentialError) {
      return needsHuman({
        kind: "credentials",
        message: `${connector.title} needs credentials that are not configured. Set them in the environment (never paste secrets into chat).`,
        missingCredentials: err.locations,
      });
    }
    const message = err instanceof Error ? err.message : String(err);
    return failed("internal", message);
  }
  if (result.status !== "ok") return result;

  const out = op.output.safeParse(result.data);
  if (!out.success) {
    return failed(
      "invalid_output",
      `Connector bug: output of ${op.name} does not match its schema`,
      {
        details: out.error.issues,
      },
    );
  }

  const meta = { ...result.meta };
  if (op.snapshot && options.store) {
    const saved = options.store.save({
      connector: connector.id,
      scope: op.snapshot.scope(parsed.data),
      entityType: op.snapshot.entityType,
      entities: op.snapshot.entities(out.data),
      takenAt: ctx.now().toISOString(),
    });
    meta.snapshotId = saved.id;
    meta.diff = options.store.diffLatest(saved.connector, saved.scope)?.diff;
  }
  return ok(out.data, meta);
}

function makeContext(connector: ConnectorDefinition, options: InvokeOptions): OperationContext {
  const root = options.localRoot ?? ".local";
  const who = options.identity ? `${connector.id}--${options.identity}` : connector.id;
  const ctx: OperationContext = {
    connector: connector.id,
    credentials: scopedCredentials(options.credentials, connector.id, options.identity),
    now: options.now ?? (() => new Date()),
    log: options.log ?? (() => {}),
    paths: {
      profileDir: join(root, "profiles", who),
      screenshotsDir: join(root, "screenshots", who),
      cacheDir: join(root, "cache", who),
    },
  };
  if (options.identity) ctx.identity = options.identity;
  if (options.resume) ctx.resume = options.resume;
  if (options.signal) ctx.signal = options.signal;
  return ctx;
}

export type OperationManifest = {
  name: string;
  toolName: string;
  cli: string[];
  title?: string;
  description: string;
  kind: OperationDefinition["kind"];
  backends?: OperationDefinition["backends"];
  /** Directly usable as MCP ToolAnnotations. */
  annotations: {
    readOnlyHint: boolean;
    destructiveHint: boolean;
    idempotentHint: boolean;
    openWorldHint: boolean;
  };
  inputSchema: JsonSchema;
  outputSchema: JsonSchema;
  snapshots?: { entityType: string };
};

export type ConnectorManifest = {
  id: string;
  title: string;
  description: string;
  category: string[];
  version: string;
  credentials: { name: string; description: string; required: boolean; env: string }[];
  entities: { type: string; description: string; schema?: JsonSchema }[];
  operations: OperationManifest[];
};

/**
 * Plain-JSON description of a connector. This is the single source that adapters
 * render: MCP tools/list, `omni <connector> --help`, and generated SKILL.md files.
 */
export function describeConnector(connector: ConnectorDefinition): ConnectorManifest {
  const envPrefix = `OMNI_${connector.id.toUpperCase().replace(/[^A-Z0-9]+/g, "_")}_`;
  return {
    id: connector.id,
    title: connector.title,
    description: connector.description,
    category: connector.category,
    version: connector.version,
    credentials: (connector.credentials ?? []).map((c) => ({
      name: c.name,
      description: c.description,
      required: c.required ?? false,
      env: envPrefix + c.name.toUpperCase().replace(/[^A-Z0-9]+/g, "_"),
    })),
    entities: (connector.entities ?? []).map((e) => {
      const entry: { type: string; description: string; schema?: JsonSchema } = {
        type: e.type,
        description: e.description,
      };
      if (e.schema) entry.schema = toJsonSchema(e.schema);
      return entry;
    }),
    operations: connector.operations.map((op) => {
      const m: OperationManifest = {
        name: op.name,
        toolName: toolName(connector.id, op.name),
        cli: cliCommand(connector.id, op.name),
        description: op.description,
        kind: op.kind,
        annotations: {
          readOnlyHint: op.kind === "read",
          destructiveHint: op.kind === "action",
          idempotentHint: op.idempotent ?? op.kind === "read",
          openWorldHint: true,
        },
        inputSchema: toJsonSchema(op.input, "input"),
        outputSchema: toJsonSchema(op.output, "output"),
      };
      if (op.title) m.title = op.title;
      if (op.backends) m.backends = op.backends;
      if (op.snapshot) m.snapshots = { entityType: op.snapshot.entityType };
      return m;
    }),
  };
}
