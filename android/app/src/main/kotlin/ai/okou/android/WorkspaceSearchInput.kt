package ai.okou.android

import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.BasicTextField
import androidx.compose.foundation.text.KeyboardActions
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.text.input.InputTransformation
import androidx.compose.foundation.text.input.TextFieldLineLimits
import androidx.compose.foundation.text.input.TextFieldState
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.SideEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.focus.FocusRequester
import androidx.compose.ui.focus.onFocusChanged
import androidx.compose.ui.graphics.Shape
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.platform.LocalSoftwareKeyboardController
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.TextRange
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.input.TextFieldValue
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp

internal val ToolDirectorySearchShape = RoundedCornerShape(18.dp)

@Composable
internal fun WorkspaceSearchInput(
    value: TextFieldValue,
    onValueChange: (TextFieldValue) -> Unit,
    label: String,
    onClear: () -> Unit,
    modifier: Modifier = Modifier,
    shape: Shape = CircleShape,
    clearLabel: String = stringResource(R.string.chat_search_clear),
) {
    val keyboard = LocalSoftwareKeyboardController.current
    var focused by remember { mutableStateOf(false) }
    val style = workspaceSearchTextStyle().copy(color = MaterialTheme.colorScheme.onSurface)
    BasicTextField(
        value = value,
        onValueChange = onValueChange,
        modifier =
            modifier
                .onFocusChanged { focused = it.isFocused }
                .semantics {
                    contentDescription = label
                },
        textStyle = style,
        singleLine = true,
        keyboardOptions = KeyboardOptions(imeAction = ImeAction.Search),
        keyboardActions = KeyboardActions(onSearch = { keyboard?.hide() }),
        cursorBrush = SolidColor(style.color),
        decorationBox = { input ->
            SearchInputDecoration(
                value.text.isNotEmpty(),
                label,
                clearLabel,
                style,
                shape,
                focused,
                onClear,
                input,
            )
        },
    )
}

@Composable
internal fun WorkspaceSearchInput(
    state: TextFieldState,
    label: String,
    onClear: () -> Unit,
    modifier: Modifier = Modifier,
    shape: Shape = CircleShape,
    inputTransformation: InputTransformation? = null,
) {
    val keyboard = LocalSoftwareKeyboardController.current
    var focused by remember { mutableStateOf(false) }
    val style = workspaceSearchTextStyle().copy(color = MaterialTheme.colorScheme.onSurface)
    BasicTextField(
        state = state,
        inputTransformation = inputTransformation,
        modifier =
            modifier
                .onFocusChanged { focused = it.isFocused }
                .semantics {
                    contentDescription = label
                },
        textStyle = style,
        lineLimits = TextFieldLineLimits.SingleLine,
        keyboardOptions = KeyboardOptions(imeAction = ImeAction.Search),
        onKeyboardAction = { keyboard?.hide() },
        cursorBrush = SolidColor(style.color),
        decorator = { input ->
            SearchInputDecoration(
                state.text.isNotEmpty(),
                label,
                stringResource(R.string.chat_search_clear),
                style,
                shape,
                focused,
                onClear,
                input,
            )
        },
    )
}

@Composable
private fun SearchInputDecoration(
    hasText: Boolean,
    label: String,
    clearLabel: String,
    style: TextStyle,
    shape: Shape,
    focused: Boolean,
    onClear: () -> Unit,
    input: @Composable () -> Unit,
) {
    val secondary = MaterialTheme.colorScheme.onSurfaceVariant
    WorkspaceSearchField(
        Modifier.fillMaxWidth(),
        focused = focused,
        hasTrailingAction = hasText,
        shape = shape,
    ) {
        Box(Modifier.weight(1f).padding(vertical = 8.dp)) {
            if (!hasText) {
                Text(
                    label,
                    style = style,
                    color = secondary,
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis,
                )
            }
            input()
        }
        if (hasText) {
            IconButton(
                onClick = onClear,
                modifier = Modifier.size(48.dp).workspaceSearchFocusOutline(CircleShape),
            ) {
                Icon(
                    painterResource(R.drawable.ic_close),
                    clearLabel,
                    modifier = Modifier.size(20.dp),
                    tint = secondary,
                )
            }
        }
    }
}

@Composable
internal fun searchClearAction(focus: FocusRequester, clear: () -> Unit): () -> Unit {
    val keyboard = LocalSoftwareKeyboardController.current
    return {
        clear()
        if (focus.requestFocus()) keyboard?.show()
    }
}

internal fun TextFieldState.committedSearchText(): String? =
    if (composition == null) text.toString() else null

// An IME can mark an already committed word while offering suggestions.
internal fun hasPendingSearchText(
    text: CharSequence,
    composition: TextRange?,
    committedKeyword: String,
): Boolean = composition != null && text.trim().toString() != committedKeyword

private class DisplayedSearchValue<T>(var value: T)

@Composable
internal fun <T> retainSearchResultsWhileComposing(current: T, composing: Boolean): T {
    val displayed = remember { DisplayedSearchValue(current) }
    if (composing) return displayed.value
    // A refresh and an IME edit can arrive in the same frame. Keep the last rendered snapshot.
    SideEffect { displayed.value = current }
    return current
}
