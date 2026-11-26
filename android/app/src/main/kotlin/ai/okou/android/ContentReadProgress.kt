package ai.okou.android

import androidx.annotation.StringRes
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
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.runtime.snapshotFlow
import androidx.compose.ui.Modifier
import androidx.compose.ui.MotionDurationScale
import androidx.compose.ui.graphics.StrokeCap
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.unit.dp

@Composable
internal fun ContentReadProgress(@StringRes label: Int) {
    val description = stringResource(label)
    val modifier =
        Modifier.fillMaxWidth().height(4.dp).semantics { contentDescription = description }
    var animate by remember { mutableStateOf(false) }
    LaunchedEffect(Unit) {
        val motion = coroutineContext[MotionDurationScale]
        // Android starts its scale observer on first access, before snapshotFlow can read it.
        motion?.scaleFactor
        snapshotFlow { motion?.scaleFactor != 0f }.collect { animate = it }
    }
    if (animate) {
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
