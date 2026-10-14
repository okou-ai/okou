import { createReadStream, mkdtempSync, rmSync, writeFileSync } from "node:fs";
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
vi.spyOn(process, "exit").mockImplementation((): never => {
  throw new Error("CLI exit");
});
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

const principal = { realm: "EXAMPLE.COM", components: ["USERNAME_CANARY"] };
const service = {
  realm: "EXAMPLE.COM",
  components: ["vnc", "desktop.example.com"],
};
const authenticationProfiles = [
  { method: "vnc_password", password: "CANARY" },
  ...[
    "username_password",
    "qemu_scram_sha256",
    "apple_dh_username_password",
    "apple_srp_username_password",
    "apple_rsa_srp_username_password",
    "rsa_aes_username_password",
  ].map((method) => {
    return {
      method,
      username: "USERNAME_CANARY",
      password: "SECRET_CANARY",
    };
  }),
  { method: "rsa_aes_password", password: "SECRET_CANARY" },
  {
    method: "client_certificate",
    certificateChain: "CERTIFICATE_CANARY",
    privateKey: "PRIVATE_KEY_CANARY",
  },
  {
    method: "client_certificate_vnc_password",
    certificateChain: "CERTIFICATE_CANARY",
    privateKey: "PRIVATE_KEY_CANARY",
    password: "CANARY",
  },
  {
    method: "qemu_kerberos_ticket",
    initiator: principal,
    service,
    ticketCache: Buffer.from("TICKET_CANARY").toString("base64"),
  },
  {
    method: "qemu_kerberos_keytab",
    initiator: principal,
    keytab: Buffer.from("KEYTAB_CANARY").toString("base64"),
  },
  {
    method: "qemu_kerberos_password",
    initiator: principal,
    password: "SECRET_CANARY",
  },
];

describe("okou vnc credential management", () => {
  it.each([false, true])(
    "projects list/show metadata and strips injected nested values (json=%s)",
    async (json) => {
      server.use(
        http.get("http://localhost:3000/api/vnc/credentials", () => {
          return HttpResponse.json({
            credentials: [
              {
                ...metadata,
                ...injectedSecrets,
                initiator: principal,
                hosts: [{ ...metadata.hosts[0], ...injectedSecrets }],
              },
            ],
            ...injectedSecrets,
          });
        }),
      );
      await invoke("list", ...(json ? ["--json"] : []));
      expect(JSON.parse(String(output.mock.calls[0]?.[0]))).toStrictEqual({
        credentials: [metadata],
      });
      await invoke("show", id, ...(json ? ["--json"] : []));
      expect(printed()).toContain('"revision":');
      expectNoSecrets();
    },
  );

  it.each(authenticationProfiles)(
    "creates and updates $method without echoing credential material",
    async (authentication) => {
      let created: unknown;
      let updated: unknown;
      server.use(
        http.post(
          "http://localhost:3000/api/vnc/credentials",
          async ({ request }) => {
            expect(request.headers.get("authorization")).toBe(
              `Bearer ${token(["connector:read", "connector:write"])}`,
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
      expect(printed()).not.toContain(
        Buffer.from("TICKET_CANARY").toString("base64"),
      );
      expect(printed()).not.toContain(
        Buffer.from("KEYTAB_CANARY").toString("base64"),
      );
    },
  );

  it("preserves an explicit create UUID and safely reports a bodyless result", async () => {
    let body: unknown;
    server.use(
      http.post(
        "http://localhost:3000/api/vnc/credentials",
        async ({ request }) => {
          body = await request.json();
          return new HttpResponse(null, { status: 204 });
        },
      ),
    );
    const value = {
      id,
      name: metadata.name,
      authentication: authenticationProfiles[0],
    };
    await invoke("create", "--input", input(value), "--json");
    expect(body).toStrictEqual(value);
    expect(output).toHaveBeenCalledExactlyOnceWith(JSON.stringify({ id }));
  });

  it("accepts JSON from stdin without exposing input credential values", async () => {
    const descriptor = Object.getOwnPropertyDescriptor(process, "stdin");
    if (!descriptor) throw new Error("stdin descriptor unavailable");
    const body = {
      name: metadata.name,
      authentication: authenticationProfiles[0],
    };
    const stream = createReadStream(input(body));
    let received: unknown;
    server.use(
      http.post(
        "http://localhost:3000/api/vnc/credentials",
        async ({ request }) => {
          received = await request.json();
          return new HttpResponse(null, { status: 204 });
        },
      ),
    );
    Object.defineProperty(process, "stdin", {
      configurable: true,
      value: stream,
    });
    try {
      await invoke("create", "--input", "-", "--json");
    } finally {
      stream.destroy();
      Object.defineProperty(process, "stdin", descriptor);
    }
    expect(received).toEqual({
      ...body,
      id: expect.stringMatching(/^[a-f0-9-]{36}$/u),
    });
    expectNoSecrets();
  });

  it.each(["update", "delete"])(
    "requires expectedRevision on %s",
    async (operation) => {
      await expect(
        invoke(operation, id, "--input", input({ name: "SECRET_CANARY" })),
      ).rejects.toThrow("CLI exit");
      expect(printed()).toContain("Invalid configuration input");
      expectNoSecrets();
      expect(output).not.toHaveBeenCalled();
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

  it.each([400, 401, 403, 404, 409, 500, 503])(
    "does not reflect HTTP %s errors",
    async (status) => {
      server.use(
        http.post("http://localhost:3000/api/vnc/credentials", () => {
          return HttpResponse.json(
            {
              error: {
                code: "SECRET_CANARY",
                message: JSON.stringify(injectedSecrets),
              },
            },
            { status },
          );
        }),
      );
      await expect(
        invoke(
          "create",
          "--input",
          input({
            name: metadata.name,
            authentication: authenticationProfiles[0],
          }),
          "--json",
        ),
      ).rejects.toThrow("CLI exit");
      expect(output).not.toHaveBeenCalled();
      expect(printed()).toContain(`HTTP ${status}`);
      expectNoSecrets();
    },
  );

  it.each([
    "SECRET_CANARY",
    JSON.stringify({ authentication: injectedSecrets }),
    JSON.stringify({ expectedRevision: 0, authentication: injectedSecrets }),
  ])("never echoes invalid JSON/contract input", async (value) => {
    const path = join(dir, "invalid.json");
    writeFileSync(path, value);
    await expect(invoke("update", id, "--input", path)).rejects.toThrow(
      "CLI exit",
    );
    expectNoSecrets();
    expect(output).not.toHaveBeenCalled();
  });

  it.each(["list", "create"])(
    "does not use vnc capabilities to authorize %s",
    async (operation) => {
      vi.stubEnv("OKOU_TOKEN", token(["vnc:read", "vnc:write"]));
      await expect(
        invoke(
          operation,
          ...(operation === "create"
            ? [
                "--input",
                input({
                  name: metadata.name,
                  authentication: authenticationProfiles[0],
                }),
              ]
            : []),
        ),
      ).rejects.toThrow("CLI exit");
      expect(printed()).toContain(
        operation === "list" ? "connector:read" : "connector:write",
      );
      expect(output).not.toHaveBeenCalled();
    },
  );

  it("requires authentication before reading credential metadata", async () => {
    vi.stubEnv("OKOU_TOKEN", undefined);
    await expect(invoke("list", "--json")).rejects.toThrow("CLI exit");
    expect(printed()).toContain("OKOU_TOKEN");
    expect(output).not.toHaveBeenCalled();
  });

  it("delegates personal-token credential reads and writes to backend authorization", async () => {
    vi.stubEnv("OKOU_TOKEN", "personal-token");
    server.use(
      http.get("http://localhost:3000/api/vnc/credentials", ({ request }) => {
        expect(request.headers.get("authorization")).toBe(
          "Bearer personal-token",
        );
        return HttpResponse.json({ credentials: [metadata] });
      }),
      http.post(
        "http://localhost:3000/api/vnc/credentials",
        async ({ request }) => {
          expect(request.headers.get("authorization")).toBe(
            "Bearer personal-token",
          );
          expect(await request.json()).toMatchObject({
            name: metadata.name,
            authentication: authenticationProfiles[0],
          });
          return HttpResponse.json(metadata, { status: 201 });
        },
      ),
    );
    await invoke("list", "--json");
    expect(printed()).toContain(metadata.name);
    await invoke(
      "create",
      "--input",
      input({
        name: metadata.name,
        authentication: authenticationProfiles[0],
      }),
      "--json",
    );
    expectNoSecrets();
  });

  it("rejects an invalid resource UUID without reflecting it", async () => {
    await expect(invoke("show", "USERNAME_CANARY", "--json")).rejects.toThrow(
      "CLI exit",
    );
    expect(printed()).toContain("exact UUID");
    expectNoSecrets();
    expect(output).not.toHaveBeenCalled();
  });

  it("reports unavailable exact IDs instead of choosing another credential", async () => {
    server.use(
      http.get("http://localhost:3000/api/vnc/credentials", () => {
        return HttpResponse.json({ credentials: [] });
      }),
    );
    await expect(invoke("show", id, "--json")).rejects.toThrow("CLI exit");
    expect(printed()).toContain("VNC credential unavailable");
    expect(output).not.toHaveBeenCalled();
  });

  it("does not echo malformed successful response bodies", async () => {
    server.use(
      http.get("http://localhost:3000/api/vnc/credentials", () => {
        return new HttpResponse("SECRET_CANARY", {
          headers: { "content-type": "application/json" },
        });
      }),
    );
    await expect(invoke("list", "--json")).rejects.toThrow("CLI exit");
    expectNoSecrets();
  });
});
