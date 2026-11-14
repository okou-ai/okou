package ai.okou.android

import android.content.res.Configuration
import android.graphics.Bitmap
import android.os.Build
import androidx.test.core.app.takeScreenshot
import androidx.test.platform.app.InstrumentationRegistry
import androidx.test.services.storage.TestStorage
import org.json.JSONObject

/** Shared device-only output support; feature scenarios live outside ordinary test sources. */
object ScreenshotCapture {
    fun capture(name: String) {
        require(Regex("[A-Za-z0-9][A-Za-z0-9._-]*\\.png").matches(name))
        val instrumentation = InstrumentationRegistry.getInstrumentation()
        val run =
            checkNotNull(InstrumentationRegistry.getArguments().getString("okouScreenshotRun"))
        val context = instrumentation.targetContext
        val configuration = context.resources.configuration
        val bitmap = takeScreenshot()
        try {
            TestStorage().openOutputFile(name).use {
                check(bitmap.compress(Bitmap.CompressFormat.PNG, 100, it))
            }
            val metadata =
                JSONObject()
                    .put("runId", run)
                    .put("api", Build.VERSION.SDK_INT)
                    .put("device", Build.MODEL)
                    .put("locale", configuration.locales.toLanguageTags())
                    .put("densityDpi", configuration.densityDpi)
                    .put("fontScale", configuration.fontScale)
                    .put("nightMode", configuration.uiMode and Configuration.UI_MODE_NIGHT_MASK)
                    .put("width", bitmap.width)
                    .put("height", bitmap.height)
            TestStorage().openOutputFile("$name.json").use {
                it.write(metadata.toString().toByteArray(Charsets.UTF_8))
            }
        } finally {
            bitmap.recycle()
        }
    }
}
