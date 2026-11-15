package ai.okou.android.releasetest

import android.content.Intent
import android.content.pm.ApplicationInfo
import android.graphics.Bitmap
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import androidx.test.services.storage.TestStorage
import androidx.test.uiautomator.By
import androidx.test.uiautomator.UiDevice
import androidx.test.uiautomator.Until
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Test
import org.junit.runner.RunWith

/** Runs outside the optimized app: no test Application, app classes or added app keep rules. */
@RunWith(AndroidJUnit4::class)
class ReleaseStartupTest {
    @Test
    fun optimizedApplicationDisplaysItsNativeAuthentication() {
        val instrumentation = InstrumentationRegistry.getInstrumentation()
        val context = instrumentation.context
        val packageName = "ai.okou.android"
        val info = context.packageManager.getApplicationInfo(packageName, 0)
        assertEquals(0, info.flags and ApplicationInfo.FLAG_DEBUGGABLE)
        val intent = checkNotNull(context.packageManager.getLaunchIntentForPackage(packageName))
        val device = UiDevice.getInstance(instrumentation)
        var failure: Throwable? = null
        try {
            context.startActivity(
                intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TASK)
            )
            assertNotNull(
                "The optimized release must render the native Okou authentication screen",
                device.wait(Until.findObject(By.pkg(packageName).text("Okou")), 10_000),
            )
        } catch (error: Throwable) {
            failure = error
            try {
                val storage = TestStorage()
                instrumentation.uiAutomation.takeScreenshot()?.let { image ->
                    try {
                        storage.openOutputFile("release-startup.png").use {
                            image.compress(Bitmap.CompressFormat.PNG, 100, it)
                        }
                    } finally {
                        image.recycle()
                    }
                }
                storage.openOutputFile("release-startup.xml").use(device::dumpWindowHierarchy)
            } catch (diagnostic: Throwable) {
                error.addSuppressed(diagnostic)
            }
            throw error
        } finally {
            try {
                device.executeShellCommand("am force-stop $packageName")
            } catch (cleanup: Throwable) {
                if (failure != null) failure.addSuppressed(cleanup) else throw cleanup
            }
        }
    }
}
