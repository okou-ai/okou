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
                displayLarge = defaults.displayLarge.copy(fontFamily = font),
                displayMedium = defaults.displayMedium.copy(fontFamily = font),
                displaySmall = defaults.displaySmall.copy(fontFamily = font),
                headlineLarge = defaults.headlineLarge.copy(fontFamily = font),
                headlineMedium = defaults.headlineMedium.copy(fontFamily = font),
                headlineSmall = defaults.headlineSmall.copy(fontFamily = font),
                titleLarge = defaults.titleLarge.copy(fontFamily = font),
                titleMedium = defaults.titleMedium.copy(fontFamily = font),
                titleSmall = defaults.titleSmall.copy(fontFamily = font),
                bodyLarge = defaults.bodyLarge.copy(fontFamily = font),
                bodyMedium = defaults.bodyMedium.copy(fontFamily = font),
                bodySmall = defaults.bodySmall.copy(fontFamily = font),
                labelLarge = defaults.labelLarge.copy(fontFamily = font),
                labelMedium = defaults.labelMedium.copy(fontFamily = font),
                labelSmall = defaults.labelSmall.copy(fontFamily = font),
            ),
        content = content,
    )
}
