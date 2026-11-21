package ai.okou.android.chat

import ai.okou.android.R
import ai.okou.android.WorkspaceMenu
import ai.okou.android.WorkspaceMenuItem
import ai.okou.android.currentWindowSizeDp
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

@Composable
internal fun ConversationToolbarActions(
    state: ChatListUiState,
    thread: ConfirmedChat?,
    onRowAction: (String, ChatRowAction) -> Unit,
    onRename: (String, String) -> Unit,
    openSettings: ((restoreFocus: Boolean) -> Unit)?,
    settingsFocus: FocusRequester? = null,
) {
    val actions = thread?.let { state.rowActions(it) }.orEmpty()
    if (actions.isEmpty() && openSettings == null) return
    key(thread?.id) {
        var menu by remember { mutableStateOf(false) }
        var rename by remember { mutableStateOf(false) }
        var delete by remember { mutableStateOf(false) }
        val focus = settingsFocus ?: remember { FocusRequester() }
        var keyboardFocused by remember { mutableStateOf(false) }
        var restoreFocus by remember { mutableStateOf(false) }
        val busy = state.offline || thread?.id in state.pendingRowActions

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
            if (menu)
                WorkspaceMenu(
                    items =
                        actions.map { action ->
                            WorkspaceMenuItem(
                                stringResource(action.label()),
                                action.icon(),
                                enabled = !busy,
                                destructive = action == ChatRowAction.Delete,
                            ) {
                                menu = false
                                when (action) {
                                    ChatRowAction.Rename -> rename = true
                                    ChatRowAction.Delete -> delete = true
                                    else -> onRowAction(checkNotNull(thread).id, action)
                                }
                            }
                        } +
                            listOfNotNull(
                                openSettings?.let {
                                    WorkspaceMenuItem(
                                        stringResource(R.string.settings),
                                        R.drawable.ic_settings,
                                    ) {
                                        menu = false
                                        it(restoreFocus)
                                    }
                                }
                            ),
                    close = { menu = false },
                )
        }
        if (rename && thread != null)
            RenameListItemDialog(
                currentName = thread.title.orEmpty(),
                titleRes = R.string.chat_rename,
                labelRes = R.string.chat_title_field,
                enabled = !busy && ChatRowAction.Rename in actions,
                dismiss = { rename = false },
                save = { title ->
                    onRename(thread.id, title)
                    rename = false
                },
            )
        if (delete && thread != null)
            DeleteChatDialog(
                enabled = !busy && ChatRowAction.Delete in actions,
                dismiss = { delete = false },
                confirm = {
                    delete = false
                    onRowAction(thread.id, ChatRowAction.Delete)
                },
            )
        LaunchedEffect(menu, rename, delete) {
            if (!menu && !rename && !delete && restoreFocus) {
                restoreFocus = false
                focus.requestFocus()
            }
        }
    }
}

@Composable
internal fun NewConversationWelcome(modifier: Modifier = Modifier) {
    val window = currentWindowSizeDp()
    val wide = window.width >= 600
    val short = window.height < 480
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
                    painterResource(R.drawable.okou_mark),
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
