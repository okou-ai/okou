package ai.okou.android

import ai.okou.android.state.rememberSettingsFlag
import androidx.annotation.DrawableRes
import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ColumnScope
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.selection.selectable
import androidx.compose.foundation.selection.selectableGroup
import androidx.compose.foundation.selection.toggleable
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.ModalBottomSheet
import androidx.compose.material3.Surface
import androidx.compose.material3.Switch
import androidx.compose.material3.SwitchDefaults
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.rememberModalBottomSheetState
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.focus.FocusRequester
import androidx.compose.ui.focus.focusRequester
import androidx.compose.ui.focus.onFocusChanged
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.disabled
import androidx.compose.ui.semantics.heading
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
internal fun SettingsGroup(content: @Composable ColumnScope.() -> Unit) {
    Surface(
        Modifier.fillMaxWidth(),
        shape = RoundedCornerShape(16.dp),
        color = MaterialTheme.colorScheme.surface,
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
) {
    val colors = MaterialTheme.colorScheme
    val muted = colors.onSurfaceVariant
    val expandedText = currentWindowSizeDp().width < 360 || LocalDensity.current.fontScale > 1.3f
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
            if (expandedText && value != null) {
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
        if (!expandedText && value != null) {
            Row(
                verticalAlignment = Alignment.CenterVertically,
                horizontalArrangement = Arrangement.spacedBy(6.dp),
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
    supportingText: String? = null,
) {
    val action =
        if (checked == null || onCheckedChange == null) {
            Modifier.semantics(mergeDescendants = true) { disabled() }
        } else Modifier.toggleable(checked, role = Role.Switch, onValueChange = onCheckedChange)
    Row(
        Modifier.fillMaxWidth()
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
                val outline = MaterialTheme.colorScheme.onSurfaceVariant
                Switch(
                    checked,
                    onCheckedChange = null,
                    enabled = onCheckedChange != null,
                    colors =
                        SwitchDefaults.colors(
                            uncheckedThumbColor = outline,
                            uncheckedBorderColor = outline,
                        ),
                )
            }
        }
    }
}

@Composable
internal fun SettingsPickerRow(
    title: String,
    value: String?,
    leading: @Composable () -> Unit,
    enabled: Boolean = true,
    sheet: @Composable (dismiss: () -> Unit) -> Unit,
) {
    SettingsTrigger(enabled = enabled, content = sheet) { modifier, open ->
        SettingsRow(title, leading, modifier, value, onClick = open, enabled = enabled)
    }
}

@Composable
internal fun SettingsTrigger(
    enabled: Boolean = true,
    content: @Composable (dismiss: () -> Unit) -> Unit,
    trigger: @Composable (Modifier, open: () -> Unit) -> Unit,
) {
    var open by rememberSettingsFlag()
    var focused by remember { mutableStateOf(false) }
    var restoreFocus by rememberSettingsFlag()
    val focus = remember { FocusRequester() }
    trigger(Modifier.focusRequester(focus).onFocusChanged { focused = it.isFocused }) {
        if (enabled) {
            restoreFocus = focused
            open = true
        }
    }
    if (open && enabled) content { open = false }
    LaunchedEffect(open, enabled) {
        if (!open && enabled && restoreFocus) {
            restoreFocus = false
            focus.requestFocus()
        }
    }
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
internal fun SettingsModal(
    onDismiss: () -> Unit,
    content: @Composable (centered: Boolean) -> Unit,
) {
    val window = currentWindowSizeDp()
    if (workspaceListPaneWidth(window.width, window.height) != null) {
        Dialog(
            onDismissRequest = onDismiss,
            properties = DialogProperties(usePlatformDefaultWidth = false),
        ) {
            Surface(
                Modifier.padding(horizontal = 24.dp).widthIn(max = 460.dp).fillMaxWidth(),
                shape = RoundedCornerShape(28.dp),
                color = MaterialTheme.colorScheme.surface,
            ) {
                content(true)
            }
        }
    } else {
        ModalBottomSheet(
            onDismissRequest = onDismiss,
            sheetState = rememberModalBottomSheetState(skipPartiallyExpanded = true),
            sheetMaxWidth = 460.dp,
            shape = RoundedCornerShape(topStart = 28.dp, topEnd = 28.dp),
            containerColor = MaterialTheme.colorScheme.surface,
        ) {
            content(false)
        }
    }
}

@Composable
internal fun SettingsSheet(
    title: String,
    onDismiss: () -> Unit,
    actions: (@Composable () -> Unit)? = null,
    content: @Composable ColumnScope.() -> Unit,
) {
    val windowHeight = currentWindowSizeDp().height.dp
    val scroll = rememberScrollState()
    SettingsModal(onDismiss) { centered ->
        Column(
            Modifier.fillMaxWidth()
                .heightIn(max = windowHeight * 0.80f)
                .padding(
                    start = 16.dp,
                    end = 16.dp,
                    top = if (centered) 16.dp else 0.dp,
                    bottom = 16.dp,
                )
                .verticalScroll(scroll),
            verticalArrangement = Arrangement.spacedBy(8.dp),
        ) {
            Text(
                title,
                Modifier.semantics { heading() },
                style =
                    MaterialTheme.typography.titleLarge.copy(fontSize = 22.sp, lineHeight = 28.sp),
            )
            Column(
                Modifier.fillMaxWidth(),
                verticalArrangement = Arrangement.spacedBy(8.dp),
                content = content,
            )
            actions?.invoke()
        }
    }
}

@Composable
internal fun SettingsConfirmation(
    title: String,
    message: String,
    confirm: String,
    onDismiss: () -> Unit,
    onConfirm: () -> Unit,
) {
    val colors = MaterialTheme.colorScheme
    AlertDialog(
        onDismissRequest = onDismiss,
        modifier = Modifier.widthIn(max = 360.dp),
        shape = RoundedCornerShape(28.dp),
        containerColor = colors.surface,
        title = { Text(title) },
        text = { Text(message) },
        dismissButton = {
            TextButton(
                onClick = onDismiss,
                colors = ButtonDefaults.textButtonColors(contentColor = colors.onSurface),
            ) {
                Text(stringResource(R.string.settings_cancel))
            }
        },
        confirmButton = {
            Button(
                onClick = onConfirm,
                shape = RoundedCornerShape(12.dp),
                modifier = Modifier.heightIn(min = 48.dp),
                colors =
                    ButtonDefaults.buttonColors(
                        containerColor = colors.inverseSurface,
                        contentColor = colors.inverseOnSurface,
                    ),
            ) {
                Text(confirm)
            }
        },
    )
}

@Composable
internal fun <T> SettingsRadioOptions(
    options: List<T>,
    selected: T,
    label: (T) -> Int,
    enabled: Boolean,
    onSelect: (T) -> Unit,
) {
    Column(Modifier.fillMaxWidth().selectableGroup()) {
        options.forEach { option ->
            SettingsChoiceRow(
                stringResource(label(option)),
                selected = option == selected,
                enabled = enabled,
                onClick = { onSelect(option) },
            )
        }
    }
}

@Composable
internal fun SettingsChoiceRow(
    label: String,
    selected: Boolean,
    enabled: Boolean,
    onClick: () -> Unit,
    modifier: Modifier = Modifier,
    leading: @Composable () -> Unit = {},
) {
    val colors = MaterialTheme.colorScheme
    val foreground = if (selected) colors.onSecondaryContainer else colors.onSurface
    Row(
        modifier
            .fillMaxWidth()
            .heightIn(min = 56.dp)
            .clip(RoundedCornerShape(12.dp))
            .then(if (selected) Modifier.background(colors.secondaryContainer) else Modifier)
            .selectable(selected, enabled = enabled, role = Role.RadioButton, onClick = onClick)
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
