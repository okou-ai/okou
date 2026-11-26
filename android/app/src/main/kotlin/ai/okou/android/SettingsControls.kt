package ai.okou.android

import ai.okou.android.state.rememberSettingsChoiceFocus
import ai.okou.android.state.rememberSettingsFlag
import ai.okou.android.updates.updateFocusOutline
import androidx.activity.compose.BackHandler
import androidx.annotation.DrawableRes
import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.interaction.MutableInteractionSource
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.BoxWithConstraints
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ColumnScope
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.foundation.layout.WindowInsetsSides
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.isImeVisible
import androidx.compose.foundation.layout.only
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.safeDrawing
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.layout.windowInsetsPadding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.selection.selectable
import androidx.compose.foundation.selection.selectableGroup
import androidx.compose.foundation.selection.toggleable
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.BottomSheetDefaults
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Icon
import androidx.compose.material3.LocalRippleConfiguration
import androidx.compose.material3.LocalRippleThemeConfiguration
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.ModalBottomSheet
import androidx.compose.material3.ModalBottomSheetProperties
import androidx.compose.material3.ProvideTextStyle
import androidx.compose.material3.RippleConfiguration
import androidx.compose.material3.RippleThemeConfiguration
import androidx.compose.material3.SheetValue
import androidx.compose.material3.SnackbarHost
import androidx.compose.material3.SnackbarHostState
import androidx.compose.material3.Surface
import androidx.compose.material3.Switch
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.rememberBottomSheetState
import androidx.compose.material3.ripple
import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableFloatStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberUpdatedState
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.alpha
import androidx.compose.ui.draw.clip
import androidx.compose.ui.focus.FocusRequester
import androidx.compose.ui.focus.focusRequester
import androidx.compose.ui.focus.onFocusChanged
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.RectangleShape
import androidx.compose.ui.input.InputMode
import androidx.compose.ui.layout.Layout
import androidx.compose.ui.layout.LayoutCoordinates
import androidx.compose.ui.layout.onGloballyPositioned
import androidx.compose.ui.layout.positionInRoot
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.platform.LocalInputModeManager
import androidx.compose.ui.platform.LocalSoftwareKeyboardController
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.LiveRegionMode
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.clearAndSetSemantics
import androidx.compose.ui.semantics.disabled
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.semantics.liveRegion
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.compose.ui.window.Dialog
import androidx.compose.ui.window.DialogProperties

@Composable
internal fun SettingsSection(title: String, content: @Composable ColumnScope.() -> Unit) {
    Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
        Text(
            title,
            Modifier.padding(horizontal = 8.dp).semantics { heading() },
            color = MaterialTheme.colorScheme.onSurfaceVariant,
            style = MaterialTheme.typography.labelLarge.copy(fontSize = 13.sp, lineHeight = 20.sp),
        )
        content()
    }
}

@Composable
internal fun SettingsGroup(
    color: Color = MaterialTheme.colorScheme.surfaceContainerLow,
    content: @Composable ColumnScope.() -> Unit,
) {
    Surface(
        Modifier.fillMaxWidth(),
        shape = RoundedCornerShape(16.dp),
        color = color,
        border = BorderStroke(1.dp, MaterialTheme.colorScheme.outlineVariant),
    ) {
        Column(content = content)
    }
}

@Composable
internal fun SettingsIcon(@DrawableRes icon: Int) {
    Icon(painterResource(icon), contentDescription = null, modifier = Modifier.size(20.dp))
}

@Composable
internal fun SettingsRow(
    title: String,
    leading: @Composable () -> Unit,
    modifier: Modifier = Modifier,
    value: String? = null,
    onClick: (() -> Unit)? = null,
    enabled: Boolean = true,
    showChevron: Boolean = onClick != null,
    valueMaxLines: Int = Int.MAX_VALUE,
    valueLeading: (@Composable () -> Unit)? = null,
    supportingText: String? = null,
    valueMaxWidth: Dp = 144.dp,
    reserveValueSpace: Boolean = false,
    valueBelowTitle: Boolean =
        currentWindowSizeDp().width < 360 || LocalDensity.current.fontScale > 1.3f,
) {
    val colors = MaterialTheme.colorScheme
    val muted = colors.onSurfaceVariant
    val action =
        if (onClick == null) Modifier
        else Modifier.clickable(enabled = enabled, role = Role.Button, onClick = onClick)
    Row(
        modifier
            .fillMaxWidth()
            .then(action)
            .heightIn(min = if (supportingText == null) 56.dp else 72.dp)
            .padding(horizontal = 16.dp, vertical = 12.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(12.dp),
    ) {
        leading()
        Column(Modifier.weight(1f)) {
            Text(
                title,
                style = MaterialTheme.typography.bodyLarge,
                fontWeight = if (supportingText == null) null else FontWeight(550),
            )
            if (supportingText != null) {
                Text(
                    supportingText,
                    Modifier.padding(top = 2.dp),
                    color = muted,
                    style =
                        MaterialTheme.typography.bodySmall.copy(
                            fontSize = 12.sp,
                            lineHeight = 16.sp,
                        ),
                )
            }
            if (valueBelowTitle && value != null) {
                Row(
                    verticalAlignment = Alignment.CenterVertically,
                    horizontalArrangement = Arrangement.spacedBy(6.dp),
                ) {
                    valueLeading?.invoke()
                    Text(
                        value,
                        color = muted,
                        style = MaterialTheme.typography.bodyMedium,
                        maxLines = valueMaxLines,
                        overflow = TextOverflow.Ellipsis,
                    )
                }
            }
        }
        if (!valueBelowTitle && value != null) {
            Row(
                modifier = if (reserveValueSpace) Modifier.weight(0.8f) else Modifier,
                verticalAlignment = Alignment.CenterVertically,
                horizontalArrangement = Arrangement.spacedBy(6.dp, Alignment.End),
            ) {
                valueLeading?.invoke()
                Text(
                    value,
                    Modifier.widthIn(max = valueMaxWidth),
                    color = muted,
                    style = MaterialTheme.typography.bodyMedium,
                    textAlign = TextAlign.End,
                    maxLines = valueMaxLines,
                    overflow = TextOverflow.Ellipsis,
                )
            }
        }
        if (showChevron)
            Icon(
                painterResource(R.drawable.ic_chevron_right),
                contentDescription = null,
                modifier = Modifier.size(18.dp),
                tint = muted,
            )
    }
}

@Composable
internal fun SettingsSwitchRow(
    title: String,
    leading: @Composable () -> Unit,
    checked: Boolean?,
    onCheckedChange: ((Boolean) -> Unit)?,
    modifier: Modifier = Modifier,
    supportingText: String? = null,
) {
    val interactions = remember { MutableInteractionSource() }
    val action =
        if (checked == null) {
            Modifier.semantics(mergeDescendants = true) { disabled() }
        } else {
            Modifier.updateFocusOutline(
                    RoundedCornerShape(12.dp),
                    MaterialTheme.colorScheme.onSurface,
                )
                .toggleable(
                    checked,
                    interactionSource = interactions,
                    indication = null,
                    enabled = onCheckedChange != null,
                    role = Role.Switch,
                    onValueChange = { onCheckedChange?.invoke(it) },
                )
        }
    Row(
        modifier
            .fillMaxWidth()
            .then(action)
            .heightIn(min = if (supportingText == null) 56.dp else 72.dp)
            .padding(horizontal = 16.dp, vertical = 12.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(12.dp),
    ) {
        leading()
        Column(Modifier.weight(1f)) {
            Text(title, style = MaterialTheme.typography.bodyLarge)
            if (supportingText != null) {
                Text(
                    supportingText,
                    style = MaterialTheme.typography.bodyMedium,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
            }
        }
        Box(Modifier.width(52.dp)) {
            if (checked != null) {
                OkouSwitch(
                    checked,
                    enabled = onCheckedChange != null,
                    interactionSource = interactions,
                )
            }
        }
    }
}

@Composable
internal fun OkouSwitch(
    checked: Boolean,
    enabled: Boolean,
    interactionSource: MutableInteractionSource,
) {
    Switch(
        checked = checked,
        enabled = enabled,
        onCheckedChange = null,
        interactionSource = interactionSource,
    )
}

@Composable
internal fun SettingsPickerRow(
    title: String,
    value: String?,
    leading: @Composable () -> Unit,
    modifier: Modifier = Modifier,
    enabled: Boolean = true,
    visible: Boolean = true,
    fallbackFocus: FocusRequester? = null,
    sheet: @Composable (dismiss: () -> Unit) -> Unit,
) {
    SettingsTrigger(
        enabled = enabled,
        visible = visible,
        fallbackFocus = fallbackFocus,
        content = sheet,
    ) { triggerModifier, open ->
        SettingsRow(
            title,
            leading,
            modifier.then(triggerModifier),
            value,
            onClick = open,
            enabled = enabled,
        )
    }
}

@Composable
internal fun SettingsTrigger(
    enabled: Boolean = true,
    visible: Boolean = true,
    fallbackFocus: FocusRequester? = null,
    content: @Composable (dismiss: () -> Unit) -> Unit,
    trigger: @Composable (Modifier, open: () -> Unit) -> Unit,
) {
    var open by rememberSettingsFlag()
    var focused by remember { mutableStateOf(false) }
    var restoreFocus by rememberSettingsFlag()
    val focus = remember { FocusRequester() }
    // Resolve return focus before Compose detaches the hidden trigger.
    val restoreRelatedFocus = !visible && (focused || restoreFocus)
    if (visible) {
        trigger(Modifier.focusRequester(focus).onFocusChanged { focused = it.isFocused }) {
            if (enabled) {
                restoreFocus = focused
                open = true
            }
        }
        if (open && enabled) content { open = false }
    }
    LaunchedEffect(open, enabled, visible) {
        if (!visible) {
            open = false
            restoreFocus = false
            if (restoreRelatedFocus) fallbackFocus?.requestFocus()
        } else if (!open && enabled && restoreFocus) {
            restoreFocus = false
            focus.requestFocus()
        }
    }
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
internal fun SettingsModal(
    onDismiss: () -> Unit,
    dismissible: Boolean = true,
    fullScreen: Boolean = false,
    showDragHandle: Boolean = true,
    fitContentInsets: Boolean = false,
    confirmDismiss: (() -> Boolean)? = null,
    reserveTopInset: Boolean = false,
    content: @Composable (centered: Boolean) -> Unit,
) {
    val window = currentWindowSizeDp()
    if (fullScreen || workspaceListPaneWidth(window.width, window.height) != null) {
        Dialog(
            onDismissRequest = { if (confirmDismiss?.invoke() != false) onDismiss() },
            properties =
                DialogProperties(
                    dismissOnBackPress = dismissible,
                    dismissOnClickOutside = dismissible && !fullScreen,
                    usePlatformDefaultWidth = false,
                    decorFitsSystemWindows = !fitContentInsets,
                ),
        ) {
            Surface(
                if (fullScreen) Modifier.fillMaxSize()
                else Modifier.padding(horizontal = 24.dp).widthIn(max = 460.dp).fillMaxWidth(),
                shape = if (fullScreen) RectangleShape else MaterialTheme.shapes.extraLarge,
                color = MaterialTheme.colorScheme.surface,
            ) {
                if (fitContentInsets) {
                    Box(Modifier.windowInsetsPadding(WindowInsets.safeDrawing)) { content(true) }
                } else content(true)
            }
        }
    } else {
        val allowDismiss by rememberUpdatedState(dismissible)
        val confirm by rememberUpdatedState(confirmDismiss)
        ModalBottomSheet(
            onDismissRequest = onDismiss,
            modifier =
                if (reserveTopInset)
                    Modifier.windowInsetsPadding(
                        WindowInsets.safeDrawing.only(WindowInsetsSides.Top),
                    )
                else Modifier,
            sheetState =
                rememberBottomSheetState(
                    initialValue = SheetValue.Hidden,
                    enabledValues = setOf(SheetValue.Hidden, SheetValue.Expanded),
                    confirmValueChange = {
                        it != SheetValue.Hidden || allowDismiss && confirm?.invoke() != false
                    },
                ),
            sheetGesturesEnabled = dismissible,
            dragHandle = if (showDragHandle) ({ BottomSheetDefaults.DragHandle() }) else null,
            properties =
                ModalBottomSheetProperties(
                    shouldDismissOnBackPress = dismissible && confirmDismiss == null,
                    shouldDismissOnClickOutside = dismissible,
                ),
        ) {
            // A vetoed native predictive hide can leave the sheet scaled after Back.
            val imeVisible = WindowInsets.isImeVisible
            val keyboard = LocalSoftwareKeyboardController.current
            BackHandler(enabled = confirmDismiss != null) {
                if (imeVisible) keyboard?.hide()
                else if (dismissible && confirmDismiss?.invoke() != false) onDismiss()
            }
            content(false)
        }
    }
}

internal fun settingsPanelContentPadding(compactHeight: Boolean) =
    PaddingValues(start = 16.dp, end = 16.dp, bottom = if (compactHeight) 12.dp else 22.dp)

@Composable internal fun isShortSettingsPanelWindow() = currentWindowSizeDp().height < 480

internal enum class SettingsSheetScroll {
    Panel,
    Body,
    None,
}

@Composable
internal fun SettingsSheet(
    title: String,
    onDismiss: () -> Unit,
    modifier: Modifier = Modifier,
    actions: (@Composable () -> Unit)? = null,
    titleInset: Dp = 0.dp,
    progress: (@Composable () -> Unit)? = null,
    actionSpacing: Dp = 8.dp,
    scroll: SettingsSheetScroll = SettingsSheetScroll.Body,
    dismissible: Boolean = true,
    fullScreenInShortWindow: Boolean = false,
    confirmDismiss: (() -> Boolean)? = null,
    snackbar: SnackbarHostState? = null,
    content: @Composable ColumnScope.() -> Unit,
) {
    val compactHeight = isShortSettingsPanelWindow()
    val scrollModifier =
        if (scroll == SettingsSheetScroll.None) Modifier
        else Modifier.verticalScroll(rememberScrollState())
    SettingsModal(
        onDismiss,
        dismissible = dismissible,
        fullScreen = compactHeight && fullScreenInShortWindow,
        fitContentInsets = compactHeight && fullScreenInShortWindow,
        confirmDismiss = confirmDismiss,
        // Give native scroll bodies stable height as the sheet opens and consumes the top inset.
        reserveTopInset = scroll == SettingsSheetScroll.None,
    ) { centered ->
        var panelBottom by remember { mutableFloatStateOf(0f) }
        var actionTop by remember { mutableStateOf<Float?>(null) }
        val panel: @Composable () -> Unit = {
            Column(
                modifier
                    .fillMaxWidth()
                    .padding(settingsPanelContentPadding(compactHeight))
                    .padding(top = if (centered) 16.dp else 0.dp)
                    .then(if (scroll == SettingsSheetScroll.Panel) scrollModifier else Modifier),
            ) {
                Box(Modifier.fillMaxWidth()) {
                    val compactTitle = compactHeight && fullScreenInShortWindow
                    Text(
                        title,
                        Modifier.padding(start = titleInset, end = titleInset, bottom = 8.dp)
                            .semantics { heading() },
                        style =
                            MaterialTheme.typography.titleLarge.copy(
                                fontSize = if (compactTitle) 16.sp else 22.sp,
                                lineHeight = if (compactTitle) 24.sp else 28.sp,
                                fontWeight = FontWeight.SemiBold,
                            ),
                    )
                    if (progress != null) Box(Modifier.align(Alignment.BottomCenter)) { progress() }
                }
                val body = Modifier.fillMaxWidth()
                val bodyModifier =
                    when (scroll) {
                        SettingsSheetScroll.Panel -> body
                        SettingsSheetScroll.Body ->
                            body.weight(1f, fill = false).then(scrollModifier)
                        SettingsSheetScroll.None -> body.weight(1f, fill = false)
                    }
                Column(bodyModifier) {
                    Column(
                        Modifier.fillMaxWidth(),
                        verticalArrangement = Arrangement.spacedBy(8.dp),
                        content = content,
                    )
                    if (actions != null) {
                        val anchor =
                            if (snackbar == null) Modifier
                            else Modifier.onGloballyPositioned { actionTop = it.positionInRoot().y }
                        Box(Modifier.padding(top = actionSpacing).then(anchor)) { actions() }
                    }
                }
            }
        }
        if (snackbar == null) panel()
        else {
            Box(
                Modifier.onGloballyPositioned {
                    panelBottom = it.positionInRoot().y + it.size.height
                },
                propagateMinConstraints = true,
            ) {
                panel()
                Box(Modifier.matchParentSize()) {
                    // Overlay the content while keeping the action group reachable.
                    val actionInset =
                        with(LocalDensity.current) {
                            (panelBottom - (actionTop ?: panelBottom)).coerceAtLeast(0f).toDp()
                        }
                    SnackbarHost(
                        snackbar,
                        Modifier.align(Alignment.BottomCenter)
                            .widthIn(max = 504.dp)
                            .padding(start = 12.dp, end = 12.dp, bottom = actionInset + 8.dp),
                    )
                }
            }
        }
    }
}

@Composable
internal fun SettingsSheetDescription(text: String) {
    Text(
        text,
        Modifier.padding(horizontal = 8.dp),
        color = MaterialTheme.colorScheme.onSurfaceVariant,
        style = MaterialTheme.typography.bodyMedium.copy(fontSize = 13.sp, lineHeight = 20.sp),
    )
}

private val buttonFocusOutlineTheme =
    RippleThemeConfiguration(
        focus =
            RippleThemeConfiguration.Focus.InsetRing(
                outerStrokeInset = 1.dp,
                outerStrokeWidth = 2.dp,
                innerStrokeInset = 0.dp,
                innerStrokeWidth = 0.dp,
            ),
    )

@Composable
internal fun WithButtonFocusOutline(color: Color, content: @Composable () -> Unit) {
    CompositionLocalProvider(
        LocalRippleThemeConfiguration provides buttonFocusOutlineTheme,
        LocalRippleConfiguration provides
            RippleConfiguration(
                focus =
                    RippleConfiguration.Focus.InsetRing(
                        outerStrokeColor = color,
                        innerStrokeColor = Color.Transparent,
                    ),
            ),
        content = content,
    )
}

@Composable
internal fun OkouConfirmationDialog(
    title: String,
    confirm: String,
    onDismiss: () -> Unit,
    onConfirm: () -> Unit,
    confirmEnabled: Boolean = true,
    dismissEnabled: Boolean = true,
    destructive: Boolean = false,
    dismissLabel: String = stringResource(R.string.settings_cancel),
    keepActionsVisible: Boolean = false,
    pendingConfirmLabel: String? = null,
    confirmPending: Boolean = false,
    actionStatus: (@Composable () -> Unit)? = null,
    content: @Composable () -> Unit,
) {
    Dialog(
        onDismissRequest = onDismiss,
        properties =
            DialogProperties(
                usePlatformDefaultWidth = false,
                dismissOnBackPress = dismissEnabled,
                dismissOnClickOutside = dismissEnabled,
            ),
    ) {
        BoxWithConstraints {
            val compact = with(LocalDensity.current) { maxHeight < 16.sp.toDp() * 12 }
            val margin = if (compact) 12.dp else 24.dp
            val inset = if (compact) 16.dp else 24.dp
            val titleGap = if (compact) 8.dp else 16.dp
            val actionGap = if (compact) 12.dp else 24.dp
            val titleStyle =
                if (compact)
                    MaterialTheme.typography.titleLarge.copy(fontSize = 20.sp, lineHeight = 28.sp)
                else MaterialTheme.typography.headlineSmall
            val bodyStyle = MaterialTheme.typography.bodyMedium
            val colors = MaterialTheme.colorScheme
            val dialogWidth = minOf(360.dp, (maxWidth - margin * 2).coerceAtLeast(0.dp))
            val dialogHeight = (maxHeight - margin * 2).coerceAtLeast(0.dp)
            val contentHeight = (dialogHeight - inset * 2).coerceAtLeast(0.dp)
            Surface(
                Modifier.width(dialogWidth).heightIn(max = dialogHeight),
                shape = RoundedCornerShape(28.dp),
                color = colors.surfaceContainerHigh,
                contentColor = colors.onSurface,
            ) {
                Layout(
                    modifier = Modifier.verticalScroll(rememberScrollState()).padding(inset),
                    content = {
                        Text(
                            title,
                            Modifier.semantics { heading() },
                            style = titleStyle,
                        )
                        Surface(
                            Modifier.fillMaxWidth().verticalScroll(rememberScrollState()),
                            color = Color.Transparent,
                            contentColor = colors.onSurfaceVariant,
                        ) {
                            ProvideTextStyle(bodyStyle, content)
                        }
                        Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                            actionStatus?.invoke()
                            WithButtonFocusOutline(colors.onBackground) {
                                FlowRow(
                                    Modifier.fillMaxWidth(),
                                    horizontalArrangement =
                                        Arrangement.spacedBy(8.dp, Alignment.End),
                                    verticalArrangement = Arrangement.spacedBy(8.dp),
                                ) {
                                    val buttonPadding =
                                        if (compact)
                                            PaddingValues(horizontal = 8.dp, vertical = 8.dp)
                                        else ButtonDefaults.TextButtonContentPadding
                                    TextButton(
                                        onClick = onDismiss,
                                        modifier = Modifier.heightIn(min = 48.dp),
                                        enabled = dismissEnabled,
                                        contentPadding = buttonPadding,
                                    ) {
                                        Text(dismissLabel)
                                    }
                                    TextButton(
                                        onClick = onConfirm,
                                        modifier =
                                            Modifier.heightIn(min = 48.dp).semantics {
                                                if (confirmPending) {
                                                    liveRegion = LiveRegionMode.Polite
                                                }
                                            },
                                        enabled = confirmEnabled && !confirmPending,
                                        contentPadding = buttonPadding,
                                        colors =
                                            if (destructive)
                                                ButtonDefaults.textButtonColors(
                                                    contentColor = colors.error,
                                                )
                                            else ButtonDefaults.textButtonColors(),
                                    ) {
                                        if (pendingConfirmLabel == null) {
                                            Text(confirm)
                                        } else {
                                            Box(contentAlignment = Alignment.Center) {
                                                val hidden =
                                                    Modifier.clearAndSetSemantics {}.alpha(0f)
                                                if (confirmPending) {
                                                    Text(confirm, hidden)
                                                    Text(pendingConfirmLabel)
                                                } else {
                                                    Text(pendingConfirmLabel, hidden)
                                                    Text(confirm)
                                                }
                                            }
                                        }
                                    }
                                }
                            }
                        }
                    },
                ) { children, constraints ->
                    val loose = constraints.copy(minHeight = 0)
                    val heading = children[0].measure(loose)
                    val actions = children[2].measure(loose)
                    val titleSpace = titleGap.roundToPx()
                    val actionSpace = actionGap.roundToPx()
                    val bodySpace =
                        contentHeight.roundToPx() -
                            heading.height -
                            actions.height -
                            titleSpace -
                            actionSpace
                    // Let the whole dialog scroll if there is too little room for the body.
                    val minimumBodyHeight =
                        if (keepActionsVisible) bodyStyle.fontSize.toDp().roundToPx()
                        else bodyStyle.lineHeight.toDp().roundToPx() * 2
                    val body =
                        children[1].measure(
                            loose.copy(
                                maxHeight = maxOf(bodySpace, minimumBodyHeight),
                            ),
                        )
                    val bodyTop = heading.height + titleSpace
                    val actionsTop = bodyTop + body.height + actionSpace
                    layout(constraints.maxWidth, actionsTop + actions.height) {
                        heading.placeRelative(0, 0)
                        body.placeRelative(0, bodyTop)
                        actions.placeRelative(0, actionsTop)
                    }
                }
            }
        }
    }
}

@Composable
internal fun <T : Enum<T>> SettingsRadioSheet(
    title: String,
    dismiss: () -> Unit,
    options: List<T>,
    selected: T,
    label: (T) -> Int,
    onSelect: (T) -> Unit,
) {
    SettingsChoiceSheet(title, dismiss, options, options.indexOf(selected), { it.name }) {
        option,
        position ->
        SettingsChoiceRow(
            stringResource(label(option)),
            selected = option == selected,
            enabled = true,
            onClick = {
                dismiss()
                onSelect(option)
            },
            modifier = position,
        )
    }
}

@Composable
internal fun <T> SettingsChoiceSheet(
    title: String,
    dismiss: () -> Unit,
    options: List<T>,
    selectedIndex: Int,
    optionKey: (T) -> String,
    choice: @Composable (T, Modifier) -> Unit,
) {
    val initialIndex = remember { if (selectedIndex in options.indices) selectedIndex else 0 }
    val scroll = rememberLazyListState(initialFirstVisibleItemIndex = initialIndex)
    SettingsChoicePanel(
        title,
        dismiss,
        initialKey = options.getOrNull(initialIndex)?.let(optionKey),
        isAvailable = { key -> options.any { optionKey(it) == key } },
    ) { position ->
        LazyColumn(Modifier.fillMaxWidth().selectableGroup(), state = scroll) {
            items(options, key = optionKey) { option ->
                choice(option, position(optionKey(option)))
            }
        }
    }
}

@Composable
internal fun SettingsChoicePanel(
    title: String,
    dismiss: () -> Unit,
    initialKey: String?,
    isAvailable: (String) -> Boolean,
    content: @Composable ((String) -> Modifier) -> Unit,
) {
    var focusedKey by rememberSettingsChoiceFocus()
    val inputMode = LocalInputModeManager.current
    SettingsSheet(title, dismiss, scroll = SettingsSheetScroll.None) {
        // Reattach focus when resizing replaces the bottom sheet with a dialog or vice versa.
        val openingKey = remember { focusedKey?.takeIf(isAvailable) ?: initialKey }
        val focus = remember { FocusRequester() }
        var positioned by remember { mutableStateOf(false) }
        var coordinates by remember { mutableStateOf<LayoutCoordinates?>(null) }
        LaunchedEffect(coordinates) {
            if (!positioned && coordinates?.isAttached == true) {
                positioned = true
                if (inputMode.inputMode == InputMode.Keyboard) focus.requestFocus()
            }
        }
        val anchor =
            Modifier.focusRequester(focus).onGloballyPositioned {
                if (!positioned && coordinates?.isAttached != true) coordinates = it
            }
        content { key ->
            (if (key == openingKey) anchor else Modifier).onFocusChanged {
                if (it.isFocused) focusedKey = key
            }
        }
    }
}

private val settingsChoiceRipple = ripple(enableFocusIndication = false)

@Composable
internal fun SettingsChoiceRow(
    label: String,
    selected: Boolean,
    enabled: Boolean,
    onClick: () -> Unit,
    modifier: Modifier = Modifier,
    leading: @Composable () -> Unit = {},
    trailing: @Composable (Color) -> Unit = {},
) {
    val colors = MaterialTheme.colorScheme
    val foreground = if (selected) colors.onSecondaryContainer else colors.onSurface
    val shape = RoundedCornerShape(12.dp)
    Row(
        modifier
            .fillMaxWidth()
            .heightIn(min = 56.dp)
            .clip(shape)
            .updateFocusOutline(shape, foreground)
            .then(if (selected) Modifier.background(colors.secondaryContainer) else Modifier)
            .selectable(
                selected,
                interactionSource = null,
                indication = settingsChoiceRipple,
                enabled = enabled,
                role = Role.RadioButton,
                onClick = onClick,
            )
            .padding(horizontal = 12.dp, vertical = 8.dp),
        horizontalArrangement = Arrangement.spacedBy(8.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        leading()
        Text(
            label,
            Modifier.weight(1f),
            color = foreground,
            style = MaterialTheme.typography.bodyLarge,
        )
        trailing(foreground)
        Box(Modifier.size(20.dp), contentAlignment = Alignment.Center) {
            if (selected)
                Icon(
                    painterResource(R.drawable.ic_check),
                    contentDescription = null,
                    modifier = Modifier.size(20.dp),
                    tint = foreground,
                )
        }
    }
}
