import { runnerVncContract } from "../contracts/runner-vnc";
import { VNC_USERNAME_PASSWORD_MAX_BYTES } from "../contracts/vnc-credentials";
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
            "Exact supported tuples; empty means no supported policy.",
          ],
        },
      },
      identityDocs("ResolveRequestRunnerIdentity"),
      {
        rustTypeName: "ResolveRequestSupportedProfile",
        rustDoc: [
          "One supported authentication, security and transport tuple, never a cross-product.",
        ],
        fields: {
          authMethod: ["Supported authentication method."],
          securityType: ["Supported security policy."],
          transportType: [
            "Supported transport; omission is the legacy direct-only capability.",
          ],
        },
      },
      {
        rustTypeName: "ResolveRequestSupportedProfileAuthMethod",
        rustDoc: ["Authentication method advertised by this Runner."],
        variants: {
          vnc_password: ["Classic VNC password authentication."],
          username_password: ["Plain username/password authentication."],
          apple_dh_username_password: [
            "Apple DH username/password authentication with 63-byte fields.",
          ],
          apple_srp_username_password: [
            "Apple Direct SRP username/password authentication with bounded UTF-8 fields.",
          ],
        },
      },
      {
        rustTypeName: "ResolveRequestSupportedProfileSecurityType",
        rustDoc: ["Security profile advertised by this Runner."],
        variants: {
          x509_vnc: ["VeNCrypt X509Vnc."],
          x509_plain: ["VeNCrypt X509Plain."],
          apple_dh: ["Apple DH type 30, requiring SSH to Mac loopback."],
          apple_srp: [
            "Apple Direct SRP type 36, requiring SSH to Mac loopback.",
          ],
        },
      },
      {
        rustTypeName: "ResolveRequestSupportedProfileTransportType",
        rustDoc: ["Transport supported for this exact profile tuple."],
        variants: {
          direct: ["Connect directly under the VNC public-network policy."],
          ssh: ["Connect through the verified Run-owned SSH transport."],
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
      password: `crate::SecretUtf8Text<${VNC_USERNAME_PASSWORD_MAX_BYTES}>`,
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
          serverName: [
            "Certificate identity for X509 transport handoffs; absent for Apple DH.",
          ],
          transport: [
            "Explicit direct or generation-bound SSH transport snapshot.",
          ],
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
            "Legacy direct credential and policy; the VNC server controls connection admission.",
          ],
          resolved_transport: [
            "Current credential, policy and explicit generation-bound transport.",
          ],
          resolved_apple_dh: [
            "Apple DH credential and verified SSH-to-Mac-loopback transport only.",
          ],
          resolved_apple_srp: [
            "Apple Direct SRP credential and verified SSH-to-Mac-loopback transport only.",
          ],
        },
      },
      {
        rustTypeName: "ResolveResponseResolvedTransportTransport",
        rustDoc: [
          "Secret-free transport snapshot selected by an exact capability tuple.",
        ],
        fields: {
          connectionId: ["Exact saved SSH connection UUID."],
          generation: ["Current saved SSH configuration generation."],
        },
        variants: {
          direct: ["Connect directly under the VNC public-network policy."],
          ssh: ["Connect through this exact SSH authority snapshot."],
        },
      },
      {
        rustTypeName: "ResolveResponseResolvedAuthentication",
        rustDoc: ["Typed private VNC credential."],
        fields: {
          username: ["Bounded Plain username, preserving exact UTF-8 bytes."],
          password: [
            "Bounded zeroizing password, preserving exact UTF-8 bytes and spaces.",
          ],
        },
        variants: {
          vnc_password: ["Classic VNC password challenge response."],
          username_password: [
            "Username/password authentication inside verified TLS.",
          ],
          apple_dh_username_password: [
            "Apple DH username/password fields; the Runner validates 63-byte bounds.",
          ],
          apple_srp_username_password: [
            "Apple Direct SRP username/password fields; the Runner validates 255/1023-byte bounds.",
          ],
        },
      },
      {
        rustTypeName: "ResolveResponseResolvedSecurity",
        rustDoc: [
          "Saved security policy, independent of future engine capabilities.",
        ],
        fields: { trust: ["Required verified TLS trust policy."] },
        variants: {
          x509_vnc: ["VeNCrypt X509Vnc with verified TLS."],
          x509_plain: ["VeNCrypt X509Plain with verified TLS."],
          apple_dh: [
            "Apple DH type 30; only the separately verified SSH channel protects the RFB session.",
          ],
          apple_srp: [
            "Apple Direct SRP type 36; only the separately verified SSH channel protects the RFB session.",
          ],
        },
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
          expectedTransport: [
            "Expected explicit transport snapshot; omission preserves legacy direct-only checks.",
          ],
        },
      },
      identityDocs("CheckRequestRunnerIdentity"),
      {
        rustTypeName: "CheckRequestExpectedTransport",
        rustDoc: ["Expected secret-free SSH authority snapshot."],
        fields: {
          connectionId: ["Exact saved SSH connection UUID."],
          generation: ["Expected saved SSH configuration generation."],
        },
        variants: {
          direct: ["Expect the saved direct transport."],
          ssh: ["Expect this exact saved SSH connection and generation."],
        },
      },
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
