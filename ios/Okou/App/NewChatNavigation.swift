import Observation
import SwiftUI
import UIKit

/// System entry points carry no account data and wait for an authenticated workspace.
@MainActor @Observable
final class NewChatRequests {
  static let shared = NewChatRequests()
  static let shortcutType = "ai.okou.new-chat"
  static let voiceShortcutType = "ai.okou.voice-input"
  private struct Request {
    let id = UUID()
    let startsVoiceInput: Bool
  }
  private var pending: Request?
  var pendingID: UUID? { pending?.id }
  private(set) var openedID: UUID?

  func request(startVoiceInput: Bool = false) {
    pending = Request(startsVoiceInput: startVoiceInput)
  }

  @discardableResult
  func receive(_ shortcut: UIApplicationShortcutItem) -> Bool {
    switch shortcut.type {
    case Self.shortcutType: request()
    case Self.voiceShortcutType: request(startVoiceInput: true)
    default: return false
    }
    return true
  }

  @discardableResult
  func open(in workspace: WorkspaceStore) -> Bool {
    guard let pending,
      workspace.openNewChatFromSystem(startVoiceInput: pending.startsVoiceInput)
    else { return false }
    openedID = pending.id
    consume(pending.id)
    return true
  }

  func consume(_ id: UUID) {
    if pending?.id == id { pending = nil }
  }

  func cancelPendingVoiceInput() {
    if pending?.startsVoiceInput == true { pending = nil }
  }
}

extension EnvironmentValues {
  @Entry var newChatActivation: UUID? = nil
}

struct NewChatNavigation: ViewModifier {
  let workspace: WorkspaceStore
  let isAuthenticated: Bool
  var requests = NewChatRequests.shared
  var didOpen: () -> Void = {}
  @Environment(\.scenePhase) private var scenePhase

  private struct Readiness: Equatable {
    let requestID: UUID?
    let isActive: Bool
    let isAuthenticated: Bool
    let canOpen: Bool
  }

  func body(content: Content) -> some View {
    content
      .environment(\.newChatActivation, requests.openedID)
      .onChange(
        of: Readiness(
          requestID: requests.pendingID, isActive: scenePhase == .active,
          isAuthenticated: isAuthenticated, canOpen: workspace.canOpenNewChatFromSystem),
        initial: true
      ) { _, readiness in
        guard readiness.requestID != nil, readiness.isActive, readiness.isAuthenticated,
          readiness.canOpen
        else { return }
        UIApplication.shared.sendAction(
          #selector(UIResponder.resignFirstResponder), to: nil, from: nil, for: nil)
        if requests.open(in: workspace) { didOpen() }
      }
  }
}

/// SwiftUI's window scene receives both cold-launch and running-app quick actions.
final class NewChatSceneDelegate: NSObject, UIWindowSceneDelegate {
  func sceneDidEnterBackground(_ scene: UIScene) {
    NewChatRequests.shared.cancelPendingVoiceInput()
  }

  func scene(
    _ scene: UIScene, willConnectTo session: UISceneSession,
    options connectionOptions: UIScene.ConnectionOptions
  ) {
    if let shortcut = connectionOptions.shortcutItem {
      NewChatRequests.shared.receive(shortcut)
    }
  }

  func windowScene(
    _ windowScene: UIWindowScene, performActionFor shortcutItem: UIApplicationShortcutItem,
    completionHandler: @escaping (Bool) -> Void
  ) {
    completionHandler(NewChatRequests.shared.receive(shortcutItem))
  }
}
