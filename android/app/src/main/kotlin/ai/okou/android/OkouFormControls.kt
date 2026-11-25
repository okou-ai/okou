package ai.okou.android

import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.widthIn
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.minimumInteractiveComponentSize
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.alpha
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.semantics.LiveRegionMode
import androidx.compose.ui.semantics.clearAndSetSemantics
import androidx.compose.ui.semantics.disabled
import androidx.compose.ui.semantics.liveRegion
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp

/** Content spacing shared by Okou's compact editing forms. */
internal object OkouFormLayout {
    val LabelGap = 8.dp
    val FieldPadding = PaddingValues(12.dp)
    val SupportingTextGap = 4.dp
    val GroupGap = 16.dp
    val ActionGap = 8.dp
}

@Composable
internal fun okouFormInputStyle() = MaterialTheme.typography.bodyLarge.copy(letterSpacing = 0.sp)

@Composable
internal fun okouFormSupportingTextHeight() = with(LocalDensity.current) { 16.sp.toDp() }

@Composable
internal fun OkouFormFieldError(message: String?) {
    Box(Modifier.heightIn(min = okouFormSupportingTextHeight())) {
        if (message != null) {
            Text(
                message,
                style =
                    MaterialTheme.typography.bodySmall.copy(fontSize = 12.sp, lineHeight = 16.sp),
            )
        }
    }
}

internal enum class OkouActionTreatment {
    Primary,
    Outline,
    Text,
}

@Composable
internal fun OkouActionButton(
    label: String,
    onClick: () -> Unit,
    modifier: Modifier = Modifier,
    enabled: Boolean = true,
    treatment: OkouActionTreatment = OkouActionTreatment.Primary,
    layoutLabels: List<String> = emptyList(),
    retainDisabledFocus: Boolean = false,
) {
    val colors = MaterialTheme.colorScheme
    val shape = MaterialTheme.shapes.medium
    val size = modifier.minimumInteractiveComponentSize().heightIn(min = 48.dp)
    val padding = PaddingValues(horizontal = 12.dp, vertical = 8.dp)
    val style =
        MaterialTheme.typography.bodySmall.copy(
            fontSize = 13.sp,
            lineHeight = 20.sp,
            letterSpacing = 0.sp,
            fontWeight = FontWeight(550),
        )
    val text: @Composable () -> Unit = {
        if (layoutLabels.isEmpty()) Text(label, style = style)
        else
            Box(contentAlignment = Alignment.Center) {
                for (layoutLabel in layoutLabels) {
                    Text(
                        layoutLabel,
                        Modifier.clearAndSetSemantics {}.alpha(0f),
                        style = style,
                    )
                }
                Text(label, style = style)
            }
    }
    when (treatment) {
        OkouActionTreatment.Text ->
            TextButton(
                onClick,
                size,
                enabled,
                shape = shape,
                colors = ButtonDefaults.textButtonColors(contentColor = colors.onSurface),
                contentPadding = padding,
                content = { text() },
            )
        OkouActionTreatment.Outline ->
            OutlinedButton(
                onClick,
                size,
                enabled,
                shape = shape,
                colors = ButtonDefaults.outlinedButtonColors(contentColor = colors.onSurface),
                border = BorderStroke(1.dp, colors.outline),
                contentPadding = padding,
                content = { text() },
            )
        OkouActionTreatment.Primary ->
            Button(
                onClick = { if (enabled) onClick() },
                modifier =
                    if (retainDisabledFocus)
                        size.semantics {
                            disabled()
                            liveRegion = LiveRegionMode.Polite
                        }
                    else size,
                enabled = enabled || retainDisabledFocus,
                shape = shape,
                colors =
                    ButtonDefaults.buttonColors(
                        containerColor =
                            if (retainDisabledFocus) colors.surfaceVariant
                            else colors.inverseSurface,
                        contentColor =
                            if (retainDisabledFocus) colors.onSurfaceVariant
                            else colors.inverseOnSurface,
                        disabledContainerColor = colors.surfaceVariant,
                        disabledContentColor = colors.onSurfaceVariant,
                    ),
                contentPadding = padding,
                content = { text() },
            )
    }
}

@Composable
internal fun OkouFormActions(
    cancelLabel: String,
    confirmLabel: String?,
    cancel: () -> Unit,
    confirm: () -> Unit,
    confirmEnabled: Boolean,
    modifier: Modifier = Modifier,
    cancelEnabled: Boolean = true,
    confirmLayoutLabels: List<String> = emptyList(),
    confirmMinWidth: Dp = 0.dp,
    keepConfirmFocusWhilePending: Boolean = false,
) {
    FlowRow(
        Modifier.fillMaxWidth().then(modifier),
        horizontalArrangement = Arrangement.spacedBy(OkouFormLayout.ActionGap, Alignment.End),
        verticalArrangement = Arrangement.spacedBy(OkouFormLayout.ActionGap),
    ) {
        OkouActionButton(
            cancelLabel,
            cancel,
            enabled = cancelEnabled,
            treatment = OkouActionTreatment.Text,
        )
        if (confirmLabel != null) {
            OkouActionButton(
                confirmLabel,
                confirm,
                modifier = Modifier.widthIn(min = confirmMinWidth),
                enabled = confirmEnabled,
                layoutLabels = confirmLayoutLabels,
                retainDisabledFocus = keepConfirmFocusWhilePending,
            )
        }
    }
}
