import { beforeEach, describe, expect, it } from "vitest";
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

async function seedSession(input: {
  id: string;
  repoOwner: string;
  repoName: string;
  updatedAt?: number;
}): Promise<void> {
  const now = input.updatedAt ?? Date.now();
  await env.DB.prepare(
    `INSERT INTO sessions (id, title, repo_owner, repo_name, model, reasoning_effort, status, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
  )
    .bind(
      input.id,
      null,
      input.repoOwner.toLowerCase(),
      input.repoName.toLowerCase(),
      "openai/gpt-5.3-codex",
      null,
      "active",
      now,
      now
    )
    .run();
}

describe("Session folders API", () => {
  beforeEach(cleanD1Tables);

  it("returns empty folders and assignments initially", async () => {
    const headers = await authHeaders();
    const response = await SELF.fetch("https://test.local/session-folders/user-1", { headers });
    expect(response.status).toBe(200);
    const body = await response.json<{
      folders: unknown[];
      assignments: unknown[];
    }>();
    expect(body.folders).toEqual([]);
    expect(body.assignments).toEqual([]);
  });

  it("creates, renames, and deletes folders", async () => {
    const headers = await authHeaders();
    const create = await SELF.fetch("https://test.local/session-folders/user-1", {
      method: "POST",
      headers,
      body: JSON.stringify({
        repoOwner: "Acme",
        repoName: "Widgets",
        name: "Backlog",
      }),
    });
    expect(create.status).toBe(201);
    const created = await create.json<{
      folder: { id: string; repoOwner: string; repoName: string };
    }>();
    expect(created.folder.repoOwner).toBe("acme");
    expect(created.folder.repoName).toBe("widgets");

    const rename = await SELF.fetch(
      `https://test.local/session-folders/user-1/${encodeURIComponent(created.folder.id)}`,
      {
        method: "PATCH",
        headers,
        body: JSON.stringify({ name: "Roadmap" }),
      }
    );
    expect(rename.status).toBe(200);
    const renamed = await rename.json<{ folder: { name: string } }>();
    expect(renamed.folder.name).toBe("Roadmap");

    const remove = await SELF.fetch(
      `https://test.local/session-folders/user-1/${encodeURIComponent(created.folder.id)}`,
      {
        method: "DELETE",
        headers,
      }
    );
    expect(remove.status).toBe(200);
    const removedBody = await remove.json<{ movedToUnfiledCount: number }>();
    expect(removedBody.movedToUnfiledCount).toBe(0);
  });

  it("moves sessions to folder and back to unfiled", async () => {
    await seedSession({ id: "s-1", repoOwner: "acme", repoName: "widgets" });
    const headers = await authHeaders();

    const create = await SELF.fetch("https://test.local/session-folders/user-1", {
      method: "POST",
      headers,
      body: JSON.stringify({
        repoOwner: "acme",
        repoName: "widgets",
        name: "Urgent",
      }),
    });
    const created = await create.json<{ folder: { id: string } }>();

    const moveIn = await SELF.fetch("https://test.local/session-folders/user-1/sessions/s-1", {
      method: "PUT",
      headers,
      body: JSON.stringify({ folderId: created.folder.id }),
    });
    expect(moveIn.status).toBe(200);

    const listAfterMove = await SELF.fetch("https://test.local/session-folders/user-1", {
      headers,
    });
    const listBody = await listAfterMove.json<{
      assignments: Array<{ sessionId: string; folderId: string }>;
    }>();
    expect(listBody.assignments).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ sessionId: "s-1", folderId: created.folder.id }),
      ])
    );

    const moveOut = await SELF.fetch("https://test.local/session-folders/user-1/sessions/s-1", {
      method: "PUT",
      headers,
      body: JSON.stringify({ folderId: null }),
    });
    expect(moveOut.status).toBe(200);

    const listAfterUnfiled = await SELF.fetch("https://test.local/session-folders/user-1", {
      headers,
    });
    const unfiledBody = await listAfterUnfiled.json<{ assignments: unknown[] }>();
    expect(unfiledBody.assignments).toHaveLength(0);
  });

  it("rejects cross-repo session moves", async () => {
    await seedSession({ id: "s-1", repoOwner: "acme", repoName: "widgets" });
    const headers = await authHeaders();
    const create = await SELF.fetch("https://test.local/session-folders/user-1", {
      method: "POST",
      headers,
      body: JSON.stringify({
        repoOwner: "acme",
        repoName: "another-repo",
        name: "Mismatched",
      }),
    });
    const created = await create.json<{ folder: { id: string } }>();

    const move = await SELF.fetch("https://test.local/session-folders/user-1/sessions/s-1", {
      method: "PUT",
      headers,
      body: JSON.stringify({ folderId: created.folder.id }),
    });
    expect(move.status).toBe(400);
    const body = await move.json<{ error: string }>();
    expect(body.error).toContain("across repos");
  });

  it("deleting folder reports moved assignment count", async () => {
    await seedSession({ id: "s-1", repoOwner: "acme", repoName: "widgets" });
    const headers = await authHeaders();
    const create = await SELF.fetch("https://test.local/session-folders/user-1", {
      method: "POST",
      headers,
      body: JSON.stringify({
        repoOwner: "acme",
        repoName: "widgets",
        name: "ToDelete",
      }),
    });
    const created = await create.json<{ folder: { id: string } }>();
    await SELF.fetch("https://test.local/session-folders/user-1/sessions/s-1", {
      method: "PUT",
      headers,
      body: JSON.stringify({ folderId: created.folder.id }),
    });

    const remove = await SELF.fetch(
      `https://test.local/session-folders/user-1/${encodeURIComponent(created.folder.id)}`,
      {
        method: "DELETE",
        headers,
      }
    );
    expect(remove.status).toBe(200);
    const body = await remove.json<{ movedToUnfiledCount: number }>();
    expect(body.movedToUnfiledCount).toBe(1);
  });
});
