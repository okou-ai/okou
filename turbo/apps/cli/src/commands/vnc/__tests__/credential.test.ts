import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { http, HttpResponse } from "msw";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { server } from "../../../mocks/server";
import { createVncCommand } from "../index";

const id = "a0000000-0000-4000-8000-000000000001";
const metadata = {
  id,
  name: "Desktop login",
  authMethod: "username_password",
  revision: 3,
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-02T00:00:00.000Z",
  hosts: [{ id, displayName: "Desktop" }],
};
const injectedSecrets = {
  username: "USERNAME_CANARY",
  password: "SECRET_CANARY",
  privateKey: "PRIVATE_KEY_CANARY",
  certificateChain: "CERTIFICATE_CANARY",
  ticketCache: "TICKET_CANARY",
  keytab: "KEYTAB_CANARY",
  authentication: { password: "NESTED_CANARY" },
  value: "VALUE_CANARY",
};
const output = vi.spyOn(console, "log").mockImplementation(() => {});
const errors = vi.spyOn(console, "error").mockImplementation(() => {});
let dir: string;
function token(capabilities: readonly string[]) {
  return `vm0_sandbox_e30.${Buffer.from(JSON.stringify({ scope: "okou", capabilities, userId: "owner", orgId: "org", runId: id })).toString("base64url")}.signature`;
}
function input(body: unknown) {
  const path = join(dir, "input.json");
  writeFileSync(path, JSON.stringify(body));
  return path;
}
async function invoke(...args: string[]) {
  await createVncCommand().parseAsync(["credential", ...args], {
    from: "user",
  });
}
function printed() {
  return [...output.mock.calls, ...errors.mock.calls].flat().join("\n");
}
function expectNoSecrets() {
  expect(printed()).not.toContain("CANARY");
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "okou-vnc-credential-"));
  vi.stubEnv("OKOU_TOKEN", token(["connector:read", "connector:write"]));
  vi.stubEnv("OKOU_API_BACKEND_URL", "http://localhost:3000");
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
  process.exitCode = 0;
  output.mockClear();
  errors.mockClear();
  vi.unstubAllEnvs();
});

const authenticationProfiles = [
  {
    method: "username_password",
    username: "USERNAME_CANARY",
    password: "SECRET_CANARY",
  },
  {
    method: "client_certificate",
    certificateChain: "CERTIFICATE_CANARY",
    privateKey: "PRIVATE_KEY_CANARY",
  },
];

describe("okou vnc credential management", () => {
  it("projects list/show metadata and strips injected nested values", async () => {
    server.use(
      http.get("http://localhost:3000/api/vnc/credentials", () => {
        return HttpResponse.json({
          credentials: [
            {
              ...metadata,
              ...injectedSecrets,
              hosts: [{ ...metadata.hosts[0], ...injectedSecrets }],
            },
          ],
          ...injectedSecrets,
        });
      }),
    );
    await invoke("list", "--json");
    expect(JSON.parse(String(output.mock.calls[0]?.[0]))).toStrictEqual({
      credentials: [metadata],
    });
    await invoke("show", id, "--json");
    expect(printed()).toContain('"revision":');
    expectNoSecrets();
  });

  it.each(authenticationProfiles)(
    "creates and updates $method with a personal token without echoing credential material",
    async (authentication) => {
      vi.stubEnv("OKOU_TOKEN", "personal-token");
      let created: unknown;
      let updated: unknown;
      server.use(
        http.post(
          "http://localhost:3000/api/vnc/credentials",
          async ({ request }) => {
            expect(request.headers.get("authorization")).toBe(
              "Bearer personal-token",
            );
            created = await request.json();
            return HttpResponse.json(
              {
                ...metadata,
                authMethod: authentication.method,
                ...injectedSecrets,
              },
              { status: 201 },
            );
          },
        ),
        http.patch(
          `http://localhost:3000/api/vnc/credentials/${id}`,
          async ({ request }) => {
            updated = await request.json();
            return HttpResponse.json({
              ...metadata,
              authMethod: authentication.method,
              revision: 4,
              ...injectedSecrets,
            });
          },
        ),
      );
      await invoke(
        "create",
        "--input",
        input({ name: metadata.name, authentication }),
        "--json",
      );
      expect(created).toEqual({
        id: expect.stringMatching(/^[a-f0-9-]{36}$/u),
        name: metadata.name,
        authentication,
      });
      expect(JSON.parse(String(output.mock.calls[0]?.[0]))).toStrictEqual({
        ...metadata,
        authMethod: authentication.method,
      });
      await invoke(
        "update",
        id,
        "--input",
        input({ expectedRevision: 3, authentication }),
      );
      expect(updated).toStrictEqual({ expectedRevision: 3, authentication });
      expectNoSecrets();
    },
  );

  it("deletes using the existing expectedRevision field", async () => {
    let body: unknown;
    server.use(
      http.delete(
        `http://localhost:3000/api/vnc/credentials/${id}`,
        async ({ request }) => {
          body = await request.json();
          return new HttpResponse(null, { status: 204 });
        },
      ),
    );
    await invoke(
      "delete",
      id,
      "--input",
      input({ expectedRevision: 3 }),
      "--json",
    );
    expect(body).toStrictEqual({ expectedRevision: 3 });
    expect(output).toHaveBeenCalledExactlyOnceWith(
      JSON.stringify({ id, deleted: true }),
    );
  });
});
