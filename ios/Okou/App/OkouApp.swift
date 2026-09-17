import SwiftUI

@main
struct OkouApp: App {
  @State private var authentication: AuthenticationService?
  private let configuration = Result { try AppConfiguration() }

  init() {
    // The XCTest host runs real services with isolated HTTP fixtures, never production auth.
    let isTestHost = NSClassFromString("XCTestCase") != nil
    _authentication = State(initialValue: isTestHost ? nil : AuthenticationService())
  }

  var body: some Scene {
    WindowGroup {
      Group {
        if let authentication {
          switch configuration {
          case .success(let configuration):
            AppRootView(authentication: authentication, configuration: configuration)
          case .failure(let error):
            ContentUnavailableView(
              "Unable to start Okou", systemImage: "exclamationmark.triangle",
              description: Text(error.localizedDescription))
          }
        } else {
          Color.clear
        }
      }
      .tint(Color.primary)
      .environment(\.locale, Locale(identifier: "en"))
      .task { await authentication?.start() }
      .onOpenURL { url in Task { await authentication?.handleURL(url) } }
    }
  }
}

private struct AppRootView: View {
  let authentication: AuthenticationService
  let configuration: AppConfiguration
  @State private var accountError: String?
  @Environment(\.scenePhase) private var scenePhase

  var body: some View {
    Group {
      if authentication.isLoading || authentication.isSwitchingWorkspace {
        ProgressView("Loading Okou…")
      } else if let scopeID = authentication.scopeID,
        let workspaceID = authentication.activeWorkspaceID,
        let userID = authentication.userID
      {
        WorkspaceRootView(
          authentication: authentication, configuration: configuration,
          workspaceID: workspaceID, userID: userID, scopeID: scopeID,
          accountError: $accountError
        )
        .id(scopeID)
      } else {
        SignInView(authentication: authentication, webURL: configuration.webURL)
      }
    }
    .onChange(of: scenePhase) { _, phase in
      if phase == .active { Task { await authentication.refresh() } }
    }
    .alert(
      "Unable to update account",
      isPresented: Binding(
        get: { accountError != nil }, set: { if !$0 { accountError = nil } }
      )
    ) {
      Button("OK") { accountError = nil }
    } message: {
      Text(accountError ?? "")
    }
  }
}

private struct WorkspaceRootView: View {
  let authentication: AuthenticationService
  let workspaceID: String
  let userID: String
  @State private var store: WorkspaceStore
  @Binding private var accountError: String?
  @Environment(\.scenePhase) private var scenePhase

  init(
    authentication: AuthenticationService, configuration: AppConfiguration,
    workspaceID: String, userID: String, scopeID: String,
    accountError: Binding<String?>
  ) {
    self.authentication = authentication
    self.workspaceID = workspaceID
    self.userID = userID
    _accountError = accountError
    let client = APIClient(baseURL: configuration.apiURL) {
      try await authentication.accessToken(workspaceID: workspaceID, scopeID: scopeID)
    }
    _store = State(initialValue: WorkspaceStore(client: client, webURL: configuration.webURL))
  }

  var body: some View {
    NavigationStack(path: $store.path) {
      ChatListView(store: store)
        .toolbar {
          ToolbarItem(placement: .topBarLeading) { accountMenu }
        }
        .navigationDestination(for: String.self) { id in
          if let thread = store.threads.first(where: { $0.id == id }) {
            ChatDetailView(store: store, thread: thread)
          } else {
            ContentUnavailableView(
              "Conversation unavailable", systemImage: "bubble.left",
              description: Text("It may have been removed or is no longer accessible."))
          }
        }
    }
    .task {
      store.setForeground(scenePhase == .active)
      await store.start(userID: userID, workspaceID: workspaceID)
    }
    .onDisappear { store.close() }
    .onChange(of: scenePhase) { _, phase in
      store.setForeground(phase == .active)
      if phase == .active { store.requestRefresh() }
    }
    .fullScreenCover(isPresented: Binding(get: { store.needsUpgrade }, set: { _ in })) {
      ContentUnavailableView {
        Label("Update required", systemImage: "arrow.down.app")
      } description: {
        Text(
          "This build no longer supports the current API. Install the latest Okou build to continue."
        )
      } actions: {
        Link("Open TestFlight", destination: URL(string: "itms-beta://")!)
      }
      .interactiveDismissDisabled()
    }
  }

  private var accountMenu: some View {
    Menu {
      Section("Workspace") {
        ForEach(authentication.workspaces) { workspace in
          Button {
            Task {
              do { try await authentication.switchWorkspace(workspace.id) } catch {
                accountError = error.localizedDescription
              }
            }
          } label: {
            if workspace.id == workspaceID {
              Label(workspace.name, systemImage: "checkmark")
            } else {
              Text(workspace.name)
            }
          }
        }
      }
      Button("Sign out", systemImage: "rectangle.portrait.and.arrow.right", role: .destructive) {
        Task {
          do { try await authentication.signOut() } catch {
            accountError = error.localizedDescription
          }
        }
      }
    } label: {
      Image(systemName: "person.crop.circle")
    }
    .accessibilityLabel("Workspace and account")
  }
}
