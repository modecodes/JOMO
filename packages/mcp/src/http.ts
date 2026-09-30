/**
 * Local HTTP transport for MCP clients on this machine.
 *
 * The server holds keys, so the endpoint is locked down: it listens on loopback only, refuses any
 * Host header that is not loopback (DNS rebinding), requires a bearer token on every request, and
 * keeps one MCP session per client so the server can ask the user for approval through elicitation.
 */
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import { randomUUID, timingSafeEqual } from "node:crypto";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import type { JomoContext } from "./context.js";
import { createJomoServer } from "./server.js";

export const LOOPBACK_HOSTS: ReadonlySet<string> = new Set(["127.0.0.1", "localhost", "::1", "[::1]"]);

/** `--host` may only name loopback. Anything else is refused before the keystore is opened. */
export function assertLoopbackHost(host: string | undefined): void {
  if (host !== undefined && !LOOPBACK_HOSTS.has(host)) {
    throw new Error("--http only listens on 127.0.0.1. The server holds keys; put a proxy with its own authentication in front of it if it must be reached from elsewhere.");
  }
}

export interface HttpOptions {
  /** 0 picks a free port. */
  port: number;
  /** Bearer token every request must carry. At least 16 characters. */
  token: string;
}

export interface HttpHandle {
  url: string;
  port: number;
  close(): Promise<void>;
}

export async function startHttp(ctx: JomoContext, options: HttpOptions): Promise<HttpHandle> {
  if (options.token.length < 16) throw new Error("The HTTP bearer token must be at least 16 characters");
  const expected = Buffer.from(`Bearer ${options.token}`);
  const authorised = (header: string | undefined): boolean => {
    const got = Buffer.from(header ?? "");
    return got.length === expected.length && timingSafeEqual(got, expected);
  };
  const sessions = new Map<string, { transport: StreamableHTTPServerTransport; close: () => Promise<void> }>();
  let allowedHosts: string[] = [];

  const http: Server = createServer(async (req, res) => {
    try {
      if (req.url !== "/mcp") {
        res.writeHead(404).end();
        return;
      }
      if (!authorised(req.headers.authorization)) {
        res.writeHead(401, { "www-authenticate": "Bearer" }).end();
        return;
      }
      const sessionId = req.headers["mcp-session-id"];
      const existing = typeof sessionId === "string" ? sessions.get(sessionId) : undefined;
      if (existing) {
        await existing.transport.handleRequest(req, res);
        return;
      }
      if (req.method !== "POST") {
        res.writeHead(400).end("Missing or unknown mcp-session-id");
        return;
      }
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(chunk as Buffer);
      let body: unknown;
      try {
        body = JSON.parse(Buffer.concat(chunks).toString("utf8") || "null");
      } catch {
        res.writeHead(400).end("Body is not JSON");
        return;
      }
      if (!isInitializeRequest(body)) {
        res.writeHead(400).end("A new session starts with an initialize request");
        return;
      }
      const server = createJomoServer(ctx);
      const transport: StreamableHTTPServerTransport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => randomUUID(),
        enableDnsRebindingProtection: true,
        allowedHosts,
        onsessioninitialized: (id: string): void => {
          sessions.set(id, { transport, close: () => server.close() });
        },
      });
      transport.onclose = () => {
        if (transport.sessionId) sessions.delete(transport.sessionId);
      };
      // The SDK's transport types predate exactOptionalPropertyTypes.
      await server.connect(transport as unknown as Parameters<typeof server.connect>[0]);
      await transport.handleRequest(req, res, body);
    } catch (error) {
      if (!res.headersSent) res.writeHead(500).end();
      process.stderr.write(`jomo-mcp http: ${error instanceof Error ? error.message : String(error)}\n`);
    }
  });

  await new Promise<void>((resolve, reject) => {
    http.once("error", reject);
    http.listen(options.port, "127.0.0.1", () => resolve());
  });
  const port = (http.address() as AddressInfo).port;
  allowedHosts = [...LOOPBACK_HOSTS].flatMap((h) => [h, `${h}:${port}`]);
  return {
    url: `http://127.0.0.1:${port}/mcp`,
    port,
    close: async () => {
      for (const s of sessions.values()) await s.close();
      sessions.clear();
      await new Promise<void>((resolve) => http.close(() => resolve()));
    },
  };
}
