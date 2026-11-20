package ai.okou.android.screenshots

import ai.okou.android.MainActivity
import ai.okou.android.R
import ai.okou.android.ScreenshotCapture
import ai.okou.android.TestOkouApplication
import ai.okou.android.awaitChatList
import androidx.test.core.app.ActivityScenario
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import androidx.test.uiautomator.By
import androidx.test.uiautomator.BySelector
import androidx.test.uiautomator.UiDevice
import androidx.test.uiautomator.Until
import org.junit.Test
import org.junit.runner.RunWith

@RunWith(AndroidJUnit4::class)
class ScreenshotScenario {
    private val instrumentation = InstrumentationRegistry.getInstrumentation()
    private val app = instrumentation.targetContext.applicationContext as TestOkouApplication
    private val device = UiDevice.getInstance(instrumentation)

    @Test
    fun captureLightAndDarkPalettePicker() {
        val preferences = app.snapshotApiPreferences()
        try {
            ActivityScenario.launch(MainActivity::class.java).use {
                device.awaitChatList(app)
                visible(By.desc(app.getString(R.string.settings))).click()
                capture(R.string.appearance_light, "theme-light.png")
                capture(R.string.appearance_dark, "theme-dark.png")
            }
        } finally {
            app.restoreApiPreferences(preferences)
        }
    }

    private fun capture(appearance: Int, name: String) {
        val appearanceRow = row(R.string.appearance)
        visible(appearanceRow).click()
        visible(option(appearance)).click()
        check(device.wait(Until.gone(option(appearance)), 10_000))
        visible(appearanceRow.hasDescendant(label(appearance)))
        visible(row(R.string.preference_color_theme)).click()
        visible(option(R.string.palette_default).checked(true))
        visible(option(R.string.palette_deep_lagoon))
        device.waitForIdle()
        ScreenshotCapture.capture(name)
        check(device.pressBack())
        check(device.wait(Until.gone(option(R.string.palette_default)), 10_000))
    }

    private fun label(id: Int) = By.pkg(app.packageName).text(app.getString(id))

    private fun row(id: Int) =
        By.pkg(app.packageName)
            .clickable(true)
            .checkable(false)
            .enabled(true)
            .hasDescendant(label(id))

    private fun option(id: Int) =
        By.pkg(app.packageName).checkable(true).enabled(true).hasDescendant(label(id))

    private fun visible(selector: BySelector) =
        requireNotNull(device.wait(Until.findObject(selector), 10_000)) {
            "Native setting is not visible: $selector"
        }
}
