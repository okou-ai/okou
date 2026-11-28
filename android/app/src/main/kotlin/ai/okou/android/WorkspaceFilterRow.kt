package ai.okou.android

import androidx.compose.foundation.ExperimentalFoundationApi
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.gestures.BringIntoViewSpec
import androidx.compose.foundation.gestures.LocalBringIntoViewSpec
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.relocation.BringIntoViewRequester
import androidx.compose.foundation.relocation.bringIntoViewRequester
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.selection.selectable
import androidx.compose.foundation.selection.selectableGroup
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.FilterChipDefaults
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberUpdatedState
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.draw.drawWithContent
import androidx.compose.ui.focus.focusProperties
import androidx.compose.ui.focus.onFocusChanged
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.input.InputMode
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.platform.LocalInputModeManager
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.unit.LayoutDirection
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp

@OptIn(ExperimentalFoundationApi::class)
@Composable
internal fun <T : Any> WorkspaceFilterRow(
    options: List<T>,
    selected: T,
    role: Role,
    label: @Composable (T) -> String,
    modifier: Modifier = Modifier,
    optionModifier: (T) -> Modifier = { Modifier },
    enabled: Boolean = true,
    onSelect: (T) -> Unit,
) {
    val colors = MaterialTheme.colorScheme
    val disabledColors = if (enabled) null else FilterChipDefaults.filterChipColors()
    val keyboardFocus = LocalInputModeManager.current.inputMode == InputMode.Keyboard
    val shape = RoundedCornerShape(12.dp)
    val scroll = rememberScrollState()
    val reveal = remember(options) { options.associateWith { BringIntoViewRequester() } }
    var focused by remember { mutableStateOf<T?>(null) }
    val fade = with(LocalDensity.current) { 16.dp.toPx() }
    val defaultSpec = LocalBringIntoViewSpec.current
    val revealEnabled by rememberUpdatedState(enabled)
    val revealSpec =
        remember(defaultSpec, scroll, fade) {
            object : BringIntoViewSpec by defaultSpec {
                override fun calculateScrollDistance(
                    offset: Float,
                    size: Float,
                    containerSize: Float,
                ): Float {
                    if (!revealEnabled || scroll.maxValue == 0) return 0f
                    val margin = ((containerSize - size) / 2).coerceIn(0f, fade)
                    return defaultSpec.calculateScrollDistance(
                        offset - margin,
                        size + 2 * margin,
                        containerSize,
                    )
                }
            }
        }
    val visibleOption = focused ?: selected
    // Keep the user's offset when an adjacent pane toggles whether the filters are available.
    LaunchedEffect(visibleOption, scroll.maxValue) {
        if (revealEnabled) reveal.getValue(visibleOption).bringIntoView()
    }
    CompositionLocalProvider(LocalBringIntoViewSpec provides revealSpec) {
        Row(
            modifier
                .drawWithContent {
                    drawContent()
                    val rtl = layoutDirection == LayoutDirection.Rtl
                    val background = colors.background
                    val transparent = background.copy(alpha = 0f)
                    if (if (rtl) scroll.canScrollForward else scroll.canScrollBackward) {
                        drawRect(
                            Brush.horizontalGradient(listOf(background, transparent), endX = fade),
                            size = Size(fade, size.height),
                        )
                    }
                    if (if (rtl) scroll.canScrollBackward else scroll.canScrollForward) {
                        val x = size.width - fade
                        drawRect(
                            Brush.horizontalGradient(listOf(transparent, background), startX = x),
                            topLeft = Offset(x, 0f),
                            size = Size(fade, size.height),
                        )
                    }
                }
                .horizontalScroll(scroll, enabled = enabled)
                .selectableGroup(),
            horizontalArrangement = Arrangement.spacedBy(6.dp),
        ) {
            for (option in options) {
                val checked = option == selected
                val container =
                    if (checked)
                        disabledColors?.disabledSelectedContainerColor ?: colors.secondaryContainer
                    else colors.background
                val content =
                    disabledColors?.disabledLabelColor
                        ?: if (checked) colors.onSecondaryContainer else colors.onSurface
                Box(
                    Modifier.widthIn(min = 48.dp)
                        .heightIn(min = 48.dp)
                        .clip(shape)
                        .then(optionModifier(option))
                        .focusProperties { canFocus = enabled }
                        .background(container)
                        .then(
                            if (keyboardFocus && focused == option)
                                Modifier.border(2.dp, colors.onBackground, shape)
                            else Modifier,
                        )
                        .bringIntoViewRequester(reveal.getValue(option))
                        .onFocusChanged {
                            if (it.isFocused) focused = option
                            else if (focused == option) focused = null
                        }
                        .selectable(checked, enabled = enabled, role = role) { onSelect(option) }
                        .padding(horizontal = 8.dp, vertical = 8.dp),
                    contentAlignment = Alignment.Center,
                ) {
                    Text(
                        label(option),
                        style =
                            MaterialTheme.typography.bodyMedium.copy(
                                fontSize = 13.sp,
                                lineHeight = 20.sp,
                                letterSpacing = 0.sp,
                            ),
                        color = content,
                    )
                }
            }
        }
    }
}
