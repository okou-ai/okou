package ai.okou.android

import android.graphics.BlurMaskFilter
import android.graphics.Paint
import androidx.annotation.StringRes
import androidx.compose.foundation.Image
import androidx.compose.foundation.layout.padding
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.drawWithCache
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.ColorFilter
import androidx.compose.ui.graphics.ImageBitmap
import androidx.compose.ui.graphics.asAndroidBitmap
import androidx.compose.ui.graphics.asImageBitmap
import androidx.compose.ui.layout.Layout
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.res.imageResource
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.LiveRegionMode
import androidx.compose.ui.semantics.liveRegion
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.Constraints
import androidx.compose.ui.unit.dp
import androidx.core.graphics.scale
import kotlin.math.roundToInt

internal enum class ContentReadFailureLayout {
    Viewport,
    Section,
    Panel,
}

@Composable
internal fun ContentReadFailure(
    @StringRes message: Int,
    modifier: Modifier = Modifier,
    failureLayout: ContentReadFailureLayout = ContentReadFailureLayout.Viewport,
) {
    val fillViewport = failureLayout == ContentReadFailureLayout.Viewport
    val compact = failureLayout == ContentReadFailureLayout.Panel || isShortWindowHeight()
    val maxArtWidth = if (compact) 112.dp else 160.dp
    val gap = if (compact) 12.dp else 16.dp
    val color = MaterialTheme.colorScheme.onSurface
    val illustration = ImageBitmap.imageResource(R.drawable.okou_load_failed)
    val aspectRatio = illustration.width.toFloat() / illustration.height
    val dark = LocalOkouDarkMode.current
    Layout(
        modifier = modifier.padding(vertical = 16.dp),
        content = {
            Text(
                stringResource(message),
                modifier = Modifier.semantics { liveRegion = LiveRegionMode.Polite },
                color = color,
                style = MaterialTheme.typography.bodyLarge.copy(fontWeight = FontWeight.Medium),
                textAlign = TextAlign.Center,
            )
            Image(
                illustration,
                contentDescription = null,
                modifier =
                    Modifier.testTag("content-read-failure-illustration")
                        .then(
                            if (dark) Modifier.illustrationEdge(illustration, color) else Modifier,
                        ),
            )
        },
    ) { (text, image), constraints ->
        // A scrollable parent can supply the viewport as a minimum height.
        val viewport =
            if (constraints.hasBoundedHeight) constraints.maxHeight else constraints.minHeight
        val label = text.measure(constraints.copy(minWidth = 0, minHeight = 0))
        val gapPx = gap.roundToPx()
        val artWidthLimit =
            if (!fillViewport && !constraints.hasBoundedHeight) maxArtWidth.roundToPx()
            else ((viewport - label.height - gapPx).coerceAtLeast(0) * aspectRatio).toInt()
        val artWidth = minOf(maxArtWidth.roundToPx(), constraints.maxWidth, artWidthLimit)
        val art =
            if (artWidth == 0) null
            else image.measure(Constraints.fixed(artWidth, (artWidth / aspectRatio).roundToInt()))
        val labelOffset = if (art == null) 0 else art.height + gapPx
        val groupHeight = label.height + labelOffset
        val height =
            if (fillViewport) maxOf(viewport, groupHeight)
            else groupHeight.coerceIn(constraints.minHeight, constraints.maxHeight)
        val top = (height - groupHeight) * 2 / 5
        layout(constraints.maxWidth, height) {
            art?.placeRelative((constraints.maxWidth - art.width) / 2, top)
            label.placeRelative((constraints.maxWidth - label.width) / 2, top + labelOffset)
        }
    }
}

private fun Modifier.illustrationEdge(bitmap: ImageBitmap, color: Color): Modifier = drawWithCache {
    // Blur the transparent silhouette at its displayed size to keep the edge one dp wide.
    val scaled = bitmap.asAndroidBitmap().scale(size.width.roundToInt(), size.height.roundToInt())
    val offset = IntArray(2)
    val paint =
        Paint().apply { maskFilter = BlurMaskFilter(1.dp.toPx(), BlurMaskFilter.Blur.NORMAL) }
    val mask = scaled.extractAlpha(paint, offset).asImageBitmap()
    val tint = ColorFilter.tint(color.copy(alpha = 0.38f))
    onDrawWithContent {
        drawImage(mask, Offset(offset[0].toFloat(), offset[1].toFloat()), colorFilter = tint)
        drawContent()
    }
}
