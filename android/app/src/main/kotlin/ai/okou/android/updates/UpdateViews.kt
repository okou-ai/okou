package ai.okou.android.updates

import ai.okou.android.EntryBrand
import ai.okou.android.EntryCompactHeight
import ai.okou.android.EntryContentGutter
import ai.okou.android.EntryContentWidth
import ai.okou.android.R
import ai.okou.android.SettingsIcon
import ai.okou.android.SettingsModal
import ai.okou.android.SettingsRow
import ai.okou.android.api.generated.AndroidUpdatesRelease
import ai.okou.android.currentWindowSizeDp
import ai.okou.android.entrySpacing
import ai.okou.android.entryTitleStyle
import ai.okou.android.entryTopPadding
import ai.okou.android.keyboardReadingScroll
import ai.okou.android.measureEntryBrandHeight
import ai.okou.android.state.rememberUpdateWorkspaceState
import android.text.format.Formatter
import androidx.annotation.DrawableRes
import androidx.annotation.StringRes
import androidx.compose.foundation.background
import androidx.compose.foundation.focusable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.BoxWithConstraints
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.safeDrawingPadding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.systemBars
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.FilledIconButton
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.MutableState
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
import androidx.compose.ui.semantics.clearAndSetSemantics
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.disabled
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.semantics.liveRegion
import androidx.compose.ui.semantics.onClick
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
import java.text.NumberFormat

internal data class UpdateToolbarAction(
    val label: String,
    val activate: (() -> Unit)?,
    val progress: String? = null,
    val installsPackage: Boolean = false,
    @DrawableRes val icon: Int = R.drawable.ic_update,
    val opensDetails: Boolean = false,
    val detailsOpen: Boolean = false,
)

private fun UpdateTransfer.Downloading.percent(): Int? = downloadedBytes?.let {
    (it.coerceIn(0L, release.size) * 100 / release.size).toInt()
}

@Composable
private fun updatePercent(percent: Int): String {
    val locale = LocalConfiguration.current.locales[0]
    val format = remember(locale) { NumberFormat.getPercentInstance(locale) }
    return format.format(percent / 100.0)
}

@Composable
private fun downloadLabel(percent: Int?): String =
    if (percent == null) stringResource(R.string.updates_preparing)
    else stringResource(R.string.updates_downloading, updatePercent(percent))

private val UpdateUiState.interrupted
    get() = transfer is UpdateTransfer.Failed || transfer is UpdateTransfer.Interrupted

private val UpdateUiState.requiresNewerAndroid
    get() = offeredRelease?.let { it.minimumSdk > sdk } == true

@Composable
internal fun updateToolbarAction(
    state: UpdateUiState,
    download: (AndroidUpdatesRelease) -> Unit,
    install: (AndroidUpdatesRelease) -> Unit,
    @StringRes installProgress: Int?,
    openDetails: () -> Unit,
): UpdateToolbarAction? {
    if (state.preparing || state.required || !state.available) return null
    val transfer = state.transfer
    return when {
        transfer is UpdateTransfer.Downloading -> {
            val percent = updatePercent(transfer.percent() ?: 0)
            UpdateToolbarAction(
                stringResource(R.string.updates_downloading, percent),
                openDetails,
                progress = percent,
                opensDetails = true,
            )
        }
        transfer is UpdateTransfer.Ready && state.canInstall ->
            UpdateToolbarAction(
                stringResource(installProgress ?: R.string.updates_ready),
                if (installProgress == null) ({ install(transfer.release) }) else null,
                installsPackage = true,
            )
        state.interrupted || transfer is UpdateTransfer.Waiting ->
            UpdateToolbarAction(
                stringResource(
                    if (transfer is UpdateTransfer.Interrupted) R.string.updates_error_interrupted
                    else R.string.updates_download_failed,
                ),
                openDetails,
                icon = R.drawable.ic_download,
                opensDetails = true,
            )
        state.canDownload -> {
            val release = checkNotNull(state.candidate)
            UpdateToolbarAction(
                stringResource(R.string.updates_download),
                { download(release) },
                icon = R.drawable.ic_download,
            )
        }
        else ->
            UpdateToolbarAction(
                stringResource(
                    if (state.requiresNewerAndroid) R.string.updates_android_unsupported
                    else R.string.updates_toolbar,
                ),
                openDetails,
                opensDetails = true,
            )
    }
}

@Composable
internal fun UpdateToolbarButton(action: UpdateToolbarAction, height: Dp) {
    val shape = RoundedCornerShape(12.dp)
    val colors = MaterialTheme.colorScheme
    val focus = rememberUpdateControlFocus(away = action.activate == null || action.detailsOpen)
    val detailsLabel = stringResource(R.string.updates_title)
    val inputMode = LocalInputModeManager.current
    val maxTextSize = with(LocalDensity.current) { 16.dp.toSp() }
    FilledIconButton(
        onClick = {
            if (
                action.installsPackage ||
                    (action.opensDetails && inputMode.inputMode == InputMode.Keyboard)
            )
                focus.rememberTrigger()
            action.activate?.invoke()
        },
        enabled = action.activate != null,
        modifier =
            Modifier.size(width = 48.dp, height = height)
                .then(focus.modifier)
                .updateFocusOutline(shape, colors.onBackground, keyboardOnly = true)
                .semantics {
                    contentDescription = action.label
                    if (action.opensDetails) onClick(label = detailsLabel, action = null)
                },
        shape = shape,
    ) {
        if (action.progress == null) {
            Icon(
                painterResource(action.icon),
                contentDescription = null,
                Modifier.size(24.dp),
            )
        } else {
            Text(
                action.progress,
                style =
                    MaterialTheme.typography.labelMedium.copy(
                        fontSize = minOf(12f, maxTextSize.value).sp,
                        fontWeight = FontWeight.Bold,
                        letterSpacing = 0.sp,
                        fontFeatureSettings = "tnum",
                    ),
                maxLines = 1,
            )
        }
    }
}

@Composable
internal fun UpdateHost(
    state: UpdateUiState,
    check: () -> Unit,
    download: (AndroidUpdatesRelease) -> Unit,
    install: (AndroidUpdatesRelease) -> Unit,
    @StringRes installProgress: Int?,
    detailsOpen: MutableState<Boolean>,
    content: @Composable (openUpdates: () -> Unit) -> Unit,
) {
    var details by detailsOpen
    val savedUi = rememberUpdateWorkspaceState()
    val showDetails = details && !state.required
    if (state.required) {
        LaunchedEffect(Unit) {
            details = false
            savedUi.removeState("update-details")
        }
        RequiredUpdateScreen(state, check, download, install, installProgress)
    } else {
        Box(
            Modifier.fillMaxSize()
                .background(MaterialTheme.colorScheme.background)
                .safeDrawingPadding(),
        ) {
            // Retain navigation metadata while the required screen owns the task.
            savedUi.SaveableStateProvider("workspace") {
                content { details = true }
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
                installProgress,
                close = {
                    details = false
                    savedUi.removeState("update-details")
                },
            )
        }
    }
}

@Composable
internal fun AppUpdateSettings(
    state: UpdateUiState,
    open: () -> Unit,
    detailsOpen: Boolean = false,
) {
    val status =
        when (state.check) {
            UpdateCheck.Checking -> R.string.updates_check_in_progress
            UpdateCheck.Waiting,
            UpdateCheck.Failed -> R.string.updates_status_check_failed
            UpdateCheck.Unknown -> R.string.updates_needed.takeIf { state.available }
            UpdateCheck.Checked ->
                if (state.available) R.string.updates_needed else R.string.updates_not_needed
        }
    val focus = remember { FocusRequester() }
    var focused by remember { mutableStateOf(false) }
    var restoreFocus by remember { mutableStateOf(false) }
    LaunchedEffect(detailsOpen) {
        if (!detailsOpen && restoreFocus) {
            restoreFocus = false
            focus.requestFocus()
        }
    }
    BoxWithConstraints {
        SettingsRow(
            stringResource(R.string.updates_title),
            leading = { SettingsIcon(R.drawable.ic_update) },
            modifier =
                Modifier.focusRequester(focus)
                    .onFocusChanged { focused = it.isFocused }
                    .updateFocusOutline(
                        RoundedCornerShape(12.dp),
                        MaterialTheme.colorScheme.onSurface,
                    ),
            value = status?.let { stringResource(it) },
            valueMaxLines = 1,
            reserveValueSpace = true,
            valueBelowTitle = maxWidth <= with(LocalDensity.current) { 16.sp.toDp() * 17 },
            onClick = {
                restoreFocus = focused
                open()
            },
            valueLeading =
                if (status == R.string.updates_needed) {
                    {
                        Box(
                            Modifier.size(8.dp)
                                .background(MaterialTheme.colorScheme.primary, CircleShape),
                        )
                    }
                } else null,
        )
    }
}

@Composable
private fun UpdateSheet(
    state: UpdateUiState,
    check: () -> Unit,
    download: (AndroidUpdatesRelease) -> Unit,
    install: (AndroidUpdatesRelease) -> Unit,
    @StringRes installProgress: Int?,
    close: () -> Unit,
) {
    val window = currentWindowSizeDp()
    val bars = WindowInsets.systemBars
    val windowHeight =
        with(LocalDensity.current) {
            window.height.dp - (bars.getTop(this) + bars.getBottom(this)).toDp()
        }
    val base = with(LocalDensity.current) { 16.sp.toDp() }
    val compact = windowHeight < base * 13
    val short = windowHeight < base * 9
    SettingsModal(close, showDragHandle = !compact) { centered ->
        val release = state.offeredRelease
        val inset = if (compact) 16.dp else 24.dp
        val verticalInset = if (short) 8.dp else if (compact) 12.dp else 24.dp
        BoxWithConstraints(
            Modifier.fillMaxWidth()
                .heightIn(max = if (compact) windowHeight else windowHeight * 0.8f)
                .padding(horizontal = inset)
                .padding(
                    top = if (compact || centered) verticalInset else 0.dp,
                    bottom = verticalInset,
                ),
        ) {
            val actions = measureUpdateActions(maxWidth, required = false)
            val title = stringResource(R.string.updates_title)
            val headingStyle =
                (if (compact)
                        MaterialTheme.typography.titleLarge.copy(
                            fontSize = 20.sp,
                            lineHeight = 28.sp,
                        )
                    else MaterialTheme.typography.headlineSmall)
                    .copy(fontWeight = FontWeight.SemiBold)
            val measurer = rememberTextMeasurer(cacheSize = 1)
            val titleHeight =
                with(LocalDensity.current) {
                    measurer
                        .measure(
                            title,
                            headingStyle,
                            constraints = Constraints(maxWidth = maxWidth.roundToPx()),
                        )
                        .size
                        .height
                        .toDp()
                }
            val bodyLineHeight =
                with(LocalDensity.current) { MaterialTheme.typography.bodyMedium.lineHeight.toDp() }
            val resultSpacing = 4.dp
            // Match the rounding of each text row and the gap.
            val resultMinHeight =
                with(LocalDensity.current) {
                    (bodyLineHeight.roundToPx() * 2 + resultSpacing.roundToPx()).toDp()
                }
            val scroll = rememberScrollState()
            val contentSpacing = if (short) 8.dp else if (compact) 12.dp else 16.dp
            val headingGap = if (short) 4.dp else 8.dp
            val scrollHeading =
                maxHeight <
                    actions.height + headingGap + contentSpacing + titleHeight + bodyLineHeight
            val heading: @Composable () -> Unit = {
                Text(
                    title,
                    style = headingStyle,
                    modifier = Modifier.semantics { heading() },
                )
                Spacer(Modifier.height(headingGap))
            }
            Column(Modifier.fillMaxWidth()) {
                if (!scrollHeading) heading()
                Column(
                    Modifier.fillMaxWidth().weight(1f, fill = false).keyboardReadingScroll(scroll),
                ) {
                    if (scrollHeading) heading()
                    UpdateCopy(
                        stringResource(R.string.updates_installed, state.installedVersion),
                        muted = true,
                    )
                    Spacer(Modifier.height(if (short) 4.dp else 8.dp))
                    Column(
                        Modifier.heightIn(min = resultMinHeight),
                        verticalArrangement = Arrangement.spacedBy(resultSpacing),
                    ) {
                        if (release != null) {
                            FlowRow(
                                horizontalArrangement =
                                    Arrangement.spacedBy(if (compact) 12.dp else 16.dp),
                                verticalArrangement = Arrangement.spacedBy(4.dp),
                            ) {
                                UpdateMetadata(release, compact = compact)
                            }
                        } else if (state.check == UpdateCheck.Checked) {
                            UpdateStatusText(R.string.updates_current)
                        }
                        val requiresNewerAndroid = state.requiresNewerAndroid
                        if (requiresNewerAndroid) {
                            UpdateStatusText(R.string.updates_android_unsupported)
                        }
                        state.updateProblemMessage(requiresNewerAndroid)?.let {
                            UpdateStatusText(it)
                        }
                    }
                }
                Spacer(Modifier.height(contentSpacing))
                Row(
                    Modifier.fillMaxWidth(),
                    horizontalArrangement = Arrangement.spacedBy(updateSheetActionGap),
                    verticalAlignment = Alignment.CenterVertically,
                ) {
                    ActionText(
                        stringResource(R.string.updates_close),
                        close,
                        Modifier.width(actions.dismissWidth).heightIn(min = actions.height),
                    )
                    UpdateAction(
                        state,
                        check,
                        download,
                        install,
                        installProgress = installProgress,
                        Modifier.weight(1f).heightIn(min = actions.height),
                    )
                }
            }
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
    val windowHeight = currentWindowSizeDp().height
    val compact = windowHeight < EntryCompactHeight
    val groupSpacing = entrySpacing(compact)
    val base = with(LocalDensity.current) { 16.sp.toDp() }
    val requiresNewerAndroid = state.requiresNewerAndroid
    Surface(Modifier.fillMaxSize(), color = MaterialTheme.colorScheme.background) {
        BoxWithConstraints(
            Modifier.fillMaxSize().safeDrawingPadding(),
            contentAlignment = Alignment.TopCenter,
        ) {
            val shortTitle = maxHeight < base * 13
            val actionWidth = (maxWidth - EntryContentGutter * 2).coerceIn(0.dp, EntryContentWidth)
            val actionHeight = measureUpdateActions(actionWidth, required = true).height
            Column(
                Modifier.padding(horizontal = EntryContentGutter)
                    .widthIn(max = EntryContentWidth)
                    .fillMaxSize()
                    .padding(
                        top = entryTopPadding(windowHeight),
                        bottom = groupSpacing,
                    ),
            ) {
                RequiredUpdateContent(
                    state,
                    title =
                        stringResource(
                            when {
                                requiresNewerAndroid && shortTitle ->
                                    R.string.updates_required_incompatible_short
                                requiresNewerAndroid -> R.string.updates_required_incompatible
                                shortTitle -> R.string.updates_required_short
                                else -> R.string.updates_required
                            },
                        ),
                    compact = compact,
                    shortTitle = shortTitle,
                    modifier = Modifier.weight(1f).fillMaxWidth(),
                )
                Spacer(Modifier.height(8.dp))
                UpdateAction(
                    state,
                    check,
                    download,
                    install,
                    installProgress,
                    Modifier.fillMaxWidth().heightIn(min = actionHeight),
                )
            }
        }
    }
}

@Composable
private fun RequiredUpdateContent(
    state: UpdateUiState,
    title: String,
    compact: Boolean,
    shortTitle: Boolean,
    modifier: Modifier,
) {
    val groupSpacing = entrySpacing(compact)
    val titleGap = 8.dp
    val titleStyle = entryTitleStyle(compact)
    val bodyStyle = MaterialTheme.typography.bodyMedium
    // The details and the complete page have different scroll origins.
    val detailsScroll = rememberScrollState()
    val pageScroll = rememberScrollState()
    BoxWithConstraints(modifier) {
        val measurer = rememberTextMeasurer()
        val brandHeight = measureEntryBrandHeight(compact, maxWidth, measurer)
        val (titleHeight, bodyLineHeight) =
            with(LocalDensity.current) {
                measurer
                    .measure(
                        title,
                        titleStyle,
                        constraints = Constraints(maxWidth = maxWidth.roundToPx()),
                    )
                    .size
                    .height
                    .toDp() to bodyStyle.lineHeight.toDp()
            }
        // In the shortest windows, let the heading scroll so there is room to read the details.
        val scrollHeading =
            maxHeight < brandHeight + groupSpacing + titleHeight + titleGap + bodyLineHeight
        Column(
            Modifier.fillMaxWidth()
                .then(if (scrollHeading) Modifier.keyboardReadingScroll(pageScroll) else Modifier),
            horizontalAlignment = Alignment.CenterHorizontally,
        ) {
            EntryBrand(compact)
            Spacer(Modifier.height(groupSpacing))
            Text(
                title,
                style = titleStyle,
                textAlign = TextAlign.Center,
                modifier = Modifier.semantics { heading() },
            )
            Spacer(Modifier.height(titleGap))
            val details = Modifier.fillMaxWidth()
            Column(
                if (scrollHeading) details
                else details.weight(1f).keyboardReadingScroll(detailsScroll),
                horizontalAlignment = Alignment.CenterHorizontally,
            ) {
                val requiresNewerAndroid = state.requiresNewerAndroid
                if (requiresNewerAndroid) {
                    UpdateStatusText(
                        R.string.updates_newer_android_required,
                        Modifier.padding(bottom = 8.dp),
                        textAlign = TextAlign.Center,
                    )
                }
                Text(
                    stringResource(
                        if (requiresNewerAndroid) R.string.updates_required_incompatible_description
                        else R.string.updates_required_description,
                    ),
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                    style = bodyStyle,
                    textAlign = TextAlign.Center,
                )
                Spacer(Modifier.height(if (shortTitle) 12.dp else 16.dp))
                FlowRow(
                    horizontalArrangement =
                        Arrangement.spacedBy(16.dp, Alignment.CenterHorizontally),
                    verticalArrangement = Arrangement.spacedBy(4.dp),
                ) {
                    UpdateCopy(
                        stringResource(R.string.updates_installed, state.installedVersion),
                        muted = true,
                    )
                    state.offeredRelease?.let { UpdateMetadata(it) }
                }
                // New feedback follows the existing content so it cannot shift what is being read.
                state.updateProblemMessage(requiresNewerAndroid)?.let {
                    UpdateStatusText(it, Modifier.padding(top = 8.dp), textAlign = TextAlign.Center)
                }
            }
        }
    }
}

@Composable
private fun UpdateMetadata(release: AndroidUpdatesRelease, compact: Boolean = false) {
    UpdateCopy(stringResource(R.string.updates_version, release.version), muted = true)
    val size = Formatter.formatShortFileSize(LocalContext.current, release.size)
    val packageSize = stringResource(R.string.updates_package_size, size)
    UpdateCopy(
        if (compact) size else packageSize,
        muted = true,
        modifier =
            if (compact) Modifier.clearAndSetSemantics { contentDescription = packageSize }
            else Modifier,
    )
}

@StringRes
private fun UpdateUiState.updateProblemMessage(requiresNewerAndroid: Boolean): Int? {
    val latestProblem =
        when (problem) {
            UpdateProblem.Check -> R.string.updates_error_check
            UpdateProblem.Download -> R.string.updates_error_download
            UpdateProblem.Integrity -> R.string.updates_error_integrity
            UpdateProblem.Identity -> R.string.updates_error_identity
            UpdateProblem.Storage -> R.string.updates_error_storage
            UpdateProblem.Interrupted -> R.string.updates_error_interrupted
            UpdateProblem.Install -> R.string.updates_error_install
            null -> null
        }
    return when {
        latestProblem != null -> latestProblem
        (check == UpdateCheck.Failed || check == UpdateCheck.Waiting) &&
            transfer !is UpdateTransfer.Downloading -> R.string.updates_error_check
        !requiresNewerAndroid &&
            check != UpdateCheck.Checking &&
            (required || available) &&
            displayedRelease?.let(::isEligible) != true -> R.string.updates_unavailable
        else -> null
    }
}

@Composable
private fun UpdateStatusText(
    @StringRes message: Int,
    modifier: Modifier = Modifier,
    textAlign: TextAlign = TextAlign.Unspecified,
) {
    val colors = MaterialTheme.colorScheme
    Text(
        stringResource(message),
        color =
            when (message) {
                R.string.updates_android_unsupported,
                R.string.updates_newer_android_required,
                R.string.updates_error_integrity,
                R.string.updates_error_identity,
                R.string.updates_error_storage,
                R.string.updates_error_install -> colors.error
                R.string.updates_current -> colors.onSurface
                else -> colors.onSurfaceVariant
            },
        style = MaterialTheme.typography.bodyMedium,
        textAlign = textAlign,
        modifier = modifier.semantics { liveRegion = LiveRegionMode.Polite },
    )
}

@Composable
private fun UpdateCopy(label: String, modifier: Modifier = Modifier, muted: Boolean = false) {
    Text(
        label,
        modifier = modifier,
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
    val shape = ButtonDefaults.shape
    val contentPadding =
        if (state.required)
            PaddingValues(requiredUpdateActionHorizontalPadding, updateActionVerticalPadding)
        else updateActionPadding
    val focus = remember { UpdateControlFocus() }
    val checking =
        state.check == UpdateCheck.Checking &&
            transfer !is UpdateTransfer.Downloading &&
            transfer !is UpdateTransfer.Waiting &&
            !state.canInstall &&
            !state.canDownload
    val downloadPercent = (transfer as? UpdateTransfer.Downloading)?.percent()
    val progress =
        when {
            transfer is UpdateTransfer.Downloading -> downloadLabel(downloadPercent)
            transfer is UpdateTransfer.Recovering && transfer.release != null ->
                stringResource(R.string.updates_preparing)
            state.canInstall && installProgress != null -> stringResource(installProgress)
            checking -> stringResource(R.string.updates_check_in_progress)
            else -> null
        }
    val showingProgress = progress != null
    // Capture focus before the button and the progress target replace each other.
    val retainFocus = remember(showingProgress) { focus.isFocused }
    LaunchedEffect(showingProgress) {
        if (retainFocus) focus.requestFocus()
    }
    val controlModifier =
        modifier
            .heightIn(min = updateActionMinHeight)
            .then(focus.modifier)
            .updateFocusOutline(
                shape,
                if (showingProgress) colors.onSurface else colors.onPrimary,
            )
    if (progress != null) {
        val fraction = downloadPercent?.let { it / 100f }
        val disabledColors = ButtonDefaults.buttonColors()
        val installing = state.canInstall && installProgress != null
        val waitingToInstall = installing && installProgress == R.string.updates_waiting_to_install
        val useDisabledColors = checking || waitingToInstall || (state.required && installing)
        Box(
            controlModifier
                .focusable()
                .clip(shape)
                .background(
                    if (useDisabledColors) disabledColors.disabledContainerColor
                    else colors.surfaceContainerHigh,
                )
                .semantics(
                    mergeDescendants = true,
                ) {
                    if (waitingToInstall) {
                        disabled()
                    } else {
                        progressBarRangeInfo =
                            if (fraction == null) ProgressBarRangeInfo.Indeterminate
                            else ProgressBarRangeInfo(fraction, 0f..1f)
                    }
                },
            contentAlignment = Alignment.Center,
        ) {
            Text(
                progress,
                modifier = Modifier.padding(contentPadding),
                color =
                    if (useDisabledColors) disabledColors.disabledContentColor
                    else colors.onSurface,
                style = updateProgressStyle(),
                textAlign = TextAlign.Center,
            )
            if (fraction != null) {
                Box(Modifier.align(Alignment.BottomStart).matchParentSize()) {
                    Box(
                        Modifier.align(Alignment.BottomStart)
                            .fillMaxWidth()
                            .height(2.dp)
                            .background(colors.secondaryContainer),
                    ) {
                        Box(
                            Modifier.fillMaxWidth(fraction)
                                .fillMaxSize()
                                .background(colors.primary),
                        )
                    }
                }
            }
        }
        return
    }
    val (label, action) =
        when {
            transfer is UpdateTransfer.Ready && state.canInstall ->
                R.string.updates_ready to { install(transfer.release) }
            transfer is UpdateTransfer.Waiting ->
                R.string.updates_retry_download to { download(transfer.release) }
            state.canDownload -> {
                val label =
                    if (state.interrupted) R.string.updates_retry_download
                    else R.string.updates_download
                label to { download(checkNotNull(state.candidate)) }
            }
            state.check == UpdateCheck.Waiting || state.check == UpdateCheck.Failed ->
                R.string.updates_retry_check to check
            state.required || state.requiresNewerAndroid ->
                R.string.updates_check_compatible to check
            else -> R.string.updates_check to check
        }
    Button(
        onClick = action,
        modifier = controlModifier,
        shape = shape,
        contentPadding = contentPadding,
    ) {
        Text(stringResource(label), textAlign = TextAlign.Center)
    }
}

private class UpdateControlFocus {
    private val requester = FocusRequester()
    private var restore = false
    var isFocused = false
        private set

    val modifier = Modifier.focusRequester(requester).onFocusChanged { isFocused = it.isFocused }

    fun requestFocus() {
        requester.requestFocus()
    }

    fun rememberTrigger() {
        restore = isFocused
    }

    fun restoreTrigger() {
        if (restore) requestFocus()
        restore = false
    }
}

@Composable
private fun rememberUpdateControlFocus(away: Boolean): UpdateControlFocus {
    val focus = remember { UpdateControlFocus() }
    val windowFocused = LocalWindowInfo.current.isWindowFocused
    LaunchedEffect(away, windowFocused) {
        if (!away && windowFocused) focus.restoreTrigger()
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
                .updateFocusOutline(ButtonDefaults.shape, MaterialTheme.colorScheme.onSurface),
        contentPadding = updateActionPadding,
    ) {
        Text(label, textAlign = TextAlign.Center)
    }
}

private val updateActionMinHeight = 48.dp
private val updateActionHorizontalPadding = 12.dp
private val requiredUpdateActionHorizontalPadding = 16.dp
private val updateActionVerticalPadding = 8.dp
private val updateSheetActionGap = 8.dp
private val updateActionPadding =
    PaddingValues(updateActionHorizontalPadding, updateActionVerticalPadding)

@Composable
private fun updateProgressStyle() =
    MaterialTheme.typography.labelLarge.copy(fontFeatureSettings = "tnum")

private data class UpdateActionSize(val dismissWidth: Dp, val height: Dp)

// Reserve room for both buttons and progress so localized wrapping cannot move the footer.
@Composable
private fun measureUpdateActions(width: Dp, required: Boolean): UpdateActionSize {
    val measurer = rememberTextMeasurer(cacheSize = 16)
    val dismissLabel = if (required) null else stringResource(R.string.updates_close)
    val horizontalPadding =
        if (required) requiredUpdateActionHorizontalPadding else updateActionHorizontalPadding
    val mainLabels =
        listOf(
            stringResource(R.string.updates_download),
            stringResource(R.string.updates_check),
            stringResource(R.string.updates_check_compatible),
            stringResource(R.string.updates_retry_check),
            stringResource(R.string.updates_retry_download),
            stringResource(R.string.updates_ready),
        )
    val progressLabels =
        listOf(
            downloadLabel(null),
            downloadLabel(100),
            stringResource(R.string.updates_check_in_progress),
            stringResource(R.string.updates_installing),
            stringResource(R.string.updates_waiting_to_install),
        )
    val labelStyle = MaterialTheme.typography.labelLarge
    val progressStyle = updateProgressStyle()
    return with(LocalDensity.current) {
        val dismissWidth =
            dismissLabel?.let {
                (measurer.measure(it, labelStyle, softWrap = false).size.width.toDp() +
                        horizontalPadding * 2)
                    .coerceAtLeast(72.dp)
                    .coerceAtMost((width - updateSheetActionGap - 48.dp).coerceAtLeast(0.dp))
            } ?: 0.dp
        val mainWidth = if (required) width else width - dismissWidth - updateSheetActionGap
        fun textHeight(label: String, style: TextStyle, slotWidth: Dp): Dp {
            val available = (slotWidth - horizontalPadding * 2).roundToPx().coerceAtLeast(0)
            return measurer
                .measure(label, style, constraints = Constraints(maxWidth = available))
                .size
                .height
                .toDp()
        }
        val textHeight =
            maxOf(
                dismissLabel?.let { textHeight(it, labelStyle, dismissWidth) } ?: 0.dp,
                mainLabels.maxOf { textHeight(it, labelStyle, mainWidth) },
                progressLabels.maxOf { textHeight(it, progressStyle, mainWidth) },
            )
        UpdateActionSize(
            dismissWidth,
            (textHeight + updateActionVerticalPadding * 2).coerceAtLeast(updateActionMinHeight),
        )
    }
}

@Composable
internal fun Modifier.updateFocusOutline(
    shape: Shape,
    color: Color,
    keyboardOnly: Boolean = false,
    outlineInset: Dp = 2.dp,
    includeDescendantFocus: Boolean = false,
): Modifier {
    val focused = remember { mutableStateOf(false) }
    val showOutline = !keyboardOnly || LocalInputModeManager.current.inputMode == InputMode.Keyboard
    return onFocusChanged {
        // The scroll container has a non-focusable target above its keyboard stop.
        focused.value = if (includeDescendantFocus) it.hasFocus else it.isFocused
    }
        .drawWithContent {
            drawContent()
            if (focused.value && showOutline) {
                val width = 2.dp.toPx()
                inset(outlineInset.toPx()) {
                    drawOutline(
                        shape.createOutline(size, layoutDirection, this),
                        color,
                        style = Stroke(width),
                    )
                }
            }
        }
}
