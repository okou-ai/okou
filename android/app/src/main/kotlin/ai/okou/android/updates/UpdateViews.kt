package ai.okou.android.updates

import ai.okou.android.LocalActivityStatusColor
import ai.okou.android.R
import ai.okou.android.SettingsIcon
import ai.okou.android.SettingsRow
import ai.okou.android.api.generated.AndroidUpdatesRelease
import android.text.format.Formatter
import androidx.activity.compose.BackHandler
import androidx.annotation.DrawableRes
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.safeDrawingPadding
import androidx.compose.foundation.layout.size
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
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalConfiguration
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.platform.LocalWindowInfo
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.LiveRegionMode
import androidx.compose.ui.semantics.ProgressBarRangeInfo
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.semantics.liveRegion
import androidx.compose.ui.semantics.progressBarRangeInfo
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.compose.ui.window.Dialog
import androidx.compose.ui.window.DialogProperties
import java.text.NumberFormat

internal data class UpdateToolbarAction(
    val label: String,
    val activate: (() -> Unit)?,
    @DrawableRes val icon: Int = R.drawable.ic_download,
)

private fun UpdateTransfer.Downloading.fraction(): Float =
    (downloadedBytes.toDouble() / release.size).coerceIn(0.0, 1.0).toFloat()

@Composable
private fun UpdateTransfer.Downloading.percent(): String {
    val locale = LocalConfiguration.current.locales[0]
    val format = remember(locale) { NumberFormat.getPercentInstance(locale) }
    return format.format((fraction() * 100).toInt() / 100.0)
}

private val UpdateUiState.interrupted
    get() = transfer is UpdateTransfer.Failed || transfer is UpdateTransfer.Interrupted

@Composable
internal fun updateToolbarAction(
    state: UpdateUiState,
    download: (AndroidUpdatesRelease) -> Unit,
    install: (AndroidUpdatesRelease) -> Unit,
    installEnabled: Boolean,
    openDetails: () -> Unit,
): UpdateToolbarAction? {
    if (!state.announce) return null
    val transfer = state.transfer
    return when {
        transfer is UpdateTransfer.Downloading ->
            UpdateToolbarAction(transfer.percent(), openDetails)
        transfer is UpdateTransfer.Ready && state.canInstall ->
            UpdateToolbarAction(
                stringResource(R.string.updates_install_toolbar),
                if (installEnabled) ({ install(transfer.release) }) else null,
                R.drawable.ic_refresh,
            )
        state.canDownload -> {
            val release = checkNotNull(state.candidate)
            val label = if (state.interrupted) R.string.retry else R.string.updates_toolbar
            UpdateToolbarAction(stringResource(label), { download(release) })
        }
        else -> UpdateToolbarAction(stringResource(R.string.updates_toolbar), openDetails)
    }
}

@Composable
internal fun UpdateHost(
    state: UpdateUiState,
    check: () -> Unit,
    download: (AndroidUpdatesRelease) -> Unit,
    defer: (AndroidUpdatesRelease) -> Unit,
    install: (AndroidUpdatesRelease) -> Unit,
    installEnabled: Boolean,
    automaticInstall: AndroidUpdatesRelease?,
    windowFocused: Boolean,
    startAutomaticInstall: (AndroidUpdatesRelease) -> Unit,
    showAnnouncement: Boolean,
    content: @Composable (openUpdates: () -> Unit) -> Unit,
) {
    var details by rememberSaveable { mutableStateOf(false) }
    val showDetails = details && !state.required
    LaunchedEffect(automaticInstall, showDetails, windowFocused) {
        if (automaticInstall != null && !showDetails && windowFocused)
            startAutomaticInstall(automaticInstall)
    }
    if (state.required) {
        LaunchedEffect(Unit) { details = false }
        RequiredUpdateScreen(state, check, download, install, installEnabled)
    } else {
        Column(Modifier.fillMaxSize().safeDrawingPadding()) {
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
            Box(Modifier.weight(1f)) { content { details = true } }
        }
    }
    if (showDetails) {
        UpdateSheet(
            state,
            check,
            download,
            install,
            installEnabled,
            automaticInstall,
            close = { details = false },
        )
    }
}

@Composable
internal fun AppUpdateSettings(state: UpdateUiState, open: () -> Unit) {
    val transfer = state.transfer
    val newVersion = state.canDownload && !state.interrupted
    val summary =
        when {
            state.preparing -> stringResource(R.string.updates_preparing)
            transfer is UpdateTransfer.Downloading ->
                stringResource(R.string.updates_downloading, transfer.percent())
            state.canInstall -> stringResource(R.string.updates_ready)
            state.interrupted && state.available -> stringResource(R.string.updates_interrupted)
            newVersion -> stringResource(R.string.updates_new_version)
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
    installEnabled: Boolean,
    automaticInstall: AndroidUpdatesRelease?,
    close: () -> Unit,
) {
    val window = LocalConfiguration.current
    val windowHeight =
        with(LocalDensity.current) { LocalWindowInfo.current.containerSize.height.toDp() }
    val panel: @Composable () -> Unit = {
        val focused = LocalWindowInfo.current.isWindowFocused
        LaunchedEffect(automaticInstall, focused) {
            if (automaticInstall != null && focused) close()
        }
        val transfer = state.transfer
        val release = state.displayedRelease?.takeIf { state.available }
        Column(
            Modifier.fillMaxWidth()
                .heightIn(max = windowHeight * 0.8f)
                .padding(start = 24.dp, end = 24.dp, bottom = 24.dp),
            verticalArrangement = Arrangement.spacedBy(20.dp),
        ) {
            Column(
                Modifier.weight(1f, fill = false).verticalScroll(rememberScrollState()),
                verticalArrangement = Arrangement.spacedBy(12.dp),
            ) {
                Text(
                    if (release == null) stringResource(R.string.updates_title)
                    else stringResource(R.string.updates_target, release.version),
                    style = MaterialTheme.typography.headlineSmall,
                    modifier = Modifier.semantics { heading() },
                )
                if (release != null) {
                    UpdateMetadata(state.installedVersion, release)
                }
                when {
                    transfer is UpdateTransfer.Downloading ->
                        UpdateCopy(stringResource(R.string.updates_background))
                    state.canInstall && state.problem == null ->
                        UpdateCopy(stringResource(R.string.updates_ready_description))
                    state.check == UpdateCheck.Checked && release == null ->
                        UpdateCopy(stringResource(R.string.updates_current))
                    state.check == UpdateCheck.Checking ->
                        UpdateCopy(stringResource(R.string.updates_checking))
                }
                if (release != null && release.notes.isNotBlank()) UpdateCopy(release.notes)
                UpdateProblemText(state)
            }
            Row(
                Modifier.fillMaxWidth(),
                horizontalArrangement = Arrangement.spacedBy(8.dp),
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
                ActionText(stringResource(dismissLabel), close, Modifier.widthIn(min = 72.dp))
                UpdateAction(
                    state,
                    check,
                    download,
                    install = {
                        close()
                        install(it)
                    },
                    installEnabled,
                    Modifier.weight(1f),
                )
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
    installEnabled: Boolean,
) {
    BackHandler {}
    val top =
        with(LocalDensity.current) {
            (LocalWindowInfo.current.containerSize.height.toDp() * 0.08f).coerceIn(24.dp, 72.dp)
        }
    Surface(Modifier.fillMaxSize(), color = MaterialTheme.colorScheme.background) {
        Box(Modifier.fillMaxSize().safeDrawingPadding(), contentAlignment = Alignment.Center) {
            Column(
                Modifier.widthIn(max = 560.dp)
                    .fillMaxSize()
                    .padding(start = 24.dp, end = 24.dp, bottom = 24.dp),
                verticalArrangement = Arrangement.spacedBy(24.dp),
            ) {
                Column(
                    Modifier.weight(1f).verticalScroll(rememberScrollState()).padding(top = top)
                ) {
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
                    state.displayedRelease?.let { release ->
                        Spacer(Modifier.height(16.dp))
                        UpdateMetadata(state.installedVersion, release, includeTarget = true)
                    }
                }
                Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                    UpdateProblemText(state)
                    if (state.canInstall && state.problem == null)
                        UpdateCopy(stringResource(R.string.updates_required_resume), muted = true)
                    UpdateAction(
                        state,
                        check,
                        download,
                        install,
                        installEnabled,
                        Modifier.fillMaxWidth(),
                        labelStyle = MaterialTheme.typography.labelLarge.copy(fontSize = 13.sp),
                    )
                }
            }
        }
    }
}

@Composable
private fun UpdateMetadata(
    installedVersion: String,
    release: AndroidUpdatesRelease,
    includeTarget: Boolean = false,
) {
    FlowRow(
        horizontalArrangement = Arrangement.spacedBy(16.dp),
        verticalArrangement = Arrangement.spacedBy(4.dp),
    ) {
        UpdateCopy(stringResource(R.string.updates_installed, installedVersion), muted = true)
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

@Composable
private fun UpdateProblemText(state: UpdateUiState) {
    val release = state.displayedRelease
    if (release != null && (state.available || state.required) && !state.isEligible(release)) {
        Text(
            stringResource(
                if (release.minimumSdk > state.sdk) R.string.updates_android_unsupported
                else R.string.updates_unavailable
            ),
            style = MaterialTheme.typography.bodyMedium,
            color = MaterialTheme.colorScheme.error,
        )
    }
    state.problem?.let { problem ->
        val message =
            when (problem) {
                UpdateProblem.Check -> R.string.updates_error_check
                UpdateProblem.Download -> R.string.updates_error_download
                UpdateProblem.Integrity -> R.string.updates_error_integrity
                UpdateProblem.Identity -> R.string.updates_error_identity
                UpdateProblem.Storage -> R.string.updates_error_storage
                UpdateProblem.Interrupted -> R.string.updates_error_interrupted
                UpdateProblem.Install -> R.string.updates_error_install
            }
        Text(
            stringResource(message),
            color = MaterialTheme.colorScheme.error,
            style = MaterialTheme.typography.bodyMedium,
            modifier = Modifier.semantics { liveRegion = LiveRegionMode.Polite },
        )
    }
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
    installEnabled: Boolean,
    modifier: Modifier,
    labelStyle: TextStyle = MaterialTheme.typography.labelLarge,
) {
    val transfer = state.transfer
    val colors = MaterialTheme.colorScheme
    val shape = RoundedCornerShape(12.dp)
    val checking = state.check == UpdateCheck.Checking && !state.canInstall && !state.canDownload
    if (transfer is UpdateTransfer.Downloading || checking) {
        val fraction = (transfer as? UpdateTransfer.Downloading)?.fraction()
        Box(
            modifier
                .heightIn(min = 48.dp)
                .background(colors.secondaryContainer, shape)
                .semantics {
                    progressBarRangeInfo =
                        if (fraction == null) ProgressBarRangeInfo.Indeterminate
                        else ProgressBarRangeInfo(fraction, 0f..1f)
                }
                .padding(horizontal = 12.dp, vertical = 6.dp),
            contentAlignment = Alignment.Center,
        ) {
            Text(
                if (transfer is UpdateTransfer.Downloading)
                    stringResource(R.string.updates_downloading, transfer.percent())
                else stringResource(R.string.updates_check_in_progress),
                color = colors.onSecondaryContainer,
                style =
                    labelStyle.copy(fontFeatureSettings = "tnum", fontWeight = FontWeight.Normal),
            )
        }
        return
    }
    val (label, action) =
        when {
            state.preparing -> R.string.updates_preparing to null
            transfer is UpdateTransfer.Ready && state.canInstall ->
                R.string.updates_ready to
                    if (installEnabled) ({ install(transfer.release) }) else null
            state.canDownload ->
                (if (state.interrupted) R.string.retry else R.string.updates_toolbar) to
                    ({
                        download(checkNotNull(state.candidate))
                    })
            state.check == UpdateCheck.Failed -> R.string.retry to check
            else -> R.string.updates_check to check
        }
    Button(
        onClick = { action?.invoke() },
        enabled = action != null,
        modifier = modifier.heightIn(min = 48.dp),
        shape = shape,
        colors =
            ButtonDefaults.buttonColors(
                containerColor = colors.inverseSurface,
                contentColor = colors.inverseOnSurface,
            ),
    ) {
        Text(stringResource(label), style = labelStyle)
    }
}

@Composable
private fun ActionText(label: String, action: () -> Unit, modifier: Modifier = Modifier) {
    TextButton(
        onClick = action,
        modifier = modifier.heightIn(min = 48.dp),
        colors = ButtonDefaults.textButtonColors(contentColor = MaterialTheme.colorScheme.onSurface),
    ) {
        Text(label)
    }
}
