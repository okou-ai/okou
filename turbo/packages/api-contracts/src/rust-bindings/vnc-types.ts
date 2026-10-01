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
          transportType: ["Supported transport for this exact tuple."],
        },
      },
      {
        rustTypeName: "ResolveRequestSupportedProfileAuthMethod",
        rustDoc: ["Authentication method advertised by this Runner."],
        variants: {
          none: [
            "No inner RFB client authentication; require explicit saved X509None.",
          ],
          vnc_password: ["Classic VNC password authentication."],
          username_password: ["Plain username/password authentication."],
          qemu_scram_sha256: ["QEMU-specific SCRAM-SHA-256 authentication."],
          apple_dh_username_password: [
            "Apple DH username/password authentication with 63-byte fields.",
          ],
          apple_srp_username_password: [
            "Apple Direct SRP username/password authentication with bounded UTF-8 fields.",
          ],
          apple_rsa_srp_username_password: [
            "Apple RSA/SRP username/password authentication with a 234-byte username bound.",
          ],
          client_certificate: [
            "Required TLS client certificate with X509None.",
          ],
          client_certificate_vnc_password: [
            "Required TLS client certificate and classic VNC password.",
          ],
        },
      },
      {
        rustTypeName: "ResolveRequestSupportedProfileSecurityType",
        rustDoc: ["Security profile advertised by this Runner."],
        variants: {
          x509_none: ["VeNCrypt X509None; no inner client authentication."],
          x509_vnc: ["VeNCrypt X509Vnc."],
          x509_plain: ["VeNCrypt X509Plain."],
          qemu_x509_sasl: ["QEMU X509SASL subtype 263 with verified TLS."],
          apple_vnc_password: [
            "Apple bare type 2, requiring SSH to Mac loopback.",
          ],
          apple_dh: ["Apple DH type 30, requiring SSH to Mac loopback."],
          apple_srp: [
            "Apple Direct SRP type 36, requiring SSH to Mac loopback.",
          ],
          apple_rsa_srp: [
            "Apple RSA/SRP type 33, requiring SSH to Mac loopback.",
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
      privateKeyPkcs8Der: "crate::SecretUtf8Text<24576>",
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
          authentication: [
            "Exact saved method, with no credential for X509None.",
          ],
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
          resolved_transport: [
            "Current credential, policy and explicit generation-bound transport.",
          ],
          resolved_apple_vnc_password: [
            "Apple classic VNC password with verified SSH-to-Mac-loopback transport only.",
          ],
          resolved_apple_dh: [
            "Apple DH credential and verified SSH-to-Mac-loopback transport only.",
          ],
          resolved_apple_srp: [
            "Apple Direct SRP credential and verified SSH-to-Mac-loopback transport only.",
          ],
          resolved_apple_rsa_srp: [
            "Apple RSA/SRP credential and verified SSH-to-Mac-loopback transport only.",
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
        rustTypeName: "ResolveResponseResolvedTransportAuthentication",
        rustDoc: ["Typed private VNC credential."],
        fields: {
          username: ["Bounded Plain username, preserving exact UTF-8 bytes."],
          password: [
            "Bounded zeroizing password, preserving exact UTF-8 bytes and spaces.",
          ],
          certificateChainDer: [
            "Bounded base64-encoded DER client certificate chain.",
          ],
          privateKeyPkcs8Der: [
            "Base64-encoded unencrypted PKCS#8 key, private and zeroizing.",
          ],
        },
        variants: {
          none: ["No inner client authentication or secret."],
          vnc_password: ["Classic VNC password challenge response."],
          username_password: [
            "Username/password authentication inside verified TLS.",
          ],
          qemu_scram_sha256: [
            "Bounded ASCII SCRAM-SHA-256 credential for QEMU X509SASL.",
          ],
          apple_dh_username_password: [
            "Apple DH username/password fields; the Runner validates 63-byte bounds.",
          ],
          apple_srp_username_password: [
            "Apple Direct SRP username/password fields; the Runner validates 255/1023-byte bounds.",
          ],
          apple_rsa_srp_username_password: [
            "Apple RSA/SRP username/password fields; the Runner validates 234/1023-byte bounds.",
          ],
          client_certificate: [
            "Required client identity; no inner RFB credential.",
          ],
          client_certificate_vnc_password: [
            "Required client identity and classic VNC password.",
          ],
        },
      },
      {
        rustTypeName: "ResolveResponseResolvedTransportSecurity",
        rustDoc: [
          "Saved security policy, independent of future engine capabilities.",
        ],
        fields: { trust: ["Required verified TLS trust policy."] },
        variants: {
          x509_none: ["Verified TLS without inner RFB client authentication."],
          x509_vnc: ["VeNCrypt X509Vnc with verified TLS."],
          x509_plain: ["VeNCrypt X509Plain with verified TLS."],
          qemu_x509_sasl: [
            "QEMU X509SASL subtype 263 and SCRAM-SHA-256 over verified TLS.",
          ],
          apple_vnc_password: [
            "Apple bare type 2; only the separately verified SSH channel protects the RFB session.",
          ],
          apple_dh: [
            "Apple DH type 30; only the separately verified SSH channel protects the RFB session.",
          ],
          apple_srp: [
            "Apple Direct SRP type 36; only the separately verified SSH channel protects the RFB session.",
          ],
          apple_rsa_srp: [
            "Apple RSA/SRP type 33; only the separately verified SSH channel protects the RFB session.",
          ],
        },
      },
      {
        rustTypeName: "ResolveResponseResolvedTransportSecurityX509VncTrust",
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
          expectedTransport: ["Expected explicit transport snapshot."],
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
