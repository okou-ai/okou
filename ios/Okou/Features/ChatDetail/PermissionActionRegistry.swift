import CCState
import ChatData
import ChatDomain
import Foundation

/// Stable permission resources live with their conversation, independently of reused rows and sheets.
@MainActor
final class PermissionActionRegistry {
  private let commands: ChatCommands
  private let sync: ChatSync
  private let didFail: @MainActor (Error) -> Void
  private let didContinue: @MainActor () async -> Void
  let resources: PermissionCardResources
  private let graph: CCState.Store
  // These owners retain duration, confirmed review and exact mutation/continuation identities.
  // They are a business ledger until conversation close, not the disposable read cache.
  private var cards: [ChatPermissionAction: PermissionActionStore] = [:]
  private var batches: [ChatPermissionBatchAction: PermissionBatchStore] = [:]
  private var owner: UUID?
  private var closed = false

  init(
    commands: ChatCommands, sync: ChatSync, graph: CCState.Store,
    didFail: @escaping @MainActor (Error) -> Void,
    didContinue: @escaping @MainActor () async -> Void
  ) {
    self.commands = commands
    self.graph = graph
    resources = PermissionCardResources(commands: commands, graph: graph, didFail: didFail)
    self.sync = sync
    self.didFail = didFail
    self.didContinue = didContinue
  }

  var isBusy: Bool {
    cards.values.contains { $0.isBusy } || batches.values.contains { $0.isSaving }
  }

  var member: WorkspaceMemberID? { commands.approvalClient.member }

  func card(_ action: ChatPermissionBatchAction) -> PermissionBatchStore {
    if let existing = batches[action] { return existing }
    let card = PermissionBatchStore(
      action: action, resources: resources, commands: commands, sync: sync, graph: graph,
      didFail: didFail, didContinue: didContinue)
    if closed {
      card.close()
    } else if owner != nil {
      card.activate()
    }
    batches[action] = card
    return card
  }

  func card(_ action: ChatPermissionAction) -> PermissionActionStore {
    if let existing = cards[action] { return existing }
    let card = PermissionActionStore(
      action: action, resources: resources, commands: commands, sync: sync,
      didFail: didFail, didContinue: didContinue)
    if closed {
      card.close()
    } else if owner != nil {
      card.activate()
    }
    cards[action] = card
    return card
  }

  func activate(owner: UUID) {
    guard !closed, self.owner != owner else { return }
    if self.owner != nil { deactivate() }
    self.owner = owner
    resources.activate()
    for card in cards.values { card.activate() }
    for card in batches.values { card.activate() }
  }

  func deactivate() {
    owner = nil
    resources.deactivate()
    for card in cards.values { card.deactivate() }
    for card in batches.values { card.deactivate() }
  }
  func close() {
    closed = true
    resources.close()
    for card in cards.values { card.close() }
    for card in batches.values { card.close() }
  }
}
