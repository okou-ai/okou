import ChatData
import ChatDataTestSupport
import ChatDomain
import Synchronization
import XCTest

@testable import Okou

@MainActor
final class ChatThreadActionsTests: XCTestCase {
  func testProjectMovesUpdateBeforeConfirmationAndSurvivePickerCancellation() async throws {
    let fixture = ThreadActionsFixture()
    let store = fixture.workspace()
    defer { store.close() }
    await store.refresh()
    store.selectChat(ThreadActionsFixture.thread)
    let original = try XCTUnwrap(store.list.threads.first)
    let destinations: [String?] = [
      ThreadActionsFixture.project, ThreadActionsFixture.otherProject, nil
    ]
    for projectID in destinations {
      let gate = ThreadActionGate()
      defer { gate.open() }
      let requested = expectation(description: "Project write reached HTTP")
      fixture.state.value.withLock {
        $0.nextGate = gate
        $0.nextWriteRequested = { requested.fulfill() }
      }
      var pickerOpen = true
      let moving = Task {
        await store.moveToProject(ThreadActionsFixture.thread, projectID: projectID) {
          pickerOpen = false
        }
      }
      addTeardownBlock { @MainActor in
        store.close()
        moving.cancel()
        gate.open()
        _ = await moving.value
      }
      await fulfillment(of: [requested], timeout: 3)
      XCTAssertFalse(pickerOpen)
      XCTAssertEqual(store.list.threads.first?.projectId, projectID)
      XCTAssertEqual(store.selectedConversation?.thread.projectId, projectID)
      XCTAssertEqual(store.selectedThreadID, original.id)
      XCTAssertEqual(store.list.threads.first?.sortAt, original.sortAt)
      if let projectID { XCTAssertTrue(store.projects.isExpanded(projectID)) }

      moving.cancel()
      await store.refresh()
      XCTAssertEqual(store.list.threads.first?.projectId, projectID)
      gate.open()
      let moved = await moving.value
      XCTAssertTrue(moved)
    }
    fixture.remote(
      kind: "project_updated", extra: ",\"projectId\":\"\(ThreadActionsFixture.project)\"")
    await store.refresh()
    XCTAssertEqual(store.selectedConversation?.thread.projectId, ThreadActionsFixture.project)
    XCTAssertEqual(fixture.writes.map(\.action), ["project", "project", "project"])
  }

  func testFailedProjectMoveRetriesItsIdentityAndSettlesEarlierFailedMoves() async throws {
    let fixture = ThreadActionsFixture()
    let store = fixture.workspace()
    defer { store.close() }
    await store.refresh()
    fixture.state.value.withLock { $0.failNext["project"] = 503 }
    let failed = await store.moveToProject(
      ThreadActionsFixture.thread, projectID: ThreadActionsFixture.project)
    XCTAssertFalse(failed)
    XCTAssertEqual(store.threadFeedback?.actionTitle, "Retry")
    await store.refresh()
    XCTAssertEqual(store.list.threads.first?.projectId, ThreadActionsFixture.project)
    await (try XCTUnwrap(store.threadFeedback)).action()
    let ids = fixture.writes.compactMap(\.eventID)
    XCTAssertEqual(ids.count, 2)
    XCTAssertEqual(ids.first, ids.last)
    XCTAssertEqual(try XCTUnwrap(ids.first).split(separator: "-")[2].first, "7")
    XCTAssertNil(store.threadFeedback)

    fixture.state.value.withLock { $0.failNext["project"] = 503 }
    await store.moveToProject(
      ThreadActionsFixture.thread, projectID: ThreadActionsFixture.otherProject)
    let moved = await store.moveToProject(ThreadActionsFixture.thread, projectID: nil)
    XCTAssertTrue(moved)
    // A later confirmed choice also settles the earlier move that never persisted.
    fixture.remote(
      kind: "project_updated", extra: ",\"projectId\":\"\(ThreadActionsFixture.project)\"")
    await store.refresh()
    XCTAssertEqual(store.list.threads.first?.projectId, ThreadActionsFixture.project)
    XCTAssertEqual(Set(fixture.writes.compactMap(\.eventID)).count, 3)
  }

  func testOpenMenuUsesTheLatestTitleWhenSettingStatusOrMovingToProject() async throws {
    let fixture = ThreadActionsFixture()
    let store = fixture.workspace()
    defer { store.close() }
    await store.refresh()
    var movedTitle: String?
    let menu = ChatThreadMenu(
      workspace: store, threadID: ThreadActionsFixture.thread,
      moveToProject: { movedTitle = $0.title })
    fixture.remote(kind: "renamed", extra: ",\"title\":\"Updated from another device\"")
    await store.refresh()

    await menu.perform(.setStatus("🔥"))
    XCTAssertEqual(fixture.writes.map(\.title), ["🔥 Updated from another device"])
    await menu.perform(.moveToProject)
    XCTAssertEqual(movedTitle, "🔥 Updated from another device")
    await menu.perform(.setStatus(nil))
    XCTAssertEqual(store.list.threads.first?.title, "Updated from another device")
  }

  func testOpenMenuCannotMarkUnreadAfterTheChatBecomesMuted() async throws {
    let fixture = ThreadActionsFixture()
    let store = fixture.workspace()
    defer { store.close() }
    await store.refresh()
    let menu = ChatThreadMenu(
      workspace: store, threadID: ThreadActionsFixture.thread, moveToProject: { _ in })

    await menu.perform(.mute)
    XCTAssertTrue(try XCTUnwrap(store.list.threads.first).isMuted)
    await menu.perform(.markUnread)
    XCTAssertEqual(fixture.writes.map(\.action), ["mute"])
    await menu.perform(.mute)
    XCTAssertFalse(try XCTUnwrap(store.list.threads.first).isMuted)
    XCTAssertEqual(fixture.writes.map(\.action), ["mute", "mark-read", "unmute"])
  }

  func testRenameUpdatesListAndOpenChatBeforeSavingAndReconcilesWithRemoteTitles() async throws {
    let fixture = ThreadActionsFixture()
    let store = fixture.workspace()
    defer { store.close() }
    await store.refresh()
    store.selectChat(ThreadActionsFixture.thread)
    store.list.beginRename(ThreadActionsFixture.thread)
    store.list.renameTitle = "  Focus for this week  "
    let gate = ThreadActionGate()
    defer { gate.open() }
    let requested = expectation(description: "Write reached the HTTP boundary")
    fixture.state.value.withLock {
      $0.nextGate = gate
      $0.nextWriteRequested = { requested.fulfill() }
    }
    let saving = Task { await store.list.saveRename() }
    addTeardownBlock { @MainActor in
      store.close()
      saving.cancel()
      gate.open()
      await saving.value
    }
    await fulfillment(of: [requested], timeout: 3)
    XCTAssertNil(store.list.renameRequest)
    XCTAssertEqual(store.list.threads.first?.displayTitle, "Focus for this week")
    XCTAssertEqual(store.selectedConversation?.thread.displayTitle, "Focus for this week")

    // An old server snapshot must not replace the title while its write is pending.
    await store.refresh()
    XCTAssertEqual(store.list.threads.first?.displayTitle, "Focus for this week")
    XCTAssertEqual(store.selectedConversation?.thread.displayTitle, "Focus for this week")
    gate.open()
    await saving.value
    fixture.remote(kind: "renamed", extra: ",\"title\":\"Updated from another device\"")
    await store.refresh()
    XCTAssertEqual(store.list.threads.first?.displayTitle, "Updated from another device")
    XCTAssertEqual(store.selectedConversation?.thread.displayTitle, "Updated from another device")
  }

  func testRenameTrimsSkipsUnchangedTitlesAndKeepsInputForExplicitRetry() async throws {
    let fixture = ThreadActionsFixture()
    let store = fixture.workspace()
    defer { store.close() }
    await store.refresh()
    store.selectChat(ThreadActionsFixture.thread)
    store.list.beginRename(ThreadActionsFixture.thread)
    store.list.renameTitle = "  \n "
    await store.list.saveRename()
    XCTAssertTrue(fixture.writes.isEmpty)
    store.list.beginRename(ThreadActionsFixture.thread)
    store.list.renameTitle = "  Planning a useful week \n"
    await store.list.saveRename()
    XCTAssertTrue(fixture.writes.isEmpty)
    fixture.state.value.withLock { $0.failNext["rename"] = 503 }
    store.list.beginRename(ThreadActionsFixture.thread)
    store.list.renameTitle = "  A title worth keeping  "
    await store.list.saveRename()
    XCTAssertEqual(store.list.renameTitle, "  A title worth keeping  ")
    XCTAssertNotNil(store.list.renameRequest?.error)
    XCTAssertEqual(store.selectedConversation?.thread.title, "A title worth keeping")
    await store.refresh()
    XCTAssertEqual(store.list.threads.first?.displayTitle, "A title worth keeping")
    await store.list.saveRename()
    XCTAssertEqual(store.list.threads.first?.displayTitle, "A title worth keeping")
    XCTAssertEqual(
      fixture.writes.filter { $0.action == "rename" }.map(\.title),
      ["A title worth keeping", "A title worth keeping"])
    let renameIDs = fixture.writes.filter { $0.action == "rename" }.compactMap(\.eventID)
    XCTAssertEqual(renameIDs.count, 2)
    XCTAssertNotNil(UUID(uuidString: try XCTUnwrap(renameIDs.first)))
    XCTAssertEqual(Set(renameIDs).count, 1)
    fixture.remote(kind: "renamed", extra: ",\"title\":\"Confirmed elsewhere\"")
    await store.refresh()
    XCTAssertEqual(store.selectedConversation?.thread.title, "Confirmed elsewhere")
  }

  func testUnmuteMarksReadBeforeExposingPastRepliesAndRetriesFailures() async throws {
    let fixture = ThreadActionsFixture(muted: true)
    let store = fixture.workspace()
    defer { store.close() }
    await store.prepareWorkspaceComposer()
    await store.refresh()
    XCTAssertFalse(try XCTUnwrap(store.list.threads.first).isUnread)
    fixture.state.value.withLock { $0.failNext["mark-read"] = 503 }
    XCTAssertTrue(store.list.canMute(ThreadActionsFixture.thread))
    await store.setMuted(ThreadActionsFixture.thread, muted: false)
    XCTAssertEqual(fixture.writes.map(\.action), ["mark-read"])
    XCTAssertTrue(try XCTUnwrap(store.list.threads.first).isMuted)
    XCTAssertEqual(store.threadFeedback?.actionTitle, "Retry")
    let retry = try XCTUnwrap(store.threadFeedback)
    await retry.action()
    XCTAssertEqual(fixture.writes.map(\.action), ["mark-read", "mark-read", "unmute"])
    let thread = try XCTUnwrap(store.list.threads.first)
    XCTAssertFalse(thread.isMuted)
    XCTAssertFalse(thread.isUnread)
    XCTAssertEqual(store.threadFeedback?.actionTitle, "Undo")

    // A new reply after unmuting can become unread normally.
    fixture.state.value.withLock { $0.unread = true }
    await store.list.refreshIndicators()
    XCTAssertTrue(try XCTUnwrap(store.list.threads.first).isUnread)
  }

  func testMuteDenialAndUnmuteFailureKeepRecoverableState() async throws {
    let fixture = ThreadActionsFixture()
    let store = fixture.workspace()
    defer { store.close() }
    await store.prepareWorkspaceComposer()
    await store.refresh()
    fixture.state.value.withLock { $0.failNext["mute"] = 404 }
    await store.setMuted(ThreadActionsFixture.thread, muted: true)
    XCTAssertFalse(try XCTUnwrap(store.list.threads.first).isMuted)
    XCTAssertTrue(try XCTUnwrap(store.list.threads.first).isUnread)
    await (try XCTUnwrap(store.threadFeedback)).action()
    XCTAssertTrue(try XCTUnwrap(store.list.threads.first).isMuted)
    // Undo a mute restores the old unread state, without marking read.
    await (try XCTUnwrap(store.threadFeedback)).action()
    XCTAssertEqual(fixture.writes.map(\.action), ["mute", "mute", "unmute"])
    XCTAssertTrue(try XCTUnwrap(store.list.threads.first).isUnread)
    await store.setMuted(ThreadActionsFixture.thread, muted: true)
    fixture.state.value.withLock { $0.failNext["unmute"] = 403 }
    await store.setMuted(ThreadActionsFixture.thread, muted: false)
    XCTAssertTrue(try XCTUnwrap(store.list.threads.first).isMuted)
    XCTAssertEqual(store.threadFeedback?.actionTitle, "Retry")
    await (try XCTUnwrap(store.threadFeedback)).action()
    XCTAssertFalse(try XCTUnwrap(store.list.threads.first).isMuted)
    XCTAssertFalse(try XCTUnwrap(store.list.threads.first).isUnread)
  }

  func testClosingWorkspaceCancelsMutationsAndDiscardsEditorsFeedbackAndUndo() async throws {
    for operation in ["archive", "mute", "rename"] {
      let fixture = ThreadActionsFixture()
      let store = fixture.workspace()
      defer { store.close() }
      await store.prepareWorkspaceComposer()
      await store.refresh()
      store.selectChat(ThreadActionsFixture.thread)
      let gate = ThreadActionGate()
      defer { gate.open() }
      let requested = expectation(description: "Write reached the HTTP boundary")
      fixture.state.value.withLock {
        $0.nextGate = gate
        $0.nextWriteRequested = { requested.fulfill() }
      }
      let pending = Task {
        switch operation {
        case "archive":
          await store.setArchived(ThreadActionsFixture.thread, archived: true, leaveDetail: true)
        case "mute": await store.setMuted(ThreadActionsFixture.thread, muted: true)
        default:
          store.list.beginRename(ThreadActionsFixture.thread)
          store.list.renameTitle = "Old workspace edit"
          await store.list.saveRename()
        }
      }
      addTeardownBlock { @MainActor in
        store.close()
        pending.cancel()
        gate.open()
        await pending.value
      }
      await fulfillment(of: [requested], timeout: 3)
      store.close()
      gate.open()
      await pending.value
      XCTAssertNil(store.threadFeedback)
      XCTAssertNil(store.list.renameRequest)
      let freshFixture = ThreadActionsFixture()
      let fresh = freshFixture.workspace()
      defer { fresh.close() }
      await fresh.refresh()
      XCTAssertEqual(fresh.list.threads.first?.title, "Planning a useful week")
      XCTAssertFalse(try XCTUnwrap(fresh.list.threads.first).isMuted)
      XCTAssertFalse(try XCTUnwrap(fresh.list.threads.first).isArchived)
      XCTAssertNil(fresh.threadFeedback)
    }
  }

  func testUpgradeFromMenuMutationClosesWorkspaceWithoutRetryOrEditor() async throws {
    let fixture = ThreadActionsFixture()
    let store = fixture.workspace()
    await store.prepareWorkspaceComposer()
    await store.refresh()
    fixture.state.value.withLock { $0.failNext["mute"] = 426 }
    await store.setMuted(ThreadActionsFixture.thread, muted: true)
    XCTAssertTrue(store.needsUpgrade)
    XCTAssertNil(store.threadFeedback)
    store.list.beginRename(ThreadActionsFixture.thread)
    XCTAssertNil(store.list.renameRequest)
  }

}

@MainActor
final class ChatThreadArchiveTests: XCTestCase {

  func testArchiveDismissesAttentionWhilePreservingUnreadStateAndUndo() async throws {
    let fixture = ThreadActionsFixture()
    let store = fixture.workspace()
    defer { store.close() }
    await store.prepareWorkspaceComposer()
    await store.refresh()
    store.sidebar.select(.unread)
    let before = try XCTUnwrap(store.list.threads.first)
    XCTAssertTrue(before.isUnread)
    XCTAssertTrue(store.list.hasUnreadThreads)

    let archived = await store.setArchived(ThreadActionsFixture.thread, archived: true)

    XCTAssertTrue(archived)
    let archivedThread = try XCTUnwrap(store.list.threads.first)
    XCTAssertTrue(archivedThread.isArchived)
    XCTAssertTrue(archivedThread.isUnread)
    XCTAssertEqual(archivedThread.unreadAt, before.unreadAt)
    XCTAssertFalse(store.list.hasUnreadThreads)
    XCTAssertEqual(fixture.writes.map(\.action), ["archive"])

    let undo = try XCTUnwrap(store.threadFeedback)
    store.navigationActions.setRowVisible(undo.threadID, visible: true)
    await store.navigationActions.performThreadFeedback(undo.id)
    await store.navigationActions.performThreadFeedback(undo.id)

    XCTAssertEqual(store.threadFeedback?.message, "Chat unarchived")
    XCTAssertNil(store.threadFeedback?.actionTitle)
    XCTAssertEqual(store.threadFeedback?.kind, .archiveUndo(showsBanner: false))
    XCTAssertFalse(try XCTUnwrap(store.list.threads.first).isArchived)
    XCTAssertTrue(try XCTUnwrap(store.list.threads.first).isUnread)
    XCTAssertTrue(store.list.hasUnreadThreads)
    XCTAssertEqual(fixture.writes.map(\.action), ["archive", "unarchive"])
  }

  func testAcceptedArchiveKeepsUndoWhenTheFollowingListRefreshFails() async throws {
    let fixture = ThreadActionsFixture()
    let store = fixture.workspace()
    defer { store.close() }
    await store.prepareWorkspaceComposer()
    await store.refresh()
    fixture.state.value.withLock { $0.failNext["events"] = 503 }

    let archived = await store.setArchived(ThreadActionsFixture.thread, archived: true)

    XCTAssertTrue(archived)
    XCTAssertEqual(store.threadFeedback?.actionTitle, "Undo")
    XCTAssertTrue(try XCTUnwrap(store.list.threads.first).isArchived)
    await store.refresh()
    XCTAssertTrue(try XCTUnwrap(store.list.threads.first).isArchived)
    XCTAssertEqual(fixture.writes.map(\.action), ["archive"])
    await store.navigationActions.performThreadFeedback(try XCTUnwrap(store.threadFeedback).id)
    XCTAssertFalse(try XCTUnwrap(store.list.threads.first).isArchived)
    XCTAssertEqual(fixture.writes.map(\.action), ["archive", "unarchive"])
  }

  func testListArchiveAndUndoKeepTheCurrentPageAndDraft() async throws {
    let fixture = ThreadActionsFixture()
    let store = fixture.workspace()
    defer { store.close() }
    await store.prepareWorkspaceComposer()
    await store.refresh()
    store.selectChat(ThreadActionsFixture.thread)
    try XCTUnwrap(store.selectedConversation).draft = "Keep the conversation draft"
    store.sidebar.select(.unread)
    store.sidebarInteraction.setOpen(true)

    let archived = await store.setArchived(ThreadActionsFixture.thread, archived: true)

    XCTAssertTrue(archived)
    XCTAssertTrue(store.sidebarInteraction.isOpen)
    XCTAssertEqual(store.sidebar.filter, .unread)
    XCTAssertEqual(store.selectedThreadID, ThreadActionsFixture.thread)
    XCTAssertEqual(store.selectedConversation?.draft, "Keep the conversation draft")
    let undo = try XCTUnwrap(store.threadFeedback)
    XCTAssertFalse(undo.requiresNavigation)
    XCTAssertEqual(undo.actionTitle, "Undo")
    await store.navigationActions.performThreadFeedback(undo.id)
    XCTAssertTrue(store.sidebarInteraction.isOpen)
    XCTAssertEqual(store.sidebar.filter, .unread)
    XCTAssertEqual(store.threadFeedback?.kind, .archiveUndo(showsBanner: true))
    XCTAssertNil(store.threadFeedback?.actionTitle)
    store.navigationActions.setRowVisible(undo.threadID, visible: true)
    store.navigationActions.setRowVisible(undo.threadID, visible: false)
    XCTAssertEqual(store.threadFeedback?.kind, .archiveUndo(showsBanner: false))
    XCTAssertFalse(try XCTUnwrap(store.list.threads.first).isArchived)
    XCTAssertEqual(fixture.writes.map(\.action), ["archive", "unarchive"])
  }

  func testDetailArchiveWaitsForNewChatCreationToReleaseNavigation() async throws {
    let fixture = ThreadActionsFixture()
    let store = fixture.workspace()
    defer { store.close() }
    await store.prepareWorkspaceComposer()
    await store.refresh()
    store.selectChat(ThreadActionsFixture.thread)
    store.sidebarInteraction.setOpen(false)
    let menu = ChatThreadMenu(
      workspace: store, threadID: ThreadActionsFixture.thread, moveToProject: { _ in })
    await menu.perform(.archive)
    let undo = try XCTUnwrap(store.threadFeedback)
    XCTAssertTrue(undo.requiresNavigation)
    XCTAssertTrue(store.sidebarInteraction.isOpen)
    store.startNewChat()
    store.sidebarInteraction.setOpen(false)
    let gate = ThreadActionGate()
    defer { gate.open() }
    let requested = expectation(description: "Write reached the HTTP boundary")
    fixture.state.value.withLock {
      $0.nextGate = gate
      $0.nextWriteRequested = { requested.fulfill() }
    }
    let creating = Task { await store.createChat() }
    addTeardownBlock { @MainActor in
      store.close()
      creating.cancel()
      gate.open()
      await creating.value
    }
    await fulfillment(of: [requested], timeout: 3)
    await store.navigationActions.performThreadFeedback(undo.id)
    XCTAssertNil(store.selectedThreadID)
    XCTAssertEqual(fixture.writes.map(\.action), ["archive", "create"])
    store.selectChat(ThreadActionsFixture.thread)
    let unarchived = await store.setArchived(ThreadActionsFixture.thread, archived: false)
    XCTAssertTrue(unarchived)
    let archived = await store.setArchived(
      ThreadActionsFixture.thread, archived: true, leaveDetail: true)
    XCTAssertFalse(archived)
    XCTAssertEqual(store.selectedThreadID, ThreadActionsFixture.thread)
    XCTAssertEqual(fixture.writes.map(\.action), ["archive", "create", "unarchive"])
    gate.open()
    let created = await creating.value
    XCTAssertEqual(created?.id, ThreadActionsFixture.createdThread)
    XCTAssertEqual(store.selectedThreadID, ThreadActionsFixture.createdThread)
    store.selectChat(ThreadActionsFixture.thread)
    try XCTUnwrap(store.selectedConversation).draft = "Keep the original reply"
    let saved = await store.setArchived(
      ThreadActionsFixture.thread, archived: true, leaveDetail: true)
    XCTAssertTrue(saved)
    XCTAssertEqual(store.selectedThreadID, ThreadActionsFixture.thread)
    XCTAssertEqual(fixture.writes.map(\.action), ["archive", "create", "unarchive", "archive"])
    XCTAssertTrue(store.sidebarInteraction.isOpen)
    await store.navigationActions.performThreadFeedback(try XCTUnwrap(store.threadFeedback).id)
    XCTAssertFalse(store.sidebarInteraction.isOpen)
    XCTAssertEqual(store.selectedThreadID, ThreadActionsFixture.thread)
    XCTAssertEqual(store.selectedConversation?.draft, "Keep the original reply")
    XCTAssertNil(store.threadFeedback?.actionTitle)
    XCTAssertEqual(store.threadFeedback?.kind, .archiveUndo(showsBanner: false))
  }

  func testDetailArchiveSurvivesNavigationAndCallerCancellationWithoutInterruptingNewChat()
    async throws
  {
    let fixture = ThreadActionsFixture()
    let store = fixture.workspace()
    defer { store.close() }
    await store.prepareWorkspaceComposer()
    await store.refresh()
    store.selectChat(ThreadActionsFixture.thread)
    store.sidebar.select(.unread)
    store.sidebarInteraction.setOpen(false)
    try XCTUnwrap(store.selectedConversation).draft = "Keep my reply after undo"
    let gate = ThreadActionGate()
    defer { gate.open() }
    let requested = expectation(description: "Write reached the HTTP boundary")
    fixture.state.value.withLock {
      $0.nextGate = gate
      $0.nextWriteRequested = { requested.fulfill() }
    }
    let archiving = Task {
      await store.setArchived(ThreadActionsFixture.thread, archived: true, leaveDetail: true)
    }
    addTeardownBlock {
      archiving.cancel()
      gate.open()
      _ = await archiving.value
    }
    await fulfillment(of: [requested], timeout: 3)
    XCTAssertTrue(store.sidebarInteraction.isOpen)
    XCTAssertTrue(store.threadFeedback?.isWorking == true)
    XCTAssertNil(store.threadFeedback?.actionTitle)
    XCTAssertEqual(store.selectedThreadID, ThreadActionsFixture.thread)
    XCTAssertEqual(store.selectedConversation?.draft, "Keep my reply after undo")
    XCTAssertTrue(store.list.threads(archived: false).isEmpty)
    XCTAssertEqual(
      store.list.threads(archived: true).map(\.id),
      [ThreadActionsFixture.thread])
    XCTAssertEqual(store.sidebar.filter, .unread)
    // The user can start unrelated work before the archive confirmation arrives.
    store.startNewChat()
    store.sidebarInteraction.setOpen(false)
    store.newChatDraft = "Continue a different task"
    // Ending the initiating detail task must not revoke the workspace-owned command.
    archiving.cancel()
    let duplicate = await store.setArchived(ThreadActionsFixture.thread, archived: true)
    XCTAssertFalse(duplicate)
    gate.open()
    let archived = await archiving.value
    XCTAssertTrue(archived)
    XCTAssertFalse(store.sidebarInteraction.isOpen)
    XCTAssertNil(store.selectedThreadID)
    XCTAssertEqual(store.newChatDraft, "Continue a different task")
    XCTAssertNil(store.threadFeedback)
    store.sidebarInteraction.goBack()
    XCTAssertNil(store.threadFeedback)
    XCTAssertEqual(
      store.conversation(for: ThreadActionsFixture.thread)?.draft, "Keep my reply after undo")
    XCTAssertTrue(try XCTUnwrap(store.list.threads.first).isArchived)
    XCTAssertEqual(fixture.writes.map(\.action), ["archive"])
  }

  func testArchiveFailureReturnsToSourceAndRetriesTheOriginalEventWithoutReopeningChat()
    async throws
  {
    let fixture = ThreadActionsFixture(muted: true)
    let store = fixture.workspace()
    defer { store.close() }
    await store.prepareWorkspaceComposer()
    await store.refresh()
    store.selectChat(ThreadActionsFixture.thread)
    store.sidebarInteraction.setOpen(false)
    let gate = ThreadActionGate()
    defer { gate.open() }
    let requested = expectation(description: "Archive reached HTTP")
    fixture.state.value.withLock {
      $0.failNext["archive"] = 503
      $0.nextGate = gate
      $0.nextWriteRequested = { requested.fulfill() }
    }
    let archiving = Task {
      await store.setArchived(ThreadActionsFixture.thread, archived: true, leaveDetail: true)
    }
    addTeardownBlock {
      gate.open()
      _ = await archiving.value
    }
    await fulfillment(of: [requested], timeout: 3)
    XCTAssertTrue(store.sidebarInteraction.isOpen)
    store.startNewChat()
    store.sidebarInteraction.setOpen(false)
    store.newChatDraft = "A separate task"
    gate.open()
    let archived = await archiving.value
    XCTAssertFalse(archived)
    XCTAssertNil(store.threadFeedback)

    store.sidebarInteraction.goBack()
    let retry = try XCTUnwrap(store.threadFeedback)
    XCTAssertEqual(retry.actionTitle, "Retry")
    XCTAssertTrue(retry.message.contains("Planning a useful week"))
    await store.navigationActions.performThreadFeedback(retry.id)
    let archiveIDs = fixture.writes.filter { $0.action == "archive" }.compactMap(\.eventID)
    XCTAssertEqual(archiveIDs, Array(repeating: try XCTUnwrap(archiveIDs.first), count: 2))
    let undo = try XCTUnwrap(store.threadFeedback)
    XCTAssertEqual(undo.actionTitle, "Undo")
    XCTAssertFalse(undo.requiresNavigation)

    fixture.state.value.withLock { $0.failNext["unarchive"] = 503 }
    await store.navigationActions.performThreadFeedback(undo.id)
    let retryUndo = try XCTUnwrap(store.threadFeedback)
    XCTAssertEqual(retryUndo.actionTitle, "Retry")
    XCTAssertTrue(retryUndo.persists)
    await store.navigationActions.performThreadFeedback(retryUndo.id)
    let undoIDs = fixture.writes.filter { $0.action == "unarchive" }.compactMap(\.eventID)
    XCTAssertEqual(undoIDs, Array(repeating: try XCTUnwrap(undoIDs.first), count: 2))
    XCTAssertNil(store.threadFeedback?.actionTitle)
    XCTAssertEqual(store.threadFeedback?.message, "Chat unarchived")
    XCTAssertTrue(store.sidebarInteraction.isOpen)
    XCTAssertNil(store.selectedThreadID)
    XCTAssertEqual(store.newChatDraft, "A separate task")
    XCTAssertFalse(try XCTUnwrap(store.list.threads.first).isArchived)
    XCTAssertTrue(try XCTUnwrap(store.list.threads.first).isMuted)
  }

  func testRetryReconcilesALostArchiveResponseBeforeSendingAnotherWrite() async throws {
    let fixture = ThreadActionsFixture()
    let store = fixture.workspace()
    defer { store.close() }
    await store.refresh()
    let id = ThreadActionsFixture.thread
    store.selectChat(id)
    store.sidebarInteraction.setOpen(false)
    fixture.state.value.withLock { $0.failNext["archive"] = 503 }
    await store.setArchived(id, archived: true, leaveDetail: true)
    let retry = try XCTUnwrap(store.threadFeedback)
    XCTAssertEqual(retry.actionTitle, "Retry")
    fixture.remote(kind: "archived", eventID: try XCTUnwrap(fixture.writes.first?.eventID))
    await store.navigationActions.performThreadFeedback(retry.id)
    XCTAssertEqual(fixture.writes.map(\.action), ["archive"])
    XCTAssertTrue(try XCTUnwrap(store.list.threads.first).isArchived)
    let undo = try XCTUnwrap(store.threadFeedback)
    XCTAssertEqual(undo.actionTitle, "Undo")
    XCTAssertTrue(undo.requiresNavigation)

    fixture.state.value.withLock { $0.failNext["unarchive"] = 503 }
    await store.navigationActions.performThreadFeedback(undo.id)
    let retryUndo = try XCTUnwrap(store.threadFeedback)
    fixture.remote(kind: "unarchived", eventID: try XCTUnwrap(fixture.writes.last?.eventID))
    fixture.remote(kind: "archived")
    await store.navigationActions.performThreadFeedback(retryUndo.id)

    XCTAssertEqual(fixture.writes.map(\.action), ["archive", "unarchive"])
    XCTAssertTrue(try XCTUnwrap(store.list.threads.first).isArchived)
    XCTAssertTrue(store.sidebarInteraction.isOpen)
    XCTAssertNil(store.threadFeedback)
  }

  func testOpeningAnotherChatWhileUndoIsPendingKeepsItsDraftAndConsumesTheUndo() async throws {
    let fixture = ThreadActionsFixture()
    let store = fixture.workspace()
    defer { store.close() }
    let first = ThreadActionsFixture.thread
    let second = ThreadActionsFixture.createdThread
    fixture.remote(kind: "created", threadID: second)
    await store.prepareWorkspaceComposer()
    await store.refresh()
    store.selectChat(first)
    store.sidebarInteraction.setOpen(false)
    await store.setArchived(first, archived: true, leaveDetail: true)
    let undo = try XCTUnwrap(store.threadFeedback)
    let gate = ThreadActionGate()
    defer { gate.open() }
    let requested = expectation(description: "Undo reached HTTP")
    fixture.state.value.withLock {
      $0.nextGate = gate
      $0.nextWriteRequested = { requested.fulfill() }
    }
    let undoing = Task { await store.navigationActions.performThreadFeedback(undo.id) }
    addTeardownBlock {
      gate.open()
      await undoing.value
    }
    await fulfillment(of: [requested], timeout: 3)
    store.selectChat(second)
    store.sidebarInteraction.setOpen(false)
    try XCTUnwrap(store.selectedConversation).draft = "Finish the other reply"
    gate.open()
    await undoing.value

    XCTAssertNil(store.threadFeedback)
    XCTAssertEqual(store.selectedThreadID, second)
    XCTAssertEqual(store.selectedConversation?.draft, "Finish the other reply")
    XCTAssertFalse(try XCTUnwrap(store.list.threads.first { $0.id == first }).isArchived)
    store.sidebarInteraction.goBack()
    await store.navigationActions.performThreadFeedback(undo.id)
    XCTAssertNil(store.threadFeedback)
    XCTAssertEqual(fixture.writes.map(\.action), ["archive", "unarchive"])
  }

  func testLeavingTheListExpiresUndoAndDirectUnarchiveOffersItsOwnSingleUndo() async throws {
    let fixture = ThreadActionsFixture()
    let store = fixture.workspace()
    defer { store.close() }
    fixture.remote(kind: "created", threadID: ThreadActionsFixture.createdThread)
    await store.refresh()
    let id = ThreadActionsFixture.thread
    await store.setArchived(id, archived: true)
    let oldUndo = try XCTUnwrap(store.threadFeedback)
    store.selectChat(ThreadActionsFixture.createdThread)
    store.sidebarInteraction.setOpen(false)
    XCTAssertNil(store.threadFeedback)
    store.sidebarInteraction.goBack()
    XCTAssertNil(store.threadFeedback)
    await store.navigationActions.performThreadFeedback(oldUndo.id)
    XCTAssertEqual(fixture.writes.map(\.action), ["archive"])

    store.sidebar.select(.archived)
    await store.setArchived(id, archived: false)
    let expired = try XCTUnwrap(store.threadFeedback)
    store.sidebar.select(.recent)
    store.sidebar.select(.archived)
    XCTAssertNil(store.threadFeedback)
    await store.navigationActions.performThreadFeedback(expired.id)
    XCTAssertEqual(fixture.writes.map(\.action), ["archive", "unarchive"])

    // The archived detail (including a deep-link entry) stays open on direct Unarchive.
    fixture.remote(kind: "archived")
    await store.refresh()
    let opened = await store.openChatLink(.thread(id: id, runID: nil))
    XCTAssertTrue(opened)
    store.sidebarInteraction.setOpen(false)
    await store.setArchived(id, archived: false, leaveDetail: true)
    let undo = try XCTUnwrap(store.threadFeedback)
    XCTAssertTrue(store.sidebarInteraction.showsChat)
    XCTAssertEqual(undo.actionTitle, "Undo")
    await store.navigationActions.performThreadFeedback(undo.id)
    XCTAssertEqual(store.threadFeedback?.message, "Chat archived")
    XCTAssertNil(store.threadFeedback?.actionTitle)
    XCTAssertEqual(store.selectedThreadID, id)
    XCTAssertTrue(try XCTUnwrap(store.list.threads.first { $0.id == id }).isArchived)
    XCTAssertEqual(fixture.writes.map(\.action), ["archive", "unarchive", "unarchive", "archive"])
  }

  func testDirectUnarchiveFromArchivedSupersedesAnUnconfirmedArchive() async throws {
    let fixture = ThreadActionsFixture()
    let store = fixture.workspace()
    defer { store.close() }
    await store.refresh()
    let id = ThreadActionsFixture.thread
    fixture.state.value.withLock { $0.failNext["archive"] = 503 }
    await store.setArchived(id, archived: true)
    let retry = try XCTUnwrap(store.threadFeedback)
    store.sidebar.select(.archived)
    await store.setArchived(id, archived: false)
    store.sidebar.select(.recent)

    await store.navigationActions.performThreadFeedback(retry.id)
    XCTAssertNil(store.threadFeedback)
    XCTAssertFalse(try XCTUnwrap(store.list.threads.first).isArchived)
    XCTAssertEqual(fixture.writes.map(\.action), ["archive", "unarchive"])
  }

  func testLateArchiveAcknowledgementPreservesTheNewerChatUndo() async throws {
    let fixture = ThreadActionsFixture()
    let store = fixture.workspace()
    defer { store.close() }
    let first = ThreadActionsFixture.thread
    let second = ThreadActionsFixture.createdThread
    fixture.remote(kind: "created", threadID: second)
    await store.refresh()
    let gate = ThreadActionGate()
    defer { gate.open() }
    let requested = expectation(description: "First archive reached HTTP")
    fixture.state.value.withLock {
      $0.nextGate = gate
      $0.nextWriteRequested = { requested.fulfill() }
    }
    let archiving = Task { await store.setArchived(first, archived: true) }
    addTeardownBlock {
      gate.open()
      _ = await archiving.value
    }
    await fulfillment(of: [requested], timeout: 3)
    await store.setArchived(second, archived: true)
    let undo = try XCTUnwrap(store.threadFeedback)
    gate.open()
    _ = await archiving.value
    XCTAssertEqual(store.threadFeedback?.id, undo.id)
    XCTAssertEqual(undo.threadID, second)
    await store.navigationActions.performThreadFeedback(undo.id)
    XCTAssertTrue(try XCTUnwrap(store.list.threads.first { $0.id == first }).isArchived)
    XCTAssertFalse(try XCTUnwrap(store.list.threads.first { $0.id == second }).isArchived)
  }

  func testArchivedDetailDoesNotReadRepliesBehindTheList() async throws {
    let fixture = ThreadActionsFixture()
    let store = fixture.workspace()
    defer { store.close() }
    await store.prepareWorkspaceComposer()
    await store.refresh()
    store.selectChat(ThreadActionsFixture.thread)
    await store.setArchived(ThreadActionsFixture.thread, archived: true, leaveDetail: true)
    let undo = try XCTUnwrap(store.threadFeedback)
    store.setPhase(.active)

    // A reply can bring the retained chat back while the user is still choosing work.
    fixture.remote(kind: "unarchived")
    await store.refresh()
    await store.selectedConversation?.refresh()
    XCTAssertTrue(store.sidebarInteraction.isOpen)
    XCTAssertTrue(try XCTUnwrap(store.list.threads.first).isUnread)
    XCTAssertEqual(fixture.writes.map(\.action), ["archive"])

    await store.navigationActions.performThreadFeedback(undo.id)
    await store.selectedConversation?.refresh()
    XCTAssertFalse(store.sidebarInteraction.isOpen)
    XCTAssertFalse(try XCTUnwrap(store.list.threads.first).isUnread)
    XCTAssertEqual(fixture.writes.map(\.action), ["archive", "unarchive", "mark-read"])
  }

}
