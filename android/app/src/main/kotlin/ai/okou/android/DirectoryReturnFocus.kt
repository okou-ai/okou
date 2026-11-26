package ai.okou.android

import androidx.compose.foundation.focusGroup
import androidx.compose.foundation.lazy.LazyListState
import androidx.compose.runtime.Composable
import androidx.compose.runtime.SideEffect
import androidx.compose.runtime.remember
import androidx.compose.ui.Modifier
import androidx.compose.ui.focus.FocusRequester
import androidx.compose.ui.focus.onFocusChanged
import androidx.compose.ui.input.InputMode
import androidx.compose.ui.layout.onGloballyPositioned
import androidx.compose.ui.platform.LocalInputModeManager

private class DirectoryFocusRestoration {
    var completed = false
        private set

    fun finish(onFinished: () -> Unit) {
        if (completed) return
        completed = true
        onFinished()
    }
}

/** Restores keyboard focus after placement while the directory has no focused control. */
@Composable
internal fun Modifier.restoreDirectoryFocus(
    rowKey: String?,
    ready: Boolean,
    position: LazyListState,
    row: FocusRequester,
    fallback: FocusRequester,
    onFinished: () -> Unit,
    rowEnabled: Boolean,
): Modifier {
    if (rowKey == null) return this
    val restoration = remember(rowKey, position) { DirectoryFocusRestoration() }
    val input = LocalInputModeManager.current
    if (input.inputMode != InputMode.Keyboard) {
        SideEffect { restoration.finish(onFinished) }
        return this
    }
    val directoryFocus = onFocusChanged {
        if (it.hasFocus) restoration.finish(onFinished)
    }
        .focusGroup()
    if (!ready) return directoryFocus
    return directoryFocus.onGloballyPositioned {
        if (!restoration.completed && input.inputMode == InputMode.Keyboard) {
            val rowVisible =
                rowEnabled && position.layoutInfo.visibleItemsInfo.any { it.key == rowKey }
            if ((rowVisible && row.requestFocus()) || fallback.requestFocus()) {
                restoration.finish(onFinished)
            }
        }
    }
}
