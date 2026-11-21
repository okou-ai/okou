package ai.okou.android.auth

import ai.okou.android.OkouApp
import ai.okou.android.R
import ai.okou.android.SettingsGroup
import ai.okou.android.SettingsIcon
import ai.okou.android.SettingsRow
import ai.okou.android.SettingsScreen
import ai.okou.android.SettingsSection
import ai.okou.android.WorkspaceFilterSubtitle
import ai.okou.android.api.generated.Organization
import ai.okou.android.chat.ChatListFilter
import ai.okou.android.chat.WorkspaceRealtimeLifecycle
import ai.okou.android.currentWindowSizeDp
import ai.okou.android.instructions.PersonalInstructionsSettings
import ai.okou.android.preferences.MemberPreferencesSettings
import ai.okou.android.state.SettingsDestination
import ai.okou.android.updates.UpdateToolbarAction
import ai.okou.android.workspaceListPaneWidth
import ai.okou.android.workspaceListTitleStyle
import androidx.compose.foundation.Image
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.RowScope
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.safeDrawingPadding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.key
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.LiveRegionMode
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.semantics.liveRegion
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
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
    appUpdates: @Composable (() -> Unit)? = null,
    updateToolbarAction: UpdateToolbarAction? = null,
    onUpdateEditingChanged: (Boolean) -> Unit = {},
) {
    val textButtonColors =
        ButtonDefaults.textButtonColors(contentColor = MaterialTheme.colorScheme.onSurface)
    Surface(Modifier.fillMaxSize(), color = MaterialTheme.colorScheme.background) {
        val ready = state.ready
        val opened = state.opening as? OpeningWorkspace.Authorized
        val identity = ready?.identity ?: state.opening?.identity
        val organization = ready?.organization ?: opened?.organization
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
                    ready?.composer,
                    ready?.controls,
                    projectExpansion = ready?.projectExpansion ?: opened?.projectExpansion,
                    settingsContent = { destination, openInstructions ->
                        if (ready != null) {
                            when (destination) {
                                SettingsDestination.Overview ->
                                    SettingsScreen(
                                        appUpdates = appUpdates,
                                        workspacePreferences = {
                                            MemberPreferencesSettings(ready.preferences)
                                        },
                                        workspace = { WorkspaceSettings(state, chooseWorkspace) },
                                        account = { AccountSettings(openInstructions, signOut) },
                                    )
                                SettingsDestination.Instructions ->
                                    PersonalInstructionsSettings(ready.instructions)
                            }
                        }
                    },
                    recovery = ready?.recovery,
                    workspaceTitle =
                        organization?.let { workspace ->
                            { filter -> WorkspaceTitle(workspace, state, filter, chooseWorkspace) }
                        },
                    updateToolbarAction = updateToolbarAction,
                    onUpdateEditingChanged = onUpdateEditingChanged,
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
    var choosing by remember { mutableStateOf(false) }
    val organization = checkNotNull(state.ready).organization
    val canSwitch = state.memberships.size > 1
    SettingsSection(stringResource(R.string.auth_workspace)) {
        SettingsGroup {
            SettingsRow(
                organization.name,
                leading = {
                    val logo = remember(organization.id) { workspaceLogo(organization.id) }
                    Image(
                        painterResource(logo),
                        contentDescription = null,
                        modifier = Modifier.size(24.dp).clip(RoundedCornerShape(6.dp)),
                    )
                },
                value = if (canSwitch) stringResource(R.string.auth_switch_workspace) else null,
                onClick = if (canSwitch) ({ choosing = true }) else null,
            )
        }
    }
    if (choosing) {
        WorkspaceChooser(state, chooseWorkspace) { choosing = false }
    }
}

@Composable
private fun AccountSettings(openInstructions: () -> Unit, signOut: () -> Unit) {
    SettingsSection(stringResource(R.string.settings_account)) {
        SettingsGroup {
            SettingsRow(
                stringResource(R.string.instructions_title),
                leading = { SettingsIcon(R.drawable.ic_settings) },
                onClick = openInstructions,
            )
            HorizontalDivider()
            SettingsRow(
                stringResource(R.string.auth_sign_out),
                leading = { SettingsIcon(R.drawable.ic_logout) },
                onClick = signOut,
                showChevron = false,
            )
        }
    }
}

@Composable
private fun WorkspaceTitle(
    workspace: Organization,
    state: SessionUiState,
    filter: ChatListFilter,
    chooseWorkspace: (String) -> Unit,
) {
    val canSwitch = state.ready != null && state.memberships.size > 1
    val window = currentWindowSizeDp()
    val pane = workspaceListPaneWidth(window.width, window.height)
    val logoSize = if (pane == null) 28.dp else 26.dp
    val spacing = if (pane == null) 8.dp else 6.dp
    var choosing by remember { mutableStateOf(false) }
    val identity: @Composable RowScope.() -> Unit = {
        val logo = remember(workspace.id) { workspaceLogo(workspace.id) }
        Image(
            painterResource(logo),
            contentDescription = null,
            modifier = Modifier.size(logoSize).clip(RoundedCornerShape(8.dp)),
        )
        Column(Modifier.padding(start = spacing).weight(1f, fill = false)) {
            Row(verticalAlignment = Alignment.CenterVertically) {
                Text(
                    workspace.name,
                    Modifier.weight(1f, fill = false),
                    style = workspaceListTitleStyle(window.width, pane),
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis,
                )
                if (canSwitch) {
                    Icon(
                        painterResource(R.drawable.ic_expand_more),
                        stringResource(R.string.auth_switch_workspace),
                        Modifier.padding(start = spacing).size(14.dp),
                    )
                }
            }
            WorkspaceFilterSubtitle(filter)
        }
    }
    if (canSwitch) {
        TextButton(
            onClick = { choosing = true },
            modifier = Modifier.heightIn(min = 48.dp),
            shape = RoundedCornerShape(12.dp),
            colors =
                ButtonDefaults.textButtonColors(contentColor = MaterialTheme.colorScheme.onSurface),
            contentPadding =
                PaddingValues(
                    start = spacing,
                    top = spacing,
                    end = if (pane == 320 || window.width < 360) 0.dp else spacing,
                    bottom = spacing,
                ),
            content = identity,
        )
        if (choosing) WorkspaceChooser(state, chooseWorkspace) { choosing = false }
    } else {
        Row(
            Modifier.heightIn(min = 48.dp).padding(spacing),
            verticalAlignment = Alignment.CenterVertically,
            content = identity,
        )
    }
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
    state: SessionUiState,
    chooseWorkspace: (String) -> Unit,
    dismiss: () -> Unit,
) {
    val colors = ButtonDefaults.textButtonColors(contentColor = MaterialTheme.colorScheme.onSurface)
    AlertDialog(
        onDismissRequest = dismiss,
        title = { Text(stringResource(R.string.auth_choose_workspace)) },
        text = {
            Column(Modifier.verticalScroll(rememberScrollState())) {
                state.memberships.forEach { workspace ->
                    TextButton(
                        onClick = {
                            dismiss()
                            chooseWorkspace(workspace.id)
                        },
                        modifier = Modifier.fillMaxWidth(),
                        colors = colors,
                    ) {
                        Text(workspace.name)
                    }
                }
            }
        },
        confirmButton = {
            TextButton(onClick = dismiss, colors = colors) { Text(stringResource(R.string.back)) }
        },
    )
}
