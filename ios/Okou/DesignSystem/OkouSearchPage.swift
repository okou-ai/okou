import SwiftUI

/// A fixed search header and filter row above plain results. The native field focuses during
/// presentation; ending input leaves the header in place, and the trailing ✕ closes the sheet
/// in one action. An empty state centres between the header and the keyboard.
///
/// Put it in a `NavigationStack` presented as a large native sheet with
/// `okouSheetBackground(OkouColor.background)`. `results` are list rows; `empty` shows over
/// the list, so give it content only when the list has nothing to show.
struct OkouSearchPage<Filters: View, Results: View, Empty: View>: View {
  @Binding var text: String
  let prompt: LocalizedStringResource
  let close: () -> Void
  let filters: Filters
  let results: Results
  let empty: Empty

  init(
    text: Binding<String>, prompt: LocalizedStringResource,
    close: @escaping () -> Void,
    @ViewBuilder filters: () -> Filters,
    @ViewBuilder results: () -> Results,
    @ViewBuilder empty: () -> Empty
  ) {
    _text = text
    self.prompt = prompt
    self.close = close
    self.filters = filters()
    self.results = results()
    self.empty = empty()
  }

  var body: some View {
    List { results.listRowBackground(Color.clear) }
      .listStyle(.plain)
      .scrollContentBackground(.hidden)
      .background(OkouColor.background)
      .toolbar(.hidden, for: .navigationBar)
      // Results end cleanly under a solid header instead of blurring through it.
      .scrollEdgeEffectStyle(.hard, for: .top)
      .scrollDismissesKeyboard(.immediately)
      // Over the list rather than its first row, which would sit at the top: centred in what
      // is left of the screen, as the system's `ContentUnavailableView` sits in a search.
      .overlay { empty }
      .safeAreaBar(edge: .top, spacing: 0) {
        VStack(spacing: 0) {
          HStack(spacing: OkouSpace.sm) {
            OkouSearchBar {
              OkouSearchField(text: $text, prompt: prompt)
            }
            OkouCloseButton(action: close)
              .buttonStyle(.plain)
              .modifier(OkouGlassControl(shape: .circle))
              .accessibilityLabel("Close")
              .accessibilityIdentifier("close-search")
          }
          .padding(.horizontal, OkouSpace.lg)
          .padding(.top, OkouSpace.xl)
          .padding(.bottom, OkouSpace.sm)
          filters.padding(.vertical, OkouSpace.sm)
        }
        .background(OkouColor.background)
      }
  }
}
