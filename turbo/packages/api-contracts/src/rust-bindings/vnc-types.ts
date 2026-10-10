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

function principalDocs(name: string): RustTypeDeclarationDoc {
  return {
    rustTypeName: name,
    rustDoc: [
      "Explicit case-preserving Kerberos identity; native validates K1 budgets.",
    ],
    fields: {
      realm: ["Exact realm, never discovered from a hostname."],
      components: [
        "Ordered bounded principal components, never a path or ambient identity.",
      ],
    },
  };
}
function kdcTransportDocs(name: string): RustTypeDeclarationDoc {
  return {
    rustTypeName: name,
    rustDoc: ["Independently authorized exact KDC transport snapshot."],
    fields: {
      connectionId: ["Exact separately granted saved SSH UUID."],
      generation: ["Current SSH generation, independently fenced from RFB."],
    },
    variants: {
      direct: ["Exact saved public-network KDC route."],
      ssh: ["Exact independently authorized SSH-to-loopback KDC route."],
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
          kdcTransportType: [
            "Absent for legacy, none for offline tickets, exact direct/ssh for online sources.",
          ],
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
          qemu_kerberos_ticket: ["Canonical selected-service ticket; no KDC."],
          qemu_kerberos_keytab: ["Explicit online canonical keytab."],
          qemu_kerberos_password: ["Explicit online password."],
          rsa_aes_password: [
            "RSA-AES password-only subtype with 255-byte fields.",
          ],
          rsa_aes_username_password: [
            "RSA-AES username/password subtype with 255-byte fields.",
          ],
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
          qemu_x509_gssapi: [
            "Verified QEMU263 with exact GSSAPI and no inner layer.",
          ],
          rsa_aes_ra2: ["Pinned RSA-AES type 5; full-session AES-128 EAX."],
          rsa_aes_ra2_256: [
            "Pinned RSA-AES type 129; full-session AES-256 EAX.",
          ],
          rsa_aes_ra2ne: ["Pinned RSA-AES type 6; verified SSH-loopback only."],
          rsa_aes_ra2ne_256: [
            "Pinned RSA-AES type 130; verified SSH-loopback only.",
          ],
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
        rustTypeName: "ResolveRequestSupportedProfileKdcTransportType",
        rustDoc: ["KDC transport for this exact source/RFB/KDC tuple."],
        variants: {
          none: ["Offline service ticket; no KDC operation."],
          direct: ["Separate exact public KDC route."],
          ssh: ["Separate authorized SSH-loopback KDC route."],
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
      ticketCache: "crate::SecretUtf8Text<87384>",
      keytab: "crate::SecretUtf8Text<87384>",
    },
    declarations: [
      principalDocs(
        "ResolveResponseResolvedTransportAuthenticationQemuKerberosTicketInitiator",
      ),
      principalDocs(
        "ResolveResponseResolvedTransportAuthenticationQemuKerberosTicketService",
      ),
      principalDocs(
        "ResolveResponseResolvedTransportSecurityQemuX509GssapiService",
      ),
      kdcTransportDocs(
        "ResolveResponseResolvedTransportSecurityQemuX509GssapiKdcTransport",
      ),
      {
        rustTypeName:
          "ResolveResponseResolvedTransportSecurityQemuX509GssapiKdc",
        rustDoc: [
          "Online-only bounded KDC policy, independent of RFB transport.",
        ],
        fields: {
          host: ["Exact saved KDC host; never provided by native."],
          port: ["Exact saved TCP KDC port."],
          transport: ["Current separately authorized route snapshot."],
          ticketLifetimeSeconds: [
            "Requested bounded lifetime, not a server guarantee.",
          ],
          renewableLifetimeSeconds: [
            "Requested bounded renew-till policy; never extends active RFB.",
          ],
        },
      },
      {
        rustTypeName: "ResolveResponse",
        rustDoc: [
          "Private credential handoff. Never Debug, clone, serialize, persist or send to guest.",
        ],
        fields: {
          host: ["Current private destination."],
          port: ["Current destination port."],
          generation: ["Current saved configuration generation."],
          credentialRevision: [
            "Kerberos-only source revision, mandatory when admitting a Kerberos profile.",
          ],
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
          resolved_kerberos: [
            "Current explicit Kerberos source, independent KDC route and source revision.",
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
          resolved_rsa_aes: [
            "Exact RSA-AES mode, independent wire pin and bounded credential.",
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
          initiator: ["Explicit saved initiator identity."],
          service: ["Exact service selected by offline import."],
          ticketCache: [
            "Canonical service-only FILE4 cache, zeroizing and never guest-visible.",
          ],
          keytab: ["Canonical FILEkeytab2, zeroizing and never guest-visible."],
        },
        variants: {
          none: ["No inner client authentication or secret."],
          rsa_aes_password: [
            "RSA-AES password-only subtype; native validates 255 UTF-8 bytes.",
          ],
          rsa_aes_username_password: [
            "RSA-AES username/password subtype; native validates 255 UTF-8 bytes per field.",
          ],
          vnc_password: ["Classic VNC password challenge response."],
          username_password: [
            "Username/password authentication inside verified TLS.",
          ],
          qemu_scram_sha256: [
            "Bounded ASCII SCRAM-SHA-256 credential for QEMU X509SASL.",
          ],
          qemu_kerberos_ticket: [
            "Explicit canonical offline ticket; no KDC fallback.",
          ],
          qemu_kerberos_keytab: [
            "Explicit same-source online keytab acquisition.",
          ],
          qemu_kerberos_password: [
            "Explicit same-source online password acquisition.",
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
        fields: {
          trust: ["Required verified TLS trust policy."],
          serverKeySha256: [
            "Independent full RSA wire-key SHA256, never CA trust.",
          ],
          service: [
            "Exact same-realm vnc service, separate from TCP/TLS identities.",
          ],
          kdc: ["Absent offline; separately authorized route/policy online."],
        },
        variants: {
          rsa_aes_ra2: ["Pinned type 5; full-session AES-128 EAX."],
          rsa_aes_ra2_256: ["Pinned type 129; full-session AES-256 EAX."],
          rsa_aes_ra2ne: [
            "Pinned type 6; authentication-only over verified SSH-loopback.",
          ],
          rsa_aes_ra2ne_256: [
            "Pinned type 130; authentication-only over verified SSH-loopback.",
          ],
          x509_none: ["Verified TLS without inner RFB client authentication."],
          x509_vnc: ["VeNCrypt X509Vnc with verified TLS."],
          x509_plain: ["VeNCrypt X509Plain with verified TLS."],
          qemu_x509_sasl: [
            "QEMU X509SASL subtype 263 and SCRAM-SHA-256 over verified TLS.",
          ],
          qemu_x509_gssapi: [
            "Verified QEMU263/GSSAPI/no inner layer; never SCRAM or anonymous TLS.",
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
          expectedKdcTransport: [
            "Online-only independent KDC authority snapshot.",
          ],
          expectedCredentialRevision: ["Kerberos-only pinned source revision."],
        },
      },
      identityDocs("CheckRequestRunnerIdentity"),
      kdcTransportDocs("CheckRequestExpectedKdcTransport"),
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
