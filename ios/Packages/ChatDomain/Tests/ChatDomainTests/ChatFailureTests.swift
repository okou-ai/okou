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
        lateOutput
      ], recovering: false)
    XCTAssertEqual(history.latestFailureID, newestFailure.id)
    XCTAssertTrue(history.messages.contains { $0.id == lateOutput.id })
  }

  func testStructuredReasonsOwnRunRecovery() {
    struct RecoveryCase {
      let reason: String
      let kind: ChatFailure.Kind
      let canRetry: Bool
    }
    let cases = [
      RecoveryCase(reason: "session_history_limit", kind: .newChat, canRetry: false),
      RecoveryCase(reason: "context_window_exceeded", kind: .newChat, canRetry: false),
      RecoveryCase(reason: "guest_root_filesystem_full", kind: .retryable, canRetry: true),
      RecoveryCase(reason: "guest_home_filesystem_full", kind: .retryable, canRetry: true),
      RecoveryCase(reason: "execution_timeout", kind: .timeout, canRetry: true),
      RecoveryCase(reason: "insufficient_credits", kind: .billing, canRetry: false),
      RecoveryCase(reason: "provider_insufficient_credits", kind: .settings, canRetry: false),
      RecoveryCase(reason: "invalid_api_key", kind: .settings, canRetry: false),
      RecoveryCase(reason: "invalid_credentials", kind: .settings, canRetry: false),
      RecoveryCase(reason: "reconnect_required", kind: .settings, canRetry: false),
      RecoveryCase(reason: "terms_acceptance_required", kind: .terms, canRetry: false),
      RecoveryCase(reason: "input_too_large", kind: .inputTooLarge, canRetry: false),
      RecoveryCase(reason: "provider_image_too_large", kind: .inputTooLarge, canRetry: false),
      RecoveryCase(reason: "output_token_limit", kind: .outputLimit, canRetry: true),
      RecoveryCase(reason: "provider_rate_limited", kind: .retryable, canRetry: true),
      RecoveryCase(reason: "provider_overloaded", kind: .capacity, canRetry: true),
      RecoveryCase(reason: "provider_stream_timeout", kind: .retryable, canRetry: true),
      RecoveryCase(reason: "provider_queue_timeout", kind: .retryable, canRetry: true),
      RecoveryCase(reason: "provider_server_error", kind: .retryable, canRetry: true),
      RecoveryCase(reason: "response_connection_lost", kind: .retryable, canRetry: true),
      RecoveryCase(reason: "codex_access_program_unavailable", kind: .retryable, canRetry: true),
      RecoveryCase(reason: "safety_policy_refusal", kind: .safety, canRetry: true),
      RecoveryCase(reason: "unsupported_model", kind: .unavailable, canRetry: true),
      RecoveryCase(reason: "usage_limit", kind: .usage, canRetry: true)
    ]
    for testCase in cases {
      let recovery = failure(testCase.reason).recovery(
        personalFramework: .codex)
      XCTAssertEqual(recovery.kind, testCase.kind, testCase.reason)
      XCTAssertEqual(recovery.canRetry, testCase.canRetry, testCase.reason)
    }
  }

  func testUnknownStructuredReasonsNeverBorrowLegacyActionsOrSubscription() {
    for framework: ChatFailure.Framework? in [nil, .codex, .claude] {
      let recovery = failure("future_reason").recovery(
        personalFramework: framework)
      XCTAssertEqual(recovery.kind, .unknown)
      XCTAssertFalse(recovery.canRetry)
      XCTAssertFalse(recovery.showsModelPicker)
    }
    XCTAssertEqual(
      failure(nil).recovery(personalFramework: .claude).kind,
      .unknown)
    XCTAssertFalse(
      failure(nil).recovery(personalFramework: nil).canRetry)
  }

  func testRunRecoveryDoesNotInventFrameworkOrResetHints() {
    for reason in [nil, "unknown", "future_reason"] as [String?] {
      let recovery = failure(reason)
        .recovery(personalFramework: .codex)
      XCTAssertEqual(recovery.kind, .unknown)
      XCTAssertNil(recovery.framework)
      XCTAssertNil(recovery.resetLabel)
      XCTAssertFalse(recovery.canRetry)
    }
    let usage = failure("usage_limit")
      .recovery(personalFramework: .codex)
    XCTAssertEqual(usage.kind, .usage)
    XCTAssertEqual(usage.framework, .codex)
    XCTAssertEqual(usage.window, .unknown)
    XCTAssertFalse(usage.modelScoped)
    XCTAssertNil(usage.resetLabel)
    XCTAssertEqual(
      failure("provider_overloaded")
        .recovery(personalFramework: nil).kind, .capacity)
  }

  func testRunFailureWithoutTextSurvivesProjectionAndOwnsRecovery() throws {
    let event = ChatEvent(
      id: "failure", runId: "run", createdAt: .now, eventType: .runFailed,
      failureReason: "execution_timeout")
    let history = try ChatEventProjection.history(rows: [event], recovering: false)
    XCTAssertEqual(history.executionState, .failed)
    XCTAssertEqual(history.latestFailureID, "failure")
    XCTAssertFalse(try XCTUnwrap(history.messages.first).text.isEmpty)
    XCTAssertEqual(
      history.messages.first?.failure?.recovery(personalFramework: nil).kind, .timeout)
  }

  func testAutonomyOutputErrorStillRequiresContinuation() {
    let output = ChatFailure(
      id: "output", outputError: "AUTONOMY_BUDGET_EXHAUSTED")
    XCTAssertEqual(output.recovery(personalFramework: nil).kind, .autonomy)
    XCTAssertTrue(output.recovery(personalFramework: nil).canRetry)
  }

  func testOnlyLatestRenderableFailureCanOwnActions() throws {
    let failed = ChatEvent(
      id: "failure", createdAt: .now, eventType: .runFailed,
      failureReason: "execution_timeout")
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
      input, partial, ChatEvent(id: "stopped", createdAt: .now, eventType: .runCancelled)
    ] {
      XCTAssertNil(
        try ChatEventProjection.history(rows: [failed, later], recovering: false).latestFailureID)
    }
  }

  private func failure(_ reason: String?) -> ChatFailure {
    ChatFailure(id: "failure", runFailureReason: reason)
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
      failureReason: "execution_timeout")
  }
}
