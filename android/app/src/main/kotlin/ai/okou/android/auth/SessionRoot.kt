package ai.okou.android.auth

import ai.okou.android.AppearanceMode
import ai.okou.android.AppearanceUiState
import ai.okou.android.OkouApp
import ai.okou.android.R
import ai.okou.android.preferences.MemberPreferencesSettings
import androidx.compose.foundation.Image
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.safeDrawingPadding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Button
import androidx.compose.material3.CircularProgressIndicator
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
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.LiveRegionMode
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.semantics.liveRegion
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.unit.dp
import com.clerk.api.ui.ClerkColors
import com.clerk.api.ui.ClerkTheme
import com.clerk.api.ui.ClerkTypography
import com.clerk.ui.auth.AuthView

@Composable
fun SessionRoot(
    state: SessionUiState,
    appearance: AppearanceUiState,
    selectAppearance: (AppearanceMode) -> Unit,
    retryAppearance: () -> Unit,
    retry: () -> Unit,
    chooseWorkspace: (String) -> Unit,
    signOut: () -> Unit,
    openWorkspaceSetup: () -> Unit,
) {
    Surface(Modifier.fillMaxSize(), color = MaterialTheme.colorScheme.background) {
        val ready = state.ready
        if (state.stage == SessionStage.Ready && ready != null) {
            key(ready.identity, state.generation) {
                OkouApp(
                    ready.home,
                    appearance,
                    selectAppearance,
                    retryAppearance,
                    account = { WorkspaceActions(state, chooseWorkspace, signOut) },
                    workspacePreferences = { MemberPreferencesSettings(ready.preferences) },
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
                    CircularProgressIndicator()
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
                    TextButton(onClick = retry) { Text(stringResource(R.string.retry)) }
                }
                if (
                    state.stage != SessionStage.Restoring && state.stage != SessionStage.SigningOut
                ) {
                    TextButton(onClick = signOut) { Text(stringResource(R.string.auth_sign_out)) }
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
private fun WorkspaceActions(
    state: SessionUiState,
    chooseWorkspace: (String) -> Unit,
    signOut: () -> Unit,
) {
    var choosing by remember { mutableStateOf(false) }
    Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
        Text(stringResource(R.string.auth_workspace), style = MaterialTheme.typography.titleLarge)
        Text(checkNotNull(state.ready).organization.name)
        if (state.memberships.size > 1) {
            OutlinedButton(onClick = { choosing = true }) {
                Text(stringResource(R.string.auth_switch_workspace))
            }
        }
        TextButton(onClick = signOut) { Text(stringResource(R.string.auth_sign_out)) }
    }
    if (choosing) {
        AlertDialog(
            onDismissRequest = { choosing = false },
            title = { Text(stringResource(R.string.auth_choose_workspace)) },
            text = {
                Column(Modifier.verticalScroll(rememberScrollState())) {
                    state.memberships.forEach { workspace ->
                        TextButton(
                            onClick = {
                                choosing = false
                                chooseWorkspace(workspace.id)
                            },
                            modifier = Modifier.fillMaxWidth(),
                        ) {
                            Text(workspace.name)
                        }
                    }
                }
            },
            confirmButton = {
                TextButton(onClick = { choosing = false }) { Text(stringResource(R.string.back)) }
            },
        )
    }
}
