import Observation
import SwiftUI
import UIKit

/// System entry points carry no account data and wait for an authenticated workspace.
@MainActor @Observable
final class NewChatRequests {
  static let shared = NewChatRequests()
  static let shortcutType = "ai.okou.new-chat"
  private(set) var pendingID: UUID?
  private(set) var openedID: UUID?

  func request() { pendingID = UUID() }

  @discardableResult
  func receive(_ shortcut: UIApplicationShortcutItem) -> Bool {
    guard shortcut.type == Self.shortcutType else { return false }
    request()
    return true
  }

  @discardableResult
  func open(in workspace: WorkspaceStore) -> Bool {
    guard let pendingID, workspace.openNewChatFromSystem() else { return false }
    openedID = pendingID
    consume(pendingID)
    return true
  }

  func consume(_ id: UUID) {
    if pendingID == id { pendingID = nil }
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
