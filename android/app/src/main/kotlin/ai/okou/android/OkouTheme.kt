package ai.okou.android

import ai.okou.android.api.generated.UserPreferencesColorTheme
import ai.okou.android.api.generated.UserPreferencesTheme
import androidx.compose.foundation.isSystemInDarkTheme
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Typography
import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.remember
import androidx.compose.runtime.staticCompositionLocalOf
import androidx.compose.ui.text.font.Font
import androidx.compose.ui.text.font.FontFamily

internal val LocalOkouDarkMode = staticCompositionLocalOf { false }

internal fun UserPreferencesTheme.resolveDark(systemDark: Boolean): Boolean =
    when (this) {
        UserPreferencesTheme.SYSTEM -> systemDark
        UserPreferencesTheme.LIGHT -> false
        UserPreferencesTheme.DARK -> true
    }

/** Uses the Android Tonal Spot palette selected by the synced workspace preference. */
@Composable
fun OkouTheme(
    dark: Boolean = isSystemInDarkTheme(),
    palette: UserPreferencesColorTheme = UserPreferencesColorTheme.DEFAULT,
    content: @Composable () -> Unit,
) {
    val colors = remember(dark, palette) { resolvePalette(palette, dark) }
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
            CompositionLocalProvider(LocalOkouDarkMode provides dark, content = content)
        },
    )
}
