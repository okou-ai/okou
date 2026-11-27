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
    class Request(val rowKey: String, val inputMode: InputMode, val previousIndex: Int?)

    var pending by mutableStateOf<Request?>(null)
        private set

    fun returningFrom(
        rowKey: String?,
        inputMode: InputMode,
        keyboardOnly: Boolean = true,
        previousIndex: Int? = null,
    ) {
        pending =
            rowKey
                ?.takeIf { !keyboardOnly || inputMode == InputMode.Keyboard }
                ?.let {
                    Request(it, inputMode, previousIndex)
                }
    }

    fun cancel() {
        pending = null
    }

    fun finish(request: Request) {
        if (pending === request) cancel()
    }

    fun isCurrent(request: Request, inputMode: InputMode): Boolean =
        pending === request && request.inputMode == inputMode
}

@Composable
internal fun Modifier.observeReturnFocus(
    returnFocus: DirectoryReturnFocus,
    active: Boolean = true,
): Modifier {
    if (!active) return this
    val request = returnFocus.pending ?: return this
    val input = LocalInputModeManager.current
    if (input.inputMode != request.inputMode) {
        SideEffect { returnFocus.finish(request) }
        return this
    }
    return onFocusChanged {
        if (it.hasFocus) returnFocus.finish(request)
    }
        .focusGroup()
}

/** Restores focus after placement, yielding to manual focus moves while waiting for content. */
@Composable
internal fun Modifier.restoreDirectoryFocus(
    returnFocus: DirectoryReturnFocus,
    ready: Boolean,
    position: LazyListState,
    row: FocusRequester,
    fallback: FocusRequester,
    rowEnabled: Boolean,
    requestMissingRowAlternative: (DirectoryReturnFocus.Request) -> Boolean = { false },
): Modifier {
    if (!ready) return observeReturnFocus(returnFocus)
    val request = returnFocus.pending ?: return this
    val input = LocalInputModeManager.current
    if (input.inputMode != request.inputMode) {
        SideEffect { returnFocus.finish(request) }
        return this
    }
    // Attaching a focus group here could immediately report existing focus in a retained list.
    return onGloballyPositioned {
        if (returnFocus.isCurrent(request, input.inputMode)) {
            val rowVisible =
                rowEnabled && position.layoutInfo.visibleItemsInfo.any { it.key == request.rowKey }
            if (
                (rowVisible && row.requestFocus()) ||
                    (!rowEnabled && requestMissingRowAlternative(request)) ||
                    fallback.requestFocus()
            ) {
                returnFocus.finish(request)
            }
        }
    }
}
