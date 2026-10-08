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
  @State private var sidebarDrag: CGFloat?
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
    _store = State(
      initialValue: WorkspaceStore(
        client: client, webURL: configuration.webURL,
        cache: ChatCache(
          scope: ChatCacheScope(
            apiBaseURL: configuration.apiURL,
            userID: userID, workspaceID: workspaceID))))
  }

  var body: some View {
    GeometryReader { geometry in
      let sidebarWidth = min(300, geometry.size.width - 56)
      let topInset = geometry.safeAreaInsets.top
      let screenHeight = geometry.size.height + topInset + geometry.safeAreaInsets.bottom
      let sidebarOffset = min(
        max((isSidebarOpen ? sidebarWidth : 0) + (sidebarDrag ?? 0), 0), sidebarWidth)
      let sidebarProgress = sidebarOffset / sidebarWidth
      let panelCornerRadius = 30 * sidebarProgress
      ZStack(alignment: .leading) {
        Color(uiColor: .systemBackground).ignoresSafeArea()

        ChatSidebarView(
          store: store, authentication: authentication, workspaceID: workspaceID,
          accountError: $accountError,
          close: closeSidebar,
          newChat: startNewChat
        )
        .frame(width: sidebarWidth, height: geometry.size.height)
        .allowsHitTesting(isSidebarOpen)
        .accessibilityHidden(!isSidebarOpen)

        VStack(spacing: 0) {
          mainHeader
          Group {
            if let conversation = store.selectedConversation {
              ChatDetailView(conversation: conversation)
                .id(conversation.thread.id)
            } else {
              newChatHome
                .safeAreaInset(edge: .bottom, spacing: 0) {
                  ChatComposerView(
                    draft: $store.newChatDraft, isBusy: store.isCreating,
                    showsProgress: store.isCreating, canStop: false,
                    needsUpgrade: store.needsUpgrade,
                    error: store.error ?? store.list.error, attachmentURL: store.webURL,
                    submit: { await store.sendNewChat() }, refresh: nil)
                }
            }
          }
          .frame(maxWidth: .infinity, maxHeight: .infinity)
        }
        .frame(width: geometry.size.width, height: geometry.size.height)
        .background(alignment: .top) {
          RoundedRectangle(cornerRadius: panelCornerRadius, style: .continuous)
            .fill(Color(uiColor: .systemBackground))
            .frame(width: geometry.size.width, height: screenHeight)
            .offset(y: -topInset)
        }
        .overlay(alignment: .top) {
          Color(uiColor: .secondarySystemBackground)
            .frame(width: geometry.size.width, height: screenHeight)
            .clipShape(RoundedRectangle(cornerRadius: panelCornerRadius, style: .continuous))
            .opacity(0.82 * sidebarProgress)
            .offset(y: -topInset)
            .allowsHitTesting(isSidebarOpen)
            .onTapGesture(perform: closeSidebar)
            .accessibilityLabel("Close sidebar")
            .accessibilityAddTraits(.isButton)
            .accessibilityHidden(!isSidebarOpen)
        }
        .mask(alignment: .top) {
          RoundedRectangle(cornerRadius: panelCornerRadius, style: .continuous)
            .frame(width: geometry.size.width, height: screenHeight)
            .offset(y: -topInset)
        }
        .compositingGroup()
        .shadow(color: .black.opacity(0.3 * sidebarProgress), radius: 18, x: -5)
        .offset(x: sidebarOffset)
        .accessibilityHidden(isSidebarOpen)
      }
      .frame(width: geometry.size.width, height: geometry.size.height, alignment: .leading)
      .gesture(
        SidebarPanGesture(
          isOpen: isSidebarOpen, sidebarWidth: sidebarWidth,
          changed: { translation in
            if sidebarDrag == nil {
              UIApplication.shared.sendAction(
                #selector(UIResponder.resignFirstResponder), to: nil, from: nil, for: nil)
            }
            sidebarDrag = translation
          },
          ended: { translation, velocity, cancelled in
            let wasOpen = isSidebarOpen
            let opens = SidebarGesturePolicy.settlesOpen(
              wasOpen: wasOpen, sidebarWidth: sidebarWidth, translation: translation,
              velocity: velocity, cancelled: cancelled)
            withAnimation(reduceMotion ? nil : .spring(response: 0.34, dampingFraction: 0.88)) {
              isSidebarOpen = opens
              sidebarDrag = nil
            }
            if opens && !wasOpen { Task { await store.refreshNavigation() } }
          })
      )
    }
    .task {
      store.setForeground(scenePhase == .active)
      await store.start(userID: userID, workspaceID: workspaceID)
    }
    .onDisappear { store.close() }
    .onReceive(
      NotificationCenter.default.publisher(for: UIApplication.didReceiveMemoryWarningNotification)
    ) { _ in
      Task { await store.reduceMemory() }
    }
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
        store.list.threads.first(where: { $0.id == store.selectedThreadID })?.displayTitle
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
        .buttonBorderShape(.circle)
        .accessibilityLabel("Open sidebar")
        .accessibilityIdentifier("open-sidebar")
        Spacer()
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
        if let agent = store.list.agents.first(where: { $0.agentId == store.selectedAgentID }),
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
      sidebarDrag = nil
    }
    Task { await store.refreshNavigation() }
  }

  private func closeSidebar() {
    withAnimation(reduceMotion ? nil : .spring(response: 0.34, dampingFraction: 0.88)) {
      isSidebarOpen = false
      sidebarDrag = nil
    }
  }

  private func startNewChat(_ agentID: String? = nil) {
    UIApplication.shared.sendAction(
      #selector(UIResponder.resignFirstResponder), to: nil, from: nil, for: nil)
    store.startNewChat(agentID: agentID)
    closeSidebar()
  }
}
