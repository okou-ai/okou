package ai.okou.android

import android.content.res.Configuration
import androidx.compose.foundation.isSystemInDarkTheme
import androidx.compose.foundation.text.selection.LocalTextSelectionColors
import androidx.compose.foundation.text.selection.TextSelectionColors
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Typography
import androidx.compose.material3.darkColorScheme
import androidx.compose.material3.lightColorScheme
import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.remember
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalConfiguration
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.Font
import androidx.compose.ui.text.font.FontFamily

/** Colors follow Web semantic roles; Android owns control geometry and interaction. */
@Composable
fun OkouTheme(dark: Boolean = isSystemInDarkTheme(), content: @Composable () -> Unit) {
    val context = LocalContext.current
    val configuration = LocalConfiguration.current
    // Read the selected resource qualifiers without replacing the Activity or its native owners.
    val resources =
        remember(context, configuration, dark) {
            val themed =
                Configuration(configuration).apply {
                    uiMode =
                        (uiMode and Configuration.UI_MODE_NIGHT_MASK.inv()) or
                            if (dark) Configuration.UI_MODE_NIGHT_YES
                            else Configuration.UI_MODE_NIGHT_NO
                }
            context.createConfigurationContext(themed).resources
        }
    fun role(id: Int) = Color(resources.getColor(id, null))
    val defaults = if (dark) darkColorScheme() else lightColorScheme()
    val colors =
        defaults.copy(
            primary = role(R.color.okou_primary),
            onPrimary = role(R.color.okou_primary_foreground),
            primaryContainer = role(R.color.okou_accent),
            onPrimaryContainer = role(R.color.okou_accent_foreground),
            secondary = role(R.color.okou_foreground),
            onSecondary = role(R.color.okou_background),
            secondaryContainer = role(R.color.okou_accent),
            onSecondaryContainer = role(R.color.okou_accent_foreground),
            tertiary = role(R.color.okou_primary),
            onTertiary = role(R.color.okou_primary_foreground),
            tertiaryContainer = role(R.color.okou_muted),
            onTertiaryContainer = role(R.color.okou_foreground),
            background = role(R.color.okou_background),
            onBackground = role(R.color.okou_foreground),
            surface = role(R.color.okou_card),
            onSurface = role(R.color.okou_card_foreground),
            surfaceVariant = role(R.color.okou_muted),
            onSurfaceVariant = role(R.color.okou_muted_foreground),
            surfaceTint = role(R.color.okou_primary),
            surfaceContainerLowest = role(R.color.okou_background),
            surfaceContainerLow = role(R.color.okou_card),
            surfaceContainer = role(R.color.okou_muted),
            surfaceContainerHigh = role(R.color.okou_muted),
            surfaceContainerHighest = role(R.color.okou_muted),
            outline = role(R.color.okou_border),
            outlineVariant = role(R.color.okou_border),
            error = role(R.color.okou_destructive),
            onError = role(R.color.okou_destructive_foreground),
            errorContainer = role(R.color.okou_muted),
            onErrorContainer = role(R.color.okou_destructive),
            inverseSurface = role(R.color.okou_foreground),
            inverseOnSurface = role(R.color.okou_background),
            inversePrimary = role(R.color.okou_primary),
        )
    val font = remember { FontFamily(Font(R.font.geist)) }
    val typography = remember { Typography() }
    MaterialTheme(
        colorScheme = colors,
        typography =
            Typography(
                displayLarge = typography.displayLarge.copy(fontFamily = font),
                displayMedium = typography.displayMedium.copy(fontFamily = font),
                displaySmall = typography.displaySmall.copy(fontFamily = font),
                headlineLarge = typography.headlineLarge.copy(fontFamily = font),
                headlineMedium = typography.headlineMedium.copy(fontFamily = font),
                headlineSmall = typography.headlineSmall.copy(fontFamily = font),
                titleLarge = typography.titleLarge.copy(fontFamily = font),
                titleMedium = typography.titleMedium.copy(fontFamily = font),
                titleSmall = typography.titleSmall.copy(fontFamily = font),
                bodyLarge = typography.bodyLarge.copy(fontFamily = font),
                bodyMedium = typography.bodyMedium.copy(fontFamily = font),
                bodySmall = typography.bodySmall.copy(fontFamily = font),
                labelLarge = typography.labelLarge.copy(fontFamily = font),
                labelMedium = typography.labelMedium.copy(fontFamily = font),
                labelSmall = typography.labelSmall.copy(fontFamily = font),
            ),
        content = {
            CompositionLocalProvider(
                LocalTextSelectionColors provides
                    TextSelectionColors(
                        handleColor = colors.onSurface,
                        backgroundColor = colors.primary.copy(alpha = 0.25f),
                    ),
                content = content,
            )
        },
    )
}
