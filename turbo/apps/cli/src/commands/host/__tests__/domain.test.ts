import { randomUUID } from "node:crypto";
import chalk from "chalk";
import { http, HttpResponse } from "msw";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { hostContract } from "@okouai/api-contracts/contracts/host";
import type {
  hostedDomainSchema,
  hostedDomainSettingsSchema,
} from "@okouai/api-contracts/contracts/hosted-site-domains";
import type { infer as zInfer } from "zod";
import { server } from "../../../mocks/server";
import { createHostCommand } from "../index";

const base = "http://localhost:3000/api";
const siteId = "00000000-0000-4000-8000-000000000001";
const deploymentId = "00000000-0000-4000-8000-000000000002";
const domainId = "00000000-0000-4000-8000-000000000003";
const hostname = "www.example.com";
const defaultUrl = "https://demo-site.okou.app";
type Domain = zInfer<typeof hostedDomainSchema>;
type Settings = zInfer<typeof hostedDomainSettingsSchema>;

function dnsRecords(name = hostname): Domain["records"] {
  return [
    { type: "TXT", name: `_okou-challenge.${name}`, value: "ownership-proof" },
    { type: "CNAME", name, value: "connect.example.net" },
  ];
}

function domainFixture(ready: boolean, name = hostname): Domain {
  return {
    id: domainId,
    hostname: name,
    revision: randomUUID(),
    ready,
    removing: false,
    records: dnsRecords(name),
    verification: ready ? verification(true) : null,
  };
}

function verification(ready: boolean): NonNullable<Domain["verification"]> {
  const passed = { status: "passed" as const, message: "Verified" };
  return {
    status: ready ? "ready" : "incomplete",
    eligibleForSelection: ready,
    checkedAt: "2026-11-25T00:00:00Z",
    validationRecords: ready
      ? []
      : [
          {
            type: "TXT",
            name: `_acme-challenge.${hostname}`,
            value: "certificate-proof",
          },
        ],
    checks: {
      ownership: passed,
      dns: passed,
      provider: passed,
      certificate: ready
        ? passed
        : {
            status: "pending",
            message: "Configure the certificate TXT record",
          },
      route: ready
        ? passed
        : { status: "not_checked", message: "HTTPS pending" },
    },
  };
}

describe("okou host domain", () => {
  const logs = vi.spyOn(console, "log").mockImplementation(() => {});
  const errors = vi.spyOn(console, "error").mockImplementation(() => {});
  vi.spyOn(process, "exit").mockImplementation(() => {
    throw new Error("process.exit called");
  });

  beforeEach(() => {
    chalk.level = 0;
    vi.stubEnv("OKOU_API_BACKEND_URL", "http://localhost:3000");
    vi.stubEnv("OKOU_TOKEN", "test-token");
  });

  afterEach(() => {
    logs.mockClear();
    errors.mockClear();
    vi.unstubAllEnvs();
  });

  function mockApi(
    options: {
      enabled?: boolean;
      allowed?: boolean;
      domain?: Domain;
      selected?: boolean;
      conflict?: "verify" | "select" | "remove";
      cleanupPending?: boolean;
    } = {},
  ) {
    const calls: string[] = [];
    let ready = false;
    let settings: Settings = {
      siteId,
      defaultUrl,
      effectiveUrl:
        options.selected && options.allowed !== false
          ? `https://${hostname}`
          : defaultUrl,
      selectedDomainId: options.selected ? domainId : null,
      revision: randomUUID(),
      allowed: options.allowed ?? true,
      domains: options.domain ? [options.domain] : [],
    };
    function conflict(operation: string) {
      return options.conflict === operation
        ? HttpResponse.json(
            {
              error: {
                code: "REVISION_CONFLICT",
                message: "The domain changed. Reload and try again.",
              },
            },
            { status: 409 },
          )
        : null;
    }
    server.use(
      http.get(`${base}/feature-switches`, ({ request }) => {
        calls.push("availability");
        expect(request.headers.get("authorization")).toBe("Bearer test-token");
        return HttpResponse.json({
          switches: {},
          effectiveSwitches: {
            hostedSiteCustomDomains: options.enabled ?? true,
          },
        });
      }),
      http.get(`${base}/host/aliases/demo-site`, ({ request }) => {
        calls.push("resolve");
        expect(new URL(request.url).searchParams.get("publicBrand")).toBe(
          "okou",
        );
        return HttpResponse.json({
          pointer: {
            version: 1,
            publicBrand: "okou",
            publicSlug: "demo-site",
            siteId,
            deploymentId,
            prefix: `sites/brands/okou/publications/${deploymentId}`,
            manifestKey: `sites/brands/okou/publications/${deploymentId}/manifest.json`,
            spaFallback: false,
            updatedAt: "2026-11-25T00:00:00Z",
          },
        });
      }),
      http.get(`${base}/host/sites/${siteId}/domains`, ({ request }) => {
        calls.push("list");
        expect(request.headers.get("authorization")).toBe("Bearer test-token");
        return HttpResponse.json(settings);
      }),
      http.post(`${base}/host/sites/${siteId}/domains`, async ({ request }) => {
        calls.push("add");
        const body = hostContract.addSiteDomain.body.parse(
          await request.json(),
        );
        settings = {
          ...settings,
          domains: [domainFixture(false, body.hostname)],
          revision: randomUUID(),
        };
        return HttpResponse.json(settings);
      }),
      http.post(
        `${base}/host/sites/${siteId}/domains/${domainId}/verify`,
        async ({ request }) => {
          calls.push("verify");
          const domain = settings.domains[0]!;
          expect(
            hostContract.verifySiteDomain.body.parse(await request.json())
              .expectedRevision,
          ).toBe(domain.revision);
          const failure = conflict("verify");
          if (failure) return failure;
          const checked = verification(ready);
          settings = {
            ...settings,
            domains: [
              {
                ...domain,
                ready,
                verification: checked,
                revision: randomUUID(),
                records: [
                  ...dnsRecords(domain.hostname),
                  ...checked.validationRecords,
                ],
              },
            ],
          };
          return HttpResponse.json(settings);
        },
      ),
      http.patch(
        `${base}/host/sites/${siteId}/domain-selection`,
        async ({ request }) => {
          calls.push("select");
          const body = hostContract.selectSiteDomain.body.parse(
            await request.json(),
          );
          expect(body.expectedRevision).toBe(settings.revision);
          expect(body.expectedPublicSlug).toBe("demo-site");
          const failure = conflict("select");
          if (failure) return failure;
          settings = {
            ...settings,
            selectedDomainId: body.domainId,
            effectiveUrl: body.domainId
              ? `https://${settings.domains[0]!.hostname}`
              : defaultUrl,
            revision: randomUUID(),
          };
          return HttpResponse.json(settings);
        },
      ),
      http.delete(
        `${base}/host/sites/${siteId}/domains/${domainId}`,
        async ({ request }) => {
          calls.push("remove");
          expect(
            hostContract.removeSiteDomain.body.parse(await request.json())
              .expectedRevision,
          ).toBe(settings.domains[0]!.revision);
          const failure = conflict("remove");
          if (failure) return failure;
          if (options.cleanupPending && !settings.domains[0]!.removing) {
            settings = {
              ...settings,
              selectedDomainId: null,
              effectiveUrl: defaultUrl,
              revision: randomUUID(),
              domains: [
                {
                  ...settings.domains[0]!,
                  ready: false,
                  removing: true,
                  revision: randomUUID(),
                },
              ],
            };
            return HttpResponse.json(
              {
                error: {
                  code: "DOMAIN_CLEANUP_PENDING",
                  message:
                    "The domain is disconnected. Click Remove again to finish provider cleanup.",
                },
              },
              { status: 503 },
            );
          }
          settings = {
            ...settings,
            selectedDomainId: null,
            effectiveUrl: defaultUrl,
            domains: [],
            revision: randomUUID(),
          };
          return HttpResponse.json(settings);
        },
      ),
    );
    return {
      calls,
      ready() {
        ready = true;
      },
      settings() {
        return settings;
      },
    };
  }

  async function run(...args: string[]) {
    await createHostCommand().parseAsync(["node", "okou", "domain", ...args]);
  }

  function jsonOutput(): Settings & { publicSlug: string } {
    return JSON.parse(logs.mock.calls.at(-1)![0] as string);
  }

  it("documents the complete manual DNS/HTTPS flow without authentication", async () => {
    vi.stubEnv("OKOU_TOKEN", "");
    let help = "";
    const command = createHostCommand();
    const domain = command.commands.find((child) => {
      return child.name() === "domain";
    });
    if (!domain) throw new Error("Expected the registered domain command");
    domain.exitOverride().configureOutput({
      writeOut(text) {
        help += text;
      },
    });
    await expect(
      command.parseAsync(["node", "okou", "domain", "-h"]),
    ).rejects.toMatchObject({ code: "commander.helpDisplayed" });
    expect(help).toContain("domain add my-report www.example.com");
    expect(help).toContain("additional certificate TXT records");
    expect(help).toContain("no automatic polling");
    expect(help).toContain("domain select my-report www.example.com");
    expect(help).toContain("--default keeps connected domains active");
    expect(help).toContain("same custom-domain feature switch as the App");
    expect(help).toContain("active paid subscription");
  });

  it("adds a claim and prints the exact DNS records and next command", async () => {
    mockApi();
    await run("add", "demo-site", hostname);
    const output = logs.mock.calls.flat().join("\n");
    expect(output).toContain(
      `TXT\t_okou-challenge.${hostname}\townership-proof`,
    );
    expect(output).toContain(`CNAME\t${hostname}\tconnect.example.net`);
    expect(output).toContain(`okou host domain verify demo-site ${hostname}`);
    expect(output).toContain(defaultUrl);
  });

  it("completes add, explicit verification, selection, and removal through the saved API state", async () => {
    const api = mockApi();
    await run("add", "demo-site", hostname, "--json");
    expect(jsonOutput().domains[0]).toMatchObject({ hostname, ready: false });
    await expect(
      run("verify", "demo-site", hostname, "--json"),
    ).rejects.toThrow("process.exit called");
    expect(jsonOutput().domains[0]!.verification).toMatchObject({
      status: "incomplete",
      checks: { certificate: { status: "pending" } },
    });
    expect(jsonOutput().domains[0]!.records).toContainEqual({
      type: "TXT",
      name: `_acme-challenge.${hostname}`,
      value: "certificate-proof",
    });
    expect(
      api.calls.filter((call) => {
        return call === "verify";
      }),
    ).toHaveLength(1);
    expect(api.calls).not.toContain("select");
    api.ready();
    await run("verify", "demo-site", hostname, "--json");
    expect(jsonOutput().domains[0]!.verification).toMatchObject({
      status: "ready",
      eligibleForSelection: true,
    });
    await run("select", "demo-site", hostname, "--json");
    expect(jsonOutput()).toMatchObject({
      effectiveUrl: `https://${hostname}`,
      selectedDomainId: domainId,
    });
    await run("remove", "demo-site", hostname, "--json");
    expect(jsonOutput()).toMatchObject({
      domains: [],
      selectedDomainId: null,
      effectiveUrl: defaultUrl,
    });
    expect(api.settings().domains).toEqual([]);
  });

  it.each([
    ["list", "demo-site"],
    ["add", "demo-site", hostname],
    ["verify", "demo-site", hostname],
    ["select", "demo-site", hostname],
    ["select", "demo-site", "--default"],
    ["remove", "demo-site", hostname],
  ])(
    "gates %s before reading or changing site settings when disabled",
    async (...args) => {
      const api = mockApi({ enabled: false });
      await expect(run(...args)).rejects.toThrow("process.exit called");
      expect(api.calls).toEqual(["availability"]);
      expect(errors.mock.calls.flat().join("\n")).toContain("not enabled");
      expect(logs.mock.calls).toHaveLength(0);
    },
  );

  it.each(["add", "verify", "select"])(
    "requires a paid subscription for %s",
    async (operation) => {
      const api = mockApi({ allowed: false, domain: domainFixture(true) });
      await expect(run(operation, "demo-site", hostname)).rejects.toThrow(
        "process.exit called",
      );
      expect(api.calls).toEqual(["availability", "resolve", "list"]);
      expect(errors.mock.calls.flat().join("\n")).toContain(
        "active paid Okou subscription",
      );
    },
  );

  it("keeps inspection, restoring the platform URL, and removal available after a subscription expires", async () => {
    const api = mockApi({
      allowed: false,
      domain: domainFixture(true),
      selected: true,
    });
    await run("list", "demo-site", "--json");
    expect(jsonOutput().allowed).toBe(false);
    await run("select", "demo-site", "--default", "--json");
    expect(jsonOutput()).toMatchObject({
      effectiveUrl: defaultUrl,
      selectedDomainId: null,
    });
    expect(jsonOutput().domains).toHaveLength(1);
    await run("remove", "demo-site", hostname, "--json");
    expect(jsonOutput().domains).toEqual([]);
    expect(
      api.calls.filter((call) => {
        return call === "remove";
      }),
    ).toHaveLength(1);
  });

  it("refuses selection of an unverified hostname without sending a save request", async () => {
    const api = mockApi({ domain: domainFixture(false) });
    await expect(run("select", "demo-site", hostname)).rejects.toThrow(
      "process.exit called",
    );
    expect(api.calls).not.toContain("select");
    expect(errors.mock.calls.flat().join("\n")).toContain(
      "Domain is not ready",
    );
    expect(logs.mock.calls).toHaveLength(0);
  });

  it.each(["verify", "select", "remove"] as const)(
    "reports a %s revision conflict without replaying the mutation",
    async (operation) => {
      const api = mockApi({ domain: domainFixture(true), conflict: operation });
      await expect(
        run(operation, "demo-site", hostname, "--json"),
      ).rejects.toThrow("process.exit called");
      expect(errors.mock.calls.flat().join("\n")).toContain(
        "The domain changed",
      );
      expect(
        api.calls.filter((call) => {
          return call === operation;
        }),
      ).toHaveLength(1);
      expect(logs.mock.calls).toHaveLength(0);
    },
  );

  it("matches an international hostname exactly and supports the inherited JSON option", async () => {
    mockApi({ domain: domainFixture(true, "xn--bcher-kva.example") });
    await createHostCommand().parseAsync([
      "node",
      "okou",
      "--json",
      "domain",
      "select",
      "demo-site",
      "BÜCHER.example.",
    ]);
    expect(logs.mock.calls).toHaveLength(1);
    expect(jsonOutput()).toMatchObject({
      selectedDomainId: domainId,
      effectiveUrl: "https://xn--bcher-kva.example",
    });
  });

  it("does not substitute another configured domain for a missing hostname", async () => {
    const api = mockApi({ domain: domainFixture(true) });
    await expect(
      run("remove", "demo-site", "other.example.com"),
    ).rejects.toThrow("process.exit called");
    expect(api.calls).not.toContain("remove");
    expect(errors.mock.calls.flat().join("\n")).toContain(
      "not configured for this website",
    );
  });

  it("resumes pending provider cleanup only after an explicit new removal", async () => {
    const api = mockApi({
      allowed: false,
      domain: domainFixture(true),
      selected: true,
      cleanupPending: true,
    });
    await expect(
      run("remove", "demo-site", hostname, "--json"),
    ).rejects.toThrow("process.exit called");
    expect(logs.mock.calls).toHaveLength(0);
    expect(errors.mock.calls.flat().join("\n")).toContain(
      "finish provider cleanup",
    );
    expect(
      api.calls.filter((call) => {
        return call === "remove";
      }),
    ).toHaveLength(1);
    await run("list", "demo-site", "--json");
    expect(jsonOutput()).toMatchObject({
      selectedDomainId: null,
      domains: [{ hostname, ready: false, removing: true }],
    });
    await run("remove", "demo-site", hostname, "--json");
    expect(jsonOutput().domains).toEqual([]);
    expect(
      api.calls.filter((call) => {
        return call === "remove";
      }),
    ).toHaveLength(2);
  });

  it("rejects a wildcard before sending any API request", async () => {
    const api = mockApi();
    await expect(run("add", "demo-site", "*.example.com")).rejects.toThrow(
      "process.exit called",
    );
    expect(api.calls).toEqual([]);
    expect(errors.mock.calls.flat().join("\n")).toContain(
      "without a URL scheme, path, port, or wildcard",
    );
  });
});
