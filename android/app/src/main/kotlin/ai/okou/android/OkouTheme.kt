package ai.okou.android

import androidx.compose.foundation.isSystemInDarkTheme
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Typography
import androidx.compose.material3.darkColorScheme
import androidx.compose.material3.lightColorScheme
import androidx.compose.runtime.Composable
import androidx.compose.ui.res.colorResource
import androidx.compose.ui.text.font.Font
import androidx.compose.ui.text.font.FontFamily

/** Colors follow Web semantic roles; Android owns control geometry and interaction. */
@Composable
fun OkouTheme(content: @Composable () -> Unit) {
    val dark = isSystemInDarkTheme()
    val primary = colorResource(R.color.okou_primary)
    val ink = colorResource(R.color.okou_primary_foreground)
    val background = colorResource(R.color.okou_background)
    val foreground = colorResource(R.color.okou_foreground)
    val card = colorResource(R.color.okou_card)
    val muted = colorResource(R.color.okou_muted_foreground)
    val colors =
        if (dark) {
            darkColorScheme(
                primary = primary,
                onPrimary = ink,
                background = background,
                surface = card,
                onBackground = foreground,
                onSurface = foreground,
                onSurfaceVariant = muted,
            )
        } else {
            lightColorScheme(
                primary = primary,
                onPrimary = ink,
                background = background,
                surface = card,
                onBackground = foreground,
                onSurface = foreground,
                onSurfaceVariant = muted,
            )
        }
    val font = FontFamily(Font(R.font.geist))
    val defaults = Typography()
    MaterialTheme(
        colorScheme = colors,
        typography =
            Typography(
                headlineLarge = defaults.headlineLarge.copy(fontFamily = font),
                bodyLarge = defaults.bodyLarge.copy(fontFamily = font),
                bodyMedium = defaults.bodyMedium.copy(fontFamily = font),
                labelLarge = defaults.labelLarge.copy(fontFamily = font),
            ),
        content = content,
    )
}
