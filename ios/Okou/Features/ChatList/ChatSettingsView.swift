import SwiftUI
import UIKit

/// The appearance the user chose in Settings; the app root applies it.
enum OkouAppearancePreference: String, CaseIterable, Identifiable {
  case system, light, dark

  static let storageKey = "okou.appearance"

  var id: String { rawValue }

  var colorScheme: ColorScheme? {
    switch self {
    case .system: nil
    case .light: .light
    case .dark: .dark
    }
  }

  var title: LocalizedStringKey {
    switch self {
    case .system: "System"
    case .light: "Light"
    case .dark: "Dark"
    }
  }
}

/// Account-wide actions live apart from chat-scoped model and service settings.
struct ChatSettingsView: View {
  let store: WorkspaceStore
  let authentication: AuthenticationService
  let notifications: NotificationService
  @Binding var accountError: String?
  @Environment(\.dismiss) private var dismiss
  @Environment(\.openURL) private var openURL
  @AppStorage(OkouAppearancePreference.storageKey) private var appearance =
    OkouAppearancePreference.system.rawValue
  @State private var signingOut = false
  @State private var confirmsSignOut = false

  private static let securityURL = URL(string: "https://www.okou.ai/en/security")!
  private static let supportEmail = "contact@okou.ai"

  var body: some View {
    NavigationStack {
      Form {
        Section { profile }
        Section {
          workspaceRow
          Link(destination: store.webURL) {
            OkouRowLabel(
              "Open Okou on web", okouSymbol: "arrow-up-right", slot: OkouAvatarSize.account)
          }
        } header: {
          Text("Workspace").okouSectionHeader()
        }
        Section {
          Button {
            if notifications.status == .denied {
              openURL(URL(string: UIApplication.openNotificationSettingsURLString)!)
            } else {
              Task { await notifications.enable() }
            }
          } label: {
            OkouValueRow(value: Text(notificationStatus)) {
              settingsLabel("Notifications", icon: "bell")
            }
          }
          if notifications.registrationError != nil {
            Button {
              Task { await notifications.retryRegistration() }
            } label: {
              settingsLabel("Retry notification setup", icon: "bell-ring")
            }
          }
          Picker(selection: $appearance) {
            ForEach(OkouAppearancePreference.allCases) { option in
              Text(option.title).tag(option.rawValue)
            }
          } label: {
            settingsLabel("Appearance", icon: "sun-moon")
          }
          .okouValuePicker()
          Button {
            openURL(URL(string: UIApplication.openSettingsURLString)!)
          } label: {
            OkouValueRow(
              value: Text(
                Locale.current.localizedString(
                  forLanguageCode: Locale.current.language.languageCode?.identifier ?? "en") ?? "")
            ) {
              settingsLabel("Language", icon: "languages")
            }
          }
        } header: {
          Text("Preferences").okouSectionHeader()
        } footer: {
          Group {
            Text(
              "Notifications tell you when a chat finishes. Pick a chat's model at the top of the chat, and its connectors under + in the message composer."
            )
            .font(.okou(.footnote)).foregroundStyle(OkouColor.mutedForeground)

          }
          .okouSectionNote()
        }
        Section {
          Link(destination: URL(string: "mailto:\(Self.supportEmail)")!) {
            OkouValueRow(value: Text(verbatim: Self.supportEmail)) {
              settingsLabel("Contact support", icon: "life-buoy")
            }
          }
          Link(destination: Self.securityURL) {
            settingsLabel("Security & privacy", icon: "shield-check")
          }
          OkouValueRow(value: Text(verbatim: Self.version).monospacedDigit()) {
            settingsLabel("Version", icon: "info")
          }
          .textSelection(.enabled)
        } header: {
          Text("Support").okouSectionHeader()
        }
        #if DEBUG
          // Debug builds only: the live design system, pushed here so Back returns to
          // Settings and ✕ closes Settings from any page. English only, so it never enters
          // the string catalog.
          Section {
            NavigationLink {
              OkouDesignSystemCatalog()
                .toolbar { OkouCloseToolbarItem { dismiss() } }
            } label: {
              OkouRowLabel(Text(verbatim: "Design system")) {
                OkouIcon("layout-grid", size: OkouIconSize.standard)
              }
            }
            NavigationLink {
              ResultStylesPage()
                .toolbar { OkouCloseToolbarItem { dismiss() } }
            } label: {
              OkouRowLabel(Text(verbatim: "Results in a chat")) {
                OkouIcon("images", size: OkouIconSize.standard)
              }
            }
          } header: {
            Text(verbatim: "Developer").okouSectionHeader()
          } footer: {
            Text(verbatim: "Only in Debug builds.").okouSectionNote()
          }
        #endif
        Section {
          Button(role: .destructive) {
            confirmsSignOut = true
          } label: {
            HStack {
              settingsLabel("Sign out", icon: "log-out")
              if signingOut {
                Spacer()
                ProgressView()
              }
            }
            .foregroundStyle(OkouColor.destructive)
          }
          .disabled(signingOut)
          .signOutConfirmation(isPresented: $confirmsSignOut, signOut: signOut)
        } header: {
          Text("Account").okouSectionHeader()
        }
      }
      .okouGroupedBackground()
      .font(.okou(.body))
      .tint(OkouColor.foreground)
      .navigationTitle("Settings")
      .navigationBarTitleDisplayMode(.inline)
      .toolbar { OkouCloseToolbarItem { dismiss() } }
    }
  }

  private var profile: some View {
    let profile = authentication.profile
    var email: Text?
    if let address = profile?.email, profile?.name != nil {
      email = Text(verbatim: address)
    }
    // The account and the workspace below share one mark size and one text edge.
    return OkouAccountRowLabel(
      Text(profile?.name ?? profile?.email ?? String(localized: "Signed in")), detail: email
    ) {
      OkouProfileAvatar(
        imageURL: profile?.imageURL, hasImage: profile?.hasImage ?? false,
        size: OkouAvatarSize.account)
    }
  }

  @ViewBuilder private var workspaceRow: some View {
    if let workspace = authentication.workspaces.first(where: {
      $0.id == authentication.activeWorkspaceID
    }) {
      OkouRowLabel(Text(workspace.name), slot: OkouAvatarSize.account) {
        OkouWorkspaceLogo(
          workspaceID: workspace.id, name: workspace.name,
          imageURL: workspace.imageURL, hasImage: workspace.hasImage,
          size: OkouAvatarSize.account)
      }
    }
  }

  private var notificationStatus: LocalizedStringKey {
    switch notifications.status {
    case .authorized: "On"
    case .denied: "Off in Settings"
    default: "Turn on"
    }
  }

  private static var version: String {
    let info = Bundle.main.infoDictionary
    let version = info?["CFBundleShortVersionString"] as? String ?? "–"
    let build = info?["CFBundleVersion"] as? String ?? "–"
    return "\(version) (\(build))"
  }

  private func signOut() {
    signingOut = true
    Task {
      defer { signingOut = false }
      do {
        try await notifications.signOut(authentication: authentication)
        dismiss()
      } catch {
        accountError = error.localizedDescription
        dismiss()
      }
    }
  }

  private func settingsLabel(_ title: LocalizedStringKey, icon: String) -> some View {
    OkouRowLabel(title, okouSymbol: icon)
  }

}
