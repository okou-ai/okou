/** Validate writes using authoritative identity, never a name. */
export function agentConfigurationUpdateError(isDefaultAgent: boolean) {
  return isDefaultAgent
    ? {
        code: "DEFAULT_AGENT_READ_ONLY",
        message:
          "The workspace default Okou agent is read-only and cannot be modified.",
      }
    : null;
}

export function agentDeletionError(isDefaultAgent: boolean) {
  return isDefaultAgent
    ? {
        code: "DEFAULT_AGENT_DELETE_LOCKED",
        message: "The workspace default Okou agent cannot be deleted.",
      }
    : null;
}
