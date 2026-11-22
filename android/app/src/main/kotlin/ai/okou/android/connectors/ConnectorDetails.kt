package ai.okou.android.connectors

import ai.okou.android.OkouSwitch
import ai.okou.android.R
import ai.okou.android.SettingsModal
import ai.okou.android.chat.ChatSkeletonBlock
import ai.okou.android.chat.rememberChatWaitIndicator
import ai.okou.android.currentWindowSizeDp
import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.selection.toggleable
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
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
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.res.pluralStringResource
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.LiveRegionMode
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.semantics.liveRegion
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp

private enum class ConnectorPanel {
    Account,
    Rename,
    Authorize,
    Permissions,
}

@Composable
internal fun ConnectorDetails(
    model: ConnectorModel,
    state: ConnectorUiState,
    preview: ConnectorEntry?,
    wide: Boolean,
) {
    val detail = state.detail.data
    val entry = detail?.entry ?: preview
    val accounts = state.accounts.data ?: entry?.slug?.let(state::accountsFor).orEmpty()
    val hasAccountContent = state.accounts.data != null || accounts.isNotEmpty()
    var panel by remember { mutableStateOf<ConnectorPanel?>(null) }
    var accountId by remember { mutableStateOf<String?>(null) }
    var confirmingDisconnect by remember { mutableStateOf(false) }
    var restoreAccountFocus by remember { mutableStateOf(false) }
    var restoreActionFocus by remember { mutableStateOf<FocusRequester?>(null) }
    val accountFocus = remember { FocusRequester() }
    val addFocus = remember { FocusRequester() }
    val permissionsFocus = remember { FocusRequester() }
    val renameFocus = remember { FocusRequester() }
    val reauthorizeFocus = remember { FocusRequester() }
    val disconnectFocus = remember { FocusRequester() }
    val account = accounts.find { it.id == accountId }
    val action = state.action?.takeIf { it.target.slug == entry?.slug }
    val busy = action?.busy == true
    val otherAction = state.action?.takeIf { it.target.slug != entry?.slug }
    val canModify =
        !state.offline &&
            !busy &&
            action?.reconciling != true &&
            state.accounts.data != null &&
            otherAction?.let { it.busy || it.reconciling || it.authorization != null } != true
    val color = MaterialTheme.colorScheme

    fun dismissPanel() {
        if (busy) return
        val previous = panel
        if (previous == ConnectorPanel.Permissions) model.hidePermissions()
        model.dismissAction()
        when (previous) {
            ConnectorPanel.Rename,
            ConnectorPanel.Authorize -> {
                panel = if (account != null) ConnectorPanel.Account else null
                if (account != null) {
                    restoreActionFocus =
                        if (previous == ConnectorPanel.Rename) renameFocus else reauthorizeFocus
                }
            }
            else -> panel = null
        }
        if (panel == null) {
            if (previous == ConnectorPanel.Permissions) permissionsFocus.requestFocus()
            else if (account != null) restoreAccountFocus = true
            else if (detail != null && detail.methods.isNotEmpty() && state.accounts.data != null)
                addFocus.requestFocus()
        }
    }

    LaunchedEffect(panel, confirmingDisconnect, restoreActionFocus, canModify) {
        if (
            panel == ConnectorPanel.Account && account != null && !confirmingDisconnect && canModify
        ) {
            val target = restoreActionFocus ?: return@LaunchedEffect
            restoreActionFocus = null
            if (target !== reauthorizeFocus || account.status.needsAttention) target.requestFocus()
        }
    }

    LaunchedEffect(action?.authorization) {
        if (panel == null && action?.authorization != null && !action.reconciling) {
            accountId = action.target.connectionId
            panel = ConnectorPanel.Authorize
        }
    }

    LaunchedEffect(action?.result, action?.busy) {
        if (action == null || action.busy) return@LaunchedEffect
        when (action.result) {
            ConnectorResult.Disconnected -> {
                if (panel == ConnectorPanel.Account && accountId == action.target.connectionId) {
                    confirmingDisconnect = false
                    panel = null
                    accountId = null
                    if (detail?.methods?.isNotEmpty() == true) addFocus.requestFocus()
                }
                model.clearImpact()
                model.dismissAction()
            }
            ConnectorResult.Renamed -> {
                if (panel == ConnectorPanel.Rename && accountId == action.target.connectionId)
                    panel = ConnectorPanel.Account
                model.dismissAction()
            }
            ConnectorResult.Authorized -> {
                if (panel == ConnectorPanel.Authorize) {
                    panel = if (account != null) ConnectorPanel.Account else null
                    if (panel == null && detail?.methods?.isNotEmpty() == true)
                        addFocus.requestFocus()
                }
                model.dismissAction()
            }
            null -> Unit
        }
    }

    Box(
        Modifier.fillMaxSize().padding(horizontal = if (wide) 32.dp else 20.dp),
        contentAlignment = Alignment.TopCenter,
    ) {
        Column(
            Modifier.widthIn(max = 666.dp)
                .fillMaxWidth()
                .verticalScroll(rememberScrollState())
                .padding(top = if (wide) 28.dp else 20.dp, bottom = 24.dp)
                .testTag("connector-detail")
        ) {
            if (entry != null) {
                Row(horizontalArrangement = Arrangement.spacedBy(12.dp)) {
                    ConnectorIcon(entry, large = true)
                    Column(verticalArrangement = Arrangement.spacedBy(4.dp)) {
                        Text(
                            entry.name,
                            style =
                                MaterialTheme.typography.headlineSmall.copy(
                                    fontSize = 24.sp,
                                    lineHeight = 32.sp,
                                    letterSpacing = 0.sp,
                                    fontWeight = FontWeight.SemiBold,
                                ),
                            modifier = Modifier.semantics { heading() },
                        )
                        if (entry.description.isNotBlank()) {
                            Text(
                                entry.description,
                                style = connectorBodyType(),
                                color = color.onSurfaceVariant,
                            )
                        }
                    }
                }
                if (entry.description.isNotBlank()) Spacer(Modifier.height(12.dp))
                ConnectorSectionDivider()
                Text(
                    stringResource(R.string.connector_accounts),
                    style = connectorBodyType().copy(fontWeight = FontWeight.SemiBold),
                    modifier = Modifier.semantics { heading() },
                )
                Spacer(Modifier.height(8.dp))
                for (saved in accounts) {
                    val target = saved.id == accountId
                    ConnectorAccountRow(
                        saved,
                        if (target) Modifier.focusRequester(accountFocus) else Modifier,
                    ) {
                        model.dismissAction()
                        accountId = saved.id
                        panel = ConnectorPanel.Account
                    }
                }
                LaunchedEffect(restoreAccountFocus, account?.id) {
                    if (restoreAccountFocus && account != null) {
                        restoreAccountFocus = false
                        accountFocus.requestFocus()
                    }
                }

                if (!hasAccountContent && !state.offline) {
                    if (state.accounts.failure == null) {
                        ConnectorSkeleton(
                            stringResource(R.string.connector_loading_accounts),
                            rows = 1,
                        )
                    } else {
                        ConnectorStatusBanner(R.string.connector_accounts_failed)
                    }
                }
                if (detail != null && state.accounts.data != null) {
                    Spacer(Modifier.height(8.dp))
                    if (detail.methods.isNotEmpty()) {
                        val label =
                            if (accounts.isEmpty()) R.string.connector_connect
                            else R.string.connector_add
                        ConnectorButton(
                            stringResource(label),
                            onClick = {
                                model.dismissAction()
                                accountId = null
                                panel = ConnectorPanel.Authorize
                            },
                            modifier =
                                (if (wide) Modifier else Modifier.fillMaxWidth()).focusRequester(
                                    addFocus
                                ),
                            enabled = canModify,
                            treatment =
                                if (accounts.isEmpty()) ConnectorButtonTreatment.Primary
                                else ConnectorButtonTreatment.Outline,
                        )
                    } else if (accounts.isEmpty()) {
                        Text(
                            stringResource(R.string.connector_no_method),
                            style = connectorFeedbackType(),
                            color = color.onSurfaceVariant,
                        )
                    }
                }
                if (detail?.hasPermissions == true) {
                    ConnectorSectionDivider()
                    ConnectorAccountAction(
                        stringResource(R.string.connector_permissions),
                        modifier = Modifier.focusRequester(permissionsFocus),
                        chevron = true,
                    ) {
                        panel = ConnectorPanel.Permissions
                        model.showPermissions()
                    }
                }
                if (state.offline) ConnectorStatusBanner(R.string.connector_offline_action)
                else if (detail == null && state.detail.failure != null) {
                    ConnectorStatusBanner(R.string.connector_load_failed)
                } else if (
                    state.detail.failure == ConnectorReadFailure.Sustained ||
                        hasAccountContent &&
                            state.accounts.failure == ConnectorReadFailure.Sustained
                ) {
                    ConnectorStatusBanner(R.string.connector_refresh_failed)
                }
                if (panel == null) ConnectorActionFeedback(action)
            } else if (!state.offline && state.detail.failure == null) {
                if (rememberChatWaitIndicator(waiting = true)) {
                    val label = stringResource(R.string.connector_loading)
                    Column(
                        Modifier.fillMaxWidth().semantics { contentDescription = label },
                        verticalArrangement = Arrangement.spacedBy(12.dp),
                    ) {
                        ChatSkeletonBlock(
                            Modifier.widthIn(max = 220.dp).fillMaxWidth().height(24.dp)
                        )
                        ChatSkeletonBlock(
                            Modifier.widthIn(max = 300.dp).fillMaxWidth().height(14.dp)
                        )
                    }
                }
            } else {
                ConnectorStatusBanner(
                    if (state.offline) R.string.connector_offline
                    else R.string.connector_load_failed
                )
            }
        }
    }

    if (panel != null && entry != null) {
        ConnectorSheet(::dismissPanel, dismissible = !busy) {
            if (panel != ConnectorPanel.Permissions && accountId != null && account == null) {
                ConnectorStatusBanner(R.string.connector_account_unavailable)
                ConnectorActionFeedback(action)
                ConnectorButton(
                    stringResource(R.string.updates_close),
                    ::dismissPanel,
                    enabled = !busy,
                    treatment = ConnectorButtonTreatment.Text,
                )
                return@ConnectorSheet
            }
            when (panel) {
                ConnectorPanel.Permissions ->
                    ConnectorPermissionSheet(
                        entry.name,
                        state.permissions,
                        state.offline,
                        ::dismissPanel,
                    )
                ConnectorPanel.Account ->
                    if (account != null) {
                        ConnectorAccountSheet(
                            account,
                            canModify,
                            action?.takeIf { it.target.connectionId == account.id },
                            state.offline,
                            onDefault = { model.setDefaultEnabled(account.id, it) },
                            renameFocus = renameFocus,
                            reauthorizeFocus = reauthorizeFocus,
                            disconnectFocus = disconnectFocus,
                            rename = {
                                model.dismissAction()
                                panel = ConnectorPanel.Rename
                            },
                            reauthorize = {
                                model.dismissAction()
                                panel = ConnectorPanel.Authorize
                            },
                            disconnect = {
                                model.dismissAction()
                                confirmingDisconnect = true
                                model.prepareDisconnect(account.id)
                            },
                        )
                    }
                ConnectorPanel.Rename ->
                    if (account != null) {
                        ConnectorRenameSheet(
                            account,
                            canModify,
                            action,
                            save = { model.rename(account.id, it) },
                            cancel = ::dismissPanel,
                        )
                    }
                ConnectorPanel.Authorize ->
                    if (detail != null) {
                        ConnectorAuthorizationSheet(
                            model,
                            detail,
                            account,
                            canModify,
                            action,
                            state.offline,
                            ::dismissPanel,
                        )
                    }
                null -> Unit
            }
        }
    }

    if (confirmingDisconnect && account != null) {
        ConnectorDisconnectDialog(
            account,
            state.impact?.takeIf { it.accountId == account.id }?.read,
            canModify,
            action,
            state.offline,
            confirm = { model.disconnect(account.id) },
            cancel = {
                if (!busy) {
                    confirmingDisconnect = false
                    restoreActionFocus = disconnectFocus
                    model.clearImpact()
                    model.dismissAction()
                }
            },
        )
    }
}

@Composable
private fun ConnectorAccountRow(
    account: ConnectorSavedAccount,
    modifier: Modifier,
    open: () -> Unit,
) {
    Row(
        modifier
            .fillMaxWidth()
            .heightIn(min = 52.dp)
            .clip(RoundedCornerShape(8.dp))
            .clickable(onClick = open, role = Role.Button)
            .padding(horizontal = 12.dp, vertical = 8.dp)
            .testTag("connector-account-${account.id}"),
        horizontalArrangement = Arrangement.spacedBy(12.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(4.dp)) {
            Text(
                account.label(),
                style = connectorBodyType().copy(fontWeight = FontWeight.SemiBold),
            )
            if (
                account.displayName != null &&
                    account.identity != null &&
                    account.displayName != account.identity
            ) {
                Text(
                    account.identity,
                    style = connectorSmallType(),
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
            }
            ConnectorAccountStatusText(account)
        }
        ConnectorChevron()
    }
}

@Composable
private fun ConnectorAccountStatusText(account: ConnectorSavedAccount) {
    Text(
        connectorAccountStatus(account),
        style = connectorSmallType(),
        color =
            if (account.status.needsAttention) MaterialTheme.colorScheme.error
            else MaterialTheme.colorScheme.onSurfaceVariant,
    )
}

@Composable
private fun ConnectorSectionDivider() {
    Spacer(Modifier.height(16.dp))
    HorizontalDivider(color = MaterialTheme.colorScheme.outline)
    Spacer(Modifier.height(16.dp))
}

@Composable
private fun ConnectorSheet(
    dismiss: () -> Unit,
    dismissible: Boolean,
    content: @Composable () -> Unit,
) {
    val windowHeight = currentWindowSizeDp().height.dp
    val scroll = rememberScrollState()
    SettingsModal(dismiss, dismissible) { centered ->
        Column(
            Modifier.fillMaxWidth()
                .heightIn(max = windowHeight * 0.80f)
                .testTag("connector-sheet")
                .padding(
                    start = 16.dp,
                    end = 16.dp,
                    top = if (centered) 16.dp else 0.dp,
                    bottom = 16.dp,
                )
                .verticalScroll(scroll),
            verticalArrangement = Arrangement.spacedBy(8.dp),
        ) {
            content()
        }
    }
}

@Composable
private fun ConnectorPermissionSheet(
    service: String,
    permissions: ConnectorRead<List<ConnectorPermission>>,
    offline: Boolean,
    close: () -> Unit,
) {
    ConnectorSheetHeading(stringResource(R.string.connector_permissions_title, service))
    Text(stringResource(R.string.connector_permissions_copy), style = connectorBodyType())
    when {
        permissions.data == null -> {
            if (!offline && permissions.failure == null)
                ConnectorSkeleton(stringResource(R.string.connector_loading_permissions), rows = 1)
        }
        permissions.data.isEmpty() ->
            Text(stringResource(R.string.connector_no_permissions), style = connectorFeedbackType())
        else ->
            Column(
                verticalArrangement = Arrangement.spacedBy(12.dp),
                modifier = Modifier.padding(vertical = 8.dp),
            ) {
                for (permission in permissions.data) {
                    Column(verticalArrangement = Arrangement.spacedBy(4.dp)) {
                        Text(
                            permission.name,
                            style = connectorBodyType().copy(fontWeight = FontWeight.SemiBold),
                        )
                        if (!permission.description.isNullOrBlank()) {
                            Text(
                                permission.description,
                                style = connectorSmallType(),
                                color = MaterialTheme.colorScheme.onSurfaceVariant,
                            )
                        }
                    }
                }
            }
    }
    when {
        offline -> ConnectorStatusBanner(R.string.connector_offline)
        permissions.data == null && permissions.failure != null ->
            ConnectorStatusBanner(R.string.connector_permissions_failed)
        permissions.failure == ConnectorReadFailure.Sustained ->
            ConnectorStatusBanner(R.string.connector_refresh_failed)
    }
    Box(Modifier.fillMaxWidth(), contentAlignment = Alignment.CenterEnd) {
        ConnectorButton(
            stringResource(R.string.updates_close),
            close,
            treatment = ConnectorButtonTreatment.Text,
        )
    }
}

@Composable
private fun ConnectorAccountSheet(
    account: ConnectorSavedAccount,
    canModify: Boolean,
    action: ConnectorAction?,
    offline: Boolean,
    onDefault: (Boolean) -> Unit,
    renameFocus: FocusRequester,
    reauthorizeFocus: FocusRequester,
    disconnectFocus: FocusRequester,
    rename: () -> Unit,
    reauthorize: () -> Unit,
    disconnect: () -> Unit,
) {
    val color = MaterialTheme.colorScheme
    ConnectorSheetHeading(account.label())
    if (
        account.displayName != null &&
            account.identity != null &&
            account.displayName != account.identity
    ) {
        Text(account.identity, color = color.onSurfaceVariant, style = connectorSmallType())
    }
    val defaultEnabled =
        account.defaultEnabled.takeIf { account.status == ConnectorAccountStatus.Connected }
    if (defaultEnabled == null) ConnectorAccountStatusText(account)
    if (offline) ConnectorStatusBanner(R.string.connector_offline_action)
    Column(Modifier.fillMaxWidth()) {
        if (account.status.needsAttention) {
            ConnectorAccountAction(
                stringResource(
                    if (account.status == ConnectorAccountStatus.UpdatePermissions)
                        R.string.connector_update_permissions
                    else R.string.connector_reauthorize
                ),
                enabled = canModify,
                modifier = Modifier.focusRequester(reauthorizeFocus),
                onClick = reauthorize,
            )
        } else if (defaultEnabled != null) {
            ConnectorDefaultSwitch(defaultEnabled, canModify, onDefault)
        }
        ConnectorAccountAction(
            stringResource(R.string.connector_rename),
            modifier = Modifier.focusRequester(renameFocus),
            enabled = canModify,
            onClick = rename,
        )
        ConnectorAccountAction(
            stringResource(R.string.connector_disconnect),
            modifier = Modifier.focusRequester(disconnectFocus),
            enabled = canModify,
            destructive = true,
            onClick = disconnect,
        )
    }
    ConnectorActionFeedback(action)
}

@Composable
private fun ConnectorDefaultSwitch(
    checked: Boolean,
    enabled: Boolean,
    onCheckedChange: (Boolean) -> Unit,
) {
    val color = MaterialTheme.colorScheme
    Row(
        Modifier.fillMaxWidth()
            .heightIn(min = 56.dp)
            .clip(RoundedCornerShape(12.dp))
            .toggleable(
                checked,
                enabled = enabled,
                role = Role.Switch,
                onValueChange = onCheckedChange,
            )
            .padding(horizontal = 16.dp),
        horizontalArrangement = Arrangement.spacedBy(16.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Text(
            stringResource(R.string.connector_default_enabled),
            Modifier.weight(1f),
            color = color.onSurface.copy(alpha = if (enabled) 1f else 0.38f),
            style = connectorBodyType(),
        )
        OkouSwitch(checked, enabled)
    }
}

@Composable
private fun ConnectorAccountAction(
    label: String,
    modifier: Modifier = Modifier,
    enabled: Boolean = true,
    destructive: Boolean = false,
    chevron: Boolean = false,
    onClick: () -> Unit,
) {
    val colors = MaterialTheme.colorScheme
    Row(
        modifier
            .fillMaxWidth()
            .heightIn(min = if (chevron) 52.dp else 56.dp)
            .clip(RoundedCornerShape(if (chevron) 8.dp else 12.dp))
            .clickable(enabled = enabled, role = Role.Button, onClick = onClick)
            .padding(horizontal = if (chevron) 12.dp else 16.dp, vertical = 8.dp),
        horizontalArrangement = Arrangement.spacedBy(12.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Text(
            label,
            Modifier.weight(1f),
            style =
                connectorBodyType()
                    .copy(fontWeight = if (chevron) FontWeight.SemiBold else FontWeight.Normal),
            color =
                when {
                    !enabled -> colors.onSurfaceVariant
                    destructive -> colors.error
                    else -> colors.onSurface
                },
        )
        if (chevron) ConnectorChevron()
    }
}

@Composable
private fun ConnectorDisconnectDialog(
    account: ConnectorSavedAccount,
    impact: ConnectorRead<Long>?,
    canModify: Boolean,
    action: ConnectorAction?,
    offline: Boolean,
    confirm: () -> Unit,
    cancel: () -> Unit,
) {
    val count = impact?.data
    AlertDialog(
        onDismissRequest = cancel,
        modifier = Modifier.widthIn(max = 360.dp),
        shape = RoundedCornerShape(28.dp),
        title = {
            Text(
                stringResource(R.string.connector_disconnect_title),
                modifier = Modifier.semantics { heading() },
                style =
                    MaterialTheme.typography.titleLarge.copy(
                        fontSize = 24.sp,
                        lineHeight = 32.sp,
                        letterSpacing = 0.sp,
                        fontWeight = FontWeight.SemiBold,
                    ),
            )
        },
        text = {
            Column(
                Modifier.verticalScroll(rememberScrollState()),
                verticalArrangement = Arrangement.spacedBy(8.dp),
            ) {
                Text(
                    account.label(),
                    style = connectorBodyType().copy(fontWeight = FontWeight.SemiBold),
                )
                if (
                    account.displayName != null &&
                        account.identity != null &&
                        account.displayName != account.identity
                ) {
                    Text(account.identity, style = connectorSmallType())
                }
                Text(
                    stringResource(R.string.connector_disconnect_copy),
                    style = connectorFeedbackType(),
                )
                when {
                    count != null && count > 0 -> {
                        val displayed = count.coerceAtMost(Int.MAX_VALUE.toLong()).toInt()
                        Text(
                            pluralStringResource(
                                R.plurals.connector_impact_count,
                                displayed,
                                displayed,
                            ),
                            style = connectorFeedbackType(),
                        )
                    }
                    offline -> ConnectorStatusBanner(R.string.connector_offline_action)
                    impact?.failure != null ->
                        ConnectorStatusBanner(R.string.connector_impact_failed)
                    count == null -> ConnectorProgress(R.string.connector_loading_impact)
                }
                ConnectorActionFeedback(action)
            }
        },
        confirmButton = {
            ConnectorButton(
                stringResource(R.string.connector_disconnect),
                confirm,
                enabled = canModify && count != null,
                treatment = ConnectorButtonTreatment.Destructive,
            )
        },
        dismissButton = {
            ConnectorButton(
                stringResource(R.string.settings_cancel),
                cancel,
                enabled = action?.busy != true,
                treatment = ConnectorButtonTreatment.Text,
            )
        },
        containerColor = MaterialTheme.colorScheme.surface,
    )
}

@Composable
internal fun ConnectorActionFeedback(action: ConnectorAction?) {
    if (action?.busy == true) ConnectorProgress(R.string.connector_working)
    else if (action?.problem != null)
        ConnectorStatusBanner(
            when (action.problem) {
                ConnectorProblem.Failed -> R.string.connector_change_failed
                ConnectorProblem.BrowserUnavailable -> R.string.connector_browser_unavailable
                ConnectorProblem.AuthorizationIncomplete -> R.string.connector_incomplete
                ConnectorProblem.VerificationPending -> R.string.connector_verify_pending
            }
        )
}

@Composable
private fun ConnectorProgress(label: Int) {
    Row(
        Modifier.semantics { liveRegion = LiveRegionMode.Polite },
        horizontalArrangement = Arrangement.spacedBy(8.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        CircularProgressIndicator(
            Modifier.size(16.dp),
            strokeWidth = 2.dp,
            color = MaterialTheme.colorScheme.onSurface,
        )
        Text(
            stringResource(label),
            style = connectorFeedbackType(),
            color = MaterialTheme.colorScheme.onSurfaceVariant,
        )
    }
}

@Composable
internal fun ConnectorSheetHeading(label: String) {
    Text(
        label,
        modifier = Modifier.semantics { heading() },
        style =
            MaterialTheme.typography.titleLarge.copy(
                fontSize = 22.sp,
                lineHeight = 28.sp,
                letterSpacing = 0.sp,
                fontWeight = FontWeight.SemiBold,
            ),
    )
}

@Composable
internal fun ConnectorSavedAccount.label() =
    displayName ?: identity ?: stringResource(R.string.connector_account)

internal enum class ConnectorButtonTreatment {
    Primary,
    Outline,
    Text,
    Destructive,
}

@Composable
internal fun ConnectorButton(
    label: String,
    onClick: () -> Unit,
    modifier: Modifier = Modifier,
    enabled: Boolean = true,
    treatment: ConnectorButtonTreatment = ConnectorButtonTreatment.Primary,
) {
    val colors = MaterialTheme.colorScheme
    val shape = RoundedCornerShape(12.dp)
    val size = modifier.heightIn(min = 48.dp)
    val padding = PaddingValues(horizontal = 12.dp, vertical = 8.dp)
    val text: @Composable () -> Unit = {
        Text(label, style = connectorSmallType().copy(fontWeight = FontWeight(550)))
    }
    when (treatment) {
        ConnectorButtonTreatment.Text ->
            TextButton(
                onClick,
                size,
                enabled,
                shape = shape,
                colors = ButtonDefaults.textButtonColors(contentColor = colors.onSurface),
                contentPadding = padding,
                content = { text() },
            )
        ConnectorButtonTreatment.Outline ->
            OutlinedButton(
                onClick,
                size,
                enabled,
                shape = shape,
                colors = ButtonDefaults.outlinedButtonColors(contentColor = colors.onSurface),
                border = BorderStroke(1.dp, colors.outline),
                contentPadding = padding,
                content = { text() },
            )
        ConnectorButtonTreatment.Primary,
        ConnectorButtonTreatment.Destructive -> {
            val destructive = treatment == ConnectorButtonTreatment.Destructive
            Button(
                onClick,
                size,
                enabled,
                shape = shape,
                colors =
                    ButtonDefaults.buttonColors(
                        containerColor = if (destructive) colors.error else colors.inverseSurface,
                        contentColor = if (destructive) colors.onError else colors.inverseOnSurface,
                        disabledContainerColor = colors.surfaceVariant,
                        disabledContentColor = colors.onSurfaceVariant,
                    ),
                contentPadding = padding,
                content = { text() },
            )
        }
    }
}
