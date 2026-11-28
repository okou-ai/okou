package ai.okou.android

import androidx.annotation.StringRes
import androidx.compose.animation.core.Animatable
import androidx.compose.animation.core.CubicBezierEasing
import androidx.compose.animation.core.tween
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.progressSemantics
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.LinearProgressIndicator
import androidx.compose.material3.ProgressIndicatorDefaults
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.derivedStateOf
import androidx.compose.runtime.getValue
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.ui.Modifier
import androidx.compose.ui.MotionDurationScale
import androidx.compose.ui.graphics.StrokeCap
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.clearAndSetSemantics
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.hideFromAccessibility
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.unit.dp

private val ReadProgressEnter = tween<Float>(150, easing = CubicBezierEasing(0f, 0f, 0f, 1f))
private val ReadProgressExit = tween<Float>(150, easing = CubicBezierEasing(0.3f, 0f, 1f, 1f))

@Composable
internal fun ContentReadProgress(
    @StringRes label: Int,
    visible: Boolean,
    modifier: Modifier = Modifier,
) {
    val opacity = remember { Animatable(0f) }
    val hasOpacity by remember { derivedStateOf { opacity.value > 0f } }
    if (!visible && !hasOpacity) return

    val motion = rememberCoroutineScope().coroutineContext[MotionDurationScale]
    val reducedMotion = motion?.scaleFactor == 0f
    LaunchedEffect(visible, reducedMotion) {
        val target = if (visible) 1f else 0f
        if (opacity.value == target) return@LaunchedEffect
        // Keep the tween when retargeting. AnimatedVisibility switches to a spring on interruption.
        if (reducedMotion) opacity.snapTo(target)
        else opacity.animateTo(target, if (visible) ReadProgressEnter else ReadProgressExit)
    }
    if (!visible && reducedMotion) return

    Box(if (reducedMotion) modifier else modifier.graphicsLayer { alpha = opacity.value }) {
        ReadProgressIndicator(label, announce = visible, animated = !reducedMotion)
    }
}

@Composable
private fun ReadProgressIndicator(@StringRes label: Int, announce: Boolean, animated: Boolean) {
    val bounds = Modifier.fillMaxWidth().height(4.dp)
    val modifier =
        if (announce) {
            val description = stringResource(label)
            bounds.semantics { contentDescription = description }
        } else {
            bounds.clearAndSetSemantics { hideFromAccessibility() }
        }
    if (animated) {
        LinearProgressIndicator(
            modifier = modifier,
            strokeCap = StrokeCap.Round,
        )
    } else {
        val shape = RoundedCornerShape(2.dp)
        Box(
            modifier
                .progressSemantics()
                .background(ProgressIndicatorDefaults.linearTrackColor, shape),
        ) {
            Box(
                Modifier.fillMaxWidth(0.3f)
                    .fillMaxHeight()
                    .background(ProgressIndicatorDefaults.linearColor, shape),
            )
        }
    }
}
