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
  private struct Selection {
    let cardID: String
    let optionID: String
    let note: String
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
  var directionNotes: [String: String] = [:]
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

  func load() async {
    guard !busy else { return }
    let previous = current?.id
    do {
      let result = try await resources.loadForYou()
      try Task.checkCancellation()
      cards = result
      position = previous.flatMap { id in result.firstIndex { $0.id == id } } ?? 0
      loaded = true
      error = nil
    } catch is CancellationError {
    } catch { self.error = error.localizedDescription }
  }

  func move(_ offset: Int) {
    let next = position + offset
    guard !busy, cards.indices.contains(next) else { return }
    position = next
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
      notice = Notice(
        text: reason == nil
          ? String(localized: "Suggestion dismissed") : String(localized: "Feedback saved"),
        undo: Undo(card: card, position: position, feedbackID: id))
      remove(card)
      feedbackID = nil
    }
  }

  func undo(_ action: Undo) async {
    await perform {
      let restored = try await feed.feedback(
        action.card, reason: nil, id: action.undoID, undoing: action.feedbackID)
      if restored {
        if let index = cards.firstIndex(where: { $0.id == action.card.id }) {
          position = index
        } else {
          position = min(action.position, cards.count)
          cards.insert(action.card, at: position)
        }
      }
      notice = restored ? nil : Notice(text: String(localized: "This suggestion has expired."))
      workspace?.requestRefresh(.forYou)
    }
  }

  func resolve(_ card: ForYouCard, event: ForYouAutomation, enable: Bool) async {
    await perform {
      try await feed.resolve(event, cardID: card.id, enable: enable)
      notice = Notice(
        text: enable
          ? String(localized: "Automation enabled") : String(localized: "Event dismissed"))
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
      if !openChat {
        notice = Notice(
          text: String(localized: "Sent to a new chat"), threadID: selections[card.id]?.threadID)
      }
      remove(card)
    }
    return openChat && error == nil
  }

  func sendDirection(_ card: ForYouCard, note: String) async -> Bool {
    guard case .suggestion(let suggestion) = card.content else { return false }
    await perform {
      let draft = try card.directionDraft(note: note)
      let attempt = try beginSelection(card, optionID: "custom", note: note)
      try await send(draft, target: suggestion.customOption.threadId, attempt: attempt)
      notice = Notice(
        text: String(localized: "Direction sent"), threadID: selections[card.id]?.threadID)
      directionNotes[card.id] = nil
      // Accepting the annotated chat event atomically consumes the custom direction.
      remove(card)
    }
    return error == nil
  }

  func open(_ id: String) async -> Bool {
    guard let workspace else { return false }
    let opened = await workspace.openChatLink(.thread(id: id, runID: nil))
    if !opened { error = workspace.chatLinkError ?? String(localized: "Couldn’t open this chat.") }
    return opened
  }

  private func beginSelection(_ card: ForYouCard, optionID: String, note: String = "") throws
    -> Selection
  {
    if let selection = selections[card.id] {
      guard selection.cardID == card.id && selection.optionID == optionID && selection.note == note
      else {
        throw ChatError.invalidContract(
          String(localized: "Retry the previous action to confirm its result."))
      }
      return selection
    }
    let attempt = Selection(cardID: card.id, optionID: optionID, note: note)
    selections[card.id] = attempt
    return attempt
  }

  private func send(_ draft: ComposerDraft, target: String?, attempt: Selection) async throws {
    guard let document = draft.draftUserMessage, document.isSupported, let workspace,
      !workspace.isClosed
    else {
      throw ChatError.composerUnavailable
    }
    var destination = selections[attempt.cardID]?.threadID ?? target
    if let target, selections[attempt.cardID]?.threadID == nil {
      do {
        try await feed.checkThread(target)
      } catch APIClientError.http(404, _, _, _) {
        destination = nil
      }
    }
    if destination == nil {
      let thread = try await commands.createThread(clientThreadID: attempt.newThreadID)
      try Task.checkCancellation()
      workspace.list.insertCreated(thread)
      destination = thread.id
    }
    guard let destination else { throw ChatError.composerUnavailable }
    selections[attempt.cardID]?.threadID = destination
    _ = try await commands.send(
      threadID: destination, text: document.text,
      attachments: (draft.draftAttachments ?? []).map(\.attachment),
      document: document, clientEventID: attempt.messageID, chatThreadSortEventID: attempt.sortID)
    workspace.requestRefresh(.threadList)
  }

  private func remove(_ card: ForYouCard) {
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
