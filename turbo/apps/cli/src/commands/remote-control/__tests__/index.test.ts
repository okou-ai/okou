import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { http, HttpResponse } from "msw";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { server } from "../../../mocks/server";
import { createRemoteControlCommand } from "../index";

const ID = "33333333-3333-4333-8333-333333333333";
const HOST_ID = "44444444-4444-4444-8444-444444444444";
const SNAPSHOT = "a".repeat(64);
const CLIENT_ID = "private-client-id-never-print";
const SECRET = "private-client-secret-never-print";
const BASE = "http://localhost:3000";
const credentials = { clientId: CLIENT_ID, clientSecret: SECRET };

function token(capabilities: readonly string[]) {
  const header = Buffer.from(JSON.stringify({ alg: "HS256" })).toString(
    "base64url",
  );
  const payload = Buffer.from(
    JSON.stringify({
      userId: "user-1",
      orgId: "org-1",
      runId: "run-1",
      scope: "okou",
      capabilities,
      iat: 1,
      exp: 2,
    }),
  ).toString("base64url");
  return `vm0_sandbox_${header}.${payload}.signature`;
}

function config(scope: "personal" | "organization" = "personal") {
  return {
    id: ID,
    name: "Private network",
    scope,
    tags: ["tag:work"],
    revision: 7,
    generation: 3,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-02T00:00:00.000Z",
    sshHosts: [
      {
        id: HOST_ID,
        displayName: "SSH reference",
        credentials,
        clientId: CLIENT_ID,
      },
    ],
    credentials,
    clientId: CLIENT_ID,
    clientSecret: SECRET,
    extra: { credentials },
  };
}

for (const kind of ["cloudflare-access", "tailscale"] as const) {
  describe(`okou remote-control ${kind}`, () => {
    let log = vi.spyOn(console, "log").mockImplementation(() => {});
    let error = vi.spyOn(console, "error").mockImplementation(() => {});
    let directory: string;

    beforeEach(() => {
      log = vi.spyOn(console, "log").mockImplementation(() => {});
      error = vi.spyOn(console, "error").mockImplementation(() => {});
      directory = mkdtempSync(join(tmpdir(), "remote-networks-"));
      vi.stubEnv("OKOU_API_BACKEND_URL", BASE);
      vi.stubEnv("OKOU_TOKEN", token(["connector:read", "connector:write"]));
    });
    afterEach(() => {
      log.mockClear();
      error.mockClear();
      vi.restoreAllMocks();
      vi.unstubAllEnvs();
      rmSync(directory, { recursive: true, force: true });
    });

    const url = `${BASE}/api/${kind}/configs`;
    function input(body: unknown) {
      const path = join(directory, "input.json");
      writeFileSync(path, JSON.stringify(body));
      return path;
    }
    function run(...args: string[]) {
      return createRemoteControlCommand().parseAsync([
        "node",
        "okou",
        kind,
        ...args,
      ]);
    }
    function output() {
      return [...log.mock.calls, ...error.mock.calls].flat().join("\n");
    }
    function noCredentials() {
      expect(output()).not.toContain(CLIENT_ID);
      expect(output()).not.toContain(SECRET);
      expect(output()).not.toContain("clientId");
      expect(output()).not.toContain("credentials");
    }
    it("lists scoped whitelisted metadata and nested references despite extra fields", async () => {
      server.use(
        http.get(url, ({ request }) => {
          if (kind === "cloudflare-access")
            expect(new URL(request.url).searchParams.get("view")).toBe(
              "scoped",
            );
          expect(request.headers.get("Authorization")).toContain(
            "Bearer vm0_sandbox_",
          );
          return HttpResponse.json({
            configs: [config(), { ...config("organization"), id: HOST_ID }],
          });
        }),
      );
      await run("list", "--scope", "personal", "--json");
      expect(JSON.parse(String(log.mock.calls[0]?.[0]))).toStrictEqual({
        configs: [
          {
            id: ID,
            name: "Private network",
            scope: "personal",
            tags: ["tag:work"],
            revision: 7,
            generation: 3,
            sshHosts: [{ id: HOST_ID, displayName: "SSH reference" }],
          },
        ],
      });
      noCredentials();
    });

    it("shows one exact ID from list without a new GET contract", async () => {
      server.use(
        http.get(url, () => {
          return HttpResponse.json({ configs: [config()] });
        }),
      );
      await run("show", ID, "--json");
      expect(JSON.parse(String(log.mock.calls[0]?.[0])).id).toBe(ID);
      noCredentials();
    });

    it("preserves VNC roles and protocol identity while stripping nested provider secrets", async () => {
      server.use(
        http.get(url, () => {
          return HttpResponse.json({
            configs: [
              {
                ...config(),
                vncHosts: [
                  {
                    id: HOST_ID,
                    displayName: "VNC reference",
                    roles: ["rfb", "kdc"],
                    credentials,
                    clientSecret: SECRET,
                  },
                ],
              },
            ],
          });
        }),
      );
      await run("list", "--json");
      const result = JSON.parse(String(log.mock.calls[0]?.[0]));
      expect(result.configs[0].sshHosts).toEqual([
        { id: HOST_ID, displayName: "SSH reference" },
      ]);
      expect(result.configs[0].vncHosts).toEqual([
        { id: HOST_ID, displayName: "VNC reference", roles: ["rfb", "kdc"] },
      ]);
      noCredentials();
    });

    it("creates a default UUID using only POST with credentials in the JSON body", async () => {
      const body = {
        name: "Work",
        scope: "organization",
        credentials,
        ...(kind === "tailscale" ? { tags: ["tag:work"] } : {}),
      };
      let received: unknown;
      server.use(
        http.post(url, async ({ request }) => {
          received = await request.json();
          return HttpResponse.json(config("organization"), { status: 201 });
        }),
      );
      await run("create", "--input", input(body), "--json");
      expect(received).toEqual({
        ...body,
        id: expect.stringMatching(
          /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u,
        ),
      });
      noCredentials();
    });

    it("updates exactly the supplied revision and credentials without any preliminary read or reference binding", async () => {
      const body = {
        expectedRevision: 7,
        credentials,
        ...(kind === "tailscale" ? { tags: ["tag:new"] } : {}),
      };
      server.use(
        http.patch(`${url}/${ID}`, async ({ request }) => {
          expect(await request.json()).toStrictEqual(body);
          return HttpResponse.json({ ...config(), revision: 8, generation: 4 });
        }),
      );
      await run("update", ID, "--input", input(body), "--json");
      expect(JSON.parse(String(log.mock.calls[0]?.[0]))).toMatchObject({
        revision: 8,
        generation: 4,
      });
      noCredentials();
    });

    it("deletes using the supplied snapshot, without discovery reads", async () => {
      const body = { expectedRevision: 7, impactSnapshot: SNAPSHOT };
      server.use(
        http.delete(`${url}/${ID}`, async ({ request }) => {
          expect(await request.json()).toStrictEqual(body);
          return new HttpResponse(null, { status: 204 });
        }),
      );
      await run("delete", ID, "--input", input(body), "--json");
      expect(JSON.parse(String(log.mock.calls[0]?.[0]))).toStrictEqual({
        id: ID,
      });
    });

    it("previews only safe impact fields and strips extra owner credentials", async () => {
      server.use(
        http.get(`${url}/${ID}/impact-preview`, ({ request }) => {
          expect(new URL(request.url).searchParams.get("operation")).toBe(
            "convert",
          );
          return HttpResponse.json({
            expectedRevision: 7,
            ownHostCount: 1,
            otherHostCount: 2,
            affectedOwners: [
              { userId: "owner-1", displayName: "Owner", credentials },
            ],
            impactSnapshot: SNAPSHOT,
            credentials,
          });
        }),
      );
      await run("impact", ID, "--operation", "convert", "--json");
      expect(JSON.parse(String(log.mock.calls[0]?.[0]))).toStrictEqual({
        revision: 7,
        references: {
          ownHostCount: 1,
          otherHostCount: 2,
          affectedOwners: [{ id: "owner-1", name: "Owner" }],
          impactSnapshot: SNAPSHOT,
        },
      });
      noCredentials();
    });

    it.each(["personal", "organization"] as const)(
      "converts to %s through its existing contract with no reads",
      async (scope) => {
        const body =
          scope === "personal"
            ? { expectedRevision: 7, impactSnapshot: SNAPSHOT }
            : { expectedRevision: 7 };
        server.use(
          http.post(`${url}/${ID}/convert-to-${scope}`, async ({ request }) => {
            expect(await request.json()).toStrictEqual(body);
            return HttpResponse.json(config(scope));
          }),
        );
        await run(
          "set-scope",
          ID,
          "--scope",
          scope,
          "--input",
          input(body),
          "--json",
        );
        expect(JSON.parse(String(log.mock.calls[0]?.[0])).scope).toBe(scope);
        noCredentials();
      },
    );
  });
}
