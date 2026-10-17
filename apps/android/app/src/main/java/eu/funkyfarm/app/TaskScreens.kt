package eu.funkyfarm.app

import android.net.Uri
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.text.selection.SelectionContainer
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.launch
import org.json.JSONArray
import org.json.JSONObject
import java.util.UUID

private val taskStates = listOf("open" to "Not started", "in_progress" to "In progress", "done" to "Completed by a person", "cancelled" to "Cancelled")
private val taskKeyboard = KeyboardOptions(autoCorrectEnabled = false)
private const val TASK_PAGE_SIZE = 20

private fun taskStatus(data: JSONObject): String {
    val value = data.opt("status")
    if (value == null || value === JSONObject.NULL) return "open"
    require(value is String && taskStates.any { it.first == value }) { "This task has an unsupported status. Reload it or ask the owner to check it; no progress has been assumed." }
    return value
}

private fun taskFarmId(data: JSONObject): String {
    val value = data.opt("farm_id")
    require(value is String && value.matches(Regex("[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}"))) { "This task has no valid linked farm. Ask the owner to check its farm scope before answering." }
    return UUID.fromString(value).toString()
}

internal fun openNativeTaskHref(model: FarmModel, href: String): Boolean = runCatching {
    val uri = Uri.parse(href)
    if (uri.scheme != null || uri.authority != null || uri.fragment != null) return@runCatching false
    if (uri.path == "/app/tasks") {
        val farm = uri.getQueryParameter("farm_id")?.let { UUID.fromString(it).toString() }.orEmpty()
        model.detail = "tasks" to if (farm.isBlank()) "" else "list:$farm"
        true
    } else {
        val match = Regex("^/app/tasks/([0-9a-fA-F-]{36})$").matchEntire(uri.path.orEmpty()) ?: return@runCatching false
        model.detail = "tasks" to UUID.fromString(match.groupValues[1]).toString(); true
    }
}.getOrDefault(false)

@Composable internal fun TaskDestination(model: FarmModel, destination: String) {
    val session = model.session ?: return
    val binding = "${model.origin}:${session.getJSONObject("user").getString("id")}:${session.getJSONObject("workspace")}:$destination:${model.serverVersion}"
    key(binding) {
        if (destination.isBlank() || destination.startsWith("list:")) TaskList(model, destination.removePrefix("list:"), session)
        else TaskQuestion(model, destination, session)
    }
}

@Composable private fun TaskList(model: FarmModel, initialFarm: String, owner: JSONObject) {
    var farmId by remember { mutableStateOf(initialFarm) }; var offset by remember { mutableStateOf(0) }; var attempt by remember { mutableStateOf(0) }
    var page by remember { mutableStateOf<JSONObject?>(null) }; var loading by remember { mutableStateOf(false) }; var problem by remember { mutableStateOf("") }
    LaunchedEffect(farmId, offset, attempt) {
        page = null; loading = true; problem = ""
        try {
            val result = model.sourceRequest("/tasks?limit=$TASK_PAGE_SIZE&offset=$offset" + if (farmId.isBlank()) "" else "&farm_id=${UUID.fromString(farmId)}")
            if (model.session !== owner) throw CancellationException()
            require(result.getJSONArray("items").objects().all { farmId.isBlank() || it.data().text("farm_id") == farmId }) { "The task list did not match the chosen farm." }
            result.getJSONArray("items").objects().forEach { taskStatus(it.data()) }
            page = result
        } catch (error: CancellationException) { throw error }
        catch (error: Throwable) { problem = sourceFailure(error) }
        finally { loading = false }
    }
    Text("Tasks and questions", style = MaterialTheme.typography.headlineSmall, fontWeight = FontWeight.Bold)
    Text("Open a question, record your own answer and choose its actual progress. Saving an answer does not confirm a fact, issue a report or send anything to an authority.")
    val farms = model.records["farms"].orEmpty()
    val choices = listOf("" to "All farms I can access") + farms.map { it.getString("id") to it.title() } + if (farmId.isNotBlank() && farms.none { it.getString("id") == farmId }) listOf(farmId to "Farm selected by this task link") else emptyList()
    Choice("Farm for these tasks", farmId, choices) { farmId = it; offset = 0; page = null }
    if (farms.size < (model.totals["farms"] ?: 0)) OutlinedButton(onClick = { model.loadMore("farms") }, enabled = !model.busy) { Text("Load more farm choices") }
    if (loading) Text("Loading current tasks…")
    if (problem.isNotBlank()) Text(problem, color = MaterialTheme.colorScheme.error)
    OutlinedButton(onClick = { page = null; attempt++ }, enabled = !loading) { Text("Reload tasks and questions") }
    page?.let { result ->
        val rows = result.getJSONArray("items").objects(); val total = result.getInt("total")
        Text("${if (rows.isEmpty()) 0 else offset + 1}–${offset + rows.size} of $total tasks. Includes retained completed and cancelled tasks; this is not just the Home preview.")
        if (rows.isEmpty()) Text("No tasks are shown for this choice. This does not establish that no other work or missing information exists.")
        rows.forEach { task -> Card(onClick = { model.detail = "tasks" to task.getString("id") }, modifier = Modifier.fillMaxWidth()) { Column(Modifier.padding(14.dp), verticalArrangement = Arrangement.spacedBy(5.dp)) {
            Text(task.title(), fontWeight = FontWeight.Bold); Text(taskStates.first { it.first == taskStatus(task.data()) }.second)
            Text("Due: ${task.data().text("due_date").ifBlank { "Not recorded" }}")
            if (task.data().text("purpose") == "missing_information") Text("A question for the farmer · an answer or explanation is required before completion or cancellation")
        } } }
        Row { TextButton(onClick = { offset = maxOf(0, offset - TASK_PAGE_SIZE); page = null }, enabled = !loading && offset > 0) { Text("Previous tasks") }; TextButton(onClick = { offset += rows.size; page = null }, enabled = !loading && rows.isNotEmpty() && offset + rows.size < total) { Text("Next tasks") } }
    }
}

private fun taskCanWrite(owner: JSONObject, farmId: String): Boolean {
    if (runCatching { taskFarmId(obj("farm_id" to farmId)) }.isFailure) return false
    val workspace = owner.getJSONObject("workspace")
    val grant = workspace.optJSONArray("farm_ids")
    if (grant != null && (0 until grant.length()).none { grant.optString(it) == farmId }) return false
    val permissions = workspace.optJSONArray("permissions") ?: JSONArray()
    return workspace.text("role") == "owner" || (0 until permissions.length()).any { permissions.optString(it) == "review" }
}

@Composable private fun TaskQuestion(model: FarmModel, id: String, owner: JSONObject) {
    val key = "task-answer:$id"; val scope = rememberCoroutineScope()
    var record by remember { mutableStateOf<JSONObject?>(null) }; var farm by remember { mutableStateOf<JSONObject?>(null) }; var draft by remember { mutableStateOf(model.draft(key, JSONObject())) }
    var attempt by remember { mutableStateOf(0) }; var loading by remember { mutableStateOf(true) }; var saving by remember { mutableStateOf(false) }
    var problem by remember { mutableStateOf("") }; var fresh by remember { mutableStateOf(false) }; var discard by remember { mutableStateOf(false) }
    val pending = draft.optJSONObject("pending")
    LaunchedEffect(id, attempt) {
        loading = true; fresh = false; record = null; farm = null; problem = ""
        try {
            val result = model.sourceRequest("/tasks/${UUID.fromString(id)}")
            if (model.session !== owner) throw CancellationException()
            require(result.getString("id") == id && result.getString("kind") == "tasks") { "The current task did not match this question." }
            val farmId = taskFarmId(result.data())
            val linkedFarm = model.sourceRequest("/farms/$farmId")
            if (model.session !== owner) throw CancellationException()
            require(linkedFarm.getString("id") == farmId && linkedFarm.getString("kind") == "farms") { "The authorised farm did not match this task. Its answer cannot be changed." }
            val checked = JSONObject(result.toString()).apply { getJSONObject("data").put("status", taskStatus(result.data())) }
            if (!draft.has("expected_revision")) { draft = obj("expected_revision" to checked.getInt("revision"), "notes" to checked.data().text("notes"), "status" to checked.data().getString("status")); model.saveDraft(key, draft) }
            farm = linkedFarm; record = checked; fresh = true
        } catch (error: CancellationException) { throw error }
        catch (error: Throwable) { problem = sourceFailure(error); if (error is ApiFailure && error.status in listOf(401, 403, 404)) { model.deleteDraft(key); draft = JSONObject() } }
        finally { loading = false }
    }
    Text("Answer a question or update a task", style = MaterialTheme.typography.headlineSmall, fontWeight = FontWeight.Bold)
    if (loading) Text("Opening the current authorised task…")
    if (problem.isNotBlank()) Text(problem, color = MaterialTheme.colorScheme.error)
    OutlinedButton(onClick = { fresh = false; record = null; attempt++ }, enabled = !loading && !saving) { Text("Reload this question and its saved answer") }
    record?.let { task ->
        val data = task.data(); val farmId = data.text("farm_id"); val canWrite = farm?.getString("id") == taskFarmId(data) && taskCanWrite(owner, farmId)
        val matches = draft.optInt("expected_revision") == task.getInt("revision")
        val requiresAnswer = data.text("purpose") == "missing_information"
        Text(task.title(), style = MaterialTheme.typography.titleLarge, fontWeight = FontWeight.Bold)
        Text("Farm: ${farm?.title() ?: "Not recorded"}")
        Text("Original question or task", style = MaterialTheme.typography.labelLarge)
        SelectionContainer { Text(data.text("description").ifBlank { "No additional question text was supplied." }) }
        Text("Due: ${data.text("due_date").ifBlank { "Not recorded" }} · Assigned to: ${data.text("assignee").ifBlank { "Not recorded" }}")
        if (data.text("asked_at").isNotBlank()) Text("Question recorded: ${data.text("asked_at")}")
        Text("Saved answer and progress · revision ${task.getInt("revision")}", style = MaterialTheme.typography.titleMedium)
        SelectionContainer { Text(data.text("notes").ifBlank { "No answer or notes saved yet." }) }
        Text(taskStates.find { it.first == data.text("status") }?.second ?: data.text("status"))
        if (requiresAnswer) Text("Write the actual answer before completing this question, or explain why you are cancelling it. A reply is not a reviewed farm fact; any underlying record still needs its own separate review.")
        if (!canWrite) Text("Your current grant is read-only for this farm. You can read this question and its saved answer, but cannot change it.")
        if (!matches) Text("The task changed after this device draft started. Compare the current question and answer above. Your draft is retained, but will not be rebased onto the new revision.", color = MaterialTheme.colorScheme.error)
        OutlinedTextField(draft.text("notes"), { draft = JSONObject(draft.toString()).put("notes", it); model.saveDraft(key, draft) }, label = { Text(if (requiresAnswer) "Your answer or explanation · required before completion or cancellation" else "Your notes or answer") }, keyboardOptions = taskKeyboard, enabled = canWrite && !loading && !saving && pending == null, modifier = Modifier.fillMaxWidth().heightIn(min = 120.dp))
        val noteLength = draft.text("notes").let { it.codePointCount(0, it.length) }
        Text("$noteLength / 4000 characters")
        if (noteLength > 4000) Text("Shorten the answer to 4000 characters before saving. Your text has not been truncated.", color = MaterialTheme.colorScheme.error)
        if (canWrite && pending == null) Choice("Actual task progress", draft.text("status"), taskStates) { if (!loading && !saving) { draft = JSONObject(draft.toString()).put("status", it); model.saveDraft(key, draft) } }
        else Text("Device draft progress: ${taskStates.find { it.first == draft.text("status") }?.second ?: "Not supplied"}")
        if (requiresAnswer && draft.text("status") in listOf("done", "cancelled") && draft.text("notes").isBlank()) Text("Add your answer or explanation before completing or cancelling the question.", color = MaterialTheme.colorScheme.error)
        val maySave = fresh && canWrite && !loading && !saving && (pending != null && pending.text("state") != "conflict" || pending == null && matches && noteLength <= 4000 && taskStates.any { it.first == draft.text("status") } && (!requiresAnswer || draft.text("status") !in listOf("done", "cancelled") || draft.text("notes").isNotBlank()))
        Button(onClick = { scope.launch {
            saving = true; problem = ""
            try {
                require(model.session === owner && canWrite && fresh)
                val intent = pending ?: obj("key" to UUID.randomUUID().toString(), "body" to obj("expected_revision" to draft.getInt("expected_revision"), "data" to obj("notes" to draft.text("notes"), "status" to draft.getString("status"))), "state" to "pending").also { draft = JSONObject(draft.toString()).put("pending", it); model.saveDraft(key, draft) }
                val result = model.sourceRequest("/tasks/$id", "PATCH", intent.getJSONObject("body"), intent.getString("key"))
                if (model.session !== owner) throw CancellationException()
                require(result.getString("id") == id && result.data().text("farm_id") == farmId)
                model.deleteDraft(key); draft = JSONObject(); fresh = false; record = null; attempt++; model.notify("Your answer and task progress were saved. The original question was kept unchanged."); model.refresh()
            } catch (error: CancellationException) { throw error }
            catch (error: Throwable) {
                if (model.session === owner) {
                    problem = sourceFailure(error)
                    if (error is ApiFailure && error.status == 422) { draft = JSONObject(draft.toString()).apply { remove("pending") }; model.saveDraft(key, draft) }
                    if (error is ApiFailure && error.status == 409) { draft = JSONObject(draft.toString()).apply { optJSONObject("pending")?.put("state", "conflict") }; model.saveDraft(key, draft); fresh = false }
                    if (error is ApiFailure && error.status in listOf(401, 403, 404)) { record = null; fresh = false; model.deleteDraft(key); draft = JSONObject() }
                }
            } finally { if (model.session === owner) saving = false }
        } }, enabled = maySave) { Text(if (pending == null) "Save my answer and actual progress" else "Retry this exact saved answer") }
        if (pending != null) Text("An answer delivery is unresolved. Exact retry uses the saved body and delivery identity, not newly edited text. A conflict needs comparison and a fresh decision; it is never silently rebased.")
        TextButton(onClick = { discard = true }, enabled = !loading && !saving) { Text("Discard device answer after comparison") }
        listOf("document_id" to "Open the original linked document", "request_id" to "Open the linked letter or request").forEach { (field, label) -> data.text(field).takeIf(String::isNotBlank)?.let { linked -> TaskSourceLink(model, owner, farmId, if (field == "document_id") "documents" else "requests", linked, label) } }
        OutlinedButton(onClick = { model.detail = null; model.tab = "Documents" }) { Text("Open Documents to add a real file") }
        Text("Adding a document is a separate action. It does not attach a file to this answer, confirm extracted information or mark the task completed.", style = MaterialTheme.typography.bodySmall)
        OutlinedButton(onClick = { model.detail = "tasks" to if (farmId.isBlank()) "" else "list:$farmId" }) { Text("See this farm's tasks and questions") }
    }
    if (discard) AlertDialog(onDismissRequest = { discard = false }, title = { Text("Discard this device answer?") }, text = { Text("Compare the saved server answer first. A lost response may already have committed it. This removes only the device draft and retry intent; it does not change the original question or any saved answer. A new draft will start from the freshly loaded revision.") }, confirmButton = { TextButton(onClick = { model.deleteDraft(key); draft = JSONObject(); fresh = false; record = null; discard = false; attempt++ }) { Text("Discard device draft and reload") } }, dismissButton = { TextButton(onClick = { discard = false }) { Text("Keep my draft") } })
}

@Composable private fun TaskSourceLink(model: FarmModel, owner: JSONObject, farmId: String, kind: String, id: String, label: String) {
    val scope = rememberCoroutineScope(); var loading by remember { mutableStateOf(false) }; var problem by remember { mutableStateOf("") }
    OutlinedButton(onClick = { scope.launch {
        loading = true; problem = ""
        try {
            val result = model.sourceRequest("/$kind/${UUID.fromString(id)}")
            if (model.session !== owner) throw CancellationException()
            require(result.getString("id") == id && result.data().text("farm_id") == farmId && farmId.isNotBlank()) { "This source is not linked to the same farm. No unrelated document has been opened." }
            model.open(kind, id)
        } catch (error: CancellationException) { throw error }
        catch (error: Throwable) { problem = sourceFailure(error) }
        finally { loading = false }
    } }, enabled = !loading) { Text(label) }
    if (problem.isNotBlank()) Text(problem, color = MaterialTheme.colorScheme.error)
}
