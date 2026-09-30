/**
 * The tool surface as OpenAI function-calling schemas, for clients without MCP support.
 * Semantics are identical to the MCP tools (two-phase confirmation, unit-bearing amounts).
 */
import { z } from "zod";
import { TOOL_PREFIX, TOOL_SPECS, type ToolKey } from "./spec.js";

export interface OpenAIFunctionTool {
  type: "function";
  function: { name: string; description: string; parameters: Record<string, unknown>; strict?: boolean };
}

export function toolJsonSchema(key: ToolKey): Record<string, unknown> {
  return z.toJSONSchema(z.object(TOOL_SPECS[key].shape)) as Record<string, unknown>;
}

export const jomoToolSchemas: readonly OpenAIFunctionTool[] = (Object.keys(TOOL_SPECS) as ToolKey[]).map((key) => ({
  type: "function",
  function: { name: `${TOOL_PREFIX}${key}`, description: TOOL_SPECS[key].description, parameters: toolJsonSchema(key) },
}));

export { TOOL_SPECS, TOOL_PREFIX };
