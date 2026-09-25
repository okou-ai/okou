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
  @State private var isSidebarOpen = false
  @Binding private var accountError: String?
  @Environment(\.scenePhase) private var scenePhase
  @Environment(\.accessibilityReduceMotion) private var reduceMotion

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
    GeometryReader { geometry in
      let sidebarWidth = min(300, geometry.size.width - 56)
      let topInset = geometry.safeAreaInsets.top
      let screenHeight = geometry.size.height + topInset + geometry.safeAreaInsets.bottom
      ZStack(alignment: .leading) {
        Color(uiColor: .systemBackground).ignoresSafeArea()

        ChatSidebarView(
          store: store, authentication: authentication, workspaceID: workspaceID,
          accountError: $accountError,
          close: closeSidebar,
          newChat: startNewChat
        )
        .frame(width: sidebarWidth, height: geometry.size.height)
        .opacity(isSidebarOpen ? 1 : 0)
        .allowsHitTesting(isSidebarOpen)
        .accessibilityHidden(!isSidebarOpen)

        VStack(spacing: 0) {
          mainHeader
          Group {
            if let id = store.selectedThreadID,
              let thread = store.threads.first(where: { $0.id == id })
            {
              ChatDetailView(store: store, thread: thread)
                .id(thread.id)
            } else {
              newChatHome
                .safeAreaInset(edge: .bottom, spacing: 0) {
                  ChatComposerView(store: store, thread: nil)
                }
            }
          }
          .frame(maxWidth: .infinity, maxHeight: .infinity)
        }
        .frame(width: geometry.size.width, height: geometry.size.height)
        .background(alignment: .top) {
          RoundedRectangle(cornerRadius: isSidebarOpen ? 30 : 0)
            .fill(Color(uiColor: isSidebarOpen ? .secondarySystemBackground : .systemBackground))
            .frame(width: geometry.size.width, height: screenHeight)
            .offset(y: -topInset)
        }
        .overlay(alignment: .top) {
          if isSidebarOpen {
            Color(uiColor: .secondarySystemBackground).opacity(0.82)
              .frame(width: geometry.size.width, height: screenHeight)
              .clipShape(RoundedRectangle(cornerRadius: 30))
              .offset(y: -topInset)
              .onTapGesture(perform: closeSidebar)
              .accessibilityLabel("Close sidebar")
              .accessibilityAddTraits(.isButton)
          }
        }
        .shadow(color: .black.opacity(isSidebarOpen ? 0.3 : 0), radius: 18, x: -5)
        .offset(x: isSidebarOpen ? sidebarWidth : 0)
        .accessibilityHidden(isSidebarOpen)
      }
      .frame(width: geometry.size.width, height: geometry.size.height, alignment: .leading)
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

  private var mainHeader: some View {
    ZStack {
      Text(
        store.threads.first(where: { $0.id == store.selectedThreadID })?.displayTitle
          ?? store.currentAgentName
      )
      .font(.system(size: 17, weight: .semibold))
      .lineLimit(1)
      .padding(.horizontal, 66)
      HStack {
        Button(action: openSidebar) {
          Image(systemName: "line.3.horizontal")
            .font(.system(size: 19, weight: .medium))
            .frame(width: 32, height: 32)
        }
        .buttonStyle(.glass)
        .accessibilityLabel("Open sidebar")
        .accessibilityIdentifier("open-sidebar")
        Spacer()
        Button(action: { startNewChat() }) {
          Image(systemName: "square.and.pencil")
            .font(.system(size: 19, weight: .medium))
            .frame(width: 32, height: 32)
        }
        .buttonStyle(.glass)
        .accessibilityLabel("New chat")
        .disabled(store.isCreating || store.needsUpgrade)
      }
    }
    .buttonStyle(.plain)
    .padding(.horizontal, 16)
    .frame(height: 60)
    .background(Color(uiColor: .systemBackground))
  }

  private var newChatHome: some View {
    VStack {
      Spacer(minLength: 24)
      HStack(spacing: 16) {
        if let agent = store.agents.first(where: { $0.agentId == store.selectedAgentID }),
          !agent.isDefaultAgent
        {
          Text(String((agent.displayName ?? "A").prefix(1)))
            .font(.system(size: 28, weight: .medium))
            .frame(width: 56, height: 56)
            .background(
              Color(uiColor: .secondarySystemBackground), in: RoundedRectangle(cornerRadius: 14))
        } else {
          Image("AssistantAvatar")
            .resizable()
            .scaledToFit()
            .frame(width: 56, height: 56)
            .background(
              Color(uiColor: .secondarySystemBackground), in: RoundedRectangle(cornerRadius: 14))
        }
        Text(greetingText)
          .font(.system(size: 24, weight: .semibold))
          .fixedSize(horizontal: false, vertical: true)
      }
      .frame(maxWidth: .infinity)
      .padding(.horizontal, 24)
      .accessibilityElement(children: .combine)
      Spacer(minLength: 24)
    }
  }

  private var greetingText: String {
    let name = authentication.firstName?.trimmingCharacters(in: .whitespacesAndNewlines)
    let chinese = Locale.preferredLanguages.first?.hasPrefix("zh") == true
    if let name, !name.isEmpty {
      return chinese ? "今天我们做点什么，\(name)？" : "What are we working on, \(name)?"
    }
    return chinese ? "今天我们做点什么？" : "What are we working on?"
  }

  private func openSidebar() {
    UIApplication.shared.sendAction(
      #selector(UIResponder.resignFirstResponder), to: nil, from: nil, for: nil)
    withAnimation(reduceMotion ? nil : .spring(response: 0.34, dampingFraction: 0.88)) {
      isSidebarOpen = true
    }
    Task { await store.refreshNavigation() }
  }

  private func closeSidebar() {
    withAnimation(reduceMotion ? nil : .spring(response: 0.34, dampingFraction: 0.88)) {
      isSidebarOpen = false
    }
  }

  private func startNewChat(_ agentID: String? = nil) {
    UIApplication.shared.sendAction(
      #selector(UIResponder.resignFirstResponder), to: nil, from: nil, for: nil)
    store.startNewChat(agentID: agentID)
    closeSidebar()
  }
}
