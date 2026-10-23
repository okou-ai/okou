import ChatData
import ChatDataTestSupport
import ChatDomain
import Foundation
import SwiftUI
import Synchronization
import XCTest

@testable import Okou

@MainActor
final class ComposerDraftTests: XCTestCase {
  func testNativeInlineReferencesSurviveDeviceRestartRemoteRoundTripAndConflictChoice() async throws
  {
    let rich = try richDraft()
    let quoted = try JSONDecoder().decode(
      MessageJSON.self,
      from: Data(
        #"{"type":"feedback","quote":"PWA passage","eventId":"pwa-event","range":{"start":3,"end":14},"source":{"type":"mail","id":"mail","status":"sent","sentId":"sent"},"note":[{"type":"text","text":"Compare "},{"type":"agent","agentId":"73000000-0000-4000-8000-000000000001","nameSnapshot":"Planner"},{"type":"text","text":"now"}]}"#
          .utf8))
    let additional: MessageJSON = .object([
      "type": .string("additional_info"), "text": .string("Keep the source context"),
    ])
    let remote = ComposerDraft(
      document: ChatDraftDocument(
        parts: [additional] + (rich.draftUserMessage?.parts ?? []) + [quoted]),
      attachments: rich.draftAttachments)
    let server = DraftServer(remote: remote)
    let storage = server.storage()
    let composer = server.composer(storage: storage)
    await composer.synchronize()
    try await eventually { composer.attachments.isReady }
    let navigation = MentionNavigationFixture()
    let workspace = try await navigation.workspace()
    defer { workspace.close() }
    let host = UIHostingController(
      rootView: MentionComposerHarness(state: composer, source: workspace.mentionTestSource))
    let window = try await mountMentionHost(host)
    let input = try XCTUnwrap(
      mentionInputs(in: host.view).first { $0.text.hasPrefix("Review this") })
    input.becomeFirstResponder()
    input.selectedRange = NSRange(location: 7, length: 0)
    input.insertText("🌷 new ")
    try await eventually { composer.text == "Review 🌷 new this " }
    let note = try XCTUnwrap(
      mentionInputs(in: host.view).first { $0.accessibilityLabel == "Ask or comment on this quote" }
    )
    note.becomeFirstResponder()
    note.selectedRange = NSRange(location: note.text.utf16.count, length: 0)
    note.insertText(" @project")
    try await eventually { mentionTable(in: host.view) != nil }
    note.insertText("\n")
    try await eventually {
      composer.editorBlocks.first(where: \.isFeedback)?.content.parts.contains {
        $0["type"]?.string == "chat_thread"
      } == true
    }
    XCTAssertEqual(composer.document.parts.first, additional)
    XCTAssertEqual(
      composer.document.parts.first { $0["type"]?.string == "file" },
      rich.draftUserMessage?.parts.last)
    XCTAssertEqual(composer.document.parts.last?["source"], quoted["source"])
    XCTAssertEqual(composer.document.parts.last?["range"], quoted["range"])
    await composer.synchronize()
    let saved = composer.value
    XCTAssertEqual(server.state.value.withLock { $0.remote }, saved)
    input.becomeFirstResponder()
    input.selectedRange = NSRange(location: 0, length: input.text.utf16.count)
    input.cut(nil)
    defer { UIPasteboard.general.items = [] }
    try await eventually { composer.text.isEmpty }
    await hostingPresentationFrame()
    input.undoManager?.undo()
    try await eventually(message: "Native cut/undo must retain source and attachment positions") {
      composer.value == saved
    }
    unmount(window)
    composer.close()

    let reopened = server.composer(storage: storage)
    defer { reopened.close() }
    XCTAssertEqual(reopened.value, saved)
    let reopenedHost = UIHostingController(rootView: MentionComposerHarness(state: reopened))
    let reopenedWindow = try await mountMentionHost(reopenedHost)
    defer { unmount(reopenedWindow) }
    let restoredNote = try XCTUnwrap(
      mentionInputs(in: reopenedHost.view).first {
        $0.accessibilityLabel == "Ask or comment on this quote"
      })
    XCTAssertEqual(restoredNote.text.filter { $0 == "\u{fffc}" }.count, 2)
    restoredNote.becomeFirstResponder()
    let referenceRange = (restoredNote.text as NSString).range(of: "\u{fffc}")
    restoredNote.selectedRange = referenceRange
    restoredNote.deleteBackward()
    try await eventually {
      reopened.editorBlocks.first(where: \.isFeedback)?.content.parts.contains {
        $0["type"]?.string == "agent"
      } == false
    }
    restoredNote.undoManager?.undo()
    try await eventually { reopened.value == saved }
    restoredNote.insertText(" Local")
    server.state.value.withLock { $0.remote = remote }
    await reopened.synchronize()
    XCTAssertNotNil(reopened.conflictingRemote)
    reopened.useRemote()
    try await eventually {
      reopened.value == remote
        && mentionInputs(in: reopenedHost.view).contains {
          $0 !== restoredNote && $0.text == "Compare \u{fffc}now"
        }
    }
    XCTAssertEqual(reopened.document.parts.last?["source"], quoted["source"])
  }

  func testRestartRestoresTextUploadedFilesAndRichDocumentWithoutCreatingAThread() async throws {
    let server = DraftServer(remote: try richDraft())
    let storage = server.storage()
    let first = server.composer(storage: storage)
    await first.synchronize()
    try await eventually { first.attachments.isReady }
    XCTAssertEqual(first.text, "Review this ")
    XCTAssertEqual(first.contextLabels, ["Plan"])
    first.text = "Review this carefully"
    await first.synchronize()
    let saved = server.state.value.withLock { $0.remote }
    XCTAssertEqual(
      saved.draftUserMessage?.parts.filter { $0["type"]?.string != "text" },
      try richDraft().draftUserMessage?.parts.filter { $0["type"]?.string != "text" })
    first.close()
    let reopened = server.composer(storage: storage)
    defer { reopened.close() }
    XCTAssertEqual(reopened.text, "Review this carefully")
    try await eventually { reopened.attachments.isReady }
    XCTAssertEqual(reopened.attachments.uploaded.first?.id, "file")
    XCTAssertEqual(reopened.value, saved)
    XCTAssertTrue(server.state.value.withLock { $0.paths.allSatisfy { !$0.contains("POST") } })
  }

  func testQuotedDraftRoundTripsNotesSourcesOrderAndConflictRecovery() async throws {
    let remote = try JSONDecoder().decode(
      ComposerDraft.self,
      from: Data(
        #"{"draftUserMessage":{"version":1,"parts":[{"type":"text","text":"Before"},{"type":"feedback","quote":"PWA passage","note":[{"type":"text","text":"First "},{"type":"chat_thread","threadId":"43000000-0000-4000-8000-000000000001","titleSnapshot":"Plan"},{"type":"text","text":"note"}],"eventId":"pwa-event","range":{"start":3,"end":14},"source":{"type":"mail","id":"mail","status":"sent","sentId":"sent"}},{"type":"text","text":"After"}]},"draftAttachments":null}"#
          .utf8))
    let server = DraftServer(remote: remote)
    let storage = server.storage()
    let composer = server.composer(storage: storage)
    await composer.synchronize()
    let quote = try XCTUnwrap(composer.editorBlocks.first(where: \.isFeedback))
    composer.editBlock(quote.id, text: "First revised note")
    let source = remote.draftUserMessage?.parts[1]["source"]
    XCTAssertEqual(composer.document.parts[1]["source"], source)
    let inline = quote.content.parts[1]
    guard case .array(let note) = composer.document.parts[1]["note"] else {
      return XCTFail("Feedback note was lost")
    }
    XCTAssertTrue(note.contains(inline))
    let message = ChatMessage(
      id: "native-event", role: .assistant, text: "Second 🌷 passage",
      createdAt: Date(), isQueued: false, isError: false)
    let selection = try XCTUnwrap(
      ChatFeedbackSelection(
        message: message, range: NSRange(location: 0, length: message.text.utf16.count)))
    let second = try XCTUnwrap(composer.addFeedback(selection))
    composer.editBlock(second, text: "Independent note")
    XCTAssertEqual(
      composer.document.parts.map { $0["type"]?.string }, ["text", "feedback", "text", "feedback"])
    await composer.synchronize()
    let saved = server.state.value.withLock { $0.remote }
    XCTAssertEqual(saved, composer.value)
    composer.close()
    composer.editBlock(second, text: "Retired editor")
    let reopened = server.composer(storage: storage)
    defer { reopened.close() }
    XCTAssertEqual(reopened.value, saved)
    let quotes = reopened.editorBlocks.filter(\.isFeedback)
    XCTAssertEqual(quotes.map(\.content.text), ["First revised note", "Independent note"])
    reopened.removeFeedback(quotes[0].id)
    XCTAssertEqual(reopened.document.text, "Before\nAfter")
    XCTAssertEqual(
      reopened.editorBlocks.filter(\.isFeedback).map(\.content.text), ["Independent note"])
    server.state.value.withLock { $0.remote = remote }
    await reopened.synchronize()
    XCTAssertNotNil(reopened.conflictingRemote)
    reopened.useRemote()
    XCTAssertEqual(reopened.value, remote)
    XCTAssertEqual(reopened.editorBlocks.filter(\.isFeedback).first?.content.text, "First note")
  }

  func testCancelledDraftOpeningDoesNotStartRemoteRequests() async {
    let server = DraftServer()
    let composer = server.composer()
    defer { composer.close() }
    let opening = Task { await composer.synchronize() }
    opening.cancel()
    await opening.value
    XCTAssertTrue(server.state.value.withLock { $0.paths.isEmpty })
  }

  func testTypingDuringLateRemoteLoadKeepsLocalInputAndClearCannotResurrectRemote() async throws {
    for clear in [false, true] {
      let gate = DraftGate()
      let started = expectation(description: "Draft request started")
      let server = DraftServer(
        remote: textDraft("Remote"),
        onRead: {
          started.fulfill()
          await gate.wait()
        })
      let composer = server.composer()
      defer {
        composer.close()
        gate.open()
      }
      let loading = Task { await composer.synchronize() }
      await fulfillment(of: [started], timeout: 2)
      composer.text = "Local typing"
      if clear { composer.clear() }
      gate.open()
      await loading.value
      XCTAssertEqual(composer.text, clear ? "" : "Local typing")
      XCTAssertEqual(
        server.state.value.withLock { $0.remote.draftUserMessage?.text ?? "" }, composer.text)
    }
  }

  func testTypingDuringReconnectKeepsLocalInputWithoutOverwritingAKnownRemoteChange() async throws {
    let gate = DraftGate()
    let started = expectation(description: "Reconnect draft read")
    let count = DraftReadCount()
    let server = DraftServer(
      remote: textDraft("Baseline"),
      onRead: {
        let index = count.value.withLock {
          $0 += 1
          return $0
        }
        if index == 2 {
          started.fulfill()
          await gate.wait()
        }
      })
    let composer = server.composer()
    defer {
      composer.close()
      gate.open()
    }
    await composer.synchronize()
    composer.text = "Local offline edit"
    server.state.value.withLock { $0.remote = textDraft("New edit from PWA") }
    let reconnect = Task { await composer.synchronize() }
    await fulfillment(of: [started], timeout: 2)
    composer.text = "Local typing continues"
    gate.open()
    await reconnect.value
    XCTAssertEqual(composer.text, "Local typing continues")
    XCTAssertNotNil(composer.conflictingRemote)
    XCTAssertEqual(
      server.state.value.withLock { $0.remote.draftUserMessage?.text }, "New edit from PWA")
  }

  func testOldSaveResponseCannotReplaceNewInputAndClearsAreSerializedAfterWrites() async throws {
    let saving = expectation(description: "Save is in flight")
    let gate = DraftGate()
    let server = DraftServer(onWrite: { index in
      if index == 1 {
        saving.fulfill()
        await gate.wait()
      }
    })
    let composer = server.composer()
    defer {
      composer.close()
      gate.open()
    }
    await composer.synchronize()
    composer.text = "Older save"
    let task = Task { await composer.synchronize() }
    await fulfillment(of: [saving], timeout: 2)
    composer.text = "New input"
    composer.clear()
    composer.text = "Final input"
    gate.open()
    await task.value
    XCTAssertEqual(composer.text, "Final input")
    XCTAssertEqual(server.state.value.withLock { $0.remote.draftUserMessage?.text }, "Final input")
    composer.clear()
    await composer.synchronize()
    XCTAssertEqual(server.state.value.withLock { $0.remote }, ComposerDraft())
  }

  func testOfflineReopenSynchronizesLocalDraftAndDetectsOtherDeviceChanges() async throws {
    let server = DraftServer()
    let storage = server.storage()
    let composer = server.composer(storage: storage)
    await composer.synchronize()
    server.state.value.withLock { $0.networkError = .notConnectedToInternet }
    composer.text = "Local offline draft"
    await composer.synchronize()
    XCTAssertNil(composer.error)
    composer.close()
    let reopened = server.composer(storage: storage)
    defer { reopened.close() }
    XCTAssertEqual(reopened.text, "Local offline draft")
    server.state.value.withLock { $0.networkError = nil }
    await reopened.synchronize()
    XCTAssertEqual(
      server.state.value.withLock { $0.remote.draftUserMessage?.text }, "Local offline draft")
    reopened.text = "New local work"
    server.state.value.withLock { $0.remote = textDraft("Other device") }
    await reopened.synchronize()
    XCTAssertNotNil(reopened.conflictingRemote)
    XCTAssertEqual(reopened.text, "New local work")
    XCTAssertEqual(server.state.value.withLock { $0.remote.draftUserMessage?.text }, "Other device")
    reopened.useRemote()
    XCTAssertEqual(reopened.text, "Other device")
  }

  func testOfflineClearSurvivesRestartAndCannotResurrectTheSentDraft() async throws {
    let server = DraftServer(remote: textDraft("Send me"))
    let storage = server.storage()
    let composer = server.composer(storage: storage)
    await composer.synchronize()
    server.state.value.withLock { $0.networkError = .notConnectedToInternet }
    composer.clear()
    await composer.synchronize()
    composer.close()
    let reopened = server.composer(storage: storage)
    defer { reopened.close() }
    XCTAssertEqual(reopened.text, "")
    server.state.value.withLock { $0.networkError = nil }
    await reopened.synchronize()
    XCTAssertEqual(server.state.value.withLock { $0.remote }, ComposerDraft())
  }

  func testTransientNetworkFailuresKeepDeviceDraftsAvailableForLaterSynchronization() async throws {
    for failure in [URLError.Code.timedOut, .cancelled, .networkConnectionLost] {
      let server = DraftServer()
      let storage = server.storage()
      let composer = server.composer(storage: storage)
      composer.text = "Keep this device draft"
      server.state.value.withLock { $0.networkError = failure }
      await composer.synchronize()
      XCTAssertNil(composer.error)
      XCTAssertTrue(composer.canSend)
      composer.close()

      let reopened = server.composer(storage: storage)
      defer { reopened.close() }
      XCTAssertEqual(reopened.text, "Keep this device draft")
      server.state.value.withLock { $0.networkError = nil }
      await reopened.synchronize()
      XCTAssertEqual(
        server.state.value.withLock { $0.remote.draftUserMessage?.text }, "Keep this device draft")
    }
  }

  func testHTTPRejectionsRemainVisibleAndRecoverOnExplicitRetry() async {
    for status in [403, 500] {
      let server = DraftServer()
      let composer = server.composer()
      defer { composer.close() }
      composer.text = "Retain the rejected draft"
      server.state.value.withLock {
        $0.rejection = ChatHTTPResponse(
          status: status, body: "{\"error\":{\"message\":\"Draft rejected\"}}")
      }
      await composer.synchronize()
      XCTAssertTrue(composer.error?.contains("Draft rejected") == true)
      XCTAssertEqual(composer.text, "Retain the rejected draft")
      server.state.value.withLock { $0.rejection = nil }
      await composer.synchronize()
      XCTAssertNil(composer.error)
      XCTAssertEqual(
        server.state.value.withLock { $0.remote.draftUserMessage?.text },
        "Retain the rejected draft")
    }
  }

  func testBackgroundCancellationPreservesEditsAndResumesWithoutTheOldResponse() async throws {
    let gate = DraftGate()
    let started = expectation(description: "Draft hydration started before backgrounding")
    let count = DraftReadCount()
    let server = DraftServer(onRead: {
      let index = count.value.withLock {
        $0 += 1
        return $0
      }
      if index == 1 {
        started.fulfill()
        await gate.wait()
      }
    })
    let storage = server.storage()
    let composer = server.composer(storage: storage)
    defer {
      composer.close()
      gate.open()
    }
    let opening = Task { await composer.synchronize() }
    await fulfillment(of: [started], timeout: 2)
    composer.setForeground(false)
    composer.text = "Edit retained while synchronization is paused"
    await composer.synchronize()
    XCTAssertEqual(server.state.value.withLock { $0.remote }, ComposerDraft())

    composer.setForeground(true)
    await composer.synchronize()
    gate.open()
    await opening.value
    XCTAssertNil(composer.error)
    XCTAssertEqual(
      server.state.value.withLock { $0.remote.draftUserMessage?.text },
      "Edit retained while synchronization is paused")
    composer.close()
    let reopened = server.composer(storage: storage)
    defer { reopened.close() }
    XCTAssertEqual(reopened.text, "Edit retained while synchronization is paused")
  }

  func testUnreadableDeviceDraftIsNotReplacedByAnEmptyDefault() async throws {
    let server = DraftServer()
    let storage = server.storage()
    let key = ChatDraftTarget.agent(draftAgentID).key
    try storage.save("unreadable draft record", key: key)
    let composer = server.composer(storage: storage)
    XCTAssertNotNil(composer.error)
    XCTAssertFalse(composer.canSend)
    await composer.synchronize()
    composer.text = "New input remains in memory"
    composer.close()
    XCTAssertEqual(try storage.load(key, as: String.self), "unreadable draft record")
    XCTAssertTrue(server.state.value.withLock { $0.paths.isEmpty })
  }

  func testAcknowledgedClearDoesNotReviveAnOldRemoteDraftAfterRestart() async throws {
    let server = DraftServer(remote: textDraft("Old draft"))
    let storage = server.storage()
    let composer = server.composer(storage: storage)
    await composer.synchronize()
    composer.clear()
    await composer.synchronize()
    composer.close()
    server.state.value.withLock { $0.remote = textDraft("Old draft") }
    let reopened = server.composer(storage: storage)
    defer { reopened.close() }
    await reopened.synchronize()
    XCTAssertEqual(reopened.text, "")
    XCTAssertNotNil(reopened.conflictingRemote)
    reopened.keepLocal()
    await reopened.synchronize()
    XCTAssertEqual(server.state.value.withLock { $0.remote }, ComposerDraft())
  }

  func testUnavailableRemoteAttachmentRetainsCanonicalPartUntilExplicitRemoval() async throws {
    let server = DraftServer(remote: try richDraft())
    server.state.value.withLock { $0.missingFile = true }
    let composer = server.composer()
    defer { composer.close() }
    await composer.synchronize()
    try await eventually {
      composer.attachments.items.contains { if case .failed = $0.state { true } else { false } }
    }
    XCTAssertFalse(composer.canSend)
    composer.text = "Keep the attachment context"
    await composer.synchronize()
    XCTAssertTrue(
      server.state.value.withLock {
        $0.remote.draftUserMessage!.parts.contains { $0["fileId"]?.string == "file" }
      })
    let file = try XCTUnwrap(composer.attachments.items.first)
    composer.attachments.remove(file.id)
    await composer.synchronize()
    XCTAssertFalse(
      server.state.value.withLock {
        $0.remote.draftUserMessage!.parts.contains { $0["type"]?.string == "file" }
      })
    XCTAssertNil(server.state.value.withLock { $0.remote.draftAttachments })
    XCTAssertTrue(composer.canSend)
  }

  func testRemoteMetadataCannotOwnOrRemoveADeviceFile() async throws {
    let server = DraftServer()
    let source = server.directory.appendingPathComponent("provider-file.txt")
    try Data("Keep provider-owned bytes".utf8).write(to: source)
    var remote = try richDraft()
    let file = try XCTUnwrap(remote.draftAttachments?.first?.attachment)
    remote.draftAttachments = [.init(attachment: file, url: source.absoluteString)]
    server.state.value.withLock { $0.remote = remote }
    let composer = server.composer()
    await composer.synchronize()
    XCTAssertFalse(composer.canSend)
    XCTAssertNotNil(composer.attachments.error)
    composer.clear()
    composer.close()
    XCTAssertTrue(FileManager.default.fileExists(atPath: source.path))
  }

  func testInterruptedLocalFileIsNeverRestoredAsUploadedAndMissingFileRetryFails() async throws {
    let server = DraftServer()
    let storage = server.storage()
    let source = server.directory.appendingPathComponent("local.txt")
    try Data("local".utf8).write(to: source)
    let composer = server.composer(storage: storage)
    composer.attachments.importFiles([source])
    try await eventually {
      composer.attachments.items.contains { if case .failed = $0.state { true } else { false } }
    }
    let copied = try XCTUnwrap(composer.attachments.items.first?.file.url)
    composer.close()
    XCTAssertTrue(FileManager.default.fileExists(atPath: copied.path))
    try FileManager.default.removeItem(at: copied)
    let reopened = server.composer(storage: storage)
    defer {
      reopened.clear()
      reopened.close()
    }
    XCTAssertTrue(reopened.attachments.uploaded.isEmpty)
    XCTAssertFalse(reopened.attachments.isReady)
    let item = try XCTUnwrap(reopened.attachments.items.first)
    reopened.attachments.retry(item.id)
    try await eventually {
      reopened.attachments.items.contains { if case .failed = $0.state { true } else { false } }
    }
    XCTAssertTrue(reopened.attachments.uploaded.isEmpty)
  }

  func testNativeComposerPreviewShowsRestoredContextAndConflictActions() async throws {
    let server = DraftServer(remote: try richDraft())
    let composer = server.composer()
    defer { composer.close() }
    await composer.synchronize()
    composer.text = "Saved draft after restart"
    server.state.value.withLock { $0.remote = textDraft("Edited on PWA") }
    await composer.synchronize()
    let host = UIHostingController(
      rootView: ChatComposerView(
        draft: Binding(get: { composer.text }, set: { composer.text = $0 }),
        isBusy: false, showsProgress: false, canStop: false, needsUpgrade: false,
        error: nil, attachmentURL: server.http.baseURL, attachments: composer.attachments,
        draftState: composer, submit: {}, refresh: nil))
    XCTAssertNotNil(composer.conflictingRemote)
    let scene = try XCTUnwrap(UIApplication.shared.connectedScenes.first as? UIWindowScene)
    let window = UIWindow(windowScene: scene)
    window.frame = CGRect(x: 0, y: 0, width: 390, height: 844)
    window.rootViewController = host
    window.makeKeyAndVisible()
    host.view.layoutIfNeeded()
    await Task.yield()
    defer { unmount(window) }
    let image = UIGraphicsImageRenderer(bounds: window.bounds).image { _ in
      window.drawHierarchy(in: window.bounds, afterScreenUpdates: true)
    }
    let attachment = XCTAttachment(image: image)
    attachment.name = "Restored draft and cross-device choice"
    attachment.lifetime = .keepAlways
    add(attachment)
    XCTAssertNotNil(composer.conflictingRemote)
  }

  func testRecommendationsDoNotMatchAcrossReferencesInsideQuotedNotes() async throws {
    let remote = try JSONDecoder().decode(
      ComposerDraft.self,
      from: Data(
        #"{"draftUserMessage":{"version":1,"parts":[{"type":"text","text":"Before"},{"type":"feedback","quote":"One","note":[{"type":"text","text":"Existing "},{"type":"chat_thread","threadId":"43000000-0000-4000-8000-000000000001","titleSnapshot":"Plan"},{"type":"text","text":"question"}]},{"type":"feedback","quote":"Two","note":[]}]},"draftAttachments":null}"#
          .utf8))
    let server = DraftServer(remote: remote)
    let composer = server.composer()
    defer { composer.close() }
    await composer.synchronize()
    let notes = composer.editorBlocks.filter(\.isFeedback)
    let firstNote = composer.document.parts[1]
    let source = ChatRecommendedFollowupSource(
      eventID: "followups",
      followups: [
        ChatRecommendedFollowup(prompt: "Existing question", kind: .talk)
      ])
    let host = UIHostingController(
      rootView: VStack {
        RecommendedFollowupList(
          source: source, finishedAt: nil, select: composer.editor.selectOrAppendText)
        ChatComposerView(
          draft: Binding(get: { composer.text }, set: { composer.text = $0 }),
          isBusy: false, showsProgress: false, canStop: false, needsUpgrade: false, error: nil,
          attachmentURL: server.http.baseURL, attachments: composer.attachments,
          draftState: composer, submit: {}, refresh: nil)
      })
    let scene = try XCTUnwrap(UIApplication.shared.connectedScenes.first as? UIWindowScene)
    let window = UIWindow(windowScene: scene)
    window.frame = CGRect(x: 0, y: 0, width: 390, height: 844)
    window.rootViewController = host
    window.makeKeyAndVisible()
    defer { unmount(window) }
    try await eventually { composer.editor.view?.window != nil }
    func button(in view: UIView) -> UIButton? {
      if let button = view as? UIButton, button.accessibilityLabel == "Existing question" {
        return button
      }
      return view.subviews.lazy.compactMap { button(in: $0) }.first
    }
    let action = try XCTUnwrap(button(in: host.view))
    action.sendActions(for: .touchUpInside)
    try await eventually {
      composer.editorBlocks.first(where: { $0.id == notes[1].id })?.content.text
        == "Existing question"
    }
    XCTAssertEqual(composer.document.parts[1], firstNote)
    XCTAssertEqual(composer.text, "Before")
    XCTAssertEqual(
      composer.editorBlocks.filter(\.isFeedback).map(\.content.text),
      ["Existing question", "Existing question"])
  }

  func testRecommendedTextPreservesRichDraftAttachmentsAndConflictRecovery() async throws {
    let server = DraftServer(remote: try richDraft())
    let composer = server.composer(storage: server.storage())
    defer { composer.close() }
    await composer.synchronize()
    try await eventually { composer.attachments.isReady }
    let parts = composer.document.parts.filter { $0["type"]?.string != "text" }
    let attachments = composer.attachments.savedItems
    let host = UIHostingController(
      rootView: ChatComposerTextInput(
        text: Binding(get: { composer.text }, set: { composer.text = $0 }),
        isFocused: .constant(true), acceptsImages: true, isCurrent: { true }, pasteImages: { _ in },
        editor: composer.editor))
    let scene = try XCTUnwrap(UIApplication.shared.connectedScenes.first as? UIWindowScene)
    let window = UIWindow(windowScene: scene)
    window.frame = CGRect(x: 0, y: 0, width: 390, height: 300)
    window.rootViewController = host
    window.makeKeyAndVisible()
    defer { unmount(window) }
    try await eventually { composer.editor.view?.window != nil }
    composer.editor.selectOrAppendText("Compare the alternatives")
    try await eventually { composer.text.hasSuffix("\nCompare the alternatives") }
    XCTAssertEqual(composer.document.parts.filter { $0["type"]?.string != "text" }, parts)
    XCTAssertEqual(composer.attachments.savedItems, attachments)
    server.state.value.withLock { $0.remote = textDraft("Edited on another device") }
    await composer.synchronize()
    XCTAssertNotNil(composer.conflictingRemote)
    XCTAssertTrue(composer.text.hasSuffix("Compare the alternatives"))
    composer.keepLocal()
    await composer.synchronize()
    XCTAssertNil(composer.conflictingRemote)
    XCTAssertEqual(server.state.value.withLock { $0.remote }, composer.value)
  }
}

private func textDraft(_ text: String) -> ComposerDraft {
  var document = ChatDraftDocument()
  document.replaceText(text)
  return ComposerDraft(document: document)
}

private func richDraft() throws -> ComposerDraft {
  try JSONDecoder().decode(
    ComposerDraft.self,
    from: Data(
      #"{"draftUserMessage":{"version":1,"parts":[{"type":"text","text":"Review this "},{"type":"chat_thread","threadId":"43000000-0000-4000-8000-000000000001","titleSnapshot":"Plan"},{"type":"file","fileId":"file","filenameSnapshot":"notes.txt","contentType":"text/plain","annotatedFileId":"annotated","annotations":{"marks":[]}}]},"draftAttachments":[{"id":"file","url":"artifact://file","filename":"notes.txt","contentType":"text/plain","size":5}]}"#
        .utf8))
}

private final class DraftServer: Sendable {
  struct State: Sendable {
    var remote = ComposerDraft()
    var networkError: URLError.Code?
    var rejection: ChatHTTPResponse?
    var missingFile = false
    var paths: [String] = []
    var writes = 0
  }
  let state: DraftServerState
  let http: ChatHTTPFixture
  let directory: URL
  init(
    remote: ComposerDraft = ComposerDraft(), onRead: @escaping @Sendable () async -> Void = {},
    onWrite: @escaping @Sendable (Int) async -> Void = { _ in }
  ) {
    let state = DraftServerState(remote: remote)
    self.state = state
    directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
    try! FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
    http = ChatHTTPFixture { request in
      let path = request.url!.path
      let failure = state.value.withLock { value in
        value.paths.append(request.httpMethod! + " " + path)
        return value.networkError
      }
      if let failure { throw URLError(failure) }
      if let rejection = state.value.withLock({ $0.rejection }) { return rejection }
      if path == "/api/web/file-url" {
        return ChatHTTPResponse(
          status: state.value.withLock { $0.missingFile } ? 404 : 200, body: "{}")
      }
      guard path == "/api/agents/\(draftAgentID)/draft" else { throw URLError(.unsupportedURL) }
      if request.httpMethod == "PATCH" {
        let index = state.value.withLock { value in
          value.writes += 1
          return value.writes
        }
        await onWrite(index)
        let draft = try JSONDecoder().decode(ComposerDraft.self, from: chatRequestBody(request))
        state.value.withLock { $0.remote = draft }
        return ChatHTTPResponse(status: 204, body: "")
      }
      let remote = state.value.withLock { $0.remote }
      await onRead()
      return ChatHTTPResponse(
        body: String(decoding: try JSONEncoder().encode(remote), as: UTF8.self))
    }
  }
  deinit { try? FileManager.default.removeItem(at: directory) }
  func storage() -> ChatDraftStorage {
    ChatDraftStorage(
      scope: ChatCacheScope(apiBaseURL: http.baseURL, userID: "user", workspaceID: "org"),
      directory: directory)
  }
  @MainActor func composer(storage: ChatDraftStorage? = nil) -> ComposerDraftStore {
    ComposerDraftStore(
      target: .agent(draftAgentID),
      commands: ChatCommands(client: http.client, sync: ChatSync(client: http.client)),
      repository: ChatDraftRepository(client: http.client), storage: storage, didFail: { _ in })
  }
}

private final class DraftGate: Sendable {
  let stream: AsyncStream<Void>
  let continuation: AsyncStream<Void>.Continuation
  init() { (stream, continuation) = AsyncStream.makeStream() }
  func wait() async { for await _ in stream { return } }
  func open() { continuation.finish() }
}

private final class DraftServerState: Sendable {
  let value: Mutex<DraftServer.State>
  init(remote: ComposerDraft) { value = Mutex(DraftServer.State(remote: remote)) }
}

private let draftAgentID = "43000000-0000-4000-8000-000000000002"

private final class DraftReadCount: Sendable { let value = Mutex(0) }
