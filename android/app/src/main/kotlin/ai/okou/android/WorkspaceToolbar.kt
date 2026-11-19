package ai.okou.android

import ai.okou.android.chat.ChatListFilter
import ai.okou.android.chat.label
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.selection.selectable
import androidx.compose.foundation.selection.selectableGroup
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.FilterChip
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.RadioButton
import androidx.compose.material3.RadioButtonDefaults
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
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
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.onClick
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp

@Composable
internal fun AppliedChatFilter(filter: ChatListFilter, clear: () -> Unit) {
    val clearLabel = stringResource(R.string.chat_clear_filter)
    Box(Modifier.widthIn(max = 720.dp).fillMaxWidth().padding(horizontal = 24.dp)) {
        FilterChip(
            selected = true,
            onClick = clear,
            label = { Text(stringResource(filter.label())) },
            trailingIcon = {
                Icon(painterResource(R.drawable.ic_close), null, Modifier.size(16.dp))
            },
            modifier = Modifier.semantics { onClick(label = clearLabel, action = null) },
        )
    }
}

@Composable
internal fun WorkspaceToolbarActions(
    showFilter: Boolean,
    filter: ChatListFilter,
    selectFilter: (ChatListFilter) -> Unit,
    openUpdate: (() -> Unit)?,
    settingsFocus: FocusRequester,
    openSettings: (restoreFocus: Boolean) -> Unit,
) {
    var filterOpen by remember(showFilter) { mutableStateOf(false) }
    var anchorFocused by remember { mutableStateOf(false) }
    val settingsAnchor =
        Modifier.focusRequester(settingsFocus).onFocusChanged { anchorFocused = it.isFocused }
    val foreground = MaterialTheme.colorScheme.onSurface
    val textButtonColors = ButtonDefaults.textButtonColors(contentColor = foreground)
    if (openUpdate == null) {
        if (showFilter) {
            IconButton(onClick = { filterOpen = true }) {
                Icon(
                    painterResource(R.drawable.ic_filter_list),
                    stringResource(R.string.chat_filter),
                )
            }
        }
        IconButton(modifier = settingsAnchor, onClick = { openSettings(anchorFocused) }) {
            Icon(painterResource(R.drawable.ic_settings), stringResource(R.string.settings))
        }
    } else {
        val updateIconSize = 24.dp
        TextButton(
            onClick = openUpdate,
            // Preserve the label's width budget when adding the leading icon.
            modifier = Modifier.widthIn(max = 136.dp + updateIconSize + ButtonDefaults.IconSpacing),
            colors = textButtonColors,
        ) {
            Icon(
                painterResource(R.drawable.ic_download),
                contentDescription = null,
                modifier = Modifier.size(updateIconSize),
            )
            Spacer(Modifier.width(ButtonDefaults.IconSpacing))
            Text(
                stringResource(R.string.updates_view),
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
            )
        }
        Box {
            var expanded by remember(showFilter) { mutableStateOf(false) }
            var restoreAnchor by remember { mutableStateOf(false) }
            IconButton(
                modifier = settingsAnchor,
                onClick = {
                    restoreAnchor = anchorFocused
                    expanded = true
                },
            ) {
                Icon(
                    painterResource(R.drawable.ic_more_horiz),
                    stringResource(R.string.chat_more_actions),
                )
            }
            DropdownMenu(expanded = expanded, onDismissRequest = { expanded = false }) {
                if (showFilter) {
                    DropdownMenuItem(
                        text = { Text(stringResource(R.string.chat_filter)) },
                        leadingIcon = {
                            Icon(
                                painterResource(R.drawable.ic_filter_list),
                                contentDescription = null,
                            )
                        },
                        onClick = {
                            expanded = false
                            filterOpen = true
                        },
                    )
                }
                DropdownMenuItem(
                    text = { Text(stringResource(R.string.settings)) },
                    leadingIcon = {
                        Icon(painterResource(R.drawable.ic_settings), contentDescription = null)
                    },
                    onClick = {
                        expanded = false
                        openSettings(restoreAnchor)
                    },
                )
            }
        }
    }
    if (filterOpen) {
        val radioColors = RadioButtonDefaults.colors(selectedColor = foreground)
        AlertDialog(
            onDismissRequest = { filterOpen = false },
            title = { Text(stringResource(R.string.chat_filter)) },
            text = {
                Column(Modifier.selectableGroup().verticalScroll(rememberScrollState())) {
                    ChatListFilter.entries.forEach { choice ->
                        Row(
                            Modifier.fillMaxWidth()
                                .heightIn(min = 48.dp)
                                .selectable(
                                    selected = filter == choice,
                                    role = Role.RadioButton,
                                    onClick = {
                                        selectFilter(choice)
                                        filterOpen = false
                                    },
                                )
                                .padding(horizontal = 8.dp),
                            verticalAlignment = Alignment.CenterVertically,
                        ) {
                            RadioButton(
                                selected = filter == choice,
                                onClick = null,
                                colors = radioColors,
                            )
                            Text(stringResource(choice.label()), Modifier.padding(start = 12.dp))
                        }
                    }
                }
            },
            confirmButton = {
                TextButton(onClick = { filterOpen = false }, colors = textButtonColors) {
                    Text(stringResource(R.string.back))
                }
            },
        )
    }
}
