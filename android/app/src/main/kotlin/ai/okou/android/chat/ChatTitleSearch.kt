package ai.okou.android.chat

import ai.okou.android.R
import androidx.compose.foundation.background
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
import androidx.compose.runtime.remember
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.focus.FocusRequester
import androidx.compose.ui.focus.focusRequester
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.platform.LocalSoftwareKeyboardController
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp

@Composable
internal fun ChatTitleSearch(
    state: ChatListUiState,
    query: String,
    onQueryChange: (String) -> Unit,
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
    val ordered =
        remember(state.threads) {
            state.threads
                .asSequence()
                .filter { it.hidden != true }
                .map { it to chatTimestamp(it.sortAt) }
                .sortedWith(
                    compareByDescending<Pair<ConfirmedChat, ChatTimestamp>> { it.second }
                        .thenBy { it.first.id }
                )
                .map { it.first }
                .toList()
        }
    val projectNames = remember(state.projects) { state.projects.associate { it.id to it.name } }
    val keyword = query.trim()
    val results =
        remember(ordered, keyword, untitled) {
            if (keyword.isEmpty()) ordered.take(12)
            else
                ordered.filter {
                    (it.title?.takeIf(String::isNotBlank) ?: untitled).contains(
                        keyword,
                        ignoreCase = true,
                    )
                }
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
                onValueChange = { onQueryChange(it.take(256)) },
                modifier =
                    Modifier.weight(1f)
                        .focusRequester(inputFocus)
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
                            .background(colors.surfaceVariant, RoundedCornerShape(18.dp))
                            .padding(start = 12.dp, end = if (query.isEmpty()) 12.dp else 0.dp),
                        verticalAlignment = Alignment.CenterVertically,
                    ) {
                        Box(Modifier.weight(1f)) {
                            if (query.isEmpty()) {
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
                        if (query.isNotEmpty()) {
                            IconButton(onClick = { onQueryChange("") }) {
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
        LazyColumn(
            Modifier.fillMaxWidth()
                .weight(1f)
                .padding(horizontal = 16.dp)
                .testTag("chat_search_results"),
            state = position,
        ) {
            if (state.listPhase == ChatReadPhase.Failed) {
                item {
                    Column(Modifier.padding(horizontal = 12.dp)) {
                        Text(
                            stringResource(
                                if (state.confirmedAt == null) R.string.chat_load_failed
                                else R.string.chat_refresh_failed
                            )
                        )
                        TextButton(onClick = retry) { Text(stringResource(R.string.retry)) }
                    }
                }
            } else if (state.source == ChatListSource.Cache) {
                item { Text(stringResource(R.string.chat_cached), Modifier.padding(12.dp)) }
            }
            if (state.confirmedAt == null && state.listPhase == ChatReadPhase.Loading) {
                item { Text(stringResource(R.string.chat_loading), Modifier.padding(12.dp)) }
            } else if (results.isEmpty() && state.listPhase != ChatReadPhase.Failed) {
                item { Text(stringResource(R.string.chat_search_empty), Modifier.padding(12.dp)) }
            } else if (results.isNotEmpty()) {
                item {
                    Text(
                        stringResource(
                            if (keyword.isEmpty()) R.string.chat_search_recent
                            else R.string.chat_list_title
                        ),
                        Modifier.padding(horizontal = 12.dp, vertical = 8.dp),
                        style = MaterialTheme.typography.titleSmall,
                    )
                }
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
                            chat.title?.takeIf(String::isNotBlank) ?: untitled,
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
