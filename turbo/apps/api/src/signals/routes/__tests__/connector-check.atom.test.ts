import { connectorCheckContract } from "@okouai/api-contracts/contracts/connector-check";
import { connectorPermissionsContract } from "@okouai/api-contracts/contracts/connector-permissions";
import { describe, expect, it } from "vitest";

import { accept, testContext } from "../../../__tests__/test-context";
import { setupApp } from "../../../__tests__/test-helpers";
import { connectorCheckRoutes } from "../connector-check";
import { connectorPermissionsRoutes } from "../connector-permissions";
import {
  createConnectorBddApi,
  manualHttpCustomConnectorCreateBody,
} from "./helpers/api-bdd-connectors";
import { okouTokenFromClaim } from "./helpers/chat-events-fixture";
import { publicChatActor } from "./helpers/public-chat-actor";

const context = testContext();
const connectors = createConnectorBddApi(context);
const prefix = "https://atom.example.test/api";

describe.each([false, true])(
  "Atom issuing permissions (Chat accounts: %s)",
  (chatAccounts) => {
    it("keeps reads available and denies issuing until the owner grants permission", async () => {
      const connectorIds: string[] = [];
      const fixture = await publicChatActor(context, {
        beforeWorkspaceCleanup: async (actor) => {
          for (const connectorId of connectorIds) {
            await connectors.deleteCustomConnector(actor, connectorId);
          }
        },
      });
      const { actor, agentId, runnerGroup, run: own } = fixture;
      await own(() => {
        return connectors.updateFeatureSwitches(actor, {
          connectorChatAccountAccess: chatAccounts,
        });
      });
      const body = manualHttpCustomConnectorCreateBody({
        displayName: "Atom",
        prefixTemplates: [`${prefix}/`],
      });
      const definition = await own(() => {
        return connectors.createCustomConnector(actor, body);
      });
      connectorIds.push(definition.id);
      await own(() => {
        return connectors.setCustomConnectorSecret(
          actor,
          definition.id,
          "atom-fixture-credential",
        );
      });
      await own(() => {
        return connectors.updateAgentCustomConnectors(actor, agentId, [
          definition.id,
        ]);
      });
      const updated = await own(() => {
        return connectors.updateCustomConnector(actor, definition.id, {
          ...body,
          permissionBundleRef: "builtin:atom@1",
        });
      });
      expect(updated.permissionBundleRef).toBe("builtin:atom@1");
      await expect(
        own(() => {
          return connectors.readAgentCustomConnectorGrants(actor, agentId);
        }),
      ).resolves.toStrictEqual([
        { customConnectorId: definition.id, permissionNames: [] },
      ]);
      const metadata = await own(() => {
        return connectors.readCustomConnectorPermissions(actor, definition.id);
      });
      expect(metadata.defaultPolicies).toMatchObject({
        read: "allow",
        "grants:issue": "deny",
      });

      const sent = await fixture.sendChatRun(actor, {
        agentId,
        prompt: "Read Atom inventories before requesting issuing access",
      });
      const claimed = await fixture.claimChatRun(runnerGroup, sent.runId);
      const firewallName = `custom_connector_${definition.id.replaceAll("-", "")}`;
      expect(claimed.claim.networkPolicies?.[firewallName]).toMatchObject({
        unknownPolicy: "deny",
        allow: expect.arrayContaining(["read"]),
        deny: ["grants:issue"],
      });
      expect(claimed.claim.firewalls).toContainEqual(
        expect.objectContaining({
          kind: "inline",
          customConnectorId: definition.id,
          firewall: expect.objectContaining({
            name: firewallName,
            apis: expect.arrayContaining([
              expect.objectContaining({
                permissions: expect.arrayContaining([
                  expect.objectContaining({ name: "grants:issue" }),
                ]),
              }),
            ]),
          }),
        }),
      );
      const token = okouTokenFromClaim(claimed.claim);
      const client = setupApp({ context, routes: connectorCheckRoutes })(
        connectorCheckContract,
      );
      const check = async (method: string, path: string) => {
        return await own(() => {
          return accept(
            client.check({
              headers: { authorization: `Bearer ${token}` },
              body: {
                mode: "url",
                method,
                url: `${prefix}${path}`,
                target: {
                  kind: "custom",
                  customConnectorId: definition.id,
                },
              },
            }),
            [200],
          );
        });
      };
      const grantIssuing = async (allowed: boolean) => {
        return await own(async () => {
          if (chatAccounts) {
            const permissions = setupApp({
              context,
              routes: connectorPermissionsRoutes,
            })(connectorPermissionsContract);
            await accept(
              permissions.apply({
                headers: { authorization: "Bearer clerk-session" },
                body: {
                  target: { kind: "custom", customConnectorId: definition.id },
                  mode: "replace",
                  grants: allowed
                    ? [{ permission: "grants:issue", action: "allow" }]
                    : [],
                },
              }),
              [200],
            );
            return;
          }
          await connectors.requestUpdateAgentCustomConnectorGrants(
            actor,
            agentId,
            [
              {
                customConnectorId: definition.id,
                permissionNames: allowed ? ["grants:issue"] : [],
              },
            ],
            [200],
          );
        });
      };

      for (const [method, path] of [
        ["GET", "/me"],
        ["HEAD", "/admin/entitlements"],
        ["GET", "/admin/redeem-codes"],
        ["GET", "/admin/coupons"],
        ["GET", "/admin/invoices/prepared-invoice"],
        ["GET", "/admin/subscription-grants"],
        ["POST", "/admin/coupons/preview"],
      ] as const) {
        expect((await check(method, path)).body).toMatchObject({
          outcome: "resolved",
          permission: {
            kind: "matched",
            permissions: [{ name: "read", policy: { outcome: "allow" } }],
          },
        });
      }

      expect(
        (await check("POST", "/admin/entitlements/existing-delivery/cancel"))
          .body,
      ).toMatchObject({
        outcome: "resolved",
        permission: {
          kind: "matched",
          permissions: [{ name: "plans:cancel", policy: { outcome: "allow" } }],
        },
      });

      for (const [method, path] of [
        ["POST", "/admin/redeem-codes"],
        ["PATCH", "/admin/redeem-codes/existing-code"],
        ["DELETE", "/admin/redeem-codes/existing-code"],
        ["POST", "/admin/entitlements"],
        ["POST", "/admin/entitlements/credits"],
        ["POST", "/admin/coupons"],
        ["POST", "/admin/coupons/existing-batch/issue"],
        ["POST", "/admin/coupons/existing-batch/enabled"],
        ["POST", "/admin/subscription-grants"],
        ["POST", "/admin/subscription-grants/existing-grant/complete"],
        ["POST", "/admin/subscription-grants/existing-grant/deliver"],
        ["POST", "/admin/subscription-grants/existing-grant/cancel"],
      ] as const) {
        expect((await check(method, path)).body).toMatchObject({
          outcome: "resolved",
          permission: {
            kind: "matched",
            permissions: [
              {
                name: "grants:issue",
                policy: { outcome: "deny", basis: "deny-list" },
              },
            ],
          },
        });
      }
      expect((await check("POST", "/admin/future-grants")).body).toMatchObject({
        outcome: "resolved",
        permission: {
          kind: "unknown-endpoint",
          policy: { outcome: "deny", basis: "unknown-policy" },
        },
      });

      await grantIssuing(true);
      expect((await check("POST", "/admin/entitlements")).body).toMatchObject({
        outcome: "resolved",
        permission: {
          kind: "matched",
          permissions: [{ name: "grants:issue", policy: { outcome: "allow" } }],
        },
      });

      await grantIssuing(false);
      expect((await check("POST", "/admin/entitlements")).body).toMatchObject({
        outcome: "resolved",
        permission: {
          kind: "matched",
          permissions: [{ name: "grants:issue", policy: { outcome: "deny" } }],
        },
      });
    });
  },
);
