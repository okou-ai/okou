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
      "VNC access is not available",
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
