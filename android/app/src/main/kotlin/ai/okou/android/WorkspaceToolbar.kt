package ai.okou.android

import ai.okou.android.chat.ChatListFilter
import ai.okou.android.chat.ChatListUiState
import ai.okou.android.chat.label
import ai.okou.android.chat.markAllReadTargets
import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.selection.selectableGroup
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.FilterChip
import androidx.compose.material3.FilterChipDefaults
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.focus.FocusRequester
import androidx.compose.ui.focus.focusRequester
import androidx.compose.ui.focus.onFocusChanged
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.onClick
import androidx.compose.ui.semantics.role
import androidx.compose.ui.semantics.selected
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.semantics.stateDescription
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.DpOffset
import androidx.compose.ui.unit.dp

@Composable
internal fun AppliedChatFilter(filter: ChatListFilter, clear: () -> Unit) {
    val clearLabel = stringResource(R.string.chat_clear_filter)
    val colors = MaterialTheme.colorScheme
    Box(
        Modifier.widthIn(max = 720.dp)
            .fillMaxWidth()
            .padding(start = 24.dp, end = 24.dp, bottom = 4.dp)
    ) {
        FilterChip(
            selected = true,
            onClick = clear,
            label = { Text(stringResource(filter.label())) },
            shape = RoundedCornerShape(12.dp),
            colors =
                FilterChipDefaults.filterChipColors(
                    selectedContainerColor = colors.surfaceVariant,
                    selectedLabelColor = colors.onSurface,
                    selectedTrailingIconColor = colors.onSurface,
                ),
            trailingIcon = {
                Icon(painterResource(R.drawable.ic_close), null, Modifier.size(16.dp))
            },
            modifier =
                Modifier.heightIn(min = 48.dp).semantics {
                    onClick(label = clearLabel, action = null)
                },
        )
    }
}

@Composable
internal fun WorkspaceToolbarActions(
    showFilter: Boolean,
    list: ChatListUiState,
    selectFilter: (ChatListFilter) -> Unit,
    markAllRead: () -> Unit,
    openSearch: (() -> Unit)? = null,
    openUpdate: (() -> Unit)?,
    settingsFocus: FocusRequester,
    openSettings: (restoreFocus: Boolean) -> Unit,
) {
    var filterOpen by remember(showFilter, openUpdate != null) { mutableStateOf(false) }
    var anchorFocused by remember { mutableStateOf(false) }
    val settingsAnchor =
        Modifier.focusRequester(settingsFocus).onFocusChanged { anchorFocused = it.isFocused }
    val foreground = MaterialTheme.colorScheme.onSurface
    val textButtonColors = ButtonDefaults.textButtonColors(contentColor = foreground)
    val filterMenu =
        @Composable {
            ChatFilterMenu(
                expanded = filterOpen,
                close = { filterOpen = false },
                filter = list.filter,
                selectFilter = selectFilter,
                canMarkAllRead =
                    filterOpen && remember(list) { list.markAllReadTargets().isNotEmpty() },
                markAllRead = markAllRead,
            )
        }
    if (openUpdate == null) {
        if (showFilter) {
            Box {
                val currentFilter = stringResource(list.filter.label())
                IconButton(
                    onClick = { filterOpen = true },
                    modifier = Modifier.semantics { stateDescription = currentFilter },
                ) {
                    Icon(
                        painterResource(R.drawable.ic_filter_list),
                        stringResource(R.string.chat_filter),
                    )
                }
                filterMenu()
            }
        }
        if (openSearch != null) {
            IconButton(onClick = openSearch) {
                Icon(painterResource(R.drawable.ic_search), stringResource(R.string.chat_search))
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
                if (openSearch != null) {
                    DropdownMenuItem(
                        text = { Text(stringResource(R.string.chat_search)) },
                        leadingIcon = {
                            Icon(painterResource(R.drawable.ic_search), contentDescription = null)
                        },
                        onClick = {
                            expanded = false
                            openSearch()
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
            filterMenu()
        }
    }
}

@Composable
private fun ChatFilterMenu(
    expanded: Boolean,
    close: () -> Unit,
    filter: ChatListFilter,
    selectFilter: (ChatListFilter) -> Unit,
    canMarkAllRead: Boolean,
    markAllRead: () -> Unit,
) {
    val colors = MaterialTheme.colorScheme
    val item = Modifier.padding(horizontal = 6.dp).clip(RoundedCornerShape(10.dp))
    DropdownMenu(
        expanded = expanded,
        onDismissRequest = close,
        modifier = Modifier.width(244.dp),
        offset = DpOffset(0.dp, 4.dp),
        shape = RoundedCornerShape(16.dp),
        containerColor = colors.surface,
        shadowElevation = 6.dp,
        border = BorderStroke(1.dp, colors.outline),
    ) {
        DropdownMenuItem(
            modifier = item,
            enabled = canMarkAllRead,
            text = {
                Text(
                    stringResource(R.string.chat_mark_all_read),
                    style = MaterialTheme.typography.bodyMedium,
                )
            },
            leadingIcon = {
                Icon(painterResource(R.drawable.ic_done_all), null, Modifier.size(18.dp))
            },
            onClick = {
                close()
                markAllRead()
            },
        )
        HorizontalDivider(Modifier.padding(horizontal = 12.dp, vertical = 5.dp))
        Column(Modifier.selectableGroup()) {
            ChatListFilter.entries.forEach { choice ->
                DropdownMenuItem(
                    modifier =
                        item.semantics {
                            role = Role.RadioButton
                            selected = filter == choice
                        },
                    text = {
                        Text(
                            stringResource(choice.label()),
                            style = MaterialTheme.typography.bodyMedium,
                        )
                    },
                    trailingIcon =
                        if (filter == choice) {
                            {
                                Icon(
                                    painterResource(R.drawable.ic_check),
                                    null,
                                    Modifier.size(18.dp),
                                )
                            }
                        } else null,
                    onClick = {
                        selectFilter(choice)
                        close()
                    },
                )
            }
        }
    }
}
