package ai.okou.android.auth

import ai.okou.android.LocalActivityStatusColor
import ai.okou.android.OkouApp
import ai.okou.android.OkouConfirmationDialog
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
import ai.okou.android.instructions.PersonalInstructionsSettings
import ai.okou.android.preferences.MemberPreferencesSettings
import ai.okou.android.preferences.PreferenceFeedback
import ai.okou.android.settings.WorkspaceSettingsDataPage
import ai.okou.android.settings.settingsWebClick
import ai.okou.android.state.SettingsDestination
import ai.okou.android.state.rememberSettingsFlag
import ai.okou.android.state.rememberSettingsReturnFocus
import ai.okou.android.state.rememberWorkspaceSwitchTarget
import ai.okou.android.updates.UpdateToolbarAction
import ai.okou.android.updates.updateFocusOutline
import ai.okou.android.workspaceSearchControlHeight
import androidx.annotation.StringRes
import androidx.compose.foundation.Image
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.safeDrawingPadding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.relocation.BringIntoViewRequester
import androidx.compose.foundation.relocation.bringIntoViewRequester
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.selection.selectableGroup
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.key
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.runtime.withFrameNanos
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.focus.FocusRequester
import androidx.compose.ui.focus.focusRequester
import androidx.compose.ui.focus.onFocusChanged
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.LiveRegionMode
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.heading
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
    onUpdateEditingChanged: (Boolean) -> Unit = {},
) {
    val textButtonColors =
        ButtonDefaults.textButtonColors(contentColor = MaterialTheme.colorScheme.onSurface)
    var switchTarget by rememberWorkspaceSwitchTarget()
    Surface(Modifier.fillMaxSize(), color = MaterialTheme.colorScheme.background) {
        val ready = state.ready
        val opened = state.opening as? OpeningWorkspace.Authorized
        val identity = ready?.identity ?: state.opening?.identity
        val organization = ready?.organization ?: opened?.organization
        val workspaceName =
            organization?.name
                ?: state.memberships.firstOrNull { it.id == identity?.workspaceId }?.name
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
                if (ready != null) WorkspaceRealtimeLifecycle(ready.chats.updates)
                val startupRecovery: (@Composable () -> Unit)? =
                    if (state.stage == SessionStage.Unavailable && !state.working) {
                        { WorkspaceStartupRecovery(retry, signOut) }
                    } else null
                OkouApp(
                    ready?.chats ?: opened?.chats,
                    ready?.composer ?: opened?.composer,
                    ready?.controls,
                    workflows = ready?.workflows,
                    workflowTimezone =
                        ready
                            ?.preferences
                            ?.uiState
                            ?.collectAsStateWithLifecycle()
                            ?.value
                            ?.confirmed
                            ?.timezone ?: java.util.TimeZone.getDefault().id,
                    projectExpansion = ready?.projectExpansion ?: opened?.projectExpansion,
                    settingsContent = { destination, open, close ->
                        WorkspaceSettingsContent(
                            destination,
                            state,
                            identity.workspaceId,
                            workspaceName,
                            open,
                            close,
                            switchWorkspace,
                            account?.takeIf { it.userId == identity.userId },
                            signOut,
                            appUpdates,
                            retry,
                        )
                    },
                    recovery = ready?.recovery,
                    artifacts = ready?.artifacts,
                    chatArtifacts = ready?.chatArtifacts,
                    connectors = ready?.connectors,
                    workspaceName = workspaceName,
                    workspaceAvatar = {
                        WorkspaceAvatar(
                            identity.workspaceId,
                            workspaceName,
                            state,
                            switchWorkspace,
                            restoreFocus = switchTarget == identity.workspaceId,
                            onRestored = { switchTarget = null },
                        )
                    },
                    updateToolbarAction = updateToolbarAction,
                    onUpdateEditingChanged = onUpdateEditingChanged,
                    workspaceReady = ready != null,
                    startupRecovery = startupRecovery,
                )
            }
        } else if (state.stage == SessionStage.SignIn) {
            NativeAuthentication()
        } else {
            Column(
                Modifier.fillMaxSize()
                    .safeDrawingPadding()
                    .verticalScroll(rememberScrollState())
                    .padding(24.dp),
                verticalArrangement = Arrangement.spacedBy(20.dp, Alignment.CenterVertically),
                horizontalAlignment = Alignment.CenterHorizontally,
            ) {
                OkouAuthLogo()
                Text(
                    stringResource(R.string.auth_welcome),
                    style = MaterialTheme.typography.headlineMedium,
                    modifier = Modifier.semantics { heading() },
                )
                val message =
                    when (state.stage) {
                        SessionStage.Restoring -> R.string.auth_restoring
                        SessionStage.LoadingWorkspace -> R.string.auth_preparing_workspace
                        SessionStage.SigningOut -> R.string.auth_signing_out
                        SessionStage.ChooseWorkspace ->
                            if (state.memberships.isEmpty()) R.string.auth_no_workspace
                            else R.string.auth_choose_workspace
                        SessionStage.AccessRemoved -> R.string.auth_access_removed
                        SessionStage.UpdateRequired -> R.string.auth_update_required
                        else -> R.string.auth_unavailable
                    }
                Text(
                    stringResource(message),
                    modifier = Modifier.semantics { liveRegion = LiveRegionMode.Polite },
                )
                if (state.stage == SessionStage.Restoring || state.working) {
                    CircularProgressIndicator(color = MaterialTheme.colorScheme.onSurface)
                }
                if (state.stage == SessionStage.ChooseWorkspace) {
                    state.memberships.forEach { workspace ->
                        OutlinedButton(onClick = { chooseWorkspace(workspace.id) }) {
                            Text(workspace.name)
                        }
                    }
                    if (state.memberships.isEmpty()) {
                        Button(onClick = openWorkspaceSetup) {
                            Text(stringResource(R.string.auth_workspace_setup))
                        }
                    }
                }
                if (
                    !state.working &&
                        state.stage != SessionStage.Restoring &&
                        state.stage != SessionStage.UpdateRequired
                ) {
                    TextButton(onClick = retry, colors = textButtonColors) {
                        Text(stringResource(R.string.retry))
                    }
                }
                if (
                    state.stage != SessionStage.Restoring && state.stage != SessionStage.SigningOut
                ) {
                    TextButton(onClick = signOut, colors = textButtonColors) {
                        Text(stringResource(R.string.auth_sign_out))
                    }
                }
            }
        }
    }
}

@Composable
private fun NativeAuthentication() {
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
                    ring = colors.primary,
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
    AuthView(
        modifier = Modifier.safeDrawingPadding(),
        clerkTheme = theme,
        logo = { OkouAuthLogo() },
        isDismissible = false,
        persistIdentifiers = false,
        preferGoogleOneTap = false,
    )
}

@Composable
private fun OkouAuthLogo() {
    Column(
        horizontalAlignment = Alignment.CenterHorizontally,
        verticalArrangement = Arrangement.spacedBy(12.dp),
    ) {
        Image(
            painterResource(R.drawable.okou_mark),
            contentDescription = null,
            modifier = Modifier.size(64.dp),
        )
        Text(stringResource(R.string.app_name), style = MaterialTheme.typography.headlineLarge)
    }
}

@Composable
private fun WorkspaceSettingsContent(
    destination: SettingsDestination,
    state: SessionUiState,
    workspaceId: String,
    workspaceName: String?,
    open: (SettingsDestination) -> Unit,
    close: () -> Unit,
    switchWorkspace: (String) -> Unit,
    account: NativeAccount?,
    signOut: () -> Unit,
    appUpdates: @Composable (() -> Unit)?,
    retry: () -> Unit,
) {
    val ready = state.ready
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
        SettingsDestination.Account -> AccountSettings(account, signOut)
        SettingsDestination.Overview,
        SettingsDestination.Instructions -> {
            val instructionsOpen = destination == SettingsDestination.Instructions
            val preferenceModel = ready?.preferences
            val preferences = preferenceModel?.uiState?.collectAsStateWithLifecycle()?.value
            SettingsScreen(
                appUpdates = appUpdates,
                workspacePreferences = {
                    MemberPreferencesSettings(preferenceModel, state.cachedAppearance)
                    if (state.stage == SessionStage.Unavailable && !state.working) {
                        WorkspaceStartupRecovery(retry)
                    }
                },
                workspace = {
                    WorkspaceSettings(workspaceId, workspaceName, state, switchWorkspace) {
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
                            checked = preferences?.cloudBrowser,
                            supportingText = stringResource(R.string.settings_cloud_browser_detail),
                            onCheckedChange = preferenceModel?.let { it::setCloudBrowser },
                        )
                    }
                    if (preferenceModel != null && preferences?.pending?.cloudBrowser != null) {
                        PreferenceFeedback(preferences, preferenceModel::retry)
                    }
                },
                myOkou = {
                    InstructionsSetting(instructionsOpen, ready != null) {
                        open(SettingsDestination.Instructions)
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
                        }
                    }
                },
            )
            if (instructionsOpen && ready != null) {
                val chatState by ready.chats.uiState.collectAsStateWithLifecycle()
                PersonalInstructionsSettings(ready.instructions, close, chatState.offline)
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
private fun WorkspaceStartupRecovery(retry: () -> Unit, signOut: (() -> Unit)? = null) {
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
            TextButton(onClick = signOut, colors = textButtonColors) {
                Text(stringResource(R.string.auth_sign_out))
            }
        }
    }
}

@Composable
private fun WorkspaceSettings(
    workspaceId: String,
    workspaceName: String?,
    state: SessionUiState,
    chooseWorkspace: (String) -> Unit,
    creditRow: @Composable () -> Unit,
) {
    val enabled = state.ready != null
    val label = stringResource(R.string.auth_workspace)
    val message = workspacePreparationMessage(state)
    val subtitle =
        if (message == null) label.takeIf { workspaceName != null } else stringResource(message)
    SettingsGroup {
        SettingsTrigger(
            enabled = enabled,
            content = { dismiss ->
                WorkspaceChooser(workspaceId, state.memberships, chooseWorkspace, dismiss)
            },
        ) { modifier, open ->
            SettingsRow(
                workspaceName ?: label,
                leading = { WorkspaceLogo(workspaceId, Modifier.size(40.dp)) },
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
private fun AccountSettings(account: NativeAccount?, signOut: () -> Unit) {
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
        SettingsTrigger(
            content = { dismiss ->
                OkouConfirmationDialog(
                    title = stringResource(R.string.settings_sign_out_title),
                    confirm = stringResource(R.string.auth_sign_out),
                    onDismiss = dismiss,
                    onConfirm = {
                        dismiss()
                        signOut()
                    },
                ) {
                    Text(stringResource(R.string.settings_sign_out_body))
                }
            }
        ) { modifier, open ->
            SettingsRow(
                stringResource(R.string.auth_sign_out),
                leading = { SettingsIcon(R.drawable.ic_logout) },
                modifier = modifier,
                onClick = open,
                showChevron = false,
            )
        }
    }
}

@Composable
private fun WorkspaceAvatar(
    workspaceId: String,
    workspaceName: String?,
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
            WorkspaceChooser(workspaceId, state.memberships, chooseWorkspace, dismiss)
        },
    ) { modifier, open ->
        IconButton(
            onClick = open,
            enabled = enabled,
            modifier =
                Modifier.focusRequester(destinationFocus)
                    .then(modifier)
                    .size(size)
                    .updateFocusOutline(CircleShape, LocalActivityStatusColor.current)
                    .semantics {
                        contentDescription = workspaceName?.let { "$label, $it" } ?: label
                    },
        ) {
            WorkspaceLogo(workspaceId, Modifier.size(size))
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
private fun WorkspaceLogo(id: String, modifier: Modifier) {
    val logo = remember(id) { workspaceLogo(id) }
    Image(painterResource(logo), contentDescription = null, modifier = modifier.clip(CircleShape))
}

// The Web and iOS clients use FNV-1a over UTF-16 to select the same bundled brand tile.
private fun workspaceLogo(id: String): Int {
    val hash = id.fold(2_166_136_261u) { hash, char -> (hash xor char.code.toUInt()) * 16_777_619u }
    return workspaceLogos[(hash % workspaceLogos.size.toUInt()).toInt()]
}

private val workspaceLogos =
    intArrayOf(
        R.drawable.workspace_default_0,
        R.drawable.workspace_default_1,
        R.drawable.workspace_default_2,
        R.drawable.workspace_default_3,
        R.drawable.workspace_default_4,
        R.drawable.workspace_default_5,
        R.drawable.workspace_default_6,
        R.drawable.workspace_default_7,
    )

@Composable
private fun WorkspaceChooser(
    currentId: String,
    memberships: List<WorkspaceMembership>,
    chooseWorkspace: (String) -> Unit,
    dismiss: () -> Unit,
) {
    SettingsSheet(stringResource(R.string.auth_switch_workspace), dismiss) {
        val selected = remember { BringIntoViewRequester() }
        Column(Modifier.fillMaxWidth().selectableGroup()) {
            memberships.forEach { workspace ->
                val current = workspace.id == currentId
                SettingsChoiceRow(
                    workspace.name,
                    selected = current,
                    enabled = true,
                    onClick = {
                        dismiss()
                        if (!current) chooseWorkspace(workspace.id)
                    },
                    modifier = if (current) Modifier.bringIntoViewRequester(selected) else Modifier,
                    leading = { WorkspaceLogo(workspace.id, Modifier.size(28.dp)) },
                )
            }
        }
        LaunchedEffect(currentId) {
            withFrameNanos {}
            selected.bringIntoView()
        }
    }
}
