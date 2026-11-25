import AuthenticationServices
import SwiftUI

/// Adapts the system browser to the connector attempt that owns its API receipt.
struct ConnectorAuthenticationSessionView: UIViewControllerRepresentable {
  let ownerID: UUID?
  let url: URL?
  let callbackURL: URL?
  let onFinish: @MainActor (URL, URL?, Error?) -> Void

  func makeUIViewController(context: Context) -> Controller { Controller() }

  func updateUIViewController(_ controller: Controller, context: Context) {
    controller.update(ownerID: ownerID, url: url, callbackURL: callbackURL, onFinish: onFinish)
  }

  static func dismantleUIViewController(_ controller: Controller, coordinator: ()) {
    controller.cancel()
  }

  final class Controller: UIViewController {
    private typealias BrowserCompletion = ASWebAuthenticationSession.CompletionHandler
    private var ownerID: UUID?
    private weak var anchorWindow: UIWindow?
    private var requestedURL: URL?
    private var callbackURL: URL?
    private var requestID: UUID?
    private var session: ASWebAuthenticationSession?
    private var presentation: Presentation?
    private var onFinish: (@MainActor (URL, URL?, Error?) -> Void)?

    override func loadView() {
      let anchor = AnchorView()
      anchor.isUserInteractionEnabled = false
      anchor.attached = { [weak self] window in
        self?.anchorWindow = window
        self?.startIfReady()
      }
      view = anchor
    }

    func update(
      ownerID: UUID?, url: URL?, callbackURL: URL?,
      onFinish: @escaping @MainActor (URL, URL?, Error?) -> Void
    ) {
      self.onFinish = onFinish
      guard self.ownerID != ownerID || requestedURL != url || self.callbackURL != callbackURL
      else { return }
      cancel()
      self.ownerID = ownerID
      requestedURL = url
      self.callbackURL = callbackURL
      startIfReady()
    }

    private func startIfReady() {
      guard session == nil, let url = requestedURL, let window = anchorWindow else { return }
      let id = UUID()
      requestID = id
      let presentation = Presentation(window: window)
      let completion: BrowserCompletion = { [weak self] callback, error in
        Task { @MainActor [weak self] in
          self?.finish(id: id, url: url, callbackURL: callback, error: error)
        }
      }
      let session: ASWebAuthenticationSession
      if let callbackURL, let host = callbackURL.host {
        session = ASWebAuthenticationSession(
          url: url, callback: .https(host: host, path: callbackURL.path),
          completionHandler: completion)
      } else {
        // Older APIs and other providers still complete through receipt polling.
        // Require HTTPS for registered origins only after every serving and
        // retained rollback API supports it; keep the other live paths (#50221).
        session = ASWebAuthenticationSession(
          url: url, callbackURLScheme: nil, completionHandler: completion)
      }
      session.presentationContextProvider = presentation
      session.prefersEphemeralWebBrowserSession = false
      self.presentation = presentation
      self.session = session
      if !session.start() {
        finish(id: id, url: url, callbackURL: nil, error: PresentationError.unavailable)
      }
    }

    private func finish(id: UUID, url: URL, callbackURL: URL?, error: Error?) {
      guard requestID == id else { return }
      requestID = nil
      requestedURL = nil
      session = nil
      presentation = nil
      if let error = error as? ASWebAuthenticationSessionError, error.code == .canceledLogin {
        onFinish?(url, callbackURL, CancellationError())
      } else {
        onFinish?(url, callbackURL, error)
      }
    }

    func cancel() {
      ownerID = nil
      requestID = nil
      let previous = session
      session = nil
      presentation = nil
      requestedURL = nil
      previous?.cancel()
    }

    private final class AnchorView: UIView {
      var attached: ((UIWindow) -> Void)?

      override func didMoveToWindow() {
        super.didMoveToWindow()
        if let window { attached?(window) }
      }
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
