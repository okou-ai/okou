import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { http, HttpResponse } from "msw";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { server } from "../../../mocks/server";
import { createVncHostCommand } from "../host";

const host = {
  id: "a0000000-0000-4000-8000-000000000001",
  displayName: "Shared desktop",
  host: "vnc.example.com",
  port: 5900,
  authMethod: "vnc_password",
  securityType: "x509_vnc",
  availability: { status: "ready" },
};
const plainHost = {
  ...host,
  id: "a0000000-0000-4000-8000-000000000002",
  displayName: "Plain desktop",
  authMethod: "username_password",
  securityType: "x509_plain",
};
const output = vi.spyOn(console, "log").mockImplementation(() => {});
const errors = vi.spyOn(console, "error").mockImplementation(() => {});
vi.spyOn(process, "exit").mockImplementation((): never => {
  throw new Error("CLI exit");
});

function runToken(capabilities: readonly string[] = ["vnc:read"]): string {
  const payload = {
    scope: "okou",
    capabilities,
    userId: "vnc-owner",
    orgId: "vnc-org",
    runId: host.id,
  };
  return `vm0_sandbox_e30.${Buffer.from(JSON.stringify(payload)).toString("base64url")}.signature`;
}

async function invoke(...args: string[]) {
  await createVncHostCommand().parseAsync(["list", ...args], {
    from: "user",
  });
}

beforeEach(() => {
  vi.stubEnv("OKOU_TOKEN", runToken());
  vi.stubEnv("OKOU_API_BACKEND_URL", "http://localhost:3000");
});

afterEach(() => {
  process.exitCode = 0;
  output.mockClear();
  errors.mockClear();
  vi.unstubAllEnvs();
});

describe("okou vnc host list", () => {
  it("prints current host metadata through the canonical authenticated API", async () => {
    let authorization: string | null = null;
    server.use(
      http.get("http://localhost:3000/api/vnc/hosts", ({ request }) => {
        authorization = request.headers.get("authorization");
        return HttpResponse.json({ hosts: [host] });
      }),
    );

    await invoke("--json");

    expect(authorization).toBe(`Bearer ${runToken()}`);
    expect(output).toHaveBeenCalledTimes(1);
    expect(JSON.parse(String(output.mock.calls[0]?.[0]))).toStrictEqual({
      hosts: [host],
    });
    expect(errors).not.toHaveBeenCalled();
  });

  it("prints host identity and the explicit session-mode next step", async () => {
    server.use(
      http.get("http://localhost:3000/api/vnc/hosts", () => {
        return HttpResponse.json({ hosts: [host] });
      }),
    );

    await invoke();

    const text = output.mock.calls.flat().join("\n");
    expect(text).toContain(host.id);
    expect(text).toContain("Shared desktop");
    expect(text).toContain("vnc.example.com:5900");
    expect(text).toContain("vnc_password / x509_vnc");
    expect(text).toContain("ready to attempt (connectivity not checked)");
    expect(text).toContain("availability.status=ready");
    expect(text).toContain("okou vnc session start --help");
    expect(text).toContain("choose shared or exclusive mode explicitly");
  });

  it("prints the exact X509Plain authentication and security pair", async () => {
    server.use(
      http.get("http://localhost:3000/api/vnc/hosts", () => {
        return HttpResponse.json({ hosts: [plainHost] });
      }),
    );

    await invoke();

    const text = output.mock.calls.flat().join("\n");
    expect(text).toContain("Plain desktop");
    expect(text).toContain("username_password / x509_plain");
  });

  it("shows a blocked SSH-backed VNC host for diagnosis without suggesting it for use", async () => {
    const blocked = {
      ...host,
      id: "a0000000-0000-4000-8000-000000000003",
      displayName: "Blocked desktop",
      availability: { status: "blocked", reason: "needs_rebind" },
    };
    server.use(
      http.get("http://localhost:3000/api/vnc/hosts", () => {
        return HttpResponse.json({ hosts: [host, blocked] });
      }),
    );
    await invoke("--json");
    expect(output).toHaveBeenCalledTimes(1);
    expect(JSON.parse(String(output.mock.calls[0]?.[0]))).toStrictEqual({
      hosts: [host, blocked],
    });
    output.mockClear();
    await invoke();
    const text = output.mock.calls.flat().join("\n");
    expect(text).toContain(blocked.id);
    expect(text).toContain("blocked: needs_rebind");
    expect(text).toContain("rebind the underlying SSH host");
    expect(text).toContain("explicitly choose Direct");
  });

  it("explains an authorized empty inventory without inventing a host", async () => {
    server.use(
      http.get("http://localhost:3000/api/vnc/hosts", () => {
        return HttpResponse.json({ hosts: [] });
      }),
    );

    await invoke();

    expect(output).toHaveBeenCalledExactlyOnceWith(
      "No VNC hosts available to this Run. Ask the owner to check host setup and chat access in Connectors.",
    );
  });

  it("surfaces unavailable authority instead of reporting an empty inventory", async () => {
    server.use(
      http.get("http://localhost:3000/api/vnc/hosts", () => {
        return HttpResponse.json(
          {
            error: {
              code: "VNC_UNAVAILABLE",
              message: "VNC access is not available",
            },
          },
          { status: 404 },
        );
      }),
    );

    await expect(invoke()).rejects.toThrow("CLI exit");

    expect(output).not.toHaveBeenCalled();
    expect(errors.mock.calls.flat().join("\n")).toContain(
      "Cannot list VNC hosts (HTTP 404)",
    );
  });

  it.each([
    [401, "permission_denied"],
    [403, "permission_denied"],
    [404, "unavailable"],
    [500, "authority_failure"],
    [503, "authority_failure"],
  ] as const)("reports HTTP %s as safe JSON %s", async (status, reason) => {
    server.use(
      http.get("http://localhost:3000/api/vnc/hosts", () => {
        return HttpResponse.json(
          {
            error: {
              code: "UPSTREAM_SECRET_CANARY",
              message: "Sensitive upstream detail must not reach JSON",
            },
          },
          { status },
        );
      }),
    );

    await invoke("--json");

    expect(output).toHaveBeenCalledTimes(1);
    expect(JSON.parse(String(output.mock.calls[0]?.[0]))).toStrictEqual({
      outcome: "failed",
      reason,
      delivery: "not_dispatched",
    });
    expect(errors).not.toHaveBeenCalled();
    expect(process.exitCode).toBe(1);
  });

  it.each([
    [
      "network failure",
      () => {
        return HttpResponse.error();
      },
    ],
    [
      "invalid JSON",
      () => {
        return new HttpResponse("SENSITIVE_UPSTREAM_DETAIL", {
          headers: { "content-type": "application/json" },
        });
      },
    ],
    [
      "invalid inventory",
      () => {
        return HttpResponse.json({ hosts: "SENSITIVE_UPSTREAM_DETAIL" });
      },
    ],
    [
      "cross-paired inventory",
      () => {
        return HttpResponse.json({
          hosts: [{ ...host, authMethod: "username_password" }],
        });
      },
    ],
    [
      "missing availability",
      () => {
        return HttpResponse.json({
          hosts: [{ ...host, availability: undefined }],
        });
      },
    ],
    [
      "unknown blocked reason",
      () => {
        return HttpResponse.json({
          hosts: [
            {
              ...host,
              availability: { status: "blocked", reason: "unknown" },
            },
          ],
        });
      },
    ],
  ] as const)(
    "reports %s as a safe structured failure",
    async (_, response) => {
      let requests = 0;
      server.use(
        http.get("http://localhost:3000/api/vnc/hosts", () => {
          requests++;
          return response();
        }),
      );

      await invoke("--json");

      expect(requests).toBe(1);
      expect(output).toHaveBeenCalledExactlyOnceWith(
        JSON.stringify({
          outcome: "failed",
          reason: "authority_failure",
          delivery: "not_dispatched",
        }),
      );
      expect(errors).not.toHaveBeenCalled();
      expect(process.exitCode).toBe(1);
    },
  );

  it.each([
    undefined,
    "personal-token",
    runToken(["vnc:write"]),
    runToken(["ssh:read", "ssh:write"]),
  ])(
    "rejects missing VNC read permission before inventory (%s)",
    async (token) => {
      vi.stubEnv("OKOU_TOKEN", token);
      let requests = 0;
      server.use(
        http.get("http://localhost:3000/api/vnc/hosts", () => {
          requests++;
          return HttpResponse.json({ hosts: [host] });
        }),
      );

      await invoke("--json");

      expect(requests).toBe(0);
      expect(output).toHaveBeenCalledTimes(1);
      expect(JSON.parse(String(output.mock.calls[0]?.[0]))).toStrictEqual({
        outcome: "failed",
        reason: "permission_denied",
        delivery: "not_dispatched",
      });
      expect(process.exitCode).toBe(1);
    },
  );
});

const configuredHost = {
  id: host.id,
  displayName: host.displayName,
  host: host.host,
  port: host.port,
  credentialId: "a0000000-0000-4000-8000-000000000002",
  credentialName: "Login",
  security: { type: "x509_plain" },
  generation: 7,
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-02T00:00:00.000Z",
};
const secrets = {
  username: "USERNAME_CANARY",
  password: "SECRET_CANARY",
  privateKey: "KEY_CANARY",
  certificateChain: "CERTIFICATE_CANARY",
  ticketCache: "TICKET_CANARY",
  keytab: "KEYTAB_CANARY",
};
const authenticationMethods: Readonly<Record<string, string>> = {
  x509_plain: "username_password",
  qemu_x509_sasl: "qemu_scram_sha256",
  apple_dh: "apple_dh_username_password",
  apple_srp: "apple_srp_username_password",
  apple_rsa_srp: "apple_rsa_srp_username_password",
};
const securityProfiles = [
  ...["x509_none", "x509_vnc", "x509_plain", "qemu_x509_sasl"].map((type) => {
    return {
      type,
      trust: { mode: "custom_ca", caBundle: "PEM_CANARY" },
      serverName: host.host,
    };
  }),
  ...[
    "rsa_aes_ra2",
    "rsa_aes_ra2_256",
    "rsa_aes_ra2ne",
    "rsa_aes_ra2ne_256",
  ].map((type) => {
    return { type, serverKeySha256: "a".repeat(64) };
  }),
  ...["apple_vnc_password", "apple_dh", "apple_srp", "apple_rsa_srp"].map(
    (type) => {
      return { type };
    },
  ),
  {
    type: "qemu_x509_gssapi",
    trust: { mode: "system" },
    service: { realm: "EXAMPLE.COM", components: ["vnc", host.host] },
  },
];

describe("okou vnc host configuration management", () => {
  let directory: string;
  function input(value: unknown) {
    const path = join(directory, "input.json");
    writeFileSync(path, JSON.stringify(value));
    return path;
  }
  async function manage(...args: string[]) {
    await createVncHostCommand().parseAsync(args, { from: "user" });
  }
  function text() {
    return [...output.mock.calls, ...errors.mock.calls].flat().join("\n");
  }
  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), "okou-vnc-host-"));
    vi.stubEnv("OKOU_TOKEN", runToken(["connector:read", "connector:write"]));
  });
  afterEach(() => {
    rmSync(directory, { recursive: true, force: true });
  });

  it("allows personal-token configured-host inspection without granting execution access", async () => {
    vi.stubEnv("OKOU_TOKEN", "personal-token");
    server.use(
      http.get("http://localhost:3000/api/vnc/connections", ({ request }) => {
        expect(request.headers.get("authorization")).toBe(
          "Bearer personal-token",
        );
        return HttpResponse.json({ connections: [configuredHost] });
      }),
    );
    await manage("list", "--scope", "configured", "--json");
    expect(JSON.parse(String(output.mock.calls[0]?.[0]))).toStrictEqual({
      connections: [configuredHost],
    });
    output.mockClear();
    await manage("list", "--scope", "authorized", "--json");
    expect(JSON.parse(String(output.mock.calls[0]?.[0]))).toStrictEqual({
      outcome: "failed",
      reason: "permission_denied",
      delivery: "not_dispatched",
    });
    expect(process.exitCode).toBe(1);
    expect(errors).not.toHaveBeenCalled();
  });

  it.each([false, true])(
    "lists and shows only safe configured metadata (json=%s)",
    async (json) => {
      server.use(
        http.get("http://localhost:3000/api/vnc/connections", () => {
          return HttpResponse.json({
            connections: [
              {
                ...configuredHost,
                ...secrets,
                security: {
                  type: "x509_plain",
                  trust: { mode: "custom_ca", caBundle: "PEM_CANARY" },
                  ...secrets,
                },
                transport: { type: "ssh", connectionId: host.id, ...secrets },
              },
            ],
            ...secrets,
          });
        }),
      );
      await manage(
        "list",
        "--scope",
        "configured",
        ...(json ? ["--json"] : []),
      );
      expect(JSON.parse(String(output.mock.calls[0]?.[0]))).toStrictEqual({
        connections: [
          {
            ...configuredHost,
            transport: { type: "ssh", connectionId: host.id },
          },
        ],
      });
      await manage("show", host.id, ...(json ? ["--json"] : []));
      expect(text()).toContain('"generation":');
      expect(text()).not.toContain("CANARY");
    },
  );

  it.each(securityProfiles)(
    "preserves $type profile and SSH binding in writes without echoing PEM or inline credentials",
    async (security) => {
      const transport = { type: "ssh", connectionId: host.id };
      const authentication =
        security.type === "x509_vnc" || security.type === "apple_vnc_password"
          ? { method: "vnc_password", password: "CANARY" }
          : security.type === "qemu_x509_gssapi"
            ? {
                method: "qemu_kerberos_password",
                initiator: {
                  realm: "EXAMPLE.COM",
                  components: ["USERNAME_CANARY"],
                },
                password: "SECRET_CANARY",
              }
            : {
                method:
                  authenticationMethods[security.type] ??
                  "rsa_aes_username_password",
                username: "USERNAME_CANARY",
                password: "SECRET_CANARY",
              };
      const credential =
        security.type === "x509_none"
          ? { type: "none" }
          : { create: { name: "Login", authentication } };
      let created: unknown;
      let updated: unknown;
      server.use(
        http.post(
          "http://localhost:3000/api/vnc/connections",
          async ({ request }) => {
            created = await request.json();
            return HttpResponse.json(
              {
                ...configuredHost,
                security: { ...security, ...secrets },
                transport: { ...transport, ...secrets },
                ...secrets,
              },
              { status: 201 },
            );
          },
        ),
        http.patch(
          `http://localhost:3000/api/vnc/connections/${host.id}`,
          async ({ request }) => {
            updated = await request.json();
            return HttpResponse.json({
              ...configuredHost,
              generation: 8,
              security: { ...security, ...secrets },
              transport,
            });
          },
        ),
      );
      const body = {
        displayName: host.displayName,
        host: host.host,
        security,
        credential,
        transport,
      };
      await manage("create", "--input", input(body), "--json");
      expect(created).toEqual({
        ...body,
        port: 5900,
        id: expect.stringMatching(/^[a-f0-9-]{36}$/u),
      });
      expect(JSON.parse(String(output.mock.calls[0]?.[0]))).toStrictEqual({
        ...configuredHost,
        security: { type: security.type },
        transport,
      });
      await manage(
        "update",
        host.id,
        "--input",
        input({ expectedGeneration: 7, security, credential, transport }),
      );
      expect(updated).toStrictEqual({
        expectedGeneration: 7,
        security,
        credential,
        transport,
      });
      expect(text()).not.toContain("CANARY");
    },
  );

  it("preserves explicit create UUID and direct transport, including credentialless X509None", async () => {
    let received: unknown;
    server.use(
      http.post(
        "http://localhost:3000/api/vnc/connections",
        async ({ request }) => {
          received = await request.json();
          return new HttpResponse(null, { status: 204 });
        },
      ),
    );
    const body = {
      id: host.id,
      displayName: host.displayName,
      host: host.host,
      port: 5901,
      credential: { type: "none" },
      security: { type: "x509_none", trust: { mode: "system" } },
      transport: { type: "direct" },
    };
    await manage("create", "--input", input(body), "--json");
    expect(received).toStrictEqual(body);
    expect(output).toHaveBeenCalledExactlyOnceWith(
      JSON.stringify({ id: host.id }),
    );
  });

  it("deletes with expectedGeneration without a new confirmation or self-grant", async () => {
    let body: unknown;
    server.use(
      http.delete(
        `http://localhost:3000/api/vnc/connections/${host.id}`,
        async ({ request }) => {
          body = await request.json();
          return new HttpResponse(null, { status: 204 });
        },
      ),
    );
    await manage(
      "delete",
      host.id,
      "--input",
      input({ expectedGeneration: 7 }),
      "--json",
    );
    expect(body).toStrictEqual({ expectedGeneration: 7 });
    expect(output).toHaveBeenCalledExactlyOnceWith(
      JSON.stringify({ id: host.id, deleted: true }),
    );
  });

  it.each(["update", "delete"])(
    "requires generation on %s before sending input",
    async (operation) => {
      await expect(
        manage(
          operation,
          host.id,
          "--input",
          input({ displayName: "SECRET_CANARY" }),
        ),
      ).rejects.toThrow("CLI exit");
      expect(text()).toContain("Invalid configuration input");
      expect(text()).not.toContain("CANARY");
      expect(output).not.toHaveBeenCalled();
    },
  );

  it.each([401, 403, 409, 500])(
    "never reflects HTTP %s response secrets",
    async (status) => {
      server.use(
        http.patch(
          `http://localhost:3000/api/vnc/connections/${host.id}`,
          () => {
            return HttpResponse.json(
              {
                error: {
                  code: "SECRET_CANARY",
                  message: JSON.stringify(secrets),
                },
              },
              { status },
            );
          },
        ),
      );
      await expect(
        manage(
          "update",
          host.id,
          "--input",
          input({ expectedGeneration: 7, displayName: "Desktop" }),
          "--json",
        ),
      ).rejects.toThrow("CLI exit");
      expect(text()).toContain(`HTTP ${status}`);
      expect(text()).not.toContain("CANARY");
      expect(output).not.toHaveBeenCalled();
    },
  );

  it("keeps connector management capabilities separate from VNC execution", async () => {
    vi.stubEnv("OKOU_TOKEN", runToken(["vnc:read", "vnc:write"]));
    await expect(
      manage("list", "--scope", "configured", "--json"),
    ).rejects.toThrow("CLI exit");
    expect(text()).toContain("connector:read");
    await expect(
      manage("delete", host.id, "--input", input({ expectedGeneration: 7 })),
    ).rejects.toThrow("CLI exit");
    expect(text()).toContain("connector:write");
    output.mockClear();
    vi.stubEnv("OKOU_TOKEN", runToken(["connector:read", "connector:write"]));
    await invoke("--json");
    expect(output).toHaveBeenCalledExactlyOnceWith(
      JSON.stringify({
        outcome: "failed",
        reason: "permission_denied",
        delivery: "not_dispatched",
      }),
    );
  });

  it("reports an unavailable exact owned host without selecting a fallback", async () => {
    server.use(
      http.get("http://localhost:3000/api/vnc/connections", () => {
        return HttpResponse.json({ connections: [] });
      }),
    );
    await expect(manage("show", host.id, "--json")).rejects.toThrow("CLI exit");
    expect(text()).toContain("VNC host unavailable");
    expect(output).not.toHaveBeenCalled();
  });
});
