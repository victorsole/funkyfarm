package eu.funkyfarm.app

import android.content.Context
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.Job
import org.json.JSONArray
import org.json.JSONObject
import java.io.File
import java.util.UUID

fun JSONArray.objects(): List<JSONObject> = (0 until length()).mapNotNull { optJSONObject(it) }
fun JSONObject.data(): JSONObject = optJSONObject("data") ?: this
fun JSONObject.title(): String = data().let { it.optString("title").ifBlank { it.optString("name").ifBlank { it.optString("filename").ifBlank { it.optString("label").ifBlank { it.optString("key", "Record") } } } } }
fun obj(vararg values: Pair<String, Any?>) = JSONObject().apply { values.forEach { (key, value) -> put(key, value ?: JSONObject.NULL) } }

class FarmModel(val context: Context) {
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main)
    private val bootstrap = PrivateStore(context, "session")
    private val intake = PrivateStore(context, "intake")
    private var vault: PrivateStore? = null
    private var state = JSONObject()
    private var generation = 0
    var session by mutableStateOf<JSONObject?>(null); private set
    var origin by mutableStateOf("https://funkyfarm.elfeel.me"); private set
    var tab by mutableStateOf("Home")
    var detail by mutableStateOf<Pair<String, String>?>(null)
    var administration by mutableStateOf<Pair<String, String?>?>(null)
    var sourceImports by mutableStateOf<JSONObject?>(null)
    var czechJournal by mutableStateOf<JSONObject?>(null)
    var cases by mutableStateOf<JSONObject?>(null)
    var item by mutableStateOf<JSONObject?>(null); private set
    var records by mutableStateOf<Map<String, List<JSONObject>>>(emptyMap()); private set
    var totals by mutableStateOf<Map<String, Int>>(emptyMap()); private set
    var packs by mutableStateOf<List<JSONObject>>(emptyList()); private set
    var extras by mutableStateOf<Map<String, JSONObject>>(emptyMap()); private set
    var privateUnavailable by mutableStateOf<Set<String>>(emptySet()); private set
    var message by mutableStateOf(""); private set
    var busy by mutableStateOf(false); private set
    var offline by mutableStateOf(false); private set
    var version by mutableStateOf(0); private set
    var serverVersion by mutableStateOf(0); private set
    var staged by mutableStateOf<List<JSONObject>>(emptyList()); private set
    var shared by mutableStateOf<List<JSONObject>>(emptyList()); private set
    var exporting by mutableStateOf(false); private set
    private var reportTransfer: ReportFileTransfer? = null
    private var exportJob: Job? = null
    private val sending = mutableSetOf<String>()
    init {
        runCatching {
            val stored = bootstrap.json("auth.json")
            if (stored.has("session")) activate(stored.getJSONObject("session"), stored.getString("origin"), restoring = true)
            shared = intake.json("items.json").optJSONArray("items")?.objects().orEmpty()
        }.onFailure { message = "Private saved data could not be unlocked. Sign in again; no data has been sent." }
    }
    fun api() = Api(origin, session?.optString("token").orEmpty(), session?.optJSONObject("workspace")?.optString("id").orEmpty())
    private fun activate(auth: JSONObject, endpoint: String, restoring: Boolean = false) {
        cancelReportExport(); clearReportExports(incompleteOnly = restoring)
        generation++; origin = endpoint; session = auth; administration = null; sourceImports = null; czechJournal = null; cases = null
        vault = PrivateStore(context, auth.getJSONObject("user").getString("id") + ":" + auth.getJSONObject("workspace").getString("id"))
        state = vault!!.json("workspace.json")
        staged = state.optJSONArray("attachments")?.objects().orEmpty()
        records = state.optJSONObject("cache")?.let { cache -> cache.keys().asSequence().associateWith { cache.optJSONArray(it)?.objects().orEmpty() } }.orEmpty()
        records["reports"]?.let { reports ->
            val compact = reports.map(::compactCachedReport)
            records = records + ("reports" to compact); state.optJSONObject("cache")?.put("reports", JSONArray(compact))
        }
        state.optJSONArray("outbox")?.objects()?.forEach { job -> job.optJSONObject("current")?.takeIf { it.optString("kind") == "reports" }?.let { job.put("current", compactCachedReport(it)) } }
        vault!!.save("workspace.json", state)
        totals = state.optJSONObject("totals")?.let { counts -> counts.keys().asSequence().associateWith { counts.optInt(it) } }.orEmpty()
        bootstrap.save("auth.json", obj("session" to auth, "origin" to endpoint))
        detail = null; item = null; tab = "Home"; extras = state.optJSONObject("workflow_home")?.let { mapOf("home" to it) }.orEmpty(); privateUnavailable = emptySet(); version++
    }
    private fun persist() { vault?.save("workspace.json", state); version++ }
    private fun action(block: suspend () -> Unit) {
        val expected = generation
        scope.launch {
            busy = true
            try { block() } catch (error: Throwable) {
                if (generation == expected) {
                    message = error.message ?: "The action could not finish. Your draft is retained."
                    if (error is ApiFailure && error.status == 401) message = "Your session has expired. Sign out, then sign in again. Saved drafts remain encrypted until sign-out."
                }
            } finally { if (generation == expected) busy = false }
        }
    }
    fun authenticate(endpoint: String, email: String, password: String, name: String, register: Boolean) = action {
        val credentials = obj("email" to email.trim(), "password" to password)
        if (register) credentials.put("display_name", name.trim())
        val response = withContext(Dispatchers.IO) { Api(endpoint).request(if (register) "/auth/register" else "/auth/login", "POST", credentials) }
        activate(response, endpoint); message = "Signed in to your private workspace."; refresh()
    }
    fun logout() {
        cancelReportExport()
        val client = api(); val old = vault; administration = null; sourceImports = null; czechJournal = null; cases = null
        generation++; session = null; vault = null; state = JSONObject(); records = emptyMap(); totals = emptyMap(); staged = emptyList(); packs = emptyList(); extras = emptyMap(); privateUnavailable = emptySet(); item = null; detail = null; sending.clear(); busy = false; offline = false
        bootstrap.purge(); old?.purge(); intake.purge(); shared = emptyList()
        listOf("exports", "camera").forEach { name -> File(context.cacheDir, name).listFiles()?.forEach { it.delete() } }
        message = "Signed out. This account's local drafts, pending jobs, captures and exports were purged."
        scope.launch { withContext(Dispatchers.IO) { runCatching { client.request("/auth/logout", "POST", JSONObject()) } } }
    }
    fun refresh() = action {
        val expected = generation; val client = api()
        try {
            val pages = withContext(Dispatchers.IO) {
                client.request("/auth/session")
                listOf("farms", "facts", "requests", "documents", "reports", "operations", "purchases", "sales", "tasks", "checklists").associateWith { kind -> client.request("/$kind?limit=${recordPageSize(kind)}") }
            }
            if (generation != expected) return@action
            val loaded = pages.mapValues { it.value.optJSONArray("items")?.objects().orEmpty() }
            totals = pages.mapValues { it.value.optInt("total") }
            records = loaded; state.put("totals", JSONObject(totals)); state.put("cache", JSONObject().apply { loaded.forEach { (kind, values) -> put(kind, JSONArray(values)) } }); persist(); offline = false
            val loadedPacks = withContext(Dispatchers.IO) { client.request("/packs").optJSONArray("items")?.objects().orEmpty() }
            if (generation == expected) packs = loadedPacks
            val home = withContext(Dispatchers.IO) { client.request("/workflow/home") }
            if (generation == expected) { extras = extras + ("home" to home); state.put("workflow_home", home); persist() }
        } catch (error: Throwable) {
            if (generation != expected) return@action
            if (error is ApiFailure && error.status in listOf(401, 403, 404)) {
                records = emptyMap(); item = null; extras = emptyMap(); state.remove("cache"); state.remove("workflow_home"); persist(); throw error
            }
            offline = true; message = "Offline or service unavailable. Showing saved records; edits stay on this device until sent explicitly."
        }
    }
    fun loadMore(kind: String) = action {
        val expected = generation; val client = api(); val offset = records[kind].orEmpty().size
        val page = withContext(Dispatchers.IO) { client.request("/$kind?limit=${recordPageSize(kind)}&offset=$offset") }
        if (generation == expected) {
            records = records + (kind to (records[kind].orEmpty() + page.optJSONArray("items")?.objects().orEmpty()).distinctBy { it.optString("id") })
            totals = totals + (kind to page.optInt("total")); state.put("totals", JSONObject(totals)); state.optJSONObject("cache")?.put(kind, JSONArray(records[kind])); persist()
        }
    }
    fun open(kind: String, id: String) {
        detail = kind to id; item = null
        action {
            val expected = generation; val client = api()
            try {
                val value = withContext(Dispatchers.IO) { client.request("/$kind/$id") }
                if (generation == expected && detail == (kind to id)) { item = value; offline = false }
            } catch (error: Throwable) {
                if (generation != expected) return@action
                if (error is ApiFailure && error.status in listOf(401, 403, 404)) { item = null; records = records + (kind to records[kind].orEmpty().filterNot { it.optString("id") == id }); state.optJSONObject("cache")?.put(kind, JSONArray(records[kind])); persist(); throw error }
                item = records[kind]?.find { it.optString("id") == id }; offline = true
                message = "Showing a saved copy. A server revision check is required for changes."
            }
        }
    }
    fun loadExtra(key: String, path: String) = action {
        val expected = generation; val client = api()
        try {
            val response = withContext(Dispatchers.IO) { client.request(path) }
            if (generation == expected) { extras = extras + (key to response); privateUnavailable = privateUnavailable - key }
        } catch (error: Throwable) {
            if (generation == expected && error is ApiFailure && error.status in listOf(401, 403, 404)) { extras = extras - key; privateUnavailable = privateUnavailable + key }
            throw error
        }
    }
    fun postExtra(key: String, path: String, body: JSONObject, draftKey: String? = null) = action {
        val expected = generation; val client = api()
        extras = extras - key
        val response = withContext(Dispatchers.IO) { client.request(path, "POST", body) }
        if (generation == expected) {
            extras = extras + (key to JSONObject(response.toString()).put("_request", JSONObject(body.toString())))
            draftKey?.let(::deleteDraft)
        }
    }
    fun forgetExtra(key: String) { extras = extras - key }
    suspend fun sourceRequest(path: String, method: String = "GET", body: JSONObject? = null, retryId: String? = null): JSONObject {
        val expected = generation; val client = api(); val workspace = session?.getJSONObject("workspace")?.getString("id") ?: throw CancellationException()
        val response = withContext(Dispatchers.IO) { client.request(path, method, body, retryId) }
        if (generation != expected || session == null) throw CancellationException()
        fun checkWorkspace(value: JSONObject) {
            if (value.has("workspace_id")) require(value.getString("workspace_id") == workspace) { "This source does not belong to the open workspace." }
            value.optJSONArray("items")?.objects()?.forEach(::checkWorkspace)
            listOf("rows", "row", "record", "farm").forEach { key -> value.optJSONObject(key)?.let(::checkWorkspace) }
        }
        checkWorkspace(response)
        if (method == "GET" && path.startsWith("/reports/")) offline = false
        return response
    }
    fun saveImportFile(key: String, bytes: ByteArray, filename: String, owner: JSONObject): JSONObject {
        require(session === owner && vault != null) { "The account changed before this file could be saved." }
        require(bytes.isNotEmpty() && bytes.size <= MAX_SOURCE_IMPORT) { "Choose a nonempty CSV no larger than 20 MiB." }
        val decoder = Charsets.UTF_8.newDecoder(); decoder.decode(java.nio.ByteBuffer.wrap(bytes))
        require(bytes.none { it == 0.toByte() }) { "Use UTF-8 text CSV, not a spreadsheet workbook." }
        val old = draft(key, JSONObject())
        require(!old.has("upload_intent")) { "Resolve the pending upload before choosing another source." }
        val file = obj("id" to UUID.randomUUID().toString(), "name" to filename.take(255), "size" to bytes.size)
        vault!!.put(file.getString("id"), bytes)
        val next = JSONObject(old.toString()).put("file", file)
        try { saveDraft(key, next) } catch (error: Throwable) { vault!!.delete(file.getString("id")); throw error }
        old.optJSONObject("file")?.optString("id")?.let { vault!!.delete(it) }
        return next
    }
    fun clearImportFile(key: String) {
        val file = draft(key, JSONObject()).optJSONObject("file")
        deleteDraft(key); file?.optString("id")?.let { vault?.delete(it) }
    }
    suspend fun uploadImportFile(file: JSONObject, fields: JSONObject, retryId: String): JSONObject {
        val expected = generation; val client = api(); val store = vault ?: throw CancellationException()
        val workspace = session!!.getJSONObject("workspace").getString("id")
        val response = withContext(Dispatchers.IO) { val bytes = store.read(file.getString("id")) ?: error("The saved source is missing. Select it again after resolving this upload."); client.uploadImport(bytes, file.getString("name"), fields, retryId) }
        if (generation != expected || session == null) throw CancellationException()
        require(response.getString("workspace_id") == workspace) { "The uploaded source did not match this workspace." }
        return response
    }
    fun checkCapture(key: String, body: JSONObject) = action {
        val expected = generation; val client = api()
        val response = withContext(Dispatchers.IO) { client.request("/workflow/check", "POST", body) }
        if (generation == expected) extras = extras + ("check:$key" to obj("input" to JSONObject(body.toString()), "result" to response))
    }
    fun clearCheck(key: String) { extras = extras - "check:$key" }
    fun submitCapture(key: String, body: JSONObject, acknowledged: List<String>) {
        val checked = extras["check:$key"] ?: error("Check these details before saving.")
        require(checked.getJSONObject("input").toString() == body.toString()) { "Your details changed. Check them again before saving." }
        val result = checked.getJSONObject("result")
        require(result.optBoolean("can_save")) { "Resolve the missing details first." }
        val output = JSONObject(body.toString()).put("check_token", result.getString("check_token")).put("acknowledged_codes", JSONArray(acknowledged))
        enqueue("/workflow/capture", output, draftKey = key)
        clearCheck(key)
    }
    fun previewAnswer(key: String, body: JSONObject) = action {
        val expected = generation; val client = api()
        val input = JSONObject(body.toString()).put("preview", true)
        val response = withContext(Dispatchers.IO) { client.request("/workflow/answer", "POST", input) }
        if (generation == expected) extras = extras + ("answer:$key" to obj("input" to input, "result" to response))
    }
    fun clearAnswer(key: String) { extras = extras - "answer:$key" }
    fun saveAnswer(key: String, body: JSONObject, acknowledged: List<String>) {
        val checked = extras["answer:$key"] ?: error("Check your answer before saving.")
        val input = JSONObject(body.toString()).put("preview", true)
        require(checked.getJSONObject("input").toString() == input.toString()) { "Your answer changed. Check it again." }
        val check = checked.getJSONObject("result").getJSONObject("check")
        require(check.optBoolean("can_save")) { "Resolve the missing details first." }
        input.put("preview", false).put("check_token", check.getString("check_token")).put("acknowledged_codes", JSONArray(acknowledged))
        enqueue("/workflow/answer", input, draftKey = key); clearAnswer(key)
    }
    fun draft(key: String, initial: JSONObject): JSONObject = state.optJSONObject("drafts")?.optJSONObject(key) ?: JSONObject(initial.toString())
    fun saveDraft(key: String, value: JSONObject) {
        val drafts = state.optJSONObject("drafts") ?: JSONObject().also { state.put("drafts", it) }
        drafts.put(key, JSONObject(value.toString())); persist()
    }
    fun deleteDraft(key: String) { state.optJSONObject("drafts")?.remove(key); persist() }
    fun queue(): List<JSONObject> { version; return state.optJSONArray("outbox")?.objects().orEmpty() }
    fun enqueue(path: String, body: JSONObject, method: String = "POST", draftKey: String? = null) {
        val jobs = queue().toMutableList()
        if (draftKey != null && jobs.any { it.optString("draft_key") == draftKey }) {
            message = "This draft already has a pending delivery. Open pending changes in Account to retry or resolve it; no second copy was sent."
            return
        }
        val id = UUID.randomUUID().toString()
        jobs.add(obj("id" to id, "path" to path, "method" to method, "body" to body, "state" to "queued", "draft_key" to draftKey, "created" to java.time.Instant.now().toString()))
        state.put("outbox", JSONArray(jobs)); persist(); message = "Saved on this device. Sending with a stable retry identity."; retry(id)
    }
    fun retry(id: String) {
        val job = queue().find { it.optString("id") == id } ?: return
        if (job.optString("state") == "conflict" || !sending.add(id)) return
        val expected = generation; val client = api(); val store = vault ?: return
        action {
            job.put("state", "sending"); persist()
            try {
                val response = withContext(Dispatchers.IO) {
                    if (job.has("attachment")) {
                        val attachment = job.getJSONObject("attachment")
                        client.upload(store.read(attachment.getString("id")) ?: error("The saved attachment is missing."), attachment.getString("name"), attachment.getString("mime"), id)
                    } else client.request(job.getString("path"), job.getString("method"), job.getJSONObject("body"), id)
                }
                if (generation != expected) return@action
                discard(id); job.optString("draft_key").takeIf { it.isNotBlank() && it != "null" }?.let(::deleteDraft)
                serverVersion++
                message = "Synchronized with your workspace."; refresh(); detail?.let { open(it.first, it.second) }
                if (job.optString("path") in listOf("/workflow/capture", "/workflow/answer")) response.optJSONObject("record")?.let { saved -> open(saved.getString("kind"), saved.getString("id")) }
                if (response.optString("kind") == "reports") open("reports", response.getString("id"))
                if (job.optString("path") == "/cases" && response.optString("kind") == "admin_cases") cases = obj("case_id" to response.getString("id"))
                if (job.optString("path") == "/workflow/onboard") { detail = null; tab = "Home" }
            } catch (error: Throwable) {
                if (generation != expected) return@action
                job.put("state", if (error is ApiFailure && error.status == 409) "conflict" else if (error is ApiFailure && error.status in 400..499) "needs_review" else "queued")
                job.put("error", error.message ?: "Connection interrupted. Retry explicitly."); persist()
                message = when (job.optString("state")) { "conflict" -> "The server changed. Compare the latest record before choosing how to resolve this edit."; "needs_review" -> "The service refused this action. Its draft is retained; inspect the reason before retrying."; else -> "Saved on this device. Open pending changes to retry." }
            } finally { sending.remove(id) }
        }
    }
    fun discard(id: String) {
        val job = queue().find { it.optString("id") == id }
        job?.optJSONObject("attachment")?.optString("id")?.let { vault?.delete(it) }
        state.put("outbox", JSONArray(queue().filterNot { it.optString("id") == id })); persist()
    }
    fun inspectConflict(job: JSONObject) = action {
        val expected = generation; val client = api(); val path = job.getString("path")
        val current = withContext(Dispatchers.IO) {
            when {
                path == "/regulatory/preferences" -> client.request("/regulatory/updates?farm_id=${job.getJSONObject("body").getString("farm_id")}").getJSONObject("preferences")
                path.startsWith("/compliance/farms/") -> client.request(path.substringBefore("/checklist") + "?year=${job.getJSONObject("body").optInt("year", java.time.LocalDate.now().year)}")
                path == "/workflow/capture" || path == "/workflow/answer" -> error("Check the saved details again in their original form. This action will not be rebased automatically.")
                path.startsWith("/cases/") -> client.request("/cases/" + path.removePrefix("/cases/").substringBefore('/').substringBefore('?'))
                path.startsWith("/reports/") -> client.request("/reports/" + path.removePrefix("/reports/").substringBefore('/').substringBefore('?'))
                path == "/reports" -> error("Reload the report list to compare saved previews. Report creation is not rebased automatically.")
                else -> client.request(path.substringBefore("/review").substringBefore("/approve").substringBefore("/reply").substringBefore("/close"))
            }
        }
        if (generation == expected) { job.put("current", current); persist() }
    }
    fun resolveConflict(job: JSONObject) {
        require(job.getString("method") == "PATCH" && job.has("current"))
        require(!job.getString("path").startsWith("/cases/")) { "Compare this preparation job and compose a fresh edit. Its saved payload will not be rebased automatically." }
        val body = JSONObject(job.getJSONObject("body").toString()).put("expected_revision", job.getJSONObject("current").getInt("revision"))
        val path = job.getString("path"); discard(job.getString("id")); enqueue(path, body, "PATCH")
    }
    fun stage(bytes: ByteArray, name: String, mime: String, scan: Boolean = false) {
        require(bytes.isNotEmpty() && bytes.size <= MAX_DOCUMENT)
        require(mime in listOf("application/pdf", "image/png", "image/jpeg", "text/plain")) { "Use PDF, PNG, JPEG or UTF-8 text." }
        if (mime == "text/plain") Charsets.UTF_8.newDecoder().decode(java.nio.ByteBuffer.wrap(bytes))
        val values = if (session == null) shared else staged
        require(values.size < 10 && values.sumOf { it.optLong("size") } + bytes.size <= 30L * 1024 * 1024) { "Finish the current intake first (10 items / 30 MiB total)." }
        val id = UUID.randomUUID().toString(); val store = vault ?: intake
        store.put(id, bytes)
        val result = values + obj("id" to id, "name" to name.take(120), "mime" to mime, "size" to bytes.size, "scan" to scan)
        if (session == null) { shared = result; intake.save("items.json", obj("items" to JSONArray(shared))) }
        else { staged = result; state.put("attachments", JSONArray(staged)); persist() }
        message = "Saved privately on this device. Review before upload."
    }
    fun bindShared() {
        require(session != null)
        val next = (staged + shared).distinctBy { it.getString("id") }
        require(next.size <= 10 && next.sumOf { it.optLong("size") } <= 30L * 1024 * 1024) { "Finish the current intake before binding more shared files." }
        shared.forEach { part -> vault!!.put(part.getString("id"), intake.read(part.getString("id")) ?: error("A shared file could not be restored.")) }
        staged = next; state.put("attachments", JSONArray(staged)); persist()
        intake.purge(); shared = emptyList()
    }
    fun saveAssembledPdf(bytes: ByteArray, pages: List<JSONObject>) {
        require(bytes.isNotEmpty() && bytes.size <= MAX_DOCUMENT)
        val id = UUID.randomUUID().toString()
        vault!!.put(id, bytes)
        val removedIds = pages.map { it.getString("id") }.toSet()
        staged = staged.filterNot { it.getString("id") in removedIds } + obj("id" to id, "name" to "Reviewed scan.pdf", "mime" to "application/pdf", "size" to bytes.size, "scan" to false)
        state.put("attachments", JSONArray(staged)); persist()
        removedIds.forEach { vault!!.delete(it) }
    }
    fun attachmentBytes(part: JSONObject) = vault?.read(part.getString("id")) ?: error("The attachment is unavailable.")
    fun moveAttachment(index: Int, direction: Int) {
        val next = staged.toMutableList(); val target = index + direction
        if (target !in next.indices) return
        val part = next.removeAt(index); next.add(target, part); staged = next; state.put("attachments", JSONArray(staged)); persist()
    }
    fun removeAttachment(part: JSONObject) {
        vault?.delete(part.getString("id")); staged = staged.filterNot { it.optString("id") == part.optString("id") }; state.put("attachments", JSONArray(staged)); persist()
    }
    fun upload(part: JSONObject) {
        require(!part.optBoolean("scan")) { "Assemble reviewed camera pages first." }
        val id = UUID.randomUUID().toString()
        state.put("outbox", JSONArray(queue() + obj("id" to id, "path" to "/documents", "state" to "queued", "attachment" to part)))
        staged = staged.filterNot { it.optString("id") == part.optString("id") }; state.put("attachments", JSONArray(staged)); persist(); retry(id)
    }
    fun notify(value: String) { message = value }
    private fun clearReportExports(incompleteOnly: Boolean = false) {
        val directory = File(context.cacheDir, "exports").canonicalFile
        directory.listFiles()?.filter { it.isFile && it.canonicalFile.parentFile == directory && (!incompleteOnly || it.name.endsWith(".partial")) }?.forEach { it.delete() }
    }
    fun cancelReportExport(tellUser: Boolean = false) {
        reportTransfer?.cancel(); exportJob?.cancel(); reportTransfer = null; exportJob = null; exporting = false
        if (tellUser) message = "Export cancelled. Incomplete private file removed."
    }
    fun export(record: JSONObject, format: String, completed: (File) -> Unit) {
        if (exporting) { message = "Finish or cancel the current export first."; return }
        try {
            require(format in listOf("pdf", "csv", "json", "xlsx"))
            require(session != null && record.getString("workspace_id") == session!!.getJSONObject("workspace").getString("id"))
            require(record.data().optString("status") == "issued") { "Only an approved report can be exported." }
            val expected = generation; val client = api()
            val directory = File(context.cacheDir, "exports").apply { mkdirs() }
            clearReportExports()
            val budget = minOf(REPORT_EXPORT_BUDGET, directory.usableSpace - REPORT_DISK_RESERVE)
            if (budget <= 0) { message = "Free private device storage before exporting; 32 MiB is kept available."; return }
            val file = File(directory, "farm-report-${UUID.randomUUID()}.$format")
            val transfer = ReportFileTransfer(File(directory, file.name + ".partial"), budget)
            reportTransfer = transfer; exporting = true
            exportJob = scope.launch {
                var shared = false
                try {
                    withContext(Dispatchers.IO) { client.streamReport("/reports/${record.getString("id")}/download?format=$format", transfer) }
                    if (generation != expected || session == null) throw CancellationException()
                    transfer.check()
                    require(transfer.file.renameTo(file)) { "The completed export could not be prepared for sharing. Free storage and retry." }
                    completed(file); shared = true
                } catch (error: CancellationException) { /* The cancellation owner removes this private file. */ }
                catch (error: Throwable) { if (generation == expected && !transfer.cancelled) message = error.message ?: "The export could not finish. No incomplete file was shared." }
                finally {
                    if (!shared) { transfer.file.delete(); file.delete() }
                    if (reportTransfer === transfer) { reportTransfer = null; exportJob = null; exporting = false }
                }
            }
        } catch (error: Throwable) { cancelReportExport(); message = error.message ?: "The private export could not be prepared. No file was shared." }
    }
    fun original(record: JSONObject, completed: (ByteArray) -> Unit) = action {
        val expected = generation; val client = api()
        val bytes = withContext(Dispatchers.IO) { client.download("/documents/${record.getString("id")}/file") }
        if (generation == expected) completed(bytes)
    }
    fun exportCaseField(path: String, completed: (File, String) -> Unit) {
        if (exporting) { message = "Finish or cancel the current private download first."; return }
        try {
            val uri = java.net.URI(path)
            require(uri.scheme == null && uri.rawAuthority == null && uri.rawFragment == null)
            val match = Regex("^/field-proposals/([0-9a-fA-F-]{36})/export$").matchEntire(uri.path) ?: error("This is not a supported field-change download.")
            UUID.fromString(match.groupValues[1])
            val arguments = uri.rawQuery.orEmpty().split('&').map { it.split('=', limit = 2) }
            require(arguments.size == 2 && arguments.all { it.size == 2 } && arguments.map { it[0] }.toSet() in listOf(setOf("format", "expected_revision"), setOf("format", "retained_revision"))) { "A field export needs exactly one current or retained reviewed revision." }
            val query = arguments.associate { it[0] to it[1] }; val format = query.getValue("format")
            require(format in listOf("geojson", "correction", "kml") && (query["expected_revision"] ?: query["retained_revision"])?.toIntOrNull()?.let { it > 0 } == true)
            streamCaseExport(path, "field-change", if (format == "correction") "json" else format, when (format) { "kml" -> "application/vnd.google-earth.kml+xml"; "geojson" -> "application/geo+json"; else -> "application/json" }, REPORT_EXPORT_BUDGET, completed = completed)
        } catch (error: Throwable) { message = error.message ?: "The revision-bound field export could not be prepared." }
    }
    fun exportCasePacket(path: String, caseId: String, completed: (File, String) -> Unit) {
        if (exporting) { message = "Finish or cancel the current private download first."; return }
        try {
            val uri = java.net.URI(path)
            require(uri.scheme == null && uri.rawAuthority == null && uri.rawFragment == null)
            val match = Regex("^/cases/([0-9a-fA-F-]{36})/packet$").matchEntire(uri.path) ?: error("This is not a supported prepared-folder download.")
            require(UUID.fromString(match.groupValues[1]) == UUID.fromString(caseId)) { "This prepared folder belongs to a different job." }
            val arguments = uri.rawQuery.orEmpty().split('&').map { it.split('=', limit = 2) }
            require(arguments.size == 2 && arguments.all { it.size == 2 } && arguments.map { it[0] }.toSet() in listOf(setOf("expected_revision", "reference_fingerprint"), setOf("retained_revision", "reference_fingerprint"))) { "A prepared folder needs exactly one reviewed revision and its source fingerprint." }
            val query = arguments.associate { it[0] to it[1] }
            require((query["expected_revision"] ?: query["retained_revision"])?.toIntOrNull()?.let { it > 0 } == true && query.getValue("reference_fingerprint").matches(Regex("[0-9a-fA-F]{64}"))) { "The prepared-folder review identity is invalid. Reload this job." }
            streamCaseExport(path, "prepared-folder", "zip", "application/zip", 128L * 1024 * 1024, expectedMime = "application/zip", completed = completed)
        } catch (error: Throwable) { message = error.message ?: "The complete prepared folder could not be prepared. No file was shared." }
    }
    private fun streamCaseExport(path: String, prefix: String, suffix: String, mime: String, maximumBytes: Long, expectedMime: String? = null, completed: (File, String) -> Unit) {
        try {
            require(session != null)
            val expected = generation; val sourceVersion = serverVersion; val client = api()
            val directory = File(context.cacheDir, "exports").apply { mkdirs() }; clearReportExports()
            val budget = minOf(maximumBytes, directory.usableSpace - REPORT_DISK_RESERVE)
            require(budget > 0) { "Free private storage before downloading; 32 MiB is kept available." }
            val file = File(directory, "$prefix-${UUID.randomUUID()}.$suffix")
            val transfer = ReportFileTransfer(File(directory, file.name + ".partial"), budget)
            reportTransfer = transfer; exporting = true
            exportJob = scope.launch {
                var shared = false
                try {
                    withContext(Dispatchers.IO) { client.streamReport(path, transfer, expectedMime) }
                    if (generation != expected || session == null) throw CancellationException()
                    require(serverVersion == sourceVersion) { "The signed-in source context changed during download. Reload the job before sharing." }
                    transfer.check(); require(transfer.file.renameTo(file)) { "The complete private file could not be prepared for sharing." }
                    completed(file, mime); shared = true
                } catch (error: CancellationException) { /* Sign-out, context disposal or explicit cancellation owns cleanup. */ }
                catch (error: Throwable) { if (generation == expected && !transfer.cancelled) message = error.message ?: "The complete private download could not finish. No incomplete file was shared." }
                finally { if (!shared) { transfer.file.delete(); file.delete() }; if (reportTransfer === transfer) { reportTransfer = null; exportJob = null; exporting = false } }
            }
        } catch (error: Throwable) { cancelReportExport(); message = error.message ?: "The private file could not be prepared. No file was shared." }
    }
}
