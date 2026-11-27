package ai.okou.android.connectors

import ai.okou.android.CompactPanelTopAppBar
import ai.okou.android.ContentReadFailure
import ai.okou.android.ContentReadFailureLayout
import ai.okou.android.OkouActionButton
import ai.okou.android.OkouActionTreatment
import ai.okou.android.OkouConfirmationDialog
import ai.okou.android.OkouSwitch
import ai.okou.android.PaneReadAnnouncements
import ai.okou.android.R
import ai.okou.android.SettingsModal
import ai.okou.android.WorkspaceFeedbackHost
import ai.okou.android.chat.ChatSkeletonBlock
import ai.okou.android.chat.ContentReadFeedback
import ai.okou.android.isShortSettingsPanelWindow
import ai.okou.android.rememberContentReadSkeleton
import ai.okou.android.settingsPanelContentPadding
import ai.okou.android.updates.updateFocusOutline
import ai.okou.android.workspaceFeedbackMessageHeight
import androidx.compose.animation.animateContentSize
import androidx.compose.foundation.clickable
import androidx.compose.foundation.interaction.MutableInteractionSource
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.BoxWithConstraints
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ColumnScope
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxHeight
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
import androidx.compose.material3.Button
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.SnackbarHostState
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.SideEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.key
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.BiasAlignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.focus.FocusRequester
import androidx.compose.ui.focus.focusRequester
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.res.painterResource
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
    Authorize,
    Permissions,
}

private val connectorFeedbackBottomInset = 8.dp

@Composable
internal fun ConnectorDetails(
    model: ConnectorModel,
    state: ConnectorUiState,
    preview: ConnectorEntry?,
    wide: Boolean,
    announcements: PaneReadAnnouncements,
    initialAccountId: String? = null,
    onCloseInitialAccount: () -> Unit = {},
) {
    val detail = state.detail.data
    val detailFailure = state.detail.failure
    val detailUnavailable = detailFailure == ConnectorReadFailure.Unavailable
    val entry = detail?.entry ?: preview
    if (entry == null && detailFailure != null) {
        val pane = Modifier.widthIn(max = 666.dp)
        Box(
            Modifier.fillMaxSize().testTag("connector-detail"),
            contentAlignment = Alignment.TopCenter,
        ) {
            ConnectorReadFailureContent(
                detailFailure,
                R.string.connector_load_failed,
                if (detailUnavailable) pane
                else pane.fillMaxHeight().padding(horizontal = if (wide) 32.dp else 20.dp),
            )
        }
        return
    }
    val accountContent = state.selectedAccountContent
    val accounts = accountContent.orEmpty()
    val hasAccountContent = accountContent != null
    val showsAddAccount = hasAccountContent && detail?.methods?.isNotEmpty() == true
    val renameEditor = model.renameEditor?.takeIf { it.target.slug == state.slug }
    var panel by remember {
        mutableStateOf(if (renameEditor != null) ConnectorPanel.Account else null)
    }
    var accountId by remember { mutableStateOf(renameEditor?.accountId) }
    var resolvingInitialAccount by
        remember(initialAccountId) {
            mutableStateOf(initialAccountId != null && renameEditor == null)
        }
    var restoreAccountFocus by remember { mutableStateOf(false) }
    var restoreActionFocus by remember { mutableStateOf<FocusRequester?>(null) }
    val permissionAnnouncements = remember(model) { PaneReadAnnouncements() }
    SideEffect { permissionAnnouncements.retain(listOfNotNull(state.permissions.failureRound)) }
    val accountFocus = remember { FocusRequester() }
    val addFocus = remember { FocusRequester() }
    val permissionsFocus = remember { FocusRequester() }
    val renameFocus = remember { FocusRequester() }
    val primaryAccountFocus = remember { FocusRequester() }
    val disconnectFocus = remember { FocusRequester() }
    val account = accounts.find { it.id == accountId }
    val disconnectImpact = state.impact?.takeIf { it.accountId == accountId }
    val action = state.action?.takeIf { it.target.slug == state.slug }
    val busy = action?.busy == true
    val canModify = state.canChangeAccounts
    val color = MaterialTheme.colorScheme
    val unnamedAccount = stringResource(R.string.connector_account)

    LaunchedEffect(initialAccountId, state.accounts.isConfirmed) {
        if (resolvingInitialAccount && state.accounts.isConfirmed) {
            resolvingInitialAccount = false
            if (accounts.any { it.id == initialAccountId }) {
                accountId = initialAccountId
                panel = ConnectorPanel.Account
            }
        }
    }

    fun dismissPanel() {
        if (busy) return
        val previous = panel
        if (previous == ConnectorPanel.Permissions) model.hidePermissions()
        if (disconnectImpact != null) model.clearImpact()
        model.dismissAction()
        if (
            previous == ConnectorPanel.Account &&
                initialAccountId != null &&
                account?.id == initialAccountId
        ) {
            onCloseInitialAccount()
            return
        }
        panel =
            if (previous == ConnectorPanel.Authorize && account != null) ConnectorPanel.Account
            else null
        if (panel == ConnectorPanel.Account) restoreActionFocus = primaryAccountFocus
        if (panel == null) {
            if (previous == ConnectorPanel.Permissions) {
                if (detail?.hasPermissions == true) permissionsFocus.requestFocus()
            } else if (account != null) restoreAccountFocus = true
            else if (showsAddAccount && state.accounts.data != null) addFocus.requestFocus()
        }
    }

    fun returnFromRename(editor: ConnectorRenameEditor) {
        model.closeRename(editor)
        model.dismissAction()
        restoreActionFocus = renameFocus
    }

    val confirmingDisconnect = disconnectImpact != null
    val accountNotice = state.accounts.notice().takeIf { hasAccountContent }
    val detailNotice =
        state.detail
            .notice(
                if (detail == null) R.string.connector_load_failed
                else R.string.connector_refresh_failed,
            )
            .takeUnless { detailUnavailable }
    val serviceNotices = listOfNotNull(detailNotice, accountNotice)

    val authorization = action?.authorization
    LaunchedEffect(authorization) {
        if (
            panel == null &&
                action != null &&
                authorization != null &&
                (!action.reconciling ||
                    authorization is ConnectorAuthorization.Receipt &&
                        authorization.externalCodeSessionId != null)
        ) {
            accountId = action.target.connectionId
            panel = ConnectorPanel.Authorize
        }
    }

    LaunchedEffect(action?.result, action?.busy) {
        if (action == null || action.busy) return@LaunchedEffect
        when (action.result) {
            ConnectorResult.Disconnected -> {
                if (panel == ConnectorPanel.Account && accountId == action.target.connectionId) {
                    panel = null
                    accountId = null
                    if (showsAddAccount) addFocus.requestFocus()
                }
                model.clearImpact()
                model.dismissAction()
            }
            ConnectorResult.Renamed -> {
                if (renameEditor != null && renameEditor.target == action.target)
                    returnFromRename(renameEditor)
                else model.dismissAction()
            }
            ConnectorResult.Authorized -> {
                if (panel == ConnectorPanel.Authorize) {
                    if (account != null) {
                        panel = ConnectorPanel.Account
                        restoreActionFocus = primaryAccountFocus
                    } else {
                        panel = null
                        if (showsAddAccount) addFocus.requestFocus()
                    }
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
                .testTag("connector-detail"),
        ) {
            if (entry != null) {
                Row(horizontalArrangement = Arrangement.spacedBy(12.dp)) {
                    ConnectorIcon(entry.icon)
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

                if (detailUnavailable) {
                    ContentReadFeedback(R.string.connector_load_failed)
                } else if (!hasAccountContent) {
                    when (state.accounts.failure) {
                        ConnectorReadFailure.Unavailable ->
                            ContentReadFeedback(
                                R.string.connector_accounts_failed,
                                Modifier.fillMaxWidth(),
                            )
                        else -> {
                            val bodyHeight = if (isShortSettingsPanelWindow()) 160.dp else 208.dp
                            Box(
                                Modifier.fillMaxWidth().heightIn(min = bodyHeight),
                                propagateMinConstraints = true,
                            ) {
                                if (state.accounts.failure == null) {
                                    ConnectorSkeleton(
                                        stringResource(R.string.connector_loading_accounts),
                                        rows = 1,
                                    )
                                } else {
                                    ContentReadFailure(
                                        R.string.chat_list_first_load_failed,
                                        Modifier.fillMaxWidth(),
                                        failureLayout = ContentReadFailureLayout.Section,
                                    )
                                }
                            }
                        }
                    }
                }
                if (detail != null && hasAccountContent) {
                    Spacer(Modifier.height(8.dp))
                    if (showsAddAccount) {
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
                                    addFocus,
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
                    ConnectorNavigationRow(
                        onClick = {
                            panel = ConnectorPanel.Permissions
                            model.showPermissions()
                        },
                        modifier = Modifier.focusRequester(permissionsFocus),
                    ) {
                        Text(stringResource(R.string.connector_permissions))
                    }
                }
                if (panel == null) ConnectorActionFeedback(action)
            } else if (rememberContentReadSkeleton()) {
                val label = stringResource(R.string.connector_loading)
                Column(
                    Modifier.fillMaxWidth().semantics { contentDescription = label },
                    verticalArrangement = Arrangement.spacedBy(12.dp),
                ) {
                    ChatSkeletonBlock(Modifier.widthIn(max = 220.dp).fillMaxWidth().height(24.dp))
                    ChatSkeletonBlock(Modifier.widthIn(max = 300.dp).fillMaxWidth().height(14.dp))
                }
            }
        }
        if (panel == null && entry != null) {
            ConnectorReadFeedbackHost(
                serviceNotices,
                announcements,
                Modifier.align(Alignment.BottomCenter).padding(bottom = 8.dp),
            )
        }
    }

    if (renameEditor != null) {
        val confirmedAccount = account?.takeIf { state.accounts.data != null }
        ConnectorRenameSheet(
            renameEditor,
            confirmedLabel = confirmedAccount?.label(),
            canModify = canModify && confirmedAccount != null,
            action = action?.takeIf { it.target == renameEditor.target },
            save = { model.submitRename(renameEditor, it) },
            cancel = { if (!busy) returnFromRename(renameEditor) },
            readFeedback = rememberConnectorReadFeedback(accountNotice, announcements),
        )
    } else if (panel != null && entry != null) {
        if (panel != ConnectorPanel.Permissions && accountId != null && account == null) {
            ConnectorSheet(
                entry.name,
                ::dismissPanel,
                dismissible = !busy,
                actions = { ConnectorCloseAction(::dismissPanel, enabled = !busy) },
            ) {
                ConnectorStatusBanner(R.string.connector_account_unavailable)
                ConnectorActionFeedback(action)
            }
        } else {
            when (panel) {
                ConnectorPanel.Permissions ->
                    ConnectorPermissionSheet(
                        entry.name,
                        state.permissions,
                        permissionAnnouncements,
                        ::dismissPanel,
                    )
                ConnectorPanel.Account ->
                    if (account != null) {
                        ConnectorSheet(
                            account.label(),
                            ::dismissPanel,
                            dismissible = !busy,
                            back = if (account.id == initialAccountId) ::dismissPanel else null,
                            feedback =
                                rememberConnectorReadFeedback(
                                    accountNotice.takeUnless { confirmingDisconnect },
                                    announcements,
                                ),
                        ) {
                            ConnectorAccountActions(
                                account,
                                canModify,
                                action?.takeIf { it.target.connectionId == account.id },
                                onDefault = { model.setDefaultEnabled(account.id, it) },
                                onPolicy = { model.setMemberPolicy(account.id, it) },
                                renameFocus = renameFocus,
                                primaryAccountFocus = primaryAccountFocus,
                                disconnectFocus = disconnectFocus,
                                rename = {
                                    model.dismissAction()
                                    model.openRename(account.id, unnamedAccount)
                                },
                                reauthorize = {
                                    model.dismissAction()
                                    panel = ConnectorPanel.Authorize
                                },
                                disconnect = {
                                    model.dismissAction()
                                    model.prepareDisconnect(account.id)
                                },
                            )
                            LaunchedEffect(restoreActionFocus, confirmingDisconnect, canModify) {
                                val target = restoreActionFocus ?: return@LaunchedEffect
                                if (confirmingDisconnect || !canModify) return@LaunchedEffect
                                restoreActionFocus = null
                                if (
                                    target === primaryAccountFocus &&
                                        !account.status.needsAttention &&
                                        account.defaultSwitchChecked == null
                                ) {
                                    renameFocus.requestFocus()
                                } else {
                                    target.requestFocus()
                                }
                            }
                        }
                    }
                ConnectorPanel.Authorize ->
                    ConnectorAuthorizationSheet(
                        model = model,
                        service = entry.name,
                        detail = state.detail,
                        account = account,
                        addingAccount = accounts.isNotEmpty(),
                        canModify = canModify,
                        action = action,
                        cancel = ::dismissPanel,
                        readFeedback =
                            rememberConnectorReadFeedback(
                                if (detail == null) listOfNotNull(accountNotice)
                                else serviceNotices,
                                announcements,
                            ),
                    )
                null -> Unit
            }
        }
    }

    if (disconnectImpact != null && account != null) {
        ConnectorDisconnectDialog(
            account,
            disconnectImpact.read,
            canModify,
            action,
            confirm = { model.disconnect(account.id) },
            cancel = {
                if (!busy) {
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
    val label = account.label()
    val identity = account.identity?.takeIf { it != label }
    ConnectorNavigationRow(
        onClick = open,
        modifier = modifier.testTag("connector-account-${account.id}"),
        supportingContent = {
            Column(Modifier.padding(top = 4.dp), verticalArrangement = Arrangement.spacedBy(4.dp)) {
                if (identity != null) {
                    Text(
                        identity,
                        style = connectorSmallType(),
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                    )
                }
                ConnectorAccountStatusText(account)
            }
        },
    ) {
        Text(label)
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
    HorizontalDivider(color = MaterialTheme.colorScheme.outlineVariant)
    Spacer(Modifier.height(16.dp))
}

@Composable
internal fun ConnectorSheet(
    title: String,
    dismiss: () -> Unit,
    dismissible: Boolean = true,
    expandInShortWindow: Boolean = false,
    compactForm: Boolean = false,
    back: (() -> Unit)? = null,
    actions: (@Composable () -> Unit)? = null,
    feedback: SnackbarHostState? = null,
    actionFeedback: SnackbarHostState? = null,
    inContentFeedbackMessage: String? = null,
    centerCompactContent: Boolean = false,
    retainedScroll: androidx.compose.foundation.ScrollState? = null,
    content: @Composable ColumnScope.() -> Unit,
) {
    val shortWindow = isShortSettingsPanelWindow()
    val fullScreen = (expandInShortWindow || compactForm) && shortWindow
    val overlayFeedback =
        actionFeedback ?: feedback.takeIf { fullScreen || inContentFeedbackMessage != null }
    val scroll = retainedScroll ?: key(title) { rememberScrollState() }
    val titleStyle = MaterialTheme.typography.titleLarge.copy(fontSize = 22.sp, lineHeight = 28.sp)
    SettingsModal(
        dismiss,
        dismissible,
        fullScreen,
        fitContentInsets = compactForm && fullScreen,
        snackbar = feedback.takeIf { overlayFeedback == null },
        onBack = back,
    ) { centered ->
        val frame =
            if (fullScreen) Modifier.fillMaxSize()
            else
                Modifier.fillMaxWidth()
                    .animateContentSize(
                        alignment = if (centered) Alignment.Center else Alignment.BottomCenter,
                    )
        BoxWithConstraints(
            frame
                .testTag("connector-sheet")
                .padding(settingsPanelContentPadding(compactHeight = shortWindow))
                .padding(top = if (centered && !fullScreen) 16.dp else 0.dp),
        ) {
            val minimumControlsHeight =
                with(LocalDensity.current) {
                    titleStyle.lineHeight.toDp() * 2 +
                        maxOf(48.dp, 20.sp.toDp() + 16.dp) * 2 +
                        16.dp
                }
            // Keep the Snackbar clear of the scroll viewport and leave the footer in place.
            val feedbackSpace =
                if (inContentFeedbackMessage != null) {
                    workspaceFeedbackMessageHeight(inContentFeedbackMessage, maxWidth) +
                        connectorFeedbackBottomInset
                } else 0.dp
            val scrollAll = actions != null && maxHeight < minimumControlsHeight + feedbackSpace
            Column(
                when {
                    scrollAll -> Modifier.fillMaxWidth().verticalScroll(scroll)
                    fullScreen -> Modifier.fillMaxSize()
                    else -> Modifier.fillMaxWidth()
                },
                verticalArrangement = Arrangement.spacedBy(8.dp),
            ) {
                if (fullScreen) {
                    CompactPanelTopAppBar(
                        title,
                        back = back ?: dismiss.takeIf { compactForm },
                        backEnabled = dismissible,
                    )
                } else
                    Row(verticalAlignment = Alignment.CenterVertically) {
                        if (back != null) {
                            IconButton(
                                back,
                                enabled = dismissible,
                                modifier = Modifier.size(48.dp),
                            ) {
                                Icon(
                                    painterResource(R.drawable.ic_arrow_back),
                                    stringResource(R.string.back),
                                )
                            }
                        }
                        Text(
                            title,
                            Modifier.semantics { heading() },
                            style =
                                titleStyle.copy(
                                    letterSpacing = 0.sp,
                                    fontWeight = FontWeight.SemiBold,
                                ),
                        )
                    }
                Box(
                    if (scrollAll) Modifier.fillMaxWidth()
                    else Modifier.weight(1f, fill = fullScreen).fillMaxWidth(),
                    propagateMinConstraints = true,
                ) {
                    Column(
                        Modifier.padding(bottom = feedbackSpace)
                            .then(if (scrollAll) Modifier else Modifier.verticalScroll(scroll)),
                        verticalArrangement =
                            if (fullScreen && centerCompactContent && !scrollAll)
                                Arrangement.spacedBy(8.dp, BiasAlignment.Vertical(-0.2f))
                            else Arrangement.spacedBy(8.dp),
                        content = content,
                    )
                    if (overlayFeedback != null) {
                        Box(
                            Modifier.matchParentSize()
                                .padding(bottom = connectorFeedbackBottomInset),
                            contentAlignment = Alignment.BottomCenter,
                        ) {
                            WorkspaceFeedbackHost(
                                overlayFeedback,
                                Modifier,
                                manageTimeout = actionFeedback == null,
                            )
                        }
                    }
                }
                actions?.invoke()
            }
        }
    }
}

@Composable
private fun ConnectorPermissionSheet(
    service: String,
    permissions: ConnectorRead<List<ConnectorPermission>>,
    announcements: PaneReadAnnouncements,
    close: () -> Unit,
) {
    val pendingHeight = if (isShortSettingsPanelWindow()) 160.dp else 208.dp
    val pendingBody = Modifier.fillMaxWidth().heightIn(min = pendingHeight)
    ConnectorSheet(
        stringResource(R.string.connector_permissions_title, service),
        close,
        actions = { ConnectorCloseAction(close) },
        feedback =
            rememberConnectorReadFeedback(
                permissions.notice().takeIf { permissions.data != null },
                announcements,
            ),
    ) {
        Text(stringResource(R.string.connector_permissions_copy), style = connectorBodyType())
        when {
            permissions.data == null ->
                when {
                    permissions.failure == ConnectorReadFailure.Unavailable ->
                        ContentReadFeedback(
                            R.string.connector_permissions_failed,
                            Modifier.fillMaxWidth(),
                        )
                    permissions.failure != null ->
                        ConnectorReadFailureContent(
                            permissions.failure,
                            R.string.connector_permissions_failed,
                            pendingBody,
                            failureLayout = ContentReadFailureLayout.Panel,
                        )
                    else ->
                        Box(pendingBody) {
                            ConnectorSkeleton(
                                stringResource(R.string.connector_loading_permissions),
                                rows = 1,
                            )
                        }
                }
            permissions.data.isEmpty() ->
                Text(
                    stringResource(R.string.connector_no_permissions),
                    style = connectorFeedbackType(),
                )
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
    }
}

@Composable
private fun ConnectorAccountActions(
    account: ConnectorSavedAccount,
    canModify: Boolean,
    action: ConnectorAction?,
    onDefault: (Boolean) -> Unit,
    onPolicy: (ai.okou.android.api.generated.ConnectorAccountPolicyRequestPolicy) -> Unit,
    renameFocus: FocusRequester,
    primaryAccountFocus: FocusRequester,
    disconnectFocus: FocusRequester,
    rename: () -> Unit,
    reauthorize: () -> Unit,
    disconnect: () -> Unit,
) {
    val color = MaterialTheme.colorScheme
    if (
        account.displayName != null &&
            account.identity != null &&
            account.displayName != account.identity
    ) {
        Text(account.identity, color = color.onSurfaceVariant, style = connectorSmallType())
    }
    val defaultEnabled = account.defaultSwitchChecked
    if (defaultEnabled == null) ConnectorAccountStatusText(account)
    Column(Modifier.fillMaxWidth()) {
        account.policy?.let { policy ->
            Text(
                stringResource(R.string.connector_access_scope),
                color = color.onSurfaceVariant,
                style = connectorSmallType(),
            )
            ConnectorAccountPolicyMenu(account, policy, canModify, onPolicy)
        }
        if (account.status.needsAttention) {
            ConnectorAccountAction(
                stringResource(
                    if (account.status == ConnectorAccountStatus.UpdatePermissions)
                        R.string.connector_update_permissions
                    else R.string.connector_reauthorize,
                ),
                enabled = canModify,
                modifier = Modifier.focusRequester(primaryAccountFocus),
                onClick = reauthorize,
            )
        } else if (defaultEnabled != null) {
            ConnectorDefaultSwitch(
                defaultEnabled,
                canModify,
                onDefault,
                Modifier.focusRequester(primaryAccountFocus),
            )
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

private val ConnectorSavedAccount.defaultSwitchChecked: Boolean?
    get() = defaultEnabled.takeIf { status == ConnectorAccountStatus.Connected }

@Composable
internal fun ConnectorCloseAction(close: () -> Unit, enabled: Boolean = true) {
    Box(Modifier.fillMaxWidth(), contentAlignment = Alignment.CenterEnd) {
        ConnectorButton(
            stringResource(R.string.updates_close),
            close,
            enabled = enabled,
            treatment = ConnectorButtonTreatment.Text,
        )
    }
}

@Composable
private fun ConnectorDefaultSwitch(
    checked: Boolean,
    enabled: Boolean,
    onCheckedChange: (Boolean) -> Unit,
    modifier: Modifier = Modifier,
) {
    val color = MaterialTheme.colorScheme
    val shape = RoundedCornerShape(12.dp)
    val interactions = remember { MutableInteractionSource() }
    Row(
        modifier
            .fillMaxWidth()
            .heightIn(min = 56.dp)
            .clip(shape)
            .updateFocusOutline(shape, color.onSurface, keyboardOnly = true)
            .toggleable(
                checked,
                interactionSource = interactions,
                indication = null,
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
        OkouSwitch(checked, enabled, interactions)
    }
}

@Composable
private fun ConnectorAccountAction(
    label: String,
    modifier: Modifier = Modifier,
    enabled: Boolean = true,
    destructive: Boolean = false,
    onClick: () -> Unit,
) {
    val colors = MaterialTheme.colorScheme
    val shape = RoundedCornerShape(12.dp)
    Row(
        modifier
            .fillMaxWidth()
            .heightIn(min = 56.dp)
            .updateFocusOutline(shape, colors.onSurface, keyboardOnly = true)
            .clip(shape)
            .clickable(enabled = enabled, role = Role.Button, onClick = onClick)
            .padding(horizontal = 16.dp, vertical = 8.dp),
        horizontalArrangement = Arrangement.spacedBy(12.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Text(
            label,
            Modifier.weight(1f),
            style = connectorBodyType(),
            color =
                when {
                    !enabled -> colors.onSurfaceVariant
                    destructive -> colors.error
                    else -> colors.onSurface
                },
        )
    }
}

@Composable
private fun ConnectorDisconnectDialog(
    account: ConnectorSavedAccount,
    impact: ConnectorRead<Long>,
    canModify: Boolean,
    action: ConnectorAction?,
    confirm: () -> Unit,
    cancel: () -> Unit,
) {
    val count = impact.data
    OkouConfirmationDialog(
        title = stringResource(R.string.connector_disconnect_title),
        confirm = stringResource(R.string.connector_disconnect),
        onDismiss = cancel,
        onConfirm = confirm,
        confirmEnabled = canModify && count != null,
        dismissEnabled = action?.busy != true,
        destructive = true,
        pendingConfirmLabel = stringResource(R.string.connector_submitting),
        confirmPending = action?.busy == true,
        actionStatus = { ConnectorActionFeedback(action?.takeUnless { it.busy }) },
    ) {
        Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
            Text(account.label(), fontWeight = FontWeight.SemiBold)
            if (
                account.displayName != null &&
                    account.identity != null &&
                    account.displayName != account.identity
            ) {
                Text(account.identity)
            }
            Text(stringResource(R.string.connector_disconnect_copy))
            when {
                count != null && count > 0 -> {
                    val displayed = count.coerceAtMost(Int.MAX_VALUE.toLong()).toInt()
                    Text(
                        pluralStringResource(
                            R.plurals.connector_impact_count,
                            displayed,
                            displayed,
                        ),
                    )
                }
                count == null && impact.failure == ConnectorReadFailure.Network ->
                    ConnectorStatusBanner(R.string.connector_network_failed)
                count == null && impact.failure != null ->
                    ConnectorStatusBanner(R.string.connector_impact_failed)
                count == null -> ConnectorProgress(R.string.connector_loading_impact)
            }
        }
    }
}

@Composable
internal fun ConnectorActionFeedback(action: ConnectorAction?) {
    if (action?.busy == true)
        ConnectorProgress(
            if (
                action.reconciling ||
                    action.authorization is ConnectorAuthorization.Browser ||
                    action.authorization is ConnectorAuthorization.DeviceVerification
            )
                R.string.connector_working
            else R.string.connector_submitting,
        )
    else if (action?.problem != null)
        ConnectorStatusBanner(
            connectorActionProblemMessage(action.problem),
            error =
                action.problem == ConnectorProblem.Failed ||
                    action.problem == ConnectorProblem.Network,
        )
}

internal fun connectorActionProblemMessage(problem: ConnectorProblem) =
    when (problem) {
        ConnectorProblem.Failed -> R.string.connector_change_failed
        ConnectorProblem.Network -> R.string.connector_network_failed
        ConnectorProblem.BrowserUnavailable -> R.string.connector_browser_unavailable
        ConnectorProblem.AuthorizationIncomplete -> R.string.connector_incomplete
        ConnectorProblem.DeviceAuthorizationDenied -> R.string.connector_device_denied
        ConnectorProblem.DeviceCodeExpired -> R.string.connector_device_expired
        ConnectorProblem.DeviceAuthorizationFailed -> R.string.connector_device_failed
        ConnectorProblem.AuthorizationUnconfirmed -> R.string.connector_authorization_unconfirmed
        ConnectorProblem.VerificationPending -> R.string.connector_verify_pending
        ConnectorProblem.VerificationNetwork -> R.string.connector_verify_network
    }

@Composable
internal fun ConnectorProgress(label: Int) {
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
internal fun ConnectorSavedAccount.label() =
    displayName ?: identity ?: stringResource(R.string.connector_account)

internal typealias ConnectorButtonTreatment = OkouActionTreatment

@Composable
internal fun ConnectorButton(
    label: String,
    onClick: () -> Unit,
    modifier: Modifier = Modifier,
    enabled: Boolean = true,
    treatment: ConnectorButtonTreatment = ConnectorButtonTreatment.Primary,
) = OkouActionButton(label, onClick, modifier, enabled, treatment, useMaterialButtonDefaults = true)
