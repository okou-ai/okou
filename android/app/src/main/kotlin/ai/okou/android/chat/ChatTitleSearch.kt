package ai.okou.android.chat

import ai.okou.android.R
import androidx.annotation.StringRes
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.LazyListState
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.BasicTextField
import androidx.compose.foundation.text.KeyboardActions
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.focus.FocusRequester
import androidx.compose.ui.focus.focusRequester
import androidx.compose.ui.focus.onFocusChanged
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.platform.LocalSoftwareKeyboardController
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.input.TextFieldValue
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp

@Composable
internal fun ChatTitleSearch(
    state: ChatListUiState,
    query: TextFieldValue,
    onQueryChange: (TextFieldValue) -> Unit,
    position: LazyListState,
    focusOnEntry: Boolean,
    onFocused: () -> Unit,
    onClose: () -> Unit,
    onOpen: (ConfirmedChat) -> Unit,
    retry: () -> Unit,
) {
    val colors = MaterialTheme.colorScheme
    val keyboard = LocalSoftwareKeyboardController.current
    val inputFocus = remember { FocusRequester() }
    var inputFocused by remember { mutableStateOf(false) }
    val fieldShape = RoundedCornerShape(18.dp)
    LaunchedEffect(focusOnEntry) {
        if (focusOnEntry) {
            inputFocus.requestFocus()
            keyboard?.show()
            onFocused()
        }
    }
    val searchLabel = stringResource(R.string.chat_search_hint)
    val inputStyle = MaterialTheme.typography.bodyLarge.copy(color = colors.onSurface)
    val untitled = stringResource(R.string.chat_untitled)
    val archived = stringResource(R.string.chat_archived)
    val projectNames = remember(state.projects) { state.projects.associate { it.id to it.name } }
    val keyword = query.text.trim().lowercase()
    val results =
        remember(state.threadsByRecency, keyword, untitled) {
            val visible = state.threadsByRecency.asSequence().filter { it.hidden != true }
            if (keyword.isEmpty()) visible.take(12).toList()
            else visible.filter { it.searchTitle(untitled).lowercase().contains(keyword) }.toList()
        }

    Column(Modifier.widthIn(max = 720.dp).fillMaxSize().imePadding().testTag("chat_search")) {
        Row(
            Modifier.fillMaxWidth().padding(start = 4.dp, top = 8.dp, end = 16.dp, bottom = 8.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            IconButton(onClick = onClose) {
                Icon(painterResource(R.drawable.ic_arrow_back), stringResource(R.string.back))
            }
            BasicTextField(
                value = query,
                onValueChange = onQueryChange,
                modifier =
                    Modifier.weight(1f)
                        .focusRequester(inputFocus)
                        .onFocusChanged { inputFocused = it.isFocused }
                        .testTag("chat_search_query")
                        .semantics { contentDescription = searchLabel },
                textStyle = inputStyle,
                singleLine = true,
                keyboardOptions = KeyboardOptions(imeAction = ImeAction.Search),
                keyboardActions = KeyboardActions(onSearch = { keyboard?.hide() }),
                cursorBrush = SolidColor(colors.onSurface),
                decorationBox = { input ->
                    Row(
                        Modifier.fillMaxWidth()
                            .heightIn(min = 48.dp)
                            .background(colors.surfaceVariant, fieldShape)
                            .border(
                                1.dp,
                                if (inputFocused) colors.primary else colors.outlineVariant,
                                fieldShape,
                            )
                            .padding(
                                start = 12.dp,
                                end = if (query.text.isEmpty()) 12.dp else 0.dp,
                            ),
                        verticalAlignment = Alignment.CenterVertically,
                    ) {
                        Box(Modifier.weight(1f)) {
                            if (query.text.isEmpty()) {
                                Text(
                                    searchLabel,
                                    style = inputStyle,
                                    color = colors.onSurfaceVariant,
                                    maxLines = 1,
                                    overflow = TextOverflow.Ellipsis,
                                )
                            }
                            input()
                        }
                        if (query.text.isNotEmpty()) {
                            IconButton(
                                onClick = {
                                    onQueryChange(TextFieldValue())
                                    inputFocus.requestFocus()
                                    keyboard?.show()
                                }
                            ) {
                                Icon(
                                    painterResource(R.drawable.ic_close),
                                    stringResource(R.string.chat_search_clear),
                                )
                            }
                        }
                    }
                },
            )
        }
        val failed = state.listPhase == ChatReadPhase.Failed
        if (state.confirmedAt == null) {
            // Let the restored list position apply to the result rows once data is available.
            SearchNotice(
                if (failed) R.string.chat_load_failed else R.string.chat_loading,
                retry.takeIf { failed },
            )
            return@Column
        }
        LazyColumn(
            Modifier.fillMaxWidth()
                .weight(1f)
                .padding(horizontal = 16.dp)
                .testTag("chat_search_results"),
            state = position,
        ) {
            // Keep result indices stable when the cache or refresh notice changes.
            item {
                if (failed) {
                    SearchNotice(R.string.chat_refresh_failed, retry)
                } else if (state.source == ChatListSource.Cache) {
                    SearchNotice(R.string.chat_cached)
                }
                if (results.isEmpty() && !failed) {
                    SearchNotice(R.string.chat_search_empty)
                } else if (results.isNotEmpty()) {
                    Text(
                        stringResource(
                            if (keyword.isEmpty()) R.string.chat_search_recent
                            else R.string.chat_list_title
                        ),
                        Modifier.padding(horizontal = 12.dp, vertical = 8.dp).semantics {
                            heading()
                        },
                        style = MaterialTheme.typography.titleSmall,
                    )
                }
            }
            if (results.isNotEmpty()) {
                items(results, key = { it.id }) { chat ->
                    val project = projectNames[chat.projectId]
                    val subtitle =
                        if (chat.archived) listOfNotNull(project, archived).joinToString(" · ")
                        else project
                    Column(
                        Modifier.fillMaxWidth()
                            .heightIn(min = 52.dp)
                            .clip(RoundedCornerShape(8.dp))
                            .clickable(role = Role.Button) { onOpen(chat) }
                            .padding(horizontal = 12.dp, vertical = 8.dp),
                        verticalArrangement = Arrangement.Center,
                    ) {
                        Text(
                            chat.searchTitle(untitled),
                            style = MaterialTheme.typography.bodyLarge,
                            maxLines = 1,
                            overflow = TextOverflow.Ellipsis,
                        )
                        if (!subtitle.isNullOrEmpty()) {
                            Text(
                                subtitle,
                                color = colors.onSurfaceVariant,
                                fontSize = 13.sp,
                                lineHeight = 20.sp,
                            )
                        }
                    }
                }
            }
        }
    }
}

private fun ConfirmedChat.searchTitle(untitled: String): String =
    title?.takeIf(String::isNotBlank) ?: untitled

@Composable
private fun SearchNotice(@StringRes label: Int, retry: (() -> Unit)? = null) {
    Column(Modifier.padding(12.dp)) {
        Text(stringResource(label))
        if (retry != null) TextButton(onClick = retry) { Text(stringResource(R.string.retry)) }
    }
}
