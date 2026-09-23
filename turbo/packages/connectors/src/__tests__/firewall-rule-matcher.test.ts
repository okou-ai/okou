import { describe, it, expect } from "vitest";
import {
  matchFirewallHost,
  matchFirewallPath,
  matchFirewallPathPrefix,
  matchFirewallBaseUrl,
  findMatchingPermissions,
  matchFirewallRequestDecision,
} from "../firewall-rule-matcher";
import type { FirewallConfig } from "../firewall-types";

describe("matchFirewallPath", () => {
  it("matches exact literal path", () => {
    expect(matchFirewallPath("/api/v1/users", "/api/v1/users")).toEqual({});
  });

  it("matches single segment params", () => {
    expect(
      matchFirewallPath(
        "/repos/myorg/myrepo/pulls",
        "/repos/{owner}/{repo}/pulls",
      ),
    ).toEqual({ owner: "myorg", repo: "myrepo" });
  });

  it("captures hyphenated parameter names used by generated firewalls", () => {
    expect(
      matchFirewallPath("/v1/ingest/events", "/v1/ingest/{dataset-id}"),
    ).toEqual({
      "dataset-id": "events",
    });
  });

  it("matches greedy + (one or more)", () => {
    expect(
      matchFirewallPath(
        "/repos/a/b/git/ref/heads/main",
        "/repos/{owner}/{repo}/git/{rest+}",
      ),
    ).toEqual({ owner: "a", repo: "b", rest: "ref/heads/main" });
  });

  it("fails greedy + when no segments remain", () => {
    expect(
      matchFirewallPath("/repos/a/b/git", "/repos/{owner}/{repo}/git/{rest+}"),
    ).toBeNull();
  });

  it("fails greedy + when only empty segments remain", () => {
    expect(
      matchFirewallPath("/repos/a/b/git/", "/repos/{owner}/{repo}/git/{rest+}"),
    ).toBeNull();
    expect(
      matchFirewallPath(
        "/repos/a/b/git//",
        "/repos/{owner}/{repo}/git/{rest+}",
      ),
    ).toBeNull();
  });

  it("preserves empty segments before non-empty greedy + rest", () => {
    expect(
      matchFirewallPath(
        "/repos/a/b/git//heads/main",
        "/repos/{owner}/{repo}/git/{rest+}",
      ),
    ).toEqual({ owner: "a", repo: "b", rest: "/heads/main" });
  });

  it("rejects non-terminal greedy path params", () => {
    expect(matchFirewallPath("/api/a/b/tail", "/api/{rest+}/tail")).toBeNull();
    expect(matchFirewallPath("/api/a/b/tail", "/api/{rest*}/tail")).toBeNull();
  });

  it("matches greedy * (zero or more) with segments", () => {
    expect(matchFirewallPath("/anything/here", "/{path*}")).toEqual({
      path: "anything/here",
    });
  });

  it("matches greedy * with zero segments", () => {
    expect(matchFirewallPath("/", "/{path*}")).toEqual({ path: "" });
  });

  it("returns null on literal mismatch", () => {
    expect(matchFirewallPath("/api/v2/users", "/api/v1/users")).toBeNull();
  });

  it("returns null when path is too short", () => {
    expect(
      matchFirewallPath("/repos/myorg", "/repos/{owner}/{repo}/pulls"),
    ).toBeNull();
  });

  it("returns null when path is too long (no greedy)", () => {
    expect(
      matchFirewallPath(
        "/repos/myorg/myrepo/pulls/123",
        "/repos/{owner}/{repo}/pulls",
      ),
    ).toBeNull();
  });

  it("returns null on empty path vs non-empty pattern", () => {
    expect(matchFirewallPath("/", "/api/v1")).toBeNull();
  });

  it("treats trailing slashes as distinct path segments", () => {
    expect(matchFirewallPath("/api/v1/users/", "/api/v1/users")).toBeNull();
  });

  it("rejects empty path segments for single-segment params", () => {
    expect(matchFirewallPath("/repos//myrepo", "/repos/{owner}")).toBeNull();
    expect(matchFirewallPath("//repos/myorg", "/repos/{owner}")).toBeNull();
    expect(matchFirewallPath("/repos/myorg/", "/repos/{owner}")).toBeNull();
  });

  it("can match explicitly empty path segments", () => {
    expect(matchFirewallPath("/repos//myorg", "/repos//{owner}")).toEqual({
      owner: "myorg",
    });
  });

  it("handles multiple params in a row", () => {
    expect(
      matchFirewallPath(
        "/orgs/acme/insights/api/route-stats/user/42",
        "/orgs/{org}/insights/api/route-stats/{actor_type}/{actor_id}",
      ),
    ).toEqual({ org: "acme", actor_type: "user", actor_id: "42" });
  });
});

describe("matchFirewallHost", () => {
  it("matches host params case-insensitively", () => {
    expect(
      matchFirewallHost("ETH.G.ALCHEMY.COM", "{network}.g.alchemy.com"),
    ).toEqual({
      network: "eth",
    });
  });

  it("matches leading greedy host params", () => {
    expect(
      matchFirewallHost("foo.bar.bentoml.ai", "{deployment+}.bentoml.ai"),
    ).toEqual({ deployment: "foo.bar" });
  });

  it("preserves original case for leading greedy host params", () => {
    expect(
      matchFirewallHost("Foo.Bar.bentoml.ai", "{deployment+}.bentoml.ai"),
    ).toEqual({ deployment: "Foo.Bar" });
  });

  it("preserves original case for star-greedy leading host params", () => {
    expect(
      matchFirewallHost("Foo.Bar.bentoml.ai", "{deployment*}.bentoml.ai"),
    ).toEqual({ deployment: "Foo.Bar" });
  });

  it("requires a non-empty leading host for plus greedy params", () => {
    expect(
      matchFirewallHost("bentoml.ai", "{deployment+}.bentoml.ai"),
    ).toBeNull();
  });

  it("allows an empty leading host for star greedy params", () => {
    expect(matchFirewallHost("bentoml.ai", "{deployment*}.bentoml.ai")).toEqual(
      { deployment: "" },
    );
  });

  it("rejects non-leading greedy host params", () => {
    expect(
      matchFirewallHost("foo.bar.example.com", "foo.{deployment+}.com"),
    ).toBeNull();
    expect(
      matchFirewallHost("foo.bar.example.com", "foo.{deployment*}.com"),
    ).toBeNull();
  });

  it("preserves non-default ports in host matching", () => {
    expect(
      matchFirewallHost("api.example.com:8443", "api.example.com:8443"),
    ).toEqual({});
    expect(
      matchFirewallHost("api.example.com:9443", "api.example.com:8443"),
    ).toBeNull();
  });
});

describe("matchFirewallPathPrefix", () => {
  it("returns the full path for a root base prefix", () => {
    expect(matchFirewallPathPrefix("/v2/demo", "/")).toBe("/v2/demo");
  });

  it("returns slash when the path exactly matches the base prefix", () => {
    expect(matchFirewallPathPrefix("/api/v1", "/api/v1")).toBe("/");
  });

  it("returns relative path after literal base prefix", () => {
    expect(matchFirewallPathPrefix("/api/v1/users/123", "/api/v1")).toBe(
      "/users/123",
    );
  });

  it("preserves repeated slashes after the base prefix", () => {
    expect(matchFirewallPathPrefix("/api/v1//users", "/api/v1")).toBe(
      "//users",
    );
  });

  it("preserves non-terminal empty base path segments", () => {
    expect(matchFirewallPathPrefix("/api/v1//users", "/api/v1/")).toBe(
      "/users",
    );
  });

  it("returns relative path after parameterized base prefix", () => {
    expect(
      matchFirewallPathPrefix("/owner/repo/main/README.md", "/{owner}/{repo}"),
    ).toBe("/main/README.md");
  });

  it("rejects empty segments for plain params in base prefixes", () => {
    expect(
      matchFirewallPathPrefix("/owner//main", "/{owner}/{repo}"),
    ).toBeNull();
  });

  it("keeps base boundary strict", () => {
    expect(matchFirewallPathPrefix("/apiary/users", "/api")).toBeNull();
  });

  it("rejects non-terminal greedy path params", () => {
    expect(
      matchFirewallPathPrefix("/api/a/b/tail", "/api/{rest+}/tail"),
    ).toBeNull();
    expect(
      matchFirewallPathPrefix("/api/a/b/tail", "/api/{rest*}/tail"),
    ).toBeNull();
  });

  it("requires plus greedy path params to consume a non-empty segment", () => {
    expect(matchFirewallPathPrefix("/api", "/api/{rest+}")).toBeNull();
    expect(matchFirewallPathPrefix("/api/", "/api/{rest+}")).toBeNull();
  });

  it("allows plus greedy path params to consume remaining segments", () => {
    expect(matchFirewallPathPrefix("/api/users/123", "/api/{rest+}")).toBe("/");
  });

  it("allows star greedy path params to consume zero segments", () => {
    expect(matchFirewallPathPrefix("/api", "/api/{rest*}")).toBe("/");
    expect(matchFirewallPathPrefix("/api/users/123", "/api/{rest*}")).toBe("/");
  });
});

describe("matchFirewallBaseUrl", () => {
  it("matches normalized static authorities and strips query fragments", () => {
    expect(
      matchFirewallBaseUrl(
        "https://API.XERO.COM.:443/api.xro/2.0/Accounts?where=Name#ignored",
        "https://api.xero.com/api.xro/2.0",
      ),
    ).toEqual({
      displayBase: "https://api.xero.com/api.xro/2.0",
      relativePath: "/Accounts",
      score: expect.any(Number),
    });
  });

  it("matches case-insensitive schemes and normalized base authorities", () => {
    expect(
      matchFirewallBaseUrl(
        "HTTPS://API.GitHub.com/repos",
        "https://api.github.com.",
      ),
    ).toEqual({
      displayBase: "https://api.github.com.",
      relativePath: "/repos",
      score: expect.any(Number),
    });

    expect(
      matchFirewallBaseUrl(
        "https://api.github.com:8443/repos",
        "https://api.github.com.:08443",
      ),
    ).toEqual({
      displayBase: "https://api.github.com.:08443",
      relativePath: "/repos",
      score: expect.any(Number),
    });
  });

  it.each([
    [
      "runtime trailing host dot",
      "https://api.github.com./repos",
      "https://api.github.com",
    ],
    [
      "runtime leading-zero port",
      "https://api.github.com:08443/repos",
      "https://api.github.com:8443",
    ],
    [
      "canonical IPv6 spelling",
      "https://[2001:0db8::1]/repos",
      "https://[2001:db8::1]",
    ],
    [
      "IPv4-mapped IPv6 spelling",
      "https://[::ffff:127.0.0.1]/repos",
      "https://[::ffff:7f00:1]",
    ],
  ])("matches %s authority normalization", (_label, url, base) => {
    expect(matchFirewallBaseUrl(url, base)).toEqual({
      displayBase: base,
      relativePath: "/repos",
      score: expect.any(Number),
    });
  });

  it.each([
    [
      "punycode runtime with Unicode base",
      "https://xn--fsqu00a.xn--0zwm56d/repos",
      "https://例子.测试",
      "/repos",
    ],
    [
      "Unicode runtime with punycode base",
      "https://例子.测试/repos",
      "https://xn--fsqu00a.xn--0zwm56d",
      "/repos",
    ],
    [
      "parameterized Unicode base suffix",
      "https://api.xn--fsqu00a.xn--0zwm56d/api",
      "https://{sub}.例子.测试",
      "/api",
    ],
    [
      "parameterized punycode base suffix",
      "https://api.例子.测试/api",
      "https://{sub}.xn--fsqu00a.xn--0zwm56d",
      "/api",
    ],
    [
      "Unicode sharp-s runtime with punycode base",
      "https://faß.de/repos",
      "https://xn--fa-hia.de",
      "/repos",
    ],
    [
      "percent-encoded Unicode sharp-s runtime with punycode base",
      "https://fa%C3%9F.de/repos",
      "https://xn--fa-hia.de",
      "/repos",
    ],
    [
      "parameterized Unicode sharp-s runtime with punycode base",
      "https://api.faß.de/api",
      "https://{sub}.xn--fa-hia.de",
      "/api",
    ],
    [
      "parameterized percent-encoded Unicode sharp-s runtime with punycode base",
      "https://api.fa%C3%9F.de/api",
      "https://{sub}.xn--fa-hia.de",
      "/api",
    ],
    [
      "mathematical sigma runtime with punycode base",
      "https://𝛓.example/repos",
      "https://xn--4xa.example",
      "/repos",
    ],
    [
      "parameterized mathematical sigma runtime with punycode base",
      "https://api.𝛓.example/api",
      "https://{sub}.xn--4xa.example",
      "/api",
    ],
  ])(
    "matches IDNA-equivalent authorities for %s",
    (_label, url, base, relativePath) => {
      expect(matchFirewallBaseUrl(url, base)).toEqual({
        displayBase: base,
        relativePath,
        score: expect.any(Number),
      });
    },
  );

  it.each([
    ["Unicode-to-ASCII alias", "https://faß.de/repos", "https://fass.de"],
    ["ASCII-to-Unicode alias", "https://fass.de/repos", "https://faß.de"],
    [
      "Kelvin sign runtime alias",
      "https://K.example/repos",
      "https://k.example",
    ],
    ["Kelvin sign base alias", "https://k.example/repos", "https://K.example"],
    [
      "fullwidth Latin runtime alias",
      "https://Ａ.example/repos",
      "https://a.example",
    ],
    [
      "fullwidth Latin base alias",
      "https://a.example/repos",
      "https://Ａ.example",
    ],
    [
      "percent-encoded Kelvin sign runtime alias",
      "https://%E2%84%AA.example/repos",
      "https://k.example",
    ],
    [
      "percent-encoded fullwidth Latin runtime alias",
      "https://%EF%BC%A1.example/repos",
      "https://a.example",
    ],
    [
      "parameterized Kelvin sign runtime alias",
      "https://api.K.example/api",
      "https://{sub}.k.example",
    ],
    [
      "parameterized fullwidth Latin runtime alias",
      "https://api.Ａ.example/api",
      "https://{sub}.a.example",
    ],
    [
      "parameterized percent-encoded Kelvin sign runtime alias",
      "https://api.%E2%84%AA.example/api",
      "https://{sub}.k.example",
    ],
  ])("rejects unsafe IDNA compatibility alias for %s", (_label, url, base) => {
    expect(matchFirewallBaseUrl(url, base)).toBeNull();
  });

  it.each([
    ["opening brace", "https://api.github.com/static{"],
    ["closing brace", "https://api.github.com/static}"],
  ])("matches static base paths with a literal single %s", (_label, base) => {
    expect(matchFirewallBaseUrl(`${base}/repos`, base)).toEqual({
      displayBase: base,
      relativePath: "/repos",
      score: expect.any(Number),
    });
  });

  it.each([
    ["opening brace", "https://api.github.com/static{"],
    ["closing brace", "https://api.github.com/static}"],
  ])(
    "scores static literal single-%s path bases above root bases",
    (_label, base) => {
      const rootMatch = matchFirewallBaseUrl(
        `${base}/repos`,
        "https://api.github.com",
      );
      const braceMatch = matchFirewallBaseUrl(`${base}/repos`, base);

      expect(rootMatch).toMatchObject({
        displayBase: "https://api.github.com",
        relativePath: expect.stringMatching(/^\/static[{}]\/repos$/),
      });
      expect(braceMatch).toMatchObject({
        displayBase: base,
        relativePath: "/repos",
      });
      if (rootMatch === null || braceMatch === null) {
        throw new Error("expected both base URLs to match");
      }
      expect(braceMatch.score).toBeGreaterThan(rootMatch.score);
    },
  );

  it("matches parameterized path base URLs", () => {
    expect(
      matchFirewallBaseUrl(
        "https://raw.githubusercontent.com/owner/repo/main/README.md",
        "https://raw.githubusercontent.com/{owner}/{repo}",
      ),
    ).toEqual({
      displayBase: "https://raw.githubusercontent.com/{owner}/{repo}",
      relativePath: "/main/README.md",
      score: expect.any(Number),
    });
  });

  it("treats encoded slash as segment content in parameterized path bases", () => {
    expect(
      matchFirewallBaseUrl(
        "https://api.example.com/v1/acme%2Fteam/projects/123",
        "https://api.example.com/v1/{org}",
      ),
    ).toEqual({
      displayBase: "https://api.example.com/v1/{org}",
      relativePath: "/projects/123",
      score: expect.any(Number),
    });
  });

  it("matches parameterized host base URLs", () => {
    expect(
      matchFirewallBaseUrl(
        "https://ETH.G.ALCHEMY.COM/v2/demo",
        "https://{network}.g.alchemy.com",
      ),
    ).toEqual({
      displayBase: "https://{network}.g.alchemy.com",
      relativePath: "/v2/demo",
      score: expect.any(Number),
    });
  });

  it.each([
    [
      "base trailing host dot",
      "https://internal.example.com/v1/users",
      "https://{sub}.example.com.",
    ],
    [
      "runtime trailing host dot",
      "https://internal.example.com./v1/users",
      "https://{sub}.example.com",
    ],
    [
      "base leading-zero non-default port",
      "https://internal.example.com:8443/v1/users",
      "https://{sub}.example.com.:08443",
    ],
    [
      "runtime trailing host dot with non-default port",
      "https://internal.example.com.:8443/v1/users",
      "https://{sub}.example.com:8443",
    ],
  ])(
    "matches parameterized host base URLs with normalized authority: %s",
    (_label, url, base) => {
      expect(matchFirewallBaseUrl(url, base)).toEqual({
        displayBase: base,
        relativePath: "/v1/users",
        score: expect.any(Number),
      });
    },
  );

  it("scores static host bases above wildcard host bases with the same path scope", () => {
    const staticMatch = matchFirewallBaseUrl(
      "https://api.g.alchemy.com/v2/demo",
      "https://api.g.alchemy.com",
    );
    const wildcardMatch = matchFirewallBaseUrl(
      "https://api.g.alchemy.com/v2/demo",
      "https://{network}.g.alchemy.com",
    );

    expect(staticMatch).toMatchObject({
      displayBase: "https://api.g.alchemy.com",
      relativePath: "/v2/demo",
    });
    expect(wildcardMatch).toMatchObject({
      displayBase: "https://{network}.g.alchemy.com",
      relativePath: "/v2/demo",
    });
    if (staticMatch === null || wildcardMatch === null) {
      throw new Error("expected both base URLs to match");
    }
    expect(staticMatch.score).toBeGreaterThan(wildcardMatch.score);
  });

  it("scores longer path bases above root bases even when the longer path has params", () => {
    const rootMatch = matchFirewallBaseUrl(
      "https://api.example.com/v1/acme/projects",
      "https://api.example.com",
    );
    const pathMatch = matchFirewallBaseUrl(
      "https://api.example.com/v1/acme/projects",
      "https://api.example.com/v1/{org}",
    );

    expect(rootMatch).toMatchObject({
      displayBase: "https://api.example.com",
      relativePath: "/v1/acme/projects",
    });
    expect(pathMatch).toMatchObject({
      displayBase: "https://api.example.com/v1/{org}",
      relativePath: "/projects",
    });
    if (rootMatch === null || pathMatch === null) {
      throw new Error("expected both base URLs to match");
    }
    expect(pathMatch.score).toBeGreaterThan(rootMatch.score);
  });

  it("returns slash when URL exactly matches the base URL", () => {
    expect(
      matchFirewallBaseUrl(
        "https://api.github.com?per_page=1#ignored",
        "https://api.github.com",
      ),
    ).toEqual({
      displayBase: "https://api.github.com",
      relativePath: "/",
      score: expect.any(Number),
    });
  });

  it("keeps repeated root base slashes as a path boundary", () => {
    const rootMatch = matchFirewallBaseUrl(
      "https://api.example.com//users",
      "https://api.example.com",
    );
    const repeatedRootMatch = matchFirewallBaseUrl(
      "https://api.example.com//users",
      "https://api.example.com//",
    );

    expect(
      matchFirewallBaseUrl(
        "https://api.example.com/users",
        "https://api.example.com//",
      ),
    ).toBeNull();

    expect(
      matchFirewallBaseUrl(
        "https://api.example.com//users",
        "https://api.example.com//",
      ),
    ).toEqual({
      displayBase: "https://api.example.com/",
      relativePath: "/users",
      score: expect.any(Number),
    });

    expect(rootMatch).toMatchObject({
      displayBase: "https://api.example.com",
      relativePath: "//users",
    });
    if (rootMatch === null || repeatedRootMatch === null) {
      throw new Error("expected both base URLs to match");
    }
    expect(repeatedRootMatch.score).toBeGreaterThan(rootMatch.score);
  });

  it("treats a single trailing base slash as optional", () => {
    expect(
      matchFirewallBaseUrl(
        "https://api.example.com/api/users",
        "https://api.example.com/api/",
      ),
    ).toEqual({
      displayBase: "https://api.example.com/api",
      relativePath: "/users",
      score: expect.any(Number),
    });
  });

  it("matches greedy parameterized host base URLs", () => {
    expect(
      matchFirewallBaseUrl(
        "https://foo.bar.bentoml.ai/api/v1/models",
        "https://{deployment+}.bentoml.ai",
      ),
    ).toEqual({
      displayBase: "https://{deployment+}.bentoml.ai",
      relativePath: "/api/v1/models",
      score: expect.any(Number),
    });
  });

  it("allows star-greedy host bases to match an empty leading host", () => {
    expect(
      matchFirewallBaseUrl(
        "https://bentoml.ai/api/v1/models",
        "https://{deployment*}.bentoml.ai",
      ),
    ).toEqual({
      displayBase: "https://{deployment*}.bentoml.ai",
      relativePath: "/api/v1/models",
      score: expect.any(Number),
    });
  });

  it("treats explicit default base ports as equivalent to omitted ports", () => {
    expect(
      matchFirewallBaseUrl(
        "https://api.example.com/v1/users",
        "https://api.example.com:443",
      ),
    ).toEqual({
      displayBase: "https://api.example.com:443",
      relativePath: "/v1/users",
      score: expect.any(Number),
    });

    expect(
      matchFirewallBaseUrl(
        "http://api.example.com/v1/users",
        "http://api.example.com:80",
      ),
    ).toEqual({
      displayBase: "http://api.example.com:80",
      relativePath: "/v1/users",
      score: expect.any(Number),
    });
  });

  it.each([
    [
      "https base includes default port",
      "https://internal.example.com/v1/users",
      "https://{sub}.example.com:443",
    ],
    [
      "https runtime includes default port",
      "https://internal.example.com:443/v1/users",
      "https://{sub}.example.com",
    ],
    [
      "http base includes default port",
      "http://internal.example.com/v1/users",
      "http://{sub}.example.com:80",
    ],
    [
      "http runtime includes default port",
      "http://internal.example.com:80/v1/users",
      "http://{sub}.example.com",
    ],
  ])(
    "treats explicit default ports as equivalent for parameterized host bases: %s",
    (_label, url, base) => {
      expect(matchFirewallBaseUrl(url, base)).toEqual({
        displayBase: base,
        relativePath: "/v1/users",
        score: expect.any(Number),
      });
    },
  );

  it("matches IPv6 base URLs with normalized default ports", () => {
    expect(
      matchFirewallBaseUrl(
        "https://[2001:db8::1]/v1/users",
        "https://[2001:db8::1]:443",
      ),
    ).toEqual({
      displayBase: "https://[2001:db8::1]:443",
      relativePath: "/v1/users",
      score: expect.any(Number),
    });
  });

  it("matches explicit non-default base ports only on the same port", () => {
    expect(
      matchFirewallBaseUrl(
        "https://api.example.com:8443/v1/users",
        "https://api.example.com:8443",
      ),
    ).toEqual({
      displayBase: "https://api.example.com:8443",
      relativePath: "/v1/users",
      score: expect.any(Number),
    });

    expect(
      matchFirewallBaseUrl(
        "https://api.example.com/v1/users",
        "https://api.example.com:8443",
      ),
    ).toBeNull();
  });

  it("matches parameterized host base URLs with explicit non-default ports only on the same port", () => {
    expect(
      matchFirewallBaseUrl(
        "https://internal.example.com:8443/v1/users",
        "https://{sub}.example.com:8443",
      ),
    ).toEqual({
      displayBase: "https://{sub}.example.com:8443",
      relativePath: "/v1/users",
      score: expect.any(Number),
    });

    expect(
      matchFirewallBaseUrl(
        "https://internal.example.com/v1/users",
        "https://{sub}.example.com:8443",
      ),
    ).toBeNull();
  });

  it("keeps static base path boundaries strict", () => {
    expect(
      matchFirewallBaseUrl(
        "https://slack.com/apix/chat.postMessage",
        "https://slack.com/api",
      ),
    ).toBeNull();
  });

  it("requires runtime URLs to use the same scheme as the base URL", () => {
    expect(
      matchFirewallBaseUrl(
        "http://api.github.com/repos/owner/repo",
        "https://api.github.com",
      ),
    ).toBeNull();
  });

  it("does not collapse repeated trailing base slashes", () => {
    expect(
      matchFirewallBaseUrl(
        "https://api.example.com/api/users",
        "https://api.example.com/api//",
      ),
    ).toBeNull();

    expect(
      matchFirewallBaseUrl(
        "https://api.example.com/api//users",
        "https://api.example.com/api//",
      ),
    ).toEqual({
      displayBase: "https://api.example.com/api/",
      relativePath: "/users",
      score: expect.any(Number),
    });
  });

  it("keeps base path matching case-sensitive and byte-oriented", () => {
    expect(
      matchFirewallBaseUrl(
        "https://api.example.com/API/users",
        "https://api.example.com/api",
      ),
    ).toBeNull();

    expect(
      matchFirewallBaseUrl(
        "https://api.example.com/api%2Fv1/users",
        "https://api.example.com/api/v1",
      ),
    ).toBeNull();
  });

  it("does not collapse empty segments inside parameterized base paths", () => {
    expect(
      matchFirewallBaseUrl(
        "https://api.example.com/v1//acme/projects",
        "https://api.example.com/v1/{org}",
      ),
    ).toBeNull();

    expect(
      matchFirewallBaseUrl(
        "https://api.example.com/v1/acme//projects",
        "https://api.example.com/v1/{org}",
      ),
    ).toEqual({
      displayBase: "https://api.example.com/v1/{org}",
      relativePath: "//projects",
      score: expect.any(Number),
    });

    expect(
      matchFirewallBaseUrl(
        "https://api.example.com/v1/acme/projects",
        "https://api.example.com/v1//{org}",
      ),
    ).toBeNull();

    expect(
      matchFirewallBaseUrl(
        "https://api.example.com/v1//acme/projects",
        "https://api.example.com/v1//{org}",
      ),
    ).toEqual({
      displayBase: "https://api.example.com/v1//{org}",
      relativePath: "/projects",
      score: expect.any(Number),
    });
  });

  it.each([
    ["raw whitespace", "https://api.github.com/foo bar"],
    ["path backslash", "https://api.github.com/repos\\owner/repo"],
    ["authority backslash", "https://api.github.com\\repos/owner/repo"],
    ["scheme backslash", "https:\\api.github.com/repos/owner/repo"],
    ["single-slash scheme delimiter", "https:/api.github.com/repos/owner/repo"],
    ["missing scheme delimiter", "https:api.github.com/repos/owner/repo"],
    ["userinfo", "https://user:pass@api.github.com/repos/owner/repo"],
    ["invalid authority percent escape", "https://api%zz.github.com/repos"],
    ["percent-encoded authority dot", "https://api%2egithub.com/repos"],
    ["percent-encoded authority wildcard", "https://api%2Agithub.com/repos"],
    ["percent-encoded authority slash", "https://api%2Fgithub.com/repos"],
    ["percent-encoded authority backslash", "https://api%5Cgithub.com/repos"],
    ["percent-encoded authority at sign", "https://api%40github.com/repos"],
    [
      "percent-encoded authority dot after scheme backslash",
      "https:\\api%2egithub.com/repos",
    ],
    ["malformed IPv6 authority", "https://[::1/repos"],
    ["empty port", "https://api.github.com:/repos"],
    ["non-default port", "https://api.github.com:8443/repos"],
  ])("rejects runtime URLs with %s", (_label, url) => {
    expect(matchFirewallBaseUrl(url, "https://api.github.com")).toBeNull();
  });

  it.each([
    [
      "empty host label",
      "https://.g.alchemy.com/v2/demo",
      "https://{network}.g.alchemy.com",
    ],
    [
      "raw host braces",
      "https://{eth}.g.alchemy.com/v2/demo",
      "https://{network}.g.alchemy.com",
    ],
    [
      "raw host comma",
      "https://eth,mainnet.g.alchemy.com/v2/demo",
      "https://{network}.g.alchemy.com",
    ],
    [
      "raw host wildcard",
      "https://*.g.alchemy.com/v2/demo",
      "https://{network}.g.alchemy.com",
    ],
    [
      "mixed raw host wildcard",
      "https://api*.g.alchemy.com/v2/demo",
      "https://{network}.g.alchemy.com",
    ],
    [
      "percent-encoded host comma",
      "https://eth%2Cmainnet.g.alchemy.com/v2/demo",
      "https://{network}.g.alchemy.com",
    ],
    [
      "percent-encoded host braces",
      "https://%7Beth%7D.g.alchemy.com/v2/demo",
      "https://{network}.g.alchemy.com",
    ],
    [
      "percent-encoded authority colon",
      "https://api.github.com%3A443/repos",
      "https://api.github.com",
    ],
    [
      "percent-encoded authority slash",
      "https://api%2Fgithub.com/repos",
      "https://api.github.com",
    ],
    [
      "percent-encoded authority backslash",
      "https://api%5Cgithub.com/repos",
      "https://api.github.com",
    ],
    [
      "percent-encoded authority at sign",
      "https://api%40github.com/repos",
      "https://api.github.com",
    ],
    [
      "non-canonical IPv4 octal component",
      "https://0177.0.0.1/repos",
      "https://127.0.0.1",
    ],
    [
      "non-canonical IPv4 hex component",
      "https://0x7f.0.0.1/repos",
      "https://127.0.0.1",
    ],
    [
      "non-canonical IPv4 single number",
      "https://2130706433/repos",
      "https://127.0.0.1",
    ],
    [
      "non-canonical IPv4 short form",
      "https://127.1/repos",
      "https://127.0.0.1",
    ],
    [
      "IPv4 with Unicode dot equivalents",
      "https://127。0。0。1/repos",
      "https://127.0.0.1",
    ],
    [
      "multiple trailing host dots",
      "https://api.github.com../repos",
      "https://api.github.com",
    ],
  ])(
    "rejects runtime URLs with %s before host matching",
    (_label, url, base) => {
      expect(matchFirewallBaseUrl(url, base)).toBeNull();
    },
  );

  it("rejects malformed base URLs without string-prefix fallback", () => {
    expect(
      matchFirewallBaseUrl("https://api.github.com/repos", "https://[::1"),
    ).toBeNull();
  });

  it.each([
    ["query string", "https://api.github.com?token=1"],
    ["fragment", "https://api.github.com#fragment"],
    ["backslash", "https://api.github.com\\repos"],
    ["userinfo", "https://user:pass@api.github.com"],
    ["invalid percent escape", "https://api%zz.github.com"],
    ["percent-encoded braces", "https://%7Benv%7D.github.com"],
    ["percent-encoded dot", "https://api%2egithub.com"],
    ["percent-encoded wildcard", "https://api%2Agithub.com"],
    ["percent-encoded comma", "https://api%2Cgithub.com"],
    ["empty port", "https://api.github.com:"],
    ["non-canonical IPv4 octal component", "https://0177.0.0.1"],
    ["non-canonical IPv4 hex component", "https://0x7f.0.0.1"],
    ["non-canonical IPv4 single number", "https://2130706433"],
    ["non-canonical IPv4 short form", "https://127.1"],
    ["IPv4 with Unicode dot equivalents", "https://127。0。0。1"],
  ])("rejects base URLs with %s", (_label, base) => {
    expect(
      matchFirewallBaseUrl("https://api.github.com/repos", base),
    ).toBeNull();
  });

  it.each([
    ["whole URL template", "${{ vars.N8N_BASE_URL }}/api/v1"],
    [
      "host segment template",
      "https://${{ vars.FRESHDESK_DOMAIN }}.freshdesk.com",
    ],
  ])("does not reverse-match %s base URLs", (_label, base) => {
    expect(
      matchFirewallBaseUrl("https://example.com/api/v1/users", base),
    ).toBeNull();
  });
});

describe("findMatchingPermissions", () => {
  const config: FirewallConfig = {
    name: "test-firewall",
    apis: [
      {
        base: "https://api.example.com",
        auth: { headers: { Authorization: "Bearer token" } },
        permissions: [
          {
            name: "repos:read",
            rules: [
              "GET /repos/{owner}/{repo}",
              "GET /repos/{owner}/{repo}/pulls",
            ],
          },
          {
            name: "repos:write",
            rules: ["POST /repos/{owner}/{repo}/pulls"],
          },
          {
            name: "issues:read",
            rules: ["GET /repos/{owner}/{repo}/issues"],
          },
        ],
      },
    ],
  };

  it("finds matching permission for GET request", () => {
    expect(
      findMatchingPermissions("GET", "/repos/myorg/myrepo/pulls", config),
    ).toEqual(["repos:read"]);
  });

  it("finds matching permission for POST request", () => {
    expect(
      findMatchingPermissions("POST", "/repos/myorg/myrepo/pulls", config),
    ).toEqual(["repos:write"]);
  });

  it("returns empty array when method does not match", () => {
    expect(
      findMatchingPermissions("DELETE", "/repos/myorg/myrepo/pulls", config),
    ).toEqual([]);
  });

  it("returns empty array when path does not match", () => {
    expect(
      findMatchingPermissions("GET", "/repos/myorg/myrepo/comments", config),
    ).toEqual([]);
  });

  it("handles case-insensitive method matching", () => {
    expect(
      findMatchingPermissions("get", "/repos/myorg/myrepo/pulls", config),
    ).toEqual(["repos:read"]);
  });

  it("ignores rule methods that are not valid uppercase firewall methods", () => {
    const malformedMethodConfig: FirewallConfig = {
      name: "malformed-method",
      apis: [
        {
          base: "https://example.com",
          auth: { headers: {} },
          permissions: [
            { name: "lowercase", rules: ["get /data"] },
            { name: "unknown", rules: ["BREW /data"] },
          ],
        },
      ],
    };
    expect(
      findMatchingPermissions("GET", "/data", malformedMethodConfig),
    ).toEqual([]);
    expect(
      findMatchingPermissions("BREW", "/data", malformedMethodConfig),
    ).toEqual([]);
  });

  it("ignores rule paths that fail firewall validation", () => {
    const malformedPathConfig: FirewallConfig = {
      name: "malformed-path",
      apis: [
        {
          base: "https://example.com",
          auth: { headers: {} },
          permissions: [
            { name: "missing-slash", rules: ["GET data"] },
            { name: "query", rules: ["GET /data?debug=1"] },
            { name: "fragment", rules: ["GET /data#section"] },
            { name: "backslash", rules: ["GET /data\\debug"] },
            { name: "whitespace", rules: ["GET /space path"] },
            { name: "control", rules: ["GET /data\x00debug"] },
            { name: "duplicate-param", rules: ["GET /items/{id}/{id}"] },
          ],
        },
      ],
    };
    expect(
      findMatchingPermissions("GET", "/data", malformedPathConfig),
    ).toEqual([]);
    expect(
      findMatchingPermissions("GET", "/data?debug=1", malformedPathConfig),
    ).toEqual([]);
    expect(
      findMatchingPermissions("GET", "/data#section", malformedPathConfig),
    ).toEqual([]);
    expect(
      findMatchingPermissions("GET", "/data\\debug", malformedPathConfig),
    ).toEqual([]);
    expect(
      findMatchingPermissions("GET", "/space path", malformedPathConfig),
    ).toEqual([]);
    expect(
      findMatchingPermissions("GET", "/data\x00debug", malformedPathConfig),
    ).toEqual([]);
    expect(
      findMatchingPermissions("GET", "/items/a/b", malformedPathConfig),
    ).toEqual([]);
  });

  it("ignores permission names that fail firewall validation", () => {
    const malformedPermissionConfig: FirewallConfig = {
      name: "malformed-permission",
      apis: [
        {
          base: "https://example.com",
          auth: { headers: {} },
          permissions: [
            { name: "", rules: ["GET /empty"] },
            { name: "all", rules: ["GET /all"] },
            { name: "read", rules: ["GET /items/{id}"] },
            { name: "read", rules: ["DELETE /items/{id}"] },
          ],
        },
      ],
    };
    expect(
      findMatchingPermissions("GET", "/empty", malformedPermissionConfig),
    ).toEqual([]);
    expect(
      findMatchingPermissions("GET", "/all", malformedPermissionConfig),
    ).toEqual([]);
    expect(
      findMatchingPermissions("GET", "/items/1", malformedPermissionConfig),
    ).toEqual(["read"]);
    expect(
      findMatchingPermissions("DELETE", "/items/1", malformedPermissionConfig),
    ).toEqual([]);
  });

  it("ignores empty firewall names that fail firewall validation", () => {
    const malformedNameConfig: FirewallConfig = {
      name: "",
      apis: [
        {
          base: "https://example.com",
          auth: { headers: {} },
          permissions: [{ name: "read", rules: ["GET /items/{id}"] }],
        },
      ],
    };
    expect(
      findMatchingPermissions("GET", "/items/1", malformedNameConfig),
    ).toEqual([]);
  });

  it("accepts awsSigv4 auth configs", () => {
    const config: FirewallConfig = {
      name: "aws",
      apis: [
        {
          base: "https://sts.amazonaws.com",
          auth: {
            headers: {},
            awsSigv4: {
              accessKeyId: "${{ secrets.AWS_ACCESS_KEY_ID }}",
              secretAccessKey: "${{ secrets.AWS_SECRET_ACCESS_KEY }}",
              sessionToken: "${{ secrets.AWS_SESSION_TOKEN }}",
            },
          },
          permissions: [{ name: "identity", rules: ["GET /"] }],
        },
      ],
    };

    expect(findMatchingPermissions("GET", "/", config)).toEqual(["identity"]);
  });

  it("ignores malformed awsSigv4 auth configs", () => {
    const config: FirewallConfig = {
      name: "aws",
      apis: [
        {
          base: "https://sts.amazonaws.com",
          auth: {
            headers: {
              Authorization: "Bearer ${{ secrets.TOKEN }}",
            },
            awsSigv4: {
              accessKeyId: "${{ secrets.AWS_ACCESS_KEY_ID }}",
              secretAccessKey: "${{ secrets.AWS_SECRET_ACCESS_KEY }}",
            },
          },
          permissions: [{ name: "mixed", rules: ["GET /"] }],
        },
        {
          base: "https://iam.amazonaws.com",
          auth: {
            headers: {},
            awsSigv4: {
              accessKeyId: "${{ secrets.AWS_ACCESS_KEY_ID }}",
              secretAccessKey: "",
            },
          },
          permissions: [{ name: "missing", rules: ["GET /"] }],
        },
      ],
    };

    expect(findMatchingPermissions("GET", "/", config)).toEqual([]);
  });

  it("ignores awsSigv4 auth configs with unsupported defaults", () => {
    const config = {
      name: "aws",
      apis: [
        {
          base: "https://sts.amazonaws.com",
          auth: {
            awsSigv4: {
              accessKeyId: "${{ secrets.AWS_ACCESS_KEY_ID }}",
              secretAccessKey: "${{ secrets.AWS_SECRET_ACCESS_KEY }}",
              defaultRegion: "${{ vars.AWS_REGION }}",
            },
          },
          permissions: [{ name: "identity", rules: ["GET /"] }],
        },
      ],
    };

    expect(findMatchingPermissions("GET", "/", config)).toEqual([]);
  });

  it("ignores malformed top-level firewall shapes", () => {
    const nullConfig = null;
    const arrayConfig: unknown[] = [];
    const nonStringNameConfig = {
      name: 123,
      apis: [
        {
          base: "https://example.com",
          auth: { headers: {} },
          permissions: [{ name: "read", rules: ["GET /items/{id}"] }],
        },
      ],
    };
    const nonArrayApisConfig = {
      name: "malformed-apis",
      apis: { base: "https://example.com" },
    };

    expect(findMatchingPermissions("GET", "/items/1", nullConfig)).toEqual([]);
    expect(findMatchingPermissions("GET", "/items/1", arrayConfig)).toEqual([]);
    expect(
      findMatchingPermissions("GET", "/items/1", nonStringNameConfig),
    ).toEqual([]);
    expect(
      findMatchingPermissions("GET", "/items/1", nonArrayApisConfig),
    ).toEqual([]);
  });

  it("ignores API entries that fail base or auth validation", () => {
    const malformedApiConfig = {
      name: "malformed-api",
      apis: [
        {
          base: "https://example.com?token=1",
          auth: { headers: {} },
          permissions: [{ name: "query-base", rules: ["GET /items/{id}"] }],
        },
        {
          base: "ftp://example.com",
          auth: { headers: {} },
          permissions: [{ name: "bad-scheme", rules: ["GET /items/{id}"] }],
        },
        {
          base: "https://auth.example.com",
          auth: { base: "ftp://auth.example.com/token" },
          permissions: [{ name: "bad-auth", rules: ["GET /items/{id}"] }],
        },
        {
          base: "https://cleartext-auth.example.com",
          auth: { base: "http://auth.example.com/token" },
          permissions: [{ name: "cleartext-auth", rules: ["GET /items/{id}"] }],
        },
        {
          base: "https://valid.example.com",
          auth: { headers: {} },
          permissions: [{ name: "valid", rules: ["GET /items/{id}"] }],
        },
      ],
    };

    expect(
      findMatchingPermissions("GET", "/items/1", malformedApiConfig),
    ).toEqual(["valid"]);
    expect(
      findMatchingPermissions("GET", "/items/1", malformedApiConfig, {
        apiBase: "https://example.com?token=1",
      }),
    ).toEqual([]);
    expect(
      findMatchingPermissions("GET", "/items/1", malformedApiConfig, {
        apiBase: "https://auth.example.com",
      }),
    ).toEqual([]);
    expect(
      findMatchingPermissions("GET", "/items/1", malformedApiConfig, {
        apiBase: "https://cleartext-auth.example.com",
      }),
    ).toEqual([]);
  });

  it("ignores API entries with malformed auth shapes", () => {
    const malformedApiConfig = {
      name: "malformed-api-shape",
      apis: [
        "not-an-api",
        {
          auth: { headers: {} },
          permissions: [{ name: "missing-base", rules: ["GET /items/{id}"] }],
        },
        {
          base: "https://missing-auth.example.com",
          permissions: [{ name: "missing-auth", rules: ["GET /items/{id}"] }],
        },
        {
          base: "https://string-auth.example.com",
          auth: "token",
          permissions: [{ name: "string-auth", rules: ["GET /items/{id}"] }],
        },
        {
          base: "https://bad-headers.example.com",
          auth: { headers: { Authorization: 123 } },
          permissions: [{ name: "bad-headers", rules: ["GET /items/{id}"] }],
        },
        {
          base: "https://date-headers.example.com",
          auth: { headers: new Date() },
          permissions: [{ name: "date-headers", rules: ["GET /items/{id}"] }],
        },
        {
          base: "https://bad-auth-base.example.com",
          auth: { base: 123 },
          permissions: [{ name: "bad-auth-base", rules: ["GET /items/{id}"] }],
        },
        {
          base: "https://bad-query.example.com",
          auth: { query: { api_key: 123 } },
          permissions: [{ name: "bad-query", rules: ["GET /items/{id}"] }],
        },
        {
          base: "https://date-query.example.com",
          auth: { query: new Date() },
          permissions: [{ name: "date-query", rules: ["GET /items/{id}"] }],
        },
        {
          base: "https://valid.example.com",
          auth: { headers: {} },
          permissions: [{ name: "valid", rules: ["GET /items/{id}"] }],
        },
      ],
    };

    expect(
      findMatchingPermissions("GET", "/items/1", malformedApiConfig),
    ).toEqual(["valid"]);
    expect(
      findMatchingPermissions("GET", "/items/1", malformedApiConfig, {
        apiBase: "https://missing-auth.example.com",
      }),
    ).toEqual([]);
  });

  it("ignores malformed permission shapes while keeping valid rules", () => {
    const malformedPermissionConfig = {
      name: "malformed-permission-shape",
      apis: [
        {
          base: "https://ignored.example.com",
          auth: { headers: {} },
          permissions: "read",
        },
        {
          base: "https://example.com",
          auth: { headers: {} },
          permissions: [
            "not-a-permission",
            { rules: ["GET /missing-name"] },
            { name: 123, rules: ["GET /non-string-name"] },
            { name: "missing-rules" },
            { name: "missing-rules", rules: ["GET /missing-rules"] },
            { name: "string-rules", rules: "GET /string-rules" },
            { name: "string-rules", rules: ["GET /string-rules"] },
            { name: "empty-rules", rules: [] },
            { name: "empty-rules", rules: ["GET /empty-rules"] },
            { name: "invalid-rule", rules: ["BREW /invalid-rule"] },
            { name: "invalid-rule", rules: ["GET /invalid-rule"] },
            { name: "non-string-rule", rules: [123] },
            { name: "non-string-rule", rules: ["GET /non-string-rule"] },
            {
              name: "valid-after-invalid-rule",
              rules: [
                "BREW /valid-after-invalid-rule",
                "GET /valid-after-invalid-rule",
              ],
            },
            {
              name: "valid-after-non-string-rule",
              rules: [123, "GET /valid-after-non-string-rule"],
            },
            { name: "mixed-rules", rules: ["GET /mixed", 123] },
            { name: "valid", rules: ["GET /items/{id}"] },
          ],
        },
      ],
    };

    expect(
      findMatchingPermissions("GET", "/items/1", malformedPermissionConfig),
    ).toEqual(["valid"]);
    expect(
      findMatchingPermissions("GET", "/mixed", malformedPermissionConfig),
    ).toEqual(["mixed-rules"]);
    expect(
      findMatchingPermissions(
        "GET",
        "/string-rules",
        malformedPermissionConfig,
      ),
    ).toEqual([]);
    expect(
      findMatchingPermissions(
        "GET",
        "/missing-rules",
        malformedPermissionConfig,
      ),
    ).toEqual([]);
    expect(
      findMatchingPermissions("GET", "/empty-rules", malformedPermissionConfig),
    ).toEqual([]);
    expect(
      findMatchingPermissions(
        "GET",
        "/invalid-rule",
        malformedPermissionConfig,
      ),
    ).toEqual([]);
    expect(
      findMatchingPermissions(
        "GET",
        "/non-string-rule",
        malformedPermissionConfig,
      ),
    ).toEqual([]);
    expect(
      findMatchingPermissions(
        "GET",
        "/valid-after-invalid-rule",
        malformedPermissionConfig,
      ),
    ).toEqual(["valid-after-invalid-rule"]);
    expect(
      findMatchingPermissions(
        "GET",
        "/valid-after-non-string-rule",
        malformedPermissionConfig,
      ),
    ).toEqual(["valid-after-non-string-rule"]);
  });

  it("matches ANY method rule", () => {
    const anyConfig: FirewallConfig = {
      name: "any-test",
      apis: [
        {
          base: "https://example.com",
          auth: { headers: {} },
          permissions: [{ name: "full-access", rules: ["ANY /{path*}"] }],
        },
      ],
    };
    expect(findMatchingPermissions("GET", "/anything/here", anyConfig)).toEqual(
      ["full-access"],
    );
    expect(findMatchingPermissions("POST", "/other", anyConfig)).toEqual([
      "full-access",
    ]);
  });

  it("returns only the most-specific permission when rules overlap", () => {
    const overlapConfig: FirewallConfig = {
      name: "overlap",
      apis: [
        {
          base: "https://example.com",
          auth: { headers: {} },
          permissions: [
            { name: "specific", rules: ["GET /api/users"] },
            { name: "catchall", rules: ["ANY /{path*}"] },
          ],
        },
      ],
    };
    expect(findMatchingPermissions("GET", "/api/users", overlapConfig)).toEqual(
      ["specific"],
    );
  });

  it("returns multiple permissions when best-specificity rules tie", () => {
    const overlapConfig: FirewallConfig = {
      name: "overlap",
      apis: [
        {
          base: "https://example.com",
          auth: { headers: {} },
          permissions: [
            { name: "read", rules: ["GET /api/users"] },
            { name: "audit", rules: ["ANY /api/users"] },
            { name: "catchall", rules: ["ANY /{path*}"] },
          ],
        },
      ],
    };
    expect(findMatchingPermissions("GET", "/api/users", overlapConfig)).toEqual(
      ["read", "audit"],
    );
  });

  it("deduplicates one permission when multiple best-specificity rules match", () => {
    const overlapConfig: FirewallConfig = {
      name: "overlap",
      apis: [
        {
          base: "https://example.com",
          auth: { headers: {} },
          permissions: [
            {
              name: "read",
              rules: ["GET /api/{id}", "ANY /api/{id}"],
            },
          ],
        },
      ],
    };
    expect(findMatchingPermissions("GET", "/api/users", overlapConfig)).toEqual(
      ["read"],
    );
  });

  it("considers later rules in the same permission for specificity", () => {
    const overlapConfig: FirewallConfig = {
      name: "overlap",
      apis: [
        {
          base: "https://example.com",
          auth: { headers: {} },
          permissions: [
            {
              name: "read",
              rules: ["ANY /{path*}", "GET /api/users"],
            },
            { name: "catchall", rules: ["ANY /{path*}"] },
          ],
        },
      ],
    };
    expect(findMatchingPermissions("GET", "/api/users", overlapConfig)).toEqual(
      ["read"],
    );
  });

  it("uses mixed segment specificity before plain params", () => {
    const overlapConfig: FirewallConfig = {
      name: "overlap",
      apis: [
        {
          base: "https://example.com",
          auth: { headers: {} },
          permissions: [
            { name: "plain", rules: ["GET /files/{id}"] },
            { name: "mixed", rules: ["GET /files/file-{id}"] },
          ],
        },
      ],
    };
    expect(
      findMatchingPermissions("GET", "/files/file-123", overlapConfig),
    ).toEqual(["mixed"]);
  });

  it("uses plain params before greedy params", () => {
    const overlapConfig: FirewallConfig = {
      name: "overlap",
      apis: [
        {
          base: "https://example.com",
          auth: { headers: {} },
          permissions: [
            { name: "greedy", rules: ["GET /files/{rest+}"] },
            { name: "plain", rules: ["GET /files/{id}"] },
          ],
        },
      ],
    };
    expect(findMatchingPermissions("GET", "/files/123", overlapConfig)).toEqual(
      ["plain"],
    );
  });

  it("uses plus greedy params before star greedy params", () => {
    const overlapConfig: FirewallConfig = {
      name: "overlap",
      apis: [
        {
          base: "https://example.com",
          auth: { headers: {} },
          permissions: [
            { name: "star", rules: ["GET /files/{rest*}"] },
            { name: "plus", rules: ["GET /files/{rest+}"] },
          ],
        },
      ],
    };
    expect(findMatchingPermissions("GET", "/files/123", overlapConfig)).toEqual(
      ["plus"],
    );
  });

  it("counts Unicode code points for literal-char specificity", () => {
    const overlapConfig: FirewallConfig = {
      name: "overlap",
      apis: [
        {
          base: "https://example.com",
          auth: { headers: {} },
          permissions: [
            { name: "emoji-prefix", rules: ["GET /files/😀{id}"] },
            { name: "ascii-suffix", rules: ["GET /files/{id}ab"] },
          ],
        },
      ],
    };
    expect(
      findMatchingPermissions("GET", "/files/😀xab", overlapConfig),
    ).toEqual(["ascii-suffix"]);
  });

  it("does not compare path specificity across API entries", () => {
    const multiApi: FirewallConfig = {
      name: "multi",
      apis: [
        {
          base: "https://api1.example.com",
          auth: { headers: {} },
          permissions: [{ name: "catchall", rules: ["GET /{path*}"] }],
        },
        {
          base: "https://api2.example.com",
          auth: { headers: {} },
          permissions: [{ name: "specific", rules: ["GET /data"] }],
        },
      ],
    };
    expect(findMatchingPermissions("GET", "/data", multiApi)).toEqual([
      "catchall",
      "specific",
    ]);
  });

  it("can restrict matching to one API base", () => {
    const multiApi: FirewallConfig = {
      name: "multi",
      apis: [
        {
          base: "https://api1.example.com",
          auth: { headers: {} },
          permissions: [{ name: "catchall", rules: ["GET /{path*}"] }],
        },
        {
          base: "https://api2.example.com/",
          auth: { headers: {} },
          permissions: [{ name: "specific", rules: ["GET /data"] }],
        },
      ],
    };
    expect(
      findMatchingPermissions("GET", "/data", multiApi, {
        apiBase: "https://api1.example.com",
      }),
    ).toEqual(["catchall"]);
    expect(
      findMatchingPermissions("GET", "/data", multiApi, {
        apiBase: "https://api2.example.com",
      }),
    ).toEqual(["specific"]);
  });

  it("returns empty array for config with no permissions", () => {
    const emptyConfig: FirewallConfig = {
      name: "empty",
      apis: [
        {
          base: "https://example.com",
          auth: { headers: {} },
        },
      ],
    };
    expect(findMatchingPermissions("GET", "/anything", emptyConfig)).toEqual(
      [],
    );
  });

  it("does not reduce AWS-aware rules to path-only matches", () => {
    const awsConfig: FirewallConfig = {
      name: "aws",
      apis: [
        {
          base: "https://ec2.amazonaws.com",
          auth: {
            awsSigv4: {
              accessKeyId: "${{ secrets.AWS_ACCESS_KEY_ID }}",
              secretAccessKey: "${{ secrets.AWS_SECRET_ACCESS_KEY }}",
            },
          },
          permissions: [
            {
              name: "describe-instances",
              rules: ["POST / AWS sigv4=ec2 action=DescribeInstances"],
            },
          ],
        },
      ],
    };

    expect(findMatchingPermissions("POST", "/", awsConfig)).toEqual([]);
  });

  it("keeps AWS rules fail-closed for default callers and supports opt-in diagnostics", () => {
    const firewalls = [
      {
        name: "aws",
        apis: [
          {
            base: "https://ec2.amazonaws.com",
            auth: {},
            awsSigv4Capability: true,
            permissions: [
              {
                name: "describe-instances",
                rules: ["POST / AWS sigv4=ec2 action=DescribeInstances"],
              },
            ],
          },
        ],
      },
    ];

    expect(
      matchFirewallRequestDecision(
        firewalls,
        "POST",
        "https://ec2.amazonaws.com/",
      ),
    ).toMatchObject({
      kind: "block",
      reason: "malformed_firewall_config",
    });
    expect(
      matchFirewallRequestDecision(
        firewalls,
        "POST",
        "https://ec2.amazonaws.com/",
        { aws: { unknownPolicy: "ask" } },
        { status: "absent" },
        { awsDiagnostic: {} },
      ),
    ).toMatchObject({
      kind: "block",
      reason: "unknown_endpoint",
    });
    expect(
      matchFirewallRequestDecision(
        firewalls,
        "POST",
        "https://ec2.amazonaws.com/",
        { aws: { unknownPolicy: "ask" } },
        { status: "absent" },
        {
          awsDiagnostic: {
            context: {
              sigv4Service: "ec2",
              action: "DescribeInstances",
              query: [],
              headerNames: [],
            },
          },
        },
      ),
    ).toMatchObject({
      kind: "allow",
      permission: "describe-instances",
    });
    expect(
      matchFirewallRequestDecision(
        firewalls,
        "POST",
        "https://ec2.amazonaws.com/",
        { aws: { unknownPolicy: "ask" } },
        { status: "absent" },
        {
          awsDiagnostic: {
            context: {
              sigv4Service: "ec2",
              query: [{ key: "Action", value: "DescribeInstances" }],
              headerNames: [],
            },
          },
        },
      ),
    ).toMatchObject({
      kind: "allow",
      permission: "describe-instances",
    });
    expect(
      matchFirewallRequestDecision(
        firewalls,
        "POST",
        "https://ec2.amazonaws.com/",
        { aws: { unknownPolicy: "ask" } },
        { status: "absent" },
        {
          awsDiagnostic: {
            context: {
              sigv4Service: "ec2",
              action: "StartInstances",
              query: [],
              headerNames: [],
            },
          },
        },
      ),
    ).toMatchObject({
      kind: "block",
      reason: "unknown_endpoint",
    });
  });

  it("denies an AWS rule when a blocked permission owns the same semantic rule", () => {
    const rule = "POST / AWS sigv4=ec2 action=DescribeInstances";
    const firewalls = [
      {
        name: "aws",
        apis: [
          {
            base: "https://ec2.amazonaws.com",
            auth: {},
            awsSigv4Capability: true,
            permissions: [
              { name: "describe-primary", rules: [rule] },
              { name: "describe-alias", rules: [rule] },
              {
                name: "describe-reordered",
                rules: ["POST / AWS action=DescribeInstances sigv4=ec2"],
              },
            ],
          },
        ],
      },
    ];
    const policy = {
      aws: {
        allow: ["describe-primary"],
        deny: ["describe-alias", "describe-reordered"],
        unknownPolicy: "ask",
      },
    };

    expect(
      matchFirewallRequestDecision(
        firewalls,
        "POST",
        "https://ec2.amazonaws.com/",
        policy,
        { status: "absent" },
        {
          awsDiagnostic: {
            context: {
              sigv4Service: "ec2",
              action: "DescribeInstances",
              query: [],
              headerNames: [],
            },
          },
        },
      ),
    ).toMatchObject({
      kind: "block",
      reason: "permission_denied",
      permissions: ["describe-alias", "describe-reordered"],
    });
    expect(
      matchFirewallRequestDecision(
        firewalls,
        "POST",
        "https://ec2.amazonaws.com/",
        policy,
      ),
    ).toMatchObject({ kind: "block", reason: "malformed_firewall_config" });
    expect(
      matchFirewallRequestDecision(
        firewalls,
        "POST",
        "https://ec2.amazonaws.com/",
        policy,
        { status: "absent" },
        { awsDiagnostic: {} },
      ),
    ).toMatchObject({ kind: "block", reason: "unknown_endpoint" });
  });

  it("recognizes normalized AWS aliases without conflating distinct AWS rules", () => {
    const firewalls = [
      {
        name: "aws",
        apis: [
          {
            base: "https://s3.example.com",
            auth: {},
            awsSigv4Capability: true,
            permissions: [
              {
                name: "allowed",
                rules: ["GET /{Bucket}/{Key+}?acl&versionId=one AWS sigv4=s3"],
              },
              {
                name: "blocked-alias",
                rules: [
                  "GET /{bucket}/{object+}?versionId=one&acl AWS sigv4=s3",
                ],
              },
              {
                name: "blocked-distinct",
                rules: [
                  "ANY /{bucket}/{object+}?acl&versionId=one AWS sigv4=s3",
                ],
              },
            ],
          },
        ],
      },
    ];
    const options = {
      awsDiagnostic: {
        context: {
          sigv4Service: "s3",
          query: [
            { key: "acl" },
            { key: "versionId", value: "one" },
          ],
          headerNames: [],
        },
      },
    };

    expect(
      matchFirewallRequestDecision(
        firewalls,
        "GET",
        "https://s3.example.com/bucket/key",
        {
          aws: {
            allow: ["allowed"],
            deny: ["blocked-alias", "blocked-distinct"],
            unknownPolicy: "ask",
          },
        },
        { status: "absent" },
        options,
      ),
    ).toMatchObject({
      kind: "block",
      reason: "permission_denied",
      permissions: expect.arrayContaining(["blocked-alias"]),
    });
    expect(
      matchFirewallRequestDecision(
        firewalls,
        "GET",
        "https://s3.example.com/bucket/key",
        {
          aws: {
            allow: ["allowed"],
            deny: ["blocked-distinct"],
            unknownPolicy: "ask",
          },
        },
        { status: "absent" },
        options,
      ),
    ).toMatchObject({ kind: "allow", permission: "allowed" });
  });

  it("does not let non-AWS or separate API aliases override an AWS allow", () => {
    const rule = "POST / AWS sigv4=ec2 action=DescribeInstances";
    const firewalls = [
      {
        name: "aws",
        apis: [
          {
            base: "https://ec2.amazonaws.com",
            auth: {},
            awsSigv4Capability: true,
            permissions: [{ name: "allowed", rules: [rule] }],
          },
          {
            base: "https://ec2.amazonaws.com",
            auth: {},
            awsSigv4Capability: true,
            permissions: [{ name: "other-api", rules: [rule] }],
          },
        ],
      },
    ];
    const options = {
      awsDiagnostic: {
        context: {
          sigv4Service: "ec2",
          action: "DescribeInstances",
          query: [],
          headerNames: [],
        },
      },
    };
    const policy = {
      aws: {
        allow: ["allowed"],
        deny: ["other-api", "ordinary"],
        unknownPolicy: "ask",
      },
    };

    expect(
      matchFirewallRequestDecision(
        firewalls,
        "POST",
        "https://ec2.amazonaws.com/",
        policy,
        { status: "absent" },
        options,
      ),
    ).toMatchObject({ kind: "allow", permission: "allowed" });

    firewalls[0]!.apis[0]!.permissions.push({
      name: "ordinary",
      rules: ["POST /"],
    });
    expect(
      matchFirewallRequestDecision(
        firewalls,
        "POST",
        "https://ec2.amazonaws.com/",
        policy,
        { status: "absent" },
        options,
      ),
    ).toMatchObject({ kind: "allow", permission: "allowed" });
  });

  it("keeps AWS alias denial within the winning API base", () => {
    const firewalls = [
      {
        name: "aws",
        apis: [
          {
            base: "https://dynamodb.example.com",
            auth: {},
            awsSigv4Capability: true,
            permissions: [
              {
                name: "root-allowed",
                rules: [
                  "POST /v1 AWS sigv4=dynamodb target=DynamoDB_20120810.GetItem",
                ],
              },
            ],
          },
          {
            base: "https://dynamodb.example.com/v1",
            auth: {},
            awsSigv4Capability: true,
            permissions: [
              {
                name: "nested-blocked",
                rules: [
                  "POST / AWS target=DynamoDB_20120810.GetItem sigv4=dynamodb",
                ],
              },
            ],
          },
        ],
      },
    ];

    const decide = (allow: string[], deny: string[]) => {
      return matchFirewallRequestDecision(
        firewalls,
        "POST",
        "https://dynamodb.example.com/v1",
        { aws: { allow, deny, unknownPolicy: "ask" } },
        { status: "absent" },
        {
          awsDiagnostic: {
            context: {
              sigv4Service: "dynamodb",
              target: "DynamoDB_20120810.GetItem",
              query: [],
              headerNames: [],
            },
          },
        },
      );
    };

    expect(decide(["root-allowed"], ["nested-blocked"])).toMatchObject({
      kind: "block",
      reason: "permission_denied",
      permissions: ["nested-blocked"],
    });
    expect(decide(["nested-blocked"], ["root-allowed"])).toMatchObject({
      kind: "allow",
      permission: "nested-blocked",
    });
  });

  it("matches bounded AWS target and S3 query/header selectors", () => {
    const firewalls = [
      {
        name: "aws",
        apis: [
          {
            base: "https://dynamodb.example.com",
            auth: {},
            awsSigv4Capability: true,
            permissions: [
              {
                name: "get-item",
                rules: [
                  "POST / AWS sigv4=dynamodb target=DynamoDB_20120810.GetItem",
                ],
              },
            ],
          },
          {
            base: "https://s3.example.com",
            auth: {},
            awsSigv4Capability: true,
            permissions: [
              {
                name: "get-acl",
                rules: ["GET /{Bucket}/{Key+}?acl AWS sigv4=s3"],
              },
            ],
          },
        ],
      },
    ];

    expect(
      matchFirewallRequestDecision(
        firewalls,
        "POST",
        "https://dynamodb.example.com/",
        undefined,
        { status: "present", value: "aws" },
        {
          awsDiagnostic: {
            context: {
              sigv4Service: "dynamodb",
              target: "DynamoDB_20120810.GetItem",
              query: [],
              headerNames: [],
            },
          },
        },
      ),
    ).toMatchObject({ kind: "allow", permission: "get-item" });
    expect(
      matchFirewallRequestDecision(
        firewalls,
        "POST",
        "https://dynamodb.example.com/",
        { aws: { unknownPolicy: "ask" } },
        { status: "present", value: "aws" },
        {
          awsDiagnostic: {
            context: {
              sigv4Service: "dynamodb",
              target: "DynamoDB_20120810.GetItem",
              query: [{ key: "Action", value: "OtherOperation" }],
              headerNames: [],
            },
          },
        },
      ),
    ).toMatchObject({ kind: "block", reason: "unknown_endpoint" });
    expect(
      matchFirewallRequestDecision(
        firewalls,
        "GET",
        "https://s3.example.com/bucket/key",
        { aws: { unknownPolicy: "ask" } },
        { status: "present", value: "aws" },
        {
          awsDiagnostic: {
            context: {
              sigv4Service: "s3",
              query: [{ key: "acl" }],
              headerNames: ["x-amz-acl"],
            },
          },
        },
      ),
    ).toMatchObject({ kind: "allow", permission: "get-acl" });
    expect(
      matchFirewallRequestDecision(
        firewalls,
        "GET",
        "https://s3.example.com/bucket/key",
        { aws: { unknownPolicy: "ask" } },
        { status: "present", value: "aws" },
        {
          awsDiagnostic: {
            context: {
              sigv4Service: "s3",
              query: [
                { key: "acl" },
                { key: "X-Amz-Signature", value: "private-signature" },
              ],
              headerNames: [],
            },
          },
        },
      ),
    ).toMatchObject({ kind: "block", reason: "unknown_endpoint" });
    expect(
      matchFirewallRequestDecision(
        firewalls,
        "GET",
        "https://s3.example.com/bucket/key",
        { aws: { unknownPolicy: "ask" } },
        { status: "present", value: "aws" },
        {
          awsDiagnostic: {
            context: {
              sigv4Service: "s3",
              query: [{ key: "acl" }],
              headerNames: ["x-amz-copy-source"],
            },
          },
        },
      ),
    ).toMatchObject({ kind: "block", reason: "unknown_endpoint" });
  });

  it("treats malformed AWS diagnostic selectors as unknown endpoints", () => {
    const firewalls = [
      {
        name: "aws",
        apis: [
          {
            base: "https://ec2.amazonaws.com",
            auth: {},
            awsSigv4Capability: true,
            permissions: [
              {
                name: "describe-instances",
                rules: ["POST / AWS sigv4=ec2 action=DescribeInstances"],
              },
            ],
          },
        ],
      },
    ];

    expect(
      matchFirewallRequestDecision(
        firewalls,
        "POST",
        "https://ec2.amazonaws.com/",
        { aws: { unknownPolicy: "ask" } },
        { status: "absent" },
        { awsDiagnostic: { context: null as never } },
      ),
    ).toMatchObject({ kind: "block", reason: "unknown_endpoint" });
  });

  it("deduplicates permissions across multiple api entries", () => {
    const multiApi: FirewallConfig = {
      name: "multi",
      apis: [
        {
          base: "https://api1.example.com",
          auth: { headers: {} },
          permissions: [{ name: "shared-perm", rules: ["GET /data"] }],
        },
        {
          base: "https://api2.example.com",
          auth: { headers: {} },
          permissions: [{ name: "shared-perm", rules: ["GET /data"] }],
        },
      ],
    };
    expect(findMatchingPermissions("GET", "/data", multiApi)).toEqual([
      "shared-perm",
    ]);
  });
});
