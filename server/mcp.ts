// ClubOS MCP (Model Context Protocol) server.
//
// Exposes the read-only /api/v1 surface as MCP tools, so a staff member can
// connect their Claude client (Claude Code, Claude Desktop, or any MCP client)
// straight to ClubOS using their scoped API key and ask questions of their club
// data in natural language.
//
// Design — deliberately dependency-free and low-risk:
//   • Streamable-HTTP MCP transport, hand-rolled (no @modelcontextprotocol/sdk),
//     so nothing new enters the esbuild bundle or package.json.
//   • Stateless: no session map, so requests are never pinned to a Fly machine.
//   • Auth reuse: POST /mcp is guarded by the SAME `requireApiKey` middleware as
//     /api/v1, and every tools/call forwards to the matching /api/v1 endpoint
//     over loopback carrying the same Bearer key. That means scope gating,
//     workspace (allowedOrgIds) binding, the audit log and the 240/min rate
//     limit are all enforced by the existing, battle-tested code — the MCP layer
//     adds no new way to reach data.
//
// Tool surface is generated from OPENAPI_V1_SPEC so it can never drift from the
// real /api/v1 endpoints — add an endpoint there and it becomes an MCP tool.

import type { Express, Request, Response, NextFunction } from "express";
import { OPENAPI_V1_SPEC } from "./openapi-v1";

const SERVER_NAME = "clubos";
const SERVER_VERSION = OPENAPI_V1_SPEC.info.version; // e.g. "1.2.0"

// Protocol versions we understand. We echo the client's version if we know it,
// otherwise offer our default. Newest first.
const SUPPORTED_PROTOCOL_VERSIONS = ["2025-06-18", "2025-03-26", "2024-11-05"];
const DEFAULT_PROTOCOL_VERSION = "2025-06-18";

type ToolParam = {
  name: string;
  type: "integer" | "string";
  description?: string;
  default?: unknown;
  enum?: string[];
};

type ToolDef = {
  name: string;
  path: string; // e.g. "/api/v1/league/teams"
  scope: string | null; // e.g. "league:read"
  description: string;
  params: ToolParam[];
  inputSchema: Record<string, unknown>;
};

// "/api/v1/league/teams" -> "league_teams"; "/api/v1/order-timing" -> "order_timing"
function pathToToolName(path: string): string {
  return path.replace("/api/v1/", "").replace(/[/-]/g, "_");
}

function buildMcpTools(): ToolDef[] {
  const tools: ToolDef[] = [];
  const paths = OPENAPI_V1_SPEC.paths as Record<string, any>;
  for (const [path, ops] of Object.entries(paths)) {
    if (path.endsWith("openapi.json")) continue; // not a useful tool
    const op = ops?.get;
    if (!op) continue;

    // Hyphen included: scope names are not all single words — "ethnic-cup:read"
    // parsed as "ethnic" here, which is nobody's scope. Harmless while this
    // field is informational (the loopback call to requireScope does the real
    // gating), and a silent mis-grant the day anything filters on it.
    const scopeMatch = /Scope:\s*([a-z0-9:_-]+)/i.exec(op.description || "");
    const scope = scopeMatch ? scopeMatch[1] : null;

    const params: ToolParam[] = (op.parameters || []).map((p: any) => ({
      name: p.name,
      type: p.schema?.type === "integer" ? "integer" : "string",
      description: p.description,
      default: p.schema?.default,
      enum: p.schema?.enum,
    }));

    const properties: Record<string, any> = {};
    for (const p of params) {
      const prop: Record<string, unknown> = { type: p.type };
      if (p.description) prop.description = p.description;
      if (p.enum) prop.enum = p.enum;
      if (p.default !== undefined) prop.default = p.default;
      properties[p.name] = prop;
    }

    const description = [op.summary, op.description].filter(Boolean).join(" — ");

    tools.push({
      name: pathToToolName(path),
      path,
      scope,
      description,
      params,
      // No params are required — every /api/v1 read has sensible defaults.
      inputSchema: { type: "object", properties, required: [] },
    });
  }
  return tools;
}

export const MCP_TOOLS = buildMcpTools();
const TOOL_BY_NAME = new Map(MCP_TOOLS.map((t) => [t.name, t]));

type JsonRpcMessage = {
  jsonrpc?: "2.0";
  id?: string | number | null;
  method?: string;
  params?: any;
  result?: any;
  error?: any;
};

type McpContext = {
  authHeader: string; // the caller's "Bearer clubos_..." — forwarded verbatim
  baseUrl: string; // loopback base, e.g. http://127.0.0.1:8080
};

// Handle one JSON-RPC message. Returns the response object, or null when the
// message is a notification/response that must not be answered.
export async function handleMcpMessage(
  msg: JsonRpcMessage,
  ctx: McpContext,
): Promise<JsonRpcMessage | null> {
  const method = msg.method;
  const id = msg.id ?? null;
  const isRequest = method != null && msg.id !== undefined && msg.id !== null;

  const ok = (result: any): JsonRpcMessage => ({ jsonrpc: "2.0", id, result });
  const fail = (code: number, message: string): JsonRpcMessage => ({
    jsonrpc: "2.0",
    id,
    error: { code, message },
  });

  // A response object (has result/error, no method) — nothing to do.
  if (!method) return null;

  switch (method) {
    case "initialize": {
      if (!isRequest) return null;
      const requested = msg.params?.protocolVersion;
      const protocolVersion = SUPPORTED_PROTOCOL_VERSIONS.includes(requested)
        ? requested
        : DEFAULT_PROTOCOL_VERSION;
      return ok({
        protocolVersion,
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
        instructions:
          "Read-only access to Christchurch United FC's ClubOS. Every tool is gated by " +
          "your API key's scopes and workspaces — calls outside your grant return an error. " +
          "No tool exposes medical data, payment identifiers, or player ID documents.",
      });
    }

    // Notifications — no response by protocol.
    case "notifications/initialized":
    case "notifications/cancelled":
    case "notifications/roots/list_changed":
      return null;

    case "ping":
      return isRequest ? ok({}) : null;

    case "tools/list": {
      if (!isRequest) return null;
      return ok({
        tools: MCP_TOOLS.map((t) => ({
          name: t.name,
          description: t.description,
          inputSchema: t.inputSchema,
        })),
      });
    }

    case "tools/call": {
      if (!isRequest) return null;
      const toolName = msg.params?.name;
      const args = msg.params?.arguments || {};
      const tool = TOOL_BY_NAME.get(toolName);
      if (!tool) return fail(-32602, `Unknown tool: ${toolName}`);

      const qs = new URLSearchParams();
      for (const p of tool.params) {
        const v = args[p.name];
        if (v !== undefined && v !== null && v !== "") qs.set(p.name, String(v));
      }
      const url = `${ctx.baseUrl}${tool.path}${qs.toString() ? `?${qs.toString()}` : ""}`;

      try {
        const resp = await fetch(url, {
          headers: { Authorization: ctx.authHeader, accept: "application/json" },
        });
        const text = await resp.text();
        if (!resp.ok) {
          let detail = text;
          try {
            detail = JSON.parse(text).error || text;
          } catch {
            /* keep raw text */
          }
          return ok({
            content: [{ type: "text", text: `Request failed (HTTP ${resp.status}): ${detail}` }],
            isError: true,
          });
        }
        return ok({ content: [{ type: "text", text }] });
      } catch (e: any) {
        return ok({
          content: [{ type: "text", text: `Internal error calling ${tool.path}: ${e?.message || e}` }],
          isError: true,
        });
      }
    }

    default:
      return isRequest ? fail(-32601, `Method not found: ${method}`) : null;
  }
}

// Wire the MCP endpoint onto the Express app. Call this INSIDE registerRoutes,
// after requireApiKey is defined and before the SPA fallback, passing the same
// requireApiKey closure the /api/v1 routes use.
export function mountMcpServer(
  app: Express,
  requireApiKey: (req: Request, res: Response, next: NextFunction) => unknown,
) {
  // Loopback base URL — forwards go machine-internal, never out to the public
  // host. PORT is 8080 in prod (Fly), 5000 in dev.
  const baseUrl = `http://127.0.0.1:${process.env.PORT || 5000}`;

  const cors = (res: Response) => {
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
    res.setHeader(
      "Access-Control-Allow-Headers",
      "Authorization, Content-Type, Mcp-Session-Id, MCP-Protocol-Version, Accept",
    );
  };

  // CORS preflight — must not require auth.
  app.options("/mcp", (_req, res) => {
    cors(res);
    res.status(204).end();
  });

  // Some clients open a GET to receive server-initiated messages over SSE. We
  // run stateless with no server-initiated stream, so decline politely.
  app.get("/mcp", (_req, res) => {
    cors(res);
    res.setHeader("Allow", "POST");
    res.status(405).json({
      jsonrpc: "2.0",
      id: null,
      error: { code: -32000, message: "This MCP server is stateless — use POST." },
    });
  });

  app.post("/mcp", requireApiKey, async (req: Request, res: Response) => {
    cors(res);
    const authHeader = req.headers.authorization || "";
    const ctx: McpContext = { authHeader, baseUrl };
    const body = req.body;

    try {
      if (Array.isArray(body)) {
        const responses = (await Promise.all(body.map((m) => handleMcpMessage(m, ctx)))).filter(
          (r): r is JsonRpcMessage => r !== null,
        );
        if (responses.length === 0) return res.status(202).end();
        return res.json(responses);
      }
      const response = await handleMcpMessage(body || {}, ctx);
      if (response === null) return res.status(202).end();
      return res.json(response);
    } catch (e: any) {
      return res.status(200).json({
        jsonrpc: "2.0",
        id: (body && body.id) ?? null,
        error: { code: -32603, message: `Internal error: ${e?.message || e}` },
      });
    }
  });
}
