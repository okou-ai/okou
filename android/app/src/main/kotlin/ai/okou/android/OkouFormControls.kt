package ai.okou.android

import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.widthIn
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.Icon
import androidx.compose.material3.LocalContentColor
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextFieldDefaults
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.minimumInteractiveComponentSize
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.alpha
import androidx.compose.ui.focus.onFocusChanged
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.semantics.LiveRegionMode
import androidx.compose.ui.semantics.clearAndSetSemantics
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.disabled
import androidx.compose.ui.semantics.liveRegion
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.AnnotatedString
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.rememberTextMeasurer
import androidx.compose.ui.text.style.LineHeightStyle
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.Constraints
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

// Compose Material 3 adds 4 dp below and on either side of an above-field label.
internal val NativeAboveLabelPadding = 4.dp

@Composable
internal fun OkouOutlinedSelectionField(
    label: String,
    value: String,
    modifier: Modifier = Modifier,
    enabled: Boolean = true,
    icon: Int = R.drawable.ic_expand_more,
    onClick: () -> Unit,
) {
    val colors = MaterialTheme.colorScheme
    var focused by remember { mutableStateOf(false) }
    Column(verticalArrangement = Arrangement.spacedBy(NativeAboveLabelPadding)) {
        Text(
            label,
            Modifier.padding(horizontal = NativeAboveLabelPadding),
            color =
                when {
                    !enabled -> colors.onSurface.copy(alpha = 0.38f)
                    focused -> colors.primary
                    else -> colors.onSurfaceVariant
                },
            style = MaterialTheme.typography.bodySmall,
        )
        OutlinedButton(
            onClick,
            modifier
                .fillMaxWidth()
                .heightIn(min = OutlinedTextFieldDefaults.MinHeight)
                .onFocusChanged { focused = it.isFocused }
                .semantics { contentDescription = label },
            enabled = enabled,
            shape = OutlinedTextFieldDefaults.shape,
            colors = ButtonDefaults.outlinedButtonColors(contentColor = colors.onSurface),
            border =
                when {
                    !enabled -> BorderStroke(1.dp, colors.onSurface.copy(alpha = 0.12f))
                    focused -> BorderStroke(2.dp, colors.primary)
                    else -> BorderStroke(1.dp, colors.outline)
                },
            contentPadding = OutlinedTextFieldDefaults.contentPaddingWithoutLabel(),
        ) {
            Text(value, Modifier.weight(1f), style = MaterialTheme.typography.bodyLarge)
            Spacer(Modifier.size(8.dp))
            Icon(
                painterResource(icon),
                contentDescription = null,
                modifier = Modifier.size(20.dp),
                tint = if (enabled) colors.onSurfaceVariant else LocalContentColor.current,
            )
        }
    }
}

@Composable
internal fun OkouFormLabel(label: String) {
    Text(
        label,
        Modifier.padding(bottom = OkouFormLayout.LabelGap - NativeAboveLabelPadding),
        style = MaterialTheme.typography.bodyMedium,
    )
}

@Composable
internal fun okouFormLabelHeight(
    label: String,
    fieldWidth: Int,
    style: TextStyle = MaterialTheme.typography.bodyMedium,
    gap: Dp = OkouFormLayout.LabelGap,
): Dp {
    val measurer = rememberTextMeasurer()
    return with(LocalDensity.current) {
        val textWidth = (fieldWidth - NativeAboveLabelPadding.roundToPx() * 2).coerceAtLeast(1)
        measurer
            .measure(label, style, constraints = Constraints(maxWidth = textWidth))
            .size
            .height
            .toDp() + gap
    }
}

@Composable
internal fun okouFormSupportingTextHeight() = with(LocalDensity.current) { 16.sp.toDp() }

@Composable
internal fun okouFormSupportingTextStyle() =
    MaterialTheme.typography.bodySmall.copy(
        fontSize = 12.sp,
        lineHeight = 16.sp,
        lineHeightStyle =
            LineHeightStyle(LineHeightStyle.Alignment.Center, LineHeightStyle.Trim.None),
    )

@Composable
internal fun okouFormSupportingLineHeight(reference: String): Dp {
    val style = okouFormSupportingTextStyle()
    val measurer = rememberTextMeasurer()
    return with(LocalDensity.current) {
        measurer
            .measure(AnnotatedString(reference), style, softWrap = false, maxLines = 1)
            .size
            .height
            .toDp()
            .coerceAtLeast(style.lineHeight.toDp())
    }
}

@Composable
internal fun OkouFormFieldSupport(
    message: String?,
    color: Color,
    modifier: Modifier = Modifier,
) {
    Box(modifier.heightIn(min = okouFormSupportingTextHeight())) {
        if (message != null) {
            Text(
                message,
                Modifier.semantics { liveRegion = LiveRegionMode.Polite },
                color = color,
                style = okouFormSupportingTextStyle(),
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
    useMaterialButtonDefaults: Boolean = false,
) {
    val size =
        if (useMaterialButtonDefaults) modifier
        else modifier.minimumInteractiveComponentSize().heightIn(min = 48.dp)
    val padding =
        when {
            !useMaterialButtonDefaults -> PaddingValues(horizontal = 12.dp, vertical = 8.dp)
            treatment == OkouActionTreatment.Text -> ButtonDefaults.TextButtonContentPadding
            else -> ButtonDefaults.ContentPadding
        }
    val style = MaterialTheme.typography.labelLarge
    val text: @Composable () -> Unit = {
        if (layoutLabels.isEmpty()) Text(label, style = style, textAlign = TextAlign.Center)
        else
            Box(contentAlignment = Alignment.Center) {
                for (layoutLabel in layoutLabels) {
                    Text(
                        layoutLabel,
                        Modifier.clearAndSetSemantics {}.alpha(0f),
                        style = style,
                        textAlign = TextAlign.Center,
                    )
                }
                Text(label, style = style, textAlign = TextAlign.Center)
            }
    }
    when (treatment) {
        OkouActionTreatment.Text ->
            TextButton(
                onClick,
                size,
                enabled,
                contentPadding = padding,
                content = { text() },
            )
        OkouActionTreatment.Outline ->
            OutlinedButton(
                onClick,
                size,
                enabled,
                contentPadding = padding,
                content = { text() },
            )
        OkouActionTreatment.Primary -> {
            val defaults = ButtonDefaults.buttonColors()
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
                colors =
                    if (retainDisabledFocus)
                        defaults.copy(
                            containerColor = defaults.disabledContainerColor,
                            contentColor = defaults.disabledContentColor,
                        )
                    else defaults,
                contentPadding = padding,
                content = { text() },
            )
        }
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
    useMaterialButtonDefaults: Boolean = false,
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
            useMaterialButtonDefaults = useMaterialButtonDefaults,
        )
        if (confirmLabel != null) {
            OkouActionButton(
                confirmLabel,
                confirm,
                modifier = Modifier.widthIn(min = confirmMinWidth),
                enabled = confirmEnabled,
                layoutLabels = confirmLayoutLabels,
                retainDisabledFocus = keepConfirmFocusWhilePending,
                useMaterialButtonDefaults = useMaterialButtonDefaults,
            )
        }
    }
}
