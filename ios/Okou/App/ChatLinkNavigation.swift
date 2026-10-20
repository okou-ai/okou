import Foundation
import SwiftUI

/// Only routes owned by the configured web origin can change workspace navigation.
enum ChatLinkDestination: Equatable {
  case thread(id: String, runID: String?)
  case workflow(id: String)

  init?(url: URL, webURL: URL) {
    guard let url = URLComponents(url: url, resolvingAgainstBaseURL: true),
      let web = URLComponents(url: webURL, resolvingAgainstBaseURL: true),
      ["https", "http"].contains(url.scheme?.lowercased() ?? ""),
      url.scheme?.lowercased() == web.scheme?.lowercased(),
      url.host?.lowercased() == web.host?.lowercased(),
      (url.port ?? (url.scheme == "https" ? 443 : 80))
        == (web.port ?? (web.scheme == "https" ? 443 : 80)),
      url.user == nil, url.password == nil, url.query == nil
    else { return nil }
    let path = url.path.split(separator: "/").map(String.init)
    if path.count == 2, path[0] == "chats", UUID(uuidString: path[1]) != nil {
      var runID: String?
      if let fragment = url.fragment, !fragment.isEmpty {
        guard fragment.hasPrefix("run-"),
          UUID(uuidString: String(fragment.dropFirst(4))) != nil
        else { return nil }
        runID = String(fragment.dropFirst(4)).lowercased()
      }
      self = .thread(id: path[1].lowercased(), runID: runID)
    } else {
      return nil
    }
  }
}

extension EnvironmentValues {
  @Entry var openChatSource: (@MainActor (ChatLinkDestination) -> Void)? = nil
}

struct ChatLinkNavigation: ViewModifier {
  let store: WorkspaceStore
  var didOpen: () -> Void = {}
  @State private var request: Request?

  private struct Request: Equatable {
    let id = UUID()
    let destination: ChatLinkDestination
  }

  func body(content: Content) -> some View {
    content
      .environment(\.openChatSource) { destination in
        request = Request(destination: destination)
      }
      .environment(
        \.openURL,
        OpenURLAction { url in
          guard let destination = ChatLinkDestination(url: url, webURL: store.webURL) else {
            return .systemAction(url)
          }
          request = Request(destination: destination)
          return .handled
        }
      )
      .task(id: request) {
        if let request, await store.openChatLink(request.destination) { didOpen() }
      }
      .alert(
        "Unable to open chat",
        isPresented: Binding(
          get: { store.chatLinkError != nil },
          set: { if !$0 { store.dismissChatLinkError() } })
      ) {
        Button("OK") { store.dismissChatLinkError() }
      } message: {
        Text(store.chatLinkError ?? "")
      }
  }
}
