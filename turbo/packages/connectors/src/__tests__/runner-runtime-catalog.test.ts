import { describe, expect, it } from "vitest";
import {
  createRunnerRuntimeFirewallCatalog,
  projectRunnerRuntimeFirewall,
} from "../firewall-metadata/runner-runtime-catalog";

describe("Runner runtime firewall content identity", () => {
  it("ignores object-key order but changes when firewall content changes", () => {
    function catalog(headers: Record<string, string>) {
      return createRunnerRuntimeFirewallCatalog([
        projectRunnerRuntimeFirewall({
          name: "example",
          apis: [{ base: "https://api.example.test", auth: { headers } }],
        }),
      ]);
    }
    const publication = catalog({
      "X-Tenant-Id": "${{ vars.TENANT_ID }}",
      Authorization: "Bearer ${{ secrets.API_TOKEN }}",
    });
    const jsonb = catalog({
      Authorization: "Bearer ${{ secrets.API_TOKEN }}",
      "X-Tenant-Id": "${{ vars.TENANT_ID }}",
    });
    expect(jsonb.catalogDigest).toBe(publication.catalogDigest);
    expect(jsonb.catalogVersion).toBe(publication.catalogVersion);
    const changed = catalog({
      Authorization: "Bearer ${{ secrets.OTHER_TOKEN }}",
      "X-Tenant-Id": "${{ vars.TENANT_ID }}",
    });
    expect(changed.catalogDigest).not.toBe(publication.catalogDigest);
  });
});
