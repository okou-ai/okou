package ai.okou.android.chat

import ai.okou.android.R
import ai.okou.android.WorkspaceMenu
import ai.okou.android.WorkspaceMenuItem
import ai.okou.android.currentWindowSizeDp
import ai.okou.android.isAtLeastMediumWindowWidth
import ai.okou.android.isShortWindowHeight
import androidx.compose.foundation.Image
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.material3.ripple
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.key
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.focus.FocusRequester
import androidx.compose.ui.focus.focusRequester
import androidx.compose.ui.focus.onFocusChanged
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp

// Keep each control's existing hover and keyboard focus treatment.
internal val ChatPressRipple = ripple(enableHoverIndication = false, enableFocusIndication = false)

@Composable
internal fun ConversationToolbarActions(
    state: ChatListUiState,
    thread: ConfirmedChat?,
    onRowAction: (String, ChatRowAction) -> Unit,
    onMove: (String) -> Unit,
    onRename: (String, Boolean) -> Unit,
    renameFocus: WorkspaceRenameTarget.Chat?,
    onRenameFocusFinished: (WorkspaceRenameTarget) -> Unit,
    openResources: ((restoreFocus: Boolean) -> Unit)? = null,
    actionsFocus: FocusRequester? = null,
    onFind: ((restoreFocus: Boolean) -> Unit)? = null,
) {
    val actions = thread?.let { state.rowActions(it) }.orEmpty()
    if (actions.isEmpty() && openResources == null && onFind == null) return
    key(thread?.id) {
        var menu by remember { mutableStateOf(false) }
        var delete by remember { mutableStateOf(false) }
        val focus = actionsFocus ?: remember { FocusRequester() }
        if (renameFocus != null) RestoreRenameOriginFocus(renameFocus, focus, onRenameFocusFinished)
        var keyboardFocused by remember { mutableStateOf(false) }
        var restoreFocus by remember { mutableStateOf(false) }
        val busy = thread?.id in state.pendingRowActions

        Box {
            IconButton(
                onClick = {
                    restoreFocus = keyboardFocused
                    menu = true
                },
                modifier =
                    Modifier.size(48.dp).focusRequester(focus).onFocusChanged {
                        keyboardFocused = it.isFocused
                    },
            ) {
                Icon(
                    painterResource(R.drawable.ic_more_horiz),
                    stringResource(R.string.chat_actions),
                )
            }
            if (menu) {
                val readingActions =
                    listOfNotNull(
                        onFind?.let { find ->
                            WorkspaceMenuItem(
                                stringResource(R.string.conversation_find),
                                R.drawable.ic_search,
                            ) {
                                menu = false
                                find(restoreFocus)
                            }
                        },
                        openResources?.let { open ->
                            WorkspaceMenuItem(
                                stringResource(R.string.chat_resources),
                                R.drawable.ic_folder,
                            ) {
                                menu = false
                                open(restoreFocus)
                            }
                        },
                    )
                WorkspaceMenu(
                    items =
                        readingActions +
                            actions.map { action ->
                                WorkspaceMenuItem(
                                    if (action == ChatRowAction.MoveProject)
                                        projectMoveLabel(
                                            state
                                                .projectDestinations(checkNotNull(thread))
                                                .singleOrNull(),
                                        )
                                    else stringResource(action.label()),
                                    action.icon(),
                                    enabled = !busy,
                                    destructive = action == ChatRowAction.Delete,
                                ) {
                                    menu = false
                                    when (action) {
                                        ChatRowAction.Rename -> {
                                            onRename(checkNotNull(thread).id, restoreFocus)
                                            restoreFocus = false
                                        }
                                        ChatRowAction.Delete -> delete = true
                                        ChatRowAction.MoveProject -> onMove(checkNotNull(thread).id)
                                        else -> onRowAction(checkNotNull(thread).id, action)
                                    }
                                }
                            },
                    close = { menu = false },
                    separatorBefore = readingActions.size.takeIf { onFind != null },
                )
            }
        }
        if (delete && thread != null)
            DeleteChatDialog(
                chatName = thread.title,
                enabled = !busy && ChatRowAction.Delete in actions,
                dismiss = { delete = false },
                confirm = {
                    delete = false
                    onRowAction(thread.id, ChatRowAction.Delete)
                },
            )
        LaunchedEffect(menu, delete) {
            if (!menu && !delete && restoreFocus) {
                restoreFocus = false
                focus.requestFocus()
            }
        }
    }
}

@Composable
internal fun NewConversationWelcome(modifier: Modifier = Modifier) {
    val window = currentWindowSizeDp()
    val wide = isAtLeastMediumWindowWidth(window.width)
    val short = isShortWindowHeight(window.height)
    val textAlignment = if (short) TextAlign.Start else TextAlign.Center
    Box(modifier.fillMaxSize(), contentAlignment = Alignment.Center) {
        Column(
            Modifier.fillMaxWidth()
                .verticalScroll(rememberScrollState())
                .padding(horizontal = if (wide) 32.dp else 24.dp)
                .padding(vertical = 12.dp),
            horizontalAlignment = if (short) Alignment.Start else Alignment.CenterHorizontally,
            verticalArrangement = Arrangement.Center,
        ) {
            if (!short)
                Image(
                    painterResource(R.drawable.ic_okou_welcome_avatar),
                    contentDescription = null,
                    modifier = Modifier.padding(bottom = 22.dp).size(68.dp),
                )
            Text(
                stringResource(R.string.conversation_welcome),
                textAlign = textAlignment,
                style =
                    MaterialTheme.typography.headlineSmall.copy(
                        fontSize =
                            when {
                                short -> 20.sp
                                wide -> 30.sp
                                else -> 28.sp
                            },
                        lineHeight =
                            when {
                                short -> 28.sp
                                wide -> 38.sp
                                else -> 36.sp
                            },
                        fontWeight = FontWeight.Medium,
                        letterSpacing = 0.sp,
                    ),
            )
            Text(
                stringResource(R.string.conversation_welcome_detail),
                Modifier.padding(top = if (short) 4.dp else 12.dp),
                style =
                    MaterialTheme.typography.bodyMedium.copy(fontSize = 14.sp, lineHeight = 24.sp),
                color = MaterialTheme.colorScheme.onSurfaceVariant,
                textAlign = textAlignment,
            )
        }
    }
}
