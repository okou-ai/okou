package ai.okou.android.auth

import com.clerk.api.organizations.OrganizationMembership
import kotlinx.serialization.ExperimentalSerializationApi
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonNamingStrategy
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class WorkspaceLogoTest {
    @Test
    fun clerkUploadFlagDistinguishesAnUploadFromTheGeneratedImageUrl() {
        val uploaded = "https://img.clerk.com/upload"
        val generated = "https://img.clerk.com/generated"
        assertEquals(uploaded, membership(uploaded, hasImage = true).uploadedImageUrl)
        assertNull(membership(generated, hasImage = false).uploadedImageUrl)
    }

    @Test
    fun initialKeepsTheFirstEligibleGrapheme() {
        val examples =
            mapOf(
                "   🚀 — okou" to "O",
                "🎉 + 123 Labs" to "1",
                "💬 字节" to "字",
                "한국 팀" to "한",
                "e\u0301lan" to "E\u0301",
                "𐐨 Studio" to "𐐀",
                "ßeta" to "ß",
                "workspace-design" to "W",
            )
        for ((name, initial) in examples) {
            assertEquals(name, initial, workspaceInitial(name))
        }
    }

    @Test
    fun generatedAndSymbolOnlyNamesHaveNoInitial() {
        for (name in listOf(" workspace-3F9a2c1d ", "👩🏽‍💻 ✦", "  ", "")) {
            assertNull(name, workspaceInitial(name))
        }
    }

    @OptIn(ExperimentalSerializationApi::class)
    private fun membership(url: String, hasImage: Boolean): WorkspaceMembership {
        val json = Json { namingStrategy = JsonNamingStrategy.SnakeCase }
        return json
            .decodeFromString<OrganizationMembership>(
                """
                {
                  "id": "orgmem_test",
                  "role": "org:member",
                  "role_name": "Member",
                  "public_metadata": {},
                  "created_at": 0,
                  "updated_at": 0,
                  "organization": {
                    "id": "org_test",
                    "name": "Okou",
                    "slug": "okou",
                    "image_url": "$url",
                    "has_image": $hasImage,
                    "max_allowed_memberships": 1,
                    "admin_delete_enabled": true,
                    "created_at": 0,
                    "updated_at": 0,
                    "public_metadata": {}
                  }
                }
                """
                    .trimIndent(),
            )
            .toWorkspaceMembership()
    }
}
