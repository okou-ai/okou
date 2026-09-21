import { describe, expect, expectTypeOf, it } from "vitest";
import {
  canonicalizeFirewallBaseUrlVarsForExecution,
  expandHostWildcardsInBaseUrl,
  firewallBaseUrlTemplateNeedsHostPolicy,
  validateBaseUrl,
  hasBaseUrlParams,
  hasBaseUrlVars,
  resolveFirewallBaseUrlTemplate,
  resolveFirewallBaseUrlVars,
  UNKNOWN_PERMISSION_GRANT,
} from "../firewall-types";
import {
  collectAndValidatePermissions,
  validateRule,
} from "../firewall-expander";
import type { FirewallConfig, PermissionNamesOf } from "../firewall-types";

describe("firewall expander helpers", () => {
  it("PermissionNamesOf ignores api entries without permissions", () => {
    const config = {
      name: "mixed",
      apis: [
        {
          base: "https://api.example.com",
          auth: { headers: {} },
          permissions: [
            { name: "read", rules: ["GET /files"] },
            { name: "write", rules: ["POST /files"] },
          ],
        },
        {
          base: "https://uploads.example.com",
          auth: { headers: {} },
        },
      ],
    } as const satisfies FirewallConfig;

    expectTypeOf<PermissionNamesOf<typeof config>>().toEqualTypeOf<
      "read" | "write"
    >();
  });

  it("collectAndValidatePermissions accepts mixed empty and non-empty apis", () => {
    // Pins the per-api continue boundary: one api with empty permissions
    // (auth-only injection + unknownPolicy fallback) alongside one with
    // real permissions should both validate and only the latter's names
    // should appear in the returned set.
    const config: FirewallConfig = {
      name: "mixed",
      apis: [
        {
          base: "https://api.example.com",
          auth: { headers: {} },
          permissions: [],
        },
        {
          base: "https://uploads.example.com",
          auth: { headers: {} },
          permissions: [
            { name: "upload", rules: ["POST /files"] },
            { name: "read", rules: ["GET /files/{id}"] },
          ],
        },
      ],
    };
    const names = collectAndValidatePermissions(config);
    expect([...names].sort()).toEqual(["read", "upload"]);
  });

  it.each(["all", UNKNOWN_PERMISSION_GRANT])(
    'collectAndValidatePermissions rejects reserved permission name "%s"',
    (name) => {
      const config: FirewallConfig = {
        name: "reserved-permission",
        apis: [
          {
            base: "https://api.example.com",
            auth: { headers: {} },
            permissions: [{ name, rules: ["GET /items"] }],
          },
        ],
      };

      expect(() => {
        return collectAndValidatePermissions(config);
      }).toThrow(`permission named "${name}"`);
    },
  );

  it("collectAndValidatePermissions rejects unsafe firewall base paths", () => {
    const config: FirewallConfig = {
      name: "unsafe-base",
      apis: [
        {
          base: "https://api.example.com/v1/../admin",
          auth: { headers: {} },
          permissions: [{ name: "read", rules: ["GET /items"] }],
        },
      ],
    };

    expect(() => {
      return collectAndValidatePermissions(config);
    }).toThrow("must not contain unsafe path segments");
  });

  it("collectAndValidatePermissions validates static base URL host policies", () => {
    const config = (
      base: string,
      hostPolicy: FirewallConfig["apis"][number]["hostPolicy"],
    ): FirewallConfig => {
      return {
        name: "static-host-policy",
        apis: [
          {
            base,
            hostPolicy,
            auth: { headers: { Authorization: "Bearer token" } },
            permissions: [],
          },
        ],
      };
    };

    expect(() => {
      return collectAndValidatePermissions(
        config("https://127.0.0.1", { kind: "publicDestination" }),
      );
    }).toThrow("host policy does not allow non-public IP literal");
    expect(() => {
      return collectAndValidatePermissions(
        config("https://127.0.0.1/v1/{path}", {
          kind: "publicDestination",
        }),
      );
    }).toThrow("host policy does not allow non-public IP literal");
    expect(() => {
      return collectAndValidatePermissions(
        config("https://8.8.8.8.", { kind: "publicDestination" }),
      );
    }).toThrow("host policy does not allow non-public IP literal");
    expect(() => {
      return collectAndValidatePermissions(
        config("https://\u0668.\u0668.\u0668.\u0668", {
          kind: "publicDestination",
        }),
      );
    }).toThrow("host must use canonical IPv4 address syntax");
    expect(() => {
      return collectAndValidatePermissions(
        config("https://api.evil.test", {
          kind: "providerOwned",
          suffixes: ["example.com"],
        }),
      );
    }).toThrow('host policy does not allow resolved host "api.evil.test"');
    expect(() => {
      return collectAndValidatePermissions(
        config("https://api.example.com:8443", {
          kind: "providerOwned",
          suffixes: ["example.com"],
        }),
      );
    }).toThrow("host policy does not allow non-default ports");

    expect(() => {
      return collectAndValidatePermissions(
        config("https://8.8.8.8", { kind: "publicDestination" }),
      );
    }).not.toThrow();
    expect(() => {
      return collectAndValidatePermissions(
        config("https://api.example.com", {
          kind: "providerOwned",
          suffixes: ["example.com"],
        }),
      );
    }).not.toThrow();
  });

  it("collectAndValidatePermissions validates host policy shape before base URL vars resolve", () => {
    const config = (
      hostPolicy: FirewallConfig["apis"][number]["hostPolicy"],
    ): FirewallConfig => {
      return {
        name: "template-host-policy",
        apis: [
          {
            base: "https://${{ vars.API_HOST }}",
            hostPolicy,
            auth: { headers: { Authorization: "Bearer token" } },
            permissions: [],
          },
        ],
      };
    };

    expect(() => {
      return collectAndValidatePermissions(
        config({
          kind: "providerOwned",
          suffixes: ["*.example.com"],
        }),
      );
    }).toThrow("providerOwned host policy suffixes must be fixed hostnames");
    expect(() => {
      return collectAndValidatePermissions(
        config({
          kind: "providerOwned",
          exactHosts: [".api.example.com"],
        }),
      );
    }).toThrow("providerOwned host policy exactHosts must be fixed hostnames");
    expect(() => {
      return collectAndValidatePermissions(
        config({
          kind: "providerOwned",
          suffixes: ["example.com"],
        }),
      );
    }).not.toThrow();
    expect(() => {
      return collectAndValidatePermissions(
        config({
          kind: "publicDestination",
        }),
      );
    }).not.toThrow();
  });

  it("collectAndValidatePermissions validates parameterized host policies", () => {
    const config = (
      base: string,
      hostPolicy: FirewallConfig["apis"][number]["hostPolicy"],
    ): FirewallConfig => {
      return {
        name: "parameterized-host-policy",
        apis: [
          {
            base,
            hostPolicy,
            auth: { headers: { Authorization: "Bearer token" } },
            permissions: [],
          },
        ],
      };
    };

    expect(() => {
      return collectAndValidatePermissions(
        config("https://{sub}.example.com", {
          kind: "providerOwned",
          suffixes: ["example.com"],
        }),
      );
    }).not.toThrow();
    expect(() => {
      return collectAndValidatePermissions(
        config("https://{sub}.evil.test", {
          kind: "providerOwned",
          suffixes: ["example.com"],
        }),
      );
    }).toThrow('host policy does not allow resolved host "x.evil.test"');
    expect(() => {
      return collectAndValidatePermissions(
        config("https://{sub}.example.com", {
          kind: "providerOwned",
          exactHosts: ["x.example.com"],
        }),
      );
    }).toThrow('host policy does not allow resolved host "x.example.com"');
    expect(() => {
      return collectAndValidatePermissions(
        config("https://{sub}.example.com:8443", {
          kind: "providerOwned",
          suffixes: ["example.com"],
        }),
      );
    }).toThrow("host policy does not allow non-default ports");
  });

  it("collectAndValidatePermissions rejects malformed static auth.base URLs", () => {
    const config = (authBase: string): FirewallConfig => {
      return {
        name: "rewrite",
        apis: [
          {
            base: "https://placeholder.example.com/hook",
            auth: { base: authBase },
            permissions: [],
          },
        ],
      };
    };

    expect(() => {
      return collectAndValidatePermissions(config("ftp://example.com/hook"));
    }).toThrow("scheme must be https");
    expect(() => {
      return collectAndValidatePermissions(config("http://example.com/hook"));
    }).toThrow("scheme must be https");
    expect(() => {
      return collectAndValidatePermissions(
        config("http://${{ vars.WEBHOOK_HOST }}/hook"),
      );
    }).toThrow("scheme must be https");
    expect(() => {
      return collectAndValidatePermissions(config("https:/example.com/hook"));
    }).toThrow('URL must include "://" after the scheme');
    expect(() => {
      return collectAndValidatePermissions(config("https:///hook"));
    }).toThrow("not a valid URL authority");
    expect(() => {
      return collectAndValidatePermissions(config("https://example.com:/hook"));
    }).toThrow("not a valid URL authority");
    expect(() => {
      return collectAndValidatePermissions(
        config("https://example.com/hook#fragment"),
      );
    }).toThrow("must not contain fragment");
    expect(() => {
      return collectAndValidatePermissions(
        config("https://user:pass@example.com/hook"),
      );
    }).toThrow("must not contain userinfo");
    expect(() => {
      return collectAndValidatePermissions(config("https://example.com\\hook"));
    }).toThrow("must not contain backslash");
    expect(() => {
      return collectAndValidatePermissions(config("https://0177.0.0.1/hook"));
    }).toThrow("host must use canonical IPv4 address syntax");
    expect(() => {
      return collectAndValidatePermissions(
        config("https://0177.0.0.1?token=static"),
      );
    }).toThrow("host must use canonical IPv4 address syntax");
    expect(() => {
      return collectAndValidatePermissions(config("https://127。0。0。1/hook"));
    }).toThrow("host must use canonical IPv4 address syntax");
    expect(() => {
      return collectAndValidatePermissions(
        config("https://127。0。0。1?token=static"),
      );
    }).toThrow("host must use canonical IPv4 address syntax");
    expect(() => {
      return collectAndValidatePermissions(
        config("https://example.com/\x00hook"),
      );
    }).toThrow("must not contain control characters or invalid Unicode");
    expect(() => {
      return collectAndValidatePermissions(
        config("https://example.com/\uD800hook"),
      );
    }).toThrow("must not contain control characters or invalid Unicode");
    expect(() => {
      return collectAndValidatePermissions(
        config("https:/example.com/hook/${{ secrets.WEBHOOK_TOKEN }}"),
      );
    }).toThrow('URL must include "://" after the scheme');
    expect(() => {
      return collectAndValidatePermissions(
        config("https://example.com/hook/${{ env.WEBHOOK_TOKEN }}"),
      );
    }).toThrow("contains unsupported template reference");
    expect(() => {
      return collectAndValidatePermissions(
        config("${{ secrets.WEBHOOK_URL }} /v1"),
      );
    }).toThrow("must not contain whitespace");
    expect(() => {
      return collectAndValidatePermissions(
        config("${{ secrets.WEBHOOK_URL }}\\v1"),
      );
    }).toThrow("must not contain backslash");
    expect(() => {
      return collectAndValidatePermissions(
        config("${{ secrets.WEBHOOK_URL }}/\x00v1"),
      );
    }).toThrow("must not contain control characters or invalid Unicode");
    expect(() => {
      return collectAndValidatePermissions(
        config("${{ secrets.WEBHOOK_URL }}/\uD800v1"),
      );
    }).toThrow("must not contain control characters or invalid Unicode");
    expect(() => {
      return collectAndValidatePermissions(
        config("${{ secrets.WEBHOOK_URL }}#fragment"),
      );
    }).toThrow("must not contain fragment");
    expect(() => {
      return collectAndValidatePermissions(
        config("${{ secrets.WEBHOOK_URL }}/${{ env.WEBHOOK_TOKEN }}"),
      );
    }).toThrow("contains unsupported template reference");
    expect(() => {
      return collectAndValidatePermissions(
        config("${{ secrets.WEBHOOK_URL }}@evil.com"),
      );
    }).toThrow('dynamic URL suffix must start with "/" or "?"');
    expect(() => {
      return collectAndValidatePermissions(
        config("${{ secrets.WEBHOOK_URL }}:443"),
      );
    }).toThrow('dynamic URL suffix must start with "/" or "?"');
    expect(() => {
      return collectAndValidatePermissions(
        config("${{ secrets.WEBHOOK_URL }}&token=static"),
      );
    }).toThrow('dynamic URL suffix must start with "/" or "?"');
  });

  it("collectAndValidatePermissions accepts static and templated auth.base URLs", () => {
    const validAuthBases = [
      "https://example.com/hook?token=static",
      "https://example.com?token=a@b",
      "${{ secrets.WEBHOOK_URL }}",
      "${{ secrets.WEBHOOK_BASE_URL }}/v1",
      "https://example.com/hook/${{ secrets.WEBHOOK_TOKEN }}",
      "https://${{ vars.WEBHOOK_HOST }}/hook/${{ secrets.WEBHOOK_TOKEN }}",
      "${{ secrets.WEBHOOK_BASE_URL }}/${{ vars.WEBHOOK_PATH }}",
      "${{ secrets.WEBHOOK_BASE_URL }}?token=static",
    ];

    for (const authBase of validAuthBases) {
      const config: FirewallConfig = {
        name: "rewrite",
        apis: [
          {
            base: "https://placeholder.example.com/hook",
            auth: { base: authBase },
            permissions: [],
          },
        ],
      };

      expect(() => {
        return collectAndValidatePermissions(config);
      }).not.toThrow();
    }
  });
});

describe("validateRule", () => {
  it("should accept valid rules", () => {
    expect(() => {
      return validateRule("GET /repos/{owner}/{repo}", "p", "fw");
    }).not.toThrow();
    expect(() => {
      return validateRule("POST /chat.postMessage", "p", "fw");
    }).not.toThrow();
    expect(() => {
      return validateRule("ANY /{path+}", "p", "fw");
    }).not.toThrow();
    expect(() => {
      return validateRule("DELETE /repos/{owner}/{repo}", "p", "fw");
    }).not.toThrow();
    expect(() => {
      return validateRule(
        "PUT /repos/{owner}/{repo}/contents/{path+}",
        "p",
        "fw",
      );
    }).not.toThrow();
    expect(() => {
      return validateRule(
        "PATCH /repos/{owner}/{repo}/pulls/{number}",
        "p",
        "fw",
      );
    }).not.toThrow();
    expect(() => {
      return validateRule("GET /", "p", "fw");
    }).not.toThrow();
    expect(() => {
      return validateRule("GET /emoji/\u{1F600}", "p", "fw");
    }).not.toThrow();
  });

  it("should accept explicit empty path segments", () => {
    expect(() => {
      return validateRule("GET //repos", "p", "fw");
    }).not.toThrow();
  });

  it("accepts bounded AWS-aware action, target, and REST query rules", () => {
    const options = { allowAwsPredicates: true } as const;

    expect(() => {
      return validateRule(
        "POST / AWS sigv4=ec2 action=DescribeInstances",
        "describe-instances",
        "aws",
        options,
      );
    }).not.toThrow();
    expect(() => {
      return validateRule(
        "POST / AWS sigv4=dynamodb target=DynamoDB_20120810.GetItem",
        "get-item",
        "aws",
        options,
      );
    }).not.toThrow();
    expect(() => {
      return validateRule(
        "GET /{Bucket}/{Key+}?versionId=* AWS sigv4=s3",
        "get-object-version",
        "aws",
        options,
      );
    }).not.toThrow();
  });

  it("rejects malformed or misplaced AWS-aware rules", () => {
    expect(() => {
      return validateRule(
        "POST / AWS sigv4=ec2 action=DescribeInstances",
        "describe-instances",
        "aws",
      );
    }).toThrow("AWS predicates require api.auth.awsSigv4");
    expect(() => {
      return validateRule(
        "POST / AWS action=DescribeInstances",
        "describe-instances",
        "aws",
        { allowAwsPredicates: true },
      );
    }).toThrow('AWS predicate "sigv4" is required');
    expect(() => {
      return validateRule(
        "POST / AWS sigv4=ec2 action=DescribeInstances target=Service.Operation",
        "describe-instances",
        "aws",
        { allowAwsPredicates: true },
      );
    }).toThrow('"action" and "target" cannot be combined');
    expect(() => {
      return validateRule("GET /?acl&acl AWS sigv4=s3", "get-acl", "aws", {
        allowAwsPredicates: true,
      });
    }).toThrow('duplicate AWS query requirement "acl"');
  });

  it("accepts AWS-aware rules only on SigV4 API entries", () => {
    const awsAuth = {
      awsSigv4: {
        accessKeyId: "${{ secrets.AWS_ACCESS_KEY_ID }}",
        secretAccessKey: "${{ secrets.AWS_SECRET_ACCESS_KEY }}",
      },
    };
    const permissions = [
      {
        name: "describe-instances",
        rules: ["POST / AWS sigv4=ec2 action=DescribeInstances"],
      },
    ];

    expect(() => {
      return collectAndValidatePermissions({
        name: "aws",
        apis: [
          { base: "https://ec2.amazonaws.com", auth: awsAuth, permissions },
        ],
      });
    }).not.toThrow();
    expect(() => {
      return collectAndValidatePermissions({
        name: "not-aws",
        apis: [
          {
            base: "https://api.example.com",
            auth: { headers: {} },
            permissions,
          },
        ],
      });
    }).toThrow("AWS predicates require api.auth.awsSigv4");
  });

  it("should reject missing path", () => {
    expect(() => {
      return validateRule("GET", "read", "github");
    }).toThrow('must be "METHOD /path"');
  });

  it("should reject empty string", () => {
    expect(() => {
      return validateRule("", "read", "github");
    }).toThrow('must be "METHOD /path"');
  });

  it("should reject unknown method", () => {
    expect(() => {
      return validateRule("INVALID /foo", "read", "github");
    }).toThrow('unknown method "INVALID"');
  });

  it("should reject lowercase method", () => {
    expect(() => {
      return validateRule("get /foo", "read", "github");
    }).toThrow("must be uppercase");
  });

  it("should reject path with query string", () => {
    expect(() => {
      return validateRule("GET /foo?bar=1", "read", "github");
    }).toThrow("must not contain query string or fragment");
  });

  it("should reject path with fragment", () => {
    expect(() => {
      return validateRule("GET /foo#section", "read", "github");
    }).toThrow("must not contain query string or fragment");
  });

  it("should reject path without leading slash", () => {
    expect(() => {
      return validateRule("GET foo", "read", "github");
    }).toThrow('path must start with "/"');
  });

  it("should reject malformed rule separators", () => {
    expect(() => {
      return validateRule("GET  /foo", "read", "github");
    }).toThrow('path must start with "/"');
    expect(() => {
      return validateRule("GET\t/foo", "read", "github");
    }).toThrow('must be "METHOD /path"');
    expect(() => {
      return validateRule("GET /foo bar", "read", "github");
    }).toThrow("path must not contain whitespace");
  });

  it("should reject path with raw whitespace", () => {
    expect(() => {
      return validateRule("GET /pa th", "read", "github");
    }).toThrow("path must not contain whitespace");
    expect(() => {
      return validateRule("GET /pa\tth", "read", "github");
    }).toThrow("path must not contain whitespace");
  });

  it("should reject path with raw control characters or invalid Unicode", () => {
    expect(() => {
      return validateRule("GET /pa\x00th", "read", "github");
    }).toThrow("path must not contain control characters or invalid Unicode");
    expect(() => {
      return validateRule("GET /pa\x7fth", "read", "github");
    }).toThrow("path must not contain control characters or invalid Unicode");
    expect(() => {
      return validateRule("GET /pa\uD800th", "read", "github");
    }).toThrow("path must not contain control characters or invalid Unicode");
  });

  it("should reject path with raw backslash", () => {
    expect(() => {
      return validateRule("GET /foo\\bar", "read", "github");
    }).toThrow("path must not contain backslash");
    expect(() => {
      return validateRule("GET /foo%5Cbar", "read", "github");
    }).not.toThrow();
  });

  it("should reject {param+} not in last segment", () => {
    expect(() => {
      return validateRule("GET /foo/{path+}/bar", "read", "github");
    }).toThrow("{path+} must be the last segment");
  });

  it("should accept {param+} in last segment", () => {
    expect(() => {
      return validateRule("GET /repos/{owner}/{path+}", "p", "fw");
    }).not.toThrow();
  });

  it("should accept {param*} in last segment", () => {
    expect(() => {
      return validateRule("ANY /{path*}", "p", "fw");
    }).not.toThrow();
    expect(() => {
      return validateRule("GET /repos/{owner}/{path*}", "p", "fw");
    }).not.toThrow();
  });

  it("should accept hyphenated parameter names used by generated firewalls", () => {
    expect(() => {
      return validateRule("POST /v1/ingest/{dataset-id}", "p", "fw");
    }).not.toThrow();
  });

  it("should reject {param*} not in last segment", () => {
    expect(() => {
      return validateRule("GET /foo/{path*}/bar", "read", "github");
    }).toThrow("{path*} must be the last segment");
  });

  it("should reject greedy params mixed with path literals", () => {
    expect(() => {
      return validateRule("GET /files/file-{id+}", "read", "github");
    }).toThrow(
      'greedy parameter {id+} cannot be combined with a literal prefix or suffix in segment "file-{id+}"',
    );
    expect(() => {
      return validateRule("GET /files/file-{id*}", "read", "github");
    }).toThrow(
      'greedy parameter {id*} cannot be combined with a literal prefix or suffix in segment "file-{id*}"',
    );
  });

  it("should reject duplicate parameter names", () => {
    expect(() => {
      return validateRule("GET /repos/{owner}/{owner}", "p", "fw");
    }).toThrow('duplicate parameter name "{owner}"');
  });

  it("should reject empty parameter name", () => {
    expect(() => {
      return validateRule("GET /repos/{}", "p", "fw");
    }).toThrow("empty parameter name");
  });

  it("should reject empty greedy parameter name", () => {
    expect(() => {
      return validateRule("GET /repos/{+}", "p", "fw");
    }).toThrow("empty parameter name");
  });

  it("should reject empty star parameter name", () => {
    expect(() => {
      return validateRule("GET /repos/{*}", "p", "fw");
    }).toThrow("empty parameter name");
  });
});

describe("validateBaseUrl", () => {
  it("should accept valid URLs", () => {
    expect(() => {
      return validateBaseUrl("https://api.github.com", "github");
    }).not.toThrow();
    expect(() => {
      return validateBaseUrl("http://api.github.com", "github");
    }).not.toThrow();
    expect(() => {
      return validateBaseUrl("https://slack.com/api", "slack");
    }).not.toThrow();
    expect(() => {
      return validateBaseUrl("https://us1.api.mailchimp.com/3.0", "mailchimp");
    }).not.toThrow();
    expect(() => {
      return validateBaseUrl("https://api.example.com/emoji/\u{1F600}", "fw");
    }).not.toThrow();
  });

  it("should reject invalid URLs", () => {
    expect(() => {
      return validateBaseUrl("not-a-url", "fw");
    }).toThrow('URL must include a scheme (e.g. "https://not-a-url")');
  });

  it("should reject unsupported URL schemes", () => {
    expect(() => {
      return validateBaseUrl("ftp://api.example.com/v1", "fw");
    }).toThrow("scheme must be http or https");
    expect(() => {
      return validateBaseUrl("ssh://{sub}.example.com/v1", "fw");
    }).toThrow("scheme must be http or https");
  });

  it("should reject URLs with missing authority", () => {
    expect(() => {
      return validateBaseUrl("https:///v1", "fw");
    }).toThrow("not a valid URL authority");
  });

  it("should reject URLs with empty ports", () => {
    expect(() => {
      return validateBaseUrl("https://api.example.com:", "fw");
    }).toThrow("not a valid URL authority");
    expect(() => {
      return validateBaseUrl("https://{sub}.example.com:", "fw");
    }).toThrow("not a valid URL authority");
  });

  it("should reject URLs that omit // after the scheme", () => {
    expect(() => {
      return validateBaseUrl("https:/api.example.com/v1", "fw");
    }).toThrow('URL must include "://" after the scheme');
    expect(() => {
      return validateBaseUrl("https:api.example.com/v1", "fw");
    }).toThrow('URL must include "://" after the scheme');
  });

  it("suggests adding https:// when the scheme is missing", () => {
    expect(() => {
      return validateBaseUrl("attia-n8n.duckdns.org/api/v1", "n8n");
    }).toThrow(
      'URL must include a scheme (e.g. "https://attia-n8n.duckdns.org/api/v1")',
    );
  });

  it("falls back to the generic message when scheme is present but URL is malformed", () => {
    expect(() => {
      return validateBaseUrl("https://exa mple.com", "fw");
    }).toThrow("must not contain whitespace");
  });

  it("should reject URLs with query string", () => {
    expect(() => {
      return validateBaseUrl("https://api.example.com?next=/../", "fw");
    }).toThrow("must not contain query string");
  });

  it("should reject URLs with fragment", () => {
    expect(() => {
      return validateBaseUrl("https://api.example.com#next=/../", "fw");
    }).toThrow("must not contain fragment");
  });

  it("should skip template base URLs", () => {
    expect(() => {
      return validateBaseUrl(
        "https://${{ vars.ZENDESK_SUBDOMAIN }}.zendesk.com",
        "zendesk",
      );
    }).not.toThrow();
  });

  it("should reject unsafe fixed paths in template base URLs", () => {
    expect(() => {
      return validateBaseUrl(
        "https://${{ vars.API_HOST }}/v1/../admin",
        "templated",
      );
    }).toThrow("must not contain unsafe path segments");
    expect(() => {
      return validateBaseUrl(
        "${{ vars.API_BASE_URL }}/v1/%2e%2e/admin",
        "templated",
      );
    }).toThrow("must not contain unsafe path segments");
  });

  it("should allow safe fixed paths in unresolved template base URLs", () => {
    expect(() => {
      return validateBaseUrl(
        "https://${{ vars.API_HOST }}/v1/items",
        "templated",
      );
    }).not.toThrow();
    expect(() => {
      return validateBaseUrl("${{ vars.API_BASE_URL }}/v1/items", "templated");
    }).not.toThrow();
  });

  it("should accept base URL with single host param", () => {
    expect(() => {
      return validateBaseUrl("https://{subdomain}.zendesk.com", "zendesk");
    }).not.toThrow();
  });

  it("should accept base URL with greedy host param in first position", () => {
    expect(() => {
      return validateBaseUrl("https://{sub+}.example.com", "fw");
    }).not.toThrow();
    expect(() => {
      return validateBaseUrl("https://{sub*}.example.com", "fw");
    }).not.toThrow();
  });

  it("should accept base URL with single path param", () => {
    expect(() => {
      return validateBaseUrl("https://api.example.com/v1/{org}", "fw");
    }).not.toThrow();
    expect(() => {
      return validateBaseUrl("https://api.example.com/v1/{org}/projects", "fw");
    }).not.toThrow();
  });

  it("should reject parameterized base URL with bracketed host", () => {
    expect(() => {
      return validateBaseUrl("https://[2001:db8::1]/v1/{org}", "fw");
    }).toThrow("host must have at least two segments");
    expect(() => {
      return validateBaseUrl("https://[::ffff:127.0.0.1]/v1/{org}", "fw");
    }).toThrow("host must have at least two segments");
  });

  it("should reject parameterized base URL with IPv4-shaped host", () => {
    expect(() => {
      return validateBaseUrl("https://127.{octet}.0.1", "fw");
    }).toThrow("not a valid URL authority");
    expect(() => {
      return validateBaseUrl("https://{a}.0.0.1", "fw");
    }).toThrow("not a valid URL authority");
  });

  it("should accept parameterized base URL with explicit empty path segments", () => {
    expect(() => {
      return validateBaseUrl("https://api.example.com/v1//{org}", "fw");
    }).not.toThrow();
  });

  it("should accept base URL with host and path params", () => {
    expect(() => {
      return validateBaseUrl("https://{sub}.example.com/v1/{org}", "fw");
    }).not.toThrow();
  });

  it("should reject greedy host param not in first position", () => {
    expect(() => {
      return validateBaseUrl("https://api.{sub+}.example.com", "fw");
    }).toThrow("{sub+} must be the first host segment");
    expect(() => {
      return validateBaseUrl("https://api.{sub*}.example.com", "fw");
    }).toThrow("{sub*} must be the first host segment");
  });

  it("should reject greedy host params mixed with host literals", () => {
    expect(() => {
      return validateBaseUrl("https://api-{sub+}.example.com", "fw");
    }).toThrow(
      'greedy parameter {sub+} cannot be combined with a literal prefix or suffix in host segment "api-{sub+}"',
    );
    expect(() => {
      return validateBaseUrl("https://api-{sub*}.example.com", "fw");
    }).toThrow(
      'greedy parameter {sub*} cannot be combined with a literal prefix or suffix in host segment "api-{sub*}"',
    );
  });

  it("should reject greedy path param in base URL", () => {
    expect(() => {
      return validateBaseUrl("https://api.example.com/{path+}", "fw");
    }).toThrow("greedy parameter {path+} is not allowed in base URL path");
    expect(() => {
      return validateBaseUrl("https://api.example.com/{path*}", "fw");
    }).toThrow("greedy parameter {path*} is not allowed in base URL path");
  });

  it("should reject greedy path params mixed with base path literals", () => {
    expect(() => {
      return validateBaseUrl("https://api.example.com/files/file-{id+}", "fw");
    }).toThrow("greedy parameter {id+} is not allowed in base URL path");
    expect(() => {
      return validateBaseUrl("https://api.example.com/files/file-{id*}", "fw");
    }).toThrow("greedy parameter {id*} is not allowed in base URL path");
  });

  it("should reject host with no static segments", () => {
    expect(() => {
      return validateBaseUrl("https://{a}.{b}", "fw");
    }).toThrow("must have at least one static segment");
    expect(() => {
      return validateBaseUrl("https://api-{sub}.example-{env}", "fw");
    }).toThrow("must have at least one static segment");
  });

  it("should reject empty param name in host", () => {
    expect(() => {
      return validateBaseUrl("https://{}.example.com", "fw");
    }).toThrow(/empty parameter name/);
  });

  it("should reject empty param name in path", () => {
    expect(() => {
      return validateBaseUrl("https://api.example.com/{}", "fw");
    }).toThrow(/empty parameter name/);
  });

  it("should reject duplicate param names in host", () => {
    expect(() => {
      return validateBaseUrl("https://{sub}.{sub}.example.com", "fw");
    }).toThrow('duplicate parameter name "{sub}" in host');
  });

  it("should reject duplicate param names across host and path", () => {
    expect(() => {
      return validateBaseUrl("https://{org}.example.com/{org}", "fw");
    }).toThrow('duplicate parameter name "{org}"');
  });

  it("should reject query string in parameterized base URL", () => {
    expect(() => {
      return validateBaseUrl("https://{sub}.example.com?key=val", "fw");
    }).toThrow("must not contain query string");
  });

  it("should reject fragment in parameterized base URL", () => {
    expect(() => {
      return validateBaseUrl("https://{sub}.example.com#section", "fw");
    }).toThrow("must not contain fragment");
  });

  it("should reject raw whitespace before URL parser normalization", () => {
    expect(() => {
      return validateBaseUrl("https://api.example.com/pa th", "fw");
    }).toThrow("must not contain whitespace");
    expect(() => {
      return validateBaseUrl("https://api.example.com/pa\tth", "fw");
    }).toThrow("must not contain whitespace");
    expect(() => {
      return validateBaseUrl("https://{sub}.example.com/pa th", "fw");
    }).toThrow("must not contain whitespace");
  });

  it("should reject raw control characters or invalid Unicode before URL parser normalization", () => {
    expect(() => {
      return validateBaseUrl("https://api.example.com/pa\x00th", "fw");
    }).toThrow("must not contain control characters or invalid Unicode");
    expect(() => {
      return validateBaseUrl("https://api.example.com/pa\x7fth", "fw");
    }).toThrow("must not contain control characters or invalid Unicode");
    expect(() => {
      return validateBaseUrl("https://api.example.com/pa\uD800th", "fw");
    }).toThrow("must not contain control characters or invalid Unicode");
    expect(() => {
      return validateBaseUrl("https://{sub}.example.com/pa\x00th", "fw");
    }).toThrow("must not contain control characters or invalid Unicode");
    expect(() => {
      return validateBaseUrl("https://${{ vars.API_HOST }}/\x00v1", "fw");
    }).toThrow("must not contain control characters or invalid Unicode");
  });

  it("should reject backslash before URL parser normalization", () => {
    expect(() => {
      return validateBaseUrl("https://api.example.com\\v1", "fw");
    }).toThrow("must not contain backslash");
    expect(() => {
      return validateBaseUrl("https://{sub}.example.com\\v1", "fw");
    }).toThrow("must not contain backslash");
    expect(() => {
      return validateBaseUrl("https://${{ vars.API_HOST }}\\v1", "fw");
    }).toThrow("must not contain backslash");
  });

  it("should reject percent-encoded braces in parameterized host", () => {
    expect(() => {
      return validateBaseUrl("https://{sub}.%7Benv%7D.example.com", "fw");
    }).toThrow("host must not contain percent-encoded braces");
  });

  it("should reject percent-encoded braces in static host", () => {
    expect(() => {
      return validateBaseUrl("https://%7Benv%7D.example.com", "fw");
    }).toThrow("host must not contain percent-encoded braces");
  });

  it("should reject percent-encoded dots in host", () => {
    expect(() => {
      return validateBaseUrl("https://{sub}%2eexample.com", "fw");
    }).toThrow("host must not contain percent-encoded dots");
    expect(() => {
      return validateBaseUrl("https://api%E3%80%82example.com", "fw");
    }).toThrow("host must not contain percent-encoded dots");
  });

  it("should reject raw and percent-encoded wildcard host characters", () => {
    expect(() => {
      return validateBaseUrl("https://*.example.com", "fw");
    }).toThrow("host must not contain wildcard characters");
    expect(() => {
      return validateBaseUrl("https://api-*.example.com", "fw");
    }).toThrow("host must not contain wildcard characters");
    expect(() => {
      return validateBaseUrl("https://api-{sub}*.example.com", "fw");
    }).toThrow("host must not contain wildcard characters");
    expect(() => {
      return validateBaseUrl("https://%2A.example.com", "fw");
    }).toThrow("host must not contain wildcard characters");
    expect(() => {
      return validateBaseUrl("https://api-%2A.example.com", "fw");
    }).toThrow("host must not contain wildcard characters");
  });

  it("should reject commas in host", () => {
    expect(() => {
      return validateBaseUrl("https://api,example.com", "fw");
    }).toThrow("host must not contain commas");
    expect(() => {
      return validateBaseUrl("https://{sub}.api,example.com", "fw");
    }).toThrow("host must not contain commas");
    expect(() => {
      return validateBaseUrl("https://api%2Cexample.com", "fw");
    }).toThrow("host must not contain commas");
    expect(() => {
      return validateBaseUrl("https://{sub}.api%2Cexample.com", "fw");
    }).toThrow("host must not contain commas");
  });

  it("should reject empty labels in static host", () => {
    expect(() => {
      return validateBaseUrl("https://api..example.com", "fw");
    }).toThrow("host must not contain empty labels");
    expect(() => {
      return validateBaseUrl("https://.example.com", "fw");
    }).toThrow("host must not contain empty labels");
    expect(() => {
      return validateBaseUrl("https://api.example.com..", "fw");
    }).toThrow("host must not contain empty labels");
    expect(() => {
      return validateBaseUrl("https://api.example..com:8443", "fw");
    }).toThrow("host must not contain empty labels");
  });

  it("should accept a trailing dot in static host", () => {
    expect(() => {
      return validateBaseUrl("https://api.example.com.", "fw");
    }).not.toThrow();
    expect(() => {
      return validateBaseUrl("https://api.example.com.:8443", "fw");
    }).not.toThrow();
  });

  it("should reject unsafe IDNA compatibility mappings in static host", () => {
    expect(() => {
      return validateBaseUrl("https://\u212a.example", "fw");
    }).toThrow("host must not contain unsafe IDNA compatibility mappings");
    expect(() => {
      return validateBaseUrl("https://\u1e9e.example", "fw");
    }).toThrow("host must not contain unsafe IDNA compatibility mappings");
    expect(() => {
      return validateBaseUrl("https://\u03f2.example", "fw");
    }).toThrow("host must not contain unsafe IDNA compatibility mappings");
    expect(() => {
      return validateBaseUrl("https://\uff21.example", "fw");
    }).toThrow("host must not contain unsafe IDNA compatibility mappings");
  });

  it("should reject percent-encoded unsafe IDNA compatibility mappings in host", () => {
    expect(() => {
      return validateBaseUrl("https://%E2%84%AA.example", "fw");
    }).toThrow("host must not contain unsafe IDNA compatibility mappings");
    expect(() => {
      return validateBaseUrl("https://{sub}.%EF%BC%A1.example", "fw");
    }).toThrow("host must not contain unsafe IDNA compatibility mappings");
  });

  it("should reject non-canonical IPv4 address syntax in host", () => {
    expect(() => {
      return validateBaseUrl("https://0177.0.0.1", "fw");
    }).toThrow("host must use canonical IPv4 address syntax");
    expect(() => {
      return validateBaseUrl("https://0x7f.0.0.1", "fw");
    }).toThrow("host must use canonical IPv4 address syntax");
    expect(() => {
      return validateBaseUrl("https://2130706433", "fw");
    }).toThrow("host must use canonical IPv4 address syntax");
    expect(() => {
      return validateBaseUrl("https://127.1", "fw");
    }).toThrow("host must use canonical IPv4 address syntax");
    expect(() => {
      return validateBaseUrl("https://127。0。0。1", "fw");
    }).toThrow("host must use canonical IPv4 address syntax");
    expect(() => {
      return validateBaseUrl("https://127.0.0.1。", "fw");
    }).toThrow("host must use canonical IPv4 address syntax");
    expect(() => {
      return validateBaseUrl("https://\u0668.\u0668.\u0668.\u0668", "fw");
    }).toThrow("host must use canonical IPv4 address syntax");
    expect(() => {
      return validateBaseUrl("https://127.0.0.1.", "fw");
    }).not.toThrow();
  });

  it("should reject host characters that normalize to forbidden syntax", () => {
    expect(() => {
      return validateBaseUrl("https://\u4f8b\uff0c\u5b50.example", "fw");
    }).toThrow("normalize to forbidden host syntax");
    expect(() => {
      return validateBaseUrl(
        "https://%E4%BE%8B%EF%BC%8C%E5%AD%90.example",
        "fw",
      );
    }).toThrow("normalize to forbidden host syntax");
    expect(() => {
      return validateBaseUrl("https://{sub}.\u4f8b\uff0c\u5b50.example", "fw");
    }).toThrow("normalize to forbidden host syntax");
    expect(() => {
      return validateBaseUrl("https://a\u00adb.example", "fw");
    }).toThrow("normalize to forbidden host syntax");
    expect(() => {
      return validateBaseUrl("https://a\u200bb.example", "fw");
    }).toThrow("normalize to forbidden host syntax");
    expect(() => {
      return validateBaseUrl("https://a%E2%80%8Bb.example", "fw");
    }).toThrow("normalize to forbidden host syntax");
  });

  it("should reject ASCII host characters forbidden by the runner", () => {
    for (const char of ["<", ">", "[", "]", "^", "|"]) {
      expect(() => {
        return validateBaseUrl(`https://a${char}b.example`, "fw");
      }).toThrow("host contains a forbidden ASCII character");
    }
    expect(() => {
      return validateBaseUrl("https://a%3Cb.example", "fw");
    }).toThrow("host contains a forbidden ASCII character");
  });

  it("should reject host labels that start with a combining mark", () => {
    expect(() => {
      return validateBaseUrl("https://\u0898b.example", "fw");
    }).toThrow("must not start with a combining mark");
    expect(() => {
      return validateBaseUrl("https://%E0%A2%98b.example", "fw");
    }).toThrow("must not start with a combining mark");
  });

  it("should reject invalid bidirectional host labels", () => {
    expect(() => {
      return validateBaseUrl("https://\u0870b.example", "fw");
    }).toThrow("invalid bidirectional label text");
    expect(() => {
      return validateBaseUrl("https://a\u0870b.example", "fw");
    }).toThrow("invalid bidirectional label text");
    expect(() => {
      return validateBaseUrl("https://{sub}.a\u0870b.example", "fw");
    }).toThrow("invalid bidirectional label text");
    expect(() => {
      return validateBaseUrl("https://a%E0%A1%B0b.example", "fw");
    }).toThrow("invalid bidirectional label text");
    expect(() => {
      return validateBaseUrl("https://\u0870!.example", "fw");
    }).toThrow("invalid bidirectional label text");
    expect(() => {
      return validateBaseUrl("https://\u08701!.example", "fw");
    }).toThrow("invalid bidirectional label text");
    expect(() => {
      return validateBaseUrl("https://1a\u0870.example", "fw");
    }).toThrow("invalid bidirectional label text");
    expect(() => {
      return validateBaseUrl("https://1\u0870!.example", "fw");
    }).toThrow("invalid bidirectional label text");
  });

  it("should accept valid bidirectional host label boundaries", () => {
    expect(() => {
      return validateBaseUrl("https://\u0870.example", "fw");
    }).not.toThrow();
    expect(() => {
      return validateBaseUrl("https://\u08701.example", "fw");
    }).not.toThrow();
    expect(() => {
      return validateBaseUrl("https://\u0870!\u0870.example", "fw");
    }).not.toThrow();
    expect(() => {
      return validateBaseUrl("https://\u0870!1.example", "fw");
    }).not.toThrow();
  });

  it("should reject mixed bidirectional labels outside the fixed policy", () => {
    for (const base of [
      "https://a\u0870.example",
      "https://1\u0870.example",
      "https://a1\u0870.example",
      "https://1\u0870\u0301.example",
    ]) {
      expect(() => {
        return validateBaseUrl(base, "fw");
      }).toThrow("hostname policy vm0-uts46-16.0-v1");
    }
  });

  it("should accept host labels that Python IDNA normalization keeps valid", () => {
    expect(() => {
      return validateBaseUrl("https://\u0345.example", "fw");
    }).not.toThrow();
    expect(() => {
      return validateBaseUrl("https://\u226e.example", "fw");
    }).not.toThrow();
    expect(() => {
      return validateBaseUrl("https://\u226f.example", "fw");
    }).not.toThrow();
  });

  it("should accept canonical IDNA hosts", () => {
    expect(() => {
      return validateBaseUrl("https://xn--fa-hia.de", "fw");
    }).not.toThrow();
    expect(() => {
      return validateBaseUrl("https://{sub}.xn--fa-hia.de", "fw");
    }).not.toThrow();
    expect(() => {
      return validateBaseUrl("https://\u4f8b\u5b50.\u6d4b\u8bd5", "fw");
    }).not.toThrow();
    expect(() => {
      return validateBaseUrl("https://%E2%98%83.example.com", "fw");
    }).not.toThrow();
  });

  it("should reject malformed parameterized authorities", () => {
    expect(() => {
      return validateBaseUrl("https://user@{sub}.zendesk.com", "fw");
    }).toThrow("must not contain userinfo");
    expect(() => {
      return validateBaseUrl("https://{sub}.zendesk.com:bad", "fw");
    }).toThrow("not a valid URL authority");
    expect(() => {
      return validateBaseUrl("https://{sub}.zendesk.com:99999", "fw");
    }).toThrow("not a valid URL authority");
    expect(() => {
      return validateBaseUrl("https://{sub}.api%20example.com", "fw");
    }).toThrow("percent-encoded control characters or whitespace");
    expect(() => {
      return validateBaseUrl("https://{sub}.exa%mple.com", "fw");
    }).toThrow("host has invalid percent encoding");
  });

  it("should reject empty labels in parameterized host", () => {
    expect(() => {
      return validateBaseUrl("https://{sub}.example.com..", "fw");
    }).toThrow("host must not contain empty labels");
    expect(() => {
      return validateBaseUrl("https://{sub}..example.com", "fw");
    }).toThrow("host must not contain empty labels");
    expect(() => {
      return validateBaseUrl("https://.{sub}.example.com", "fw");
    }).toThrow("host must not contain empty labels");
    expect(() => {
      return validateBaseUrl("https://{sub}.example..com", "fw");
    }).toThrow("host must not contain empty labels");
    expect(() => {
      return validateBaseUrl("https://{sub}.example.com..:8443", "fw");
    }).toThrow("host must not contain empty labels");
  });

  it("should accept a trailing dot in parameterized host", () => {
    expect(() => {
      return validateBaseUrl("https://{sub}.example.com.", "fw");
    }).not.toThrow();
    expect(() => {
      return validateBaseUrl("https://{sub}.example.com.:8443", "fw");
    }).not.toThrow();
    expect(() => {
      return validateBaseUrl("https://{sub}\u3002example.com", "fw");
    }).not.toThrow();
  });

  it("should reject non-ascii mixed host parameter literals", () => {
    expect(() => {
      return validateBaseUrl("https://例-{sub}.example.com", "fw");
    }).toThrow("must use ASCII literal prefix and suffix");
    expect(() => {
      return validateBaseUrl("https://{sub}-例.example.com", "fw");
    }).toThrow("must use ASCII literal prefix and suffix");
  });

  it("should reject unsafe IDNA compatibility mappings in parameterized host literals", () => {
    expect(() => {
      return validateBaseUrl("https://{sub}.\u212a.example", "fw");
    }).toThrow("host must not contain unsafe IDNA compatibility mappings");
    expect(() => {
      return validateBaseUrl("https://{sub}.\u1e9e.example", "fw");
    }).toThrow("host must not contain unsafe IDNA compatibility mappings");
    expect(() => {
      return validateBaseUrl("https://{sub}.\uff21.example", "fw");
    }).toThrow("host must not contain unsafe IDNA compatibility mappings");
  });

  it("should reject userinfo in static base URL", () => {
    expect(() => {
      return validateBaseUrl("https://user:pass@api.example.com", "fw");
    }).toThrow("must not contain userinfo");
  });

  it("should reject param in scheme", () => {
    expect(() => {
      return validateBaseUrl("{proto}://api.example.com", "fw");
    }).toThrow("scheme must not contain parameters");
  });

  it("should reject resolved template base URLs with raw whitespace", () => {
    const firewalls = [
      {
        name: "fw",
        apis: [
          {
            base: "https://${{ vars.API_HOST }}/pa th",
            auth: { headers: {} },
          },
        ],
      },
    ];

    expect(() => {
      return resolveFirewallBaseUrlVars(firewalls, {
        API_HOST: "api.example.com",
      });
    }).toThrow("must not contain whitespace");
  });

  it("should accept mixed {param}{literal} segment in host", () => {
    // Per #10078 — mixed segments are valid; a single parameter per segment
    // with optional literal prefix and/or suffix.
    expect(() => {
      return validateBaseUrl("https://api-{version}.example.com", "fw");
    }).not.toThrow();
  });

  it("should accept mixed {param}{literal} segment in path", () => {
    expect(() => {
      return validateBaseUrl("https://api.example.com/v1-{version}", "fw");
    }).not.toThrow();
  });
});

describe("expandHostWildcardsInBaseUrl", () => {
  it("converts custom connector host wildcards to parameterized host segments", () => {
    const expanded = expandHostWildcardsInBaseUrl("https://*.example.com/v1/");
    expect(expanded).toBe("https://{hostWildcard1}.example.com/v1/");
    expect(() => {
      return validateBaseUrl(expanded, "fw");
    }).not.toThrow();
  });

  it("converts each host wildcard into one host segment parameter", () => {
    expect(expandHostWildcardsInBaseUrl("https://*.*.example.com/")).toBe(
      "https://{hostWildcard1}.{hostWildcard2}.example.com/",
    );
  });

  it("preserves explicit ports when converting host wildcards", () => {
    const expanded = expandHostWildcardsInBaseUrl(
      "https://*.example.com:8443/v1/",
    );
    expect(expanded).toBe("https://{hostWildcard1}.example.com:8443/v1/");
    expect(() => {
      return validateBaseUrl(expanded, "fw");
    }).not.toThrow();

    expect(expandHostWildcardsInBaseUrl("https://*.example.com:443/v1/")).toBe(
      "https://{hostWildcard1}.example.com:443/v1/",
    );
  });

  it("does not normalize wildcard URLs with empty ports", () => {
    const expanded = expandHostWildcardsInBaseUrl("https://*.example.com:/v1/");
    expect(expanded).toBe("https://*.example.com:/v1/");
    expect(() => {
      return validateBaseUrl(expanded, "fw");
    }).toThrow("not a valid URL authority");
  });

  it("does not normalize wildcard URLs with userinfo", () => {
    const expanded = expandHostWildcardsInBaseUrl(
      "https://user@*.example.com/v1/",
    );
    expect(expanded).toBe("https://user@*.example.com/v1/");
    expect(() => {
      return validateBaseUrl(expanded, "fw");
    }).toThrow("must not contain userinfo");
  });

  it("does not expand percent-encoded host wildcards", () => {
    expect(expandHostWildcardsInBaseUrl("https://%2A.example.com/v1/")).toBe(
      "https://%2A.example.com/v1/",
    );
    expect(() => {
      return validateBaseUrl("https://%2A.example.com/v1/", "fw");
    }).toThrow("host must not contain wildcard characters");
  });

  it("does not normalize wildcard URLs with backslashes", () => {
    const base = String.raw`https://*.example.com\v1`;
    const expanded = expandHostWildcardsInBaseUrl(base);
    expect(expanded).toBe(base);
    expect(() => {
      return validateBaseUrl(expanded, "fw");
    }).toThrow("must not contain backslash");
  });

  it("does not expand wildcard characters inside bracketed authorities", () => {
    const expanded = expandHostWildcardsInBaseUrl("https://[::*]/v1/");
    expect(expanded).toBe("https://[::*]/v1/");
    expect(() => {
      return validateBaseUrl(expanded, "fw");
    }).toThrow("not a valid URL");
  });

  it("converts mixed-label host wildcards and leaves path wildcards literal", () => {
    expect(
      expandHostWildcardsInBaseUrl("https://api-*.example.com/files/*/"),
    ).toBe("https://api-{hostWildcard1}.example.com/files/*/");
  });
});

describe("hasBaseUrlParams", () => {
  it("returns true for host params", () => {
    expect(hasBaseUrlParams("https://{sub}.zendesk.com")).toBe(true);
  });

  it("returns true for path params", () => {
    expect(hasBaseUrlParams("https://api.example.com/v1/{org}")).toBe(true);
  });

  it("returns false for static URLs", () => {
    expect(hasBaseUrlParams("https://api.github.com")).toBe(false);
  });

  it("returns false for template vars", () => {
    expect(hasBaseUrlParams("https://${{ vars.X }}.example.com")).toBe(false);
  });

  it("returns true when both template vars and params present", () => {
    expect(hasBaseUrlParams("https://${{ vars.X }}.{region}.example.com")).toBe(
      true,
    );
  });

  it("handles adversarial input with many ${{ without closing }}", () => {
    const adversarial = "https://" + "${{".repeat(1000) + ".example.com";
    expect(hasBaseUrlParams(adversarial)).toBe(false);
  });
});

describe("hasBaseUrlVars", () => {
  it("returns true for template base URLs", () => {
    expect(
      hasBaseUrlVars("https://${{ vars.ZENDESK_SUBDOMAIN }}.zendesk.com"),
    ).toBe(true);
  });

  it("returns false for static base URLs", () => {
    expect(hasBaseUrlVars("https://api.github.com")).toBe(false);
  });

  it("returns true for multiple vars", () => {
    expect(
      hasBaseUrlVars("https://${{ vars.A }}.${{ vars.B }}.example.com"),
    ).toBe(true);
  });
});

describe("resolveFirewallBaseUrlTemplate", () => {
  it("resolves host template variables without requiring a firewall API auth object", () => {
    expect(
      resolveFirewallBaseUrlTemplate({
        serviceName: "zendesk",
        base: "https://${{ vars.ZENDESK_SUBDOMAIN }}.zendesk.com",
        vars: { ZENDESK_SUBDOMAIN: "acme" },
        credentialed: true,
      }),
    ).toBe("https://acme.zendesk.com");
  });

  it("throws when required template variables are missing", () => {
    expect(() => {
      return resolveFirewallBaseUrlTemplate({
        serviceName: "zendesk",
        base: "https://${{ vars.ZENDESK_SUBDOMAIN }}.zendesk.com",
        vars: {},
        credentialed: true,
      });
    }).toThrow('requires variable "ZENDESK_SUBDOMAIN"');
  });

  it("enforces https for credentialed resolved template bases", () => {
    expect(() => {
      return resolveFirewallBaseUrlTemplate({
        serviceName: "strapi",
        base: "${{ vars.STRAPI_BASE_URL }}",
        vars: { STRAPI_BASE_URL: "http://strapi.example.test" },
        credentialed: true,
      });
    }).toThrow("credentialed base URL must use https");
  });

  it("keeps non-credentialed http template bases valid", () => {
    expect(
      resolveFirewallBaseUrlTemplate({
        serviceName: "diagnostic",
        base: "${{ vars.DIAGNOSTIC_BASE_URL }}",
        vars: { DIAGNOSTIC_BASE_URL: "http://diagnostic.example.test" },
      }),
    ).toBe("http://diagnostic.example.test");
  });
});

describe("resolveFirewallBaseUrlVars", () => {
  const zendeskFirewall = {
    name: "zendesk",
    apis: [
      {
        base: "https://${{ vars.ZENDESK_SUBDOMAIN }}.zendesk.com",
        auth: {
          headers: {
            Authorization: "Bearer ${{ secrets.ZENDESK_API_TOKEN }}",
          },
        },
      },
    ],
  };

  const staticFirewall = {
    name: "github",
    apis: [
      {
        base: "https://api.github.com",
        auth: {
          headers: { Authorization: "Bearer ${{ secrets.GITHUB_TOKEN }}" },
        },
      },
    ],
  };

  const strapiFirewall = {
    name: "strapi",
    apis: [
      {
        base: "${{ vars.STRAPI_BASE_URL }}",
        hostPolicy: { kind: "publicDestination" as const },
        auth: {
          headers: { Authorization: "Bearer ${{ secrets.STRAPI_TOKEN }}" },
        },
      },
    ],
  };

  const shopifyFirewall = {
    name: "shopify",
    apis: [
      {
        base: "https://${{ vars.SHOPIFY_SHOP }}.myshopify.com",
        auth: {
          headers: {
            "X-Shopify-Access-Token": "${{ secrets.SHOPIFY_TOKEN }}",
          },
        },
      },
    ],
  };

  const snowflakeFirewall = {
    name: "snowflake",
    apis: [
      {
        base: "https://${{ vars.SNOWFLAKE_ACCOUNT }}.snowflakecomputing.com/api",
        auth: {
          headers: {
            Authorization: "Bearer ${{ secrets.SNOWFLAKE_PAT }}",
          },
        },
      },
    ],
  };

  const jiraFirewall = {
    name: "jira",
    apis: [
      {
        base: "https://${{ vars.JIRA_DOMAIN }}",
        hostPolicy: {
          kind: "providerOwned" as const,
          suffixes: ["atlassian.net"],
        },
        auth: {
          headers: {
            Authorization:
              "${{ basic(vars.JIRA_EMAIL, secrets.JIRA_API_TOKEN) }}",
          },
        },
      },
    ],
  };

  const n8nFirewall = {
    name: "n8n",
    apis: [
      {
        base: "${{ vars.N8N_BASE_URL }}/api/v1",
        hostPolicy: { kind: "publicDestination" as const },
        auth: {
          headers: {
            "X-N8N-API-KEY": "${{ secrets.N8N_TOKEN }}",
          },
        },
      },
    ],
  };

  const tenantPathFirewall = {
    name: "tenant-path",
    apis: [
      {
        base: "https://api.example.test/accounts/${{ vars.TENANT }}/v1",
        auth: {
          headers: {
            Authorization: "Bearer ${{ secrets.API_TOKEN }}",
          },
        },
      },
    ],
  };

  const portFirewall = {
    name: "port-api",
    apis: [
      {
        base: "https://api.example.test:${{ vars.API_PORT }}/v1",
        auth: {
          headers: {
            Authorization: "Bearer ${{ secrets.API_TOKEN }}",
          },
        },
      },
    ],
  };

  const embeddedHostFirewall = {
    name: "embedded-host",
    apis: [
      {
        base: "https://api-${{ vars.HOST_TENANT }}.example.test/v1",
        auth: {},
      },
    ],
  };

  const pathFragmentFirewall = {
    name: "path-fragment",
    apis: [
      {
        base: "https://api.example.test/v${{ vars.VERSION }}",
        auth: {
          headers: {
            Authorization: "Bearer ${{ secrets.API_TOKEN }}",
          },
        },
      },
    ],
  };

  const multiPathSegmentFirewall = {
    name: "multi-path-segment",
    apis: [
      {
        base: "https://api.example.test/accounts/${{ vars.A }}${{ vars.B }}/v1",
        auth: {
          headers: {
            Authorization: "Bearer ${{ secrets.API_TOKEN }}",
          },
        },
      },
    ],
  };

  const nonCredentialFirewall = {
    name: "diagnostic",
    apis: [
      {
        base: "${{ vars.DIAGNOSTIC_BASE_URL }}",
        auth: {},
      },
    ],
  };

  const providerOwnedWithFixedPortFirewall = {
    name: "provider-owned-port",
    apis: [
      {
        base: "https://${{ vars.API_HOST }}:444/v1",
        hostPolicy: {
          kind: "providerOwned" as const,
          suffixes: ["example.com"],
        },
        auth: {
          headers: {
            Authorization: "Bearer ${{ secrets.API_TOKEN }}",
          },
        },
      },
    ],
  };

  it("preserves static definitions and canonicalizes resolved runtime hosts", () => {
    const staticResult = resolveFirewallBaseUrlVars(
      [
        {
          name: "unicode-static",
          apis: [{ base: "https://☃.example/v1", auth: {} }],
        },
      ],
      undefined,
    );
    expect(staticResult[0]!.apis[0]!.base).toBe("https://☃.example/v1");

    const resolvedResult = resolveFirewallBaseUrlVars([zendeskFirewall], {
      ZENDESK_SUBDOMAIN: "münich",
    });
    expect(resolvedResult[0]!.apis[0]!.base).toBe(
      "https://xn--mnich-kva.zendesk.com",
    );
  });

  it("canonicalizes only hostname-bearing built-in variable values", () => {
    const result = canonicalizeFirewallBaseUrlVarsForExecution(
      [
        zendeskFirewall,
        strapiFirewall,
        embeddedHostFirewall,
        tenantPathFirewall,
      ],
      {
        ZENDESK_SUBDOMAIN: "münich",
        STRAPI_BASE_URL: "https://☃.example/v1",
        HOST_TENANT: "%55S-East",
        TENANT: "café",
      },
    );
    expect(result).toEqual({
      ZENDESK_SUBDOMAIN: "xn--mnich-kva",
      STRAPI_BASE_URL: "https://xn--n3h.example/v1",
      HOST_TENANT: "us-east",
      TENANT: "café",
    });
  });

  it("rejects encoded Unicode inside a built-in host label variable", () => {
    expect(() => {
      return canonicalizeFirewallBaseUrlVarsForExecution(
        [embeddedHostFirewall],
        { HOST_TENANT: "%C3%BC" },
      );
    }).toThrow("cannot use a non-ASCII value inside a host label");
  });

  it("rejects runtime-dependent raw and A-label variable values", () => {
    for (const STRAPI_BASE_URL of [
      "https://\u088f.example",
      "https://xn--7xb.example",
    ]) {
      expect(() => {
        return resolveFirewallBaseUrlVars([strapiFirewall], {
          STRAPI_BASE_URL,
        });
      }).toThrow("hostname policy vm0-uts46-16.0-v1");
    }
  });

  it("resolves template base URL with provided vars", () => {
    const result = resolveFirewallBaseUrlVars([zendeskFirewall], {
      ZENDESK_SUBDOMAIN: "mycompany",
    });
    expect(result[0]!.apis[0]!.base).toBe("https://mycompany.zendesk.com");
  });

  it("rejects fixed provider suffix variables that escape the authority", () => {
    expect(() => {
      return resolveFirewallBaseUrlVars([shopifyFirewall], {
        SHOPIFY_SHOP: "attacker.example:443/capture",
      });
    }).toThrow("base URL variable");
  });

  it("rejects fixed provider suffix variables with encoded URL structure", () => {
    expect(() => {
      return resolveFirewallBaseUrlVars([shopifyFirewall], {
        SHOPIFY_SHOP: "attacker.example%3A443%2Fcapture",
      });
    }).toThrow("base URL variable");
  });

  it("accepts multi-label fixed provider suffix values without URL structure", () => {
    const result = resolveFirewallBaseUrlVars([snowflakeFirewall], {
      SNOWFLAKE_ACCOUNT: "xy12345.us-east-1.aws",
    });
    expect(result[0]!.apis[0]!.base).toBe(
      "https://xy12345.us-east-1.aws.snowflakecomputing.com/api",
    );
  });

  it("rejects fixed provider suffix values that inject path syntax", () => {
    expect(() => {
      return resolveFirewallBaseUrlVars([snowflakeFirewall], {
        SNOWFLAKE_ACCOUNT: "xy12345.us-east-1.aws/capture",
      });
    }).toThrow("base URL variable");
  });

  it("accepts provider-owned whole authority template values", () => {
    const result = resolveFirewallBaseUrlVars([jiraFirewall], {
      JIRA_DOMAIN: "acme.atlassian.net",
    });
    expect(result[0]!.apis[0]!.base).toBe("https://acme.atlassian.net");
  });

  it("canonicalizes provider-owned whole authority values with trailing dots", () => {
    const result = resolveFirewallBaseUrlVars([jiraFirewall], {
      JIRA_DOMAIN: "acme.atlassian.net.",
    });
    expect(result[0]!.apis[0]!.base).toBe("https://acme.atlassian.net");
  });

  it("canonicalizes provider-owned whole authority IDNA dot equivalents", () => {
    const result = resolveFirewallBaseUrlVars([jiraFirewall], {
      JIRA_DOMAIN: "acme。atlassian。net",
    });
    expect(result[0]!.apis[0]!.base).toBe("https://acme.atlassian.net");
  });

  it("rejects provider-owned whole authority template values outside allowed hosts", () => {
    for (const JIRA_DOMAIN of [
      "attacker.example",
      "evil-atlassian.net",
      "atlassian.net.evil",
      "127.0.0.1",
    ]) {
      expect(() => {
        return resolveFirewallBaseUrlVars([jiraFirewall], {
          JIRA_DOMAIN,
        });
      }).toThrow("host policy does not allow resolved host");
    }
  });

  it("rejects provider-owned template bases with non-default ports", () => {
    expect(() => {
      return resolveFirewallBaseUrlVars([providerOwnedWithFixedPortFirewall], {
        API_HOST: "api.example.com",
      });
    }).toThrow("host policy does not allow non-default ports");
  });

  it("rejects whole authority template values with paths", () => {
    expect(() => {
      return resolveFirewallBaseUrlVars([jiraFirewall], {
        JIRA_DOMAIN: "attacker.example/capture",
      });
    }).toThrow("base URL variable");
  });

  it("rejects base URL variables that introduce firewall parameters", () => {
    expect(() => {
      return resolveFirewallBaseUrlVars([strapiFirewall], {
        STRAPI_BASE_URL: "https://{host}.example.test",
      });
    }).toThrow("base URL variable");
  });

  it("rejects base URL variables with Unicode whitespace", () => {
    expect(() => {
      return resolveFirewallBaseUrlVars([strapiFirewall], {
        STRAPI_BASE_URL: "https://strapi.example.test/work\u00a0flows",
      });
    }).toThrow("base URL variable");
  });

  it("preserves fixed path suffixes for whole base URL prefix templates", () => {
    const result = resolveFirewallBaseUrlVars([n8nFirewall], {
      N8N_BASE_URL: "https://n8n.example.test/workflows",
    });
    expect(result[0]!.apis[0]!.base).toBe(
      "https://n8n.example.test/workflows/api/v1",
    );
  });

  it("accepts encoded path separators in whole base URL prefix paths", () => {
    const result = resolveFirewallBaseUrlVars([n8nFirewall], {
      N8N_BASE_URL: "https://n8n.example.test/work%2fflows",
    });
    expect(result[0]!.apis[0]!.base).toBe(
      "https://n8n.example.test/work%2fflows/api/v1",
    );
  });

  it("rejects whole base URL prefix variables with path dot segments", () => {
    expect(() => {
      return resolveFirewallBaseUrlVars([n8nFirewall], {
        N8N_BASE_URL: "https://n8n.example.test/workflows/..",
      });
    }).toThrow("base URL variable");
  });

  it("rejects whole base URL prefix variables with encoded path dot segments", () => {
    expect(() => {
      return resolveFirewallBaseUrlVars([n8nFirewall], {
        N8N_BASE_URL: "https://n8n.example.test/workflows/%2e%2e",
      });
    }).toThrow("base URL variable");
  });

  it("accepts path segment variables without crossing path boundaries", () => {
    const result = resolveFirewallBaseUrlVars([tenantPathFirewall], {
      TENANT: "acme:prod",
    });
    expect(result[0]!.apis[0]!.base).toBe(
      "https://api.example.test/accounts/acme:prod/v1",
    );
  });

  it("rejects path segment variables that inject path structure", () => {
    expect(() => {
      return resolveFirewallBaseUrlVars([tenantPathFirewall], {
        TENANT: "acme/../admin",
      });
    }).toThrow("base URL variable");
  });

  it("rejects path segment variables with encoded path separators", () => {
    expect(() => {
      return resolveFirewallBaseUrlVars([tenantPathFirewall], {
        TENANT: "acme%2fprod",
      });
    }).toThrow("base URL variable");
    expect(() => {
      return resolveFirewallBaseUrlVars([tenantPathFirewall], {
        TENANT: "acme%252fprod",
      });
    }).toThrow("base URL variable");
  });

  it("rejects path segment variables that normalize as dot segments", () => {
    expect(() => {
      return resolveFirewallBaseUrlVars([tenantPathFirewall], {
        TENANT: "%2e%2e",
      });
    }).toThrow("base URL variable");
  });

  it("rejects path segment variables with path-parameter dot segments", () => {
    expect(() => {
      return resolveFirewallBaseUrlVars([tenantPathFirewall], {
        TENANT: "..;type=folder",
      });
    }).toThrow("base URL variable");
  });

  it("rejects path segment variables with nested encoded dot segments", () => {
    expect(() => {
      return resolveFirewallBaseUrlVars([tenantPathFirewall], {
        TENANT: "%252e%252e",
      });
    }).toThrow("base URL variable");
  });

  it("rejects path segment variables with compatibility dot segments", () => {
    expect(() => {
      return resolveFirewallBaseUrlVars([tenantPathFirewall], {
        TENANT: "\uff0e\uff0e",
      });
    }).toThrow("base URL variable");
  });

  it("accepts path variable dots that do not form dot segments", () => {
    const result = resolveFirewallBaseUrlVars([pathFragmentFirewall], {
      VERSION: "%2e1",
    });
    expect(result[0]!.apis[0]!.base).toBe("https://api.example.test/v%2e1");
  });

  it("rejects path variables that combine into dot segments", () => {
    expect(() => {
      return resolveFirewallBaseUrlVars([multiPathSegmentFirewall], {
        A: ".",
        B: ".",
      });
    }).toThrow("resolved base URL must not contain unsafe path segments");
  });

  it("accepts path variables that combine into safe segments", () => {
    const result = resolveFirewallBaseUrlVars([multiPathSegmentFirewall], {
      A: "v",
      B: "1",
    });
    expect(result[0]!.apis[0]!.base).toBe(
      "https://api.example.test/accounts/v1/v1",
    );
  });

  it("accepts authority port variables", () => {
    const result = resolveFirewallBaseUrlVars([portFirewall], {
      API_PORT: "8443",
    });
    expect(result[0]!.apis[0]!.base).toBe("https://api.example.test:8443/v1");
  });

  it("rejects authority port variables that are not numeric", () => {
    expect(() => {
      return resolveFirewallBaseUrlVars([portFirewall], {
        API_PORT: "443/path",
      });
    }).toThrow("base URL variable");
  });

  it("leaves static base URLs unchanged", () => {
    const result = resolveFirewallBaseUrlVars([staticFirewall], {
      ZENDESK_SUBDOMAIN: "mycompany",
    });
    expect(result[0]!.apis[0]!.base).toBe("https://api.github.com");
  });

  it("resolves mixed static and template firewalls", () => {
    const result = resolveFirewallBaseUrlVars(
      [staticFirewall, zendeskFirewall],
      { ZENDESK_SUBDOMAIN: "acme" },
    );
    expect(result[0]!.apis[0]!.base).toBe("https://api.github.com");
    expect(result[1]!.apis[0]!.base).toBe("https://acme.zendesk.com");
  });

  it("throws when required variable is missing", () => {
    expect(() => {
      return resolveFirewallBaseUrlVars([zendeskFirewall], {});
    }).toThrow('requires variable "ZENDESK_SUBDOMAIN"');
  });

  it("throws when vars is undefined", () => {
    expect(() => {
      return resolveFirewallBaseUrlVars([zendeskFirewall], undefined);
    }).toThrow('requires variable "ZENDESK_SUBDOMAIN"');
  });

  it("validates resolved URL is well-formed", () => {
    expect(() => {
      return resolveFirewallBaseUrlVars([zendeskFirewall], {
        ZENDESK_SUBDOMAIN: "bad value with spaces",
      });
    }).toThrow("must not contain whitespace");
  });

  it("rejects credentialed template base URLs that resolve to http", () => {
    expect(() => {
      return resolveFirewallBaseUrlVars([strapiFirewall], {
        STRAPI_BASE_URL: "http://strapi.example.test",
      });
    }).toThrow("credentialed base URL must use https");
  });

  it("accepts credentialed template base URLs that resolve to https", () => {
    const result = resolveFirewallBaseUrlVars([strapiFirewall], {
      STRAPI_BASE_URL: "https://strapi.example.test",
    });
    expect(result[0]!.apis[0]!.base).toBe("https://strapi.example.test");
  });

  it("accepts public-destination template base URLs with custom ports", () => {
    const result = resolveFirewallBaseUrlVars([strapiFirewall], {
      STRAPI_BASE_URL: "https://strapi.example.test:8443",
    });
    expect(result[0]!.apis[0]!.base).toBe("https://strapi.example.test:8443");
  });

  it("keeps generic http matching available for non-credential template bases", () => {
    const result = resolveFirewallBaseUrlVars([nonCredentialFirewall], {
      DIAGNOSTIC_BASE_URL: "http://diagnostic.example.test",
    });
    expect(result[0]!.apis[0]!.base).toBe("http://diagnostic.example.test");
  });

  it("preserves auth headers unchanged", () => {
    const result = resolveFirewallBaseUrlVars([zendeskFirewall], {
      ZENDESK_SUBDOMAIN: "mycompany",
    });
    expect(result[0]!.apis[0]!.auth.headers!.Authorization).toBe(
      "Bearer ${{ secrets.ZENDESK_API_TOKEN }}",
    );
  });

  it("returns empty array for empty input", () => {
    expect(resolveFirewallBaseUrlVars([], undefined)).toEqual([]);
  });
});

describe("firewallBaseUrlTemplateNeedsHostPolicy", () => {
  it("flags whole-host and whole-base dynamic templates", () => {
    expect(
      firewallBaseUrlTemplateNeedsHostPolicy("https://${{ vars.JIRA_DOMAIN }}"),
    ).toBe(true);
    expect(
      firewallBaseUrlTemplateNeedsHostPolicy("${{ vars.STRAPI_BASE_URL }}"),
    ).toBe(true);
    expect(
      firewallBaseUrlTemplateNeedsHostPolicy("${{ vars.N8N_BASE_URL }}/api/v1"),
    ).toBe(true);
    expect(
      firewallBaseUrlTemplateNeedsHostPolicy(
        "https://${{ vars.API_HOST }}:8443/v1",
      ),
    ).toBe(true);
    expect(
      firewallBaseUrlTemplateNeedsHostPolicy(
        "https://api.${{ vars.DOMAIN }}:8443/v1",
      ),
    ).toBe(true);
    expect(
      firewallBaseUrlTemplateNeedsHostPolicy(
        "https://api.${{ vars.DOMAIN }}/v1",
      ),
    ).toBe(true);
    expect(
      firewallBaseUrlTemplateNeedsHostPolicy("https://api-${{ vars.HOST }}/v1"),
    ).toBe(true);
    expect(
      firewallBaseUrlTemplateNeedsHostPolicy("https://${{ vars.HOST }}.com/v1"),
    ).toBe(true);
  });

  it("ignores fixed provider suffix and path-only dynamic templates", () => {
    expect(
      firewallBaseUrlTemplateNeedsHostPolicy(
        "https://${{ vars.ZENDESK_SUBDOMAIN }}.zendesk.com",
      ),
    ).toBe(false);
    expect(
      firewallBaseUrlTemplateNeedsHostPolicy(
        "https://${{ vars.TENANT }}.example.com:8443/v1",
      ),
    ).toBe(false);
    expect(
      firewallBaseUrlTemplateNeedsHostPolicy(
        "https://api.example.test/accounts/${{ vars.TENANT }}/v1",
      ),
    ).toBe(false);
  });
});
