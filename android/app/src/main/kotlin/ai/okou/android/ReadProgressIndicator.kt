package ai.okou.android

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.progressSemantics
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.LinearProgressIndicator
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.runtime.snapshotFlow
import androidx.compose.ui.Modifier
import androidx.compose.ui.MotionDurationScale
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.StrokeCap
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.unit.dp

private val progressShape = RoundedCornerShape(2.dp)

@Composable
internal fun ReadProgressIndicator(description: String, color: Color, trackColor: Color) {
    val modifier =
        Modifier.fillMaxWidth().height(4.dp).semantics { contentDescription = description }
    var animate by remember { mutableStateOf(false) }
    LaunchedEffect(Unit) {
        val motion = coroutineContext[MotionDurationScale]
        snapshotFlow { motion?.scaleFactor != 0f }.collect { animate = it }
    }
    if (animate) {
        LinearProgressIndicator(
            modifier = modifier.clip(progressShape),
            color = color,
            trackColor = trackColor,
            strokeCap = StrokeCap.Round,
        )
    } else {
        Box(modifier.progressSemantics().background(trackColor, progressShape)) {
            Box(Modifier.fillMaxWidth(0.3f).fillMaxHeight().background(color, progressShape))
        }
    }
}
