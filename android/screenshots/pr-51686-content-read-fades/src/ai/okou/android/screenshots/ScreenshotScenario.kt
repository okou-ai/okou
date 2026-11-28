package ai.okou.android.screenshots

import ai.okou.android.ChatCacheSnapshot
import ai.okou.android.ChatListApiFixture
import ai.okou.android.MainActivity
import ai.okou.android.R
import ai.okou.android.ScreenshotCapture
import ai.okou.android.TestAuthentication
import ai.okou.android.TestOkouApplication
import ai.okou.android.api.generated.UserPreferencesColorTheme
import ai.okou.android.api.generated.UserPreferencesLocale
import ai.okou.android.api.generated.UserPreferencesTheme
import ai.okou.android.auth.ReadyWorkspace
import ai.okou.android.auth.SessionModel
import ai.okou.android.awaitChatList
import ai.okou.android.chat.ChatListSource
import ai.okou.android.chatListRegion
import ai.okou.android.resolvePalette
import ai.okou.android.testAuthenticationState
import ai.okou.android.testPreferences
import android.graphics.Rect
import androidx.compose.ui.graphics.toArgb
import androidx.lifecycle.ViewModelProvider
import androidx.lifecycle.viewModelScope
import androidx.test.core.app.ActivityScenario
import androidx.test.core.app.takeScreenshot
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import androidx.test.uiautomator.By
import androidx.test.uiautomator.Condition
import androidx.test.uiautomator.UiDevice
import androidx.test.uiautomator.Until
import java.util.UUID
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import kotlinx.coroutines.Job
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withTimeout
import org.junit.Test
import org.junit.runner.RunWith

@RunWith(AndroidJUnit4::class)
class ScreenshotScenario {
    @Test
    fun readProgressRetainsTheCachedChatPosition() {
        val instrumentation = InstrumentationRegistry.getInstrumentation()
        val app = instrumentation.targetContext.applicationContext as TestOkouApplication
        val device = UiDevice.getInstance(instrumentation)
        val auth = app.authentication as TestAuthentication
        val originalAuth = auth.state.value
        val originalService = app.chatService
        val originalPreferences = app.snapshotApiPreferences()
        val originalInitialPreferences = app.initialPreferences
        val originalScale =
            device.executeShellCommand("settings get global animator_duration_scale").trim()
        val originalSize =
            Regex("Override size: (\\d+x\\d+)")
                .find(device.executeShellCommand("wm size"))
                ?.groupValues
                ?.get(1)
        val originalDensity =
            Regex("Override density: (\\d+)")
                .find(device.executeShellCommand("wm density"))
                ?.groupValues
                ?.get(1)
        val cache = ChatCacheSnapshot(app.noBackupFilesDir.resolve("chat-list"), app.chatCache)
        val palette = resolvePalette(UserPreferencesColorTheme.DEFAULT, dark = false)

        fun owner(scenario: ActivityScenario<MainActivity>): ReadyWorkspace {
            lateinit var session: SessionModel
            scenario.onActivity { session = ViewModelProvider(it)[SessionModel::class.java] }
            return runBlocking {
                withTimeout(15_000) {
                    checkNotNull(session.uiState.first { it.ready != null }.ready)
                }
            }
        }

        fun awaitRetirement(ready: ReadyWorkspace) {
            val job = checkNotNull(ready.chats.viewModelScope.coroutineContext[Job])
            runBlocking { withTimeout(15_000) { job.join() } }
        }

        fun rowBounds(): Rect {
            val row =
                checkNotNull(
                    device.wait(
                        Until.findObject(By.pkg(app.packageName).text("Personal chat")),
                        15_000,
                    ),
                )
            return Rect().apply {
                generateSequence(row.accessibilityNodeInfo) { it.parent }
                    .first { it.isClickable }
                    .getBoundsInScreen(this)
            }
        }

        fun sample(bar: Rect): List<Int> {
            val bitmap = takeScreenshot()
            try {
                return (1..15).map { index ->
                    bitmap.getPixel(bar.left + bar.width() * index / 16, bar.centerY())
                }
            } finally {
                bitmap.recycle()
            }
        }

        fun findPaintedBar(semantics: Rect, thickness: Int): Rect {
            // Material 3 can extend the TalkBack bounds beyond the painted track.
            val track = palette.secondaryContainer.toArgb()
            return checkNotNull(
                device.wait(
                    object : Condition<UiDevice, Rect?> {
                        override fun apply(device: UiDevice): Rect? {
                            val bitmap = takeScreenshot()
                            try {
                                val painted =
                                    (semantics.top until semantics.bottom).filter { y ->
                                        (1..15).any { x ->
                                            bitmap.getPixel(
                                                semantics.left + semantics.width() * x / 16,
                                                y,
                                            ) == track
                                        }
                                    }
                                if (painted.size != thickness) return null
                                return Rect(
                                    semantics.left,
                                    painted.first(),
                                    semantics.right,
                                    painted.last() + 1,
                                )
                            } finally {
                                bitmap.recycle()
                            }
                        }
                    },
                    10_000,
                ),
            ) {
                "Expected a 4 dp painted track at $semantics"
            }
        }

        try {
            device.executeShellCommand("wm density 160")
            device.executeShellCommand("wm size 440x900")
            device.executeShellCommand("settings put global animator_duration_scale 1.0")
            app.initialPreferences =
                testPreferences()
                    .copy(
                        theme = UserPreferencesTheme.LIGHT,
                        locale = UserPreferencesLocale.EN_US,
                    )
            ChatListApiFixture().use { fixture ->
                app.chatService = fixture.service
                auth.state.value = testAuthenticationState(user = "read-fades-${UUID.randomUUID()}")
                val original =
                    ActivityScenario.launch(MainActivity::class.java).use { scenario ->
                        owner(scenario).also { ready ->
                            runBlocking {
                                withTimeout(15_000) {
                                    ready.chats.uiState.first {
                                        it.source == ChatListSource.Network &&
                                            it.projectsSource == ChatListSource.Network
                                    }
                                }
                            }
                        }
                    }
                awaitRetirement(original)
                runBlocking {
                    app.chatCache
                        .open(original.identity) { true }
                        .use { lease ->
                            val saved = checkNotNull(lease.load())
                            check(
                                lease.save(
                                    saved.checkpoint,
                                    System.currentTimeMillis() - TimeUnit.MINUTES.toMillis(11),
                                ),
                            )
                        }
                }

                val started = CountDownLatch(1)
                val release = CountDownLatch(1)
                val events = fixture.events
                fixture.events = { request ->
                    started.countDown()
                    check(release.await(60, TimeUnit.SECONDS))
                    events(request)
                }
                var current: ReadyWorkspace? = null
                try {
                    ActivityScenario.launch(MainActivity::class.java).use { scenario ->
                        try {
                            current = owner(scenario)
                            device.awaitChatList(app)
                            check(started.await(15, TimeUnit.SECONDS))
                            val before = rowBounds()
                            val syncing =
                                By.pkg(app.packageName).desc(app.getString(R.string.chat_syncing))
                            val semantics =
                                checkNotNull(device.wait(Until.findObject(syncing), 15_000))
                                    .visibleBounds
                            val pane =
                                checkNotNull(
                                        device.wait(Until.findObject(chatListRegion(app)), 15_000),
                                    )
                                    .visibleBounds
                            check(pane.width() == 440)
                            check(semantics.left == pane.left && semantics.right == pane.right)
                            val bar = findPaintedBar(semantics, thickness = 4)
                            check(bar.bottom <= before.top)
                            val primary = palette.primary.toArgb()
                            val track = palette.secondaryContainer.toArgb()
                            var lastFrame: List<Int>? = null
                            check(
                                device.wait(
                                    object : Condition<UiDevice, Boolean> {
                                        override fun apply(device: UiDevice): Boolean {
                                            val pixels = sample(bar)
                                            val moved = lastFrame != null && lastFrame != pixels
                                            if (primary in pixels && track in pixels) {
                                                if (moved) return true
                                                lastFrame = pixels
                                            }
                                            return false
                                        }
                                    },
                                    10_000,
                                ),
                            ) {
                                "Expected a moving Material 3 segment at $bar"
                            }
                            ScreenshotCapture.capture("01-moving-read-progress.png")

                            device.executeShellCommand(
                                "settings put global animator_duration_scale 0.0",
                            )
                            val staticPixels = List(15) { if (it < 4) primary else track }
                            check(
                                device.wait(
                                    object : Condition<UiDevice, Boolean> {
                                        override fun apply(device: UiDevice) =
                                            sample(bar) == staticPixels
                                    },
                                    10_000,
                                ),
                            ) {
                                "Expected a static activity segment at $bar"
                            }
                            check(device.hasObject(syncing))
                            check(before == rowBounds())
                            ScreenshotCapture.capture("02-reduced-motion-read-progress.png")

                            release.countDown()
                            check(device.wait(Until.gone(syncing), 10_000))
                            check(before == rowBounds())
                            ScreenshotCapture.capture("03-read-complete.png")
                        } catch (failure: Throwable) {
                            runCatching {
                                ScreenshotCapture.capture("read-progress-diagnostic.png")
                            }
                            throw failure
                        } finally {
                            release.countDown()
                        }
                    }
                } finally {
                    current?.let(::awaitRetirement)
                }
            }
        } finally {
            auth.state.value = originalAuth
            app.chatService = originalService
            app.restoreApiPreferences(originalPreferences)
            app.initialPreferences = originalInitialPreferences
            device.executeShellCommand("wm size ${originalSize ?: "reset"}")
            device.executeShellCommand("wm density ${originalDensity ?: "reset"}")
            device.executeShellCommand(
                if (originalScale == "null") "settings delete global animator_duration_scale"
                else "settings put global animator_duration_scale $originalScale",
            )
            cache.restore()
        }
    }
}
