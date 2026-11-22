package ai.okou.android.settings

import ai.okou.android.ChatListApiFixture
import ai.okou.android.DefaultModelApiFixture
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.test.runTest
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.jsonObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

@OptIn(ExperimentalCoroutinesApi::class)
class DefaultModelSettingsTest {
    @Test
    fun offlineEditsCoalesceAndForegroundReadsTheOtherDevicesChoice() = runTest {
        ChatListApiFixture().use { api ->
            val fixture = DefaultModelApiFixture(api)
            val model = DefaultModelSettings(backgroundScope, api.service, { true }, { throw it })
            model.visible(true)
            val loaded = model.state.first { it.options != null }
            assertEquals("gpt-test", loaded.selected?.id)
            assertEquals(ModelEffort.MEDIUM, loaded.effort)
            model.online(false)
            model.fast(true)
            model.effort(ModelEffort.HIGH)
            assertTrue(model.state.value.fast)
            assertTrue(fixture.writes.isEmpty())

            model.online(true)
            val saved = model.state.first { it.pending == null }
            assertEquals(ModelEffort.HIGH, saved.effort)
            val update = fixture.writes.single()
            assertEquals(JsonPrimitive("priority"), update["serviceTier"])
            assertEquals(
                JsonPrimitive("high"),
                update["modelSettingsPatch"]?.jsonObject?.get("effort"),
            )
            assertFalse(update.containsKey("selectedImageModel"))
            assertEquals(
                JsonPrimitive("high"),
                fixture.preference["modelSettings"]
                    ?.jsonObject
                    ?.get("claude-test")
                    ?.jsonObject
                    ?.get("effort"),
            )

            val claude = saved.options!!.choices.single { it.id == "claude-test" }
            model.select(claude.id)
            val switched = model.state.first { it.pending == null }
            assertEquals(ModelEffort.HIGH, switched.effort)
            assertFalse(switched.fast)
            assertEquals(JsonNull, fixture.writes.last()["serviceTier"])

            model.visible(false)
            fixture.selectAutoElsewhere()
            model.visible(true)
            val refreshed = model.state.first { it.preference?.selectedModel == null }
            assertNull(refreshed.selected)
            assertNull(refreshed.effort)
            assertEquals(2, fixture.writes.size)
        }
    }
}
