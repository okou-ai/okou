import { runnerVncContract } from "../contracts/runner-vnc";
import { VNC_PASSWORD_MAX_LENGTH } from "../contracts/vnc-credentials";
import type { RustTypeBinding, RustTypeDeclarationDoc } from "./types";

function identityDocs(name: string): RustTypeDeclarationDoc {
  return {
    rustTypeName: name,
    rustDoc: ["Immutable winning official Runner process."],
    fields: {
      runnerId: ["Runner UUID."],
      heartbeatGeneration: ["Winning process generation."],
    },
  };
}

function authorityDocs(name: string): RustTypeDeclarationDoc {
  return {
    rustTypeName: name,
    rustDoc: ["Exact saved connection incarnation, policy and Agent grant."],
    fields: {
      instanceId: [
        "Connection incarnation; changes after delete and recreate.",
      ],
      generation: ["Current configuration generation."],
      grantId: ["Current grant identity; changes after revoke and regrant."],
    },
  };
}

function leaseRequestDocs(
  name: string,
  acquire: boolean,
): RustTypeDeclarationDoc[] {
  return [
    {
      rustTypeName: name,
      rustDoc: [
        "Operate only under exact current Run and connection authority.",
      ],
      fields: {
        connectionId: ["Exact saved connection UUID, not endpoint identity."],
        runnerIdentity: ["Winning process identity."],
        authority: ["Authority returned by credential resolution."],
        ...(acquire
          ? {
              holderId: [
                "Fresh acquisition intent UUID; preserve on ambiguous retry.",
              ],
            }
          : {
              leaseToken: [
                "Exact random lease token; never adopt another holder.",
              ],
            }),
      },
    },
    identityDocs(`${name}RunnerIdentity`),
    authorityDocs(`${name}Authority`),
  ];
}

function leaseResponseDocs(
  name: string,
  acquire: boolean,
): RustTypeDeclarationDoc[] {
  return [
    {
      rustTypeName: name,
      rustDoc: [
        "Bounded authority snapshot; stop on failure or the conservative monotonic deadline.",
        "Derive the deadline from request start plus validForMs, never response arrival.",
      ],
      fields: {
        leaseToken: ["Exact holder token for check, renew and release."],
        serverTime: ["Database clock after authority and lease lock waits."],
        expiresAt: [
          "Database expiry; diagnostic, not a local wall-clock deadline.",
        ],
        validForMs: ["Remaining validity, at most 30000 milliseconds."],
        renewAfterMs: ["Renew conservatively every 10000 milliseconds."],
      },
      variants: {
        ...(acquire
          ? {
              acquired: [
                "Acquired or replayed the same unextended live acquisition.",
              ],
              busy: ["Another holder remains within its accepted lifetime."],
            }
          : {
              valid: [
                "Exact lease is still authorized; only renew extends expiry.",
              ],
            }),
        unavailable: ["Current Run, owner or grant authority is unavailable."],
        configuration_changed: [
          "Saved connection incarnation or policy changed.",
        ],
        expired: ["Lease expired, was released or belongs to another holder."],
      },
    },
  ];
}

export const vncTypeBindings = [
  {
    schema: runnerVncContract.resolve.body,
    rustModulePath: ["runners", "vnc"],
    rustTypeName: "ResolveRequest",
    direction: "request",
    declarations: [
      {
        rustTypeName: "ResolveRequest",
        rustDoc: ["Resolve one saved VNC policy supported by this Runner."],
        fields: {
          connectionId: ["Exact saved VNC connection UUID."],
          runnerIdentity: ["Winning process identity."],
          supportedProfiles: [
            "Exact supported pairs; empty means no supported policy.",
          ],
        },
      },
      identityDocs("ResolveRequestRunnerIdentity"),
      {
        rustTypeName: "ResolveRequestSupportedProfile",
        rustDoc: [
          "One supported authentication and security pair, never a cross-product.",
        ],
        fields: {
          authMethod: ["Supported authentication method."],
          securityType: ["Supported security policy."],
        },
      },
    ],
  },
  {
    schema: runnerVncContract.resolve.responses[200],
    rustModulePath: ["runners", "vnc"],
    rustTypeName: "ResolveResponse",
    direction: "response",
    sensitive: true,
    fieldTypeOverrides: {
      password: `crate::SecretText<${VNC_PASSWORD_MAX_LENGTH}>`,
    },
    declarations: [
      {
        rustTypeName: "ResolveResponse",
        rustDoc: [
          "Private credential handoff. Never Debug, clone, serialize, persist or send to guest.",
        ],
        fields: {
          host: ["Current private destination."],
          port: ["Current destination port."],
          authority: ["Exact authority for subsequent lease operations."],
          authentication: ["Credential for the explicitly saved method."],
          security: [
            "Explicit saved transport and trust policy; never downgrade.",
          ],
        },
        variants: {
          unavailable: [
            "Current authority is unavailable; no credential delivered.",
          ],
          unsupported_profile: [
            "Runner does not support the exact saved profile.",
          ],
          resolved: [
            "Current credential and policy; control still requires a lease.",
          ],
        },
      },
      authorityDocs("ResolveResponseResolvedAuthority"),
      {
        rustTypeName: "ResolveResponseResolvedAuthentication",
        rustDoc: ["Typed private VNC credential."],
        fields: {
          password: [
            "Bounded zeroizing classic VNC password, preserving spaces.",
          ],
        },
        variants: {
          vnc_password: ["Classic VNC password challenge response."],
        },
      },
      {
        rustTypeName: "ResolveResponseResolvedSecurity",
        rustDoc: [
          "Saved security policy, independent of future engine capabilities.",
        ],
        fields: { trust: ["Required verified TLS trust policy."] },
        variants: { x509_vnc: ["VeNCrypt X509Vnc with verified TLS."] },
      },
      {
        rustTypeName: "ResolveResponseResolvedSecurityX509VncTrust",
        rustDoc: [
          "Exact trust source; insecure verification is not representable.",
        ],
        fields: {
          caBundle: ["Owner-provided CA bundle, private to this connection."],
        },
        variants: {
          system: ["Use system trust roots."],
          custom_ca: ["Use the explicitly saved custom CA bundle."],
        },
      },
    ],
  },
  ...(["acquire", "check", "renew"] as const).flatMap((action) => {
    const name =
      action === "acquire" ? "Acquire" : action === "check" ? "Check" : "Renew";
    return [
      {
        schema: runnerVncContract[action].body,
        rustModulePath: ["runners", "vnc"],
        rustTypeName: `${name}Request`,
        direction: "request" as const,
        declarations: leaseRequestDocs(`${name}Request`, action === "acquire"),
      },
      {
        schema: runnerVncContract[action].responses[200],
        rustModulePath: ["runners", "vnc"],
        rustTypeName: `${name}Response`,
        direction: "response" as const,
        declarations: leaseResponseDocs(
          `${name}Response`,
          action === "acquire",
        ),
      },
    ];
  }),
  {
    schema: runnerVncContract.release.body,
    rustModulePath: ["runners", "vnc"],
    rustTypeName: "ReleaseRequest",
    direction: "request",
    declarations: leaseRequestDocs("ReleaseRequest", false),
  },
  {
    schema: runnerVncContract.release.responses[200],
    rustModulePath: ["runners", "vnc"],
    rustTypeName: "ReleaseResponse",
    direction: "response",
    declarations: [
      {
        rustTypeName: "ReleaseResponse",
        rustDoc: [
          "Release outcome; a lost response never restores control authority.",
        ],
        variants: {
          released: ["Exact lease was released."],
          unavailable: ["Current authority is unavailable."],
          expired: [
            "Lease is expired or superseded; another holder is untouched.",
          ],
        },
      },
    ],
  },
] satisfies readonly RustTypeBinding[];
