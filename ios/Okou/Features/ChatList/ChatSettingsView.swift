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
  @State private var confirmsDeletion = false
  @State private var deleting = false

  private static let securityURL = URL(string: "https://www.okou.ai/en/security")!
  private static let supportEmail = "contact@okou.ai"

  var body: some View {
    NavigationStack {
      Form {
        Section { profile }
        Section {
          workspaceRow
          Link(destination: store.webURL) {
            settingsLabel("Open Okou on web", icon: "arrow-up-right")
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
              "Notifications tell you when a chat finishes. Model and connector choices are in the message composer."
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
        Section {
          Button(role: .destructive) {
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
          .disabled(signingOut || deleting)
          Button(role: .destructive) {
            confirmsDeletion = true
          } label: {
            HStack {
              settingsLabel("Delete account", icon: "trash-2")
              if deleting {
                Spacer()
                ProgressView()
              }
            }
            .foregroundStyle(OkouColor.destructive)
          }
          .disabled(signingOut || deleting)
        } header: {
          Text("Account").okouSectionHeader()
        }
      }
      .okouGroupedBackground()
      .font(.okou(.body))
      .tint(OkouColor.foreground)
      .navigationTitle("Settings")
      .navigationBarTitleDisplayMode(.inline)
      .toolbar { ToolbarItem(placement: .topBarTrailing) { OkouCloseButton { dismiss() } } }
      .confirmationDialog(
        "Delete your Okou account?", isPresented: $confirmsDeletion, titleVisibility: .visible
      ) {
        if authentication.canDeleteAccount {
          Button("Delete account", role: .destructive) { deleteAccount() }
        } else {
          Button("Continue on the web") {
            openURL(
              store.webURL.appending(queryItems: [
                URLQueryItem(name: "settings", value: "preference")
              ]))
          }
        }
        Button("Cancel", role: .cancel) {}
      } message: {
        Text(
          authentication.canDeleteAccount
            ? "Your profile and sign-in are removed permanently. Workspaces you own keep their chats until they are deleted separately."
            : "Account deletion is finished in your account settings on the Okou website."
        )
      }
    }
  }

  private var profile: some View {
    let profile = authentication.profile
    // Same leading slot as every other row, so the name starts on the sheet's text edge.
    return HStack(spacing: OkouSpace.md) {
      OkouProfileAvatar(
        imageURL: profile?.imageURL, hasImage: profile?.hasImage ?? false,
        size: OkouControl.rowLeadingSlot)
      VStack(alignment: .leading, spacing: OkouSpace.one) {
        Text(profile?.name ?? profile?.email ?? String(localized: "Signed in"))
          .font(.okou(.body).weight(.medium))
        if let email = profile?.email, profile?.name != nil {
          Text(verbatim: email)
            .font(.okou(.footnote)).foregroundStyle(OkouColor.mutedForeground)
            .textSelection(.enabled)
        }
      }
    }
    .accessibilityElement(children: .combine)
  }

  @ViewBuilder private var workspaceRow: some View {
    if let workspace = authentication.workspaces.first(where: {
      $0.id == authentication.activeWorkspaceID
    }) {
      OkouRowLabel(Text(workspace.name)) {
        OkouWorkspaceLogo(
          workspaceID: workspace.id, name: workspace.name,
          imageURL: workspace.imageURL, hasImage: workspace.hasImage,
          size: OkouIconSize.large)
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

  private func deleteAccount() {
    deleting = true
    Task {
      defer { deleting = false }
      do {
        try await notifications.deleteAccount(authentication: authentication)
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
