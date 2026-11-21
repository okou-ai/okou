package ai.okou.android.chat

import ai.okou.android.R
import ai.okou.android.WorkspaceSearchField
import ai.okou.android.WorkspaceSearchToolbar
import ai.okou.android.state.ChatSearchState
import ai.okou.android.workspaceSearchControlHeight
import ai.okou.android.workspaceSearchTextStyle
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.BoxWithConstraints
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.text.BasicTextField
import androidx.compose.foundation.text.KeyboardActions
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedCard
import androidx.compose.material3.Text
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
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.platform.LocalSoftwareKeyboardController
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.clearAndSetSemantics
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp

@Composable
internal fun ChatTitleSearch(
    state: ChatListUiState,
    search: ChatSearchState,
    widthDp: Int,
    listWidth: Int?,
    workspaceName: String?,
    focusOnEntry: Boolean,
    onFocused: () -> Unit,
    onClose: () -> Unit,
    onOpen: (ConfirmedChat) -> Unit,
    retry: () -> Unit,
) {
    val query = search.query
    val colors = MaterialTheme.colorScheme
    val keyboard = LocalSoftwareKeyboardController.current
    val inputFocus = remember { FocusRequester() }
    var inputFocused by remember { mutableStateOf(false) }
    LaunchedEffect(focusOnEntry) {
        if (focusOnEntry) {
            inputFocus.requestFocus()
            keyboard?.show()
            onFocused()
        }
    }
    val searchLabel = stringResource(R.string.chat_search_workspace)
    val inputStyle = workspaceSearchTextStyle().copy(color = colors.onSurface)
    val contentWidth = Modifier.widthIn(max = 720.dp).fillMaxWidth()
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

    Column(
        Modifier.fillMaxSize().imePadding().testTag("chat_search"),
        horizontalAlignment = Alignment.CenterHorizontally,
    ) {
        WorkspaceSearchToolbar(
            widthDp,
            listWidth,
            leading = {
                IconButton(
                    onClick = onClose,
                    modifier = Modifier.size(workspaceSearchControlHeight()),
                ) {
                    Icon(
                        painterResource(R.drawable.ic_arrow_back),
                        stringResource(R.string.back),
                        tint = colors.onSurface,
                    )
                }
            },
            field = { fieldModifier ->
                BasicTextField(
                    value = query,
                    onValueChange = search::edit,
                    modifier =
                        fieldModifier
                            .focusRequester(inputFocus)
                            .onFocusChanged { inputFocused = it.isFocused }
                            .testTag("chat_search_query")
                            .semantics {
                                contentDescription =
                                    workspaceName?.let { "$searchLabel, $it" } ?: searchLabel
                            },
                    textStyle = inputStyle,
                    singleLine = true,
                    keyboardOptions = KeyboardOptions(imeAction = ImeAction.Search),
                    keyboardActions = KeyboardActions(onSearch = { keyboard?.hide() }),
                    cursorBrush = SolidColor(colors.onSurface),
                    decorationBox = { input ->
                        WorkspaceSearchField(
                            Modifier.fillMaxWidth(),
                            focused = inputFocused,
                            hasTrailingAction = query.text.isNotEmpty(),
                        ) {
                            Box(Modifier.weight(1f).padding(vertical = 8.dp)) {
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
                                        search.reset()
                                        inputFocus.requestFocus()
                                        keyboard?.show()
                                    }
                                ) {
                                    Icon(
                                        painterResource(R.drawable.ic_close),
                                        stringResource(R.string.chat_search_clear),
                                        modifier = Modifier.size(20.dp),
                                        tint = colors.onSurfaceVariant,
                                    )
                                }
                            }
                        }
                    },
                )
            },
        )
        if (workspaceName != null) {
            Text(
                workspaceName,
                contentWidth
                    .padding(start = 16.dp, end = 16.dp, bottom = 4.dp)
                    .clearAndSetSemantics {},
                color = colors.onSurfaceVariant,
                fontSize = 13.sp,
                lineHeight = 20.sp,
                maxLines = 2,
                overflow = TextOverflow.Ellipsis,
            )
        }
        val failure = state.listReadFailure
        val retryFailedRead =
            retry.takeIf { !state.offline && failure == ChatListReadFailure.NeedsRetry }
        val retryEnabled = state.listPhase != ChatReadPhase.Loading
        val awaitingResults = state.confirmedAt == null && !state.offline && failure == null
        val showSkeleton = rememberChatWaitIndicator(awaitingResults)
        val resultsWidth = contentWidth.weight(1f).padding(horizontal = 16.dp)
        if (state.confirmedAt == null) {
            // Let the restored list position apply to the result rows once data is available.
            LazyColumn(resultsWidth) {
                when {
                    state.offline ->
                        item { ChatContentLoadNotice(R.string.chat_list_load_when_online) }
                    failure != null ->
                        item {
                            ChatContentLoadNotice(
                                R.string.chat_list_first_load_failed,
                                retry = retryFailedRead,
                                retryEnabled = retryEnabled,
                            )
                        }
                    showSkeleton -> item { ChatListSkeleton() }
                }
            }
            return@Column
        }
        val anchor = search.pendingAnchor
        if (anchor != null) {
            LaunchedEffect(anchor, results) {
                val index = results.indexOfFirst { it.id == anchor.chatId }
                // The heading occupies the first lazy item.
                search.restorePosition(index.takeIf { it >= 0 }?.plus(1))
            }
            return@Column
        }
        val status =
            when {
                state.offline -> R.string.chat_list_offline
                state.sustainedRefreshFailure || retryFailedRead != null ->
                    R.string.chat_list_refresh_failed
                else -> null
            }
        BoxWithConstraints(resultsWidth) {
            val inlineStatus = maxHeight < with(LocalDensity.current) { chatInlineFeedbackHeight() }
            val feedback =
                @Composable {
                    if (status != null) {
                        OutlinedCard(Modifier.fillMaxWidth().padding(bottom = 8.dp)) {
                            ChatContentLoadNotice(
                                status,
                                retry = retryFailedRead,
                                retryEnabled = retryEnabled,
                            )
                        }
                    }
                }
            Column(Modifier.fillMaxSize()) {
                LazyColumn(
                    Modifier.fillMaxWidth().weight(1f).testTag("chat_search_results"),
                    state = search.position,
                ) {
                    item(key = "search_heading") {
                        if (results.isEmpty()) {
                            Text(
                                stringResource(R.string.chat_search_empty),
                                Modifier.padding(12.dp),
                            )
                        } else {
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
                                if (chat.archived)
                                    listOfNotNull(project, archived).joinToString(" · ")
                                else project
                            Column(
                                Modifier.fillMaxWidth()
                                    .heightIn(min = ChatListRowHeight)
                                    .clip(ChatListRowShape)
                                    .clickable(role = Role.Button) { onOpen(chat) }
                                    .padding(ChatListRowPadding),
                                verticalArrangement = Arrangement.Center,
                            ) {
                                Text(
                                    chat.searchTitle(untitled),
                                    style = chatListTitleStyle(),
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
                    if (inlineStatus && status != null) item(key = "search_status") { feedback() }
                }
                if (!inlineStatus) feedback()
            }
        }
    }
}

private fun ConfirmedChat.searchTitle(untitled: String): String =
    title?.takeIf(String::isNotBlank) ?: untitled
