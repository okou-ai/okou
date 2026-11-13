import ChatData
import ChatDataTestSupport
import ChatDomain
import SwiftUI
import XCTest

@testable import Okou

@MainActor
final class FailureRecoveryTests: XCTestCase {
  func testNewFailureAcceptsOneRetryBeforeTheAcceptedSendFinishesHistoryRefresh() async throws {
    var visible = false
    let fixture = FailureRecoveryFixture()
    let (conversation, models) = await fixture.conversation(isVisible: { visible })
    defer {
      conversation.close()
      models.close()
    }
    visible = true
    let gate = ModelResponseGate()
    let started = expectation(description: "Failed run rendered before mark-read completes")
    fixture.state.value.withLock {
      $0.failNextSend = true
      $0.markReadGate = gate
      $0.markReadRequested = { started.fulfill() }
    }
    conversation.draft = "New request"
    let sending = Task { await conversation.send() }
    addTeardownBlock {
      sending.cancel()
      gate.open()
      await sending.value
    }
    await fulfillment(of: [started], timeout: 3)
    let failure = try XCTUnwrap(conversation.messages.last?.failure)
    XCTAssertFalse(conversation.failureState(failure).isBusy)
    XCTAssertTrue(conversation.failureState(failure).canSend)
    let recovery = Task { await conversation.recoverFailure(failure.id) }
    addTeardownBlock {
      recovery.cancel()
      gate.open()
      await recovery.value
    }
    try await waitForBusinessResult { conversation.isRecoveringFailure }
    gate.open()
    await sending.value
    await recovery.value

    let sends = fixture.state.value.withLock { $0.sends }
    XCTAssertEqual(sends.count, 2)
    let data = try XCTUnwrap(sends.last)
    let body = try XCTUnwrap(JSONSerialization.jsonObject(with: data) as? [String: Any])
    XCTAssertEqual(body["prompt"] as? String, "continue")
    XCTAssertTrue(conversation.messages.contains { $0.role == .user && $0.text == "continue" })
  }

  func testRunRecoveryContinuesWhenOnlyTheAutomaticReadReceiptFails() async throws {
    let fixture = FailureRecoveryFixture()
    fixture.state.value.withLock { $0.markReadStatus = 503 }
    let (conversation, models) = await fixture.conversation(isVisible: { true })
    defer {
      conversation.close()
      models.close()
    }

    await conversation.recoverFailure(FailureRecoveryFixture.failureID)

    let sends = fixture.state.value.withLock { $0.sends }
    XCTAssertEqual(sends.count, 1)
    let body = try XCTUnwrap(
      JSONSerialization.jsonObject(with: try XCTUnwrap(sends.first)) as? [String: Any])
    XCTAssertEqual(body["prompt"] as? String, "continue")
    XCTAssertTrue(conversation.messages.contains { $0.role == .user && $0.text == "continue" })
  }

  func testOneRetrySendsWhileBackgroundModelReadIsStillPending() async throws {
    let fixture = FailureRecoveryFixture(
      reason: "provider_server_error", error: "Provider unavailable")
    let (conversation, models) = await fixture.conversation()
    defer {
      conversation.close()
      models.close()
    }
    let gate = ModelResponseGate()
    let started = expectation(description: "Background model read reached the HTTP boundary")
    fixture.state.value.withLock {
      $0.metadataGate = gate
      $0.metadataRequested = { started.fulfill() }
    }
    let backgroundRead = Task { await conversation.modelSelection?.refresh() }
    addTeardownBlock {
      backgroundRead.cancel()
      gate.open()
      await backgroundRead.value
    }
    await fulfillment(of: [started], timeout: 3)
    let failure = try XCTUnwrap(conversation.messages.last?.failure)
    XCTAssertFalse(conversation.failureState(failure).isBusy)
    XCTAssertTrue(conversation.failureState(failure).canSend)

    await conversation.recoverFailure(failure.id)

    let sends = fixture.state.value.withLock { $0.sends }
    XCTAssertEqual(sends.count, 1)
    let data = try XCTUnwrap(sends.first)
    let body = try XCTUnwrap(JSONSerialization.jsonObject(with: data) as? [String: Any])
    XCTAssertEqual(body["prompt"] as? String, "continue")
    XCTAssertEqual(body["model"] as? String, "codex-model")
    XCTAssertEqual((body["runOptions"] as? [String: String])?["reasoningEffort"], "max")
    XCTAssertTrue(conversation.messages.contains { $0.role == .user && $0.text == "continue" })
    gate.open()
    await backgroundRead.value
  }

  func testModelSaveAndUncertainWriteBlockRecoveryUntilReadbackConfirmsTheChoice() async throws {
    let fixture = FailureRecoveryFixture()
    let workspace = WorkspaceStore(client: fixture.http.client, webURL: fixture.http.baseURL)
    defer { workspace.close() }
    await workspace.modelStore.refresh()
    await workspace.refresh([.threadList])
    workspace.selectedThreadID = ModelHTTPFixtures.threadID
    let conversation = try XCTUnwrap(workspace.selectedConversation)
    await conversation.modelSelection?.open()
    await conversation.refresh()
    let failure = try XCTUnwrap(conversation.messages.last?.failure)
    let oldReadGate = ModelResponseGate()
    let oldReadStarted = expectation(description: "Thread read captured before local model write")
    fixture.state.value.withLock {
      $0.threadEvents = [
        FailureRecoveryFixture.threadEvent(
          1, kind: "model_selection_updated", fields: #""selectedModel":null"#)
      ]
      $0.threadEventsGate = oldReadGate
      $0.threadEventsRequested = { oldReadStarted.fulfill() }
    }
    let oldRead = Task { await workspace.refresh([.threadList]) }
    addTeardownBlock {
      oldRead.cancel()
      oldReadGate.open()
      await oldRead.value
    }
    await fulfillment(of: [oldReadStarted], timeout: 3)
    let gate = ModelResponseGate()
    let started = expectation(description: "Model switch reached the HTTP boundary")
    fixture.state.value.withLock {
      $0.modelSaveStatus = 503
      $0.modelSaveGate = gate
      $0.modelSaveRequested = { started.fulfill() }
    }
    let saving = Task { await conversation.modelSelection?.choose(model: "claude-model") }
    addTeardownBlock {
      saving.cancel()
      gate.open()
      await saving.value
    }
    await fulfillment(of: [started], timeout: 3)
    await conversation.recoverFailure(failure.id)
    XCTAssertTrue(fixture.state.value.withLock { $0.sends.isEmpty })

    gate.open()
    await saving.value
    XCTAssertEqual(conversation.modelSelection?.selection.model, "claude-model")
    XCTAssertTrue(fixture.state.value.withLock { $0.sends.isEmpty })
    oldReadGate.open()
    await oldRead.value
    // An unrelated list update must not replace the acknowledged local choice
    // with the older selection still present in the thread projection.
    fixture.state.value.withLock {
      $0.threadEvents.append(
        FailureRecoveryFixture.threadEvent(2, kind: "renamed", fields: #""title":"Renamed""#))
    }
    await workspace.refresh([.threadList])
    await conversation.recoverFailure(failure.id)
    let sends = fixture.state.value.withLock { $0.sends }
    XCTAssertEqual(sends.count, 1)
    let data = try XCTUnwrap(sends.first)
    let body = try XCTUnwrap(JSONSerialization.jsonObject(with: data) as? [String: Any])
    XCTAssertEqual(body["model"] as? String, "claude-model")
    XCTAssertTrue(conversation.messages.contains { $0.role == .user && $0.text == "continue" })
  }

  func testThreadEventsSupplyRecoveryModelEffortAndFastWithoutAMetadataRefresh() async throws {
    for model in ["claude-model", "codex-model"] {
      let fixture = FailureRecoveryFixture()
      let workspace = WorkspaceStore(client: fixture.http.client, webURL: fixture.http.baseURL)
      defer { workspace.close() }
      await workspace.modelStore.refresh()
      await workspace.refresh([.threadList])
      workspace.selectedThreadID = ModelHTTPFixtures.threadID
      let conversation = try XCTUnwrap(workspace.selectedConversation)
      await conversation.modelSelection?.open()
      await conversation.refresh()

      let gate = ModelResponseGate()
      let started = expectation(description: "Old model read captured before thread events")
      fixture.state.value.withLock {
        $0.metadataGate = gate
        $0.metadataRequested = { started.fulfill() }
      }
      let backgroundRead = Task { await conversation.modelSelection?.refresh() }
      addTeardownBlock {
        backgroundRead.cancel()
        gate.open()
        await backgroundRead.value
      }
      await fulfillment(of: [started], timeout: 3)
      let tier = model == "codex-model" ? #""priority""# : "null"
      fixture.state.value.withLock {
        $0.model = model
        $0.metadataStatus = 503
        $0.threadEvents = [
          FailureRecoveryFixture.threadEvent(
            1, kind: "model_selection_updated",
            fields:
              "\"selectedModel\":\"\(model)\",\"modelSettingsPatch\":{\"model\":\"\(model)\",\"effort\":\"high\"}"
          ),
          FailureRecoveryFixture.threadEvent(
            2, kind: "service_tier_updated", fields: "\"serviceTier\":\(tier)"),
        ]
      }
      await workspace.refresh([.threadList])
      gate.open()
      await backgroundRead.value
      fixture.state.value.withLock { $0.metadataStatus = 200 }
      await conversation.recoverFailure(FailureRecoveryFixture.failureID)

      let sends = fixture.state.value.withLock { $0.sends }
      XCTAssertEqual(sends.count, 1)
      let data = try XCTUnwrap(sends.first)
      let body = try XCTUnwrap(JSONSerialization.jsonObject(with: data) as? [String: Any])
      XCTAssertEqual(body["model"] as? String, model)
      let options = try XCTUnwrap(body["runOptions"] as? [String: String])
      XCTAssertEqual(options["reasoningEffort"], "high")
      XCTAssertEqual(options["codexServiceTier"], model == "codex-model" ? "fast" : nil)
      XCTAssertTrue(conversation.messages.contains { $0.role == .user && $0.text == "continue" })
    }
  }

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
    defer {
      original.close()
      models.close()
    }
    original.attachmentDraft.importFiles([source])
    try await waitForBusinessResult {
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
    let selection = try XCTUnwrap(conversation.modelSelection)
    do {
      _ = try await models.stateStore.get(selection.metadataValue).value
      XCTFail("The model settings surface must retain the failed metadata read")
    } catch {
      XCTAssertEqual((error as? APIClientError)?.statusCode, 503)
    }
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
    let emptyCredits = await conversation.readFailureState(failure)
    XCTAssertNil(emptyCredits.resetAccountID)
    fixture.state.value.withLock { $0.accountStatus = 503 }
    await conversation.recoverFailure(failure.id, resetUsage: true)
    XCTAssertTrue(fixture.state.value.withLock { $0.sends.isEmpty && $0.resetKeys.isEmpty })
    let failedRead = await conversation.readFailureState(failure)
    XCTAssertNotNil(failedRead.accountError)
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
    let cardGate = ModelResponseGate()
    let settingsGate = ModelResponseGate()
    let cardStarted = expectation(description: "The card account request is held")
    let settingsStarted = expectation(description: "The superseding settings request is held")
    defer {
      cardGate.open()
      settingsGate.open()
    }
    fixture.state.value.withLock {
      $0.accountGate = cardGate
      $0.accountRequested = { cardStarted.fulfill() }
      $0.accounts = $0.accounts.replacingOccurrences(
        of: "sample@example.invalid", with: "new-active@example.invalid")
    }
    let cardRead = Task { await conversation.refreshFailureAccounts() }
    addTeardownBlock {
      cardRead.cancel()
      cardGate.open()
      settingsGate.open()
      await cardRead.value
    }
    await fulfillment(of: [cardStarted], timeout: 3)
    fixture.state.value.withLock {
      $0.accountGate = settingsGate
      $0.accountRequested = { settingsStarted.fulfill() }
    }
    let settingsRead = Task { await models.subscriptions.refresh(force: true) }
    addTeardownBlock {
      settingsRead.cancel()
      cardGate.open()
      settingsGate.open()
      _ = await settingsRead.value
    }
    await fulfillment(of: [settingsStarted], timeout: 3)
    cardGate.open()
    settingsGate.open()
    // Both callers now await the same current read after replacement.
    await cardRead.value
    _ = await settingsRead.value
    let recovered = await conversation.readFailureState(failure)
    XCTAssertEqual(recovered.accountLabel, "new-active@example.invalid")
    XCTAssertFalse(recovered.isBusy)
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
    let resetRequested = expectation(description: "Reset request reached the HTTP boundary")
    fixture.state.value.withLock {
      $0.resetGate = gate
      $0.resetRequested = { resetRequested.fulfill() }
    }
    let recovering = Task { await conversation.recoverFailure(failure.id, resetUsage: true) }
    addTeardownBlock {
      recovering.cancel()
      gate.open()
      await recovering.value
    }
    await fulfillment(of: [resetRequested], timeout: 3)
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

  func testContinueUsesConfirmedModelAndPreservesStructuredDraftAndAttachments() async throws {
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
    try await waitForBusinessResult { conversation.attachmentDraft.isReady }
    let draft = conversation.composer.value
    // A different client's model change has synchronized before recovery.
    fixture.state.value.withLock { $0.model = "claude-model" }
    await conversation.modelSelection?.refresh()
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

  func testUncertainStopChecksHistoryWithoutReplayingTheCommand() async throws {
    let fixture = FailureRecoveryFixture()
    fixture.state.value.withLock {
      $0.rows.removeLast()
      $0.lastID = FailureRecoveryFixture.id(2)
    }
    let (conversation, models) = await fixture.conversation()
    defer {
      conversation.close()
      models.close()
    }
    XCTAssertEqual(conversation.history?.canStop, true)
    await conversation.stop()
    XCTAssertNotNil(conversation.stopIssue)
    XCTAssertNil(conversation.error)
    XCTAssertEqual(fixture.state.value.withLock { $0.stopWrites }, 1)
    await conversation.refresh()
    XCTAssertEqual(fixture.state.value.withLock { $0.stopWrites }, 1)
    fixture.state.value.withLock {
      $0.rows.append(FailureRecoveryFixture.row(3, type: "run.cancelled", payload: "null"))
      $0.lastID = FailureRecoveryFixture.id(3)
    }
    await conversation.refresh()
    XCTAssertNil(conversation.stopIssue)
    XCTAssertEqual(conversation.history?.canStop, false)
    XCTAssertEqual(fixture.state.value.withLock { $0.stopWrites }, 1)
  }

  func testRejectedSendRetainsItsMessageAndIdentityForExplicitRecovery() async throws {
    let fixture = FailureRecoveryFixture()
    fixture.state.value.withLock {
      $0.sendStatus = 403
      $0.persistSend = false
    }
    let (conversation, models) = await fixture.conversation()
    defer {
      conversation.close()
      models.close()
    }
    conversation.draft = "Keep this message"
    await conversation.send()
    let pending = try XCTUnwrap(conversation.pending.first)
    XCTAssertEqual(pending.text, "Keep this message")
    XCTAssertTrue(conversation.deliveryFailureText(pending.id).hasPrefix("Message not sent."))
    XCTAssertNil(conversation.error, "The failed message owns its recovery")
    conversation.draft = "A separate unsent draft"
    fixture.state.value.withLock {
      $0.sendStatus = 200
      $0.persistSend = true
    }
    await conversation.retry(pending)
    XCTAssertTrue(conversation.pending.isEmpty)
    XCTAssertEqual(conversation.draft, "A separate unsent draft")
    let bodies = try fixture.state.value.withLock { $0.sends }.map {
      try XCTUnwrap(JSONSerialization.jsonObject(with: $0) as? [String: Any])
    }
    XCTAssertEqual(bodies.count, 2)
    XCTAssertEqual(bodies[0]["clientEventId"] as? String, bodies[1]["clientEventId"] as? String)
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
    XCTAssertEqual(conversation.deliveryFailureText(pending.id), "Delivery not confirmed")
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
      let ready = await conversation.readFailureState(failure)
      XCTAssertEqual(ready.resetAccountID, ModelHTTPFixtures.accountID)
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
    let ready = await conversation.readFailureState(failure)
    XCTAssertEqual(ready.accountLabel, "sample@example.invalid")
    XCTAssertEqual(ready.resetDetails.count, 1)
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
    let resetRequested = expectation(description: "Reset request reached the HTTP boundary")
    fixture.state.value.withLock {
      $0.resetGate = gate
      $0.resetRequested = { resetRequested.fulfill() }
    }
    let first = Task {
      await conversation.recoverFailure(FailureRecoveryFixture.failureID, resetUsage: true)
    }
    addTeardownBlock {
      first.cancel()
      gate.open()
      await first.value
    }
    await fulfillment(of: [resetRequested], timeout: 3)
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
    let cacheDirectory = CacheTestDirectory(owner: self)
    let scope = ChatCacheScope(
      apiBaseURL: fixture.http.baseURL, userID: "user", workspaceID: "workspace")
    let (conversation, models) = await fixture.conversation(
      cache: cacheDirectory.cache(scope: scope))
    defer {
      conversation.close()
      models.close()
    }
    let restarted = ChatSync(
      client: fixture.http.client, cache: cacheDirectory.cache(scope: scope))
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
    let initial = await conversation.readFailureState(failure)
    XCTAssertTrue(try XCTUnwrap(initial.billing).canManageBilling)
    fixture.state.value.withLock {
      $0.billingAdmin = false
      $0.canBuyCredits = false
    }
    await conversation.refreshFailureAccounts()
    let member = await conversation.readFailureState(failure)
    let billing = try XCTUnwrap(member.billing)
    XCTAssertFalse(billing.canManageBilling)
    XCTAssertFalse(billing.canBuyCredits)
    XCTAssertTrue(
      AssistantFailureCopy.content(member).description.contains("admin")
    )
    await conversation.recoverFailure(failure.id)
    XCTAssertTrue(fixture.state.value.withLock { $0.sends.isEmpty })
    fixture.state.value.withLock {
      $0.credits = 100
      $0.canBuyCredits = true
    }
    await conversation.refreshFailureAccounts()
    let funded = await conversation.readFailureState(failure)
    XCTAssertEqual(AssistantFailureCopy.content(funded).title, "Credits available")
    conversation.draft = "A new input"
    await conversation.send()
    let historical = conversation.failureState(failure)
    XCTAssertFalse(historical.isCurrent)
    XCTAssertFalse(AssistantFailureCopy.content(historical).description.contains("Checking"))
  }

  func testOldFailureAccountSuccessCannotAuthorizeTheNextFailure() async throws {
    let fixture = FailureRecoveryFixture(reason: "usage_limit", error: "Usage limit")
    let (conversation, models) = await fixture.conversation()
    defer {
      conversation.close()
      models.close()
    }
    let oldGate = ModelResponseGate()
    let newGate = ModelResponseGate()
    let oldStarted = expectation(description: "Old failure account response captured")
    let newStarted = expectation(description: "New failure account response captured")
    fixture.state.value.withLock {
      $0.accountGate = oldGate
      $0.accountRequested = { oldStarted.fulfill() }
    }
    let oldFinished = expectation(
      description: "Retired waiter exits while the new response is held")
    let refreshing = Task {
      await conversation.refreshFailureAccounts()
      oldFinished.fulfill()
    }
    addTeardownBlock {
      refreshing.cancel()
      oldGate.open()
      newGate.open()
      await refreshing.value
    }
    await fulfillment(of: [oldStarted], timeout: 3)
    let oldContext = try XCTUnwrap(conversation.failureContext)
    let oldRead = try oldContext.store.get(XCTUnwrap(oldContext.accounts))
    fixture.state.value.withLock {
      $0.accountGate = newGate
      $0.accountRequested = { newStarted.fulfill() }
      $0.accountStatus = 403
      $0.rows.append(
        FailureRecoveryFixture.row(
          4, type: "input.prompt",
          payload:
            #"{"userMessage":{"version":1,"parts":[{"type":"text","text":"Another request"}]}}"#))
      $0.rows.append(
        FailureRecoveryFixture.row(
          5, type: "run.failed", payload: #"{"error":"Usage limit","failureReason":"usage_limit"}"#)
      )
      $0.lastID = FailureRecoveryFixture.id(5)
    }
    await conversation.refresh()
    await fulfillment(of: [newStarted], timeout: 3)
    oldGate.open()
    _ = await oldRead.result
    await fulfillment(of: [oldFinished], timeout: 3)
    newGate.open()
    await refreshing.value
    let failure = try XCTUnwrap(conversation.messages.last?.failure)
    XCTAssertEqual(failure.id, FailureRecoveryFixture.id(5))
    let state = await conversation.readFailureState(failure)
    XCTAssertNotNil(state.accountError)
    XCTAssertNil(state.resetAccountID)
    XCTAssertNil(state.accountLabel)
    XCTAssertTrue(fixture.state.value.withLock { $0.resetKeys.isEmpty && $0.sends.isEmpty })
  }

  func testReadRetryAfterConfirmedResetDoesNotSpendAgainOrContinueAutomatically() async throws {
    let fixture = FailureRecoveryFixture(reason: "usage_limit", error: "Usage limit")
    let (conversation, models) = await fixture.conversation()
    defer {
      conversation.close()
      models.close()
    }
    fixture.state.value.withLock { $0.accountStatusAfterReset = 503 }
    await conversation.recoverFailure(FailureRecoveryFixture.failureID, resetUsage: true)
    XCTAssertEqual(fixture.state.value.withLock { $0.resetKeys.count }, 1)
    XCTAssertTrue(fixture.state.value.withLock { $0.sends.isEmpty })
    fixture.state.value.withLock {
      $0.accountStatus = 200
      $0.accountStatusAfterReset = nil
    }
    await conversation.refreshFailureAccounts()
    XCTAssertEqual(fixture.state.value.withLock { $0.resetKeys.count }, 1)
    XCTAssertTrue(fixture.state.value.withLock { $0.sends.isEmpty })
    await conversation.recoverFailure(FailureRecoveryFixture.failureID, resetUsage: true)
    XCTAssertEqual(fixture.state.value.withLock { $0.resetKeys.count }, 1)
    XCTAssertEqual(fixture.state.value.withLock { $0.sends.count }, 1)
    XCTAssertTrue(conversation.messages.contains { $0.role == .user && $0.text == "continue" })
  }

  func testRetiringBillingContextCancelsOriginalHTTPAndPreventsFutureReads() async throws {
    let fixture = FailureRecoveryFixture(reason: "insufficient_credits", error: "No credits")
    let (conversation, models) = await fixture.conversation()
    defer {
      conversation.close()
      models.close()
    }
    let owner = UUID()
    conversation.setDetailVisible(true, owner: owner)
    let gate = ModelResponseGate()
    let began = expectation(description: "Billing HTTP began")
    let cancelled = expectation(description: "Billing HTTP cancelled at its original transport")
    fixture.state.value.withLock {
      $0.billingGate = gate
      $0.billingRequested = { began.fulfill() }
      $0.billingCancelled = { cancelled.fulfill() }
    }
    let read = Task { await conversation.refreshFailureAccounts() }
    addTeardownBlock {
      read.cancel()
      gate.open()
      await read.value
    }
    await fulfillment(of: [began], timeout: 3)
    let retired = try XCTUnwrap(conversation.failureContext)
    conversation.setDetailVisible(false, owner: owner)
    await fulfillment(of: [cancelled], timeout: 3)
    gate.open()
    await read.value
    XCTAssertThrowsError(try retired.retry()) { XCTAssertTrue($0 is CancellationError) }
    XCTAssertThrowsError(try retired.store.get(XCTUnwrap(retired.billing)))
    await conversation.refreshFailureAccounts()
    await conversation.recoverFailure(FailureRecoveryFixture.failureID)
    let failure = try XCTUnwrap(conversation.messages.last?.failure)
    let state = await conversation.readFailureState(failure)
    XCTAssertFalse(state.isCurrent)
    XCTAssertNil(state.billing)
    XCTAssertTrue(fixture.state.value.withLock { $0.sends.isEmpty })
  }

  func testAccountReadFailureDoesNotBecomeBillingAuthorityAndRetriesStayReadOnly() async throws {
    for status in [401, 403, 426] {
      let fixture = FailureRecoveryFixture(reason: "usage_limit", error: "Usage limit")
      let (conversation, models) = await fixture.conversation()
      defer {
        conversation.close()
        models.close()
      }
      let failure = try XCTUnwrap(conversation.messages.last?.failure)
      fixture.state.value.withLock { $0.accountStatus = status }
      await conversation.refreshFailureAccounts()
      let unavailable = await conversation.readFailureState(failure)
      XCTAssertNotNil(unavailable.accountError)
      XCTAssertNil(unavailable.resetAccountID)
      XCTAssertNil(unavailable.billingError)
      XCTAssertNil(unavailable.billing)
      fixture.state.value.withLock { $0.accountStatus = 200 }
      await conversation.refreshFailureAccounts()
      let recovered = await conversation.readFailureState(failure)
      XCTAssertEqual(recovered.resetAccountID, ModelHTTPFixtures.accountID)
      XCTAssertTrue(fixture.state.value.withLock { $0.resetKeys.isEmpty && $0.sends.isEmpty })
    }
  }

  func testBillingFailureRevokesCapabilitiesUntilItsOwnReadSucceeds() async throws {
    let fixture = FailureRecoveryFixture(reason: "insufficient_credits", error: "No credits")
    let (conversation, models) = await fixture.conversation()
    defer {
      conversation.close()
      models.close()
    }
    let failure = try XCTUnwrap(conversation.messages.last?.failure)
    fixture.state.value.withLock { $0.billingStatus = 403 }
    await conversation.refreshFailureAccounts()
    let unavailable = await conversation.readFailureState(failure)
    XCTAssertNil(unavailable.billing)
    XCTAssertNotNil(unavailable.billingError)
    XCTAssertNil(unavailable.accountError)
    fixture.state.value.withLock {
      $0.billingStatus = 200
      $0.billingAdmin = false
    }
    await conversation.refreshFailureAccounts()
    let recovered = await conversation.readFailureState(failure)
    XCTAssertFalse(try XCTUnwrap(recovered.billing).canManageBilling)
    XCTAssertNil(recovered.billingError)
    XCTAssertTrue(fixture.state.value.withLock { $0.resetKeys.isEmpty && $0.sends.isEmpty })
  }

  func testBillingUpgradeBlocksRecoveryWithoutChangingTranscript() async throws {
    let fixture = FailureRecoveryFixture(reason: "insufficient_credits", error: "No credits")
    let (conversation, models) = await fixture.conversation()
    defer {
      conversation.close()
      models.close()
    }
    let failure = try XCTUnwrap(conversation.messages.last?.failure)
    let messages = conversation.messages
    fixture.state.value.withLock { $0.billingStatus = 426 }
    await conversation.refreshFailureAccounts()
    try await waitForBusinessResult { conversation.needsUpgrade }
    let context = try XCTUnwrap(conversation.failureContext)
    let original = try context.store.get(XCTUnwrap(context.billing))
    guard case .failure(let error) = await original.result else {
      return XCTFail("The original billing resource must retain the upgrade failure")
    }
    XCTAssertEqual((error as? APIClientError)?.statusCode, 426)
    let blocked = await conversation.readFailureState(failure)
    XCTAssertFalse(blocked.isCurrent)
    XCTAssertNil(blocked.billing)
    XCTAssertNil(blocked.resetAccountID)
    fixture.state.value.withLock { $0.billingStatus = 200 }
    await conversation.refreshFailureAccounts()
    await conversation.recoverFailure(failure.id)
    XCTAssertEqual(conversation.messages, messages)
    XCTAssertTrue(fixture.state.value.withLock { $0.resetKeys.isEmpty && $0.sends.isEmpty })
    conversation.close()
    XCTAssertThrowsError(try context.store.get(XCTUnwrap(context.billing)))
  }

}
