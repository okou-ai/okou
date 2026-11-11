import SwiftUI

/// A search surface with the system search field focused on opening, the app's ✕
/// trailing, a filter row pinned under it on a solid header, the results as a plain list, and,
/// when there are none, one `OkouEmptyState` centred in what is left of the screen.
///
/// - UIKit lays the page out under the bar (`OkouUnderNavigationBar`), so the filters and the
///   results move with the field as it rises and drops back.
/// - The field has no clear button and its ✕ is the app's (`okouSearchPageField()`).
/// - The empty state sits between the filters and the keyboard while the keyboard is up, and
///   recentres with it as it goes down.
///
/// Put it in a `NavigationStack` presented as a large native sheet with
/// `okouSheetBackground(OkouColor.background)`. `results` are list rows; `empty` shows over
/// the list, so give it content only when the list has nothing to show.
struct OkouSearchPage<Filters: View, Results: View, Empty: View>: View {
  let title: LocalizedStringKey
  @Binding var text: String
  let prompt: LocalizedStringKey
  let close: () -> Void
  let filters: Filters
  let results: Results
  let empty: Empty
  @FocusState private var isSearchFocused: Bool

  init(
    _ title: LocalizedStringKey, text: Binding<String>, prompt: LocalizedStringKey,
    close: @escaping () -> Void,
    @ViewBuilder filters: () -> Filters,
    @ViewBuilder results: () -> Results,
    @ViewBuilder empty: () -> Empty
  ) {
    self.title = title
    _text = text
    self.prompt = prompt
    self.close = close
    self.filters = filters()
    self.results = results()
    self.empty = empty()
  }

  var body: some View {
    OkouUnderNavigationBar { page }
      .ignoresSafeArea()
      .background(OkouColor.background)
      .okouSearchPageField()
      .navigationTitle(title)
      .navigationBarTitleDisplayMode(.inline)
      .searchable(
        text: $text, placement: .navigationBarDrawer(displayMode: .always), prompt: prompt
      )
      .searchFocused($isSearchFocused)
      .toolbar { OkouCloseToolbarItem(action: close) }
      .task { isSearchFocused = true }
  }

  private var page: some View {
    List { results.listRowBackground(Color.clear) }
      .listStyle(.plain)
      .scrollContentBackground(.hidden)
      .background(OkouColor.background)
      // Results end cleanly under a solid header instead of blurring through it.
      .scrollEdgeEffectStyle(.hard, for: .top)
      .scrollDismissesKeyboard(.immediately)
      // Over the list rather than its first row, which would sit at the top: centred in what
      // is left of the screen, as the system's `ContentUnavailableView` sits in a search.
      .overlay { empty }
      .safeAreaBar(edge: .top, spacing: 0) {
        filters
          .padding(.vertical, OkouSpace.sm)
          .background(OkouColor.background)
      }
  }
}
