import ClerkKit
import ClerkKitUI
import SwiftUI

struct SignInView: View {
  let authentication: AuthenticationService
  let webURL: URL

  var body: some View {
    Group {
      if let clerk = authentication.clerk {
        if authentication.isLoading {
          ProgressView("Restoring your session…")
        } else if authentication.needsWorkspaceSelection {
          WorkspaceSignInView(authentication: authentication, webURL: webURL)
        } else if clerk.environment == nil {
          unavailableView
        } else {
          AuthView(mode: .signIn, isDismissible: false) {
            Task { await authentication.refreshWorkspaces() }
          }
          .environment(clerk)
          .safeAreaInset(edge: .bottom) {
            Text("Use your existing Okou account. Manage your account on the web.")
              .font(.footnote)
              .foregroundStyle(.secondary)
              .multilineTextAlignment(.center)
              .padding()
          }
        }
      } else {
        unavailableView
      }
    }
    .environment(\.locale, Locale(identifier: "en"))
  }

  private var unavailableView: some View {
    ContentUnavailableView {
      Label("Unable to sign in", systemImage: "person.crop.circle.badge.exclamationmark")
    } description: {
      Text(authentication.errorMessage ?? "Sign-in could not be loaded. Please try again.")
    } actions: {
      Button("Try again") { Task { await authentication.refresh() } }
      Link("Open Okou on the web", destination: webURL)
    }
  }
}

/// Clerk's organization task also offers organization creation. This restricted
/// selection view keeps workspace setup on the web while using native SDK sessions.
private struct WorkspaceSignInView: View {
  let authentication: AuthenticationService
  let webURL: URL
  @State private var actionError: String?

  var body: some View {
    NavigationStack {
      List {
        if authentication.isLoadingWorkspaces && authentication.workspaces.isEmpty {
          ProgressView("Loading workspaces…")
        } else if authentication.workspaces.isEmpty {
          Section {
            Text("Finish setting up your workspace on the web, then return here.")
              .foregroundStyle(.secondary)
            Link("Open Okou on the web", destination: webURL)
            Button("Refresh workspaces") { Task { await authentication.refresh() } }
          }
        } else {
          Section("Choose a workspace") {
            ForEach(authentication.workspaces) { workspace in
              Button {
                Task {
                  do {
                    try await authentication.switchWorkspace(workspace.id)
                  } catch {
                    actionError = error.localizedDescription
                  }
                }
              } label: {
                Label(workspace.name, systemImage: "building.2")
              }
              .disabled(authentication.isSwitchingWorkspace)
            }
          }
        }
        if let error = actionError ?? authentication.errorMessage {
          Section {
            Text(error).foregroundStyle(.red)
            Button("Try again") {
              actionError = nil
              Task { await authentication.refresh() }
            }
          }
        }
        Section {
          Button("Sign out", role: .destructive) {
            Task {
              do {
                try await authentication.signOut()
              } catch {
                actionError = error.localizedDescription
              }
            }
          }
        }
      }
      .navigationTitle("Welcome to Okou")
      .task(id: authentication.userID) {
        await authentication.refreshWorkspaces()
      }
    }
  }
}
