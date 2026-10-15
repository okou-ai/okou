import { expect, test } from "vitest";
import {
  createSshConnectionRequestSchema,
  sshConnectionResponseSchema,
  updateSshConnectionRequestSchema,
} from "../ssh-connections";

const configId = "f0000000-0000-4000-8000-000000000001";
const metadata = Object.freeze({
  id: "a0000000-0000-4000-8000-000000000001",
  displayName: "Saved gateway",
  host: "gateway.example.com",
  port: 22,
  username: "operator",
  credentialId: "c0000000-0000-4000-8000-000000000001",
  credentialName: "Gateway login",
  generation: 2,
  learnedHostKey: { algorithm: "ssh-ed25519", fingerprint: "SHA256:retained" },
  createdAt: "2026-09-01T00:00:00.000Z",
  updatedAt: "2026-09-01T00:00:00.000Z",
});
const create = Object.freeze({
  id: metadata.id,
  displayName: metadata.displayName,
  host: metadata.host,
  port: metadata.port,
  credential: { id: metadata.credentialId },
});

test.each([
  { name: "Direct", response: metadata },
  {
    name: "bound Cloudflare",
    response: {
      ...metadata,
      port: 443,
      transport: { type: "cloudflare_access", configId },
    },
  },
  {
    name: "retained Cloudflare",
    response: {
      ...metadata,
      port: 443,
      transport: { type: "cloudflare_access", needsRebind: true },
    },
  },
  {
    name: "bound Tailscale",
    response: {
      ...metadata,
      host: "100.100.10.2",
      transport: { type: "tailscale", configId },
    },
  },
  {
    name: "retained Tailscale",
    response: {
      ...metadata,
      host: "100.100.10.2",
      transport: { type: "tailscale", needsRebind: true },
    },
  },
])("The preparatory reader preserves $name metadata", ({ response }) => {
  expect(sshConnectionResponseSchema.parse(response)).toStrictEqual(response);
});

test.each([
  { type: "tailscale", configId, needsRebind: true },
  { type: "tailscale", needsRebind: false },
  { type: "tailscale", configId: "not-a-uuid" },
  { type: "tailscale" },
  { type: "unknown", configId },
])("The reader rejects an invalid saved carrier %j", (transport) => {
  expect(
    sshConnectionResponseSchema.safeParse({ ...metadata, transport }).success,
  ).toBe(false);
});

test.each([
  { type: "tailscale", configId },
  {
    type: "tailscale",
    create: {
      name: "Inline private network",
      credentials: {
        clientId: "synthetic-client",
        clientSecret: "synthetic-secret",
      },
      tags: ["tag:runner"],
    },
  },
])("The backend admits Tailscale producer inputs %j", (transport) => {
  const input = { ...create, host: "100.100.10.2", transport };
  expect(createSshConnectionRequestSchema.parse(input)).toStrictEqual(input);
  const update = { expectedGeneration: 2, transport };
  expect(updateSshConnectionRequestSchema.parse(update)).toStrictEqual(update);
});

test.each([
  { type: "tailscale", configId: "not-a-uuid" },
  { type: "tailscale", needsRebind: true },
  { type: "tailscale", configId, create: {} },
])("The backend rejects invalid Tailscale producer inputs %j", (transport) => {
  expect(
    createSshConnectionRequestSchema.safeParse({ ...create, transport })
      .success,
  ).toBe(false);
  expect(
    updateSshConnectionRequestSchema.safeParse({
      expectedGeneration: 2,
      transport,
    }).success,
  ).toBe(false);
});

test.each([
  { name: "omitted Direct", input: create },
  {
    name: "explicit Direct",
    input: { ...create, transport: { type: "direct" } },
  },
  {
    name: "selected Cloudflare",
    input: {
      ...create,
      port: 443,
      transport: { type: "cloudflare_access", configId },
    },
  },
])("Existing $name create inputs remain accepted", ({ input }) => {
  expect(createSshConnectionRequestSchema.parse(input)).toStrictEqual(input);
});

test.each([
  { name: "Direct", transport: { type: "direct" } },
  { name: "Cloudflare", transport: { type: "cloudflare_access", configId } },
])("Existing $name update inputs remain accepted", ({ transport }) => {
  const input = { expectedGeneration: 2, transport };
  expect(updateSshConnectionRequestSchema.parse(input)).toStrictEqual(input);
});

test.each([
  { type: "tailscale_ssh", configId },
  {
    type: "tailscale_ssh",
    create: {
      name: "Private network",
      credentials: {
        clientId: "synthetic-client",
        clientSecret: "synthetic-secret",
      },
      tags: ["tag:runner"],
    },
  },
])(
  "Tailscale SSH accepts identity login and defaults to port 22: %j",
  (transport) => {
    const input = {
      id: metadata.id,
      displayName: metadata.displayName,
      host: "private-host",
      username: "ubuntu",
      transport,
    };
    expect(createSshConnectionRequestSchema.parse(input)).toStrictEqual({
      ...input,
      port: 22,
    });
  },
);

test.each([
  { username: "ubuntu" },
  { credential: undefined },
  { transport: { type: "tailscale", configId }, credential: undefined },
  { transport: { type: "tailscale_ssh", configId }, username: "ubuntu" },
  { transport: { type: "tailscale_ssh", configId }, credential: undefined },
  {
    transport: { type: "tailscale_ssh", configId },
    credential: undefined,
    username: "ubuntu",
    port: 2222,
  },
])("Create rejects incompatible network and login inputs: %j", (fields) => {
  expect(
    createSshConnectionRequestSchema.safeParse({ ...create, ...fields })
      .success,
  ).toBe(false);
});
