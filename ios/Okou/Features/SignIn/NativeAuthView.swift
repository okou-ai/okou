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
      // Keep the complete SDK flow available for server-required methods beyond email/password.
      AuthView(mode: flow.mode == .signIn ? .signIn : .signUp, isDismissible: true)
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
        if flow.step == .options {
          Button("More options") { showsAdditionalMethods = true }
            .font(.okou(.footnote)).foregroundStyle(OkouColor.mutedForeground)
            .frame(minHeight: OkouControl.minimumTarget)
            .disabled(flow.isWorking)
            .accessibilityLabel("More sign-in options")
        }
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
        Text(flow.mode == .signIn ? "Welcome to Okou" : "Create your account")
          .font(.okou(.title).weight(.semibold))
          .foregroundStyle(OkouColor.foreground)
          .accessibilityAddTraits(.isHeader)
        Text(flow.mode == .signIn ? "Log in to your Okou workspace." : "Meet your new AI coworker.")
          .font(.okou(.subheadline)).foregroundStyle(OkouColor.mutedForeground)
      }
      .multilineTextAlignment(.center)
      .fixedSize(horizontal: false, vertical: true)
      Spacer(minLength: OkouSpace.xxxl)
      VStack(spacing: OkouSpace.md) {
        ForEach(flow.providers) { provider in
          Button {
            flow.startOAuth(provider)
          } label: {
            HStack {
              AsyncImage(url: provider.iconImageUrl) { image in
                image.resizable().renderingMode(
                  provider.supportsTintedIconMask ? .template : .original
                ).scaledToFit().foregroundStyle(OkouColor.foreground)
              } placeholder: {
                Color.clear
              }
              .frame(width: 20, height: 20).accessibilityHidden(true)
              Spacer(minLength: OkouSpace.sm)
              Text("Continue with \(provider.name)")
              Spacer(minLength: OkouSpace.sm)
              Color.clear.frame(width: 20, height: 20)
            }
          }
          .buttonStyle(OkouProviderButtonStyle())
          .disabled(flow.isWorking)
          .accessibilityIdentifier("auth-provider-\(provider.id)")
        }
        if !flow.providers.isEmpty { separator.padding(.vertical, OkouSpace.xs) }
        Button {
          flow.chooseEmail()
        } label: {
          Label("Continue with email", okouSymbol: "mail")
        }
        .buttonStyle(OkouButtonStyle(isPrimary: true))
        .disabled(flow.isWorking)
        .accessibilityIdentifier("auth-continue-email")
        errorMessage
        if flow.isWorking { ProgressView("Connecting…").font(.okou(.footnote)) }
      }
      modeSwitch.padding(.top, OkouSpace.lg)
      legalLinks.padding(.top, OkouSpace.lg)
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
      case .email:
        emailForm
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
      if flow.step == .email {
        modeSwitch.frame(maxWidth: .infinity).padding(.top, OkouSpace.sm)
        legalLinks.frame(maxWidth: .infinity).padding(.top, OkouSpace.lg)
      }
    }
  }

  private var title: String {
    switch flow.step {
    case .email: flow.mode == .signIn ? "Log in with email" : "Create your account"
    case .code: "Check your email"
    case .password: "Enter your password"
    case .profile: "A little about you"
    case .additionalVerification: "One more step"
    case .options: "Welcome to Okou"
    }
  }

  private var subtitle: String {
    switch flow.step {
    case .email:
      flow.mode == .signIn
        ? "Enter your email to continue to Okou." : "Use your work email to get started."
    case .code: "Enter the verification code we sent to \(flow.email)."
    case .password: flow.email
    case .profile: "Complete your account details to continue."
    case .additionalVerification:
      "Your account needs an additional verification step. Continue to finish securely."
    case .options: ""
    }
  }

  private var emailForm: some View {
    VStack(alignment: .leading, spacing: OkouSpace.lg) {
      Text("Email address").font(.okou(.subheadline).weight(.medium))
      TextField(
        "Email address", text: $flow.email,
        prompt: Text("you@company.com").foregroundStyle(OkouColor.mutedForeground)
      )
      .keyboardType(.emailAddress).textContentType(.emailAddress)
      .textInputAutocapitalization(.never).autocorrectionDisabled()
      .textFieldStyle(OkouTextFieldStyle(isFocused: focusedField == .email)).focused(
        $focusedField, equals: .email
      )
      .submitLabel(.continue).onSubmit { submitEmail() }
      .disabled(flow.isWorking).accessibilityLabel("Email address").accessibilityIdentifier(
        "auth-email")
      primaryAction("Continue", disabled: !flow.canSubmitEmail) { submitEmail() }
    }
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

  private var modeSwitch: some View {
    HStack(spacing: OkouSpace.xs) {
      Text(flow.mode == .signIn ? "New to Okou?" : "Already have an account?")
        .foregroundStyle(OkouColor.mutedForeground)
      Button(flow.mode == .signIn ? "Create account" : "Log in") { flow.switchMode() }
        .foregroundStyle(OkouColor.brandText).fontWeight(.semibold)
        .disabled(flow.isWorking)
        .accessibilityIdentifier(flow.mode == .signIn ? "auth-create-account" : "auth-log-in")
    }
    .font(.okou(.subheadline)).frame(minHeight: OkouControl.minimumTarget)
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
