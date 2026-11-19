package ai.okou.android

import androidx.annotation.DrawableRes
import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ColumnScope
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.selection.selectable
import androidx.compose.foundation.selection.selectableGroup
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.ModalBottomSheet
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
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
import androidx.compose.ui.platform.LocalWindowInfo
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp

@Composable
internal fun SettingsSection(title: String, content: @Composable ColumnScope.() -> Unit) {
    Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
        Text(
            title,
            Modifier.padding(horizontal = 8.dp).semantics { heading() },
            color = MaterialTheme.colorScheme.onSurfaceVariant,
            style = MaterialTheme.typography.labelLarge,
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
) {
    val colors = MaterialTheme.colorScheme
    val muted = colors.onSurfaceVariant
    val expandedText = LocalDensity.current.fontScale > 1.3f
    val action =
        if (onClick == null) Modifier
        else Modifier.clickable(enabled = enabled, role = Role.Button, onClick = onClick)
    Row(
        modifier
            .fillMaxWidth()
            .then(action)
            .heightIn(min = 56.dp)
            .padding(horizontal = 16.dp, vertical = 12.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(12.dp),
    ) {
        leading()
        Column(Modifier.weight(1f)) {
            Text(title, style = MaterialTheme.typography.bodyLarge)
            if (expandedText && value != null)
                Text(value, color = muted, style = MaterialTheme.typography.bodyMedium)
        }
        if (!expandedText && value != null)
            Text(
                value,
                Modifier.widthIn(max = 144.dp),
                color = muted,
                style = MaterialTheme.typography.bodyMedium,
                textAlign = TextAlign.End,
            )
        if (showChevron)
            Icon(
                painterResource(R.drawable.ic_chat_chevron_end),
                contentDescription = null,
                modifier = Modifier.size(16.dp),
                tint = muted,
            )
    }
}

@Composable
internal fun SettingsPickerRow(
    title: String,
    value: String,
    leading: @Composable () -> Unit,
    enabled: Boolean,
    sheet: @Composable (dismiss: () -> Unit) -> Unit,
) {
    var open by remember { mutableStateOf(false) }
    var focused by remember { mutableStateOf(false) }
    var restoreFocus by remember { mutableStateOf(false) }
    val trigger = remember { FocusRequester() }
    SettingsRow(
        title,
        leading,
        value = value,
        onClick = {
            restoreFocus = focused
            open = true
        },
        enabled = enabled,
        modifier = Modifier.focusRequester(trigger).onFocusChanged { focused = it.isFocused },
    )
    if (open) sheet { open = false }
    LaunchedEffect(open, enabled) {
        if (!open && enabled && restoreFocus) {
            restoreFocus = false
            trigger.requestFocus()
        }
    }
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
internal fun SettingsSheet(
    title: String,
    onDismiss: () -> Unit,
    content: @Composable ColumnScope.() -> Unit,
) {
    val windowHeight =
        with(LocalDensity.current) { LocalWindowInfo.current.containerSize.height.toDp() }
    ModalBottomSheet(
        onDismissRequest = onDismiss,
        // Keep the calling page visible above taller, scrollable sheets.
        modifier = Modifier.heightIn(max = windowHeight * 0.84f),
        sheetState = rememberModalBottomSheetState(skipPartiallyExpanded = true),
        sheetMaxWidth = 520.dp,
        containerColor = MaterialTheme.colorScheme.surface,
    ) {
        Column(
            Modifier.fillMaxWidth().padding(bottom = 24.dp),
            verticalArrangement = Arrangement.spacedBy(12.dp),
        ) {
            Text(
                title,
                Modifier.padding(horizontal = 24.dp).semantics { heading() },
                style = MaterialTheme.typography.titleLarge,
            )
            Column(
                Modifier.weight(1f, fill = false)
                    .fillMaxWidth()
                    .verticalScroll(rememberScrollState())
                    .padding(horizontal = 24.dp),
                verticalArrangement = Arrangement.spacedBy(12.dp),
                content = content,
            )
        }
    }
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
            .heightIn(min = 48.dp)
            .clip(RoundedCornerShape(12.dp))
            .then(if (selected) Modifier.background(colors.secondaryContainer) else Modifier)
            .selectable(selected, enabled = enabled, role = Role.RadioButton, onClick = onClick)
            .padding(horizontal = 10.dp, vertical = 8.dp),
        horizontalArrangement = Arrangement.spacedBy(8.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        leading()
        Text(
            label,
            Modifier.weight(1f),
            color = foreground,
            style = MaterialTheme.typography.bodyMedium,
        )
        if (selected)
            Icon(
                painterResource(R.drawable.ic_settings_check),
                contentDescription = null,
                modifier = Modifier.size(16.dp),
                tint = foreground,
            )
    }
}
