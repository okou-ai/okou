#if DEBUG
  import SwiftUI
  import UIKit

  /// The results page on its own: opened from Settings ▸ Developer, or with
  /// `--result-styles`.
  struct ResultStylesPage: View {
    var body: some View {
      ScrollView { ResultStylesGallery().padding(OkouSpace.lg) }
        .navigationTitle(Text(verbatim: "Results in a chat"))
        .navigationBarTitleDisplayMode(.inline)
    }
  }

  /// Every way a result can look in a chat, on one page, each under a caption: what the agent
  /// made (website, slides, document, file, picture, video) in each state a card goes through,
  /// and what the user attached. Covers come from the real pipeline: a live website is drawn
  /// by `SitePreviewSnapshotter`, and a deck and a document are generated here and drawn by
  /// Quick Look, as a result without a server preview is. Settings ▸ Developer opens it in
  /// Debug builds; so does `--result-styles`, and the design catalog shows it too.
  struct ResultStylesGallery: View {
    /// A live hosted site, drawn the way a link in a chat is.
    private static let site = URL(string: "https://okou-404-options.sites.vm0.io/")!
    @State private var siteCover: UIImage?
    @State private var siteTitle: String?
    @State private var slidesCover: UIImage?
    @State private var classicSlidesCover: UIImage?
    @State private var documentCover: UIImage?
    @State private var drawn = false

    var body: some View {
      VStack(alignment: .leading, spacing: OkouSpace.xl) {
        group("From the agent") {
          specimen("Website, cover drawn from the live page") {
            OkouResultCard(
              title: siteTitle ?? "okou-404-options.sites.vm0.io",
              detail: "Website · okou-404-options.sites.vm0.io", icon: "globe",
              cover: picture(siteCover))
          }
          specimen("Slides: the first slide fills the 16:9 cover") {
            OkouResultCard(
              title: "Quarterly review", detail: "Slides · PPTX · 2.3 MB", icon: "layers",
              cover: picture(slidesCover), shape: .slide)
          }
          specimen("A 4:3 deck: the whole slide, centred in the 16:9 cover") {
            OkouResultCard(
              title: "Board update", detail: "Slides · KEY · 4.1 MB", icon: "layers",
              cover: picture(classicSlidesCover), shape: .slide)
          }
          specimen("Document, cover is the top of the first page") {
            OkouResultCard(
              title: "Launch plan", detail: "PDF · 1.1 MB", icon: "file-text",
              cover: picture(documentCover), shape: .document)
          }
          specimen("While a cover loads") {
            OkouResultCard(
              title: "Pricing page", detail: "Website · pricing.okou.app", icon: "globe",
              cover: .loading)
          }
          specimen("Cover could not load right now (tap to retry)") {
            OkouResultCard(
              title: "Brand guide", detail: "Tap to load preview", icon: "file-text",
              cover: .placeholder(icon: "file-text"))
          }
          specimen("Deleted or no access: the heading only") {
            OkouResultCard(
              title: "okou-share-popover-critique-0921",
              detail: "Website · No longer available", icon: "globe")
          }
          specimen("A file with nothing to picture") {
            OkouResultCard(title: "results.csv", detail: "CSV · 18 KB", icon: "table")
          }
          specimen("Picture, whole and uncropped") {
            OkouResultTile(state: picture(siteCover))
          }
          specimen("Picture loading, and one that could not load") {
            OkouResultTile(state: .loading)
            OkouResultTile(state: .placeholder(icon: "circle-arrow-down"))
          }
          specimen("Video") {
            OkouResultTile(state: picture(slidesCover), isVideo: true)
          }
        }
        group("From the user") {
          specimen("An attached picture and file, on the user's side") {
            VStack(alignment: .trailing, spacing: OkouSpace.sm) {
              OkouResultTile(state: picture(UIImage(named: "WorkspaceDefault-5")))
              OkouResultCard(
                title: "brief.docx", detail: "Document · DOCX · 84 KB", icon: "file-text"
              )
              .frame(maxWidth: 280)
            }
            .frame(maxWidth: .infinity, alignment: .trailing)
          }
        }
      }
      .task {
        guard !drawn else { return }
        drawn = true
        slidesCover = await Self.cover(
          of: Self.slidesPDF(named: "slides-wide.pdf", size: CGSize(width: 960, height: 540)))
        classicSlidesCover = await Self.cover(
          of: Self.slidesPDF(named: "slides-classic.pdf", size: CGSize(width: 768, height: 576)))
        documentCover = await Self.cover(of: Self.documentPDF())
        if let snapshot = await SitePreviewSnapshotter.shared.snapshot(Self.site) {
          siteCover = snapshot.image.flatMap(UIImage.init(data:))
          siteTitle = snapshot.title
        }
      }
    }

    private func picture(_ image: UIImage?) -> OkouPreviewState {
      if let image { return .image(image) }
      return .loading
    }

    private func group<Content: View>(_ title: String, @ViewBuilder content: () -> Content)
      -> some View
    {
      VStack(alignment: .leading, spacing: OkouSpace.lg) {
        Text(verbatim: title).font(.okou(.headline)).accessibilityAddTraits(.isHeader)
        content()
      }
    }

    private func specimen<Content: View>(_ caption: String, @ViewBuilder content: () -> Content)
      -> some View
    {
      VStack(alignment: .leading, spacing: OkouSpace.sm) {
        Text(verbatim: caption)
          .font(.okou(.footnote))
          .foregroundStyle(OkouColor.mutedForeground)
        content()
      }
    }

    private static func cover(of file: URL?) async -> UIImage? {
      guard let file,
        let data = await AttachmentFileImporter.shared.documentCover(file)
      else { return nil }
      return UIImage(data: data)
    }

    /// A one-slide deck as a presentation exports to PDF, in the deck's own proportions.
    private static func slidesPDF(named name: String, size: CGSize) -> URL? {
      let bounds = CGRect(origin: .zero, size: size)
      let inset = size.width * 0.067
      return pdf(named: name, bounds: bounds) { context in
        UIColor(OkouColor.primary).setFill()
        context.fill(bounds)
        draw(
          "Quarterly review",
          in: CGRect(x: inset, y: size.height * 0.33, width: size.width - inset * 2, height: 90),
          size: 64, weight: .bold, color: UIColor(OkouColor.primaryForeground))
        draw(
          "Q3 results, the plan for Q4, and what we need",
          in: CGRect(x: inset, y: size.height * 0.52, width: size.width - inset * 2, height: 40),
          size: 26, weight: .regular, color: UIColor(OkouColor.primaryForeground))
      }
    }

    /// A one-page A4 document with a heading and body text.
    private static func documentPDF() -> URL? {
      let bounds = CGRect(x: 0, y: 0, width: 595, height: 842)
      return pdf(named: "document.pdf", bounds: bounds) { context in
        UIColor(OkouColor.card).setFill()
        context.fill(bounds)
        draw(
          "Launch plan", in: CGRect(x: 56, y: 64, width: 483, height: 44), size: 30,
          weight: .bold, color: UIColor(OkouColor.foreground))
        draw(
          "Goals, owners and dates for the November launch.",
          in: CGRect(x: 56, y: 116, width: 483, height: 24),
          size: 14, weight: .regular, color: UIColor(OkouColor.mutedForeground))
        for line in 0..<14 {
          UIColor(OkouColor.border).setFill()
          let width: CGFloat = line % 4 == 3 ? 280 : 483
          context.fill(CGRect(x: 56, y: 168 + CGFloat(line) * 22, width: width, height: 9))
        }
      }
    }

    private static func pdf(
      named name: String, bounds: CGRect, draw: (CGContext) -> Void
    ) -> URL? {
      let url = FileManager.default.temporaryDirectory.appending(path: "result-styles-\(name)")
      let renderer = UIGraphicsPDFRenderer(bounds: bounds)
      do {
        try renderer.writePDF(to: url) { context in
          context.beginPage()
          draw(context.cgContext)
        }
      } catch {
        return nil
      }
      return url
    }

    private static func draw(
      _ text: String, in rect: CGRect, size: CGFloat, weight: UIFont.Weight, color: UIColor
    ) {
      (text as NSString).draw(
        in: rect,
        withAttributes: [
          .font: UIFont.systemFont(ofSize: size, weight: weight), .foregroundColor: color,
        ])
    }
  }
#endif
