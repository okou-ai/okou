package ai.okou.android.auth

import ai.okou.android.EntryBrand
import ai.okou.android.EntryCompactHeight
import ai.okou.android.EntryContentGutter
import ai.okou.android.EntryContentWidth
import ai.okou.android.OkouApp
import ai.okou.android.R
import ai.okou.android.SettingsChoiceRow
import ai.okou.android.SettingsGroup
import ai.okou.android.SettingsIcon
import ai.okou.android.SettingsRow
import ai.okou.android.SettingsScreen
import ai.okou.android.SettingsSection
import ai.okou.android.SettingsSheet
import ai.okou.android.SettingsSwitchRow
import ai.okou.android.SettingsTrigger
import ai.okou.android.chat.WorkspaceRealtimeLifecycle
import ai.okou.android.currentWindowSizeDp
import ai.okou.android.entryBrandNameStyle
import ai.okou.android.entrySpacing
import ai.okou.android.entryTopPadding
import ai.okou.android.instructions.PersonalInstructionsSettings
import ai.okou.android.preferences.MemberPreferencesSettings
import ai.okou.android.settings.BuiltInToolsPage
import ai.okou.android.settings.DefaultModelSetting
import ai.okou.android.settings.EmailSubscriptionSetting
import ai.okou.android.settings.ProactiveSettingsPage
import ai.okou.android.settings.WorkspaceSettingsDataPage
import ai.okou.android.settings.WorkspaceSettingsFeedback
import ai.okou.android.settings.WorkspaceSettingsProgress
import ai.okou.android.settings.settingsWebClick
import ai.okou.android.state.SettingsDestination
import ai.okou.android.state.rememberSettingsFlag
import ai.okou.android.state.rememberSettingsReturnFocus
import ai.okou.android.state.rememberWorkspacePresentationState
import ai.okou.android.state.rememberWorkspaceSwitchTarget
import ai.okou.android.updates.UpdateToolbarAction
import ai.okou.android.updates.updateFocusOutline
import ai.okou.android.workspaceSearchControlHeight
import androidx.annotation.StringRes
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.safeDrawingPadding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.relocation.BringIntoViewRequester
import androidx.compose.foundation.relocation.bringIntoViewRequester
import androidx.compose.foundation.selection.selectableGroup
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.SnackbarHostState
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.key
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.runtime.withFrameNanos
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.focus.FocusRequester
import androidx.compose.ui.focus.focusRequester
import androidx.compose.ui.focus.onFocusChanged
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.LiveRegionMode
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.liveRegion
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import com.clerk.api.ui.ClerkColors
import com.clerk.api.ui.ClerkTheme
import com.clerk.api.ui.ClerkTypography
import com.clerk.ui.auth.AuthView

@Composable
internal fun SessionRoot(
    state: SessionUiState,
    retry: () -> Unit,
    chooseWorkspace: (String) -> Unit,
    signOut: () -> Unit,
    openWorkspaceSetup: () -> Unit,
    account: NativeAccount? = null,
    appUpdates: @Composable (() -> Unit)? = null,
    updateToolbarAction: UpdateToolbarAction? = null,
) {
    var switchTarget by rememberWorkspaceSwitchTarget()
    val workspaceSwitch = state.workspaceSwitch
    LaunchedEffect(workspaceSwitch) {
        if (workspaceSwitch?.failed == true && switchTarget == workspaceSwitch.target) {
            switchTarget = null
        }
    }
    Surface(Modifier.fillMaxSize(), color = MaterialTheme.colorScheme.background) {
        val ready = state.ready
        val opened = state.opening as? OpeningWorkspace.Authorized
        val cached = state.opening as? OpeningWorkspace.Cached
        val identity = ready?.identity ?: state.opening?.identity
        val workspace = state.memberships.firstOrNull { it.id == identity?.workspaceId }
        val switchWorkspace: (String) -> Unit = { id ->
            switchTarget = id
            chooseWorkspace(id)
        }
        if (identity != null) {
            key(
                identity.apiOrigin,
                identity.userId,
                identity.sessionId,
                identity.workspaceId,
                state.generation,
            ) {
                val presentation = rememberWorkspacePresentationState()
                val workspaceContent: @Composable () -> Unit = {
                    if (ready != null) WorkspaceRealtimeLifecycle(ready.chats.updates)
                    val snackbar = remember { SnackbarHostState() }
                    var feedbackInOverlay by remember { mutableStateOf(false) }
                    val startupRecovery: (@Composable () -> Unit)? =
                        if (state.stage == SessionStage.Unavailable && !state.working) {
                            {
                                WorkspaceStartupRecovery(
                                    retry,
                                    signOut,
                                    signOutFailed =
                                        state.entryFailure == SessionEntryFailure.SignOut,
                                )
                            }
                        } else null
                    OkouApp(
                        ready?.chats ?: opened?.chats,
                        ready?.composer ?: opened?.composer,
                        ready?.controls,
                        workflows = ready?.workflows,
                        workflowReadAnnouncements = ready?.workflowReadAnnouncements,
                        workflowTimezone =
                            ready
                                ?.preferences
                                ?.uiState
                                ?.collectAsStateWithLifecycle()
                                ?.value
                                ?.timezone
                                ?: state.cachedPreferences?.timezone
                                ?: java.util.TimeZone.getDefault().id,
                        projectExpansion =
                            ready?.projectExpansion
                                ?: opened?.projectExpansion
                                ?: cached?.projectExpansion,
                        cachedStartupChats = cached?.chats,
                        namePresentation = ready?.namePresentation ?: opened?.namePresentation,
                        settingsContent = { destination, open, close ->
                            WorkspaceSettingsContent(
                                destination,
                                state,
                                identity.workspaceId,
                                workspace,
                                open,
                                close,
                                switchWorkspace,
                                account?.takeIf { it.userId == identity.userId },
                                signOut,
                                appUpdates,
                                retry,
                                snackbar,
                                { feedbackInOverlay = it },
                            )
                        },
                        settingsProgress = { destination ->
                            if (ready != null)
                                WorkspaceSettingsProgress(destination, ready.settings)
                        },
                        recovery = ready?.recovery,
                        artifacts = ready?.artifacts,
                        chatArtifacts = ready?.chatArtifacts,
                        connectors = ready?.connectors,
                        workspaceSearch = ready?.search ?: opened?.search,
                        workspaceAvatar = {
                            WorkspaceAvatar(
                                identity.workspaceId,
                                workspace,
                                state,
                                switchWorkspace,
                                restoreFocus = switchTarget == identity.workspaceId,
                                onRestored = { switchTarget = null },
                            )
                        },
                        updateToolbarAction = updateToolbarAction,
                        workspaceReady = ready != null,
                        startupRecovery = startupRecovery,
                        defaultModel = ready?.settings?.defaultModel,
                        memberPreferences = ready?.preferences,
                        snackbar = snackbar,
                        feedbackInOverlay = feedbackInOverlay,
                    )
                }
                if (!state.signingOut) {
                    presentation.SaveableStateProvider("workspace", workspaceContent)
                }
            }
        }
        if (state.signingOut || identity == null) {
            if (state.stage == SessionStage.SignIn && !state.signingOut) {
                NativeAuthentication()
            } else {
                SessionEntryScreen(state, retry, chooseWorkspace, signOut, openWorkspaceSetup)
            }
        }
    }
}

@Composable
private fun NativeAuthentication() {
    val windowHeight = currentWindowSizeDp().height
    val compact = windowHeight < EntryCompactHeight
    // Clerk 1.5 supplies 8dp above and below the logo and 18dp on each side of the form.
    val clerkAppBarPadding = 8.dp
    val hostTop = entryTopPadding(windowHeight) - clerkAppBarPadding
    val logoBottom = entrySpacing(compact) - clerkAppBarPadding
    val maxHostWidth = EntryContentWidth + EntryContentGutter * 2
    // Resolve the app-owned brand style above Clerk's theme, which has no titleLarge override.
    val brandNameStyle = entryBrandNameStyle(compact)
    val colors = MaterialTheme.colorScheme
    val type = MaterialTheme.typography
    val theme =
        ClerkTheme(
            colors =
                ClerkColors(
                    primary = colors.primary,
                    primaryForeground = colors.onPrimary,
                    background = colors.background,
                    foreground = colors.onBackground,
                    input = colors.surface,
                    inputForeground = colors.onSurface,
                    muted = colors.surfaceVariant,
                    mutedForeground = colors.onSurfaceVariant,
                    border = colors.outline,
                    ring = colors.onSurface,
                    danger = colors.error,
                    secondaryButtonBackground = colors.surface,
                    secondaryButtonForeground = colors.onSurface,
                ),
            typography =
                ClerkTypography(
                    displaySmall = type.displaySmall,
                    headlineLarge = type.headlineLarge,
                    headlineMedium = type.headlineMedium,
                    headlineSmall = type.headlineSmall,
                    titleMedium = type.titleMedium,
                    titleSmall = type.titleSmall,
                    bodyLarge = type.bodyLarge,
                    bodyMedium = type.bodyMedium,
                    bodySmall = type.bodySmall,
                    labelMedium = type.labelMedium,
                    labelSmall = type.labelSmall,
                ),
        )
    Box(
        Modifier.fillMaxSize().safeDrawingPadding().padding(top = hostTop),
        contentAlignment = Alignment.TopCenter,
    ) {
        // AuthView fills its incoming constraints before applying its modifier.
        Box(Modifier.widthIn(max = maxHostWidth).fillMaxSize()) {
            AuthView(
                clerkTheme = theme,
                logo = {
                    EntryBrand(
                        compact,
                        Modifier.padding(bottom = logoBottom),
                        nameStyle = brandNameStyle,
                    )
                },
                isDismissible = false,
                persistIdentifiers = false,
                preferGoogleOneTap = false,
            )
        }
    }
}

@Composable
private fun WorkspaceSettingsContent(
    destination: SettingsDestination,
    state: SessionUiState,
    workspaceId: String,
    workspace: WorkspaceMembership?,
    open: (SettingsDestination) -> Unit,
    close: () -> Unit,
    switchWorkspace: (String) -> Unit,
    account: NativeAccount?,
    signOut: () -> Unit,
    appUpdates: @Composable (() -> Unit)?,
    retry: () -> Unit,
    snackbar: SnackbarHostState,
    onFeedbackInOverlay: (Boolean) -> Unit,
) {
    val ready = state.ready
    if (ready != null) {
        val tools = ready.settings.builtInTools
        DisposableEffect(tools) { onDispose { tools?.leaveSettings() } }
        WorkspaceSettingsFeedback(ready.settings, ready.preferences, snackbar, destination)
    }
    val rowFocus = remember { SettingsDestination.entries.associateWith { FocusRequester() } }
    var focused by remember { mutableStateOf<SettingsDestination?>(null) }
    var restore by rememberSettingsReturnFocus()
    fun focusFor(page: SettingsDestination) =
        Modifier.focusRequester(rowFocus.getValue(page)).onFocusChanged {
            if (it.isFocused) focused = page else if (focused == page) focused = null
        }
    fun openPage(page: SettingsDestination) {
        restore = page.takeIf { it == focused }
        open(page)
    }
    LaunchedEffect(destination) {
        if (destination == SettingsDestination.Overview) {
            restore?.let { page -> rowFocus.getValue(page).requestFocus() }
            restore = null
        }
    }
    when (destination) {
        SettingsDestination.ModelAccounts,
        SettingsDestination.CreditBalance -> {
            if (ready == null) WorkspaceSettingsPreparation(state, retry)
            else WorkspaceSettingsDataPage(destination, ready.organization.name, ready.settings)
        }
        SettingsDestination.Account ->
            AccountSettings(account, state.entryFailure == SessionEntryFailure.SignOut, signOut)
        SettingsDestination.BuiltInTools -> {
            val tools = ready?.settings?.builtInTools
            if (ready != null && tools != null) {
                BuiltInToolsPage(ready.organization.name, tools, snackbar, onFeedbackInOverlay)
            } else WorkspaceSettingsPreparation(state, retry)
        }
        SettingsDestination.ProactiveServices -> {
            val proactive = ready?.settings?.proactive
            if (ready != null && proactive != null) {
                ProactiveSettingsPage(
                    ready.organization.name,
                    proactive,
                    ready.preferences,
                )
            } else WorkspaceSettingsPreparation(state, retry)
        }
        SettingsDestination.Overview,
        SettingsDestination.Instructions -> {
            val instructionsOpen = destination == SettingsDestination.Instructions
            val preferenceModel = ready?.preferences
            val preferences = preferenceModel?.uiState?.collectAsStateWithLifecycle()?.value
            SettingsScreen(
                appUpdates = appUpdates,
                workspacePreferences = {
                    MemberPreferencesSettings(preferenceModel, state.cachedPreferences)
                    if (state.stage == SessionStage.Unavailable && !state.working) {
                        WorkspaceStartupRecovery(retry)
                    }
                },
                workspace = {
                    WorkspaceSettings(workspaceId, workspace, state, switchWorkspace) {
                        SettingsRow(
                            stringResource(R.string.settings_credit_balance),
                            leading = { SettingsIcon(R.drawable.ic_paid) },
                            modifier = focusFor(SettingsDestination.CreditBalance),
                            onClick = { openPage(SettingsDestination.CreditBalance) },
                            enabled = ready != null,
                        )
                    }
                },
                models = {
                    DefaultModelSetting(
                        ready?.settings?.defaultModel,
                        snackbar,
                        onFeedbackInOverlay,
                        fallbackFocus = rowFocus.getValue(SettingsDestination.ModelAccounts),
                    )
                    SettingsRow(
                        stringResource(R.string.settings_model_accounts),
                        leading = { SettingsIcon(R.drawable.ic_account_circle) },
                        modifier = focusFor(SettingsDestination.ModelAccounts),
                        onClick = { openPage(SettingsDestination.ModelAccounts) },
                        enabled = ready != null,
                    )
                },
                tools = {
                    SettingsGroup {
                        SettingsSwitchRow(
                            stringResource(R.string.settings_cloud_browser),
                            leading = { SettingsIcon(R.drawable.ic_language) },
                            checked =
                                preferences?.cloudBrowser
                                    ?: state.cachedPreferences?.cloudBrowser
                                    ?: true,
                            supportingText = stringResource(R.string.settings_cloud_browser_detail),
                            onCheckedChange = preferenceModel?.let { it::setCloudBrowser },
                        )
                        if (ready?.settings?.builtInTools != null) {
                            HorizontalDivider()
                            SettingsRow(
                                stringResource(R.string.settings_built_in_tools),
                                leading = { SettingsIcon(R.drawable.ic_build) },
                                modifier = focusFor(SettingsDestination.BuiltInTools),
                                onClick = { openPage(SettingsDestination.BuiltInTools) },
                            )
                        }
                    }
                },
                myOkou = {
                    InstructionsSetting(instructionsOpen, ready != null) {
                        open(SettingsDestination.Instructions)
                    }
                    if (ready?.settings?.proactive != null) {
                        HorizontalDivider()
                        SettingsRow(
                            stringResource(R.string.settings_proactive_services),
                            leading = { SettingsIcon(R.drawable.ic_auto_awesome) },
                            modifier = focusFor(SettingsDestination.ProactiveServices),
                            onClick = { openPage(SettingsDestination.ProactiveServices) },
                        )
                    }
                },
                account = {
                    SettingsSection(stringResource(R.string.settings_account)) {
                        SettingsGroup {
                            SettingsRow(
                                stringResource(R.string.settings_account_security),
                                leading = { SettingsIcon(R.drawable.ic_shield) },
                                modifier = focusFor(SettingsDestination.Account),
                                onClick = { openPage(SettingsDestination.Account) },
                            )
                            HorizontalDivider()
                            EmailSubscriptionSetting(
                                ready?.settings?.emailSubscription,
                            ) {
                                openPage(SettingsDestination.Account)
                            }
                        }
                    }
                },
            )
            if (instructionsOpen && ready != null) {
                PersonalInstructionsSettings(ready.instructions, close)
            }
        }
    }
}

@StringRes
private fun workspacePreparationMessage(state: SessionUiState): Int? =
    when {
        !state.working -> null
        state.stage == SessionStage.Unavailable -> R.string.chat_list_first_load_failed
        else -> R.string.auth_preparing_workspace
    }

@Composable
private fun WorkspaceSettingsPreparation(state: SessionUiState, retry: () -> Unit) {
    val message = workspacePreparationMessage(state)
    if (message != null) {
        Text(
            stringResource(message),
            modifier = Modifier.semantics { liveRegion = LiveRegionMode.Polite },
            color = MaterialTheme.colorScheme.onSurfaceVariant,
            style = MaterialTheme.typography.bodyMedium,
        )
    } else if (state.stage == SessionStage.Unavailable) {
        WorkspaceStartupRecovery(retry)
    }
}

@Composable
private fun WorkspaceStartupRecovery(
    retry: () -> Unit,
    signOut: (() -> Unit)? = null,
    signOutFailed: Boolean = false,
) {
    val textButtonColors =
        ButtonDefaults.textButtonColors(contentColor = MaterialTheme.colorScheme.onSurface)
    Column {
        Text(
            stringResource(R.string.auth_unavailable),
            modifier = Modifier.semantics { liveRegion = LiveRegionMode.Polite },
        )
        TextButton(onClick = retry, colors = textButtonColors) {
            Text(stringResource(R.string.retry))
        }
        if (signOut != null) {
            SettingsTrigger(content = { dismiss -> SignOutConfirmation(dismiss, signOut) }) {
                modifier,
                open ->
                TextButton(onClick = open, modifier = modifier, colors = textButtonColors) {
                    Text(stringResource(R.string.auth_sign_out))
                }
            }
        }
        if (signOutFailed) SignOutFailure(Modifier.padding(top = 8.dp))
    }
}

@Composable
private fun WorkspaceSettings(
    workspaceId: String,
    workspace: WorkspaceMembership?,
    state: SessionUiState,
    chooseWorkspace: (String) -> Unit,
    creditRow: @Composable () -> Unit,
) {
    val enabled = state.ready != null
    val label = stringResource(R.string.auth_workspace)
    val message = workspacePreparationMessage(state)
    val subtitle =
        if (message == null) label.takeIf { workspace != null } else stringResource(message)
    SettingsGroup {
        SettingsTrigger(
            enabled = enabled,
            content = { dismiss ->
                WorkspaceChooser(
                    workspaceId,
                    state.memberships,
                    state.workspaceSwitch,
                    chooseWorkspace,
                    dismiss,
                )
            },
        ) { modifier, open ->
            SettingsRow(
                workspace?.name ?: label,
                leading = {
                    WorkspaceLogo(workspaceId, workspace?.name, workspace?.uploadedImageUrl, 40.dp)
                },
                modifier =
                    if (message == null) modifier
                    else modifier.semantics { liveRegion = LiveRegionMode.Polite },
                supportingText = subtitle,
                onClick = open,
                enabled = enabled,
            )
        }
        HorizontalDivider()
        creditRow()
    }
}

@Composable
private fun InstructionsSetting(
    instructionsOpen: Boolean,
    enabled: Boolean,
    openInstructions: () -> Unit,
) {
    val instructionsFocus = remember { FocusRequester() }
    var focused by remember { mutableStateOf(false) }
    var restoreFocus by rememberSettingsFlag()
    LaunchedEffect(instructionsOpen, enabled) {
        if (!instructionsOpen && restoreFocus && enabled) {
            restoreFocus = false
            instructionsFocus.requestFocus()
        }
    }
    SettingsRow(
        stringResource(R.string.instructions_title),
        leading = { SettingsIcon(R.drawable.ic_edit) },
        modifier =
            Modifier.focusRequester(instructionsFocus).onFocusChanged { focused = it.isFocused },
        enabled = enabled,
        onClick = {
            restoreFocus = focused
            openInstructions()
        },
    )
}

@Composable
private fun AccountSettings(account: NativeAccount?, signOutFailed: Boolean, signOut: () -> Unit) {
    Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
        SettingsGroup {
            if (account != null) {
                SettingsRow(
                    stringResource(R.string.settings_account_email),
                    leading = { SettingsIcon(R.drawable.ic_mail) },
                    value = account.email,
                    valueMaxWidth = 192.dp,
                )
                HorizontalDivider()
            }
            SettingsRow(
                stringResource(R.string.settings_account_web),
                leading = { SettingsIcon(R.drawable.ic_shield) },
                onClick = settingsWebClick("preference"),
            )
            HorizontalDivider()
            SettingsTrigger(content = { dismiss -> SignOutConfirmation(dismiss, signOut) }) {
                modifier,
                open ->
                SettingsRow(
                    stringResource(R.string.auth_sign_out),
                    leading = { SettingsIcon(R.drawable.ic_logout) },
                    modifier = modifier,
                    onClick = open,
                    showChevron = false,
                )
            }
        }
        if (signOutFailed) SignOutFailure(Modifier.padding(horizontal = 8.dp))
    }
}

@Composable
private fun SignOutFailure(modifier: Modifier) {
    Text(
        stringResource(R.string.auth_sign_out_failed),
        modifier.semantics { liveRegion = LiveRegionMode.Polite },
        color = MaterialTheme.colorScheme.error,
        style = MaterialTheme.typography.bodyMedium,
    )
}

@Composable
private fun WorkspaceAvatar(
    workspaceId: String,
    workspace: WorkspaceMembership?,
    state: SessionUiState,
    chooseWorkspace: (String) -> Unit,
    restoreFocus: Boolean,
    onRestored: () -> Unit,
) {
    val size = workspaceSearchControlHeight()
    val enabled = state.ready != null
    val label = stringResource(R.string.auth_switch_workspace)
    val destinationFocus = remember { FocusRequester() }
    SettingsTrigger(
        enabled = enabled,
        content = { dismiss ->
            WorkspaceChooser(
                workspaceId,
                state.memberships,
                state.workspaceSwitch,
                chooseWorkspace,
                dismiss,
            )
        },
    ) { modifier, open ->
        IconButton(
            onClick = open,
            enabled = enabled,
            modifier =
                Modifier.focusRequester(destinationFocus)
                    .then(modifier)
                    .size(size)
                    .updateFocusOutline(CircleShape, MaterialTheme.colorScheme.onSurface)
                    .semantics {
                        contentDescription = workspace?.name?.let { "$label, $it" } ?: label
                    },
        ) {
            WorkspaceLogo(workspaceId, workspace?.name, workspace?.uploadedImageUrl, size)
        }
    }
    LaunchedEffect(restoreFocus, enabled) {
        if (restoreFocus && enabled) {
            destinationFocus.requestFocus()
            onRestored()
        }
    }
}

@Composable
private fun WorkspaceChooser(
    currentId: String,
    memberships: List<WorkspaceMembership>,
    workspaceSwitch: WorkspaceSwitch?,
    chooseWorkspace: (String) -> Unit,
    dismiss: () -> Unit,
) {
    var attemptedTarget by rememberWorkspaceSwitchTarget()
    val pending = workspaceSwitch?.failed == false
    val pendingDescription = stringResource(R.string.auth_switch_workspace_pending)
    SettingsSheet(
        stringResource(R.string.auth_switch_workspace),
        dismiss,
        actions =
            if (workspaceSwitch?.failed == true && workspaceSwitch.target == attemptedTarget) {
                {
                    Text(
                        stringResource(R.string.auth_switch_workspace_failed),
                        Modifier.padding(horizontal = 12.dp).semantics {
                            liveRegion = LiveRegionMode.Polite
                        },
                        color = MaterialTheme.colorScheme.error,
                        style = MaterialTheme.typography.bodyMedium,
                    )
                }
            } else null,
        dismissible = !pending,
    ) {
        val selected = remember { BringIntoViewRequester() }
        Column(Modifier.fillMaxWidth().selectableGroup()) {
            memberships.forEach { workspace ->
                val current = workspace.id == currentId
                SettingsChoiceRow(
                    workspace.name,
                    selected = current,
                    enabled = !pending,
                    onClick = {
                        if (current) dismiss()
                        else {
                            attemptedTarget = workspace.id
                            chooseWorkspace(workspace.id)
                        }
                    },
                    modifier = if (current) Modifier.bringIntoViewRequester(selected) else Modifier,
                    leading = {
                        WorkspaceLogo(
                            workspace.id,
                            workspace.name,
                            workspace.uploadedImageUrl,
                            28.dp,
                        )
                    },
                    trailing = { foreground ->
                        if (pending && workspaceSwitch.target == workspace.id) {
                            CircularProgressIndicator(
                                Modifier.size(20.dp).semantics {
                                    contentDescription = pendingDescription
                                    liveRegion = LiveRegionMode.Polite
                                },
                                color = foreground,
                                strokeWidth = 2.dp,
                            )
                        }
                    },
                )
            }
        }
        LaunchedEffect(currentId) {
            withFrameNanos {}
            selected.bringIntoView()
        }
    }
}
