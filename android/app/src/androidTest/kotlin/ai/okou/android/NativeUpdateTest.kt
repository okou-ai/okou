package ai.okou.android

import ai.okou.android.api.RequiredUpdate
import ai.okou.android.api.generated.AndroidUpdates
import ai.okou.android.api.generated.AndroidUpdatesRelease
import ai.okou.android.updates.AppUpdates
import ai.okou.android.updates.UpdateRecord
import ai.okou.android.updates.UpdateService
import ai.okou.android.updates.UpdateStore
import androidx.test.core.app.ActivityScenario
import androidx.test.core.app.takeScreenshot
import androidx.test.core.graphics.writeToTestStorage
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import androidx.test.uiautomator.By
import androidx.test.uiautomator.UiDevice
import androidx.test.uiautomator.Until
import java.io.File
import kotlinx.coroutines.CompletableDeferred
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.junit.runners.model.MultipleFailureException

@RunWith(AndroidJUnit4::class)
class NativeUpdateTest {
    @Test
    fun initialScreenAndRequiredRecoveryUseIndependentOwnersAcrossRecreation() {
        val instrumentation = InstrumentationRegistry.getInstrumentation()
        val app = instrumentation.targetContext.applicationContext as TestOkouApplication
        val device = UiDevice.getInstance(instrumentation)
        val gate = CompletableDeferred<Unit>()
        val release =
            AndroidUpdatesRelease(
                "99.0.0",
                99_000_000,
                24,
                1234,
                "a".repeat(64),
                "https://static.okou.io/android-updates/releases/99.0.0/${"a".repeat(64)}.apk",
                "A native update",
            )
        val owner =
            AppUpdates(
                object : UpdateService {
                    override suspend fun initialize() = Unit

                    override suspend fun check(): AndroidUpdates {
                        gate.await()
                        return AndroidUpdates(null, release)
                    }

                    override suspend fun recover(release: AndroidUpdatesRelease?): File? = null

                    override suspend fun download(
                        release: AndroidUpdatesRelease,
                        progress: (Long) -> Unit,
                    ): File = error("No download requested")

                    override fun close() = Unit
                },
                object : UpdateStore {
                    override suspend fun load(): UpdateRecord? = null

                    override suspend fun save(record: UpdateRecord) = Unit
                },
                BuildConfig.VERSION_NAME,
                35,
            )
        val previous = app.updateOwner
        app.updateOwner = owner
        var scenario: ActivityScenario<MainActivity>? = null
        val failures = mutableListOf<Throwable>()
        try {
            scenario = ActivityScenario.launch(MainActivity::class.java)
            fun text(value: String) =
                device.wait(Until.findObject(By.pkg(app.packageName).text(value)), 10_000)
            assertNotNull(text(app.getString(R.string.chat_list_title)))
            gate.complete(Unit)
            assertNotNull(text(app.getString(R.string.updates_available, "99.0.0")))
            takeScreenshot().writeToTestStorage("android-update-optional.png")
            owner.requireUpdate(RequiredUpdate("99.0.0"))
            assertNotNull(text(app.getString(R.string.updates_required)))
            scenario.recreate()
            assertNotNull(text(app.getString(R.string.updates_required)))
            assertTrue(owner.state.value.required)
            takeScreenshot().writeToTestStorage("android-update-required.png")
        } catch (error: Throwable) {
            failures += error
            try {
                takeScreenshot().writeToTestStorage("android-update-failure.png")
            } catch (diagnostic: Throwable) {
                error.addSuppressed(diagnostic)
            }
        } finally {
            gate.complete(Unit)
            for (cleanup in
                listOf<() -> Unit>(
                    { scenario?.close() },
                    { owner.close() },
                    { app.updateOwner = previous },
                )) try {
                cleanup()
            } catch (error: Throwable) {
                failures += error
            }
        }
        MultipleFailureException.assertEmpty(failures)
    }
}
