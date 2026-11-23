import AuthenticationServices
import SwiftUI

/// Adapts the system browser to the connector attempt that owns its API receipt.
struct ConnectorAuthenticationSessionView: UIViewControllerRepresentable {
  let url: URL?
  let onFinish: @MainActor (URL, Error?) -> Void

  func makeUIViewController(context: Context) -> Controller { Controller() }

  func updateUIViewController(_ controller: Controller, context: Context) {
    controller.update(url: url, onFinish: onFinish)
  }

  static func dismantleUIViewController(_ controller: Controller, coordinator: ()) {
    controller.cancel()
  }

  final class Controller: UIViewController {
    private var requestedURL: URL?
    private var requestID: UUID?
    private var session: ASWebAuthenticationSession?
    private var presentation: Presentation?
    private var onFinish: (@MainActor (URL, Error?) -> Void)?

    override func viewDidAppear(_ animated: Bool) {
      super.viewDidAppear(animated)
      startIfReady()
    }

    func update(url: URL?, onFinish: @escaping @MainActor (URL, Error?) -> Void) {
      self.onFinish = onFinish
      guard requestedURL != url else { return }
      cancel()
      requestedURL = url
      startIfReady()
    }

    private func startIfReady() {
      guard session == nil, let url = requestedURL, let window = view.window else { return }
      let id = UUID()
      requestID = id
      let presentation = Presentation(window: window)
      // Provider callbacks still finish at the API. Receipt verification dismisses
      // this session; no provider callback scheme or tokens are captured by iOS.
      let session = ASWebAuthenticationSession(url: url, callbackURLScheme: nil) {
        [weak self] _, error in
        Task { @MainActor [weak self] in self?.finish(id: id, url: url, error: error) }
      }
      session.presentationContextProvider = presentation
      session.prefersEphemeralWebBrowserSession = false
      self.presentation = presentation
      self.session = session
      if !session.start() {
        finish(id: id, url: url, error: PresentationError.unavailable)
      }
    }

    private func finish(id: UUID, url: URL, error: Error?) {
      guard requestID == id else { return }
      requestID = nil
      requestedURL = nil
      session = nil
      presentation = nil
      if let error = error as? ASWebAuthenticationSessionError, error.code == .canceledLogin {
        onFinish?(url, CancellationError())
      } else {
        onFinish?(url, error)
      }
    }

    func cancel() {
      requestID = nil
      let previous = session
      session = nil
      presentation = nil
      requestedURL = nil
      previous?.cancel()
    }
  }

  private final class Presentation: NSObject, ASWebAuthenticationPresentationContextProviding {
    let window: UIWindow
    init(window: UIWindow) { self.window = window }
    func presentationAnchor(for session: ASWebAuthenticationSession) -> ASPresentationAnchor {
      window
    }
  }

  private enum PresentationError: Error { case unavailable }
}
