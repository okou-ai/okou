package ai.okou.android.screenshots

import ai.okou.android.BuildConfig
import ai.okou.android.ChatCacheSnapshot
import ai.okou.android.ComposerApiFixture
import ai.okou.android.MainActivity
import ai.okou.android.R
import ai.okou.android.ScreenshotCapture
import ai.okou.android.TestOkouApplication
import ai.okou.android.api.generated.AndroidUpdates
import ai.okou.android.api.generated.AndroidUpdatesRelease
import ai.okou.android.auth.SessionModel
import ai.okou.android.chat.ComposerTarget
import ai.okou.android.updates.AppUpdates
import ai.okou.android.updates.UpdateRecord
import ai.okou.android.updates.UpdateService
import ai.okou.android.updates.UpdateStore
import androidx.lifecycle.ViewModelProvider
import androidx.lifecycle.viewModelScope
import androidx.test.core.app.ActivityScenario
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import androidx.test.uiautomator.By
import androidx.test.uiautomator.BySelector
import androidx.test.uiautomator.Condition
import androidx.test.uiautomator.UiDevice
import androidx.test.uiautomator.Until
import java.io.File
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.Job
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withTimeout
import org.junit.Test
import org.junit.runner.RunWith
import org.junit.runners.model.MultipleFailureException

@RunWith(AndroidJUnit4::class)
class ScreenshotScenario {
    @Test
    fun captureAndroidSymbols() {
        val instrumentation = InstrumentationRegistry.getInstrumentation()
        val app = instrumentation.targetContext.applicationContext as TestOkouApplication
        val device = UiDevice.getInstance(instrumentation)
        val oldChats = app.chatService
        val oldComposer = app.composerService
        val oldUpdates = app.updateOwner
        val preferences = app.snapshotApiPreferences()
        val cache = ChatCacheSnapshot(app.noBackupFilesDir.resolve("chat-list"), app.chatCache)
        val fixture = ComposerApiFixture()
        val exposeUpdate = CompletableDeferred<Unit>()
        val updates = appUpdates(exposeUpdate)
        app.chatService = fixture.service
        app.composerService = fixture.service
        app.updateOwner = updates
        app.restoreApiPreferences(emptyMap())
        var scenario: ActivityScenario<MainActivity>? = null
        var workspaceJobs = emptyList<Job>()
        val failures = mutableListOf<Throwable>()

        fun text(label: Int) = By.pkg(app.packageName).text(app.getString(label))
        fun description(label: Int) = By.pkg(app.packageName).desc(app.getString(label))
        fun find(selector: BySelector) =
            checkNotNull(device.wait(Until.findObject(selector), 10_000)) { "Missing $selector" }

        try {
            scenario = ActivityScenario.launch(MainActivity::class.java)
            val chat = By.pkg(app.packageName).text("Personal chat")
            find(chat)
            scenario.onActivity { activity ->
                val ready =
                    checkNotNull(
                        ViewModelProvider(activity)[SessionModel::class.java].uiState.value.ready
                    )
                workspaceJobs =
                    listOfNotNull(
                        ready.chats.viewModelScope.coroutineContext[Job],
                        ready.composer.viewModelScope.coroutineContext[Job],
                    )
            }
            find(description(R.string.chat_filter))
            find(description(R.string.settings))
            find(text(R.string.composer_new))
            ScreenshotCapture.capture("01-chat-toolbar.png")

            find(chat).longClick()
            find(text(R.string.chat_pin))
            find(text(R.string.chat_archive))
            ScreenshotCapture.capture("02-chat-menu.png")
            check(device.pressBack())
            check(device.wait(Until.gone(text(R.string.chat_pin)), 10_000))

            find(description(R.string.settings)).click()
            find(text(R.string.appearance))
            find(text(R.string.preference_language))
            ScreenshotCapture.capture("03-settings.png")
            find(text(R.string.preference_color_theme)).click()
            find(text(R.string.palette_golden_hour))
            ScreenshotCapture.capture("04-palette.png")
            check(device.pressBack())
            check(device.wait(Until.gone(text(R.string.palette_golden_hour)), 10_000))
            find(description(R.string.back)).click()

            find(text(R.string.composer_new)).click()
            val editor = By.pkg(app.packageName).clazz("android.widget.EditText").enabled(true)
            find(editor).text = "Review the design"
            check(
                device.wait(
                    object : Condition<UiDevice, Boolean> {
                        override fun apply(device: UiDevice): Boolean {
                            var ready = false
                            checkNotNull(scenario).onActivity { activity ->
                                ready =
                                    ViewModelProvider(activity)[SessionModel::class.java]
                                        .uiState
                                        .value
                                        .ready
                                        ?.composer
                                        ?.uiState
                                        ?.value
                                        ?.canSend(ComposerTarget()) == true
                            }
                            return ready &&
                                device.findObject(text(R.string.composer_send))?.isEnabled == true
                        }
                    },
                    10_000,
                )
            ) {
                "Composer did not become ready to send"
            }
            ScreenshotCapture.capture("05-composer.png")
            find(description(R.string.back)).click()

            exposeUpdate.complete(Unit)
            find(text(R.string.updates_view))
            find(description(R.string.chat_more_actions)).click()
            find(text(R.string.chat_filter))
            find(text(R.string.settings))
            ScreenshotCapture.capture("06-update-overflow.png")
        } catch (failure: Throwable) {
            failures += failure
            runCatching { ScreenshotCapture.capture("failure.png") }
                .onFailure(failure::addSuppressed)
        } finally {
            exposeUpdate.complete(Unit)
            val cleanup =
                listOf<() -> Unit>(
                    { scenario?.close() },
                    { runBlocking { withTimeout(10_000) { workspaceJobs.forEach { it.join() } } } },
                    { updates.close() },
                    { app.updateOwner = oldUpdates },
                    { app.chatService = oldChats },
                    { app.composerService = oldComposer },
                    { app.restoreApiPreferences(preferences) },
                    { cache.restore() },
                    { fixture.close() },
                )
            for (restore in cleanup) {
                runCatching(restore).onFailure(failures::add)
            }
        }
        MultipleFailureException.assertEmpty(failures)
    }

    private fun appUpdates(exposeUpdate: CompletableDeferred<Unit>) =
        AppUpdates(
            object : UpdateService {
                override suspend fun initialize() = Unit

                override suspend fun check(): AndroidUpdates {
                    exposeUpdate.await()
                    return AndroidUpdates(
                        null,
                        AndroidUpdatesRelease(
                            "99.0.0",
                            24,
                            1234,
                            "a".repeat(64),
                            "https://static.okou.io/android-updates/releases/99.0.0/${"a".repeat(64)}.apk",
                            "Screenshot fixture",
                        ),
                    )
                }

                override suspend fun recover(release: AndroidUpdatesRelease): File? = null

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
}
