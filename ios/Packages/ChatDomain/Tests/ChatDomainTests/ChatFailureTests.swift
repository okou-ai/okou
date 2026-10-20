import ChatDomain
import Foundation
import XCTest

final class ChatFailureTests: XCTestCase {
  func testOlderRunsLateFailureCannotReviveActionsAfterANewerTurn() throws {
    let oldInput = input("old-input", run: "old-run")
    let newInput = input("new-input", run: "new-run")
    let lateFailure = failed("late-failure", run: "old-run")
    for newer in [newInput, input("queued-input", run: nil)] {
      let history = try ChatEventProjection.history(
        rows: [oldInput, newer, lateFailure], recovering: false)
      XCTAssertNil(history.latestFailureID)
      XCTAssertTrue(history.messages.contains { $0.id == lateFailure.id })
    }
    let completed = ChatEvent(
      id: "completed", runId: "new-run", createdAt: .now, eventType: .runCompleted)
    XCTAssertNil(
      try ChatEventProjection.history(
        rows: [oldInput, newInput, completed, lateFailure], recovering: false
      ).latestFailureID)
  }

  func testOlderRunsLateOutputDoesNotHideTheNewerTurnsFailure() throws {
    let newestFailure = failed("current-failure", run: "new-run")
    let lateOutput = ChatEvent(
      id: "late-output", runId: "old-run", createdAt: .now, eventType: .outputMessage,
      payload: .init(content: "Old answer"))
    let history = try ChatEventProjection.history(
      rows: [
        input("old-input", run: "old-run"), input("new-input", run: "new-run"), newestFailure,
        lateOutput,
      ], recovering: false)
    XCTAssertEqual(history.latestFailureID, newestFailure.id)
    XCTAssertTrue(history.messages.contains { $0.id == lateOutput.id })
  }

  func testStructuredReasonsOwnRecoveryDespiteMisleadingLegacyText() {
    let cases: [(String, ChatFailure.Kind, Bool)] = [
      ("session_history_limit", .newChat, false), ("context_window_exceeded", .newChat, false),
      ("guest_root_filesystem_full", .retryable, true),
      ("guest_home_filesystem_full", .retryable, true),
      ("execution_timeout", .timeout, true), ("insufficient_credits", .billing, false),
      ("provider_insufficient_credits", .settings, false), ("invalid_api_key", .settings, false),
      ("invalid_credentials", .settings, false), ("reconnect_required", .settings, false),
      ("terms_acceptance_required", .terms, false), ("input_too_large", .inputTooLarge, false),
      ("provider_image_too_large", .inputTooLarge, false),
      ("output_token_limit", .outputLimit, true),
      ("provider_rate_limited", .retryable, true), ("provider_overloaded", .capacity, true),
      ("provider_stream_timeout", .retryable, true), ("provider_queue_timeout", .retryable, true),
      ("provider_server_error", .retryable, true), ("response_connection_lost", .retryable, true),
      ("codex_access_program_unavailable", .retryable, true),
      ("safety_policy_refusal", .safety, true),
      ("unsupported_model", .unavailable, true), ("usage_limit", .usage, true),
    ]
    for (reason, kind, retry) in cases {
      let recovery = failure(reason, text: "AUTONOMY_BUDGET_EXHAUSTED").recovery(
        personalFramework: .codex)
      XCTAssertEqual(recovery.kind, kind, reason)
      XCTAssertEqual(recovery.canRetry, retry, reason)
    }
  }

  func testUnknownStructuredReasonsNeverBorrowLegacyActionsOrSubscription() {
    for framework: ChatFailure.Framework? in [nil, .codex, .claude] {
      let recovery = failure("future_reason", text: "You've hit your usage limit").recovery(
        personalFramework: framework)
      XCTAssertEqual(recovery.kind, .unknown)
      XCTAssertFalse(recovery.canRetry)
      XCTAssertFalse(recovery.showsModelPicker)
    }
    XCTAssertEqual(
      failure(nil, text: "Unclassified provider failure").recovery(personalFramework: .claude).kind,
      .subscription)
    XCTAssertFalse(
      failure(nil, text: "Unclassified provider failure").recovery(personalFramework: nil).canRetry)
  }

  func testLegacyUsageUsesExactFrameworkAndWindowDetails() {
    let codex = failure(nil, text: "You've hit your usage limit for model X. Try again at 8:00 PM.")
      .recovery(personalFramework: .claude)
    XCTAssertEqual(codex.framework, .codex)
    XCTAssertEqual(codex.window, .model)
    XCTAssertTrue(codex.modelScoped)
    XCTAssertEqual(codex.resetLabel, "8:00 PM")
    for (text, window): (String, ChatFailure.Window) in [
      ("You've hit your session limit. Resets 9pm.", .fiveHour),
      ("You've hit your weekly limit", .weekly), ("You've hit your Opus limit", .model),
      ("Claude Code usage limit reached", .unknown),
    ] {
      let recovery = failure(nil, text: text).recovery(personalFramework: .codex)
      XCTAssertEqual(recovery.framework, .claude)
      XCTAssertEqual(recovery.window, window)
    }
    XCTAssertEqual(
      failure("usage_limit", text: "Provider allowance reached").recovery(personalFramework: .codex)
        .framework, .codex)
  }

  func testLegacyTimeoutAutonomyAndCodexDiagnosticHaveNarrowRecognition() {
    for text in [
      "This run reached its execution time limit.", "Agent execution timed out after 120 seconds",
    ] {
      XCTAssertEqual(failure(nil, text: text).recovery(personalFramework: nil).kind, .timeout)
    }
    XCTAssertEqual(
      failure(nil, text: "AUTONOMY_BUDGET_EXHAUSTED").recovery(personalFramework: nil).kind,
      .autonomy)
    let diagnostic =
      #"prefix {"error":{"type":"invalid_request_error","message":"The 'example' model is not supported when using Codex with a ChatGPT account."}} suffix"#
    XCTAssertEqual(
      failure(nil, text: diagnostic).recovery(personalFramework: nil).kind, .unavailable)
    XCTAssertEqual(
      failure(
        nil, text: "The 'example' model is not supported when using Codex with a ChatGPT account."
      ).recovery(personalFramework: nil).kind, .unknown)
    XCTAssertEqual(
      failure(nil, text: "Request timeout").recovery(personalFramework: nil).kind, .unknown)
    XCTAssertEqual(
      failure(nil, text: "agent execution timed out after 120 seconds").recovery(
        personalFramework: nil
      ).kind, .unknown)
  }

  func testOnlyLatestRenderableFailureCanOwnActions() throws {
    let failed = ChatEvent(
      id: "failure", createdAt: .now, eventType: .runFailed,
      payload: .init(error: "Time limit", failureReason: "execution_timeout"))
    let partial = ChatEvent(
      id: "partial", createdAt: .now, eventType: .outputMessage,
      payload: .init(content: "Saved answer"))
    let input = ChatEvent(
      id: "input", createdAt: .now, eventType: .inputPrompt,
      payload: .init(
        userMessage: .init(version: 1, parts: [.init(type: "text", text: "Next input")])))
    let history = try ChatEventProjection.history(rows: [partial, failed], recovering: false)
    XCTAssertEqual(history.latestFailureID, "failure")
    XCTAssertEqual(history.messages.first?.text, "Saved answer")
    XCTAssertEqual(history.messages.last?.failure?.reason, "execution_timeout")
    for later in [
      input, partial, ChatEvent(id: "stopped", createdAt: .now, eventType: .runCancelled),
    ] {
      XCTAssertNil(
        try ChatEventProjection.history(rows: [failed, later], recovering: false).latestFailureID)
    }
  }

  private func failure(_ reason: String?, text: String) -> ChatFailure {
    ChatFailure(id: "failure", error: text, reason: reason, isRunFailure: true)
  }

  private func input(_ id: String, run: String?) -> ChatEvent {
    ChatEvent(
      id: id, runId: run, createdAt: .now, eventType: .inputPrompt,
      payload: .init(userMessage: .init(version: 1, parts: [.init(type: "text", text: "Question")]))
    )
  }

  private func failed(_ id: String, run: String) -> ChatEvent {
    ChatEvent(
      id: id, runId: run, createdAt: .now, eventType: .runFailed,
      payload: .init(error: "Timeout", failureReason: "execution_timeout"))
  }
}
