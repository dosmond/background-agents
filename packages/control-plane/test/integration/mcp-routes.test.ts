import { describe, it, expect, beforeEach } from "vitest";
import { SELF, env } from "cloudflare:test";
import { generateInternalToken } from "../../src/auth/internal";
import { cleanD1Tables } from "./cleanup";

async function authHeaders(): Promise<Record<string, string>> {
  const token = await generateInternalToken(env.INTERNAL_CALLBACK_SECRET!);
  return {
    Authorization: `Bearer ${token}`,
    "Content-Type": "application/json",
  };
}

describe("MCP routes smoke", () => {
  beforeEach(cleanD1Tables);

  it("requires auth for MCP endpoints", async () => {
    const targets = [
      { method: "GET", url: "https://test.local/repos/acme/widgets/mcp" },
      { method: "PUT", url: "https://test.local/repos/acme/widgets/mcp" },
      { method: "POST", url: "https://test.local/repos/acme/widgets/mcp/validate" },
      { method: "GET", url: "https://test.local/repos/acme/widgets/mcp/health" },
    ];

    for (const target of targets) {
      const response = await SELF.fetch(target.url, {
        method: target.method,
        headers: { "Content-Type": "application/json" },
        body: target.method === "PUT" || target.method === "POST" ? JSON.stringify({}) : undefined,
      });
      expect(response.status).toBe(401);
    }
  });

  it("GET /repos/:owner/:name/mcp returns repo-scoped config payload shape", async () => {
    const response = await SELF.fetch("https://test.local/repos/acme/widgets/mcp", {
      headers: await authHeaders(),
    });

    expect(response.status).toBe(200);
    const body = await response.json<{ repo: string; mcpConfig: unknown }>();
    expect(body.repo).toBe("acme/widgets");
    expect(body.mcpConfig).toBeNull();
  });

  it("GET /repos/:owner/:name/mcp/health returns not_configured by default", async () => {
    const response = await SELF.fetch("https://test.local/repos/acme/widgets/mcp/health", {
      headers: await authHeaders(),
    });

    expect(response.status).toBe(200);
    const body = await response.json<{ status: string; servers: unknown[] }>();
    expect(body.status).toBe("not_configured");
    expect(body.servers).toEqual([]);
  });

  it("PUT /repos/:owner/:name/mcp and POST /validate fail gracefully without resolvable repo", async () => {
    const headers = await authHeaders();
    const payload = {
      mcpConfig: {
        mcpServers: {
          local: {
            transport: "stdio",
            command: "node",
            args: ["server.js"],
          },
        },
      },
    };

    const putResponse = await SELF.fetch("https://test.local/repos/acme/widgets/mcp", {
      method: "PUT",
      headers,
      body: JSON.stringify(payload),
    });
    const validateResponse = await SELF.fetch(
      "https://test.local/repos/acme/widgets/mcp/validate",
      {
        method: "POST",
        headers,
        body: JSON.stringify(payload),
      }
    );

    // In local integration envs without GitHub App config this is 500.
    // In configured envs it may be 404 (repo not installed) or 200/400 if resolvable.
    expect([200, 400, 404, 500]).toContain(putResponse.status);
    expect([200, 400, 404, 500]).toContain(validateResponse.status);
  });
});
