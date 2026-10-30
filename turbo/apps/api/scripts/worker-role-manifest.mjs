import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import ts from "typescript";

const apiRoot = resolve(import.meta.dirname, "..");

// Experimental source-isolated ownership. Keep each role in signals/route.ts order.
// An added aggregate group must be classified explicitly, never assigned by default.
export const workerRoles = {
  runtime: {
    entry: "src/worker-roles/runtime.ts",
    groups: [
      "runnersStartupRoutes",
      "cronProcessBackgroundJobsRoutes",
      "webhooksClerkRoutes",
      "webhooksStripeRoutes",
      "webhooksAgentHealthUsageTelemetryRoutes",
      "webhooksAgentCompleteRoutes",
      "webhooksAgentEventsRoutes",
      "linkApprovalWorkflowRoutes",
      "cronCleanupSandboxesRoutes",
      "cronExecuteWorkflowAutomationsRoutes",
      "cronReconcileBillingEntitlementsRoutes",
      "cronSteerRunTimeBudgetRoutes",
      "artifactCatalogRoutes",
      "billingCheckoutRoutes",
      "chatThreadRoutes",
      "welcomeChatThreadRoutes",
      "chatEventsRoutes",
      "sharedThreadRoutes",
      "desktopShellAuthorizationRoutes",
      "chatRemoteAccessRoutes",
      "runnerVncRoutes",
      "runnerSshRoutes",
      "browserRoutes",
      "runDetailRoutes",
      "runsRoutes",
      "runsCancelRoutes",
      "orgDeleteRoutes",
      "orgMembersRoutes",
      "orgReadRoutes",
      "workflowsRoutes",
      "workflowAutomationsRoutes",
      "skillImportRoutes",
      "slackCommandsRoutes",
      "slackEventsRoutes",
      "slackInteractiveRoutes",
      "runnersRoutes",
      "runnerCancellationRoutes",
    ],
    initializeChatRunFinishedEvents: true,
  },
  realtime: {
    entry: "src/worker-roles/realtime.ts",
    groups: [
      "getStartedRoutes",
      "webhooksAgentSessionOutputRoutes",
      "cronProjectChatEventSearchRoutes",
      "jobsRoutes",
      "bankingRoutes",
      "claudeCodeDeviceAuthRoutes",
      "codexDeviceAuthRoutes",
      "atomSubscriptionGrantRoutes",
      "sshConnectionsRoutes",
      "vncConnectionsRoutes",
      "vncAccessRoutes",
      "cloudflareAccessRoutes",
      "tailscaleRoutes",
      "browserAuthorizationRoutes",
      "realtimeTokenRoutes",
      "userModelPreferenceRoutes",
      "slackConnectRoutes",
      "discordOauthRoutes",
      "discordInteractionsRoutes",
      "teamsBrowserConnectRoutes",
      "teamsConnectRoutes",
      "teamsOauthRoutes",
      "integrationsSlackRoutes",
      "integrationsDiscordRoutes",
      "integrationsDiscordReadRoutes",
      "integrationsDiscordMessageRoutes",
    ],
    initializeChatRunFinishedEvents: false,
  },
  control: {
    entry: "src/worker-roles/control.ts",
    groups: [
      "healthRoutes",
      "buildInfoRoutes",
      "authMeRoutes",
      "cliAuthRoutes",
      "desktopUpdateRoutes",
      "webhooksAgentDataRequestRoutes",
      "dataRouterHistoryRoutes",
      "cronRetainChatEventsRoutes",
      "cronCompactUsageEventsRoutes",
      "cronCleanupXResourceReadsRoutes",
      "cronConnectorOauthStateCleanupRoutes",
      "cronCleanupSuggestionsRoutes",
      "cronMonitorChatEventQueueRoutes",
      "cronTelegramCleanupRoutes",
      "emailUnsubscribeRoutes",
      "billingRedeemCodeRoutes",
      "billingUsagePackCreditsRoutes",
      "featureSwitchesRoutes",
      "featureGuidesRoutes",
      "logsRoutes",
      "mcpOAuthClientMetadataRoutes",
      "sshAccessRoutes",
      "modelCatalogRoutes",
      "runModelsRoutes",
      "voiceIoQuotaRoutes",
      "voiceIoPolishRoutes",
      "agentSetupPromptRoutes",
      "voiceIoTranscribeRoutes",
      "orgLogoRoutes",
      "orgMembershipRequestsRoutes",
      "orgOpenrouterPresetRoutes",
      "pushSubscriptionsRoutes",
      "iosPushRegistrationsRoutes",
      "iosNotificationsRoutes",
      "paidToolsRoutes",
      "halloweenOperationsRoutes",
      "integrationsWechatRoutes",
      "integrationsWechatMessagesRoutes",
      "integrationsGithubDownloadFileRoutes",
      "integrationsSlackMessageRoutes",
      "integrationsSlackReadRoutes",
      "integrationsFeishuMessageRoutes",
      "integrationsTeamsDownloadFileRoutes",
      "integrationsTeamsMessageRoutes",
      "slackChannelsRoutes",
    ],
    initializeChatRunFinishedEvents: false,
  },
  settlement: {
    entry: "src/worker-roles/settlement.ts",
    groups: [
      "githubOauthRoutes",
      "cronReconcileImageGenerationsRoutes",
      "webhooksBuiltInGenerationRoutes",
      "webhooksStripeConnectRoutes",
      "cronProcessUsageEventsRoutes",
      "billingAutoRechargeRoutes",
      "billingConcurrencyCheckoutRoutes",
      "billingConcurrencySubscriptionRoutes",
      "billingCreditCheckoutRoutes",
      "billingDowngradeRoutes",
      "billingInvoicesRoutes",
      "billingPortalRoutes",
      "billingRedeemRoutes",
      "billingRestoreRoutes",
      "billingStatusRoutes",
      "builtInGenerationRoutes",
      "imageIoGenerateRoutes",
      "mailRoutes",
      "onboardingRecommendationRoutes",
      "onboardingSourcesRoutes",
      "orgInviteRoutes",
      "userPermissionGrantsRoutes",
      "integrationsGithubRoutes",
      "slackOauthRoutes",
      "usageMembersRoutes",
      "usageRecordRoutes",
    ],
    initializeChatRunFinishedEvents: false,
  },
  objects: {
    entry: "src/worker-roles/objects.ts",
    groups: [
      "userExportRoutes",
      "webhooksAgentStorageRoutes",
      "cronCompactChatThreadSnapshotsRoutes",
      "cronReconcileArtifactCatalogRoutes",
      "cronSnapshotChatEventsRoutes",
      "cronOfficialWorkflowCatalogRoutes",
      "cronPruneStoragePresignedUrlsRoutes",
      "cronMaterializePiResourceIndexesRoutes",
      "cronComputerUseScreenshotCleanupRoutes",
      "cronBrowserReconcileRoutes",
      "cronSyncSkillsRoutes",
      "agentDraftRoutes",
      "suggestionsRoutes",
      "agentInstructionsRoutes",
      "agentsRoutes",
      "computerUseAuthorizationRoutes",
      "computerUseRoutes",
      "agentConnectorAccessRoutes",
      "remotesRoutes",
      "hostRoutes",
      "artifactShareRoutes",
      "artifactReferenceRoutes",
      "artifactOgRoutes",
      "artifactDownloadRoutes",
      "browserUserActionRoutes",
      "webFileUrlRoutes",
      "onboardingCompleteRoutes",
      "onboardingStatusRoutes",
      "userPreferencesRoutes",
      "morningBriefPreferenceRoutes",
      "proactiveSuggestionsRoutes",
      "proactiveJobsRoutes",
      "proactiveLearningRoutes",
      "integrationsWechatFileRoutes",
      "integrationsPhoneUploadInitRoutes",
      "integrationsGithubUploadCompleteRoutes",
      "integrationsGithubUploadInitRoutes",
      "integrationsFeishuFileRoutes",
      "integrationsDiscordFileRoutes",
      "integrationsSlackUploadCompleteRoutes",
      "integrationsSlackUploadInitRoutes",
      "integrationsSlackUploadMaterializeRoutes",
      "integrationsTeamsUploadCompleteRoutes",
      "integrationsTeamsUploadInitRoutes",
      "uploadsCompleteRoutes",
      "uploadsMultipartRoutes",
      "uploadsPrepareRoutes",
      "presentationTemplatesRoutes",
      "userTemplatesRoutes",
      "registryResourceDownloadRoutes",
    ],
    initializeChatRunFinishedEvents: false,
  },
  capabilities: {
    entry: "src/worker-roles/capabilities.ts",
    groups: [
      "webhooksAgentFirewallAuthRoutes",
      "builtinConnectorsAutomaticRoutes",
      "walletRoutes",
      "builtinConnectorsSlugCallbackRoutes",
      "cronConnectorCatalogRoutes",
      "connectorAgentAccessRoutes",
      "connectorCatalogRoutes",
      "connectedConnectorsRoutes",
      "connectorCheckRoutes",
      "builtinConnectorsExternalCodeRoutes",
      "builtinConnectorsOauthDeviceAuthRoutes",
      "builtinConnectorsRoutes",
      "connectorAccountRoutes",
      "customConnectorsRoutes",
      "mcpConnectorsRoutes",
      "meModelProvidersDeleteRoutes",
      "meModelProviderAccountRoutes",
      "meModelProvidersListRoutes",
      "meThirdPartySubscriptionsListRoutes",
      "meModelProvidersResetSubscriptionRoutes",
      "meModelProvidersUpsertRoutes",
      "feishuBrowserConnectRoutes",
      "feishuConnectRoutes",
      "feishuOauthRoutes",
    ],
    initializeChatRunFinishedEvents: false,
  },
  delivery: {
    entry: "src/worker-roles/delivery.ts",
    groups: [
      "cronDrainEmailOutboxRoutes",
      "emailInboundRoutes",
      "emailSubscriptionRoutes",
      "halloweenRoutes",
      "notificationsRoutes",
    ],
    initializeChatRunFinishedEvents: false,
  },
  "source-events": {
    entry: "src/worker-roles/source-events.ts",
    groups: [
      "webhooksGithubRoutes",
      "webhooksGmailRoutes",
      "webhooksGoogleFormsRoutes",
      "webhooksGoogleCalendarRoutes",
      "webhooksGoogleWorkspaceEventsRoutes",
      "webhooksNotionRoutes",
      "webhooksWorkflowAutomationsRoutes",
      "cronRenewGmailWatchesRoutes",
      "cronRenewGoogleFormsWatchesRoutes",
      "cronRenewGoogleCalendarWatchesRoutes",
      "cronRenewGoogleWorkspaceEventSubscriptionsRoutes",
      "debugMorningBriefRoutes",
      "wechatReceiverRoutes",
      "discordGatewayRoutes",
      "feishuEventsRoutes",
      "teamsBotRoutes",
      "integrationsAgentPhoneRoutes",
      "integrationsWhatsappRoutes",
      "integrationsPhoneDownloadFileRoutes",
      "integrationsPhoneMessageRoutes",
      "integrationsPhoneUploadCompleteRoutes",
      "integrationsTelegramRoutes",
      "integrationsTelegramMessageRoutes",
      "integrationsTelegramUploadCompleteRoutes",
      "integrationsTelegramUploadInitRoutes",
    ],
    initializeChatRunFinishedEvents: true,
  },
  mcp: {
    entry: "src/worker-roles/mcp.ts",
    groups: ["mcpServerRoutes"],
    initializeChatRunFinishedEvents: true,
  },
};

/** Read only the aggregate array and its named imports; never execute handlers. */
export function readAggregateRouteGroups(root = apiRoot) {
  const file = resolve(root, "src/signals/route.ts");
  const source = ts.createSourceFile(
    file,
    readFileSync(file, "utf8"),
    ts.ScriptTarget.Latest,
    true,
  );
  assert.equal(source.parseDiagnostics.length, 0, `Cannot parse ${file}`);
  const imports = new Map();
  const aggregates = [];
  for (const statement of source.statements) {
    if (
      ts.isImportDeclaration(statement) &&
      !statement.importClause?.isTypeOnly &&
      statement.importClause?.namedBindings &&
      ts.isNamedImports(statement.importClause.namedBindings)
    ) {
      assert.ok(ts.isStringLiteral(statement.moduleSpecifier));
      for (const binding of statement.importClause.namedBindings.elements) {
        if (!binding.isTypeOnly) {
          imports.set(binding.name.text, {
            exportName: binding.propertyName?.text ?? binding.name.text,
            module: statement.moduleSpecifier.text,
          });
        }
      }
    }
    if (ts.isVariableStatement(statement)) {
      for (const declaration of statement.declarationList.declarations) {
        if (
          ts.isIdentifier(declaration.name) &&
          declaration.name.text === "ROUTES"
        ) {
          aggregates.push(declaration.initializer);
        }
      }
    }
  }
  assert.equal(
    aggregates.length,
    1,
    "Exactly one aggregate ROUTES is required",
  );
  const array = aggregates[0];
  assert.ok(
    array && ts.isArrayLiteralExpression(array),
    "ROUTES must be a static array",
  );
  const groups = array.elements.map((element) => {
    assert.ok(
      ts.isSpreadElement(element) && ts.isIdentifier(element.expression),
      "Every aggregate route group must be an explicit named spread",
    );
    const name = element.expression.text;
    const binding = imports.get(name);
    assert.ok(binding, `Missing route-group import: ${name}`);
    assert.ok(
      binding.module.startsWith("./routes/"),
      `Unexpected group module: ${name}`,
    );
    return { name, ...binding };
  });
  assert.equal(
    new Set(
      groups.map((group) => {
        return group.name;
      }),
    ).size,
    groups.length,
    "Duplicate aggregate route group",
  );
  return groups;
}

/** Fail closed when a current group is missing, duplicated, stale, or reordered. */
export function assertWorkerRoleOwnership(
  roles = workerRoles,
  groups = readAggregateRouteGroups(),
) {
  const current = new Set(
    groups.map((group) => {
      return group.name;
    }),
  );
  const owners = new Map();
  const entries = new Set();
  for (const [role, config] of Object.entries(roles)) {
    assert.equal(
      typeof config.initializeChatRunFinishedEvents,
      "boolean",
      `Missing initializer policy: ${role}`,
    );
    assert.equal(
      config.entry,
      `src/worker-roles/${role}.ts`,
      `Unexpected role entry: ${role}`,
    );
    assert.ok(
      !entries.has(config.entry),
      `Duplicate role entry: ${config.entry}`,
    );
    entries.add(config.entry);
    assert.ok(config.groups.length > 0, `Empty role: ${role}`);
    for (const group of config.groups) {
      assert.ok(current.has(group), `Stale or unknown route group: ${group}`);
      assert.ok(
        !owners.has(group),
        `Duplicate route group ownership: ${group}`,
      );
      owners.set(group, role);
    }
    assert.deepEqual(
      config.groups,
      groups
        .filter((group) => {
          return config.groups.includes(group.name);
        })
        .map((group) => {
          return group.name;
        }),
      `Route order differs from signals/route.ts: ${role}`,
    );
  }
  for (const group of current) {
    assert.ok(
      owners.has(group),
      `Missing explicit route group ownership: ${group}`,
    );
  }
  return groups;
}

function expectedWorkerRoleImports(config, aggregate) {
  const expected = new Map([
    [
      "createAppWithRoutes",
      {
        module: "../app-factory-runtime",
        name: "createAppWithRoutes",
        typeOnly: false,
      },
    ],
    [
      "createWorkerHandler",
      {
        module: "../worker-runtime",
        name: "createWorkerHandler",
        typeOnly: false,
      },
    ],
    [
      "RouteEntry",
      {
        module: "../signals/route-entry",
        name: "RouteEntry",
        typeOnly: true,
      },
    ],
    ...config.groups.map((name) => {
      const group = aggregate.find((item) => {
        return item.name === name;
      });
      return [
        name,
        {
          module: `../signals/${group.module.slice(2)}`,
          name: group.exportName,
          typeOnly: false,
        },
      ];
    }),
  ]);
  const initializer = config.initializeChatRunFinishedEvents
    ? "configureChatRunFinishedEventDispatcher$"
    : "initializeNoServices$";
  expected.set(initializer, {
    module: config.initializeChatRunFinishedEvents
      ? "../signals/services/chat-run-finished-event-registration.service"
      : "./initialize-no-services",
    name: initializer,
    typeOnly: false,
  });
  return { expected, initializer };
}

function assertWorkerRoleImports(source, role, expected) {
  const imports = new Map();
  const importStatements = source.statements.filter(ts.isImportDeclaration);
  for (const statement of importStatements) {
    assert.ok(ts.isStringLiteral(statement.moduleSpecifier));
    assert.ok(
      statement.importClause &&
        !statement.importClause.name &&
        statement.importClause.namedBindings &&
        ts.isNamedImports(statement.importClause.namedBindings),
      `Role imports must be explicit named imports: ${role}`,
    );
    for (const binding of statement.importClause.namedBindings.elements) {
      assert.ok(
        !imports.has(binding.name.text),
        `Duplicate root import: ${role}/${binding.name.text}`,
      );
      imports.set(binding.name.text, {
        module: statement.moduleSpecifier.text,
        name: binding.propertyName?.text ?? binding.name.text,
        typeOnly: statement.importClause.isTypeOnly || binding.isTypeOnly,
      });
    }
  }
  assert.deepEqual(
    imports,
    expected,
    `Unexpected static root imports: ${role}`,
  );
  assert.equal(
    importStatements.length,
    new Set(
      [...expected.values()].map((item) => {
        return item.module;
      }),
    ).size,
    `Duplicate root module imports: ${role}`,
  );
  // Only imports, one private routes declaration and the complete handler export.
  assert.equal(
    source.statements.length,
    importStatements.length + 2,
    `Unexpected root statements: ${role}`,
  );
}

function assertWorkerRoleRoutes(source, role, config) {
  const declarations = source.statements.filter(ts.isVariableStatement);
  assert.equal(
    declarations.length,
    1,
    `Expected one private routes array: ${role}`,
  );
  const statement = declarations[0];
  assert.equal(
    statement.modifiers?.length ?? 0,
    0,
    `Role routes must stay private: ${role}`,
  );
  assert.equal(
    statement.declarationList.flags,
    ts.NodeFlags.Const,
    `Role routes must be const: ${role}`,
  );
  assert.equal(statement.declarationList.declarations.length, 1);
  const routes = statement.declarationList.declarations[0];
  assert.ok(ts.isIdentifier(routes.name) && routes.name.text === "roleRoutes");
  assert.ok(
    routes.initializer && ts.isArrayLiteralExpression(routes.initializer),
    `Role routes must be an explicit array: ${role}`,
  );
  assert.deepEqual(
    routes.initializer.elements.map((element) => {
      assert.ok(
        ts.isSpreadElement(element) && ts.isIdentifier(element.expression),
        `Role routes must be named spreads: ${role}`,
      );
      return element.expression.text;
    }),
    config.groups,
    `Unexpected role route composition: ${role}`,
  );
}

function assertWorkerRoleHandler(source, role, initializer) {
  const exported = source.statements.filter(ts.isExportAssignment);
  assert.equal(exported.length, 1);
  assert.ok(
    !exported[0].isExportEquals,
    `Role requires a default export: ${role}`,
  );
  const worker = exported[0].expression;
  assert.ok(
    ts.isCallExpression(worker) &&
      ts.isIdentifier(worker.expression) &&
      worker.expression.text === "createWorkerHandler",
    `Role must export its complete Worker handler: ${role}`,
  );
  assert.equal(worker.arguments.length, 1);
  const factory = worker.arguments[0];
  assert.ok(ts.isArrowFunction(factory) && ts.isBlock(factory.body));
  assert.equal(factory.modifiers?.length ?? 0, 0);
  assert.equal(factory.parameters.length, 1);
  const signal = factory.parameters[0];
  assert.ok(
    ts.isIdentifier(signal.name) &&
      signal.name.text === "signal" &&
      !signal.initializer &&
      !signal.dotDotDotToken,
  );
  assert.equal(factory.body.statements.length, 1);
  const returned = factory.body.statements[0];
  assert.ok(ts.isReturnStatement(returned));
  const app = returned.expression;
  assert.ok(
    app &&
      ts.isCallExpression(app) &&
      ts.isIdentifier(app.expression) &&
      app.expression.text === "createAppWithRoutes",
  );
  assert.equal(app.arguments.length, 1);
  const options = app.arguments[0];
  assert.ok(ts.isObjectLiteralExpression(options));
  assert.deepEqual(
    options.properties.map((property) => {
      assert.ok(
        (ts.isShorthandPropertyAssignment(property) ||
          ts.isPropertyAssignment(property)) &&
          ts.isIdentifier(property.name),
      );
      const value = ts.isShorthandPropertyAssignment(property)
        ? property.name
        : property.initializer;
      assert.ok(ts.isIdentifier(value));
      return [property.name.text, value.text];
    }),
    [
      ["signal", "signal"],
      ["routes", "roleRoutes"],
      ["initializeServices$", initializer],
    ],
    `Unexpected app initialization: ${role}`,
  );
}

/** Validate actual static roots before a role build, without importing API code. */
export function assertWorkerRoleEntries(root = apiRoot) {
  const aggregate = assertWorkerRoleOwnership(
    workerRoles,
    readAggregateRouteGroups(root),
  );
  for (const [role, config] of Object.entries(workerRoles)) {
    const file = resolve(root, config.entry);
    const source = ts.createSourceFile(
      file,
      readFileSync(file, "utf8"),
      ts.ScriptTarget.Latest,
      true,
    );
    assert.equal(source.parseDiagnostics.length, 0, `Cannot parse ${file}`);
    const { expected, initializer } = expectedWorkerRoleImports(
      config,
      aggregate,
    );
    assertWorkerRoleImports(source, role, expected);
    assertWorkerRoleRoutes(source, role, config);
    assertWorkerRoleHandler(source, role, initializer);
  }
  return workerRoles;
}
