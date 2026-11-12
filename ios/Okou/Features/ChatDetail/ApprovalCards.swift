import ChatData
import ChatDomain
import Foundation

/// Owns the native approval cards of one conversation, keyed by the request they show, so a
/// recycled transcript row finds its loaded state instead of fetching it again.
@MainActor
final class ApprovalCardRegistry {
  private let client: APIClient
  private let didContinue: @MainActor () async -> Void
  private final class WeakMailDraft {
    weak var value: MailDraftCardStore?
    init(_ value: MailDraftCardStore) { self.value = value }
  }

  // Advisory read retention. Mounted/pending owners survive eviction through weak lookup;
  // explicit mail operations keep their business identity until conversation close.
  private let mailDrafts: NSCache<NSString, MailDraftCardStore> = {
    let cache = NSCache<NSString, MailDraftCardStore>()
    cache.countLimit = 64
    return cache
  }()
  private var liveMailDrafts: [String: WeakMailDraft] = [:]
  private var mailOperations: [String: MailDraftCardStore] = [:]
  private let thread: ChatThread
  private let commands: ChatCommands
  private let sync: ChatSync
  private let didFail: @MainActor (Error) -> Void
  private final class ComputerKey: NSObject {
    let action: ChatComputerAuthorizationAction
    init(_ action: ChatComputerAuthorizationAction) { self.action = action }
    override var hash: Int { action.hashValue }
    override func isEqual(_ object: Any?) -> Bool { (object as? ComputerKey)?.action == action }
  }

  private final class WeakComputer {
    weak var value: ComputerAuthorizationStore?
    init(_ value: ComputerAuthorizationStore) { self.value = value }
  }

  // Preserve the full descriptor's callback intent and case-sensitive tokens. Read retention
  // is advisory; native selections and explicit grant/continuation attempts survive until close.
  private let computers: NSCache<ComputerKey, ComputerAuthorizationStore> = {
    let cache = NSCache<ComputerKey, ComputerAuthorizationStore>()
    cache.countLimit = 64
    return cache
  }()
  private var liveComputers: [ChatComputerAuthorizationAction: WeakComputer] = [:]
  private var computerInteractions: [ChatComputerAuthorizationAction: ComputerAuthorizationStore] =
    [:]
  private var active = false
  private var closed = false

  init(
    thread: ChatThread, commands: ChatCommands, sync: ChatSync,
    didFail: @escaping @MainActor (Error) -> Void,
    didContinue: @escaping @MainActor () async -> Void
  ) {
    self.thread = thread
    self.commands = commands
    self.sync = sync
    self.didFail = didFail
    self.client = commands.approvalClient
    self.didContinue = didContinue
  }

  func mailDraft(_ id: String) -> MailDraftCardStore {
    let id = id.lowercased()
    if let store = mailOperations[id] ?? mailDrafts.object(forKey: id as NSString)
      ?? liveMailDrafts[id]?.value
    {
      return store
    }
    liveMailDrafts = liveMailDrafts.filter { $0.value.value != nil }
    let store = MailDraftCardStore(
      id: id, client: client, didFail: didFail,
      didBeginMutation: { [weak self] card in self?.mailOperations[id] = card })
    if closed {
      store.close()
    } else {
      liveMailDrafts[id] = WeakMailDraft(store)
      mailDrafts.setObject(store, forKey: id as NSString)
      if active { store.activate() }
    }
    return store
  }

  func computer(_ action: ChatComputerAuthorizationAction) -> ComputerAuthorizationStore {
    let key = ComputerKey(action)
    if let existing = computerInteractions[action] ?? computers.object(forKey: key)
      ?? liveComputers[action]?.value
    {
      return existing
    }
    liveComputers = liveComputers.filter { $0.value.value != nil }
    let store = ComputerAuthorizationStore(
      action: action, thread: thread, commands: commands, sync: sync,
      didFail: didFail, didContinue: didContinue,
      didRetainInteraction: { [weak self] card in self?.computerInteractions[action] = card })
    if closed {
      store.close()
    } else {
      liveComputers[action] = WeakComputer(store)
      computers.setObject(store, forKey: key)
      if active { store.activate() }
    }
    return store
  }

  func activate() {
    guard !closed else { return }
    active = true
    liveMailDrafts = liveMailDrafts.filter { $0.value.value != nil }
    for card in liveMailDrafts.values.compactMap(\.value) { card.activate() }
    liveComputers = liveComputers.filter { $0.value.value != nil }
    for card in liveComputers.values.compactMap(\.value) { card.activate() }
  }

  func deactivate() {
    active = false
    liveMailDrafts = liveMailDrafts.filter { $0.value.value != nil }
    for card in liveMailDrafts.values.compactMap(\.value) { card.deactivate() }
    liveComputers = liveComputers.filter { $0.value.value != nil }
    for card in liveComputers.values.compactMap(\.value) { card.deactivate() }
  }

  func refreshComputers() async {
    guard !closed else { return }
    liveComputers = liveComputers.filter { $0.value.value != nil }
    for card in liveComputers.values.compactMap(\.value) { await card.refresh() }
  }

  func close() {
    closed = true
    active = false
    for card in liveMailDrafts.values.compactMap(\.value) { card.close() }
    mailDrafts.removeAllObjects()
    liveMailDrafts = [:]
    mailOperations = [:]
    for card in liveComputers.values.compactMap(\.value) { card.close() }
    computers.removeAllObjects()
    liveComputers = [:]
    computerInteractions = [:]
  }

}
