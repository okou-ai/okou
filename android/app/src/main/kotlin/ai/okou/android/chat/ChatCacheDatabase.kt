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

@Entity(tableName = "project_scopes")
internal data class ProjectScopeRecord(
    @PrimaryKey val scope: String,
    val authorization: String,
    val confirmedAt: Long,
    val snapshotEventId: String?,
    val snapshotSeqId: Long,
)

@Entity(
    tableName = "project_snapshot",
    primaryKeys = ["scope", "id"],
    foreignKeys =
        [
            ForeignKey(
                entity = ProjectScopeRecord::class,
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

@Entity(
    tableName = "project_events",
    primaryKeys = ["scope", "id"],
    indices = [Index(value = ["scope", "seqId"], unique = true)],
    foreignKeys =
        [
            ForeignKey(
                entity = ProjectScopeRecord::class,
                parentColumns = ["scope"],
                childColumns = ["scope"],
                onDelete = ForeignKey.CASCADE,
            )
        ],
)
internal data class ProjectEventRecord(
    val scope: String,
    val id: String,
    val seqId: Long,
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

    @Query("SELECT * FROM project_snapshot WHERE scope = :scope ORDER BY position")
    suspend fun projects(scope: String): List<ChatProjectRecord>

    @Query("DELETE FROM project_snapshot WHERE scope = :scope")
    suspend fun clearProjects(scope: String)

    @Insert suspend fun putProjects(values: List<ChatProjectRecord>)

    @Query("SELECT * FROM project_scopes WHERE scope = :scope")
    suspend fun projectScope(scope: String): ProjectScopeRecord?

    @Upsert suspend fun putProjectScope(value: ProjectScopeRecord)

    @Query("DELETE FROM project_scopes WHERE scope = :scope")
    suspend fun deleteProjectScope(scope: String)

    @Query("SELECT * FROM project_events WHERE scope = :scope ORDER BY seqId")
    suspend fun projectEvents(scope: String): List<ProjectEventRecord>

    @Query("SELECT MAX(seqId) FROM project_events WHERE scope = :scope")
    suspend fun lastProjectSeqId(scope: String): Long?

    @Query("DELETE FROM project_events WHERE scope = :scope")
    suspend fun clearProjectEvents(scope: String)

    @Insert suspend fun putProjectEvents(values: List<ProjectEventRecord>)
}

@Database(
    entities =
        [
            ChatScopeRecord::class,
            ChatSnapshotRecord::class,
            ChatEventRecord::class,
            ChatAgentRecord::class,
            ChatProjectRecord::class,
            ProjectScopeRecord::class,
            ProjectEventRecord::class,
        ],
    version = 1,
    exportSchema = true,
)
internal abstract class ChatCacheDatabase : RoomDatabase() {
    abstract fun chats(): ChatCacheDao
}
