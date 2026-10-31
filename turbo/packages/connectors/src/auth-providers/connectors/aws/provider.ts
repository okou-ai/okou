import { literal, object, string, url } from "zod";

import type {
  ExternalCodeConnectorAuthProvider,
  RefreshTokenAccessProvider,
} from "../../types";
import {
  buildAwsSigninAuthorizationUrl,
  createAwsExternalCodeProviderState,
  exchangeAwsSigninAuthorizationCode,
  parseAwsSigninVerificationCode,
  refreshAwsSigninToken,
} from "./signin";
import { getAwsCallerIdentity, type AwsCallerIdentity } from "./sts";

const AWS_EXTERNAL_CODE_SESSION_EXPIRES_IN_SECONDS = 10 * 60;

const awsExternalCodeProviderStateSchema = object({
  version: literal(1),
  state: string().min(1).max(128),
  codeVerifier: string().min(43).max(128),
  dpopKey: string().min(1),
  redirectUri: url(),
  signinRegion: string().regex(/^[a-z]{2}(?:-gov)?-[a-z]+-\d$/),
  runtimeRegion: string().regex(/^[a-z]{2}(?:-gov)?-[a-z]+-\d$/),
});

function createAwsExternalCodeGrantProvider(): ExternalCodeConnectorAuthProvider<
  "aws",
  "cli"
>["grant"] {
  return {
    kind: "external-code",
    startExternalCodeAuthorization: async (args) => {
      const providerState = createAwsExternalCodeProviderState();
      return {
        authorizationUrl: buildAwsSigninAuthorizationUrl({
          clientId: args.authClient.clientId,
          scopes: args.externalCodeGrant.scopes,
          providerState,
        }),
        providerState: JSON.stringify(providerState),
        expiresIn: AWS_EXTERNAL_CODE_SESSION_EXPIRES_IN_SECONDS,
      };
    },
    completeExternalCodeAuthorization: async (args, signal: AbortSignal) => {
      const providerState = parseAwsExternalCodeProviderState(
        args.providerState,
      );
      const verificationCode = parseAwsSigninVerificationCode({
        verificationCode: args.code,
        expectedState: providerState.state,
      });
      const token = await exchangeAwsSigninAuthorizationCode(
        {
          clientId: args.authClient.clientId,
          signinRegion: providerState.signinRegion,
          code: verificationCode.code,
          codeVerifier: providerState.codeVerifier,
          dpopKey: providerState.dpopKey,
          redirectUri: providerState.redirectUri,
        },
        signal,
      );
      const identity = await getAwsCallerIdentity(
        {
          credentials: token.credentials,
          region: providerState.runtimeRegion,
        },
        signal,
      );
      return {
        outputs: {
          refreshToken: token.refreshToken,
          dpopKey: providerState.dpopKey,
          accessKeyId: token.credentials.accessKeyId,
          secretAccessKey: token.credentials.secretAccessKey,
          sessionToken: token.credentials.sessionToken,
          signinRegion: providerState.signinRegion,
          runtimeRegion: providerState.runtimeRegion,
        },
        expiresIn: token.expiresIn,
        scopes: args.externalCodeGrant.scopes,
        userInfo: awsConnectorUserInfo(identity),
      };
    },
  };
}

function createAwsRefreshTokenAccessProvider(): RefreshTokenAccessProvider<
  "aws",
  "cli"
> {
  return {
    kind: "refresh-token",
    refresh: async (args, signal: AbortSignal) => {
      const token = await refreshAwsSigninToken(
        {
          clientId: args.authClient.clientId,
          signinRegion: args.inputs.signinRegion,
          refreshToken: args.inputs.refreshToken,
          dpopKey: args.inputs.dpopKey,
        },
        signal,
      );
      return {
        outputs: {
          refreshToken: token.refreshToken,
          accessKeyId: token.credentials.accessKeyId,
          secretAccessKey: token.credentials.secretAccessKey,
          sessionToken: token.credentials.sessionToken,
        },
        expiresIn: token.expiresIn,
      };
    },
  };
}

function parseAwsExternalCodeProviderState(providerState: string) {
  return awsExternalCodeProviderStateSchema.parse(
    JSON.parse(providerState) as unknown,
  );
}

function awsConnectorUserInfo(identity: AwsCallerIdentity) {
  return {
    id: identity.account,
    username: `${identity.arn} (${identity.userId})`,
    email: null,
  };
}

export const awsProvider = {
  grant: createAwsExternalCodeGrantProvider(),
  access: createAwsRefreshTokenAccessProvider(),
  revoke: { kind: "none" },
} as const satisfies ExternalCodeConnectorAuthProvider<"aws", "cli"> & {
  readonly access: RefreshTokenAccessProvider<"aws", "cli">;
};
