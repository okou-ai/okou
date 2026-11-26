package ai.okou.android

import ai.okou.android.api.generated.UserPreferencesColorTheme
import ai.okou.android.api.generated.UserPreferencesLocale
import ai.okou.android.preferences.languageTag
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.compositeOver
import androidx.compose.ui.graphics.luminance
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class PaletteColorsTest {
    @Test
    fun allEightPalettesResolveInBothModesWithReadableTextAndControls() {
        for (dark in listOf(false, true)) {
            val primaries =
                UserPreferencesColorTheme.entries.map { palette ->
                    val colors = resolvePalette(palette, dark)
                    fun check(role: String, foreground: Color, background: Color, minimum: Float) {
                        val brighter = maxOf(foreground.luminance(), background.luminance())
                        val darker = minOf(foreground.luminance(), background.luminance())
                        val ratio = (brighter + 0.05f) / (darker + 0.05f)
                        assertTrue("$palette/$dark $role contrast $ratio", ratio >= minimum)
                    }

                    for (surface in
                        listOf(
                            colors.surface,
                            colors.surfaceContainerLow,
                            colors.surfaceContainerHigh,
                        )) {
                        check("text", colors.onSurface, surface, 4.5f)
                        check("supporting text", colors.onSurfaceVariant, surface, 4.5f)
                        check("action and focused field", colors.primary, surface, 4.5f)
                        check("field outline", colors.outline, surface, 3f)
                        check("error", colors.error, surface, 4.5f)
                    }
                    check("primary action text", colors.onPrimary, colors.primary, 4.5f)
                    check("error container", colors.onErrorContainer, colors.errorContainer, 4.5f)
                    check("Snackbar text", colors.inverseOnSurface, colors.inverseSurface, 4.5f)
                    check("Snackbar action", colors.inversePrimary, colors.inverseSurface, 4.5f)
                    check(
                        "workflow command tag",
                        colors.onTertiaryContainer,
                        colors.tertiaryContainer,
                        4.5f,
                    )
                    check("refresh indicator", colors.primary, colors.secondaryContainer, 3f)
                    check("unchecked switch", colors.outline, colors.surfaceContainerHighest, 3f)
                    check("checked switch", colors.primary, colors.surfaceContainerLow, 3f)
                    assertNotEquals(colors.outline, colors.outlineVariant)

                    // A pressed row adds a ripple over the background and the text.
                    val ripple = colors.onSurface.copy(alpha = 0.10f)
                    for ((background, text) in
                        listOf(
                            colors.surface to colors.onSurface,
                            colors.secondaryContainer to colors.onSecondaryContainer,
                        )) {
                        for (layer in listOf(Color.Transparent, ripple)) {
                            val displayed = layer.compositeOver(background)
                            check("row title", layer.compositeOver(text), displayed, 4.5f)
                            check(
                                "row icon",
                                layer.compositeOver(colors.onSurfaceVariant),
                                displayed,
                                3f,
                            )
                            check("row status", layer.compositeOver(colors.primary), displayed, 3f)
                        }
                    }
                    assertEquals(dark, colors.surface.luminance() < 0.5f)
                    colors.primary
                }
            assertEquals(8, primaries.toSet().size)
        }
    }

    @Test
    fun defaultPaletteUsesThePublishedTonalSpotColorsInBothModes() {
        val light = resolvePalette(UserPreferencesColorTheme.DEFAULT, dark = false)
        val dark = resolvePalette(UserPreferencesColorTheme.DEFAULT, dark = true)
        assertEquals(Color(0xFF815512), light.primary)
        assertEquals(Color(0xFFF7BB70), dark.primary)
        assertEquals(Color(0xFF827568), light.outline)
        assertEquals(Color(0xFF9C8E80), dark.outline)
        assertEquals(Color(0xFFFCDEBC), light.secondaryContainer)
        assertEquals(Color(0xFF57432B), dark.secondaryContainer)
        assertEquals(Color(0xFFBA1A1A), light.error)
        assertEquals(Color(0xFFFFB4AB), dark.error)
    }

    @Test
    fun generatedLocaleNamesPreserveChineseScriptsAndCanonicalLanguageTags() {
        assertEquals("zh-Hans", UserPreferencesLocale.ZH_HANS.languageTag())
        assertEquals("zh-Hant", UserPreferencesLocale.ZH_HANT.languageTag())
        assertEquals("pt-BR", UserPreferencesLocale.PT_BR.languageTag())
        assertEquals("id-ID", UserPreferencesLocale.ID_ID.languageTag())
    }
}
