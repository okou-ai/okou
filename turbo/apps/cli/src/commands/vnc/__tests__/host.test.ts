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
function inventory<T extends { id: string }>(hosts: T[]) {
  return {
    hosts,
    identities: hosts.map(({ id }) => {
      return { id, createdAt: "2026-09-01T00:00:00.123456Z", generation: 1 };
    }),
  };
}
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
        return HttpResponse.json(inventory([host]));
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
        return HttpResponse.json(inventory([host]));
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
        return HttpResponse.json(inventory([plainHost]));
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
        return HttpResponse.json(inventory([host, blocked]));
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
        return HttpResponse.json(inventory([]));
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
          identities: inventory([host]).identities,
          hosts: [{ ...host, authMethod: "username_password" }],
        });
      },
    ],
    [
      "missing availability",
      () => {
        return HttpResponse.json({
          identities: inventory([host]).identities,
          hosts: [{ ...host, availability: undefined }],
        });
      },
    ],
    [
      "unknown blocked reason",
      () => {
        return HttpResponse.json({
          identities: inventory([host]).identities,
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
          return HttpResponse.json(inventory([host]));
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

  it("allows personal-token configured-host inspection", async () => {
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
  });

  it("lists and shows only safe configured metadata", async () => {
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
    await manage("list", "--scope", "configured", "--json");
    expect(JSON.parse(String(output.mock.calls[0]?.[0]))).toStrictEqual({
      connections: [
        {
          ...configuredHost,
          security: { type: "x509_plain", trust: { mode: "custom_ca" } },
          transport: { type: "ssh", connectionId: host.id },
        },
      ],
    });
    await manage("show", host.id, "--json");
    expect(text()).toContain('"generation":');
    expect(text()).not.toContain("CANARY");
  });

  it("reads native RFB and independent KDC protection without printing nested credentials or CA contents", async () => {
    const route = {
      type: "cloudflare_access",
      configId: host.id,
      originTls: {
        serverName: "origin.example.com",
        trust: { mode: "custom_ca", caBundle: "ORIGIN_CA_CANARY" },
        ...secrets,
      },
      ...secrets,
      clientSecret: "PROVIDER_CANARY",
    };
    const kdc = {
      host: "kdc.tailnet",
      port: 88,
      transport: { type: "tailscale", configId: configuredHost.id, ...secrets },
      ticketLifetimeSeconds: 1200,
      renewableLifetimeSeconds: 7200,
      ...secrets,
    };
    server.use(
      http.get("http://localhost:3000/api/vnc/connections", () => {
        return HttpResponse.json({
          connections: [
            {
              ...configuredHost,
              transport: route,
              security: {
                type: "qemu_x509_gssapi",
                serverName: "rfb.example.com",
                service: {
                  realm: "EXAMPLE.COM",
                  components: ["vnc", "desktop"],
                  ...secrets,
                },
                trust: { mode: "custom_ca", caBundle: "INNER_CA_CANARY" },
                kdc,
                ...secrets,
              },
            },
          ],
        });
      }),
    );
    await manage("show", host.id, "--json");
    const result = JSON.parse(String(output.mock.calls[0]?.[0]));
    expect(result.transport).toEqual({
      type: "cloudflare_access",
      configId: host.id,
      originTls: {
        serverName: "origin.example.com",
        trust: { mode: "custom_ca" },
      },
    });
    expect(result.security).toEqual({
      type: "qemu_x509_gssapi",
      serverName: "rfb.example.com",
      service: { realm: "EXAMPLE.COM", components: ["vnc", "desktop"] },
      trust: { mode: "custom_ca" },
      kdc: {
        host: kdc.host,
        port: 88,
        transport: { type: "tailscale", configId: configuredHost.id },
        ticketLifetimeSeconds: 1200,
        renewableLifetimeSeconds: 7200,
      },
    });
    expect(text()).not.toContain("CANARY");
    expect(text()).not.toContain("clientSecret");
  });

  it("preserves the independent RSA server pin on a native route while stripping provider credentials", async () => {
    const serverKeySha256 = "ab".repeat(32);
    server.use(
      http.get("http://localhost:3000/api/vnc/connections", () => {
        return HttpResponse.json({
          connections: [
            {
              ...configuredHost,
              rsaAesAuthentication: "rsa_aes_password",
              security: { type: "rsa_aes_ra2", serverKeySha256, ...secrets },
              transport: {
                type: "tailscale",
                configId: host.id,
                ...secrets,
                clientSecret: "PROVIDER_CANARY",
              },
            },
          ],
        });
      }),
    );
    await manage("show", host.id, "--json");
    expect(JSON.parse(String(output.mock.calls[0]?.[0])).security).toEqual({
      type: "rsa_aes_ra2",
      serverKeySha256,
    });
    expect(text()).not.toContain("CANARY");
    expect(text()).not.toContain("clientSecret");
  });

  it("creates an SSH-backed host and rebinds saved credentials without echoing secrets", async () => {
    const security = {
      type: "x509_plain",
      trust: { mode: "custom_ca", caBundle: "PEM_CANARY" },
      serverName: host.host,
    };
    const transport = { type: "ssh", connectionId: host.id };
    const authentication = {
      method: "username_password",
      username: "USERNAME_CANARY",
      password: "SECRET_CANARY",
    };
    const credential = { create: { name: "Login", authentication } };
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
      security: {
        type: security.type,
        serverName: security.serverName,
        trust: { mode: security.trust.mode },
      },
      transport,
    });
    const update = {
      expectedGeneration: 7,
      security,
      credential: { id: configuredHost.credentialId },
      transport,
    };
    await manage("update", host.id, "--input", input(update));
    expect(updated).toStrictEqual(update);
    expect(text()).not.toContain("CANARY");
  });

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

  it.each(["cloudflare_access", "tailscale"] as const)(
    "publishes independent native %s RFB and KDC JSON through the current owner contract",
    async (type) => {
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
      const transport = { type, configId: host.id };
      const body = {
        id: host.id,
        displayName: "Native desktop",
        host: "desktop.example.com",
        port: type === "cloudflare_access" ? 443 : 5900,
        credential: { id: configuredHost.credentialId },
        transport,
        security: {
          type: "qemu_x509_gssapi",
          serverName: "inner.example.com",
          trust: { mode: "system" },
          service: {
            realm: "EXAMPLE.COM",
            components: ["vnc", "inner.example.com"],
          },
          kdc: {
            host: "kdc.example.com",
            port: type === "cloudflare_access" ? 443 : 88,
            transport,
            ticketLifetimeSeconds: 1200,
            renewableLifetimeSeconds: 7200,
          },
        },
      };
      await manage("create", "--input", input(body), "--json");
      expect(received).toStrictEqual(body);
      expect(text()).not.toContain("CANARY");
    },
  );

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
});
