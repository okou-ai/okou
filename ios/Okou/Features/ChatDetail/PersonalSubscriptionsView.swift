import ChatData
import SwiftUI

struct PersonalSubscriptionsView: View {
  @Bindable var store: PersonalSubscriptionStore
  @Environment(\.locale) private var locale
  @State private var showsAuth = false
  @State private var disconnecting: PersonalSubscription?
  @State private var resetting: PersonalSubscription?

  var body: some View {
    List {
      ForEach(PersonalSubscriptionType.allCases) { type in
        let accounts = store.accounts.filter { $0.type == type.rawValue }
        Section {
          ForEach(accounts) { account in
            VStack(alignment: .leading, spacing: 10) {
              HStack(alignment: .top) {
                SubscriptionBrandIcon(type: type)
                VStack(alignment: .leading, spacing: 3) {
                  Text(account.accountEmail ?? account.workspaceName ?? providerTitle(type))
                    .font(.headline).textSelection(.enabled)
                  if let workspace = account.workspaceName, workspace != account.accountEmail {
                    Text(workspace).font(.caption)
                  }
                  if let plan = account.planType {
                    Text(plan).font(.caption).foregroundStyle(.secondary)
                  }
                  Text(
                    account.needsReconnect
                      ? LocalizedStringKey("Reconnect required") : LocalizedStringKey("Connected")
                  )
                  .font(.caption).foregroundStyle(account.needsReconnect ? .orange : .secondary)
                }
                Spacer()
                if account.isActive != false {
                  Image(systemName: "checkmark.circle.fill").accessibilityLabel("Active account")
                }
              }
              SubscriptionUsageView(account: account)
              HStack {
                if account.isActive == false {
                  Button("Use account") { Task { await store.activate(account) } }
                }
                Button("Reconnect") {
                  store.start(type: type, accountID: account.id)
                  showsAuth = true
                }
                Spacer()
                Menu {
                  Button("Disconnect", role: .destructive) { disconnecting = account }
                } label: {
                  Image(systemName: "ellipsis").frame(width: 44, height: 44)
                }
                .accessibilityLabel("Account actions")
              }.font(.subheadline)
              if type == .codex, let credits = account.subscriptionResetCredits, credits > 0 {
                Button("Reset usage (\(credits) credits)") { resetting = account }
                if let expiry = account.subscriptionResetCreditsNextExpiresAt, expiry > Date() {
                  Text(
                    "Credits expire \(expiry.formatted(Date.FormatStyle(date: .abbreviated, time: .shortened).locale(locale)))"
                  )
                  .font(.caption).foregroundStyle(.secondary)
                }
              }
            }
            .padding(.vertical, 4)
          }
          if accounts.isEmpty && !store.isLoading {
            Text("No connected accounts").foregroundStyle(.secondary)
          }
          Button {
            store.start(type: type)
            showsAuth = true
          } label: {
            Label("Connect account", systemImage: "plus")
          }.disabled(accounts.count >= 10)
        } header: {
          Text(providerTitle(type))
        }
      }
      if store.isLoading { ProgressView("Loading accounts…") }
      if let error = store.error { Text(error).foregroundStyle(.red) }
      if let notice = store.notice { Text(notice) }
      Button("Refresh accounts and usage") { Task { await store.refresh(force: true) } }
    }
    .disabled(store.isMutating)
    .navigationTitle("Subscriptions")
    .navigationBarTitleDisplayMode(.inline)
    .task { await store.refresh() }
    .sheet(isPresented: $showsAuth, onDismiss: store.cancelAuth) {
      SubscriptionAuthorizationView(store: store)
    }
    .confirmationDialog(
      "Disconnect account?",
      isPresented: Binding(
        get: { disconnecting != nil }, set: { if !$0 { disconnecting = nil } }
      ), titleVisibility: .visible
    ) {
      Button("Disconnect", role: .destructive) {
        if let account = disconnecting { Task { await store.disconnect(account) } }
        disconnecting = nil
      }
    } message: {
      Text(
        "Future runs will use another active account. Runs already started keep their captured account."
      )
    }
    .confirmationDialog(
      "Reset subscription usage?",
      isPresented: Binding(
        get: { resetting != nil }, set: { if !$0 { resetting = nil } }
      ), titleVisibility: .visible
    ) {
      Button("Use one reset credit") {
        if let account = resetting { Task { await store.reset(account) } }
        resetting = nil
      }
    } message: {
      Text("This uses one subscription reset credit. It cannot be undone.")
    }
  }
}

private struct SubscriptionUsageView: View {
  let account: PersonalSubscription
  @Environment(\.locale) private var locale
  var body: some View {
    VStack(alignment: .leading, spacing: 8) {
      if account.subscriptionUsage?.fiveHour == nil && account.subscriptionUsage?.weekly == nil {
        Text("Usage unavailable").foregroundStyle(.secondary)
        if let reset = account.subscriptionNextResetAt {
          Text(
            "Resets \(reset.formatted(Date.FormatStyle(date: .abbreviated, time: .shortened).locale(locale)))"
          )
        }
        if let period = account.subscriptionResetPeriod { Text(period) }
      }
      ForEach(account.usageWindows) { usage in
        window(usage.window, title: usage.id == "week" ? "Weekly window" : "5-hour window")
      }
    }.font(.caption)
  }
  @ViewBuilder private func window(
    _ window: PersonalSubscription.Window?, title: LocalizedStringKey
  ) -> some View {
    if let window {
      VStack(alignment: .leading, spacing: 4) {
        HStack {
          Text(title)
          Spacer()
          if let remaining = window.remaining {
            Text("\(remaining, specifier: "%.0f")% remaining")
          } else {
            Text("Usage unavailable")
          }
        }
        if let remaining = window.remaining {
          ProgressView(value: remaining, total: 100).accessibilityLabel(title)
        }
        if let date = window.resetAt {
          Text(
            "Resets \(date.formatted(Date.FormatStyle(date: .abbreviated, time: .shortened).locale(locale)))"
          ).foregroundStyle(
            .secondary)
        }
      }
    }
  }
}

struct SubscriptionAuthorizationView: View {
  @Bindable var store: PersonalSubscriptionStore
  @Environment(\.locale) private var locale
  @Environment(\.dismiss) private var dismiss
  @Environment(\.openURL) private var openURL

  var body: some View {
    NavigationStack {
      Form {
        switch store.phase {
        case .idle, .starting:
          ProgressView("Starting authorization…")
        case .pending, .completing:
          Section {
            Text("1. Open the authorization page in your browser and sign in.")
            if let url = store.browserURL {
              Button("Open authorization page", systemImage: "safari") { openURL(url) }
            }
            if let code = store.verificationCode {
              Text("2. Enter this verification code in your browser.")
              Text(code).font(.title.monospaced()).textSelection(.enabled)
                .accessibilityLabel("Verification code: \(code)")
              Button("Copy verification code", systemImage: "doc.on.doc") {
                UIPasteboard.general.string = code
              }
              Text("Waiting for authorization…").foregroundStyle(.secondary)
            } else {
              Text("2. Paste the authorization code shown after signing in.")
              TextField("Authorization code", text: $store.authorizationCode, axis: .vertical)
                .textInputAutocapitalization(.never).autocorrectionDisabled()
                .privacySensitive()
                .accessibilityIdentifier("subscription-authorization-code")
              Button("Complete connection") { Task { await store.submitClaudeCode() } }
                .disabled(
                  store.phase == .completing
                    || store.authorizationCode.trimmingCharacters(in: .whitespacesAndNewlines)
                      .isEmpty
                )
              if store.phase == .completing { ProgressView() }
            }
            if let expires = store.expiresAt {
              Text(
                "Authorization expires \(expires.formatted(Date.FormatStyle(date: .omitted, time: .shortened).locale(locale)))"
              )
              .font(.caption).foregroundStyle(.secondary)
            }
          }
        case .complete:
          Label("Subscription connected", systemImage: "checkmark.circle.fill")
          Button("Done") { dismiss() }
        case .expired, .failed:
          Text(
            store.phase == .expired
              ? LocalizedStringKey("Authorization expired. Start again to connect.")
              : LocalizedStringKey("Unable to authorize your subscription."))
          Button("Start again") { store.retryAuth() }
        }
        if let error = store.authError { Text(error).foregroundStyle(.red) }
      }
      .navigationTitle(store.authType.map(providerTitle) ?? "Connect subscription")
      .navigationBarTitleDisplayMode(.inline)
      .toolbar {
        ToolbarItem(placement: .cancellationAction) {
          Button("Close") {
            store.cancelAuth()
            dismiss()
          }
        }
      }
    }
    .presentationDetents([.medium, .large])
    .onDisappear { store.cancelAuth() }
  }
}
