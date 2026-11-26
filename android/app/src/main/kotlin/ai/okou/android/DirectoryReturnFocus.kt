package ai.okou.android

import androidx.compose.foundation.focusGroup
import androidx.compose.foundation.lazy.LazyListState
import androidx.compose.runtime.Composable
import androidx.compose.runtime.SideEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.focus.FocusRequester
import androidx.compose.ui.focus.onFocusChanged
import androidx.compose.ui.input.InputMode
import androidx.compose.ui.layout.onGloballyPositioned
import androidx.compose.ui.platform.LocalInputModeManager

/** Owns one transient keyboard return for the current directory visit. */
internal class DirectoryReturnFocus {
    class Request(val rowKey: String)

    var pending by mutableStateOf<Request?>(null)
        private set

    fun returningFrom(rowKey: String?, inputMode: InputMode) {
        pending = rowKey?.takeIf { inputMode == InputMode.Keyboard }?.let(::Request)
    }

    fun cancel() {
        pending = null
    }

    fun finish(request: Request) {
        if (pending === request) cancel()
    }
}

/** Restores keyboard focus after placement while the directory has no focused control. */
@Composable
internal fun Modifier.restoreDirectoryFocus(
    returnFocus: DirectoryReturnFocus,
    ready: Boolean,
    position: LazyListState,
    row: FocusRequester,
    fallback: FocusRequester,
    rowEnabled: Boolean,
): Modifier {
    val request = returnFocus.pending ?: return this
    val input = LocalInputModeManager.current
    if (input.inputMode != InputMode.Keyboard) {
        SideEffect { returnFocus.finish(request) }
        return this
    }
    val directoryFocus = onFocusChanged {
        if (it.hasFocus) returnFocus.finish(request)
    }
        .focusGroup()
    if (!ready) return directoryFocus
    return directoryFocus.onGloballyPositioned {
        if (returnFocus.pending === request && input.inputMode == InputMode.Keyboard) {
            val rowVisible =
                rowEnabled && position.layoutInfo.visibleItemsInfo.any { it.key == request.rowKey }
            if ((rowVisible && row.requestFocus()) || fallback.requestFocus()) {
                returnFocus.finish(request)
            }
        }
    }
}
