package ai.okou.android.chat

import ai.okou.android.R
import ai.okou.android.connectors.ChatConnectorAccount
import ai.okou.android.connectors.ChatConnectorOptions
import ai.okou.android.connectors.ChatConnectorOverride
import ai.okou.android.connectors.ConnectorAccountStatus
import ai.okou.android.connectors.ConnectorAccountTarget
import ai.okou.android.connectors.ConnectorButton
import ai.okou.android.connectors.ConnectorButtonTreatment
import ai.okou.android.connectors.ConnectorLoadWhenOnline
import ai.okou.android.connectors.ConnectorMark
import ai.okou.android.connectors.ConnectorReadError
import ai.okou.android.connectors.ConnectorReadFailure
import ai.okou.android.connectors.ConnectorSheet
import ai.okou.android.connectors.ConnectorSkeleton
import ai.okou.android.connectors.connectorAccountStatus
import ai.okou.android.connectors.connectorBodyType
import ai.okou.android.connectors.connectorFeedbackType
import ai.okou.android.connectors.connectorSmallType
import ai.okou.android.connectors.label
import ai.okou.android.connectors.needsAttention
import ai.okou.android.currentWindowSizeDp
import ai.okou.android.state.ComposerOptionsPage
import ai.okou.android.state.ComposerOptionsPresentation
import ai.okou.android.state.rememberComposerOptions
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ExperimentalLayoutApi
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.isImeVisible
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.selection.toggleable
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Checkbox
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.key
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.runtime.withFrameNanos
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.focus.FocusRequester
import androidx.compose.ui.focus.focusRequester
import androidx.compose.ui.platform.LocalFocusManager
import androidx.compose.ui.platform.LocalSoftwareKeyboardController
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.LiveRegionMode
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.semantics.liveRegion
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.unit.dp
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.compose.LocalLifecycleOwner
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.lifecycle.repeatOnLifecycle

@OptIn(ExperimentalLayoutApi::class)
@Composable
internal fun ChatConnectorOptionsButton(
    options: ChatConnectorOptions,
    composer: ChatComposerModel,
    composerState: ComposerState,
    target: ComposerTarget,
    offline: Boolean,
    editorFocused: Boolean,
    editorFocus: FocusRequester,
    manageConnectors: (ConnectorAccountTarget?) -> Unit,
) {
    var presentation by rememberComposerOptions(target.key)
    val buttonFocus = remember { FocusRequester() }
    val entryFocus = remember { FocusRequester() }
    val accountFocus = remember { FocusRequester() }
    val focus = LocalFocusManager.current
    val keyboard = LocalSoftwareKeyboardController.current
    val imeVisible = WindowInsets.isImeVisible
    var restoreTrigger by remember { mutableStateOf(false) }
    var restoreEntry by remember { mutableStateOf(false) }
    var restoredAccount by remember { mutableStateOf<String?>(null) }
    var sheetGeneration by remember { mutableIntStateOf(0) }
    val page = presentation.page

    LaunchedEffect(page, restoreTrigger, restoreEntry) {
        when {
            page == ComposerOptionsPage.Closed && restoreTrigger -> {
                withFrameNanos {}
                if (presentation.restoreEditor) {
                    editorFocus.requestFocus()
                    if (presentation.restoreKeyboard) keyboard?.show()
                } else buttonFocus.requestFocus()
                restoreTrigger = false
                presentation = ComposerOptionsPresentation()
            }
            page == ComposerOptionsPage.Options && restoreEntry -> {
                withFrameNanos {}
                entryFocus.requestFocus()
                restoreEntry = false
            }
        }
    }

    IconButton(
        onClick = {
            presentation =
                ComposerOptionsPresentation(ComposerOptionsPage.Options, editorFocused, imeVisible)
            focus.clearFocus()
            keyboard?.hide()
        },
        modifier = Modifier.focusRequester(buttonFocus).size(48.dp).testTag("chat-options-button"),
    ) {
        Icon(
            painterResource(R.drawable.ic_add),
            stringResource(R.string.chat_options_title),
            modifier = Modifier.size(24.dp),
            tint = MaterialTheme.colorScheme.onSurfaceVariant,
        )
    }
    if (page == ComposerOptionsPage.Closed) return

    val showingAccounts = page == ComposerOptionsPage.Connectors
    val state = options.state.collectAsStateWithLifecycle().value.takeIf { it.target == target.key }
    val reading = state?.read
    val groups = reading?.data
    val save = state?.save
    val saving = save?.saving == true
    val lifecycle = LocalLifecycleOwner.current.lifecycle
    LaunchedEffect(options, target, showingAccounts, offline, lifecycle) {
        if (showingAccounts)
            lifecycle.repeatOnLifecycle(Lifecycle.State.STARTED) {
                options.show(target, offline)
            }
    }

    fun back() {
        if (saving) return
        options.close(target)
        if (showingAccounts) {
            presentation =
                presentation.copy(page = ComposerOptionsPage.Options, returnAccount = null)
            restoreEntry = true
        } else {
            presentation = presentation.copy(page = ComposerOptionsPage.Closed)
            restoreTrigger = true
        }
    }

    fun openDirectory(account: ConnectorAccountTarget?) {
        presentation = presentation.copy(returnAccount = account?.connectionId.orEmpty())
        manageConnectors(account)
    }

    val returnAccount = presentation.returnAccount
    val accountToFocus = returnAccount ?: restoredAccount
    val focusAccount = accountToFocus?.takeIf { id ->
        groups?.any { group -> group.accounts.any { it.account.id == id } } == true
    }
    LaunchedEffect(showingAccounts, groups, returnAccount) {
        if (showingAccounts && groups != null && returnAccount != null) {
            withFrameNanos {}
            accountFocus.requestFocus()
            restoredAccount = returnAccount
            presentation = presentation.copy(returnAccount = null)
        }
    }

    val title = if (showingAccounts) R.string.connector_title else R.string.chat_options_title
    key(sheetGeneration) {
        ConnectorSheet(
            stringResource(title),
            dismiss = {
                // Material has already hidden the sheet. Start a fresh one for the parent page.
                if (showingAccounts && !saving) sheetGeneration++
                back()
            },
            dismissible = !saving,
            expandInShortWindow = true,
            back = if (showingAccounts || currentWindowSizeDp().height < 480) ::back else null,
        ) {
            if (!showingAccounts) {
                Column(verticalArrangement = Arrangement.spacedBy(4.dp)) {
                    Text(
                        stringResource(R.string.chat_options_settings),
                        modifier = Modifier.padding(start = 12.dp).semantics { heading() },
                        style = connectorSmallType(),
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                    )
                    ConnectorOptionRow(
                        stringResource(R.string.connector_title),
                        onClick = {
                            presentation = presentation.copy(page = ComposerOptionsPage.Connectors)
                        },
                        modifier =
                            Modifier.focusRequester(entryFocus).testTag("chat-options-connectors"),
                    )
                }
            } else if (groups == null) {
                when {
                    reading?.failure == ConnectorReadFailure.Unavailable ->
                        ConnectorReadError(R.string.connector_accounts_failed)
                    offline -> ConnectorLoadWhenOnline()
                    reading?.failure != null ->
                        ConnectorReadError(R.string.connector_accounts_failed)
                    else ->
                        ConnectorSkeleton(
                            stringResource(R.string.connector_loading_accounts),
                            rows = 2,
                        )
                }
            } else {
                val newChat = target.threadId == null
                val draftChoices =
                    composerState.connectorOverrides(target).associateBy { it.connectionId }
                val canEdit =
                    !saving &&
                        if (newChat) composerState.canEditDraftConnectors(target) else !offline
                Text(
                    stringResource(R.string.chat_connector_scope),
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                    style = connectorSmallType(),
                )
                if (groups.isEmpty()) ConnectorOptionFeedback(R.string.chat_connector_empty)
                for (group in groups) {
                    Column {
                        Row(
                            Modifier.padding(start = 12.dp, top = 4.dp, bottom = 4.dp),
                            horizontalArrangement = Arrangement.spacedBy(8.dp),
                            verticalAlignment = Alignment.CenterVertically,
                        ) {
                            ConnectorMark(
                                group.entry.icon,
                                20.dp,
                                Modifier.background(
                                    MaterialTheme.colorScheme.surfaceVariant,
                                    RoundedCornerShape(4.dp),
                                ),
                            )
                            Text(
                                group.entry.name,
                                Modifier.semantics { heading() },
                                style = connectorBodyType(),
                            )
                        }
                        for (row in group.accounts) {
                            key(row.account.id) {
                                val id = row.account.id
                                val chosen =
                                    if (newChat) draftChoices[id]?.enabled else row.override
                                val enabled = chosen ?: (row.account.defaultEnabled == true)
                                val choice = ChatConnectorOverride(group.entry.slug, id, !enabled)
                                ChatConnectorRow(
                                    row,
                                    enabled,
                                    canEdit,
                                    canManage = !saving,
                                    modifier =
                                        if (id == focusAccount)
                                            Modifier.focusRequester(accountFocus)
                                        else Modifier,
                                    onToggle = {
                                        if (newChat) composer.editConnectorOverride(target, choice)
                                        else options.save(target, listOf(choice))
                                    },
                                    onRepair = {
                                        openDirectory(ConnectorAccountTarget(group.entry.slug, id))
                                    },
                                )
                                if (save?.choice?.connectionId == id) {
                                    ConnectorOptionFeedback(
                                        if (saving) R.string.chat_connector_saving
                                        else R.string.chat_connector_save_failed,
                                        Modifier.padding(start = 12.dp),
                                    )
                                }
                            }
                        }
                    }
                }
                if (newChat && composerState.persistence == ComposerPersistence.Failed)
                    ConnectorOptionFeedback(R.string.composer_local_failed)
                if (reading.failure != null)
                    ConnectorOptionFeedback(R.string.connector_refresh_failed)
                val resets = groups.flatMap { group ->
                    group.accounts
                        .filter { it.override != null }
                        .map {
                            ChatConnectorOverride(group.entry.slug, it.account.id, null)
                        }
                }
                if (
                    if (newChat) draftChoices.values.any { it.enabled != null }
                    else resets.isNotEmpty()
                ) {
                    ConnectorButton(
                        stringResource(R.string.chat_connector_restore_defaults),
                        onClick = {
                            if (newChat) composer.editConnectorOverride(target, null)
                            else options.save(target, resets)
                        },
                        enabled = canEdit,
                        modifier = Modifier.testTag("chat-connector-reset"),
                        treatment = ConnectorButtonTreatment.Text,
                    )
                }
                val manageFocus =
                    if (accountToFocus != null && focusAccount == null)
                        Modifier.focusRequester(accountFocus)
                    else Modifier
                ConnectorOptionRow(
                    stringResource(R.string.chat_connector_manage),
                    onClick = { openDirectory(null) },
                    enabled = !saving,
                    modifier = manageFocus.testTag("chat-connector-manage"),
                )
            }
        }
    }
}

@Composable
private fun ChatConnectorRow(
    row: ChatConnectorAccount,
    enabled: Boolean,
    canEdit: Boolean,
    canManage: Boolean,
    modifier: Modifier,
    onToggle: () -> Unit,
    onRepair: () -> Unit,
) {
    val account = row.account
    val canToggle = canEdit && account.status == ConnectorAccountStatus.Connected
    val action =
        if (account.status.needsAttention)
            Modifier.testTag("chat-connector-repair-${account.id}")
                .clickable(
                    enabled = canManage,
                    role = Role.Button,
                    onClick = onRepair,
                )
        else
            Modifier.testTag("chat-connector-selection-${account.id}")
                .toggleable(
                    value = enabled,
                    enabled = canToggle,
                    role = Role.Checkbox,
                    onValueChange = { onToggle() },
                )
    val label = account.label()
    val identity = account.identity?.takeIf { it != label }
    Row(
        modifier
            .fillMaxWidth()
            .heightIn(min = if (identity != null || account.status.needsAttention) 72.dp else 56.dp)
            .clip(RoundedCornerShape(12.dp))
            .then(action)
            .padding(horizontal = 12.dp, vertical = 8.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(12.dp),
    ) {
        Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(4.dp)) {
            Text(label, style = connectorBodyType())
            identity?.let {
                Text(
                    it,
                    style = connectorSmallType(),
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
            }
            if (account.status.needsAttention) {
                Text(
                    connectorAccountStatus(account),
                    style = connectorSmallType(),
                    color = MaterialTheme.colorScheme.error,
                )
            }
        }
        if (account.status.needsAttention)
            Icon(painterResource(R.drawable.ic_chevron_right), null, Modifier.size(24.dp))
        else Checkbox(checked = enabled, onCheckedChange = null, enabled = canToggle)
    }
}

@Composable
private fun ConnectorOptionRow(
    title: String,
    onClick: () -> Unit,
    modifier: Modifier = Modifier,
    enabled: Boolean = true,
) {
    Row(
        modifier
            .fillMaxWidth()
            .heightIn(min = 56.dp)
            .clip(RoundedCornerShape(12.dp))
            .clickable(enabled = enabled, role = Role.Button, onClick = onClick)
            .padding(horizontal = 12.dp),
        horizontalArrangement = Arrangement.spacedBy(12.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Icon(
            painterResource(R.drawable.ic_extension),
            null,
            Modifier.size(24.dp),
            tint = MaterialTheme.colorScheme.onSurfaceVariant,
        )
        Text(title, Modifier.weight(1f), style = connectorBodyType())
        Icon(painterResource(R.drawable.ic_chevron_right), null, Modifier.size(24.dp))
    }
}

@Composable
private fun ConnectorOptionFeedback(message: Int, modifier: Modifier = Modifier) {
    Text(
        stringResource(message),
        modifier.semantics { liveRegion = LiveRegionMode.Polite },
        color = MaterialTheme.colorScheme.onSurfaceVariant,
        style = connectorFeedbackType(),
    )
}
