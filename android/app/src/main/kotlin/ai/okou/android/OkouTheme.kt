package ai.okou.android

import ai.okou.android.api.generated.UserPreferencesColorTheme
import android.content.Context
import android.content.res.Configuration
import android.util.TypedValue
import android.view.ContextThemeWrapper
import androidx.compose.foundation.isSystemInDarkTheme
import androidx.compose.foundation.text.selection.LocalTextSelectionColors
import androidx.compose.foundation.text.selection.TextSelectionColors
import androidx.compose.material3.ColorScheme
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
fun OkouTheme(
    dark: Boolean = isSystemInDarkTheme(),
    palette: UserPreferencesColorTheme = UserPreferencesColorTheme.DEFAULT,
    content: @Composable () -> Unit,
) {
    val context = LocalContext.current
    val configuration = LocalConfiguration.current
    val resolved =
        remember(context, configuration, dark, palette) { resolvePalette(context, dark, palette) }
    val colors = resolved.scheme
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
                        backgroundColor = resolved.selection,
                    ),
                content = content,
            )
        },
    )
}

internal data class PaletteColors(val scheme: ColorScheme, val selection: Color)

/** The wrapper is used only for color lookup; native controls keep the real Activity context. */
internal fun resolvePalette(
    context: Context,
    dark: Boolean,
    palette: UserPreferencesColorTheme,
): PaletteColors {
    val configuration =
        Configuration(context.resources.configuration).apply {
            uiMode =
                (uiMode and Configuration.UI_MODE_NIGHT_MASK.inv()) or
                    if (dark) Configuration.UI_MODE_NIGHT_YES else Configuration.UI_MODE_NIGHT_NO
        }
    val style =
        when (palette) {
            UserPreferencesColorTheme.DEFAULT -> R.style.OkouPalette_default
            UserPreferencesColorTheme.GOLDEN_HOUR -> R.style.OkouPalette_golden_hour
            UserPreferencesColorTheme.CITRUS_SPARK -> R.style.OkouPalette_citrus_spark
            UserPreferencesColorTheme.BERRY_BLUSH -> R.style.OkouPalette_berry_blush
            UserPreferencesColorTheme.COTTON_SKY -> R.style.OkouPalette_cotton_sky
            UserPreferencesColorTheme.BLUE_HORIZON -> R.style.OkouPalette_blue_horizon
            UserPreferencesColorTheme.DAYDREAM -> R.style.OkouPalette_daydream
            UserPreferencesColorTheme.DEEP_LAGOON -> R.style.OkouPalette_deep_lagoon
        }
    val themed = ContextThemeWrapper(context.createConfigurationContext(configuration), style)
    fun role(id: Int): Color {
        val value = TypedValue()
        check(themed.theme.resolveAttribute(id, value, true)) { "Missing generated palette role" }
        check(value.type in TypedValue.TYPE_FIRST_COLOR_INT..TypedValue.TYPE_LAST_COLOR_INT)
        return Color(value.data)
    }
    val colors =
        (if (dark) darkColorScheme() else lightColorScheme()).copy(
            primary = role(R.attr.okou_palette_primary),
            onPrimary = role(R.attr.okou_palette_primary_foreground),
            primaryContainer = role(R.attr.okou_palette_accent),
            onPrimaryContainer = role(R.attr.okou_palette_accent_foreground),
            secondary = role(R.attr.okou_palette_foreground),
            onSecondary = role(R.attr.okou_palette_background),
            secondaryContainer = role(R.attr.okou_palette_accent),
            onSecondaryContainer = role(R.attr.okou_palette_accent_foreground),
            tertiary = role(R.attr.okou_palette_primary),
            onTertiary = role(R.attr.okou_palette_primary_foreground),
            tertiaryContainer = role(R.attr.okou_palette_muted),
            onTertiaryContainer = role(R.attr.okou_palette_foreground),
            background = role(R.attr.okou_palette_background),
            onBackground = role(R.attr.okou_palette_foreground),
            surface = role(R.attr.okou_palette_card),
            onSurface = role(R.attr.okou_palette_card_foreground),
            surfaceVariant = role(R.attr.okou_palette_muted),
            onSurfaceVariant = role(R.attr.okou_palette_muted_foreground),
            surfaceTint = role(R.attr.okou_palette_primary),
            surfaceContainerLowest = role(R.attr.okou_palette_background),
            surfaceContainerLow = role(R.attr.okou_palette_card),
            surfaceContainer = role(R.attr.okou_palette_muted),
            surfaceContainerHigh = role(R.attr.okou_palette_muted),
            surfaceContainerHighest = role(R.attr.okou_palette_muted),
            outline = role(R.attr.okou_palette_border),
            outlineVariant = role(R.attr.okou_palette_border),
            error = role(R.attr.okou_palette_destructive),
            onError = role(R.attr.okou_palette_destructive_foreground),
            errorContainer = role(R.attr.okou_palette_muted),
            onErrorContainer = role(R.attr.okou_palette_destructive),
            inverseSurface = role(R.attr.okou_palette_foreground),
            inverseOnSurface = role(R.attr.okou_palette_background),
            inversePrimary = role(R.attr.okou_palette_primary),
        )
    return PaletteColors(colors, role(R.attr.okou_palette_selection))
}
