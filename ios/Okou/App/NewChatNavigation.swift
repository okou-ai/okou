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
  // Consumption retires pending work without changing the UI task's identity.
  private(set) var requestedID: UUID?
  private(set) var openedID: UUID?

  func request(startVoiceInput: Bool = false) {
    let request = Request(startsVoiceInput: startVoiceInput)
    pending = request
    requestedID = request.id
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
      .task(
        id: Readiness(
          requestID: requests.requestedID, isActive: scenePhase == .active,
          isAuthenticated: isAuthenticated, canOpen: workspace.canOpenNewChatFromSystem)
      ) {
        // Retire requests outside SwiftUI's update so a second system entry can
        // replace voice startup without exhausting onChange's per-frame limit.
        guard !Task.isCancelled, requests.pendingID != nil, scenePhase == .active,
          isAuthenticated, workspace.canOpenNewChatFromSystem
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
