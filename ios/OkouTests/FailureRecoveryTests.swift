import ChatData
import ChatDataTestSupport
import ChatDomain
import SwiftUI
import XCTest

@testable import Okou

@MainActor
final class FailureRecoveryTests: XCTestCase {
  func testRestartingAnUncertainContinuePreservesAnUnuploadedAttachmentDraft() async throws {
    let fixture = FailureRecoveryFixture()
    fixture.state.value.withLock {
      $0.sendStatus = 503
      $0.persistSend = false
    }
    let directory = FileManager.default.temporaryDirectory.appending(path: UUID().uuidString)
    try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
    defer { try? FileManager.default.removeItem(at: directory) }
    let source = directory.appending(path: "notes.txt")
    let contents = Data("Unsent local attachment".utf8)
    try contents.write(to: source)
    let storage = ChatDraftStorage(
      scope: ChatCacheScope(
        apiBaseURL: fixture.http.baseURL, userID: "user", workspaceID: "workspace"),
      directory: directory)
    let (original, models) = await fixture.conversation(draftStorage: storage)
    original.attachmentDraft.importFiles([source])
    try await eventually {
      original.attachmentDraft.items.contains { if case .failed = $0.state { true } else { false } }
    }
    let copy = try XCTUnwrap(original.attachmentDraft.items.first?.file.url)
    defer { try? FileManager.default.removeItem(at: copy.deletingLastPathComponent()) }
    XCTAssertNil(original.composer.value.draftUserMessage)
    await original.recoverFailure(FailureRecoveryFixture.failureID)
    let eventID = try XCTUnwrap(original.pending.first?.id)
    XCTAssertEqual(original.pending.first?.text, "continue")
    original.close()
    models.close()
    let (restored, restoredModels) = await fixture.conversation(draftStorage: storage)
    defer {
      restored.close()
      restoredModels.close()
    }
    XCTAssertEqual(restored.pending.first?.id, eventID)
    XCTAssertEqual(restored.attachmentDraft.items.count, 1)
    XCTAssertEqual(restored.attachmentDraft.items.first?.file.url, copy)
    XCTAssertTrue(FileManager.default.fileExists(atPath: copy.path))
    XCTAssertEqual(try Data(contentsOf: copy), contents)
    XCTAssertEqual(fixture.state.value.withLock { $0.sends.count }, 1)
  }

  func testFailedCurrentModelReadCannotResetThePreviouslySelectedAccount() async throws {
    let fixture = FailureRecoveryFixture(
      reason: "usage_limit", error: "You've hit your usage limit")
    let (conversation, models) = await fixture.conversation()
    defer {
      conversation.close()
      models.close()
    }
    let failure = try XCTUnwrap(conversation.messages.last?.failure)
    fixture.state.value.withLock { $0.metadataStatus = 503 }
    await conversation.recoverFailure(failure.id, resetUsage: true)
    XCTAssertTrue(fixture.state.value.withLock { $0.resetKeys.isEmpty && $0.sends.isEmpty })
    XCTAssertFalse(conversation.isRecoveringFailure)
    XCTAssertNotNil(conversation.modelSelection?.error)
    fixture.state.value.withLock { $0.metadataStatus = 200 }
    await conversation.modelSelection?.refresh()
    await conversation.recoverFailure(failure.id, resetUsage: true)
    XCTAssertEqual(fixture.state.value.withLock { $0.resetKeys.count }, 1)
    XCTAssertEqual(fixture.state.value.withLock { $0.sends.count }, 1)
  }

  func testEmptyResetCreditsAndFailedAccountRefreshCannotSpendCachedAccount() async throws {
    let fixture = FailureRecoveryFixture(
      reason: "usage_limit", error: "You've hit your usage limit")
    let (conversation, models) = await fixture.conversation()
    defer {
      conversation.close()
      models.close()
    }
    let failure = try XCTUnwrap(conversation.messages.last?.failure)
    fixture.state.value.withLock {
      $0.accounts = $0.accounts.replacingOccurrences(
        of: "\"subscriptionResetCredits\":2", with: "\"subscriptionResetCredits\":0")
    }
    await conversation.refreshFailureAccounts()
    XCTAssertNil(conversation.failureState(failure).resetAccountID)
    fixture.state.value.withLock { $0.accountStatus = 503 }
    await conversation.recoverFailure(failure.id, resetUsage: true)
    XCTAssertTrue(fixture.state.value.withLock { $0.sends.isEmpty && $0.resetKeys.isEmpty })
    XCTAssertNotNil(conversation.failureState(failure).accountError)
  }

  func testSharedAccountRefreshCanSupersedeCardReadWithoutLeavingItLoading() async throws {
    let fixture = FailureRecoveryFixture(
      reason: "usage_limit", error: "You've hit your usage limit")
    let (conversation, models) = await fixture.conversation()
    defer {
      conversation.close()
      models.close()
    }
    let failure = try XCTUnwrap(conversation.messages.last?.failure)
    let gate = ModelResponseGate()
    defer { gate.open() }
    fixture.state.value.withLock {
      $0.accountGate = gate
      $0.accounts = $0.accounts.replacingOccurrences(
        of: "sample@example.invalid", with: "new-active@example.invalid")
    }
    let cardRead = Task { await conversation.refreshFailureAccounts() }
    try await eventually { models.subscriptions.isLoading }
    let settingsRead = Task { await models.subscriptions.refresh(force: true) }
    await Task.yield()
    gate.open()
    await cardRead.value
    _ = await settingsRead.value
    XCTAssertEqual(conversation.failureState(failure).accountLabel, "new-active@example.invalid")
    XCTAssertFalse(conversation.failureState(failure).isBusy)
  }

  func testNewInputWhileResetIsInFlightRemovesOldActionsAndNeverContinues() async throws {
    let fixture = FailureRecoveryFixture(
      reason: "usage_limit", error: "You've hit your usage limit")
    let (conversation, models) = await fixture.conversation()
    defer {
      conversation.close()
      models.close()
    }
    let failure = try XCTUnwrap(conversation.messages.last?.failure)
    let gate = ModelResponseGate()
    defer { gate.open() }
    fixture.state.value.withLock { $0.resetGate = gate }
    let recovering = Task { await conversation.recoverFailure(failure.id, resetUsage: true) }
    try await eventually { fixture.state.value.withLock { !$0.resetKeys.isEmpty } }
    fixture.state.value.withLock {
      $0.rows.append(
        FailureRecoveryFixture.row(
          4, type: "input.prompt",
          payload:
            #"{"userMessage":{"version":1,"parts":[{"type":"text","text":"New input from another client"}]}}"#
        ))
      $0.lastID = FailureRecoveryFixture.id(4)
    }
    await conversation.refresh()
    XCTAssertFalse(conversation.failureState(failure).isCurrent)
    gate.open()
    await recovering.value
    XCTAssertTrue(fixture.state.value.withLock { $0.sends.isEmpty })
    XCTAssertTrue(conversation.messages.contains { $0.id == failure.id })
  }

  func testContinueUsesCurrentModelAndPreservesStructuredDraftAndAttachments() async throws {
    let document = ChatDraftDocument(parts: [
      .object(["type": .string("text"), "text": .string("An unfinished follow-up")]),
      .object([
        "type": .string("chat_thread"), "chatThreadId": .string(ModelHTTPFixtures.threadID),
        "titleSnapshot": .string("Related chat"),
      ]),
      .object([
        "type": .string("file"), "fileId": .string("draft-file"),
        "filenameSnapshot": .string("notes.txt"), "contentType": .string("text/plain"),
      ]),
    ])
    let file = ChatAttachment(
      id: "draft-file", filename: "notes.txt", contentType: "text/plain", size: 12,
      url: "https://file.example.invalid/draft")
    let fixture = FailureRecoveryFixture(
      draft: ComposerDraft(
        document: document,
        attachments: [.init(attachment: file, url: "https://file.example.invalid/draft")]))
    fixture.state.value.withLock { $0.accountStatus = 503 }
    let (conversation, models) = await fixture.conversation()
    defer {
      conversation.close()
      models.close()
    }
    try await eventually { conversation.attachmentDraft.isReady }
    let draft = conversation.composer.value
    // A different client changes the thread's model before recovery.
    fixture.state.value.withLock { $0.model = "claude-model" }
    await conversation.recoverFailure(FailureRecoveryFixture.failureID)
    let sends = fixture.state.value.withLock { $0.sends }
    XCTAssertEqual(sends.count, 1)
    let body = try XCTUnwrap(JSONSerialization.jsonObject(with: sends[0]) as? [String: Any])
    XCTAssertEqual(body["prompt"] as? String, "continue")
    XCTAssertEqual(body["model"] as? String, "claude-model")
    XCTAssertEqual(conversation.composer.value, draft)
    XCTAssertEqual(conversation.attachmentDraft.uploaded.map(\.id), ["draft-file"])
    XCTAssertNil(models.subscriptions.error, "Execution recovery must not depend on quota reads")
    XCTAssertTrue(conversation.messages.contains { $0.text == "Already generated content." })
    let failure = try XCTUnwrap(
      conversation.messages.first { $0.id == FailureRecoveryFixture.failureID }?.failure)
    XCTAssertFalse(conversation.failureState(failure).isCurrent)
    await conversation.recoverFailure(failure.id)
    XCTAssertEqual(fixture.state.value.withLock { $0.sends.count }, 1)
  }

  func testUncertainContinueReconcilesBeforeReusingItsClientIdentity() async throws {
    let fixture = FailureRecoveryFixture()
    fixture.state.value.withLock {
      $0.sendStatus = 503
      $0.persistSend = false
    }
    let (conversation, models) = await fixture.conversation()
    defer {
      conversation.close()
      models.close()
    }
    conversation.draft = "Retain this draft"
    await conversation.recoverFailure(FailureRecoveryFixture.failureID)
    let pending = try XCTUnwrap(conversation.pending.first)
    XCTAssertEqual(pending.text, "continue")
    XCTAssertTrue(pending.needsRetry)
    let failure = try XCTUnwrap(
      conversation.messages.first { $0.id == FailureRecoveryFixture.failureID }?.failure)
    XCTAssertFalse(conversation.failureState(failure).isCurrent)
    fixture.state.value.withLock {
      $0.sendStatus = 200
      $0.persistSend = true
    }
    await conversation.retry(pending)
    XCTAssertTrue(conversation.pending.isEmpty)
    let bodies = try fixture.state.value.withLock { $0.sends }.map {
      try XCTUnwrap(JSONSerialization.jsonObject(with: $0) as? [String: Any])
    }
    XCTAssertEqual(bodies.count, 2)
    XCTAssertEqual(bodies[0]["clientEventId"] as? String, bodies[1]["clientEventId"] as? String)
    XCTAssertEqual(conversation.draft, "Retain this draft")
  }

  func testNoCreditOrResetFailureNeverContinuesAndCanBeRetried() async throws {
    for outcome in ["noCredit", "failure"] {
      let fixture = FailureRecoveryFixture(
        reason: "usage_limit", error: "You've hit your usage limit")
      let (conversation, models) = await fixture.conversation()
      defer {
        conversation.close()
        models.close()
      }
      let failure = try XCTUnwrap(conversation.messages.last?.failure)
      XCTAssertEqual(conversation.failureState(failure).resetAccountID, ModelHTTPFixtures.accountID)
      fixture.state.value.withLock { $0.resetOutcome = outcome }
      await conversation.recoverFailure(failure.id, resetUsage: true)
      XCTAssertTrue(fixture.state.value.withLock { $0.sends.isEmpty })
      XCTAssertFalse(conversation.isRecoveringFailure)
      XCTAssertTrue(conversation.failureState(failure).isCurrent)
      fixture.state.value.withLock { $0.resetOutcome = "reset" }
      await conversation.recoverFailure(failure.id, resetUsage: true)
      XCTAssertEqual(fixture.state.value.withLock { $0.sends.count }, 1)
      let keys = fixture.state.value.withLock { $0.resetKeys }
      XCTAssertEqual(keys.count, 2)
      XCTAssertEqual(Set(keys).count, outcome == "failure" ? 1 : 2)
    }
  }

  func testOnlyCurrentMatchingAccountProvidesResetWindows() async throws {
    let fixture = FailureRecoveryFixture(
      reason: "usage_limit", error: "You've hit your usage limit")
    let (conversation, models) = await fixture.conversation()
    defer {
      conversation.close()
      models.close()
    }
    let failure = try XCTUnwrap(conversation.messages.last?.failure)
    XCTAssertEqual(conversation.failureState(failure).accountLabel, "sample@example.invalid")
    XCTAssertEqual(conversation.failureState(failure).resetDetails.count, 1)
    fixture.state.value.withLock { $0.model = "claude-model" }
    await conversation.modelSelection?.refresh()
    XCTAssertNil(conversation.failureState(failure).accountLabel)
    XCTAssertNil(conversation.failureState(failure).resetAccountID)
    XCTAssertTrue(conversation.failureState(failure).resetDetails.isEmpty)
    await conversation.recoverFailure(failure.id, resetUsage: true)
    XCTAssertTrue(fixture.state.value.withLock { $0.resetKeys.isEmpty && $0.sends.isEmpty })
  }

  func testDoubleTapAndLeavingDetailFenceLateResetCompletion() async throws {
    let fixture = FailureRecoveryFixture(
      reason: "usage_limit", error: "You've hit your usage limit")
    let (conversation, models) = await fixture.conversation()
    defer {
      conversation.close()
      models.close()
    }
    let owner = UUID()
    conversation.setDetailVisible(true, owner: owner)
    let gate = ModelResponseGate()
    defer { gate.open() }
    fixture.state.value.withLock { $0.resetGate = gate }
    let first = Task {
      await conversation.recoverFailure(FailureRecoveryFixture.failureID, resetUsage: true)
    }
    try await eventually { fixture.state.value.withLock { !$0.resetKeys.isEmpty } }
    await conversation.recoverFailure(FailureRecoveryFixture.failureID, resetUsage: true)
    XCTAssertEqual(fixture.state.value.withLock { $0.resetKeys.count }, 1)
    conversation.setDetailVisible(false, owner: owner)
    gate.open()
    await first.value
    XCTAssertTrue(fixture.state.value.withLock { $0.sends.isEmpty })
    XCTAssertFalse(conversation.isRecoveringFailure)
  }

  func testHTTPFailureFactsSurviveSQLiteReplay() async throws {
    let fixture = FailureRecoveryFixture(reason: "provider_image_too_large", error: "Image limit")
    let directory = FileManager.default.temporaryDirectory.appending(path: UUID().uuidString)
    defer { try? FileManager.default.removeItem(at: directory) }
    let scope = ChatCacheScope(
      apiBaseURL: fixture.http.baseURL, userID: "user", workspaceID: "workspace")
    let (conversation, models) = await fixture.conversation(
      cache: ChatCache(scope: scope, directory: directory))
    defer {
      conversation.close()
      models.close()
    }
    let restarted = ChatSync(
      client: fixture.http.client, cache: ChatCache(scope: scope, directory: directory))
    let history = await restarted.cachedHistory(threadID: ModelHTTPFixtures.threadID)
    let failure = try XCTUnwrap(history?.messages.last?.failure)
    XCTAssertEqual(failure.reason, "provider_image_too_large")
    XCTAssertEqual(history?.latestFailureID, failure.id)
    XCTAssertEqual(failure.recovery(personalFramework: .codex).kind, .inputTooLarge)
    XCTAssertFalse(failure.recovery(personalFramework: .codex).canRetry)
  }

  func testBillingUsesServerCapabilitiesAndMemberPermissions() async throws {
    let fixture = FailureRecoveryFixture(
      reason: "insufficient_credits", error: "insufficient_credits")
    let (conversation, models) = await fixture.conversation()
    defer {
      conversation.close()
      models.close()
    }
    let failure = try XCTUnwrap(conversation.messages.last?.failure)
    XCTAssertTrue(try XCTUnwrap(conversation.failureState(failure).billing).canManageBilling)
    fixture.state.value.withLock {
      $0.billingAdmin = false
      $0.canBuyCredits = false
    }
    await conversation.refreshFailureAccounts()
    let billing = try XCTUnwrap(conversation.failureState(failure).billing)
    XCTAssertFalse(billing.canManageBilling)
    XCTAssertFalse(billing.canBuyCredits)
    XCTAssertTrue(
      AssistantFailureCopy.content(conversation.failureState(failure)).description.contains("admin")
    )
    await conversation.recoverFailure(failure.id)
    XCTAssertTrue(fixture.state.value.withLock { $0.sends.isEmpty })
    fixture.state.value.withLock {
      $0.credits = 100
      $0.canBuyCredits = true
    }
    await conversation.refreshFailureAccounts()
    XCTAssertEqual(
      AssistantFailureCopy.content(conversation.failureState(failure)).title, "Credits available")
    conversation.draft = "A new input"
    await conversation.send()
    let historical = conversation.failureState(failure)
    XCTAssertFalse(historical.isCurrent)
    XCTAssertFalse(AssistantFailureCopy.content(historical).description.contains("Checking"))
  }

}
