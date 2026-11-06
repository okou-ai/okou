import ClerkKit
import ClerkKitUI
import SwiftUI

struct NativeAuthView: View {
  @State private var flow: NativeAuthFlow
  @State private var showsAdditionalMethods = false
  @FocusState private var focusedField: Field?
  private enum Field { case email, code, password, firstName, lastName, username }

  init(clerk: Clerk, completed: @escaping @MainActor () async -> Void) {
    _flow = State(initialValue: NativeAuthFlow(clerk: clerk, completed: completed))
  }

  var body: some View {
    GeometryReader { geometry in
      ScrollView {
        VStack(alignment: .leading, spacing: 0) {
          navigation
          if flow.step == .options {
            options(minimumHeight: max(0, geometry.size.height - 88))
          } else {
            form
              .padding(.top, OkouSpace.section)
              .frame(maxWidth: .infinity, alignment: .leading)
          }
        }
        .frame(maxWidth: OkouControl.readableWidth)
        .padding(.horizontal, OkouControl.pageInset)
        .padding(.top, OkouSpace.sm)
        .padding(.bottom, OkouSpace.xxl)
        .frame(maxWidth: .infinity)
      }
      .scrollDismissesKeyboard(.interactively)
      .scrollBounceBehavior(.basedOnSize)
    }
    .background(OkouColor.background.ignoresSafeArea())
    .onChange(of: flow.step) { _, _ in focusedField = nil }
    .onDisappear { flow.cancel() }
    .sheet(isPresented: $showsAdditionalMethods) {
      // Clerk's complete flow, for what the native steps do not cover: an extra verification
      // the account requires ("Continue securely") and password help. Not offered up front:
      // the first screen already has every method Okou enables.
      AuthView(mode: .signInOrUp, isDismissible: true)
        .initialIdentifier(flow.email)
        .environment(flow.clerk)
        .environment(\.clerkTheme, OkouAuthTheme.makeTheme())
        .clerkAppIconView { OkouWordmark(width: 76).padding(.bottom, OkouSpace.xxl) }
    }
  }

  private var navigation: some View {
    ZStack {
      if flow.step != .options { OkouWordmark(width: 60) }
      HStack {
        if flow.step == .options {
          OkouWordmark(width: 76)
        } else {
          Button {
            focusedField = nil
            flow.back()
          } label: {
            OkouToolbarIcon("chevron-left")
              .frame(width: OkouControl.minimumTarget, height: OkouControl.minimumTarget)
              .contentShape(Rectangle())
          }
          .buttonStyle(.plain).accessibilityLabel("Back").disabled(flow.isWorking)
        }
        Spacer(minLength: 0)
      }
    }
    .frame(height: OkouControl.minimumTarget)
  }

  private func options(minimumHeight: CGFloat) -> some View {
    VStack(spacing: 0) {
      Spacer(minLength: OkouSpace.xxxl)
      VStack(spacing: OkouSpace.lg) {
        Image(OkouBrand.symbol).resizable().scaledToFit()
          .frame(width: 64, height: 64)
          .foregroundStyle(OkouColor.primary).accessibilityHidden(true)
        Text("Welcome to Okou")
          .font(.okou(.title).weight(.semibold))
          .foregroundStyle(OkouColor.foreground)
          .accessibilityAddTraits(.isHeader)
        Text("Log in or create your account.")
          .font(.okou(.subheadline)).foregroundStyle(OkouColor.mutedForeground)
      }
      .multilineTextAlignment(.center)
      .fixedSize(horizontal: false, vertical: true)
      Spacer(minLength: OkouSpace.xxxl)
      VStack(spacing: OkouSpace.md) {
        ForEach(flow.providers) { provider in
          Button {
            focusedField = nil
            flow.startOAuth(provider)
          } label: {
            OkouProviderLabel(Text("Continue with \(provider.name)")) {
              AuthProviderMark(provider: provider)
            }
          }
          .buttonStyle(OkouProviderButtonStyle())
          .disabled(flow.isWorking)
          .accessibilityIdentifier("auth-provider-\(provider.id)")
        }
        if !flow.providers.isEmpty { separator.padding(.vertical, OkouSpace.xs) }
        // The email is on this screen, as on the web: one field and one Continue for
        // logging in and for a new account alike.
        emailField
        primaryAction("Continue", disabled: !flow.canSubmitEmail) { submitEmail() }
          .accessibilityIdentifier("auth-continue-email")
        errorMessage
      }
      legalLinks.padding(.top, OkouSpace.xl)
    }
    .frame(minHeight: minimumHeight)
  }

  private var form: some View {
    VStack(alignment: .leading, spacing: OkouSpace.xxl) {
      VStack(alignment: .leading, spacing: OkouSpace.md) {
        Text(title).font(.okou(.title).weight(.semibold))
          .foregroundStyle(OkouColor.foreground).accessibilityAddTraits(.isHeader)
        Text(subtitle).font(.okou(.subheadline)).foregroundStyle(OkouColor.mutedForeground)
          .fixedSize(horizontal: false, vertical: true)
      }
      switch flow.step {
      case .code:
        codeForm
      case .password:
        passwordForm
      case .profile:
        profileForm
      case .additionalVerification:
        Button("Continue securely") { showsAdditionalMethods = true }
          .buttonStyle(OkouButtonStyle(isPrimary: true))
      case .options:
        EmptyView()
      }
      errorMessage
    }
  }

  private var title: String {
    switch flow.step {
    case .code: "Check your email"
    case .password: "Enter your password"
    case .profile: "A little about you"
    case .additionalVerification: "One more step"
    case .options: "Welcome to Okou"
    }
  }

  private var subtitle: String {
    switch flow.step {
    case .code: "Enter the verification code we sent to \(flow.email)."
    case .password: flow.email
    case .profile: "Complete your account details to continue."
    case .additionalVerification:
      "Your account needs an additional verification step. Continue to finish securely."
    case .options: ""
    }
  }

  private var emailField: some View {
    TextField(
      "Email address", text: $flow.email,
      prompt: Text("Email address").foregroundStyle(OkouColor.mutedForeground)
    )
    .keyboardType(.emailAddress).textContentType(.emailAddress)
    .textInputAutocapitalization(.never).autocorrectionDisabled()
    .textFieldStyle(OkouTextFieldStyle(isFocused: focusedField == .email))
    .focused($focusedField, equals: .email)
    .submitLabel(.continue).onSubmit { submitEmail() }
    .disabled(flow.isWorking).accessibilityLabel("Email address")
    .accessibilityIdentifier("auth-email")
  }

  private var codeForm: some View {
    VStack(alignment: .leading, spacing: OkouSpace.xl) {
      Button("Change email") { flow.back() }
        .font(.okou(.subheadline).weight(.medium)).foregroundStyle(OkouColor.brandText)
        .frame(minHeight: OkouControl.minimumTarget).disabled(flow.isWorking)
      TextField(
        "Verification code", text: $flow.code,
        prompt: Text("6-digit code").foregroundStyle(OkouColor.mutedForeground)
      )
      .keyboardType(.numberPad).textContentType(.oneTimeCode)
      .textFieldStyle(OkouTextFieldStyle(isFocused: focusedField == .code)).focused(
        $focusedField, equals: .code
      )
      .disabled(flow.isWorking).accessibilityLabel("Verification code").accessibilityIdentifier(
        "auth-code")
      primaryAction("Verify and continue", disabled: flow.code.count < 6) { flow.verify() }
      TimelineView(.periodic(from: .now, by: 1)) { timeline in
        let remaining = max(0, Int(ceil(flow.resendAvailableAt.timeIntervalSince(timeline.date))))
        Button(remaining == 0 ? "Resend code" : "Resend code in \(remaining)s") { flow.resend() }
          .font(.okou(.subheadline)).foregroundStyle(OkouColor.brandText)
          .frame(maxWidth: .infinity, minHeight: OkouControl.minimumTarget)
          .disabled(remaining > 0 || flow.isWorking)
      }
    }
  }

  private var passwordForm: some View {
    VStack(alignment: .leading, spacing: OkouSpace.lg) {
      SecureField("Password", text: $flow.password)
        .textContentType(.password).textFieldStyle(
          OkouTextFieldStyle(isFocused: focusedField == .password)
        )
        .focused($focusedField, equals: .password)
        .submitLabel(.go).onSubmit { flow.submitPassword() }
        .disabled(flow.isWorking)
      primaryAction("Log in", disabled: flow.password.isEmpty) { flow.submitPassword() }
      Button("Forgot password or use another method?") { showsAdditionalMethods = true }
        .font(.okou(.subheadline)).foregroundStyle(OkouColor.brandText)
        .frame(minHeight: OkouControl.minimumTarget)
    }
  }

  private var profileForm: some View {
    VStack(alignment: .leading, spacing: OkouSpace.lg) {
      if flow.requiredFields.contains(.firstName) {
        TextField("First name", text: $flow.firstName).textContentType(.givenName)
          .textFieldStyle(OkouTextFieldStyle(isFocused: focusedField == .firstName)).focused(
            $focusedField, equals: .firstName)
      }
      if flow.requiredFields.contains(.lastName) {
        TextField("Last name", text: $flow.lastName).textContentType(.familyName)
          .textFieldStyle(OkouTextFieldStyle(isFocused: focusedField == .lastName)).focused(
            $focusedField, equals: .lastName)
      }
      if flow.requiredFields.contains(.username) {
        TextField("Username", text: $flow.username).textContentType(.username)
          .textInputAutocapitalization(.never).autocorrectionDisabled()
          .textFieldStyle(OkouTextFieldStyle(isFocused: focusedField == .username)).focused(
            $focusedField, equals: .username)
      }
      if flow.requiredFields.contains(.password) {
        SecureField("Create a password", text: $flow.password).textContentType(.newPassword)
          .textFieldStyle(OkouTextFieldStyle(isFocused: focusedField == .password)).focused(
            $focusedField, equals: .password)
      }
      if flow.requiredFields.contains(.legalAccepted) {
        Toggle("I agree to the Terms of Service and Privacy Policy", isOn: $flow.legalAccepted)
          .font(.okou(.subheadline)).tint(OkouColor.primary400)
        legalLinks
      }
      primaryAction("Continue", disabled: !flow.canSubmitProfile) { flow.submitProfile() }
    }
    .disabled(flow.isWorking)
  }

  private func primaryAction(_ title: String, disabled: Bool, action: @escaping () -> Void)
    -> some View
  {
    Button {
      focusedField = nil
      action()
    } label: {
      HStack(spacing: OkouSpace.sm) {
        if flow.isWorking { ProgressView().tint(OkouColor.primaryForeground) }
        Text(flow.isWorking ? "Please wait…" : title)
      }
    }
    .buttonStyle(OkouButtonStyle(isPrimary: true))
    .disabled(disabled || flow.isWorking)
  }

  private func submitEmail() {
    guard flow.canSubmitEmail, !flow.isWorking else { return }
    focusedField = nil
    flow.startEmail()
  }

  @ViewBuilder private var errorMessage: some View {
    if let error = flow.error {
      Label(error, okouSymbol: "circle-alert", iconSize: OkouIconSize.inline).font(.okou(.footnote))
        .foregroundStyle(OkouColor.destructive)
        .fixedSize(horizontal: false, vertical: true)
        .accessibilityIdentifier("auth-error")
    }
  }

  private var separator: some View {
    HStack(spacing: OkouSpace.lg) {
      Rectangle().fill(OkouColor.border).frame(height: OkouSpace.hairline)
      Text("or").font(.okou(.caption)).foregroundStyle(OkouColor.mutedForeground)
      Rectangle().fill(OkouColor.border).frame(height: OkouSpace.hairline)
    }
  }

  @ViewBuilder private var legalLinks: some View {
    if let terms = legalURL(flow.clerk.environment?.displayConfig.termsUrl),
      let privacy = legalURL(flow.clerk.environment?.displayConfig.privacyPolicyUrl)
    {
      VStack(spacing: OkouSpace.xs) {
        Text("By continuing, you agree to Okou’s")
        HStack(spacing: OkouSpace.xs) {
          Link("Terms of Service", destination: terms).underline()
          Text("and")
          Link("Privacy Policy", destination: privacy).underline()
        }
      }
      .font(.okou(.caption)).foregroundStyle(OkouColor.mutedForeground)
      .multilineTextAlignment(.center).fixedSize(horizontal: false, vertical: true)
    }
  }

  private func legalURL(_ value: String?) -> URL? {
    guard let value, let url = URL(string: value), url.scheme == "https" else { return nil }
    return url
  }
}
