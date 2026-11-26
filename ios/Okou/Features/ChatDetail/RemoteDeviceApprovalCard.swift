import CCState
import CCStateSwiftUI
import ChatData
import ChatDomain
import SwiftUI

@MainActor
final class RemoteDeviceApprovalStore {
  enum Outcome: Equatable { case requested, cancelled, allowed, continued }

  struct Presentation: Equatable {
    var outcome: Outcome = .requested
    var working = false
    var failed = false
  }

  let action: ChatRemoteDeviceApprovalAction
  let resources: RemoteDeviceResources
  let presentation: Computed<Presentation>
  private let graph: CCState.Store
  private let thread: ChatThread
  private let commands: ChatCommands
  private let didContinue: @MainActor () async -> Void
  private let didFail: @MainActor (Error) -> Void
  private let state = CCState.State(Presentation())
  private var task: Task<Void, Never>?
  private var active = false

  init(
    action: ChatRemoteDeviceApprovalAction, resources: RemoteDeviceResources,
    graph: CCState.Store, thread: ChatThread, commands: ChatCommands,
    didContinue: @escaping @MainActor () async -> Void,
    didFail: @escaping @MainActor (Error) -> Void
  ) {
    self.action = action
    self.resources = resources
    self.graph = graph
    self.thread = thread
    self.commands = commands
    self.didContinue = didContinue
    self.didFail = didFail
    let state = state
    presentation = Computed { try $0(state) }
  }

  func activate() { active = true }

  func deactivate() {
    active = false
    task?.cancel()
  }

  func cancel() {
    guard active, task == nil, (try? graph.get(state).outcome) == .requested else { return }
    update { $0.outcome = .cancelled }
  }

  func confirm() async {
    guard active, task == nil, (try? graph.get(resources.enabled)) == true else { return }
    let task = Task { @MainActor [weak self] in
      guard let self else { return }
      await performConfirmation()
    }
    self.task = task
    await task.value
    self.task = nil
  }

  private func performConfirmation() async {
    update {
      $0.working = true
      $0.failed = false
    }
    defer { update { $0.working = false } }
    do {
      let outcome = try graph.get(state).outcome
      if outcome == .requested {
        try await resources.approve(action)
        update { $0.outcome = .allowed }
      } else if outcome != .allowed {
        return
      }
      try Task.checkCancellation()
      if let prompt = action.callbackPrompt {
        _ = try await commands.send(
          thread: thread, text: prompt, clientEventID: action.id.uuidString.lowercased())
        update { $0.outcome = .continued }
      }
      await didContinue()
    } catch {
      if !Task.isCancelled {
        update { $0.failed = true }
        didFail(error)
      }
    }
  }

  private func update(_ change: (inout Presentation) -> Void) {
    do {
      try graph.set(
        state,
        update: { current in
          var next = current
          change(&next)
          return next
        })
    } catch { didFail(error) }
  }
}

struct RemoteDeviceApprovalCard: View {
  let store: RemoteDeviceApprovalStore
  let loadsState: Bool
  @ResolvedValue private var enabled: Bool?

  init(store: RemoteDeviceApprovalStore, loadsState: Bool) {
    self.store = store
    self.loadsState = loadsState
    _enabled = ResolvedValue(store.resources.enabled)
  }

  var body: some View {
    if loadsState && enabled == true {
      RemoteDeviceApprovalCardContent(store: store)
    } else {
      ChatActionCard {
        ChatCardHeader(title: String(localized: "Remote device access"), icon: "monitor") {
          Text(verbatim: store.action.reason)
        }
      } actions: {
        if loadsState { Text("This device is unavailable.") }
      }
    }
  }
}

private struct RemoteDeviceApprovalCardContent: View {
  let store: RemoteDeviceApprovalStore
  @LoadableValue private var directory: Loadable<[ChatRemoteDevice]>
  @ResolvedValue private var presentation: RemoteDeviceApprovalStore.Presentation?

  init(store: RemoteDeviceApprovalStore) {
    self.store = store
    _directory = LoadableValue(task: store.resources.directory, keepLast: true)
    _presentation = ResolvedValue(store.presentation)
  }

  var body: some View {
    let value = presentation ?? .init()
    if value.outcome != .cancelled {
      card(value, device: device)
    }
  }

  private func card(_ value: RemoteDeviceApprovalStore.Presentation, device: ChatRemoteDevice?)
    -> some View
  {
    ChatActionCard {
      ChatCardHeader(title: title(device), icon: "monitor") {
        Text(verbatim: store.action.reason)
        if device != nil && value.outcome == .requested {
          Text("Access covers all channels on this device across your chats.")
        }
        if value.failed {
          Text(
            value.outcome == .allowed
              ? String(localized: "Device access was granted. The task could not continue.")
              : String(localized: "Could not save the device change.")
          )
          .foregroundStyle(OkouColor.destructive)
        }
      }
    } actions: {
      switch value.outcome {
      case .requested:
        if device != nil {
          decisionButtons(working: value.working)
        } else if case .loading = directory {
          OkouLoadingRow("Loading request…")
        } else {
          Text("This device is unavailable.")
        }
      case .cancelled: EmptyView()
      case .allowed, .continued:
        Text("Device access granted")
        if value.outcome == .allowed && store.action.callbackPrompt != nil {
          Button("Continue task") { Task { await store.confirm() } }
            .buttonStyle(ChatCardButtonStyle(emphasis: .primary))
            .disabled(value.working)
        }
      }
    }
  }

  private var device: ChatRemoteDevice? {
    guard case .hasData(let devices) = directory else { return nil }
    return devices.first { $0.id == store.action.deviceID }
  }

  private func title(_ device: ChatRemoteDevice?) -> String {
    if let device { return String(localized: "Allow access to \(device.displayName)?") }
    return String(localized: "Remote device access")
  }

  private func decisionButtons(working: Bool) -> some View {
    ViewThatFits(in: .horizontal) {
      HStack(spacing: OkouSpace.sm) { buttons(working: working) }.fixedSize()
      VStack(spacing: OkouSpace.sm) { buttons(working: working) }
    }
  }

  @ViewBuilder private func buttons(working: Bool) -> some View {
    Button("Cancel", action: store.cancel)
      .buttonStyle(ChatCardButtonStyle(emphasis: .detail)).disabled(working)
    Button("Allow for 1 hour") { Task { await store.confirm() } }
      .buttonStyle(ChatCardButtonStyle(emphasis: .primary)).disabled(working)
  }
}
