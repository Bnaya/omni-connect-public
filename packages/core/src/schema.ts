/**
 * Schema layer: zod v4. DRAFT.
 *
 * Why zod v4 (and not hand-written JSON Schema):
 * - One definition gives runtime validation, static TS types (z.infer) AND JSON
 *   Schema (z.toJSONSchema, draft 2020-12, the MCP default dialect). Hand-written
 *   JSON Schema would need a validator (ajv) plus duplicated TS types.
 * - zod v4 implements Standard Schema, which is exactly what the MCP TypeScript
 *   SDK v2 (`@modelcontextprotocol/server`) accepts for inputSchema/outputSchema.
 * - It is a single dependency with no transitive deps.
 *
 * Connectors must import `z` from `@omni/core` (not from "zod") so that the whole
 * repo shares one zod instance.
 */
import { z } from "zod";

export { z };

export type JsonSchema = Record<string, unknown>;

/** JSON Schema for tool/CLI/skill descriptions. `io: "input"` describes what callers may send (defaults optional). */
export function toJsonSchema(schema: z.ZodType, io: "input" | "output" = "output"): JsonSchema {
  const json = z.toJSONSchema(schema, { io, unrepresentable: "any" }) as JsonSchema;
  return json;
}
