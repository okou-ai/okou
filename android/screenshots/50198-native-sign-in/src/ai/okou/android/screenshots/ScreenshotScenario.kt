package ai.okou.android.screenshots

import ai.okou.android.MainActivity
import ai.okou.android.R
import ai.okou.android.ScreenshotCapture
import ai.okou.android.TestAuthentication
import ai.okou.android.TestOkouApplication
import ai.okou.android.auth.AuthenticationState
import ai.okou.android.auth.ClerkAuthentication
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
    private val device = UiDevice.getInstance(instrumentation)
    private val app = instrumentation.targetContext.applicationContext as TestOkouApplication
    private val auth = app.authentication as TestAuthentication

    @Test
    fun slowRestorationContinuesToNativeClerkForm() {
        val previous = auth.state.value
        val appName = By.text(app.getString(R.string.app_name))
        val identifier = By.res("clerk.auth.start.identifier")
        try {
            auth.state.value = AuthenticationState()
            ActivityScenario.launch(MainActivity::class.java).use {
                await(appName)
                check(!device.hasObject(identifier))
                ScreenshotCapture.capture("restoring-brand.png")

                instrumentation.runOnMainSync {
                    ClerkAuthentication(app).initialize()
                    auth.state.value = AuthenticationState(initialized = true)
                }
                await(identifier)
                await(By.res("clerk.auth.start.continue"))
                await(appName)
                ScreenshotCapture.capture("sign-in.png")
            }
        } finally {
            auth.state.value = previous
        }
    }

    private fun await(selector: BySelector) {
        checkNotNull(device.wait(Until.findObject(selector), 20_000)) {
            "Never displayed $selector"
        }
    }
}
