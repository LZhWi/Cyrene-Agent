import type { JsonSchemaProp, ToolDefinition } from "../orchestrator/tool-registry";

export interface WorkToolValidationResult {
  ok: boolean;
  errors: string[];
}

function validateValue(value: unknown, schema: JsonSchemaProp, path: string, errors: string[]): void {
  if (schema.type === "array" && "items" in schema) {
    if (!Array.isArray(value)) {
      errors.push(`${path} expected array`);
      return;
    }
    value.forEach((child, index) => validateValue(child, schema.items, `${path}[${index}]`, errors));
    return;
  }
  if (schema.type === "object" && "properties" in schema) {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      errors.push(`${path} expected object`);
      return;
    }
    const record = value as Record<string, unknown>;
    const missing = (schema.required ?? []).filter((key) => !(key in record));
    if (missing.length) errors.push(`${path} missing required fields: ${missing.join(", ")}`);
    for (const [key, child] of Object.entries(record)) {
      const childSchema = schema.properties[key];
      if (!childSchema) errors.push(`${path}.${key} is not allowed`);
      else validateValue(child, childSchema, `${path}.${key}`, errors);
    }
    return;
  }
  if (schema.type === "number" && typeof value !== "number") errors.push(`${path} expected number`);
  else if (schema.type === "integer" && (!Number.isInteger(value))) errors.push(`${path} expected integer`);
  else if (schema.type === "boolean" && typeof value !== "boolean") errors.push(`${path} expected boolean`);
  else if (schema.type === "string" && typeof value !== "string") errors.push(`${path} expected string`);
  if ("enum" in schema && schema.enum && !schema.enum.includes(String(value))) {
    errors.push(`${path} must be one of: ${schema.enum.join(", ")}`);
  }
}

export function validateWorkToolArguments(
  tool: ToolDefinition,
  args: Record<string, unknown>,
): WorkToolValidationResult {
  const errors: string[] = [];
  const missing = (tool.inputSchema.required ?? []).filter((key) => !(key in args));
  if (missing.length) errors.push(`missing required fields: ${missing.join(", ")}`);
  for (const [key, value] of Object.entries(args)) {
    const schema = tool.inputSchema.properties[key];
    if (!schema) errors.push(`unknown field: ${key}`);
    else validateValue(value, schema, key, errors);
  }
  return { ok: errors.length === 0, errors };
}
