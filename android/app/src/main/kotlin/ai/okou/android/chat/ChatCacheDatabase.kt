package ai.okou.android.chat

import androidx.room.Dao
import androidx.room.Database
import androidx.room.Entity
import androidx.room.ForeignKey
import androidx.room.Index
import androidx.room.Insert
import androidx.room.PrimaryKey
import androidx.room.Query
import androidx.room.RoomDatabase
import androidx.room.Upsert

/** Only server-confirmed cache data belongs here; drafts and credentials have other owners. */
@Entity(tableName = "chat_scopes")
internal data class ChatScopeRecord(
    @PrimaryKey val scope: String,
    val authorization: String,
    val confirmedAt: Long,
    val snapshotEventId: String?,
    val snapshotSeqId: Long,
    val hasAgents: Boolean,
    val hasProjects: Boolean,
    val projectsEnabled: Boolean,
)

@Entity(
    tableName = "chat_thread_snapshot",
    primaryKeys = ["scope", "id"],
    foreignKeys =
        [
            ForeignKey(
                entity = ChatScopeRecord::class,
                parentColumns = ["scope"],
                childColumns = ["scope"],
                onDelete = ForeignKey.CASCADE,
            )
        ],
)
internal data class ChatSnapshotRecord(
    val scope: String,
    val id: String,
    val position: Int,
    val payload: String,
)

@Entity(
    tableName = "chat_thread_events",
    primaryKeys = ["scope", "id"],
    indices = [Index(value = ["scope", "seqId"], unique = true)],
    foreignKeys =
        [
            ForeignKey(
                entity = ChatScopeRecord::class,
                parentColumns = ["scope"],
                childColumns = ["scope"],
                onDelete = ForeignKey.CASCADE,
            )
        ],
)
internal data class ChatEventRecord(
    val scope: String,
    val id: String,
    val seqId: Long,
    val payload: String,
)

@Entity(
    tableName = "chat_agents",
    primaryKeys = ["scope", "id"],
    foreignKeys =
        [
            ForeignKey(
                entity = ChatScopeRecord::class,
                parentColumns = ["scope"],
                childColumns = ["scope"],
                onDelete = ForeignKey.CASCADE,
            )
        ],
)
internal data class ChatAgentRecord(
    val scope: String,
    val id: String,
    val position: Int,
    val payload: String,
)

@Entity(
    tableName = "chat_projects",
    primaryKeys = ["scope", "id"],
    foreignKeys =
        [
            ForeignKey(
                entity = ChatScopeRecord::class,
                parentColumns = ["scope"],
                childColumns = ["scope"],
                onDelete = ForeignKey.CASCADE,
            )
        ],
)
internal data class ChatProjectRecord(
    val scope: String,
    val id: String,
    val position: Int,
    val payload: String,
)

@Dao
internal interface ChatCacheDao {
    @Query("SELECT * FROM chat_scopes WHERE scope = :scope")
    suspend fun scope(scope: String): ChatScopeRecord?

    @Upsert suspend fun putScope(value: ChatScopeRecord)

    @Query("DELETE FROM chat_scopes WHERE scope = :scope") suspend fun deleteScope(scope: String)

    @Query("SELECT * FROM chat_thread_snapshot WHERE scope = :scope ORDER BY position")
    suspend fun snapshot(scope: String): List<ChatSnapshotRecord>

    @Query("DELETE FROM chat_thread_snapshot WHERE scope = :scope")
    suspend fun clearSnapshot(scope: String)

    @Insert suspend fun putSnapshot(values: List<ChatSnapshotRecord>)

    @Query("SELECT * FROM chat_thread_events WHERE scope = :scope ORDER BY seqId")
    suspend fun events(scope: String): List<ChatEventRecord>

    @Query("SELECT MAX(seqId) FROM chat_thread_events WHERE scope = :scope")
    suspend fun lastSeqId(scope: String): Long?

    @Query("DELETE FROM chat_thread_events WHERE scope = :scope")
    suspend fun clearEvents(scope: String)

    @Insert suspend fun putEvents(values: List<ChatEventRecord>)

    @Query("SELECT * FROM chat_agents WHERE scope = :scope ORDER BY position")
    suspend fun agents(scope: String): List<ChatAgentRecord>

    @Query("DELETE FROM chat_agents WHERE scope = :scope") suspend fun clearAgents(scope: String)

    @Insert suspend fun putAgents(values: List<ChatAgentRecord>)

    @Query("SELECT * FROM chat_projects WHERE scope = :scope ORDER BY position")
    suspend fun projects(scope: String): List<ChatProjectRecord>

    @Query("DELETE FROM chat_projects WHERE scope = :scope")
    suspend fun clearProjects(scope: String)

    @Insert suspend fun putProjects(values: List<ChatProjectRecord>)
}

@Database(
    entities =
        [
            ChatScopeRecord::class,
            ChatSnapshotRecord::class,
            ChatEventRecord::class,
            ChatAgentRecord::class,
            ChatProjectRecord::class,
        ],
    version = 1,
    exportSchema = true,
)
internal abstract class ChatCacheDatabase : RoomDatabase() {
    abstract fun chats(): ChatCacheDao
}
