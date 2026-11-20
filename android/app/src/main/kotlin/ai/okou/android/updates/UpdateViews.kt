package ai.okou.android.updates

import ai.okou.android.LocalActivityStatusColor
import ai.okou.android.R
import ai.okou.android.SettingsIcon
import ai.okou.android.SettingsRow
import ai.okou.android.api.generated.AndroidUpdatesRelease
import ai.okou.android.state.rememberUpdateDetailsOpen
import ai.okou.android.state.rememberUpdateWorkspaceState
import android.text.format.Formatter
import androidx.annotation.DrawableRes
import androidx.annotation.StringRes
import androidx.compose.foundation.background
import androidx.compose.foundation.interaction.MutableInteractionSource
import androidx.compose.foundation.interaction.collectIsPressedAsState
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.BoxWithConstraints
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.safeDrawingPadding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.ModalBottomSheet
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.rememberModalBottomSheetState
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.SideEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.draw.drawWithContent
import androidx.compose.ui.focus.FocusRequester
import androidx.compose.ui.focus.focusRequester
import androidx.compose.ui.focus.onFocusChanged
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.Shape
import androidx.compose.ui.graphics.drawOutline
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.graphics.drawscope.inset
import androidx.compose.ui.input.InputMode
import androidx.compose.ui.platform.LocalConfiguration
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.platform.LocalInputModeManager
import androidx.compose.ui.platform.LocalWindowInfo
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.LiveRegionMode
import androidx.compose.ui.semantics.ProgressBarRangeInfo
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.semantics.liveRegion
import androidx.compose.ui.semantics.progressBarRangeInfo
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.rememberTextMeasurer
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.Constraints
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.compose.ui.window.Dialog
import androidx.compose.ui.window.DialogProperties
import java.text.NumberFormat

internal data class UpdateToolbarAction(
    val label: String,
    val activate: (() -> Unit)?,
    @DrawableRes val icon: Int = R.drawable.ic_download,
    val accessibilityLabel: String? = null,
    val installsPackage: Boolean = false,
)

private fun UpdateTransfer.Downloading.fraction(): Float? =
    downloadedBytes?.let { (it.toDouble() / release.size).coerceIn(0.0, 1.0).toFloat() }

@Composable
private fun updatePercent(fraction: Float): String {
    val locale = LocalConfiguration.current.locales[0]
    val format = remember(locale) { NumberFormat.getPercentInstance(locale) }
    return format.format((fraction * 100).toInt() / 100.0)
}

@Composable
private fun downloadLabel(fraction: Float?): String =
    if (fraction == null) stringResource(R.string.updates_preparing)
    else stringResource(R.string.updates_downloading, updatePercent(fraction))

private val UpdateUiState.interrupted
    get() = transfer is UpdateTransfer.Failed || transfer is UpdateTransfer.Interrupted

private val UpdateUiState.installFailed
    get() = problem == UpdateProblem.Install

@Composable
internal fun updateToolbarAction(
    state: UpdateUiState,
    download: (AndroidUpdatesRelease) -> Unit,
    install: (AndroidUpdatesRelease) -> Unit,
    @StringRes installProgress: Int?,
    openDetails: () -> Unit,
): UpdateToolbarAction? {
    if (!state.announce) return null
    val transfer = state.transfer
    return when {
        transfer is UpdateTransfer.Downloading -> {
            val fraction = transfer.fraction()
            UpdateToolbarAction(
                if (fraction == null) stringResource(R.string.updates_preparing)
                else updatePercent(fraction),
                openDetails,
                accessibilityLabel = downloadLabel(fraction),
            )
        }
        transfer is UpdateTransfer.Ready && state.canInstall ->
            UpdateToolbarAction(
                stringResource(
                    installProgress
                        ?: if (state.installFailed) R.string.retry
                        else R.string.updates_install_toolbar
                ),
                if (installProgress == null) ({ install(transfer.release) }) else null,
                R.drawable.ic_refresh,
                installsPackage = true,
            )
        state.canDownload -> {
            val release = checkNotNull(state.candidate)
            val label = if (state.interrupted) R.string.retry else R.string.updates_toolbar
            UpdateToolbarAction(
                stringResource(label),
                if (state.offline) openDetails else ({ download(release) }),
            )
        }
        else -> UpdateToolbarAction(stringResource(R.string.updates_toolbar), openDetails)
    }
}

@Composable
internal fun UpdateToolbarButton(action: UpdateToolbarAction, stacked: Boolean) {
    val style =
        MaterialTheme.typography.bodyMedium.copy(
            fontSize = 14.sp,
            lineHeight = 20.sp,
            letterSpacing = 0.sp,
            fontWeight = FontWeight(550),
            fontFeatureSettings = "tnum",
        )
    val width = 104.dp
    val iconSize = 18.dp
    val gap = if (stacked) 2.dp else 8.dp
    val horizontalPadding = 6.dp
    val verticalPadding = 4.dp
    val textWidth = width - horizontalPadding * 2 - if (stacked) 0.dp else iconSize + gap
    val labels =
        listOf(
            stringResource(R.string.updates_toolbar),
            stringResource(R.string.updates_install_toolbar),
            stringResource(R.string.retry),
            stringResource(R.string.updates_preparing),
            stringResource(R.string.updates_installing),
            updatePercent(1f),
        )
    val measurer = rememberTextMeasurer()
    val labelHeight =
        with(LocalDensity.current) {
            val constraints = Constraints(maxWidth = textWidth.roundToPx())
            labels
                .maxOf { measurer.measure(it, style, constraints = constraints).size.height }
                .toDp()
        }
    val contentHeight = if (stacked) labelHeight + iconSize + gap else maxOf(iconSize, labelHeight)
    val shape = RoundedCornerShape(12.dp)
    val colors = MaterialTheme.colorScheme
    val interactions = remember { MutableInteractionSource() }
    val pressed by interactions.collectIsPressedAsState()
    val focus = rememberInstallControlFocus(inProgress = action.activate == null)
    val icon: @Composable () -> Unit = {
        Icon(painterResource(action.icon), contentDescription = null, Modifier.size(iconSize))
    }
    val label: @Composable () -> Unit = {
        Text(
            action.label,
            modifier = if (stacked) Modifier.width(textWidth) else Modifier,
            style = style,
            textAlign = if (stacked) TextAlign.Center else TextAlign.Start,
        )
    }
    // Reserve a single slot for all localized states, including wrapped labels.
    TextButton(
        onClick = {
            if (action.installsPackage) focus.rememberTrigger()
            action.activate?.invoke()
        },
        enabled = action.activate != null,
        modifier =
            Modifier.width(width)
                .heightIn(min = maxOf(updateActionMinHeight, contentHeight + verticalPadding * 2))
                .then(focus.modifier)
                .updateFocusOutline(shape, colors.inverseOnSurface)
                .semantics { action.accessibilityLabel?.let { contentDescription = it } },
        shape = shape,
        contentPadding = PaddingValues(horizontalPadding, verticalPadding),
        interactionSource = interactions,
        colors =
            ButtonDefaults.textButtonColors(
                containerColor = if (pressed) colors.onSurfaceVariant else colors.inverseSurface,
                contentColor = colors.inverseOnSurface,
                disabledContainerColor = colors.surfaceVariant,
                disabledContentColor = colors.onSurfaceVariant,
            ),
    ) {
        if (stacked) {
            Column(
                horizontalAlignment = Alignment.CenterHorizontally,
                verticalArrangement = Arrangement.spacedBy(gap),
            ) {
                icon()
                label()
            }
        } else {
            Row(
                verticalAlignment = Alignment.CenterVertically,
                horizontalArrangement = Arrangement.spacedBy(gap),
            ) {
                icon()
                label()
            }
        }
    }
}

@Composable
internal fun UpdateHost(
    state: UpdateUiState,
    check: () -> Unit,
    download: (AndroidUpdatesRelease) -> Unit,
    defer: (AndroidUpdatesRelease) -> Unit,
    install: (AndroidUpdatesRelease) -> Unit,
    @StringRes installProgress: Int?,
    automaticInstall: AndroidUpdatesRelease?,
    windowFocused: Boolean,
    startAutomaticInstall: (AndroidUpdatesRelease, fromDetails: Boolean) -> Unit,
    showAnnouncement: Boolean,
    content: @Composable (openUpdates: () -> Unit) -> Unit,
) {
    var details by rememberUpdateDetailsOpen()
    val savedUi = rememberUpdateWorkspaceState()
    var returningToDetails by remember { mutableStateOf(false) }
    if (details && installProgress != null) SideEffect { returningToDetails = true }
    val showDetails = details && !state.required && installProgress == null
    LaunchedEffect(automaticInstall, showDetails, windowFocused) {
        if (automaticInstall != null && !showDetails && windowFocused)
            startAutomaticInstall(automaticInstall, false)
    }
    if (state.required) {
        LaunchedEffect(Unit) {
            details = false
            returningToDetails = false
            savedUi.removeState("update-details")
        }
        RequiredUpdateScreen(state, check, download, install, installProgress)
    } else {
        Column(
            Modifier.fillMaxSize()
                .background(MaterialTheme.colorScheme.background)
                .safeDrawingPadding()
        ) {
            if (showAnnouncement && state.announce) {
                val release = checkNotNull(state.displayedRelease)
                Surface(color = MaterialTheme.colorScheme.surfaceVariant) {
                    Column(Modifier.fillMaxWidth().padding(horizontal = 16.dp)) {
                        Text(stringResource(R.string.updates_available, release.version))
                        FlowRow(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.End) {
                            ActionText(stringResource(R.string.updates_view), { details = true })
                            if (
                                state.transfer !is UpdateTransfer.Downloading &&
                                    state.transfer !is UpdateTransfer.Ready
                            )
                                ActionText(
                                    stringResource(R.string.updates_later),
                                    { defer(release) },
                                )
                        }
                    }
                }
            }
            Box(Modifier.weight(1f)) {
                // Retain navigation metadata while the required screen owns the task.
                savedUi.SaveableStateProvider("workspace") { content { details = true } }
            }
        }
    }
    if (showDetails) {
        savedUi.SaveableStateProvider("update-details") {
            UpdateSheet(
                state,
                check,
                download,
                install,
                automaticInstall,
                startAutomaticInstall = { startAutomaticInstall(it, true) },
                restoreInstallFocus = returningToDetails,
                onInstallFocusRestored = { returningToDetails = false },
                close = {
                    details = false
                    returningToDetails = false
                    savedUi.removeState("update-details")
                },
            )
        }
    }
}

@Composable
internal fun AppUpdateSettings(
    state: UpdateUiState,
    @StringRes installProgress: Int?,
    open: () -> Unit,
) {
    val transfer = state.transfer
    val newVersion = state.canDownload && !state.interrupted
    val summary =
        when {
            state.preparing -> stringResource(R.string.updates_preparing)
            transfer is UpdateTransfer.Downloading -> downloadLabel(transfer.fraction())
            state.canInstall ->
                stringResource(
                    installProgress
                        ?: if (state.installFailed) R.string.updates_install_failed
                        else R.string.updates_ready
                )
            state.interrupted && state.available -> stringResource(R.string.updates_interrupted)
            newVersion -> stringResource(R.string.updates_new_version)
            state.offline && !state.available ->
                stringResource(R.string.updates_waiting_for_connection)
            state.check == UpdateCheck.Checking ->
                stringResource(R.string.updates_check_in_progress)
            state.available ->
                stringResource(
                    R.string.updates_available,
                    checkNotNull(state.displayedRelease).version,
                )
            state.check == UpdateCheck.Failed -> stringResource(R.string.updates_check_failed)
            state.check == UpdateCheck.Checked -> stringResource(R.string.updates_current)
            else -> state.installedVersion
        }
    SettingsRow(
        stringResource(R.string.updates_title),
        leading = {
            SettingsIcon(if (state.canInstall) R.drawable.ic_refresh else R.drawable.ic_download)
        },
        modifier =
            Modifier.updateFocusOutline(
                RoundedCornerShape(12.dp),
                LocalActivityStatusColor.current,
            ),
        value = summary,
        onClick = open,
        valueLeading =
            if (newVersion) {
                {
                    Box(
                        Modifier.size(8.dp)
                            .background(LocalActivityStatusColor.current, CircleShape)
                    )
                }
            } else null,
    )
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun UpdateSheet(
    state: UpdateUiState,
    check: () -> Unit,
    download: (AndroidUpdatesRelease) -> Unit,
    install: (AndroidUpdatesRelease) -> Unit,
    automaticInstall: AndroidUpdatesRelease?,
    startAutomaticInstall: (AndroidUpdatesRelease) -> Unit,
    restoreInstallFocus: Boolean,
    onInstallFocusRestored: () -> Unit,
    close: () -> Unit,
) {
    val window = LocalConfiguration.current
    val windowHeight =
        with(LocalDensity.current) { LocalWindowInfo.current.containerSize.height.toDp() }
    val panel: @Composable () -> Unit = {
        val focused = LocalWindowInfo.current.isWindowFocused
        val installFocus = remember { FocusRequester() }
        val inputMode = LocalInputModeManager.current
        LaunchedEffect(restoreInstallFocus, focused) {
            if (restoreInstallFocus && focused) {
                if (inputMode.inputMode == InputMode.Keyboard) installFocus.requestFocus()
                onInstallFocusRestored()
            }
        }
        LaunchedEffect(automaticInstall, focused) {
            if (automaticInstall != null && focused) startAutomaticInstall(automaticInstall)
        }
        val transfer = state.transfer
        val release = state.displayedRelease?.takeIf { state.available }
        BoxWithConstraints(
            Modifier.fillMaxWidth()
                .heightIn(max = windowHeight * 0.8f)
                .padding(start = 24.dp, end = 24.dp, bottom = 24.dp)
        ) {
            val actions = measureUpdateSheetActions(maxWidth)
            val headingStyle = MaterialTheme.typography.headlineSmall
            val titleLineHeight = with(LocalDensity.current) { headingStyle.lineHeight.toDp() }
            val scroll = rememberScrollState()
            val contentSpacing = 20.dp
            val scrollWholePanel = maxHeight < actions.height + contentSpacing + titleLineHeight
            Column(
                if (scrollWholePanel) Modifier.fillMaxWidth().verticalScroll(scroll)
                else Modifier.fillMaxWidth(),
                verticalArrangement = Arrangement.spacedBy(contentSpacing),
            ) {
                Column(
                    if (scrollWholePanel) Modifier
                    else Modifier.weight(1f, fill = false).verticalScroll(scroll)
                ) {
                    Column(verticalArrangement = Arrangement.spacedBy(12.dp)) {
                        Text(
                            if (release == null) stringResource(R.string.updates_title)
                            else stringResource(R.string.updates_target, release.version),
                            style = headingStyle.copy(fontWeight = FontWeight.SemiBold),
                            modifier = Modifier.semantics { heading() },
                        )
                        UpdateMetadata(state.installedVersion, release)
                        if (release != null) {
                            if (release.notes.isNotBlank()) UpdateCopy(release.notes)
                        } else if (state.check == UpdateCheck.Checked && !state.offline) {
                            UpdateCopy(stringResource(R.string.updates_current))
                        }
                    }
                    UpdateProblemText(state, Modifier.padding(top = 12.dp))
                }
                Row(
                    Modifier.fillMaxWidth(),
                    horizontalArrangement = Arrangement.spacedBy(updateSheetActionGap),
                    verticalAlignment = Alignment.CenterVertically,
                ) {
                    val dismissLabel =
                        if (
                            transfer is UpdateTransfer.Downloading ||
                                state.interrupted ||
                                release == null
                        )
                            R.string.updates_close
                        else R.string.updates_later
                    ActionText(
                        stringResource(dismissLabel),
                        close,
                        Modifier.width(actions.dismissWidth).heightIn(min = actions.height),
                    )
                    UpdateAction(
                        state,
                        check,
                        download,
                        install,
                        installProgress = null,
                        Modifier.weight(1f)
                            .heightIn(min = actions.height)
                            .focusRequester(installFocus),
                    )
                }
            }
        }
    }
    val shape = RoundedCornerShape(24.dp)
    if (window.screenWidthDp >= 600 && window.screenHeightDp >= 480) {
        Dialog(
            onDismissRequest = close,
            properties = DialogProperties(usePlatformDefaultWidth = false),
        ) {
            Surface(
                Modifier.padding(horizontal = 24.dp).widthIn(max = 460.dp),
                shape = shape,
                color = MaterialTheme.colorScheme.surface,
            ) {
                Box(Modifier.padding(top = 24.dp)) { panel() }
            }
        }
    } else {
        ModalBottomSheet(
            onDismissRequest = close,
            sheetState = rememberModalBottomSheetState(skipPartiallyExpanded = true),
            sheetMaxWidth = 460.dp,
            shape = RoundedCornerShape(topStart = 24.dp, topEnd = 24.dp),
            containerColor = MaterialTheme.colorScheme.surface,
        ) {
            panel()
        }
    }
}

@Composable
private fun RequiredUpdateScreen(
    state: UpdateUiState,
    check: () -> Unit,
    download: (AndroidUpdatesRelease) -> Unit,
    install: (AndroidUpdatesRelease) -> Unit,
    @StringRes installProgress: Int?,
) {
    val top =
        with(LocalDensity.current) {
            (LocalWindowInfo.current.containerSize.height.toDp() * 0.08f).coerceIn(24.dp, 72.dp)
        }
    Surface(Modifier.fillMaxSize(), color = MaterialTheme.colorScheme.background) {
        BoxWithConstraints(
            Modifier.fillMaxSize().safeDrawingPadding(),
            contentAlignment = Alignment.TopCenter,
        ) {
            Column(
                Modifier.widthIn(max = 560.dp)
                    .fillMaxWidth()
                    .verticalScroll(rememberScrollState())
                    .heightIn(min = maxHeight)
                    .padding(start = 24.dp, end = 24.dp, bottom = 24.dp)
            ) {
                Column(Modifier.padding(top = top)) {
                    Icon(
                        painterResource(R.drawable.okou_wordmark),
                        contentDescription = null,
                        modifier = Modifier.size(80.dp, 24.dp),
                        tint = MaterialTheme.colorScheme.onBackground,
                    )
                    Spacer(Modifier.height(24.dp))
                    Text(
                        stringResource(R.string.updates_required),
                        style =
                            MaterialTheme.typography.headlineSmall.copy(
                                fontSize = 28.sp,
                                lineHeight = 36.sp,
                                fontWeight = FontWeight(650),
                            ),
                        modifier = Modifier.semantics { heading() },
                    )
                    Spacer(Modifier.height(12.dp))
                    Text(
                        stringResource(R.string.updates_required_description),
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                        style = MaterialTheme.typography.bodyLarge,
                    )
                    Spacer(Modifier.height(16.dp))
                    UpdateMetadata(
                        state.installedVersion,
                        state.displayedRelease,
                        includeTarget = true,
                    )
                }
                // Keep the action near the bottom when it fits and reachable by scrolling
                // otherwise.
                Spacer(Modifier.weight(1f))
                Spacer(Modifier.height(24.dp))
                Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                    UpdateProblemText(state)
                    UpdateAction(
                        state,
                        check,
                        download,
                        install,
                        installProgress,
                        Modifier.fillMaxWidth(),
                    )
                }
            }
        }
    }
}

@Composable
private fun UpdateMetadata(
    installedVersion: String,
    release: AndroidUpdatesRelease?,
    includeTarget: Boolean = false,
) {
    FlowRow(
        horizontalArrangement = Arrangement.spacedBy(16.dp),
        verticalArrangement = Arrangement.spacedBy(4.dp),
    ) {
        UpdateCopy(stringResource(R.string.updates_installed, installedVersion), muted = true)
        if (release != null) {
            if (includeTarget)
                UpdateCopy(stringResource(R.string.updates_version, release.version), muted = true)
            UpdateCopy(
                stringResource(
                    R.string.updates_package_size,
                    Formatter.formatShortFileSize(LocalContext.current, release.size),
                ),
                muted = true,
            )
        }
    }
}

@Composable
private fun UpdateProblemText(state: UpdateUiState, modifier: Modifier = Modifier) {
    val offline =
        state.offline && !state.canInstall && state.transfer !is UpdateTransfer.Downloading
    val availability =
        state.displayedRelease
            ?.takeIf { (state.available || state.required) && !state.isEligible(it) }
            ?.let {
                if (it.minimumSdk > state.sdk) R.string.updates_android_unsupported
                else R.string.updates_unavailable
            }
    val latestProblem =
        when (state.problem) {
            UpdateProblem.Check -> R.string.updates_error_check
            UpdateProblem.Download -> R.string.updates_error_download
            UpdateProblem.Integrity -> R.string.updates_error_integrity
            UpdateProblem.Identity -> R.string.updates_error_identity
            UpdateProblem.Storage -> R.string.updates_error_storage
            UpdateProblem.Interrupted -> R.string.updates_error_interrupted
            UpdateProblem.Install -> R.string.updates_error_install
            null -> null
        }
    val message =
        when {
            offline && state.canDownload -> R.string.updates_connect_to_download
            offline -> R.string.updates_connect_to_check
            latestProblem != null -> latestProblem
            state.check == UpdateCheck.Failed &&
                !state.canDownload &&
                !state.canInstall &&
                state.transfer !is UpdateTransfer.Downloading -> R.string.updates_error_check
            else -> availability ?: return
        }
    Text(
        stringResource(message),
        color =
            if (offline) MaterialTheme.colorScheme.onSurfaceVariant
            else MaterialTheme.colorScheme.error,
        style = MaterialTheme.typography.bodyMedium,
        modifier = modifier.semantics { liveRegion = LiveRegionMode.Polite },
    )
}

@Composable
private fun UpdateCopy(label: String, muted: Boolean = false) {
    Text(
        label,
        color =
            if (muted) MaterialTheme.colorScheme.onSurfaceVariant
            else MaterialTheme.colorScheme.onSurface,
        style = MaterialTheme.typography.bodyMedium.copy(fontFeatureSettings = "tnum"),
    )
}

@Composable
private fun UpdateAction(
    state: UpdateUiState,
    check: () -> Unit,
    download: (AndroidUpdatesRelease) -> Unit,
    install: (AndroidUpdatesRelease) -> Unit,
    @StringRes installProgress: Int?,
    modifier: Modifier,
) {
    val transfer = state.transfer
    val colors = MaterialTheme.colorScheme
    val shape = RoundedCornerShape(12.dp)
    val focus = rememberInstallControlFocus(inProgress = installProgress != null)
    val checking =
        state.check == UpdateCheck.Checking &&
            !state.offline &&
            !state.canInstall &&
            !state.canDownload
    val progress =
        when {
            transfer is UpdateTransfer.Downloading -> downloadLabel(transfer.fraction())
            state.preparing -> stringResource(R.string.updates_preparing)
            state.canInstall && installProgress != null -> stringResource(installProgress)
            checking -> stringResource(R.string.updates_check_in_progress)
            else -> null
        }
    if (progress != null) {
        val fraction = (transfer as? UpdateTransfer.Downloading)?.fraction()
        Box(
            modifier
                .heightIn(min = updateActionMinHeight)
                .clip(shape)
                .background(colors.surfaceVariant)
                .semantics {
                    progressBarRangeInfo =
                        if (fraction == null) ProgressBarRangeInfo.Indeterminate
                        else ProgressBarRangeInfo(fraction, 0f..1f)
                },
            contentAlignment = Alignment.Center,
        ) {
            Text(
                progress,
                modifier = Modifier.padding(updateActionPadding),
                color = colors.onBackground,
                style = updateProgressStyle(),
                textAlign = TextAlign.Center,
            )
            if (fraction != null) {
                Box(Modifier.align(Alignment.BottomStart).matchParentSize()) {
                    Box(
                        Modifier.align(Alignment.BottomStart)
                            .fillMaxWidth(fraction)
                            .height(2.dp)
                            .background(LocalActivityStatusColor.current)
                    )
                }
            }
        }
        return
    }
    val (label, action) =
        when {
            transfer is UpdateTransfer.Ready && state.canInstall ->
                (if (state.installFailed) R.string.updates_retry_install
                else R.string.updates_ready) to { install(transfer.release) }
            state.canDownload ->
                (if (state.interrupted) R.string.retry else R.string.updates_toolbar) to
                    ({
                        download(checkNotNull(state.candidate))
                    })
            state.check == UpdateCheck.Failed -> R.string.retry to check
            else -> R.string.updates_check to check
        }
    Button(
        onClick = {
            if (state.canInstall) focus.rememberTrigger()
            action()
        },
        enabled = !state.offline || state.canInstall,
        modifier =
            modifier
                .heightIn(min = updateActionMinHeight)
                .then(focus.modifier)
                .updateFocusOutline(shape, colors.inverseOnSurface),
        shape = shape,
        contentPadding = updateActionPadding,
        colors =
            ButtonDefaults.buttonColors(
                containerColor = colors.inverseSurface,
                contentColor = colors.inverseOnSurface,
                disabledContainerColor = colors.surfaceVariant,
                disabledContentColor = colors.onSurfaceVariant,
            ),
    ) {
        Text(stringResource(label), style = updateActionLabelStyle(), textAlign = TextAlign.Center)
    }
}

private class InstallControlFocus {
    private val requester = FocusRequester()
    private var focused = false
    private var restore = false

    val modifier = Modifier.focusRequester(requester).onFocusChanged { focused = it.isFocused }

    fun rememberTrigger() {
        restore = focused
    }

    fun restoreTrigger() {
        if (restore) requester.requestFocus()
        restore = false
    }
}

@Composable
private fun rememberInstallControlFocus(inProgress: Boolean): InstallControlFocus {
    val focus = remember { InstallControlFocus() }
    val windowFocused = LocalWindowInfo.current.isWindowFocused
    LaunchedEffect(inProgress, windowFocused) {
        if (!inProgress && windowFocused) focus.restoreTrigger()
    }
    return focus
}

@Composable
private fun ActionText(label: String, action: () -> Unit, modifier: Modifier = Modifier) {
    TextButton(
        onClick = action,
        modifier =
            modifier
                .heightIn(min = updateActionMinHeight)
                .updateFocusOutline(ButtonDefaults.shape, LocalActivityStatusColor.current),
        contentPadding = updateActionPadding,
        colors = ButtonDefaults.textButtonColors(contentColor = MaterialTheme.colorScheme.onSurface),
    ) {
        Text(label, style = updateActionLabelStyle(), textAlign = TextAlign.Center)
    }
}

private val updateActionMinHeight = 48.dp
private val updateActionHorizontalPadding = 12.dp
private val updateActionVerticalPadding = 8.dp
private val updateSheetActionGap = 8.dp
private val updateActionPadding =
    PaddingValues(updateActionHorizontalPadding, updateActionVerticalPadding)

@Composable
private fun updateActionLabelStyle() =
    MaterialTheme.typography.labelLarge.copy(fontWeight = FontWeight(550))

@Composable
private fun updateProgressStyle() =
    MaterialTheme.typography.bodyMedium.copy(fontFeatureSettings = "tnum")

private data class UpdateSheetActionSize(val dismissWidth: Dp, val height: Dp)

// Reserve room for both buttons and progress so localized wrapping cannot move the footer.
@Composable
private fun measureUpdateSheetActions(width: Dp): UpdateSheetActionSize {
    val measurer = rememberTextMeasurer()
    val dismissLabels =
        listOf(stringResource(R.string.updates_later), stringResource(R.string.updates_close))
    val mainLabels =
        listOf(
            stringResource(R.string.updates_toolbar),
            stringResource(R.string.updates_ready),
            stringResource(R.string.updates_retry_install),
        )
    val progressLabels = listOf(downloadLabel(null), downloadLabel(1f))
    val labelStyle = updateActionLabelStyle()
    val progressStyle = updateProgressStyle()
    return with(LocalDensity.current) {
        val dismissWidth =
            (dismissLabels.maxOf {
                    measurer.measure(it, labelStyle, softWrap = false).size.width.toDp()
                } + updateActionHorizontalPadding * 2)
                .coerceAtLeast(72.dp)
                .coerceAtMost((width - updateSheetActionGap - 48.dp).coerceAtLeast(0.dp))
        val mainWidth = width - dismissWidth - updateSheetActionGap
        fun textHeight(label: String, style: TextStyle, slotWidth: Dp): Dp {
            val available =
                (slotWidth - updateActionHorizontalPadding * 2).roundToPx().coerceAtLeast(0)
            return measurer
                .measure(label, style, constraints = Constraints(maxWidth = available))
                .size
                .height
                .toDp()
        }
        val textHeight =
            maxOf(
                dismissLabels.maxOf { textHeight(it, labelStyle, dismissWidth) },
                mainLabels.maxOf { textHeight(it, labelStyle, mainWidth) },
                progressLabels.maxOf { textHeight(it, progressStyle, mainWidth) },
            )
        UpdateSheetActionSize(
            dismissWidth,
            (textHeight + updateActionVerticalPadding * 2).coerceAtLeast(updateActionMinHeight),
        )
    }
}

@Composable
internal fun Modifier.updateFocusOutline(shape: Shape, color: Color): Modifier {
    val focused = remember { mutableStateOf(false) }
    return onFocusChanged { focused.value = it.isFocused }
        .drawWithContent {
            drawContent()
            if (focused.value) {
                val width = 2.dp.toPx()
                inset(width) {
                    drawOutline(
                        shape.createOutline(size, layoutDirection, this),
                        color,
                        style = Stroke(width),
                    )
                }
            }
        }
}
