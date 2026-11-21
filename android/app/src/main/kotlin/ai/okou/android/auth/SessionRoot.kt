package ai.okou.android.auth

import ai.okou.android.LocalActivityStatusColor
import ai.okou.android.OkouApp
import ai.okou.android.R
import ai.okou.android.SettingsChoiceRow
import ai.okou.android.SettingsConfirmation
import ai.okou.android.SettingsGroup
import ai.okou.android.SettingsIcon
import ai.okou.android.SettingsRow
import ai.okou.android.SettingsScreen
import ai.okou.android.SettingsSection
import ai.okou.android.SettingsSheet
import ai.okou.android.SettingsTrigger
import ai.okou.android.api.generated.Organization
import ai.okou.android.chat.WorkspaceRealtimeLifecycle
import ai.okou.android.instructions.PersonalInstructionsSettings
import ai.okou.android.preferences.MemberPreferencesSettings
import ai.okou.android.state.SettingsDestination
import ai.okou.android.state.rememberSettingsFlag
import ai.okou.android.state.rememberWorkspaceSwitchTarget
import ai.okou.android.updates.UpdateToolbarAction
import ai.okou.android.updates.updateFocusOutline
import ai.okou.android.workspaceSearchControlHeight
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
                    settingsContent = { destination, openInstructions, closeInstructions ->
                        if (ready != null) {
                            val instructionsOpen = destination == SettingsDestination.Instructions
                            SettingsScreen(
                                appUpdates = appUpdates,
                                workspacePreferences = {
                                    MemberPreferencesSettings(ready.preferences)
                                },
                                workspace = { WorkspaceSettings(state, switchWorkspace) },
                                conversation = {
                                    InstructionsSetting(instructionsOpen, openInstructions)
                                },
                                account = {
                                    AccountSettings(
                                        account?.takeIf { it.userId == ready.identity.userId },
                                        signOut,
                                    )
                                },
                            )
                            if (instructionsOpen) {
                                val chatState by ready.chats.uiState.collectAsStateWithLifecycle()
                                PersonalInstructionsSettings(
                                    ready.instructions,
                                    closeInstructions,
                                    chatState.offline,
                                )
                            }
                        }
                    },
                    recovery = ready?.recovery,
                    artifacts = ready?.artifacts ?: opened?.artifacts,
                    workspaceName = organization?.name,
                    workspaceAvatar =
                        organization?.let { workspace ->
                            {
                                WorkspaceAvatar(
                                    workspace,
                                    state,
                                    switchWorkspace,
                                    restoreFocus = switchTarget == workspace.id,
                                    onRestored = { switchTarget = null },
                                )
                            }
                        },
                    updateToolbarAction = updateToolbarAction,
                    onUpdateEditingChanged = onUpdateEditingChanged,
                    workspaceReady = ready != null,
                    startupRecovery =
                        if (state.stage == SessionStage.Unavailable) {
                            {
                                Column {
                                    Text(
                                        stringResource(R.string.auth_unavailable),
                                        modifier =
                                            Modifier.semantics {
                                                liveRegion = LiveRegionMode.Polite
                                            },
                                    )
                                    TextButton(onClick = retry, colors = textButtonColors) {
                                        Text(stringResource(R.string.retry))
                                    }
                                    TextButton(onClick = signOut, colors = textButtonColors) {
                                        Text(stringResource(R.string.auth_sign_out))
                                    }
                                }
                            }
                        } else null,
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
private fun WorkspaceSettings(state: SessionUiState, chooseWorkspace: (String) -> Unit) {
    val organization = checkNotNull(state.ready).organization
    SettingsGroup {
        SettingsTrigger(
            content = { dismiss ->
                WorkspaceChooser(organization.id, state.memberships, chooseWorkspace, dismiss)
            }
        ) { modifier, open ->
            SettingsRow(
                organization.name,
                leading = { WorkspaceLogo(organization.id, Modifier.size(40.dp)) },
                modifier = modifier,
                supportingText = stringResource(R.string.auth_workspace),
                onClick = open,
            )
        }
    }
}

@Composable
private fun InstructionsSetting(instructionsOpen: Boolean, openInstructions: () -> Unit) {
    val instructionsFocus = remember { FocusRequester() }
    var focused by remember { mutableStateOf(false) }
    var restoreFocus by rememberSettingsFlag()
    LaunchedEffect(instructionsOpen) {
        if (!instructionsOpen && restoreFocus) {
            restoreFocus = false
            instructionsFocus.requestFocus()
        }
    }
    SettingsRow(
        stringResource(R.string.instructions_title),
        leading = { SettingsIcon(R.drawable.ic_edit) },
        modifier =
            Modifier.focusRequester(instructionsFocus).onFocusChanged { focused = it.isFocused },
        onClick = {
            restoreFocus = focused
            openInstructions()
        },
    )
}

@Composable
private fun AccountSettings(account: NativeAccount?, signOut: () -> Unit) {
    SettingsSection(stringResource(R.string.settings_account)) {
        SettingsGroup {
            if (account != null) {
                SettingsRow(account.email, leading = { SettingsIcon(R.drawable.ic_account_circle) })
                HorizontalDivider()
            }
            SettingsTrigger(
                content = { dismiss ->
                    SettingsConfirmation(
                        title = stringResource(R.string.settings_sign_out_title),
                        message = stringResource(R.string.settings_sign_out_body),
                        confirm = stringResource(R.string.auth_sign_out),
                        onDismiss = dismiss,
                        onConfirm = {
                            dismiss()
                            signOut()
                        },
                    )
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
}

@Composable
private fun WorkspaceAvatar(
    workspace: Organization,
    state: SessionUiState,
    chooseWorkspace: (String) -> Unit,
    restoreFocus: Boolean,
    onRestored: () -> Unit,
) {
    val size = workspaceSearchControlHeight()
    if (state.ready != null) {
        val label = stringResource(R.string.auth_switch_workspace)
        val destinationFocus = remember { FocusRequester() }
        SettingsTrigger(
            content = { dismiss ->
                WorkspaceChooser(workspace.id, state.memberships, chooseWorkspace, dismiss)
            }
        ) { modifier, open ->
            IconButton(
                onClick = open,
                modifier =
                    Modifier.focusRequester(destinationFocus)
                        .then(modifier)
                        .size(size)
                        .updateFocusOutline(CircleShape, LocalActivityStatusColor.current)
                        .semantics { contentDescription = "$label, ${workspace.name}" },
            ) {
                WorkspaceLogo(workspace.id, Modifier.size(size))
            }
        }
        LaunchedEffect(restoreFocus) {
            if (restoreFocus) {
                destinationFocus.requestFocus()
                onRestored()
            }
        }
    } else {
        WorkspaceLogo(workspace.id, Modifier.size(size), workspace.name)
    }
}

@Composable
private fun WorkspaceLogo(id: String, modifier: Modifier, label: String? = null) {
    val logo = remember(id) { workspaceLogo(id) }
    Image(painterResource(logo), contentDescription = label, modifier = modifier.clip(CircleShape))
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
