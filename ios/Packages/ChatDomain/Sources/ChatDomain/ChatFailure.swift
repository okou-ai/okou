import Foundation

/// The original failure fact survives decoding and cache replay; recovery never edits it.
public struct ChatFailure: Equatable, Sendable {
  public let id: String
  public let outputError: String?
  public let reason: String?
  public var isRunFailure: Bool { outputError == nil }

  public init(id: String, runFailureReason: String?) {
    self.id = id
    self.reason = runFailureReason
    self.outputError = nil
  }

  public init(id: String, outputError: String) {
    self.id = id
    self.reason = nil
    self.outputError = outputError
  }

  public enum Kind: Equatable, Sendable {
    case subscription, usage, capacity, unavailable, retryable, settings, newChat, inputTooLarge
    case outputLimit, terms, safety, timeout, autonomy, billing, unknown
  }
  public enum Framework: String, Sendable { case codex, claude }
  public enum Window: Equatable, Sendable { case fiveHour, weekly, model, unknown }

  public struct Recovery: Equatable, Sendable {
    public let kind: Kind
    public let framework: Framework?
    public let window: Window?
    public let modelScoped: Bool
    public let resetLabel: String?
    public var canRetry: Bool {
      ![.settings, .newChat, .inputTooLarge, .terms, .billing, .unknown].contains(kind)
    }
    public var showsModelPicker: Bool {
      [.subscription, .usage, .capacity, .unavailable, .safety].contains(kind)
    }
    public var continues: Bool { [.timeout, .autonomy, .outputLimit].contains(kind) }
  }

  /// Run lifecycle recovery uses structured facts; output errors retain their own contract.
  public func recovery(personalFramework: Framework?) -> Recovery {
    guard let error = outputError else { return runRecovery(personalFramework: personalFramework) }
    let normalized = error.replacingOccurrences(of: #"\s+"#, with: " ", options: .regularExpression)
      .trimmingCharacters(in: .whitespacesAndNewlines)
    func matches(_ pattern: String) -> Bool {
      normalized.range(of: pattern, options: [.regularExpression, .caseInsensitive]) != nil
    }
    let codexUsage = matches(#"you(?:'|’)ve hit your usage limit\b"#)
    let claudeUsage = matches(
      #"you(?:'|’)ve hit your (?:session|weekly|5[- ]hour|opus(?:\s+[\w.-]+)?|sonnet(?:\s+[\w.-]+)?|haiku(?:\s+[\w.-]+)?) limit\b|\bclaude(?: code)? (?:rate|usage) limit reached\b"#
    )
    let codexCapacity = matches(#"selected model is at capacity\.? please try a different model"#)
    let claudeCapacity = matches(
      #"\bclaude\b.*\b(?:is overloaded|overloaded|at capacity)\b|\b529\b.*\boverload|\boverloaded_error\b"#
    )
    let unsupported = Self.isUnsupportedCodexModel(error)
    let kind: Kind
    if ["insufficient_credits", "pro_required"].contains(normalized.lowercased()) {
      kind = .billing
    } else if normalized == "This run reached its execution time limit."
      || normalized.range(
        of: #"^Agent execution timed out after [1-9]\d* seconds$"#, options: .regularExpression)
        != nil
    {
      kind = .timeout
    } else if normalized.uppercased() == "AUTONOMY_BUDGET_EXHAUSTED" {
      kind = .autonomy
    } else if unsupported {
      kind = .unavailable
    } else if codexCapacity || claudeCapacity {
      kind = .capacity
    } else if codexUsage || claudeUsage {
      kind = .usage
    } else {
      kind = .unknown
    }
    let subscriptionFallback = kind == .unknown && personalFramework != nil
    let framework: Framework? =
      kind == .usage
      ? (codexUsage ? .codex : (claudeUsage ? .claude : personalFramework))
      : (kind == .capacity
        ? (codexCapacity ? .codex : (claudeCapacity ? .claude : nil))
        : (kind == .unavailable && unsupported ? .codex : nil))
    let window: Window? =
      kind != .usage
      ? nil
      : (framework == .claude && claudeUsage
        ? (matches(#"\bweekly\b"#)
          ? .weekly
          : (matches(#"\b(?:session|5[- ]hour)\b"#)
            ? .fiveHour
            : (matches(#"\b(?:opus|sonnet|haiku)\b"#) ? .model : .unknown)))
        : (codexUsage && matches(#"\busage limit for\b"#) ? .model : .unknown))
    let resetRange = normalized.range(
      of: #"\b(?:resets?|try again at)\s+(.+)$"#, options: [.regularExpression, .caseInsensitive])
    let resetLabel = resetRange.map {
      String(normalized[$0]).replacingOccurrences(
        of: #"^(?:resets?|try again at)\s+|[.!]+$"#, with: "",
        options: [.regularExpression, .caseInsensitive])
    }
    // These two legacy fallback destinations are also owned by the PWA error card.
    let fallbackKind: Kind =
      normalized.localizedCaseInsensitiveContains("No model provider is available for this run")
      ? .settings
      : (normalized.localizedCaseInsensitiveContains("Provider not compatible")
        || error.contains("Cannot continue session")
        || error.contains("Invalid signature in thinking block")
        ? .newChat : .unknown)
    return Recovery(
      kind: subscriptionFallback ? .subscription : (kind == .unknown ? fallbackKind : kind),
      framework: subscriptionFallback ? personalFramework : framework, window: window,
      modelScoped: kind == .capacity || kind == .unavailable || window == .model,
      resetLabel: kind == .usage && (codexUsage || claudeUsage) ? resetLabel : nil)
  }

  private func runRecovery(personalFramework: Framework?) -> Recovery {
    let kind: Kind
    switch reason {
    case "session_history_limit", "context_window_exceeded": kind = .newChat
    case "guest_root_filesystem_full", "guest_home_filesystem_full", "provider_rate_limited",
      "provider_stream_timeout", "provider_queue_timeout", "provider_server_error",
      "response_connection_lost", "codex_access_program_unavailable", "provider_bad_request":
      kind = .retryable
    case "execution_timeout": kind = .timeout
    case "insufficient_credits": kind = .billing
    case "provider_insufficient_credits", "invalid_api_key", "invalid_credentials",
      "reconnect_required":
      kind = .settings
    case "terms_acceptance_required": kind = .terms
    case "input_too_large", "provider_image_too_large": kind = .inputTooLarge
    case "output_token_limit": kind = .outputLimit
    case "provider_overloaded": kind = .capacity
    case "safety_policy_refusal": kind = .safety
    case "unsupported_model", "provider_model_restricted": kind = .unavailable
    case "usage_limit": kind = .usage
    default: kind = .unknown
    }
    // This framework describes the next retry's current route, not the failed account.
    return Recovery(
      kind: kind, framework: kind == .usage ? personalFramework : nil,
      window: kind == .usage ? .unknown : nil,
      modelScoped: kind == .capacity || kind == .unavailable, resetLabel: nil)
  }

  /// The legacy Codex diagnostic must contain the structured invalid-request envelope.
  private static func isUnsupportedCodexModel(_ source: String) -> Bool {
    guard source.contains("not supported when using Codex with a ChatGPT account") else {
      return false
    }
    struct Envelope: Decodable {
      struct Detail: Decodable {
        let type: String
        let message: String
      }
      let error: Detail
    }
    for start in source.indices where source[start] == "{" {
      var depth = 0
      var quoted = false
      var escaped = false
      for index in source[start...].indices {
        let character = source[index]
        if quoted {
          if escaped {
            escaped = false
          } else if character == "\\" {
            escaped = true
          } else if character == "\"" {
            quoted = false
          }
        } else if character == "\"" {
          quoted = true
        } else if character == "{" {
          depth += 1
        } else if character == "}" {
          depth -= 1
          if depth == 0 {
            if let value = try? JSONDecoder().decode(
              Envelope.self, from: Data(source[start...index].utf8)),
              value.error.type == "invalid_request_error",
              value.error.message.range(
                of:
                  #"^The '[^']+' model is not supported when using Codex with a ChatGPT account\.$"#,
                options: .regularExpression) != nil
            {
              return true
            }
            break
          }
        }
      }
    }
    return false
  }
}
