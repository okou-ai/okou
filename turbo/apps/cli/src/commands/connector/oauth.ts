import { Command } from "commander";
import {
  startBuiltinConnectorAuthorization,
  startCustomConnectorAuthorization,
} from "../../lib/api/domains/connector-management";
import { withErrorHandler } from "../../lib/command/with-error-handler";
import {
  accountMutation,
  addAccountMutationOptions,
  resolveManagementConnector,
  type AccountMutationOptions,
} from "./management";

interface Options extends AccountMutationOptions {
  readonly authMethod?: string;
  readonly json?: boolean;
}

export const connectorOAuthStartCommand = addAccountMutationOptions(
  new Command("start")
    .description(
      "Start an existing OAuth, OpenID, or automatic member connection flow",
    )
    .argument(
      "<selector>",
      "Exact connector selector; builtin:/custom: prefixes accepted",
    ),
)
  .option(
    "--auth-method <method>",
    "Builtin auth method (required when more than one is supported)",
  )
  .option(
    "--json",
    "Print authorization URL/flow IDs or connected account ID as JSON",
  )
  .addHelpText(
    "after",
    `
Use --add for a new account or --reconnect <connection-id> for an existing one.
Return the authorization URL verbatim so the user can complete the provider
flow. Automatic setup can return a connected account ID directly.

Inside a Run, use okou connector account list <selector> --json to inspect
Chat allowance. Firewall permissions are shared across your Chats and accounts.
`,
  )
  .action(
    withErrorHandler(async (selector: string, options: Options) => {
      const account = accountMutation(options);
      const { connector } = await resolveManagementConnector(selector);
      let result;
      if (connector.kind === "custom") {
        if (options.authMethod !== undefined)
          throw new Error("--auth-method applies only to builtin connectors.");
        if (
          connector.customConnector.authMode !== "oauth" &&
          connector.customConnector.authMode !== "automatic"
        )
          throw new Error(
            "Use connector connect for manual or no-auth custom accounts.",
          );
        result = await startCustomConnectorAuthorization(
          connector.customConnector.id,
          account,
        );
      } else {
        const methods = connector.catalogConnector.authMethods.filter(
          (method) => {
            return (
              method.grantKind === "auth-code" ||
              method.grantKind === "openid-auth" ||
              method.grantKind === "automatic"
            );
          },
        );
        const method = options.authMethod
          ? methods.find((item) => {
              return item.id === options.authMethod;
            })
          : methods.length === 1
            ? methods[0]
            : undefined;
        if (
          !method ||
          (method.grantKind !== "auth-code" &&
            method.grantKind !== "openid-auth" &&
            method.grantKind !== "automatic")
        )
          throw new Error(
            "Choose one supported OAuth auth method with --auth-method; inspect connector search for connection guidance.",
          );
        result = await startBuiltinConnectorAuthorization(
          connector.slug,
          method.id,
          method.grantKind,
          account,
        );
      }
      if (options.json) console.log(JSON.stringify(result, null, 2));
      else if (result.result === "authorization") {
        console.log(result.authorizationUrl);
        console.log(`OAuth attempt ID: ${result.oauthAttemptId}`);
      } else console.log(`Connected account ID: ${result.connectionId}`);
    }),
  );

export const connectorOAuthCommand = new Command("oauth")
  .description("Start member account authorization")
  .addCommand(connectorOAuthStartCommand);
