package ai.okou.android.auth

import ai.okou.android.R
import ai.okou.android.SettingsGroup
import ai.okou.android.currentWindowSizeDp
import androidx.annotation.StringRes
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.safeDrawingPadding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.key
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.runtime.snapshotFlow
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.MotionDurationScale
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.LiveRegionMode
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.clearAndSetSemantics
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.semantics.liveRegion
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import kotlinx.coroutines.delay

@Composable
internal fun SessionEntryScreen(
    state: SessionUiState,
    retry: () -> Unit,
    chooseWorkspace: (String) -> Unit,
    signOut: () -> Unit,
    openWorkspaceSetup: () -> Unit,
) {
    val windowHeight = currentWindowSizeDp().height
    val compact = windowHeight < 480
    val groupSpacing = if (compact) 12.dp else 24.dp
    val choosing = state.stage == SessionStage.ChooseWorkspace
    val noWorkspace = choosing && state.memberships.isEmpty()
    val accessRemoved = state.stage == SessionStage.AccessRemoved
    val title =
        when (state.stage) {
            SessionStage.Restoring -> R.string.auth_restoring
            SessionStage.LoadingWorkspace -> R.string.auth_preparing_workspace
            SessionStage.SigningOut -> R.string.auth_signing_out
            SessionStage.ChooseWorkspace ->
                if (noWorkspace) R.string.auth_no_workspace else R.string.auth_choose_workspace
            SessionStage.AccessRemoved -> R.string.auth_access_removed
            SessionStage.UpdateRequired -> R.string.auth_update_required
            else -> R.string.auth_unavailable
        }
    val detail =
        when {
            noWorkspace -> R.string.auth_no_workspace_detail
            accessRemoved -> R.string.auth_access_removed_detail
            else -> null
        }
    val canRetry =
        !state.working &&
            state.stage != SessionStage.Restoring &&
            state.stage != SessionStage.UpdateRequired
    val canSignOut = state.stage != SessionStage.Restoring && state.stage != SessionStage.SigningOut
    Box(Modifier.fillMaxSize().safeDrawingPadding(), contentAlignment = Alignment.TopCenter) {
        Column(
            Modifier.padding(horizontal = if (compact) 16.dp else 24.dp)
                .widthIn(max = 360.dp)
                .fillMaxWidth()
                .verticalScroll(rememberScrollState())
                .padding(
                    top = if (compact) 12.dp else (windowHeight * 0.08f).coerceIn(32f, 80f).dp,
                    bottom = if (compact) 12.dp else 24.dp,
                ),
            verticalArrangement = Arrangement.spacedBy(groupSpacing),
            horizontalAlignment = Alignment.CenterHorizontally,
        ) {
            OkouAuthLogo()
            SessionEntryHeading(
                title,
                detail,
                compact = compact,
                waiting = state.stage == SessionStage.Restoring || state.working,
            )
            if (choosing && !noWorkspace) {
                SettingsGroup {
                    state.memberships.forEachIndexed { index, workspace ->
                        key(workspace.id) {
                            if (index != 0) {
                                HorizontalDivider(color = MaterialTheme.colorScheme.outlineVariant)
                            }
                            SessionWorkspaceRow(workspace) { chooseWorkspace(workspace.id) }
                        }
                    }
                }
            }
            if (canRetry || canSignOut || noWorkspace) {
                Column(Modifier.fillMaxWidth(), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                    if (noWorkspace) {
                        SessionPrimaryAction(R.string.auth_workspace_setup, openWorkspaceSetup)
                    } else if (canRetry && !choosing && canSignOut) {
                        SessionPrimaryAction(
                            if (accessRemoved) R.string.auth_check_access else R.string.retry,
                            retry,
                        )
                    }
                    FlowRow(
                        Modifier.fillMaxWidth(),
                        horizontalArrangement =
                            Arrangement.spacedBy(8.dp, Alignment.CenterHorizontally),
                        verticalArrangement = Arrangement.spacedBy(8.dp),
                    ) {
                        if (canRetry && (choosing || !canSignOut)) {
                            SessionTextAction(R.string.auth_check_workspace, retry)
                        }
                        if (canSignOut) {
                            SessionTextAction(
                                if (accessRemoved) R.string.auth_sign_in_again
                                else R.string.auth_sign_out,
                                signOut,
                            )
                        }
                    }
                }
            }
        }
    }
}

@Composable
private fun SessionWorkspaceRow(workspace: WorkspaceMembership, onClick: () -> Unit) {
    Row(
        Modifier.fillMaxWidth()
            .clickable(role = Role.Button, onClick = onClick)
            .heightIn(min = 64.dp)
            .padding(horizontal = 16.dp, vertical = 8.dp),
        horizontalArrangement = Arrangement.spacedBy(12.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        WorkspaceLogo(workspace.id, Modifier.size(36.dp))
        Text(
            workspace.name,
            modifier = Modifier.weight(1f),
            style = MaterialTheme.typography.titleMedium,
        )
        Icon(
            painterResource(R.drawable.ic_chevron_right),
            contentDescription = null,
            modifier = Modifier.size(20.dp),
            tint = MaterialTheme.colorScheme.onSurfaceVariant,
        )
    }
}

@Composable
private fun SessionEntryHeading(
    @StringRes title: Int,
    @StringRes detail: Int?,
    compact: Boolean,
    waiting: Boolean,
) {
    val typography = MaterialTheme.typography
    Column(
        verticalArrangement = Arrangement.spacedBy(8.dp),
        horizontalAlignment = Alignment.CenterHorizontally,
    ) {
        Row(
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(12.dp),
        ) {
            Text(
                stringResource(title),
                Modifier.weight(1f, fill = false).semantics {
                    heading()
                    liveRegion = LiveRegionMode.Polite
                },
                style = if (compact) typography.titleLarge else typography.headlineMedium,
                fontWeight = FontWeight(650),
                textAlign = TextAlign.Center,
            )
            if (waiting) SessionEntryProgress()
        }
        if (detail != null) {
            Text(
                stringResource(detail),
                style = typography.bodyMedium,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
                textAlign = TextAlign.Center,
            )
        }
    }
}

@Composable
private fun SessionEntryProgress() {
    var visible by remember { mutableStateOf(false) }
    LaunchedEffect(Unit) {
        delay(250)
        val motion = coroutineContext[MotionDurationScale]
        motion?.scaleFactor
        snapshotFlow { motion?.scaleFactor != 0f }.collect { visible = it }
    }
    Box(Modifier.size(20.dp).clearAndSetSemantics {}) {
        if (visible) {
            CircularProgressIndicator(
                modifier = Modifier.fillMaxSize(),
                color = MaterialTheme.colorScheme.onSurfaceVariant,
                strokeWidth = 2.dp,
            )
        }
    }
}

@Composable
private fun SessionPrimaryAction(@StringRes label: Int, onClick: () -> Unit) {
    Button(onClick = onClick, modifier = Modifier.fillMaxWidth().heightIn(min = 48.dp)) {
        Text(stringResource(label), textAlign = TextAlign.Center)
    }
}

@Composable
private fun SessionTextAction(@StringRes label: Int, onClick: () -> Unit) {
    TextButton(
        onClick = onClick,
        modifier = Modifier.heightIn(min = 48.dp),
        colors = ButtonDefaults.textButtonColors(contentColor = MaterialTheme.colorScheme.onSurface),
    ) {
        Text(stringResource(label), textAlign = TextAlign.Center)
    }
}
