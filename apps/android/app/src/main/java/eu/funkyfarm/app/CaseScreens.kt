package eu.funkyfarm.app

import android.content.Intent
import android.net.Uri
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.text.selection.SelectionContainer
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalClipboardManager
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.AnnotatedString
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.launch
import org.json.JSONArray
import org.json.JSONObject
import java.io.File
import java.net.URI
import java.time.LocalDate
import java.util.UUID

private val caseJobs = listOf("fields" to "Check my fields", "correction" to "Correct something already sent", "inspection" to "Prepare for an inspection")
private val caseKinds = listOf("documents" to "Documents", "requests" to "Letters and requests", "reports" to "Reports", "field_change_proposals" to "Field changes", "facts" to "Checked farm answers", "operations" to "Work records", "checklists" to "Checklists", "tasks" to "Tasks")
private val caseRoles = listOf("original" to "What was originally sent", "notice" to "Letter or inspection notice", "change" to "What needs to change", "response" to "My prepared response", "evidence" to "Supporting evidence")
private val caseKeyboard = KeyboardOptions(autoCorrectEnabled = false)
private const val CASE_PAGE_SIZE = 5
private fun caseActions(status: String): List<Pair<String, String>> = listOf("sent" to "I sent the prepared material myself", "receipt" to "I received a receipt", "needs_changes" to "I received a request for changes", "accepted" to "I received an acceptance decision", "reopen" to "Reopen this preparation job", "cancelled" to "Cancel this job in my workspace").filter { (action, _) -> when (action) { "sent" -> status == "ready_to_send"; "receipt", "accepted" -> status in listOf("sent", "receipt_saved"); "needs_changes" -> status in listOf("sent", "receipt_saved", "accepted_recorded"); "reopen" -> status in listOf("ready_to_send", "sent", "receipt_saved", "accepted_recorded", "needs_changes", "cancelled"); else -> status != "cancelled" } }
private fun caseStatus(value: String) = when (value) { "draft" -> "Being prepared"; "ready_to_send" -> "Reviewed · not sent"; "sent" -> "Sending recorded by you"; "receipt_saved" -> "Receipt recorded by you"; "needs_changes" -> "Changes requested · recorded by you"; "accepted_recorded" -> "Acceptance recorded by you · not verified"; "cancelled" -> "Cancelled in this workspace"; else -> value.replace('_', ' ') }
private fun casePin(reference: JSONObject) = obj("kind" to reference.getString("kind"), "id" to reference.getString("id"), "revision" to reference.getInt("revision"), "role" to reference.getString("role"))
private fun caseRefKey(reference: JSONObject) = "${reference.text("kind")}:${reference.text("id")}:${reference.text("role")}"
private fun casePending(model: FarmModel, id: String) = model.queue().any { it.text("path").substringBefore('?') == "/cases/$id" || it.text("path").startsWith("/cases/$id/") }
private fun caseOptionalDate(raw: String): Any = if (raw.isBlank()) JSONObject.NULL else LocalDate.parse(raw).toString()

@Composable internal fun CaseStarts(model: FarmModel, farmId: String? = null) {
    Text("What do you need to get ready?", style = MaterialTheme.typography.titleLarge)
    caseJobs.forEach { (job, label) -> OutlinedButton(onClick = { model.cases = obj("job_type" to job, "farm_id" to farmId, "create" to true) }, modifier = Modifier.fillMaxWidth()) { Text(label) } }
    TextButton(onClick = { model.cases = obj("farm_id" to farmId) }) { Text("My preparation jobs and recorded replies") }
}

@Composable internal fun CaseDestination(model: FarmModel, route: JSONObject, share: (File, String) -> Unit, close: () -> Unit) {
    val id = route.text("case_id")
    if (id.isNotBlank()) CaseDetail(model, id, share, close)
    else CaseList(model, route, close)
}

@Composable private fun CaseList(model: FarmModel, route: JSONObject, close: () -> Unit) {
    var farmId by remember { mutableStateOf(route.text("farm_id").ifBlank { model.records["farms"].orEmpty().singleOrNull()?.getString("id").orEmpty() }) }; var job by remember { mutableStateOf(route.text("job_type")) }
    var offset by remember { mutableStateOf(0) }; var reload by remember { mutableStateOf(0) }
    var page by remember { mutableStateOf<JSONObject?>(null) }; var loading by remember { mutableStateOf(false) }; var problem by remember { mutableStateOf("") }; var saved by remember { mutableStateOf(false) }
    var create by remember { mutableStateOf(route.optBoolean("create")) }
    val binding = "$farmId:$job:$offset"; val cacheKey = "case-list:$binding"
    LaunchedEffect(binding, reload, model.serverVersion) {
        page = model.draft(cacheKey, JSONObject()).optJSONObject("page"); saved = page != null; loading = true; problem = ""
        try {
            if (farmId.isBlank()) { page = null; saved = false; return@LaunchedEffect }
            val response = model.sourceRequest("/cases?farm_id=$farmId&limit=$CASE_PAGE_SIZE&offset=$offset" + (if (job.isNotBlank()) "&job_type=$job" else ""))
            page = response; saved = false; model.saveDraft(cacheKey, obj("page" to response))
        } catch (error: CancellationException) { throw error }
        catch (error: Throwable) { problem = sourceFailure(error); if (error is ApiFailure && error.status in listOf(401, 403, 404)) { page = null; saved = false; model.deleteDraft(cacheKey) } }
        finally { loading = false }
    }
    Sheet("My preparation jobs", close) {
        Text("Keep the original, the changes you are preparing, and the replies you actually receive together. This app does not send a submission or verify an authority's decision.")
        Choice("Farm", farmId, listOf("" to "Choose the actual farm") + model.records["farms"].orEmpty().map { it.getString("id") to it.title() }) { farmId = it; offset = 0; page = null }
        if (farmId.isBlank()) Text("Choose a farm to load its preparation jobs. Jobs from different farms are not mixed together.")
        Choice("Which job?", job, listOf("" to "All preparation jobs") + caseJobs) { job = it; offset = 0; page = null }
        if (model.records["farms"].orEmpty().size < (model.totals["farms"] ?: 0)) OutlinedButton(onClick = { model.loadMore("farms") }, enabled = !model.busy) { Text("Load more farm choices") }
        Button(onClick = { create = true }) { Text("Start a preparation job") }
        if (loading) Text("Loading preparation jobs…")
        if (problem.isNotBlank()) Text(problem, color = MaterialTheme.colorScheme.error)
        if (saved) Text("Saved copy · reconnect before reviewing current sources.")
        OutlinedButton(onClick = { reload++ }, enabled = !loading) { Text("Reload preparation jobs") }
        page?.let { response ->
            val rows = response.getJSONArray("items").objects(); val total = response.getInt("total")
            Text("${if (rows.isEmpty()) 0 else offset + 1}–${offset + rows.size} of $total preparation jobs")
            if (rows.isEmpty()) Text("No jobs are shown for these choices. Start with the actual letter, field change or problem you have.")
            rows.forEach { record -> Card(onClick = { model.cases = obj("case_id" to record.getString("id")) }, modifier = Modifier.fillMaxWidth()) { Column(Modifier.padding(14.dp)) { Text(record.title(), fontWeight = FontWeight.Bold); Text("${caseJobs.find { it.first == record.data().text("job_type") }?.second.orEmpty()} · ${record.data().text("reporting_year")}"); Text(caseStatus(record.data().text("status"))); record.data().optJSONObject("counts")?.let { counts -> Text("${counts.optInt("references")} chosen sources · ${counts.optInt("open_items")} unfinished items") } } } }
            Row { TextButton(onClick = { offset = maxOf(0, offset - CASE_PAGE_SIZE); page = null }, enabled = !loading && offset > 0) { Text("Previous jobs") }; TextButton(onClick = { offset += rows.size; page = null }, enabled = !loading && rows.isNotEmpty() && offset + rows.size < total) { Text("Next jobs") } }
        }
        CasePendingChanges(model)
    }
    if (create) CaseEditor(model, null, route = obj("farm_id" to farmId.ifBlank { route.text("farm_id") }, "job_type" to job.ifBlank { route.text("job_type") }, "reference" to route.optJSONObject("reference"))) { create = false; reload++ }
}

@Composable private fun CaseText(label: String, value: String, change: (String) -> Unit, multiline: Boolean = false) {
    OutlinedTextField(value, change, label = { Text(label) }, keyboardOptions = caseKeyboard, modifier = Modifier.fillMaxWidth().then(if (multiline) Modifier.heightIn(min = 95.dp) else Modifier), singleLine = !multiline)
}

@Composable private fun CaseEditor(model: FarmModel, record: JSONObject?, route: JSONObject = JSONObject(), close: () -> Unit) {
    val key = if (record != null) "case-edit:${record.getString("id")}" else "case-new:${route.text("job_type")}:${route.text("farm_id")}"
    val initial = if (record != null) JSONObject(record.data().toString()).put("expected_revision", record.getInt("revision")) else obj("farm_id" to route.text("farm_id"), "job_type" to route.text("job_type"), "title" to "", "reporting_year" to "", "references" to JSONArray().apply { route.optJSONObject("reference")?.let { put(it) } })
    var draft by remember(key) { mutableStateOf(model.draft(key, initial)) }; var picking by remember { mutableStateOf(false) }; var problem by remember { mutableStateOf("") }
    fun update(name: String, value: String) { draft = JSONObject(draft.toString()).apply { if (name == "farm_id" && text(name) != value) put("references", JSONArray()); put(name, value) }; model.saveDraft(key, draft) }
    fun setReferences(rows: List<JSONObject>) { draft = JSONObject(draft.toString()).put("references", JSONArray(rows)); model.saveDraft(key, draft) }
    val references = draft.optJSONArray("references").objectsOrEmpty()
    Sheet(if (record == null) "Start a preparation job" else "Update this preparation job", close) {
        Text("Keep supplied names, dates and references exactly as recorded. Saving starts or updates a private draft; it is not a review or a submission.")
        if (record == null) {
            Choice("Farm for this job", draft.text("farm_id"), listOf("" to "Choose the actual farm") + model.records["farms"].orEmpty().map { it.getString("id") to it.title() }) { update("farm_id", it) }
            Choice("What are you working on?", draft.text("job_type"), listOf("" to "Choose the job") + caseJobs) { update("job_type", it) }
            CaseText("Reporting year · from the actual paperwork", draft.text("reporting_year"), { update("reporting_year", it) })
        } else Text("Farm, job and year stay fixed. This draft retains case revision ${draft.getInt("expected_revision")}; it will not silently rebase after a refresh.")
        CaseText("A short name for this job", draft.text("title"), { update("title", it) })
        CaseText("Recipient or authority · as supplied", draft.text("authority"), { update("authority", it) })
        CaseText("Scheme or programme · if supplied", draft.text("scheme"), { update("scheme", it) })
        CaseText("Actual deadline · YYYY-MM-DD or blank", draft.text("deadline"), { update("deadline", it) })
        CaseText("Original submission or letter reference", draft.text("original_reference"), { update("original_reference", it) })
        CaseText("Date actually submitted · YYYY-MM-DD or blank", draft.text("original_submitted_at"), { update("original_submitted_at", it) })
        CaseText("What needs checking or correcting?", draft.text("reason"), { update("reason", it) }, true)
        Text("Selected original records and evidence", style = MaterialTheme.typography.titleMedium)
        references.forEach { reference -> Row { Text("${reference.text("title").ifBlank { caseKinds.find { it.first == reference.text("kind") }?.second ?: "Saved source" }} · ${caseRoles.find { it.first == reference.text("role") }?.second} · revision ${reference.optInt("revision")}", Modifier.weight(1f)); TextButton(onClick = { setReferences(references.filterNot { caseRefKey(it) == caseRefKey(reference) }) }) { Text("Remove source") } } }
        OutlinedButton(onClick = { picking = true }, enabled = draft.text("farm_id").isNotBlank() && references.size < 100) { Text("Choose an existing same-farm source") }
        Text("Source revisions are checked by the service. A stale source must be removed and explicitly selected again, not silently refreshed.", style = MaterialTheme.typography.bodySmall)
        if (record != null && draft.optInt("expected_revision") != record.getInt("revision")) Text("This job changed while your device draft was open. Your text is retained. Compare the current job, then explicitly discard this old device draft before starting a new edit.", color = MaterialTheme.colorScheme.error)
        if (draft.text("farm_id").isNotBlank() && draft.text("job_type") == "fields") { WebLink(model, "/app/fields/${draft.text("farm_id")}", "Open advanced boundary drawing on the website"); Text("Drawing, splitting and merging continue in your browser. Changes still need a separate review.") }
        if (problem.isNotBlank()) Text(problem, color = MaterialTheme.colorScheme.error)
        Button(onClick = { runCatching {
            require(draft.text("title").isNotBlank()) { "Give the job a short name." }
            val output = JSONObject().apply { listOf("title", "authority", "scheme", "original_reference", "reason").forEach { put(it, draft.text(it).ifBlank { null } ?: JSONObject.NULL) }; put("deadline", caseOptionalDate(draft.text("deadline"))); put("original_submitted_at", caseOptionalDate(draft.text("original_submitted_at"))); put("references", JSONArray(references.map(::casePin))) }
            if (record == null) {
                require(draft.text("farm_id").isNotBlank() && caseJobs.any { it.first == draft.text("job_type") }) { "Choose the farm and the job." }
                val year = draft.text("reporting_year").takeIf { it.matches(Regex("\\d{4}")) }?.toIntOrNull(); require(year != null && year in 1900..2200) { "Enter the actual four-digit reporting year." }
                output.put("farm_id", draft.getString("farm_id")).put("job_type", draft.getString("job_type")).put("reporting_year", year)
                model.enqueue("/cases", output, draftKey = key)
            } else model.enqueue("/cases/${record.getString("id")}", obj("expected_revision" to draft.getInt("expected_revision"), "data" to output), "PATCH", key)
            close()
        }.onFailure { problem = it.message ?: "Check these job details." } }, enabled = !model.busy && (record == null || !casePending(model, record.getString("id")) && draft.optInt("expected_revision") == record.getInt("revision"))) { Text("Save this preparation draft") }
        TextButton(onClick = { model.deleteDraft(key); close() }) { Text("Discard this device draft") }
    }
    if (picking) CaseSourcePicker(model, draft.getString("farm_id")) { source -> if (source != null) setReferences((references.filterNot { caseRefKey(it) == caseRefKey(source) } + source).take(100)); picking = false }
}

private fun JSONArray?.objectsOrEmpty() = this?.objects().orEmpty()

@Composable private fun CaseSourcePicker(model: FarmModel, farmId: String, documentsOnly: Boolean = false, selected: (JSONObject?) -> Unit) {
    var kind by remember { mutableStateOf("documents") }; var role by remember { mutableStateOf("evidence") }; var offset by remember { mutableStateOf(0) }; var reload by remember { mutableStateOf(0) }
    var page by remember { mutableStateOf<JSONObject?>(null) }; var loading by remember { mutableStateOf(true) }; var problem by remember { mutableStateOf("") }
    LaunchedEffect(farmId, kind, offset, reload, model.serverVersion) {
        page = null; loading = true; problem = ""
        try { page = model.sourceRequest(if (kind == "field_change_proposals") "/farms/$farmId/field-proposals?limit=20&offset=$offset" else "/$kind?farm_id=$farmId&limit=${if (kind == "facts") SOURCE_FACT_PAGE_SIZE else 20}&offset=$offset" + if (kind == "reports") "&view=summary" else "") }
        catch (error: CancellationException) { throw error }
        catch (error: Throwable) { problem = sourceFailure(error) }
        finally { loading = false }
    }
    Sheet("Choose a record from this farm", { selected(null) }) {
        Text("Only records explicitly assigned to this farm can be selected. An unassigned document must first be assigned to the correct farm; choosing it never confirms its contents.")
        if (!documentsOnly) { Choice("Source type", kind, caseKinds) { kind = it; offset = 0; page = null }; Choice("How does this source help?", role, caseRoles) { role = it } }
        if (loading) Text("Loading current source names and revisions…")
        if (problem.isNotBlank()) Text(problem, color = MaterialTheme.colorScheme.error)
        OutlinedButton(onClick = { reload++ }, enabled = !loading) { Text("Reload source choices") }
        page?.let { response ->
            val rows = response.getJSONArray("items").objects(); val total = response.getInt("total")
            Text("${if (rows.isEmpty()) 0 else offset + 1}–${offset + rows.size} of $total source records · only same-farm choices shown")
            val eligible = rows.filter { it.data().text("farm_id") == farmId }
            if (eligible.isEmpty()) Text("No eligible same-farm source is shown on this page.")
            eligible.forEach { record -> OutlinedButton(onClick = { selected(obj("kind" to kind, "id" to record.getString("id"), "revision" to record.getInt("revision"), "role" to role, "title" to record.title())) }, modifier = Modifier.fillMaxWidth()) { Text("${record.title()} · revision ${record.getInt("revision")} · ${record.data().text("review_status").ifBlank { record.data().text("status") }}") } }
            Row { TextButton(onClick = { offset = maxOf(0, offset - if (kind == "facts") SOURCE_FACT_PAGE_SIZE else 20); page = null }, enabled = !loading && offset > 0) { Text("Previous source choices") }; TextButton(onClick = { offset += rows.size; page = null }, enabled = !loading && rows.isNotEmpty() && offset + rows.size < total) { Text("Next source choices") } }
        }
        if (kind == "documents") WebLink(model, "/app/documents", "Assign an existing document to a farm on the website")
    }
}

@Composable private fun CaseDetail(model: FarmModel, id: String, share: (File, String) -> Unit, close: () -> Unit) {
    val scope = rememberCoroutineScope(); val cacheKey = "case-cache:$id"
    var record by remember(id) { mutableStateOf(model.draft(cacheKey, JSONObject()).optJSONObject("record")) }; var checks by remember(id) { mutableStateOf<JSONObject?>(null) }
    var reload by remember(id) { mutableStateOf(0) }; var loading by remember(id) { mutableStateOf(true) }; var fresh by remember(id) { mutableStateOf(false) }; var problem by remember(id) { mutableStateOf("") }
    var recordFresh by remember(id) { mutableStateOf(false) }; var handoffGeneration by remember(id) { mutableStateOf(0L) }
    var edit by remember(id) { mutableStateOf(false) }; var newItem by remember(id) { mutableStateOf(false) }; var reviewItem by remember(id) { mutableStateOf<JSONObject?>(null) }; var event by remember(id) { mutableStateOf(false) }
    var handoff by remember(id) { mutableStateOf<JSONObject?>(null) }; var handoffProblem by remember(id) { mutableStateOf("") }; var handoffLoading by remember(id) { mutableStateOf(false) }
    var fieldSource by remember(id) { mutableStateOf<JSONObject?>(null) }
    LaunchedEffect(id, reload, model.serverVersion) {
        loading = true; fresh = false; recordFresh = false; checks = null; handoff = null; handoffGeneration++; handoffLoading = false; problem = ""; handoffProblem = ""
        try {
            val current = model.sourceRequest("/cases/$id"); require(current.getString("id") == id) { "The job identity changed." }; record = current; recordFresh = true; model.saveDraft(cacheKey, obj("record" to current))
            val result = model.sourceRequest("/cases/$id/checks")
            require(result.getString("case_id") == id && result.getInt("case_revision") == current.getInt("revision") && result.getString("fingerprint").matches(Regex("[a-f0-9]{64}"))) { "This check belongs to a different version. Reload this job." }
            checks = result; fresh = true
        } catch (error: CancellationException) { throw error }
        catch (error: Throwable) { problem = sourceFailure(error); if (error is ApiFailure && error.status in listOf(401, 403, 404)) { record = null; recordFresh = false; model.deleteDraft(cacheKey) } }
        finally { loading = false }
    }
    val current = record; val check = checks; val pending = casePending(model, id)
    val binding = "${current?.optInt("revision")}:${check?.text("fingerprint")}:${model.session?.getJSONObject("workspace")?.getString("id")}:${model.session?.getJSONObject("user")?.getString("id")}"
    var acknowledged by remember(binding) { mutableStateOf(false) }
    Sheet(current?.title() ?: "Preparation job", close) {
        if (loading) Text("Loading this job and checking its current source revisions…")
        if (problem.isNotBlank()) Text(problem, color = MaterialTheme.colorScheme.error)
        if (!fresh) Text("Current checks are unavailable or still loading. Saved content has not been counted as ready, empty or complete.")
        OutlinedButton(onClick = { acknowledged = false; checks = null; handoff = null; handoffGeneration++; fresh = false; recordFresh = false; reload++ }, enabled = !loading) { Text("Reload this job and its current checks") }
        current?.let { item ->
            val data = item.data(); val editable = data.text("status") in listOf("draft", "needs_changes")
            Text(caseStatus(data.text("status")), style = MaterialTheme.typography.titleLarge)
            Text(data.text("external_status_notice").ifBlank { "All sending and responses are recorded by a person. They are not independently verified with an authority." })
            listOf("reporting_year", "authority", "scheme", "deadline", "original_reference", "original_submitted_at", "reason").forEach { field -> if (data.has(field)) CaseValue(field.replace('_', ' '), data.opt(field)) }
            if (editable) OutlinedButton(onClick = { edit = true }, enabled = !pending) { Text("Update the draft and chosen sources") }
            if (data.text("job_type") == "fields") { WebLink(model, "/app/fields/${data.getString("farm_id")}", "Draw, split or merge boundaries on the website"); Text("The advanced map editor opens in the browser. Native source review remains here; a private location pin is not a boundary submission.") }
            Text("Originals, changes and supporting records", style = MaterialTheme.typography.titleLarge)
            val references = check?.optJSONArray("references")?.objects() ?: data.optJSONArray("references").objectsOrEmpty()
            references.forEach { reference ->
                Text("${reference.text("title").ifBlank { caseKinds.find { it.first == reference.text("kind") }?.second ?: "Saved source" }} · ${caseRoles.find { it.first == reference.text("role") }?.second} · selected revision ${reference.optInt("revision")}")
                if (reference.has("current")) Text(if (reference.optBoolean("current")) "Matches the current source" else "Source changed or is unavailable · choose it again after comparison", color = if (reference.optBoolean("current")) MaterialTheme.colorScheme.onSurface else MaterialTheme.colorScheme.error)
                TextButton(onClick = { if (reference.text("kind") == "field_change_proposals") fieldSource = reference else { close(); model.open(reference.getString("kind"), reference.getString("id")) } }) { Text("Open this original record for comparison") }
            }
            Text("Requested records, findings and actions", style = MaterialTheme.typography.titleLarge)
            val items = data.optJSONArray("items").objectsOrEmpty()
            if (items.isEmpty()) Text("No requested records, findings or actions have been listed yet. This does not establish that nothing is required.")
            items.forEachIndexed { index, entry -> Card(Modifier.fillMaxWidth()) { Column(Modifier.padding(12.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) {
                Text(entry.text("title"), fontWeight = FontWeight.Bold); Text("${entry.text("kind").replace('_', ' ')} · ${entry.text("status").replace('_', ' ')}"); CaseValue("Actual due date", entry.opt("due_date"))
                var expanded by remember(entry.getString("id"), item.getInt("revision")) { mutableStateOf(false) }
                TextButton(onClick = { expanded = !expanded }) { Text("${if (expanded) "Hide" else "Show"} full item details · item ${index + 1}") }
                if (expanded) { CaseValue("Details", entry.opt("description")); entry.optJSONObject("review")?.let { review -> CaseValue("Recorded review note", review.opt("note")); CaseValue("Review recorded at", review.opt("at")) }; CaseHistoricDocuments(model, entry.optJSONArray("document_pins")) }
                if (editable) TextButton(onClick = { reviewItem = entry }, enabled = recordFresh && !pending) { Text("Record progress or resolve this item") }
            } } }
            if (editable) OutlinedButton(onClick = { newItem = true }, enabled = fresh && !pending && items.size < 100) { Text("Add a requested record, finding or action") }
            check?.let { result ->
                Text(result.text("next_action"), style = MaterialTheme.typography.titleMedium)
                result.optJSONArray("issues")?.objects()?.forEach { issue -> Text(issue.text("message"), color = if (issue.text("severity") == "error") MaterialTheme.colorScheme.error else MaterialTheme.colorScheme.onSurface) }
                Text(result.text("notice"))
                if (editable) {
                    Text("Documents selected here, attached to completed items or selected in approved reports are included. Other private source files stay in your workspace.")
                    Row { Checkbox(acknowledged, { acknowledged = it }, enabled = fresh && result.optBoolean("can_review") && !pending && !loading); Text("I checked this exact job, its selected source revisions and every listed item.", Modifier.weight(1f).padding(top = 12.dp)) }
                    Button(onClick = { model.enqueue("/cases/$id/review", obj("expected_revision" to item.getInt("revision"), "expected_fingerprint" to result.getString("fingerprint"), "acknowledged" to true), draftKey = "case-review:$id:${item.getInt("revision")}:${result.getString("fingerprint")}"); acknowledged = false; fresh = false; checks = null }, enabled = fresh && acknowledged && result.optBoolean("can_review") && !loading && !model.busy && !pending) { Text("Finish my preparation review · nothing sent") }
                }
            }
            if (data.text("status") in listOf("ready_to_send", "sent", "receipt_saved", "needs_changes", "accepted_recorded")) {
                OutlinedButton(onClick = { scope.launch {
                    val expectedRevision = item.getInt("revision"); val version = model.serverVersion; val token = ++handoffGeneration; handoffLoading = true; handoffProblem = ""; handoff = null
                    try { val response = model.sourceRequest("/cases/$id/handoff"); if (token != handoffGeneration || version != model.serverVersion) return@launch; require(response.getString("case_id") == id && expectedRevision == record?.optInt("revision") && recordFresh) { "This job changed while loading its handoff. Reload it." }; handoff = response }
                    catch (error: CancellationException) { throw error }
                    catch (error: Throwable) { if (token == handoffGeneration && version == model.serverVersion) handoffProblem = sourceFailure(error) }
                    finally { if (token == handoffGeneration && version == model.serverVersion) handoffLoading = false }
                } }, enabled = recordFresh && !loading && !pending && !handoffLoading) { Text("Get my files and answers for the next step") }
            }
            if (handoffLoading) Text("Checking the retained handoff…")
            if (handoffProblem.isNotBlank()) Text(handoffProblem, color = MaterialTheme.colorScheme.error)
            handoff?.let { CaseHandoff(model, item, it, share) }
            OutlinedButton(onClick = { event = true }, enabled = recordFresh && !pending && caseActions(data.text("status")).isNotEmpty()) { Text("Record what I sent or what reply I received") }
            CaseHistory(model, item, reload, share)
        }
        CasePendingChanges(model)
    }
    if (edit && current != null) CaseEditor(model, current) { edit = false }
    if (newItem && current != null) CaseItemEditor(model, current, null) { newItem = false }
    reviewItem?.let { item -> if (current != null) CaseItemEditor(model, current, item) { reviewItem = null } }
    if (event && current != null) CaseEventEditor(model, current) { event = false }
    fieldSource?.let { reference -> if (current != null) CaseFieldSource(model, reference, current.data().getString("farm_id")) { fieldSource = null } }
}

@Composable private fun CaseValue(label: String, value: Any?) {
    Text(label, style = MaterialTheme.typography.labelLarge)
    SelectionContainer { Text(if (value == null || value === JSONObject.NULL) "Not recorded" else if (value is String && value.isEmpty()) "Blank supplied value" else value.toString()) }
}

@Composable private fun CaseItemEditor(model: FarmModel, record: JSONObject, item: JSONObject?, close: () -> Unit) {
    val id = record.getString("id"); val key = "case-item:$id:${item?.getString("id") ?: "new"}"
    var draft by remember(key) { mutableStateOf(model.draft(key, obj("expected_revision" to record.getInt("revision"), "kind" to "requested_record", "title" to "", "description" to "", "due_date" to "", "status" to "in_progress", "note" to "", "documents" to JSONArray()))) }
    var picking by remember { mutableStateOf(false) }; var acknowledged by remember(key, record.getInt("revision")) { mutableStateOf(false) }; var problem by remember { mutableStateOf("") }
    fun update(name: String, value: Any) { draft = JSONObject(draft.toString()).put(name, value); model.saveDraft(key, draft); acknowledged = false }
    val documents = draft.optJSONArray("documents").objectsOrEmpty()
    Sheet(if (item == null) "Add what needs doing" else item.text("title"), close) {
        Text("This draft retains case revision ${draft.getInt("expected_revision")}. A new server version requires a fresh comparison; it will not silently replace your note.")
        if (draft.getInt("expected_revision") != record.getInt("revision")) Text("The case changed. Your text is retained; compare it, then discard this old item draft before composing a current change.", color = MaterialTheme.colorScheme.error)
        if (item == null) {
            Choice("What needs to be listed?", draft.text("kind"), listOf("requested_record" to "A requested record is missing", "finding" to "A finding to respond to", "action" to "Something to do")) { update("kind", it) }
            CaseText("Name the requested record, finding or action", draft.text("title"), { update("title", it) })
            CaseText("What does the actual letter or finding ask for?", draft.text("description"), { update("description", it) }, true)
            CaseText("Actual due date · YYYY-MM-DD or blank", draft.text("due_date"), { update("due_date", it) })
        } else {
            Choice("What have you actually done?", draft.text("status"), listOf("in_progress" to "I am working on it", "resolved" to "I have resolved it and have evidence", "cancelled" to "I am cancelling this item with a reason")) { update("status", it) }
            CaseText("Explain the progress, resolution or cancellation", draft.text("note"), { update("note", it) }, true)
            documents.forEach { doc -> Row { Text(doc.text("title"), Modifier.weight(1f)); TextButton(onClick = { update("documents", JSONArray(documents.filterNot { it.text("id") == doc.text("id") })) }) { Text("Remove evidence") } } }
            OutlinedButton(onClick = { picking = true }) { Text("Choose same-farm evidence for this item") }
            Row { Checkbox(acknowledged, { acknowledged = it }); Text("I checked this item, my explanation and the chosen evidence.", Modifier.weight(1f).padding(top = 12.dp)) }
        }
        if (problem.isNotBlank()) Text(problem, color = MaterialTheme.colorScheme.error)
        Button(onClick = { runCatching {
            val body = obj("expected_revision" to draft.getInt("expected_revision"))
            if (item == null) { require(draft.text("title").isNotBlank()) { "Name what needs doing." }; body.put("kind", draft.getString("kind")).put("title", draft.getString("title")).put("description", draft.text("description")).put("due_date", caseOptionalDate(draft.text("due_date"))); model.enqueue("/cases/$id/items", body, draftKey = key) }
            else { require(acknowledged && draft.text("note").isNotBlank()) { "Check the item and record your explanation." }; require(draft.text("status") != "resolved" || documents.isNotEmpty()) { "Choose actual evidence before resolving an item." }; body.put("status", draft.getString("status")).put("note", draft.getString("note")).put("document_ids", JSONArray(documents.map { it.getString("id") }.distinct())).put("document_revisions", JSONObject().apply { documents.forEach { put(it.getString("id"), it.getInt("revision")) } }).put("acknowledged", true); model.enqueue("/cases/$id/items/${item.getString("id")}/review", body, draftKey = key) }
            close()
        }.onFailure { problem = it.message ?: "Check this item." } }, enabled = !model.busy && !casePending(model, id) && draft.getInt("expected_revision") == record.getInt("revision") && record.data().text("status") in listOf("draft", "needs_changes") && (item == null || acknowledged)) { Text(if (item == null) "Add this item to the preparation draft" else "Save this item progress") }
        TextButton(onClick = { model.deleteDraft(key); close() }) { Text("Discard this item draft") }
    }
    if (picking) CaseSourcePicker(model, record.data().getString("farm_id"), true) { doc -> if (doc != null) update("documents", JSONArray(documents.filterNot { it.text("id") == doc.text("id") } + doc)); picking = false }
}

@Composable private fun CaseEventEditor(model: FarmModel, record: JSONObject, close: () -> Unit) {
    val id = record.getString("id"); val key = "case-event:$id"
    var draft by remember(key) { mutableStateOf(model.draft(key, obj("expected_revision" to record.getInt("revision"), "action" to "", "date" to "", "note" to "", "reference" to ""))) }
    var acknowledged by remember(key, record.getInt("revision")) { mutableStateOf(false) }; var picking by remember { mutableStateOf(false) }; var problem by remember { mutableStateOf("") }
    fun update(name: String, value: Any) { draft = JSONObject(draft.toString()).put(name, value); model.saveDraft(key, draft); acknowledged = false }
    val actions = caseActions(record.data().text("status"))
    Sheet("Record an actual send or reply", close) {
        Text("This records your own account of what happened. It does not send anything, verify delivery or establish an authority's acceptance. Keep the actual response document.")
        Choice("What actually happened?", draft.text("action"), listOf("" to "Choose an actual event") + actions) { update("action", it) }
        if (draft.getInt("expected_revision") != record.getInt("revision")) Text("The case changed. Your event text is retained. Compare what is already recorded, then discard this old event draft before composing another event.", color = MaterialTheme.colorScheme.error)
        CaseText("Actual event date · YYYY-MM-DD", draft.text("date"), { update("date", it) })
        CaseText("Actual receipt, submission or decision reference", draft.text("reference"), { update("reference", it) })
        CaseText("What did you send or what did the reply say?", draft.text("note"), { update("note", it) }, true)
        draft.optJSONObject("document")?.let { doc -> Text("Evidence: ${doc.text("title")} · revision ${doc.optInt("revision")}"); TextButton(onClick = { update("document", JSONObject.NULL) }) { Text("Remove reply evidence") } }
        OutlinedButton(onClick = { picking = true }) { Text("Choose the actual same-farm reply document") }
        Text("A receipt or acceptance needs its actual document and reference. Every event remains in the immutable history.")
        Row { Checkbox(acknowledged, { acknowledged = it }); Text("I am recording an actual event, not asking the app to send or verify anything.", Modifier.weight(1f).padding(top = 12.dp)) }
        if (problem.isNotBlank()) Text(problem, color = MaterialTheme.colorScheme.error)
        Button(onClick = { runCatching {
            require(acknowledged && actions.any { it.first == draft.text("action") } && draft.text("note").isNotBlank()) { "Choose an event that follows the current case status, explain it and acknowledge the notice." }
            val date = LocalDate.parse(draft.getString("date")); require(!date.isAfter(LocalDate.now())) { "Use the actual event date, not a future date." }
            val doc = draft.optJSONObject("document")
            require(draft.text("action") !in listOf("receipt", "accepted") || doc != null && draft.text("reference").isNotBlank()) { "Choose the actual receipt or decision document and reference." }
            val body = obj("expected_revision" to draft.getInt("expected_revision"), "action" to draft.getString("action"), "date" to date.toString(), "note" to draft.getString("note"), "reference" to draft.text("reference").ifBlank { null }, "acknowledged" to true)
            if (doc != null) body.put("document_id", doc.getString("id")).put("document_revision", doc.getInt("revision"))
            model.enqueue("/cases/$id/events", body, draftKey = key); close()
        }.onFailure { problem = it.message ?: "Check the actual event details." } }, enabled = acknowledged && !model.busy && !casePending(model, id) && draft.getInt("expected_revision") == record.getInt("revision") && actions.any { it.first == draft.text("action") }) { Text("Save my own event record · nothing sent") }
        TextButton(onClick = { model.deleteDraft(key); close() }) { Text("Discard this event draft") }
    }
    if (picking) CaseSourcePicker(model, record.data().getString("farm_id"), true) { doc -> if (doc != null) update("document", doc); picking = false }
}

@Composable private fun CaseHistory(model: FarmModel, record: JSONObject, reload: Int, share: (File, String) -> Unit) {
    val id = record.getString("id"); var offset by remember(id) { mutableStateOf(0) }; var attempt by remember(id) { mutableStateOf(0) }
    var page by remember(id) { mutableStateOf<JSONObject?>(null) }; var loading by remember(id) { mutableStateOf(false) }; var problem by remember(id) { mutableStateOf("") }
    LaunchedEffect(id, record.getInt("revision"), offset, reload, attempt) {
        loading = true; page = null; problem = ""
        try { page = model.sourceRequest("/cases/$id/events?limit=$CASE_PAGE_SIZE&offset=$offset") }
        catch (error: CancellationException) { throw error }
        catch (error: Throwable) { problem = sourceFailure(error) }
        finally { loading = false }
    }
    Text("Recorded sends, replies and decisions", style = MaterialTheme.typography.titleLarge)
    if (loading) Text("Loading recorded event history…")
    if (problem.isNotBlank()) Text(problem, color = MaterialTheme.colorScheme.error)
    OutlinedButton(onClick = { attempt++ }, enabled = !loading) { Text("Reload recorded event history") }
    page?.let { response ->
        val rows = response.getJSONArray("items").objects(); val total = response.getInt("total")
        Text("${if (rows.isEmpty()) 0 else offset + 1}–${offset + rows.size} of $total recorded events")
        if (rows.isEmpty()) Text("No events recorded on this page. The app has not checked an authority's system.")
        rows.forEachIndexed { index, event -> val data = event.data(); Card(Modifier.fillMaxWidth()) { Column(Modifier.padding(12.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) {
            Text(data.text("action").replace('_', ' '), fontWeight = FontWeight.Bold)
            CaseValue("Recorded in this workspace at", event.opt("created_at")); listOf("date", "note", "reference").forEach { CaseValue(it.replace('_', ' '), data.opt(it)) }
            Text("Recorded by a person · not independently verified")
            (data.opt("document_id") as? String)?.let { doc -> TextButton(onClick = { model.cases = null; model.open("documents", doc) }) { Text("Open this reply document") } }
            var expanded by remember(event.getString("id")) { mutableStateOf(false) }
            TextButton(onClick = { expanded = !expanded }) { Text("${if (expanded) "Hide" else "Show"} retained details · event ${offset + index + 1}") }
            if (expanded) CaseEventDetails(model, record, event.getString("id"), share)
        } } }
        Row { TextButton(onClick = { offset = maxOf(0, offset - CASE_PAGE_SIZE) }, enabled = !loading && offset > 0) { Text("Previous recorded events") }; TextButton(onClick = { offset += rows.size }, enabled = !loading && rows.isNotEmpty() && offset + rows.size < total) { Text("Next recorded events") } }
    }
}

@Composable private fun CaseEventDetails(model: FarmModel, caseRecord: JSONObject, eventId: String, share: (File, String) -> Unit) {
    val caseId = caseRecord.getString("id"); val farmId = caseRecord.data().getString("farm_id")
    var response by remember(eventId) { mutableStateOf<JSONObject?>(null) }; var attempt by remember(eventId) { mutableStateOf(0) }; var loading by remember(eventId) { mutableStateOf(true) }; var problem by remember(eventId) { mutableStateOf("") }
    LaunchedEffect(caseId, eventId, attempt) {
        response = null; loading = true; problem = ""
        try { val event = model.sourceRequest("/cases/$caseId/events/$eventId"); require(event.getString("id") == eventId && event.data().getString("case_id") == caseId && event.data().getString("farm_id") == farmId) { "This retained event belongs to a different job or farm." }; response = event }
        catch (error: CancellationException) { throw error }
        catch (error: Throwable) { problem = sourceFailure(error) }
        finally { loading = false }
    }
    if (loading) Text("Loading the complete retained event…")
    if (problem.isNotBlank()) Text(problem, color = MaterialTheme.colorScheme.error)
    if (!loading && response == null) Text("Retained event details are unavailable, not empty. No original selection has been inferred.")
    OutlinedButton(onClick = { attempt++ }, enabled = !loading) { Text("Reload this retained event") }
    response?.data()?.let { data ->
        CaseValue("Case revision recorded in this event", data.opt("case_revision")); CaseValue("Recorded at", data.opt("recorded_at")); CaseValue("Recorded by · workspace identity", data.opt("actor_id")); CaseValue("Retained content identity", data.opt("content_hash"))
        data.optJSONObject("item")?.let { entry -> Text("Item recorded in this event", style = MaterialTheme.typography.titleSmall); listOf("title", "kind", "description", "due_date", "status").forEach { if (entry.has(it)) CaseValue(it.replace('_', ' '), entry.opt(it)) }; entry.optJSONObject("review")?.let { CaseValue("Recorded explanation", it.opt("note")) }; CaseHistoricDocuments(model, entry.optJSONArray("document_pins")) }
        data.optJSONObject("changes")?.let { changes -> Text("Saved content changes", style = MaterialTheme.typography.titleSmall); listOf("title", "job_type", "reporting_year", "authority", "scheme", "deadline", "original_reference", "original_submitted_at", "reason").forEach { if (changes.has(it)) CaseValue(it.replace('_', ' '), changes.opt(it)) }; CaseHistoricReferences(model, changes.optJSONArray("references"), farmId) }
        data.optJSONObject("review")?.let { review -> CaseValue("Preparation reviewed at", review.opt("at")); CaseValue("Retained source fingerprint", review.opt("fingerprint")) }
        data.optJSONObject("sealed_bundle")?.let { bundle ->
            Text("Selection actually recorded as sent · retained unchanged", style = MaterialTheme.typography.titleMedium)
            CaseValue("Case revision recorded as sent", bundle.opt("case_revision"))
            bundle.optJSONObject("content")?.let { content -> listOf("title", "job_type", "reporting_year", "authority", "scheme", "deadline", "original_reference", "original_submitted_at", "reason").forEach { CaseValue(it.replace('_', ' '), content.opt(it)) }; CaseHistoricReferences(model, content.optJSONArray("references"), farmId); content.optJSONArray("items")?.objects()?.forEach { item -> Text("${item.text("title")} · ${item.text("status").replace('_', ' ')}"); CaseValue("Retained description", item.opt("description")); item.optJSONObject("review")?.let { CaseValue("Retained item explanation", it.opt("note")) }; CaseHistoricDocuments(model, item.optJSONArray("document_pins")) } }
            Text("These are historical selections, not a fresh check of current sources. Opening a source shows its current record for comparison, not a replacement for this retained version.")
            bundle.optJSONObject("handoff")?.let { retained -> CaseHandoff(model, caseRecord, JSONObject(retained.toString()).put("origin", "sealed_sent_bundle"), share, eventId) }
        }
    }
}

@Composable private fun CaseHistoricDocuments(model: FarmModel, documents: JSONArray?) {
    documents?.objects()?.forEach { document ->
        Text("Evidence document · retained revision ${document.optInt("revision")}")
        CaseValue("Retained document identity", document.opt("id"))
        TextButton(onClick = { model.cases = null; model.open("documents", document.getString("id")) }) { Text("Compare the current document with this retained evidence") }
    }
}

@Composable private fun CaseHistoricReferences(model: FarmModel, references: JSONArray?, farmId: String) {
    var field by remember { mutableStateOf<JSONObject?>(null) }
    references?.objects()?.forEach { reference ->
        Text("${caseKinds.find { it.first == reference.text("kind") }?.second ?: "Saved source"} · ${caseRoles.find { it.first == reference.text("role") }?.second.orEmpty()} · retained revision ${reference.optInt("revision")}")
        CaseValue("Retained source identity", reference.opt("id"))
        if (reference.text("kind") in caseKinds.map { it.first }) TextButton(onClick = { if (reference.text("kind") == "field_change_proposals") field = reference else { model.cases = null; model.open(reference.getString("kind"), reference.getString("id")) } }) { Text("Compare the current source with this retained selection") }
    }
    field?.let { reference -> CaseFieldSource(model, reference, farmId) { field = null } }
}

@Composable private fun CaseFieldSource(model: FarmModel, reference: JSONObject, farmId: String, close: () -> Unit) {
    val id = reference.getString("id"); var proposal by remember(id) { mutableStateOf<JSONObject?>(null) }; var farm by remember(id) { mutableStateOf<JSONObject?>(null) }
    var attempt by remember(id) { mutableStateOf(0) }; var loading by remember(id) { mutableStateOf(true) }; var problem by remember(id) { mutableStateOf("") }
    LaunchedEffect(id, farmId, attempt, model.serverVersion) {
        proposal = null; farm = null; loading = true; problem = ""
        try { val current = model.sourceRequest("/field-proposals/$id"); require(current.getString("id") == id && current.data().getString("farm_id") == farmId) { "This field change belongs to a different farm." }; val currentFarm = model.sourceRequest("/farms/$farmId"); proposal = current; farm = currentFarm }
        catch (error: CancellationException) { throw error }
        catch (error: Throwable) { problem = sourceFailure(error) }
        finally { loading = false }
    }
    Sheet("Compare the exact field-change source", close) {
        Text("Selected source revision ${reference.getInt("revision")}. The retained case selection is not replaced by this current source read.")
        if (loading) Text("Loading this exact field change and its farm…")
        if (problem.isNotBlank()) Text(problem, color = MaterialTheme.colorScheme.error)
        OutlinedButton(onClick = { attempt++ }, enabled = !loading) { Text("Reload this exact field change") }
        val current = proposal; val currentFarm = farm
        if (current != null && currentFarm != null) {
            Text("Current revision ${current.getInt("revision")} · ${current.data().text("status")}")
            if (current.getInt("revision") != reference.getInt("revision")) Text("This source changed after selection. Compare it, then explicitly choose the current revision in the case draft. This screen does not update the case pin.", color = MaterialTheme.colorScheme.error)
            if (current.data().text("status") == "proposed") FieldProposalReview(model, currentFarm, current)
            else { val data = current.data(); Text(data.text("note")); (data.optJSONArray("previous_parcels")?.objects() ?: listOfNotNull(data.optJSONObject("previous_parcel"))).forEachIndexed { index, parcel -> FieldReviewParcel(parcel, "Prior field ${index + 1} · retained") }; (data.optJSONArray("parcels")?.objects() ?: listOfNotNull(data.optJSONObject("parcel"))).forEachIndexed { index, parcel -> FieldReviewParcel(parcel, "Saved proposed field ${index + 1}") } }
            Text("Private field review is not an official LPIS update or authority acceptance.")
            WebLink(model, "/app/fields/$farmId?proposal_id=$id&expected_revision=${reference.getInt("revision")}", "Continue this exact field change on the website")
        } else if (!loading) Text("The exact source is unavailable. An unrelated farm or first-page proposal has not been substituted.")
    }
}

@Composable private fun CaseHandoff(model: FarmModel, record: JSONObject, handoff: JSONObject, share: (File, String) -> Unit, sealedEventId: String? = null) {
    val clipboard = LocalClipboardManager.current; val context = LocalContext.current; val scope = rememberCoroutineScope()
    var problem by remember(handoff.toString()) { mutableStateOf("") }; var loading by remember(handoff.toString()) { mutableStateOf(false) }
    var individualFiles by remember(handoff.toString()) { mutableStateOf(false) }
    val downloads = handoff.optJSONArray("downloads")?.objects().orEmpty()
    val packets = downloads.filter { Regex("^/api/v1/cases/[0-9a-fA-F-]{36}/packet$").matches(it.text("href").substringBefore('?')) }
    val individualDownloads = downloads - packets.toSet()
    DisposableEffect(record.getString("id"), record.getInt("revision"), handoff.text("reference_fingerprint"), sealedEventId) { onDispose { model.cancelReportExport() } }
    Text("Take the next step yourself", style = MaterialTheme.typography.titleLarge)
    Text(handoff.text("notice")); Text("Copying or sharing does not send anything to an authority. Use the actual official route yourself and keep its response.")
    if (handoff.text("origin") == "sealed_sent_bundle") Text("Historical handoff · these are the selections recorded as sent, not a new preparation review. Field files use their retained revision; current source changes are not silently substituted.")
    handoff.optJSONArray("fields")?.objects()?.forEach { field -> CaseValue(field.text("label"), field.opt("value")); if (field.opt("value") != null && field.opt("value") !== JSONObject.NULL) TextButton(onClick = { clipboard.setText(AnnotatedString(field.get("value").toString())) }) { Text("Copy ${field.text("label")}") } }
    handoff.text("official_url").takeIf(String::isNotBlank)?.let { raw ->
        val url = runCatching { URI(raw).takeIf { it.scheme == "https" && !it.host.isNullOrBlank() && it.rawUserInfo == null } }.getOrNull()
        if (url == null) Text("The official website address could not be verified. Do not use a guessed address.", color = MaterialTheme.colorScheme.error)
        else OutlinedButton(onClick = { runCatching { context.startActivity(Intent(Intent.ACTION_VIEW, Uri.parse(url.toASCIIString()))) }.onFailure { problem = "No browser could open the official website." } }) { Text("Open the official website myself") }
    }
    if (handoff.text("official_url").isBlank()) Text("No official website address is supplied for this farm. Check the actual letter or ask an adviser; a destination has not been guessed.")
    if (packets.isNotEmpty()) Text("Documents selected here, attached to completed items or selected in approved reports are included. Other private source files stay in your workspace. Nothing is sent. If a required selected file is unavailable, the folder cannot be downloaded; files are not silently left out.")
    if (individualDownloads.isNotEmpty()) TextButton(onClick = { individualFiles = !individualFiles }) { Text(if (individualFiles) "Hide individual files" else "Show individual files") }
    (packets + if (individualFiles) individualDownloads else emptyList()).forEach { download ->
        val packetDownload = download in packets
        Button(onClick = { scope.launch {
            val owner = model.session; val version = model.serverVersion
            loading = true; problem = ""
            try {
                suspend fun authorizeDownload() {
                    val authorized = if (handoff.text("origin") == "sealed_sent_bundle") {
                        val eventId = sealedEventId ?: record.data().text("sent_event_id")
                        require(eventId.isNotBlank()) { "The exact sent event identity is unavailable. Reload this historical job." }
                        val event = model.sourceRequest("/cases/${record.getString("id")}/events/${UUID.fromString(eventId)}")
                        require(event.getString("id") == eventId && event.data().text("case_id") == record.getString("id") && event.data().text("farm_id") == record.data().getString("farm_id") && event.data().text("action") == "sent") { "The retained event does not match this sent job." }
                        event.data().getJSONObject("sealed_bundle").getJSONObject("handoff")
                    } else {
                        require(handoff.text("origin") == "current_review") { "The handoff's review context is unavailable. Reload this job." }
                        model.sourceRequest("/cases/${record.getString("id")}/handoff").also { require(it.text("origin") == "current_review") { "This job is no longer the reviewed current preparation. Reload before downloading." } }
                    }
                    require(model.session === owner && model.serverVersion == version && authorized.getString("case_id") == record.getString("id") && authorized.getString("reference_fingerprint") == handoff.getString("reference_fingerprint") && authorized.getJSONArray("downloads").objects().any { it.text("href") == download.text("href") }) { "This exact handoff or signed-in source context changed. Reload before downloading." }
                }
                require(download.getString("href").startsWith("/api/v1/")) { "This is not an authenticated app download." }
                val path = download.getString("href").removePrefix("/api/v1")
                val uri = URI(path); require(uri.scheme == null && uri.rawAuthority == null && uri.rawFragment == null)
                val report = Regex("^/reports/([0-9a-fA-F-]{36})/download$").matchEntire(uri.path)
                val packet = Regex("^/cases/([0-9a-fA-F-]{36})/packet$").matchEntire(uri.path)
                if (packet != null) {
                    val query = uri.rawQuery.orEmpty().split('&').map { it.split('=', limit = 2) }
                    val versionKey = if (handoff.text("origin") == "sealed_sent_bundle") "retained_revision" else "expected_revision"
                    require(query.size == 2 && query.all { it.size == 2 } && query.map { it[0] }.toSet() == setOf(versionKey, "reference_fingerprint") && query.associate { it[0] to it[1] }["reference_fingerprint"] == handoff.getString("reference_fingerprint")) { "This folder does not match the displayed current or retained review. Reload this job." }
                    authorizeDownload()
                    model.exportCasePacket(path, record.getString("id"), share)
                } else if (report != null) {
                    val format = uri.rawQuery?.takeIf { it.matches(Regex("format=(pdf|csv|json|xlsx)")) }?.substringAfter('=') ?: error("The report download format is not supported.")
                    val source = model.sourceRequest("/reports/${UUID.fromString(report.groupValues[1])}?view=review")
                    require(source.data().getString("farm_id") == record.data().getString("farm_id")) { "This report belongs to a different farm." }
                    authorizeDownload()
                    model.export(source, format) { file -> share(file, when (format) { "pdf" -> "application/pdf"; "csv" -> "text/csv"; "xlsx" -> "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"; else -> "application/json" }) }
                } else { authorizeDownload(); model.exportCaseField(path) { file, mime -> share(file, mime) } }
            } catch (error: CancellationException) { throw error }
            catch (error: Throwable) { problem = sourceFailure(error) }
            finally { loading = false }
        } }, enabled = !loading && !model.exporting) { Text(if (packetDownload) "Save or share complete prepared folder (ZIP)" else "Save or share ${download.text("label")}") }
    }
    if (problem.isNotBlank()) Text(problem, color = MaterialTheme.colorScheme.error)
    if (model.message.isNotBlank()) Text(model.message, style = MaterialTheme.typography.bodySmall)
    if (loading) Text("Checking this handoff download…")
    if (model.exporting) { Text("Saving the complete file to private storage…"); OutlinedButton(onClick = { model.cancelReportExport(true) }) { Text("Cancel this private download") } }
}

@Composable private fun CasePendingChanges(model: FarmModel) {
    val jobs = model.queue().filter { it.text("path") == "/cases" || it.text("path").startsWith("/cases/") }
    var discarding by remember { mutableStateOf<JSONObject?>(null) }
    jobs.forEach { job ->
        Text("Pending preparation change · ${job.text("state").replace('_', ' ')}", style = MaterialTheme.typography.titleMedium)
        if (job.text("error").isNotBlank()) Text(job.text("error"), color = MaterialTheme.colorScheme.error)
        Text("The exact saved request and retry identity are retained for this account. A lost response is not permission to create a second change.")
        if (job.text("state") != "conflict") OutlinedButton(onClick = { model.retry(job.getString("id")) }, enabled = !model.busy && job.text("state") != "sending") { Text("Retry this exact preparation change") }
        else Text("The source or revision changed. Reload the job and compare it before composing a fresh, separately reviewed change. The saved payload will not be rebased.")
        val id = job.text("path").removePrefix("/cases/").substringBefore('/').substringBefore('?')
        if (runCatching { UUID.fromString(id) }.isSuccess) TextButton(onClick = { model.cases = obj("case_id" to id) }) { Text("Open the current job for comparison") }
        TextButton(onClick = { discarding = job }, enabled = !model.busy && job.text("state") != "sending") { Text("Remove this pending delivery after comparison") }
    }
    discarding?.let { job -> AlertDialog(onDismissRequest = { discarding = null }, title = { Text("Remove only this pending delivery?") }, text = { Text("A lost response may already have been saved on the server. Compare the current job first. Removing this delivery does not undo a recorded event or delete your saved device draft.") }, confirmButton = { TextButton(onClick = { model.discard(job.getString("id")); discarding = null }) { Text("Remove pending delivery only") } }, dismissButton = { TextButton(onClick = { discarding = null }) { Text("Keep pending delivery") } }) }
}
