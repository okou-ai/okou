package ai.okou.android.screenshots

import ai.okou.android.R
import ai.okou.android.ScreenshotCapture
import android.graphics.drawable.AdaptiveIconDrawable
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import androidx.test.uiautomator.By
import androidx.test.uiautomator.UiDevice
import androidx.test.uiautomator.Until
import org.junit.Test
import org.junit.runner.RunWith

@RunWith(AndroidJUnit4::class)
class ScreenshotScenario {
    @Test
    fun launcherShowsTheInstalledAdaptiveIcon() {
        val instrumentation = InstrumentationRegistry.getInstrumentation()
        val context = instrumentation.targetContext
        val iconId = context.applicationInfo.icon
        check(iconId == R.mipmap.ic_okou_launcher)
        val icon = context.getDrawable(iconId) as AdaptiveIconDrawable
        checkNotNull(icon.monochrome) { "The API 35 launcher icon must provide a monochrome layer" }

        val device = UiDevice.getInstance(instrumentation)
        val home =
            device.executeShellCommand(
                "cmd package resolve-activity --brief -a android.intent.action.MAIN -c android.intent.category.HOME",
            )
        val launcher = home.lineSequence().last { '/' in it }.substringBefore('/')
        val label = context.applicationInfo.loadLabel(context.packageManager).toString()
        device.pressHome()
        try {
            check(device.wait(Until.hasObject(By.pkg(launcher)), 5_000)) {
                "Expected Home $launcher, visible package was ${device.currentPackageName}"
            }
            val x = device.displayWidth / 2
            val height = device.displayHeight
            check(device.swipe(x, height * 4 / 5, x, height / 4, 20))
            check(device.wait(Until.hasObject(By.pkg(launcher).text(label)), 8_000)) {
                "Launcher app drawer did not show $label"
            }
            ScreenshotCapture.capture("launcher-icon.png")
        } finally {
            device.pressHome()
        }
    }
}
