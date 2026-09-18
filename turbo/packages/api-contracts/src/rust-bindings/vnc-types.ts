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
          generation: ["Current saved configuration generation."],
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
            "Current credential and policy; the VNC server controls connection admission.",
          ],
        },
      },
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
  {
    schema: runnerVncContract.check.body,
    rustModulePath: ["runners", "vnc"],
    rustTypeName: "CheckRequest",
    direction: "request",
    declarations: [
      {
        rustTypeName: "CheckRequest",
        rustDoc: ["Recheck current Run authorization and saved configuration."],
        fields: {
          connectionId: ["Exact saved VNC connection UUID."],
          runnerIdentity: ["Winning process identity."],
          expectedGeneration: [
            "Configuration generation returned by credential resolution.",
          ],
        },
      },
      identityDocs("CheckRequestRunnerIdentity"),
    ],
  },
  {
    schema: runnerVncContract.check.responses[200],
    rustModulePath: ["runners", "vnc"],
    rustTypeName: "CheckResponse",
    direction: "response",
    declarations: [
      {
        rustTypeName: "CheckResponse",
        rustDoc: [
          "Current authorization snapshot, not a reservation or guarantee of exclusive control.",
          "Check before operations and stop on denial, changed configuration or API failure.",
        ],
        variants: {
          valid: ["Current Run remains authorized for the same configuration."],
          unavailable: ["Current authority is unavailable."],
          configuration_changed: [
            "Saved connection configuration generation changed.",
          ],
        },
      },
    ],
  },
] as const satisfies readonly RustTypeBinding[];
