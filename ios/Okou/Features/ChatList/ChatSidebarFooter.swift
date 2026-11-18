import SwiftUI

struct ChatSidebarFooter: View {
  let store: WorkspaceStore
  let authentication: AuthenticationService
  let notifications: NotificationService
  @Binding var accountError: String?
  @Binding var showsSettings: Bool
  let colorScheme: ColorScheme
  let newChat: () -> Void
  let rowInset: CGFloat

  /// Thumb-reach bar: settings on the left, a new-message capsule, and search on the right.
  var body: some View {
    HStack(spacing: OkouSpace.md) {
      Button {
        store.prepareSettings()
        showsSettings = true
      } label: {
        let profile = authentication.profile
        OkouProfileAvatar(
          imageURL: profile?.imageURL, hasImage: profile?.hasImage ?? false,
          size: OkouControl.minimumTarget, name: profile?.name ?? profile?.email,
          cachedImage: authentication.presentation?.image("profile"), usesSharedImage: true)
      }
      .accessibilityLabel("Settings")
      .accessibilityIdentifier("settings")
      .sheet(isPresented: $showsSettings) {
        ChatSettingsView(
          store: store, authentication: authentication, notifications: notifications,
          accountError: $accountError
        )
        .okouSheetBackground()
        // The appearance is picked in this sheet while it is open. A sheet keeps the scheme
        // it opened with, and `preferredColorScheme(nil)` for System does not clear it, so
        // the sheet takes the scheme the page behind it resolved and switches with it.
        .preferredColorScheme(colorScheme)
      }
      Button {
        newChat()
      } label: {
        Label("New Message", okouSymbol: "square-pen")
          .font(.okou(.body))
          .foregroundStyle(OkouColor.placeholder)
          .lineLimit(1)
          .frame(maxWidth: .infinity, alignment: .leading)
          .padding(.horizontal, OkouSpace.lg)
          .modifier(OkouGlassControl(shape: .capsule))
      }
      .buttonStyle(.plain)
      .accessibilityLabel("New Message")
      .accessibilityIdentifier("new-chat")
      Button {
        store.search.present()
      } label: {
        OkouToolbarIcon("search")
          .modifier(OkouGlassControl(shape: .circle))
      }
      .accessibilityLabel("Search chats")
      .accessibilityIdentifier("search-chats")
    }
    .buttonStyle(.plain)
    .frame(height: OkouControl.minimumTarget + OkouSpace.md)
    .padding(.horizontal, rowInset)
    .padding(.top, OkouSpace.sm)
  }
}
