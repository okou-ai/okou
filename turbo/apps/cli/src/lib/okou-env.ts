function environmentValue(name: string): string | undefined {
  return process.env[name] || undefined;
}

function okouEnvironmentValue(suffix: string): string | undefined {
  return environmentValue(`OKOU_${suffix}`);
}

export function getOkouToken(): string | undefined {
  return okouEnvironmentValue("TOKEN");
}

export function getOkouAgentId(): string | undefined {
  return okouEnvironmentValue("AGENT_ID");
}

export function getOkouChatThreadId(): string | undefined {
  return okouEnvironmentValue("CHAT_THREAD_ID");
}

export function getOkouAppUrl(): string | undefined {
  return okouEnvironmentValue("APP_URL");
}

export function getOkouConnectorAccountContextFile(): string | undefined {
  return okouEnvironmentValue("CONNECTOR_ACCOUNT_CONTEXT_FILE");
}
