import CCState
import ChatData
import ChatDomain
import Foundation
import Observation

/// The deck keeps its order for one visit. Only the visible card gets a read receipt.
@MainActor @Observable
final class ForYouStore {
  struct Notice {
    let text: String
    var threadID: String?
    var undo: Undo?
  }
  struct Undo {
    let card: ForYouCard
    let position: Int
    let feedbackID: String
    let undoID = UUID().uuidString
  }
  /// One card this visit settled, for the recap that closes it.
  struct Handled: Identifiable {
    let id: String
    let title: String
    let detail: String
    var threadID: String?
    var undo: Undo?
  }
  private struct Selection {
    let cardID: String
    let optionID: String
    let direction: ComposerDraft?
    var model: ChatModelSelection?
    var effort: String?
    var options: ChatComposerOptions?
    var computerAccess: ChatComputerAccess?
    let newThreadID = UUID().uuidString
    let messageID = UUID().uuidString
    let sortID = UUID().uuidString
    var threadID: String?
    var prepared = false
  }
  private weak var workspace: WorkspaceStore?
  private let resources: WorkspaceResources
  private let feed: ForYouFeed
  private let commands: ChatCommands
  private var readIDs: Set<String> = []
  private var selections: [String: Selection] = [:]
  private struct ResponseID {
    let card: String
    let reason: ForYouFeedback?
    let id = UUID().uuidString
  }
  private var feedbackID: ResponseID?
  private(set) var cards: [ForYouCard] = []
  private(set) var position = 0
  private(set) var loaded = false
  private(set) var busy = false
  var error: String?
  var notice: Notice?
  private(set) var handled: [Handled] = []
  private(set) var direction: ForYouDirection?

  var current: ForYouCard? { cards.indices.contains(position) ? cards[position] : nil }
  var summary: Computed<Task<Bool, Error>> { resources.forYouSummary }

  init(
    workspace: WorkspaceStore, resources: WorkspaceResources, feed: ForYouFeed,
    commands: ChatCommands
  ) {
    self.workspace = workspace
    self.resources = resources
    self.feed = feed
    self.commands = commands
  }

  /// A visit starts without the previous one's confirmations.
  func beginVisit() async {
    handled = []
    notice = nil
    await load()
  }

  func load() async {
    guard !busy else { return }
    let previous = current?.id
    do {
      let result = try await resources.loadForYou()
      try Task.checkCancellation()
      if let direction, !result.contains(where: { $0.id == direction.cardID }) { closeDirection() }
      cards = result
      position = previous.flatMap { id in result.firstIndex { $0.id == id } } ?? 0
      loaded = true
      error = nil
    } catch is CancellationError {
    } catch { self.error = error.localizedDescription }
  }

  /// The pager came to rest on a card.
  func show(_ id: String) {
    guard let index = cards.firstIndex(where: { $0.id == id }), index != position else { return }
    position = index
    error = nil
  }

  func read(_ id: String) async {
    guard current?.id == id, !readIDs.contains(id) else { return }
    do {
      try Task.checkCancellation()
      try await feed.markRead(id)
      readIDs.insert(id)
      try resources.refreshForYouSummary()
    } catch is CancellationError {
    } catch { workspace?.requestRefresh(.forYou) }
  }

  func respond(_ card: ForYouCard, reason: ForYouFeedback?) async {
    await perform {
      if feedbackID?.card != card.id || feedbackID?.reason != reason {
        feedbackID = ResponseID(card: card.id, reason: reason)
      }
      guard let id = feedbackID?.id else { return }
      do {
        try await feed.feedback(card, reason: reason, id: id)
      } catch let failure as APIClientError {
        guard failure.statusCode == 409 else { throw failure }
        remove(card)
        notice = Notice(text: String(localized: "This suggestion was already handled."))
        return
      }
      let undo = Undo(card: card, position: position, feedbackID: id)
      notice = Notice(
        text: reason?.confirmation ?? String(localized: "Suggestion dismissed"), undo: undo)
      record(card, detail: reason?.title ?? String(localized: "Dismissed"), undo: undo)
      remove(card)
      feedbackID = nil
    }
  }

  func undo(_ action: Undo) async {
    await perform {
      let restored = try await feed.feedback(
        action.card, reason: nil, id: action.undoID, undoing: action.feedbackID)
      if let index = handled.firstIndex(where: { $0.id == action.card.id }) {
        // A card that came back is no longer settled; one that is gone can not be undone again.
        if restored { handled.remove(at: index) } else { handled[index].undo = nil }
      }
      if restored {
        if let index = cards.firstIndex(where: { $0.id == action.card.id }) {
          position = index
        } else {
          position = min(action.position, cards.count)
          cards.insert(action.card, at: position)
        }
      }
      notice =
        restored ? nil : Notice(text: String(localized: "This suggestion is no longer available."))
      workspace?.requestRefresh(.forYou)
    }
  }

  func resolve(_ card: ForYouCard, event: ForYouAutomation, enable: Bool) async {
    await perform {
      try await feed.resolve(event, cardID: card.id, enable: enable)
      notice = Notice(
        text: enable
          ? String(localized: "Automation enabled") : String(localized: "Event dismissed"))
      record(card, detail: enable ? String(localized: "Enabled") : String(localized: "Dismissed"))
      remove(card)
    }
  }

  /// Reuse send and feedback identities across a lost response, including a failed follow-up consume.
  func choose(_ card: ForYouCard, option: ForYouOption) async -> Bool {
    var openChat = false
    await perform {
      let attempt = try beginSelection(card, optionID: option.id)
      if let id = option.threadId {
        guard let workspace,
          await workspace.openChatLink(.thread(id: id, runID: nil)),
          let composer = workspace.conversation(for: id)?.composer
        else { throw ChatError.composerUnavailable }
        if !attempt.prepared {
          try await composer.prependSuggestion(option.draft)
          selections[card.id]?.prepared = true
        }
        openChat = true
      } else if !attempt.prepared {
        try await send(option.draft, target: nil, attempt: attempt)
        selections[card.id]?.prepared = true
      }
      do {
        try await feed.consume(card, optionID: option.id)
      } catch let failure as APIClientError {
        guard failure.statusCode == 409 else { throw failure }
        // The local draft or sent message is already durable even if another device consumed the card.
      }
      if openChat {
        record(
          card, detail: String(localized: "Draft ready · \(option.label)"),
          threadID: option.threadId)
      } else {
        let threadID = selections[card.id]?.threadID
        notice = Notice(text: String(localized: "Sent to a new chat"), threadID: threadID)
        record(card, detail: String(localized: "Sent · \(option.label)"), threadID: threadID)
      }
      remove(card)
    }
    return openChat && error == nil
  }

  /// Opens the input at once when its chat needs no check: a new chat, or one the list already
  /// holds. False leaves an unknown chat to `openDirection`, which checks it first.
  func openListedDirection(_ card: ForYouCard) -> Bool {
    guard case .suggestion(let suggestion) = card.content, let workspace else { return false }
    let target = suggestion.customOption.threadId
    guard target == nil || workspace.list.threads.contains(where: { $0.id == target }) else {
      return false
    }
    guard !busy, current?.id == card.id, !workspace.isClosed else { return true }
    closeDirection()
    direction = ForYouDirection(
      cardID: card.id, threadID: target, commands: commands, workspace: workspace)
    return true
  }

  func openDirection(_ card: ForYouCard) async {
    guard case .suggestion(let suggestion) = card.content, let workspace else { return }
    await perform {
      let target = try await availableThread(suggestion.customOption.threadId)
      try Task.checkCancellation()
      guard current?.id == card.id, !workspace.isClosed else { return }
      closeDirection()
      direction = ForYouDirection(
        cardID: card.id, threadID: target, commands: commands, workspace: workspace)
    }
  }

  func closeDirection() {
    direction?.close()
    direction = nil
  }

  func sendDirection(_ card: ForYouCard, from editor: ForYouDirection) async {
    guard direction === editor, current?.id == card.id, editor.composer.attachments.isReady,
      editor.composer.canSend, editor.models.canSend, let workspace
    else { return }
    await perform {
      let draft = try card.directionDraft(note: editor.composer.value)
      let attempt = try beginSelection(
        card, optionID: "custom", direction: draft, models: editor.models)
      let target = editor.models.threadID
      let workflows = try await workspace.composerWorkflows.prepareUse(
        in: editor.composer.text,
        document: editor.composer.value.draftUserMessage)
      try Task.checkCancellation()
      editor.models.isSending = true
      defer { editor.models.isSending = false }
      let destination = try await send(draft, target: target, attempt: attempt)
      workspace.composerWorkflows.recordUse(workflows)
      notice = Notice(
        text: destination == target
          ? String(localized: "Sent to the chat") : String(localized: "Sent to a new chat"),
        threadID: destination)
      record(card, detail: String(localized: "Sent"), threadID: destination)
      // Accepting the annotated message consumes the card on the server.
      remove(card)
    }
  }

  func openSource(_ id: String) async {
    guard let sidebar = workspace?.sidebarInteraction, sidebar.path == [.forYou] else { return }
    await perform {
      if await open(id), !Task.isCancelled, sidebar.path == [.forYou] {
        sidebar.path.append(.chat)
      }
    }
  }

  func open(_ id: String) async -> Bool {
    guard let workspace else { return false }
    let opened = await workspace.openChatLink(.thread(id: id, runID: nil))
    if !opened, !Task.isCancelled {
      error = workspace.chatLinkError ?? String(localized: "Couldn’t open this chat.")
      workspace.dismissChatLinkError()
    }
    return opened
  }

  private func beginSelection(
    _ card: ForYouCard, optionID: String, direction: ComposerDraft? = nil,
    models: ChatModelSelectionStore? = nil
  ) throws
    -> Selection
  {
    if let selection = selections[card.id] {
      guard selection.optionID == optionID && selection.direction == direction
      else { throw ForYouUnconfirmedChoice() }
      return selection
    }
    let attempt = Selection(
      cardID: card.id, optionID: optionID, direction: direction,
      model: models.flatMap { $0.models.configuration == nil ? nil : $0.selection },
      effort: models?.requestedEffort, options: models?.connectors.submissionOptions,
      computerAccess: models?.connectors.currentComputerAccess)
    selections[card.id] = attempt
    return attempt
  }

  private func availableThread(_ id: String?) async throws -> String? {
    guard let id else { return nil }
    do {
      try await feed.checkThread(id)
      return id
    } catch APIClientError.http(404, _, _, _) { return nil }
  }

  @discardableResult
  private func send(_ draft: ComposerDraft, target: String?, attempt: Selection) async throws
    -> String
  {
    guard let document = draft.draftUserMessage, document.isSupported, let workspace,
      !workspace.isClosed
    else {
      throw ChatError.composerUnavailable
    }
    var destination = selections[attempt.cardID]?.threadID
    if destination == nil { destination = try await availableThread(target) }
    if destination == nil {
      let thread = try await commands.createThread(
        modelSelection: attempt.model,
        reasoningEffort: attempt.effort, composerOptions: attempt.options,
        clientThreadID: attempt.newThreadID)
      try Task.checkCancellation()
      workspace.list.insertCreated(thread)
      destination = thread.id
    }
    guard let destination else { throw ChatError.composerUnavailable }
    selections[attempt.cardID]?.threadID = destination
    _ = try await commands.send(
      threadID: destination, text: document.text,
      attachments: (draft.draftAttachments ?? []).map(\.attachment),
      document: document, clientEventID: attempt.messageID, chatThreadSortEventID: attempt.sortID,
      modelSelection: attempt.model, reasoningEffort: attempt.effort,
      computerAccess: attempt.computerAccess)
    workspace.requestRefresh(.threadList)
    return destination
  }

  private func record(
    _ card: ForYouCard, detail: String, threadID: String? = nil, undo: Undo? = nil
  ) {
    handled.removeAll { $0.id == card.id }
    handled.append(
      Handled(id: card.id, title: card.title, detail: detail, threadID: threadID, undo: undo))
  }

  private func remove(_ card: ForYouCard) {
    if direction?.cardID == card.id { closeDirection() }
    cards.removeAll { $0.id == card.id }
    position = min(position, max(0, cards.count - 1))
    selections[card.id] = nil
    workspace?.requestRefresh(.forYou)
  }

  private func perform(_ operation: () async throws -> Void) async {
    guard !busy, workspace?.isClosed == false else { return }
    busy = true
    error = nil
    defer { busy = false }
    do {
      try await operation()
    } catch is CancellationError {} catch {
      self.error = error.localizedDescription
    }
  }
}

/// An earlier choice on a card has no confirmed result yet: only choosing it again can tell
/// whether it went through, so nothing else on the card starts until then. The banner says just
/// that, not that chat data is unreadable.
private struct ForYouUnconfirmedChoice: LocalizedError {
  var errorDescription: String? {
    String(localized: "Retry the previous action to confirm its result.")
  }
}

extension ForYouCard {
  fileprivate var title: String {
    switch content {
    case .suggestion(let suggestion): suggestion.title
    case .automation(let event): event.automationName
    case .unsupported: ""
    }
  }
}
