package ai.okou.android.connectors

import ai.okou.android.LocalOkouDarkMode
import androidx.compose.animation.core.CubicBezierEasing
import androidx.compose.animation.core.animateFloatAsState
import androidx.compose.animation.core.tween
import androidx.compose.foundation.Image
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.MaterialTheme
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.key
import androidx.compose.runtime.remember
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clipToBounds
import androidx.compose.ui.graphics.ColorFilter
import androidx.compose.ui.graphics.ColorMatrix
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import coil3.compose.AsyncImagePainter
import coil3.compose.LocalPlatformContext
import coil3.compose.rememberAsyncImagePainter
import coil3.decode.DataSource
import coil3.request.CachePolicy
import coil3.request.ImageRequest

private val connectorIconEaseOut = CubicBezierEasing(0f, 0f, 0.58f, 1f)
private val connectorIconInversion =
    ColorFilter.colorMatrix(
        ColorMatrix().apply {
            setToScale(-1f, -1f, -1f, 1f)
            this[0, 4] = 255f
            this[1, 4] = 255f
            this[2, 4] = 255f
        }
    )

@Composable
internal fun ConnectorIcon(
    icon: ConnectorBrandIcon?,
    large: Boolean,
    modifier: Modifier = Modifier,
) {
    Box(
        modifier
            .size(if (large) 48.dp else 40.dp)
            .background(MaterialTheme.colorScheme.surfaceVariant, RoundedCornerShape(12.dp)),
        contentAlignment = Alignment.Center,
    ) {
        if (icon != null)
            key(icon.url) {
                val context = LocalPlatformContext.current
                // Both surfaces use one decode sized for the 24dp detail mark at the maximum scale.
                val edge = with(LocalDensity.current) { 72.dp.roundToPx() }
                val request =
                    remember(context, icon.url, edge) {
                        ImageRequest.Builder(context)
                            .data(icon.url.toString())
                            .size(edge)
                            .decoderFactory(connectorSvgDecoder)
                            .diskCachePolicy(CachePolicy.DISABLED)
                            .build()
                    }
                val painter = rememberAsyncImagePainter(request)
                val loadState by painter.state.collectAsStateWithLifecycle()
                val result = (loadState as? AsyncImagePainter.State.Success)?.result
                val cached = result?.dataSource == DataSource.MEMORY_CACHE
                val invert = icon.invertInDarkMode && LocalOkouDarkMode.current
                val opacity by
                    animateFloatAsState(
                        targetValue = if (result != null && !cached) 1f else 0f,
                        animationSpec = tween(durationMillis = 150, easing = connectorIconEaseOut),
                    )
                Image(
                    painter = painter,
                    contentDescription = null,
                    modifier =
                        Modifier.size(if (large) 24.dp else 20.dp).clipToBounds().graphicsLayer {
                            scaleX = icon.scale
                            scaleY = icon.scale
                            alpha = if (cached) 1f else opacity
                        },
                    colorFilter = connectorIconInversion.takeIf { invert },
                    contentScale = ContentScale.Fit,
                )
            }
    }
}
