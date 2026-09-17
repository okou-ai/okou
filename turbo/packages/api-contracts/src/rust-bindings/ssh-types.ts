import {
  runnerSshContract,
  runnerSshInvalidateSchema,
  SSH_PASSWORD_MAX_LENGTH,
} from "../contracts/runner-ssh";
import {
  SSH_PRIVATE_KEY_MAX_LENGTH,
  SSH_PASSPHRASE_MAX_LENGTH,
} from "../contracts/ssh-connections";
import type { RustTypeBinding, RustTypeDeclarationDoc } from "./types";
import { CLOUDFLARE_ACCESS_TOKEN_MAX_LENGTH } from "../contracts/cloudflare-access";

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

function hostKeyDocs(name: string): RustTypeDeclarationDoc[] {
  return [
    {
      rustTypeName: name,
      rustDoc: [
        "Learned SSH host identity, distinct from the negotiated signature algorithm.",
      ],
      fields: {
        algorithm: ["Public key algorithm."],
        fingerprint: ["Canonical unpadded SHA256 fingerprint."],
      },
    },
    {
      rustTypeName: `${name}Algorithm`,
      rustDoc: ["Supported host public-key identities."],
      variants: {
        "ssh-ed25519": ["Ed25519."],
        "ecdsa-sha2-nistp256": ["NIST P256."],
        "ecdsa-sha2-nistp384": ["NIST P384."],
        "ecdsa-sha2-nistp521": ["NIST P521."],
        "ssh-rsa": ["RSA public-key identity; negotiate RSA-SHA2 separately."],
      },
    },
  ];
}

export const sshTypeBindings = [
  {
    schema: runnerSshContract.observe.body,
    rustModulePath: ["runners", "ssh"],
    rustTypeName: "ObservationRequest",
    direction: "request",
    declarations: [
      {
        rustTypeName: "ObservationRequest",
        rustDoc: [
          "Latest connection evidence, never commands or authorization.",
        ],
        fields: {
          connectionId: ["Exact owner connection UUID."],
          runnerIdentity: ["Winning process identity."],
          expectedGeneration: [
            "Configuration used, including successful TOFU advancement.",
          ],
          observedAt: [
            "UTC observation time, ordered independently of report delivery.",
          ],
          failureReason: [
            "Connection failure; null means verified host and authenticated user.",
          ],
        },
      },
      identityDocs("ObservationRequestRunnerIdentity"),
      {
        rustTypeName: "ObservationRequestFailureReason",
        rustDoc: [
          "Allow-listed connection failures, excluding command and authority failures.",
        ],
        variants: {
          invalid_credential: [
            "Private key or passphrase could not be decoded.",
          ],
          unsupported_credential: [
            "Unsupported private key format or algorithm.",
          ],
          credential_resource_limit: [
            "Credential exceeds the supported decoding envelope.",
          ],
          unsafe_destination: [
            "Destination does not meet the public address policy.",
          ],
          network_failure: ["DNS or connection failed."],
          host_key_mismatch: [
            "Verified host identity differs from the stored pin.",
          ],
          unsupported_host_key: ["Host key is unsupported."],
          authentication_failed: ["SSH user authentication failed."],
          protocol: ["Connection handshake failed before user authentication."],
          timed_out: ["Connection did not authenticate before its deadline."],
          access_rejected: [
            "Cloudflare Access rejected the Service Token or policy.",
          ],
          access_tls_failure: [
            "The Access gateway TLS identity could not be verified.",
          ],
          access_protocol_failure: [
            "The Access gateway did not establish a valid carrier.",
          ],
        },
      },
    ],
  },
  {
    schema: runnerSshInvalidateSchema,
    rustModulePath: ["runners", "ssh"],
    rustTypeName: "InvalidateNotification",
    direction: "response",
    declarations: [
      {
        rustTypeName: "InvalidateNotification",
        rustDoc: [
          "Best-effort SSH authority eviction, never an authorization grant.",
        ],
        fields: {
          runId: ["Affected active Run UUID."],
          connectionId: [
            "Affected connection UUID, or null for every connection in the Run.",
          ],
        },
      },
    ],
  },
  {
    schema: runnerSshContract.resolve.body,
    rustModulePath: ["runners", "ssh"],
    rustTypeName: "ResolveRequest",
    direction: "request",
    declarations: [
      {
        rustTypeName: "ResolveRequest",
        rustDoc: ["Resolve current authority for one Run connection."],
        fields: {
          connectionId: ["Exact SSH connection UUID."],
          runnerIdentity: ["Host-owned process identity."],
        },
      },
      identityDocs("ResolveRequestRunnerIdentity"),
    ],
  },
  {
    schema: runnerSshContract.pin.body,
    rustModulePath: ["runners", "ssh"],
    rustTypeName: "PinRequest",
    direction: "request",
    declarations: [
      {
        rustTypeName: "PinRequest",
        rustDoc: [
          "Learn the first key only under current authority and generation.",
        ],
        fields: {
          connectionId: ["Exact SSH connection UUID."],
          runnerIdentity: ["Host-owned process identity."],
          expectedGeneration: ["Generation delivered by JIT."],
          observedHostKey: ["Identity after KEX proof verification."],
        },
      },
      identityDocs("PinRequestRunnerIdentity"),
      ...hostKeyDocs("PinRequestObservedHostKey"),
    ],
  },
  {
    schema: runnerSshContract.pin.responses[200],
    rustModulePath: ["runners", "ssh"],
    rustTypeName: "PinResponse",
    direction: "response",
    declarations: [
      {
        rustTypeName: "PinResponse",
        rustDoc: ["Atomic first-use trust outcome."],
        fields: { generation: ["Must equal the JIT generation plus one."] },
        variants: {
          unavailable: ["Current authority no longer exists."],
          pinned: ["This observation won the pin."],
          matched: [
            "Same observation won concurrently at exactly generation plus one.",
          ],
          host_key_mismatch: ["Trust differs; never overwrite."],
          configuration_changed: ["JIT configuration is stale."],
        },
      },
    ],
  },
  {
    schema: runnerSshContract.resolve.responses[200],
    rustModulePath: ["runners", "ssh"],
    rustTypeName: "ResolveResponse",
    direction: "response",
    sensitive: true,
    fieldTypeOverrides: {
      privateKey: `crate::SecretText<${SSH_PRIVATE_KEY_MAX_LENGTH}>`,
      passphrase: `Option<crate::SecretText<${SSH_PASSPHRASE_MAX_LENGTH}>>`,
      password: `crate::SecretText<${SSH_PASSWORD_MAX_LENGTH}>`,
      clientId: `crate::SecretText<${CLOUDFLARE_ACCESS_TOKEN_MAX_LENGTH}>`,
      clientSecret: `crate::SecretText<${CLOUDFLARE_ACCESS_TOKEN_MAX_LENGTH}>`,
    },
    declarations: [
      {
        rustTypeName: "ResolveResponse",
        rustDoc: [
          "Private JIT response. Never Debug, clone, serialize, persist or send to guest.",
        ],
        fields: {
          authentication: [
            "SSH authentication after protected carrier and host proof.",
          ],
          access: ["Private Access authority for the exact saved recipient."],
          host: ["Current destination, private to Runner."],
          port: ["Current destination port."],
          username: ["Current login identity."],
          generation: ["Current configuration generation."],
          learnedHostKey: ["Existing pin, or first-use trust required."],
          privateKey: ["Bounded zeroizing private key text."],
          passphrase: ["Bounded zeroizing passphrase, preserving whitespace."],
          password: [
            "Bounded zeroizing login password, preserving whitespace.",
          ],
        },
        variants: {
          resolved_access: [
            "Authorized protected carrier and SSH credential handoff.",
          ],
          unavailable: ["Current authority not available; no secrets."],
          resolved: ["Authorized current credential handoff."],
          resolved_password: [
            "Authorized current password credential handoff.",
          ],
        },
      },
      ...hostKeyDocs("ResolveResponseResolvedLearnedHostKey"),
      {
        rustTypeName: "ResolveResponseResolvedAccessAuthentication",
        rustDoc: [
          "Private SSH authentication after carrier authorization and host proof.",
        ],
        fields: {
          privateKey: ["Bounded zeroizing key."],
          passphrase: ["Optional zeroizing passphrase."],
          password: ["Bounded zeroizing password."],
        },
        variants: {
          private_key: ["SSH private key."],
          password: ["SSH password."],
        },
      },
      {
        rustTypeName: "ResolveResponseResolvedAccessAccess",
        rustDoc: [
          "Private Service Token for the exact saved hostname, never guest-visible.",
        ],
        fields: {
          configId: ["Owner configuration ID."],
          generation: ["Effective Access generation."],
          clientId: ["Bounded zeroizing Client ID."],
          clientSecret: ["Bounded zeroizing Client Secret."],
        },
      },
    ],
  },
] satisfies readonly RustTypeBinding[];
