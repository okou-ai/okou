import CCStateSwiftUI
import ChatData
import SwiftUI

struct PersonalSubscriptionsView: View {
  let store: PersonalSubscriptionStore
  var body: some View {
    StoreProvider(store.stateStore) {
      PersonalSubscriptionsContent(store: store).id(ObjectIdentifier(store))
    }
  }
}

private struct PersonalSubscriptionsContent: View {
  @Bindable var store: PersonalSubscriptionStore
  @ResolvedValue private var groups: [PersonalSubscriptionResources.Group]?
  @LoadableStatus<[PersonalSubscriptionResources.Group]> private var status: LoadableState

  init(store: PersonalSubscriptionStore) {
    self.store = store
    _groups = ResolvedValue(task: store.resources.groups, keepLast: true)
    _status = LoadableStatus(task: store.resources.groups)
  }
  private var accountGroups: [PersonalSubscriptionResources.Group] {
    groups ?? store.resources.confirmedGroups
  }
  private var readError: String? { $groups.error.map(ChatRequestFailure.message(for:)) }

  @Environment(\.locale) private var locale
  @State private var showsAuth = false
  @State private var disconnecting: PersonalSubscription?
  @State private var resetting: PersonalSubscription?

  var body: some View {
    List {
      if status == .loading && store.accounts.isEmpty {
        OkouLoadingRow("Loading accounts…")
      }
      if let error = readError ?? store.error {
        Section {
          OkouLoadErrorRow(message: error) { _ = await store.refresh(force: true) }
        }
      }
      // One card per account, grouped by provider; the provider names only its first card.
      ForEach(accountGroups, id: \.type) { group in
        let type = group.type
        ForEach(Array(group.accounts.enumerated()), id: \.element.id) { index, account in
          accountSection(account, type: type, showsProvider: index == 0)
        }
      }
      Section {
        ForEach(PersonalSubscriptionType.allCases) { type in
          Button {
            store.start(type: type)
            showsAuth = true
          } label: {
            Text("Connect \(providerTitle(type))")
              .foregroundStyle(OkouColor.foreground)
              .frame(maxWidth: .infinity, alignment: .leading)
              .contentShape(Rectangle())
          }
          .disabled(store.accounts.filter { $0.type == type.rawValue }.count >= 10)
        }
      } header: {
        Text("Add account").okouSectionHeader()
      } footer: {
        Group {
          if let notice = store.notice {
            Text(notice)
          } else {
            Text("Runs use the active account of each provider. Pull down to refresh usage.")
          }
        }
        .okouSectionNote()
      }
    }
    .disabled(store.isMutating)
    .okouGroupedBackground()
    .refreshable { await store.refresh(force: true) }
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

  @ViewBuilder
  private func accountSection(
    _ account: PersonalSubscription, type: PersonalSubscriptionType, showsProvider: Bool
  ) -> some View {
    Section {
      identityRow(account, type: type)
      if account.needsReconnect {
        // Without a valid sign-in there is no usage to show; one row says what to do.
        HStack(spacing: OkouSpace.md) {
          Text("Sign-in expired").foregroundStyle(OkouColor.destructive)
          Spacer(minLength: OkouSpace.sm)
          Button("Reconnect") {
            store.start(type: type, accountID: account.id)
            showsAuth = true
          }
          .buttonStyle(.borderless)
          .foregroundStyle(OkouColor.foreground)
          .font(.okou(.body).weight(.medium))
        }
      } else if account.usageWindows.isEmpty {
        VStack(alignment: .leading, spacing: OkouSpace.two) {
          Text("Usage unavailable").foregroundStyle(OkouColor.mutedForeground)
          if let reset = account.subscriptionNextResetAt, reset > .now {
            Text(OkouUsageMeter.resetText(reset))
              .font(.okou(.caption)).foregroundStyle(OkouColor.mutedForeground)
          }
        }
      } else {
        ForEach(account.usageWindows) { usage in
          if let remaining = usage.window.remaining {
            OkouUsageMeter(
              title: usage.id == "week" ? "Weekly limit" : "5-hour limit", remaining: remaining,
              resetsAt: usage.window.resetAt)
          }
        }
      }
      if type == .codex, let credits = account.subscriptionResetCredits, credits > 0,
        !account.needsReconnect
      {
        Button {
          resetting = account
        } label: {
          OkouValueRow(value: Text("\(credits) left").monospacedDigit()) {
            Text("Reset usage").foregroundStyle(OkouColor.foreground)
          }
        }
      }
    } header: {
      if showsProvider {
        HStack(spacing: OkouSpace.sm) {
          SubscriptionBrandIcon(type: type)
          Text(providerTitle(type))
        }
        .okouSectionHeader()
      }
    } footer: {
      Group {
        if account.needsReconnect {
          Text("Okou can't read usage or run tasks with this account until you sign in again.")
        } else if type == .codex, let expiry = account.subscriptionResetCreditsNextExpiresAt,
          expiry > Date(), (account.subscriptionResetCredits ?? 0) > 0
        {
          Text(
            "Credits expire \(expiry.formatted(Date.FormatStyle(date: .abbreviated, time: .shortened).locale(locale)))"
          )
        }
      }
      .okouSectionNote()
    }
    .listSectionSpacing(showsProvider ? .default : .compact)
  }

  /// Email, plan and state on one row; account actions live in its menu.
  private func identityRow(_ account: PersonalSubscription, type: PersonalSubscriptionType)
    -> some View
  {
    HStack(spacing: OkouSpace.md) {
      VStack(alignment: .leading, spacing: OkouSpace.two) {
        Text(account.accountEmail ?? account.workspaceName ?? providerTitle(type))
          .font(.okou(.body).weight(.medium))
          .lineLimit(1)
          .truncationMode(.middle)
          .textSelection(.enabled)
        HStack(spacing: OkouSpace.six) {
          if let plan = account.planType, !plan.isEmpty {
            Text(plan.prefix(1).uppercased() + plan.dropFirst())
              .font(.okou(.caption).weight(.medium))
              .padding(.horizontal, OkouSpace.six)
              .padding(.vertical, OkouSpace.one)
              .background(OkouColor.nestedFill, in: Capsule())
          }
          if account.isActive != false {
            Text("Active").font(.okou(.caption)).foregroundStyle(OkouColor.mutedForeground)
          }
          if let workspace = account.workspaceName, workspace != account.accountEmail,
            !workspace.hasSuffix("'s Organization")
          {
            Text(workspace).font(.okou(.caption)).foregroundStyle(OkouColor.mutedForeground)
              .lineLimit(1)
          }
        }
      }
      Spacer(minLength: OkouSpace.sm)
      Menu {
        if account.isActive == false {
          Button("Use account", okouSymbol: "check") { Task { await store.activate(account) } }
        }
        Button("Reconnect", okouSymbol: "refresh-cw") {
          store.start(type: type, accountID: account.id)
          showsAuth = true
        }
        Button("Disconnect", okouSymbol: "log-out", role: .destructive) { disconnecting = account }
      } label: {
        OkouIcon("ellipsis", size: OkouIconSize.standard)
          .foregroundStyle(OkouColor.mutedForeground)
          .frame(width: OkouControl.minimumTarget, height: OkouControl.minimumTarget)
          .contentShape(Rectangle())
      }
      .accessibilityLabel("Account actions")
    }
  }
}

struct SubscriptionAuthorizationView: View {
  let store: PersonalSubscriptionStore
  var body: some View {
    StoreProvider(store.stateStore) {
      SubscriptionAuthorizationContent(store: store).id(ObjectIdentifier(store))
    }
  }
}

private struct SubscriptionAuthorizationContent: View {
  let store: PersonalSubscriptionStore
  @LoadableValue private var presentation: Loadable<PersonalSubscriptionAuthorization.Presentation>

  init(store: PersonalSubscriptionStore) {
    self.store = store
    _presentation = LoadableValue(store.authorization.value)
  }
  @Environment(\.locale) private var locale
  @Environment(\.dismiss) private var dismiss
  @Environment(\.openURL) private var openURL

  var body: some View {
    switch presentation {
    case .hasData(let authorization): authorizationForm(authorization)
    case .hasError(let error): OkouLoadErrorRow(message: ChatRequestFailure.message(for: error))
    case .loading: ProgressView()
    }
  }

  private func authorizationForm(_ authorization: PersonalSubscriptionAuthorization.Presentation)
    -> some View
  {
    NavigationStack {
      Form {
        switch authorization.phase {
        case .idle, .starting:
          OkouLoadingRow("Starting authorization…")
        case .pending, .completing:
          Section {
            Text("1. Open the authorization page in your browser and sign in.")
            if let url = authorization.browserURL {
              Button("Open authorization page", okouSymbol: "globe") { openURL(url) }
            }
            if let code = authorization.verificationCode {
              Text("2. Enter this verification code in your browser.")
              Text(code).font(.okou(.title).monospaced()).textSelection(.enabled)
                .accessibilityLabel("Verification code: \(code)")
              Button("Copy verification code", okouSymbol: "copy") {
                UIPasteboard.general.string = code
              }
              Text("Waiting for authorization…").foregroundStyle(OkouColor.mutedForeground)
            } else {
              Text("2. Paste the authorization code shown after signing in.")
              TextField(
                "Authorization code",
                text: Binding(
                  get: { authorization.authorizationCode }, set: { store.authorizationCode = $0 }),
                axis: .vertical
              )
              .textInputAutocapitalization(.never).autocorrectionDisabled()
              .privacySensitive()
              .accessibilityIdentifier("subscription-authorization-code")
              Button("Complete connection") { Task { await store.submitClaudeCode() } }
                .disabled(
                  authorization.phase == .completing
                    || authorization.authorizationCode.trimmingCharacters(
                      in: .whitespacesAndNewlines
                    )
                    .isEmpty
                )
              if authorization.phase == .completing { ProgressView() }
            }
            if let expires = authorization.expiresAt {
              Text(
                "Authorization expires \(expires.formatted(Date.FormatStyle(date: .omitted, time: .shortened).locale(locale)))"
              )
              .font(.okou(.caption)).foregroundStyle(OkouColor.mutedForeground)
            }
          }
        case .complete:
          Label("Subscription connected", okouSymbol: "circle-check")
          Button("Done") { dismiss() }
        case .expired, .failed:
          Text(
            authorization.phase == .expired
              ? LocalizedStringKey("Authorization expired. Start again to connect.")
              : LocalizedStringKey("Unable to authorize your subscription."))
          Button("Start again") { store.retryAuth() }
        }
        if let error = authorization.authError {
          Text(error).foregroundStyle(OkouColor.destructive)
        }
      }
      .okouGroupedBackground()
      .navigationTitle(authorization.authType.map(providerTitle) ?? "Connect subscription")
      .navigationBarTitleDisplayMode(.inline)
      .toolbar {
        OkouCloseToolbarItem {
          store.cancelAuth()
          dismiss()
        }
      }
    }
    .presentationDetents([.medium, .large])
    .onDisappear { store.cancelAuth() }
  }
}
