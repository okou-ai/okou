#if DEBUG
  import ChatData
  import SwiftUI
  import UIKit

  /// One-off, offline native acceptance fixture; excluded from the product PR.
  struct NativeComposerAlignmentPreview: View {
    @State private var store: WorkspaceStore
    @State private var composer: ComposerDraftStore
    @State private var sidebar = SidebarInteraction()
    @State private var authentication = AuthenticationService(publishableKey: "")
    @State private var notifications = NotificationService()
    @State private var accountError: String?

    init() {
      let origin = URL(string: "https://composer-preview.invalid")!
      let client = APIClient(baseURL: origin, clientVersion: "0.31.6") {
        throw CancellationError()
      }
      let scope = ChatCacheScope(
        apiBaseURL: origin, userID: "layout-preview", workspaceID: "layout-preview")
      let directory = FileManager.default.temporaryDirectory.appendingPathComponent(
        "composer-layout-\(UUID().uuidString)", isDirectory: true)
      let draft = ComposerDraftStore(
        target: .agent("layout-preview"), commands: ChatCommands(client: client),
        storage: ChatDraftStorage(scope: scope, directory: directory), didFail: { _ in })
      draft.setForeground(true)
      _composer = State(initialValue: draft)
      _store = State(initialValue: WorkspaceStore(client: client, webURL: origin))
    }

    var body: some View {
      GeometryReader { geometry in
        let width = geometry.size.width
        let progress = min(max((sidebar.isOpen ? width : 0) + (sidebar.translation ?? 0), 0), width)
          / width
        let drift = width * OkouMotion.sidebarParallax
        ZStack {
          ChatSidebarView(
            store: store, authentication: authentication, workspaceID: "layout-preview",
            notifications: notifications, sidebar: sidebar, headerHeight: 44,
            accountError: $accountError, close: { setSidebar(false) },
            newChat: { setSidebar(false) })
            .frame(width: width, height: geometry.size.height)
            .blur(radius: OkouElevation.sidebarBlur * (1 - progress))
            .opacity(progress)
            .offset(x: -drift * (1 - progress))
            .allowsHitTesting(sidebar.isOpen)
            .accessibilityHidden(!sidebar.isOpen)

          VStack {
            Spacer()
            OkouAgentAvatar(avatarURL: nil, name: "Okou", isDefault: true, size: 52)
            Text("Composer alignment")
              .font(.okou(.title2).weight(.semibold))
            Text("Offline native component preview")
              .font(.okou(.footnote)).foregroundStyle(OkouColor.mutedForeground)
            Spacer()
          }
          .frame(maxWidth: .infinity, maxHeight: .infinity)
          .safeAreaInset(edge: .bottom, spacing: 0) {
            @Bindable var draft = composer
            ChatComposerView(
              draft: $draft.text, isBusy: false, showsProgress: false, canStop: false,
              needsUpgrade: false, error: nil,
              attachmentURL: URL(string: "https://composer-preview.invalid")!,
              attachments: draft.attachments, draftState: draft,
              submit: {}, refresh: nil)
          }
          .safeAreaBar(edge: .top, spacing: 0) {
            HStack {
              Button { setSidebar(true) } label: {
                OkouToolbarIcon("menu").modifier(OkouGlassControl(shape: .circle))
              }
              .buttonStyle(.plain).accessibilityLabel("Open sidebar")
              Spacer()
              Button("Clear draft") {
                composer.text = ""
                dismissKeyboard()
              }
              .font(.okou(.callout))
            }
            .frame(height: 44).padding(.horizontal, OkouSpace.lg)
          }
          .frame(width: width, height: geometry.size.height)
          .background { OkouColor.background.ignoresSafeArea() }
          .blur(radius: OkouElevation.sidebarBlur * progress)
          .opacity(1 - progress)
          .offset(x: drift * progress)
          .allowsHitTesting(!sidebar.isOpen)
          .accessibilityHidden(sidebar.isOpen)
        }
        .gesture(
          SidebarPanGesture(
            interaction: sidebar, sidebarWidth: width,
            changed: { translation in
              if sidebar.translation == nil { dismissKeyboard() }
              sidebar.dragChanged(translation)
            },
            ended: { translation, velocity, cancelled in
              withAnimation(.spring(response: 0.34, dampingFraction: 0.88)) {
                sidebar.endDrag(
                  translation: translation, velocity: velocity, cancelled: cancelled,
                  sidebarWidth: width)
              }
            }))
      }
      .background(OkouColor.background.ignoresSafeArea())
    }

    private func setSidebar(_ open: Bool) {
      dismissKeyboard()
      withAnimation(.spring(response: 0.34, dampingFraction: 0.88)) {
        sidebar.setOpen(open)
      }
    }

    private func dismissKeyboard() {
      UIApplication.shared.sendAction(
        #selector(UIResponder.resignFirstResponder), to: nil, from: nil, for: nil)
    }
  }
#endif
