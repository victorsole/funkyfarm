package eu.funkyfarm.app

import android.content.Context
import android.net.Uri
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
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
    private val nativeSignIn = NativeSignIn(context)
    private var vault: PrivateStore? = null
    private var state = JSONObject()
    private var generation = 0
    private var providerLookup = 0
    private var nativeAttempt = 0
    var session by mutableStateOf<JSONObject?>(null); private set
    var origin by mutableStateOf("http://10.0.2.2:8139"); private set
    var tab by mutableStateOf("Home")
    var detail by mutableStateOf<Pair<String, String>?>(null)
    var administration by mutableStateOf<Pair<String, String?>?>(null)
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
    var ssoProviders by mutableStateOf<List<JSONObject>>(emptyList()); private set
    var ssoProviderOrigin by mutableStateOf(""); private set
    var ssoPending by mutableStateOf(false); private set
    private val sending = mutableSetOf<String>()
    init {
        runCatching {
            val stored = bootstrap.json("auth.json")
            if (stored.has("session")) activate(stored.getJSONObject("session"), stored.getString("origin"))
            shared = intake.json("items.json").optJSONArray("items")?.objects().orEmpty()
            ssoPending = nativeSignIn.hasPending()
        }.onFailure { message = "Private saved data could not be unlocked. Sign in again; no data has been sent." }
    }
    fun api() = Api(origin, session?.optString("token").orEmpty(), session?.optJSONObject("workspace")?.optString("id").orEmpty())
    private fun activate(auth: JSONObject, endpoint: String) {
        nativeSignIn.cancel(); ssoPending = false
        generation++; origin = endpoint; session = auth; administration = null
        vault = PrivateStore(context, auth.getJSONObject("user").getString("id") + ":" + auth.getJSONObject("workspace").getString("id"))
        state = vault!!.json("workspace.json")
        staged = state.optJSONArray("attachments")?.objects().orEmpty()
        records = state.optJSONObject("cache")?.let { cache -> cache.keys().asSequence().associateWith { cache.optJSONArray(it)?.objects().orEmpty() } }.orEmpty()
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
        cancelNativeSignIn()
        val credentials = obj("email" to email.trim(), "password" to password)
        if (register) credentials.put("display_name", name.trim())
        val response = withContext(Dispatchers.IO) { Api(endpoint).request(if (register) "/auth/register" else "/auth/login", "POST", credentials) }
        activate(response, endpoint); message = "Signed in to your private workspace."; refresh()
    }
    fun loadSignInProviders(endpoint: String) = action {
        ssoProviders = emptyList(); ssoProviderOrigin = ""
        val expected = generation; val lookup = ++providerLookup
        val response = withContext(Dispatchers.IO) { Api(endpoint).request("/auth/sso/providers") }
        if (generation == expected && lookup == providerLookup && session == null && response.optJSONArray("native_redirect_uris").strings().contains(NATIVE_SIGN_IN_REDIRECT)) {
            ssoProviders = response.optJSONArray("providers")?.objects().orEmpty()
            ssoProviderOrigin = endpoint
        }
    }
    fun beginNativeSignIn(endpoint: String, provider: JSONObject, launch: (Uri) -> Unit) {
        runCatching {
            require(session == null && !ssoPending && endpoint == ssoProviderOrigin && ssoProviders.any { it.toString() == provider.toString() }) { "Refresh the configured sign-in options before continuing." }
            val uri = nativeSignIn.start(endpoint, provider)
            ssoPending = true
            launch(uri)
            message = "Continue in your browser, or cancel browser sign-in here."
        }.onFailure { nativeSignIn.cancel(); ssoPending = false; message = "The browser sign-in could not start. Check the service address or use your password." }
    }
    fun cancelNativeSignIn() { nativeAttempt++; nativeSignIn.cancel(); ssoPending = false }
    fun completeNativeSignIn(uri: Uri) = action {
        require(session == null) { "Already signed in. Sign out before choosing another account." }
        val callback = try { nativeSignIn.callback(uri) } finally { ssoPending = nativeSignIn.hasPending() }
        val expected = generation; val attempt = ++nativeAttempt
        val response = withContext(Dispatchers.IO) { Api(callback.first).request("/auth/sso/native/token", "POST", callback.second) }
        require(response.optString("token").isNotBlank() && response.optString("csrf_token").isNotBlank() && response.has("user") && response.has("workspace")) { "The sign-in session is incomplete. Start again." }
        if (generation != expected || nativeAttempt != attempt || session != null) {
            withContext(Dispatchers.IO) { runCatching { Api(callback.first, response.getString("token"), response.getJSONObject("workspace").getString("id")).request("/auth/logout", "POST", JSONObject()) } }
            return@action
        }
        activate(response, callback.first); message = "Signed in to your private workspace."; refresh()
    }
    fun logout() {
        cancelNativeSignIn(); ssoProviders = emptyList(); ssoProviderOrigin = ""
        val client = api(); val old = vault; administration = null
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
                listOf("farms", "facts", "requests", "documents", "reports", "operations", "purchases", "sales", "tasks", "checklists").associateWith { kind -> client.request("/$kind?limit=200") }
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
        val page = withContext(Dispatchers.IO) { client.request("/$kind?limit=200&offset=$offset") }
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
                else -> client.request(path.substringBefore("/review").substringBefore("/approve").substringBefore("/reply").substringBefore("/close"))
            }
        }
        if (generation == expected) { job.put("current", current); persist() }
    }
    fun resolveConflict(job: JSONObject) {
        require(job.getString("method") == "PATCH" && job.has("current"))
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
    fun export(record: JSONObject, format: String, completed: (ByteArray) -> Unit) = action {
        val expected = generation; val client = api()
        val bytes = withContext(Dispatchers.IO) { client.download("/reports/${record.getString("id")}/download?format=$format") }
        if (generation == expected) completed(bytes)
    }
    fun original(record: JSONObject, completed: (ByteArray) -> Unit) = action {
        val expected = generation; val client = api()
        val bytes = withContext(Dispatchers.IO) { client.download("/documents/${record.getString("id")}/file") }
        if (generation == expected) completed(bytes)
    }
}
