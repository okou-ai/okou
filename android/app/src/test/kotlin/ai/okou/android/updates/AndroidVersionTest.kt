package ai.okou.android.updates

import kotlinx.serialization.json.Json
import kotlinx.serialization.json.int
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import org.junit.Assert.*
import org.junit.Test

class AndroidVersionTest {
    @Test
    fun matchesCanonicalPolicyAndPublisherOrdering() {
        val text =
            checkNotNull(javaClass.getResourceAsStream("/android-versions.json"))
                .bufferedReader()
                .use { it.readText() }
        val vectors = Json.parseToJsonElement(text).jsonObject
        for (vector in vectors.getValue("comparisons").jsonArray) {
            val item = vector.jsonObject
            val left = item.getValue("left").jsonPrimitive.content
            val right = item.getValue("right").jsonPrimitive.content
            val order = item.getValue("order").jsonPrimitive.int
            assertEquals("$left / $right", order, compareAndroidVersions(left, right))
            assertEquals("$right / $left", -order, compareAndroidVersions(right, left))
        }
        for (vector in vectors.getValue("invalid").jsonArray) {
            val version = vector.jsonPrimitive.content
            assertFalse(version, isAndroidVersion(version))
            assertNull(compareAndroidVersions(version, "1.2.3"))
            assertNull(compareAndroidVersions("1.2.3", version))
        }
    }
}
