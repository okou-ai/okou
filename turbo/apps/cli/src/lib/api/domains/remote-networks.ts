import { initClient } from "@okouai/api-contracts/contracts/trpc-contract";
import {
  cloudflareAccessContract,
  type CreateCloudflareAccessConfigRequest,
  type UpdateCloudflareAccessRequest,
  type DeleteCloudflareAccessRequest,
  type ConvertCloudflareAccessRequest,
} from "@okouai/api-contracts/contracts/cloudflare-access";
import {
  tailscaleContract,
  type CreateTailscaleConfigRequest,
  type UpdateTailscaleRequest,
  type DeleteTailscaleRequest,
  type ConvertTailscaleRequest,
} from "@okouai/api-contracts/contracts/tailscale";
import { ApiRequestError, getClientConfig } from "../core/client-factory";
import { handleManagementError } from "../../management-input";

// Transport and server errors must never reflect credential-bearing bodies.
async function request<T>(operation: () => Promise<T>): Promise<T> {
  try {
    return await operation();
  } catch (error) {
    if (error instanceof ApiRequestError) throw error;
    throw new Error(
      "Private-network request failed. Check connectivity and the input contract; credential values are not displayed.",
    );
  }
}

async function cloudflareClient() {
  return initClient(cloudflareAccessContract, await getClientConfig());
}
async function tailscaleClient() {
  return initClient(tailscaleContract, await getClientConfig());
}

export const cloudflareAccessNetworks = {
  list: () => {
    return request(async () => {
      const result = await (
        await cloudflareClient()
      ).list({ headers: {}, query: { view: "scoped" } });
      if (result.status !== 200)
        handleManagementError(
          result,
          "Cannot list Cloudflare Access configurations",
        );
      return result.body.configs;
    });
  },
  create: (body: CreateCloudflareAccessConfigRequest) => {
    return request(async () => {
      const result = await (
        await cloudflareClient()
      ).create({ headers: {}, query: { view: "scoped" }, body });
      if (result.status === 204) return { id: body.id };
      if (result.status !== 201)
        handleManagementError(
          result,
          "Cannot create Cloudflare Access configuration",
        );
      return result.body;
    });
  },
  update: (configId: string, body: UpdateCloudflareAccessRequest) => {
    return request(async () => {
      const result = await (
        await cloudflareClient()
      ).update({
        headers: {},
        query: { view: "scoped" },
        params: { configId },
        body,
      });
      if (result.status !== 200)
        handleManagementError(
          result,
          "Cannot update Cloudflare Access configuration",
        );
      return result.body;
    });
  },
  delete: (configId: string, body: DeleteCloudflareAccessRequest) => {
    return request(async () => {
      const result = await (
        await cloudflareClient()
      ).delete({
        headers: {},
        query: { view: "scoped" },
        params: { configId },
        body,
      });
      if (result.status !== 204)
        handleManagementError(
          result,
          "Cannot delete Cloudflare Access configuration",
        );
      return { id: configId };
    });
  },
  impact: (configId: string, operation: "convert" | "delete") => {
    return request(async () => {
      const result = await (
        await cloudflareClient()
      ).impactPreview({
        headers: {},
        params: { configId },
        query: { operation },
      });
      if (result.status !== 200)
        handleManagementError(
          result,
          "Cannot inspect Cloudflare Access impact",
        );
      return result.body;
    });
  },
  toOrganization: (configId: string, body: { expectedRevision: number }) => {
    return request(async () => {
      const result = await (
        await cloudflareClient()
      ).convertToOrganization({ headers: {}, params: { configId }, body });
      if (result.status !== 200)
        handleManagementError(result, "Cannot change Cloudflare Access scope");
      return result.body;
    });
  },
  toPersonal: (configId: string, body: ConvertCloudflareAccessRequest) => {
    return request(async () => {
      const result = await (
        await cloudflareClient()
      ).convertToPersonal({ headers: {}, params: { configId }, body });
      if (result.status !== 200)
        handleManagementError(result, "Cannot change Cloudflare Access scope");
      return result.body;
    });
  },
};

export const tailscaleNetworks = {
  list: () => {
    return request(async () => {
      const result = await (await tailscaleClient()).list({ headers: {} });
      if (result.status !== 200)
        handleManagementError(result, "Cannot list Tailscale configurations");
      return result.body.configs;
    });
  },
  create: (body: CreateTailscaleConfigRequest) => {
    return request(async () => {
      const result = await (
        await tailscaleClient()
      ).create({ headers: {}, body });
      if (result.status === 204) return { id: body.id };
      if (result.status !== 201)
        handleManagementError(result, "Cannot create Tailscale configuration");
      return result.body;
    });
  },
  update: (configId: string, body: UpdateTailscaleRequest) => {
    return request(async () => {
      const result = await (
        await tailscaleClient()
      ).update({ headers: {}, params: { configId }, body });
      if (result.status !== 200)
        handleManagementError(result, "Cannot update Tailscale configuration");
      return result.body;
    });
  },
  delete: (configId: string, body: DeleteTailscaleRequest) => {
    return request(async () => {
      const result = await (
        await tailscaleClient()
      ).delete({ headers: {}, params: { configId }, body });
      if (result.status !== 204)
        handleManagementError(result, "Cannot delete Tailscale configuration");
      return { id: configId };
    });
  },
  impact: (configId: string, operation: "convert" | "delete") => {
    return request(async () => {
      const result = await (
        await tailscaleClient()
      ).impactPreview({
        headers: {},
        params: { configId },
        query: { operation },
      });
      if (result.status !== 200)
        handleManagementError(result, "Cannot inspect Tailscale impact");
      return result.body;
    });
  },
  toOrganization: (configId: string, body: { expectedRevision: number }) => {
    return request(async () => {
      const result = await (
        await tailscaleClient()
      ).convertToOrganization({ headers: {}, params: { configId }, body });
      if (result.status !== 200)
        handleManagementError(result, "Cannot change Tailscale scope");
      return result.body;
    });
  },
  toPersonal: (configId: string, body: ConvertTailscaleRequest) => {
    return request(async () => {
      const result = await (
        await tailscaleClient()
      ).convertToPersonal({ headers: {}, params: { configId }, body });
      if (result.status !== 200)
        handleManagementError(result, "Cannot change Tailscale scope");
      return result.body;
    });
  },
};
