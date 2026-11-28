package ai.okou.android.auth

import ai.okou.android.EntryBrand
import ai.okou.android.EntryCompactHeight
import ai.okou.android.EntryContentGutter
import ai.okou.android.EntryContentWidth
import ai.okou.android.OkouConfirmationDialog
import ai.okou.android.R
import ai.okou.android.SettingsGroup
import ai.okou.android.WithButtonFocusOutline
import ai.okou.android.currentWindowSizeDp
import ai.okou.android.entrySpacing
import ai.okou.android.entryTitleStyle
import ai.okou.android.entryTopPadding
import ai.okou.android.updates.updateFocusOutline
import androidx.annotation.StringRes
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.safeDrawingPadding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
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
import androidx.compose.ui.focus.FocusRequester
import androidx.compose.ui.focus.focusRequester
import androidx.compose.ui.focus.onFocusChanged
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.Shape
import androidx.compose.ui.platform.LocalWindowInfo
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.LiveRegionMode
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.clearAndSetSemantics
import androidx.compose.ui.semantics.disabled
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.semantics.liveRegion
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import kotlinx.coroutines.delay

private data class EntryRowFocus(val workspaceId: String, val pageGeneration: Long)

@Composable
internal fun SessionEntryScreen(
    state: SessionUiState,
    retry: () -> Unit,
    chooseWorkspace: (String) -> Unit,
    signOut: () -> Unit,
    openWorkspaceSetup: () -> Unit,
) {
    val windowHeight = currentWindowSizeDp().height
    val compact = windowHeight < EntryCompactHeight
    val groupSpacing = entrySpacing(compact)
    if (state.stage == SessionStage.Restoring && !state.signingOut) {
        Box(Modifier.fillMaxSize().safeDrawingPadding(), contentAlignment = Alignment.Center) {
            EntryBrand(compact)
        }
        return
    }
    val choosing = !state.signingOut && state.stage == SessionStage.ChooseWorkspace
    val noWorkspace = choosing && state.memberships.isEmpty()
    val accessRemoved = !state.signingOut && state.stage == SessionStage.AccessRemoved
    var activatedRow by remember { mutableStateOf<EntryRowFocus?>(null) }
    val rowFocus = remember { FocusRequester() }
    val windowFocused = LocalWindowInfo.current.isWindowFocused
    var confirmSignOut by remember(state.entryPageGeneration) { mutableStateOf(false) }
    val signOutFocus = remember(state.entryPageGeneration) { FocusRequester() }
    var signOutFocused by remember(state.entryPageGeneration) { mutableStateOf(false) }
    var restoreSignOutFocus by remember(state.entryPageGeneration) { mutableStateOf(false) }
    val title =
        when {
            state.signingOut -> R.string.auth_signing_out
            state.stage == SessionStage.LoadingWorkspace -> R.string.auth_preparing_workspace
            choosing ->
                if (noWorkspace) R.string.auth_no_workspace else R.string.auth_choose_workspace
            accessRemoved -> R.string.auth_access_removed
            state.stage == SessionStage.UpdateRequired -> R.string.auth_update_required
            else -> R.string.auth_unavailable
        }
    val detail =
        when {
            noWorkspace -> R.string.auth_no_workspace_detail
            accessRemoved -> R.string.auth_access_removed_detail
            else -> null
        }
    val canRetry =
        !state.signingOut &&
            !state.working &&
            !state.entryReadFailed &&
            (!choosing || noWorkspace) &&
            state.stage != SessionStage.UpdateRequired
    val canSignOut =
        !state.signingOut &&
            state.stage != SessionStage.LoadingWorkspace &&
            state.stage != SessionStage.UpdateRequired
    val restoredRow = activatedRow?.takeIf { target ->
        choosing &&
            state.entryFailure == SessionEntryFailure.Selection &&
            target.pageGeneration == state.entryPageGeneration &&
            state.memberships.any { it.id == target.workspaceId }
    }
    LaunchedEffect(restoredRow, windowFocused) {
        if (restoredRow != null && windowFocused) {
            rowFocus.requestFocus()
            activatedRow = null
        }
    }
    LaunchedEffect(confirmSignOut, canSignOut, windowFocused) {
        if (!confirmSignOut && canSignOut && windowFocused && restoreSignOutFocus) {
            signOutFocus.requestFocus()
            restoreSignOutFocus = false
        }
    }
    Box(Modifier.fillMaxSize().safeDrawingPadding(), contentAlignment = Alignment.TopCenter) {
        Column(
            Modifier.padding(horizontal = EntryContentGutter)
                .widthIn(max = EntryContentWidth)
                .fillMaxWidth()
                .verticalScroll(rememberScrollState())
                .padding(
                    top = entryTopPadding(windowHeight),
                    bottom = groupSpacing,
                ),
            verticalArrangement = Arrangement.spacedBy(groupSpacing),
            horizontalAlignment = Alignment.CenterHorizontally,
        ) {
            EntryBrand(compact)
            SessionEntryHeading(
                title,
                detail,
                compact = compact,
                waiting = state.signingOut || state.working,
            )
            if (choosing && !noWorkspace) {
                SettingsGroup(color = MaterialTheme.colorScheme.surface) {
                    state.memberships.forEachIndexed { index, workspace ->
                        key(workspace.id) {
                            if (index != 0) {
                                HorizontalDivider(color = MaterialTheme.colorScheme.outlineVariant)
                            }
                            val top = if (index == 0) 16.dp else 0.dp
                            val bottom = if (index == state.memberships.lastIndex) 16.dp else 0.dp
                            SessionWorkspaceRow(
                                workspace,
                                RoundedCornerShape(
                                    topStart = top,
                                    topEnd = top,
                                    bottomEnd = bottom,
                                    bottomStart = bottom,
                                ),
                                modifier =
                                    if (workspace.id == restoredRow?.workspaceId)
                                        Modifier.focusRequester(rowFocus)
                                    else Modifier,
                            ) { focused ->
                                activatedRow =
                                    if (focused)
                                        EntryRowFocus(workspace.id, state.entryPageGeneration)
                                    else null
                                chooseWorkspace(workspace.id)
                            }
                        }
                    }
                }
            }
            if (canRetry || canSignOut || noWorkspace) {
                Column(Modifier.fillMaxWidth(), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                    if (noWorkspace) {
                        SessionPrimaryAction(R.string.auth_workspace_setup, openWorkspaceSetup)
                    } else if (canRetry) {
                        SessionPrimaryAction(
                            if (accessRemoved) R.string.auth_check_access else R.string.retry,
                            retry,
                            enabled = !state.checkingWorkspace,
                        )
                    }
                    FlowRow(
                        Modifier.fillMaxWidth(),
                        horizontalArrangement =
                            Arrangement.spacedBy(8.dp, Alignment.CenterHorizontally),
                        verticalArrangement = Arrangement.spacedBy(8.dp),
                    ) {
                        if (canRetry && noWorkspace) {
                            SessionTextAction(
                                R.string.auth_check_workspace,
                                retry,
                                enabled = !state.checkingWorkspace,
                            )
                        }
                        if (canSignOut) {
                            SessionTextAction(
                                if (accessRemoved) R.string.auth_sign_in_again
                                else R.string.auth_sign_out,
                                onClick = {
                                    restoreSignOutFocus = signOutFocused
                                    confirmSignOut = true
                                },
                                modifier =
                                    Modifier.focusRequester(signOutFocus).onFocusChanged {
                                        signOutFocused = it.isFocused
                                    },
                            )
                        }
                    }
                    val feedback =
                        when (state.entryFailure) {
                            SessionEntryFailure.Check -> R.string.auth_check_failed
                            SessionEntryFailure.Selection -> R.string.auth_selection_failed
                            SessionEntryFailure.Browser -> R.string.auth_browser_unavailable
                            SessionEntryFailure.SignOut -> R.string.auth_sign_out_failed
                            null ->
                                R.string.auth_checking_workspace.takeIf { state.checkingWorkspace }
                        }
                    if (feedback != null) {
                        Text(
                            stringResource(feedback),
                            Modifier.fillMaxWidth().semantics {
                                liveRegion = LiveRegionMode.Polite
                            },
                            style = MaterialTheme.typography.bodyMedium,
                            color =
                                if (state.entryFailure == SessionEntryFailure.SignOut)
                                    MaterialTheme.colorScheme.error
                                else MaterialTheme.colorScheme.onSurfaceVariant,
                            textAlign = TextAlign.Center,
                        )
                    }
                }
            }
        }
    }
    if (confirmSignOut && canSignOut) {
        SignOutConfirmation({ confirmSignOut = false }, signOut)
    }
}

@Composable
internal fun SignOutConfirmation(dismiss: () -> Unit, signOut: () -> Unit) {
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

@Composable
private fun SessionWorkspaceRow(
    workspace: WorkspaceMembership,
    shape: Shape,
    modifier: Modifier,
    onClick: (focused: Boolean) -> Unit,
) {
    var focused by remember { mutableStateOf(false) }
    Row(
        modifier
            .fillMaxWidth()
            .onFocusChanged { focused = it.isFocused }
            .updateFocusOutline(shape, MaterialTheme.colorScheme.onSurface)
            .clickable(role = Role.Button) { onClick(focused) }
            .heightIn(min = 64.dp)
            .padding(horizontal = 16.dp, vertical = 8.dp),
        horizontalArrangement = Arrangement.spacedBy(12.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        WorkspaceLogo(workspace.id, workspace.name, workspace.uploadedImageUrl, 36.dp)
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
            if (waiting) Spacer(Modifier.size(20.dp))
            Text(
                stringResource(title),
                Modifier.weight(1f, fill = false).semantics {
                    heading()
                    liveRegion = LiveRegionMode.Polite
                },
                style = entryTitleStyle(compact),
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
    var animate by remember { mutableStateOf<Boolean?>(null) }
    LaunchedEffect(Unit) {
        delay(250)
        val motion = coroutineContext[MotionDurationScale]
        // Android starts its scale observer on first access, before snapshotFlow can read it.
        animate = motion?.scaleFactor != 0f
        snapshotFlow { motion?.scaleFactor != 0f }.collect { animate = it }
    }
    Box(Modifier.size(20.dp).clearAndSetSemantics {}) {
        val color = MaterialTheme.colorScheme.onSurfaceVariant
        when (animate) {
            true ->
                CircularProgressIndicator(
                    modifier = Modifier.fillMaxSize(),
                    color = color,
                    strokeWidth = 2.dp,
                )
            false ->
                CircularProgressIndicator(
                    progress = { 0.25f },
                    modifier = Modifier.fillMaxSize(),
                    color = color,
                    trackColor = Color.Transparent,
                    strokeWidth = 2.dp,
                )
            null -> Unit
        }
    }
}

@Composable
private fun SessionPrimaryAction(
    @StringRes label: Int,
    onClick: () -> Unit,
    enabled: Boolean = true,
) {
    val colors = MaterialTheme.colorScheme
    val defaults = ButtonDefaults.buttonColors()
    WithButtonFocusOutline(if (enabled) colors.onPrimary else colors.onSurface) {
        Button(
            onClick = { if (enabled) onClick() },
            modifier =
                Modifier.fillMaxWidth().heightIn(min = 48.dp).sessionActionAvailability(enabled),
            colors =
                if (enabled) defaults
                else
                    defaults.copy(
                        containerColor = defaults.disabledContainerColor,
                        contentColor = defaults.disabledContentColor,
                    ),
        ) {
            Text(stringResource(label), textAlign = TextAlign.Center)
        }
    }
}

@Composable
private fun SessionTextAction(
    @StringRes label: Int,
    onClick: () -> Unit,
    modifier: Modifier = Modifier,
    enabled: Boolean = true,
) {
    val colors = MaterialTheme.colorScheme
    val shape = ButtonDefaults.textShape
    val defaults = ButtonDefaults.textButtonColors()
    TextButton(
        onClick = { if (enabled) onClick() },
        modifier =
            modifier
                .heightIn(min = 48.dp)
                .updateFocusOutline(shape, colors.onSurface)
                .sessionActionAvailability(enabled),
        shape = shape,
        colors =
            defaults.copy(
                contentColor = if (enabled) colors.onSurface else defaults.disabledContentColor,
            ),
    ) {
        Text(stringResource(label), textAlign = TextAlign.Center)
    }
}

// Keep the focused control in keyboard traversal while the check owns its activation.
private fun Modifier.sessionActionAvailability(enabled: Boolean): Modifier =
    if (enabled) this else semantics { disabled() }
