package ai.okou.android

import androidx.compose.foundation.lazy.LazyListState
import androidx.compose.runtime.Composable
import androidx.compose.runtime.remember
import androidx.compose.ui.Modifier
import androidx.compose.ui.focus.FocusRequester
import androidx.compose.ui.layout.onGloballyPositioned

private class DirectoryFocusRestoration(var completed: Boolean = false)

/** Restores input focus after placement without moving the directory to an offscreen row. */
@Composable
internal fun Modifier.restoreDirectoryFocus(
    rowKey: String?,
    ready: Boolean,
    position: LazyListState,
    row: FocusRequester,
    fallback: FocusRequester,
    onRestored: () -> Unit,
    rowEnabled: Boolean,
): Modifier {
    if (rowKey == null) return this
    val restoration = remember(rowKey, position) { DirectoryFocusRestoration() }
    if (!ready) return this
    return onGloballyPositioned {
        if (!restoration.completed) {
            val rowVisible =
                rowEnabled && position.layoutInfo.visibleItemsInfo.any { it.key == rowKey }
            if ((rowVisible && row.requestFocus()) || fallback.requestFocus()) {
                restoration.completed = true
                onRestored()
            }
        }
    }
}
