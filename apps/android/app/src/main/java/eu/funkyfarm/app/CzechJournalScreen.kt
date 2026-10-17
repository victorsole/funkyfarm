package eu.funkyfarm.app

import androidx.compose.foundation.layout.*
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.launch
import org.json.JSONArray
import org.json.JSONObject
import java.time.LocalDate
import java.util.UUID

@Composable internal fun CzechJournalScreen(model: FarmModel, route: JSONObject, close: () -> Unit) {
    val farms = model.records["farms"].orEmpty().filter { it.data().text("country") == "CZ" }
    var farmId by remember { mutableStateOf(route.text("farm_id").ifBlank { farms.singleOrNull()?.getString("id").orEmpty() }) }
    var year by remember { mutableStateOf(route.text("year").ifBlank { farms.find { it.optString("id") == farmId }?.data()?.text("reporting_year").orEmpty().ifBlank { LocalDate.now().year.toString() } }) }
    var requestId by remember { mutableStateOf(route.text("request_id")) }
    var currentRequest by remember { mutableStateOf<JSONObject?>(null) }; var journal by remember { mutableStateOf<JSONObject?>(null) }
    var journalOffset by remember { mutableStateOf(0) }; var knownEntries by remember { mutableStateOf<Map<String, JSONObject>>(emptyMap()) }; var ledgerContext by remember { mutableStateOf("") }
    var operations by remember { mutableStateOf<List<JSONObject>>(emptyList()) }; var next by remember { mutableStateOf(0) }; var total by remember { mutableStateOf(0) }
    var loading by remember { mutableStateOf(false) }; var listLoaded by remember { mutableStateOf(false) }; var problem by remember { mutableStateOf("") }; var reload by remember { mutableStateOf(0) }
    var loadGeneration by remember { mutableStateOf(0L) }; var loadedBinding by remember { mutableStateOf("") }
    var preflight by remember { mutableStateOf<JSONObject?>(null) }; var preflightInput by remember { mutableStateOf("") }
    var selected by remember { mutableStateOf<Set<String>>(emptySet()) }; var selectedRevisions by remember { mutableStateOf(JSONObject()) }
    var selectedDocuments by remember { mutableStateOf<Set<String>>(emptySet()) }
    var newDraft by remember { mutableStateOf<String?>(null) }; var editing by remember { mutableStateOf<Pair<JSONObject, Boolean>?>(null) }; var addRequest by remember { mutableStateOf(false) }
    val scope = rememberCoroutineScope()
    val selectionKey = "cz-journal-selection:$farmId:$year:$requestId:${route.text("report_id")}"
    fun invalidate() { preflight = null; preflightInput = "" }
    fun contextBinding() = "$farmId:$year:$requestId:$journalOffset:${model.serverVersion}:$reload"
    fun beginLoad(): Long { loadGeneration++; return loadGeneration }
    fun isCurrent(token: Long, binding: String) = token == loadGeneration && binding == contextBinding()
    fun changeContext(name: String, value: String) {
        loadGeneration++
        if (name == "farm") { farmId = value; requestId = "" }
        if (name == "year") { year = value; requestId = "" }
        if (name == "request") requestId = value
        selected = emptySet(); selectedRevisions = JSONObject(); selectedDocuments = emptySet(); journalOffset = 0; knownEntries = emptyMap(); journal = null; operations = emptyList(); currentRequest = null; next = 0; total = 0; listLoaded = false; loadedBinding = ""; loading = false; problem = ""; invalidate()
    }
    fun saveSelection() { model.saveDraft(selectionKey, obj("operation_ids" to JSONArray(selected.sorted()), "revisions" to selectedRevisions, "document_ids" to JSONArray(selectedDocuments.sorted()))) }
    suspend fun load() {
        val token = beginLoad(); val binding = contextBinding()
        val loadFarm = farmId; val loadYear = year; val loadRequest = requestId; val loadOffset = journalOffset
        val context = "$loadFarm:$loadYear:$loadRequest:${model.serverVersion}"
        loading = true; listLoaded = false; loadedBinding = ""; problem = ""; invalidate(); journal = null; currentRequest = null; operations = emptyList(); next = 0; total = 0
        try {
            if (loadFarm.isBlank()) return
            val chosenYear = loadYear.takeIf { it.matches(Regex("\\d{4}")) }?.toIntOrNull()
            require(chosenYear != null && chosenYear in 1900..2200) { "Enter the journal's four-digit application year." }
            val recordedFarm = model.sourceRequest("/farms/$loadFarm")
            if (!isCurrent(token, binding)) return
            require(recordedFarm.data().text("country") == "CZ") { "Choose the recorded Czech farm for this journal." }
            var loadedRequest: JSONObject? = null; var loadedJournal: JSONObject? = null
            if (loadRequest.isNotBlank()) {
                val response = model.sourceRequest("/workflow/questions?request_id=$loadRequest&journal_limit=20&journal_offset=$loadOffset")
                if (!isCurrent(token, binding)) return
                val request = response.getJSONObject("request")
                require(request.data().text("farm_id") == loadFarm && request.data().optInt("reporting_year") == chosenYear && request.data().text("pack_id") == CZECH_JOURNAL_PACK) { "Choose journal paperwork for this same farm, year and Czech journal pack." }
                loadedRequest = request
                loadedJournal = response.optJSONArray("journals")?.objects()?.firstOrNull { it.text("pack_id") == CZECH_JOURNAL_PACK }
                require(loadedJournal != null) { "The journal's current guided checks are unavailable. Reload before preparing it." }
            }
            val page = if (loadedJournal == null) model.sourceRequest("/operations?farm_id=$loadFarm&limit=5&offset=0") else null
            if (!isCurrent(token, binding)) return
            if (ledgerContext != context) knownEntries = emptyMap()
            ledgerContext = context; currentRequest = loadedRequest; journal = loadedJournal
            knownEntries = knownEntries + loadedJournal?.optJSONArray("entries")?.objects().orEmpty().associateBy { it.getString("operation_id") }
            operations = page?.getJSONArray("items")?.objects().orEmpty(); next = operations.size; total = page?.getInt("total") ?: 0
            loadedBinding = binding; listLoaded = true
        } catch (error: CancellationException) { throw error }
        catch (error: Throwable) { if (isCurrent(token, binding)) { journal = null; currentRequest = null; problem = sourceFailure(error) } }
        finally { if (isCurrent(token, binding)) loading = false }
    }
    LaunchedEffect(farmId, year, requestId, model.serverVersion, journalOffset, reload) { load() }
    LaunchedEffect(selectionKey) {
        val draft = model.draft(selectionKey, JSONObject())
        selected = draft.optJSONArray("operation_ids").strings().toSet(); selectedRevisions = draft.optJSONObject("revisions") ?: JSONObject(); selectedDocuments = draft.optJSONArray("document_ids").strings().toSet(); invalidate()
    }
    val requests = (model.records["requests"].orEmpty() + listOfNotNull(currentRequest)).distinctBy { it.getString("id") }.filter { it.data().text("farm_id") == farmId && it.data().text("pack_id") == CZECH_JOURNAL_PACK && it.data().text("reporting_year") == year }
    val entries = journal?.optJSONArray("entries")?.objects() ?: operations.filter { it.data().text("type") == "pesticide_application" && it.data().text("date").take(4) == year }.map { operation -> obj("operation_id" to operation.getString("id"), "operation_revision" to operation.getInt("revision"), "title" to operation.title(), "date" to operation.data().text("date"), "review_status" to operation.data().text("review_status"), "active" to (operation.opt("active") != false && operation.data().opt("superseded_by") !is String), "supersedes_id" to operation.data().opt("supersedes_id"), "issues" to operation.optJSONArray("journal_issues")) }
    val availableEntries = if (journal != null) knownEntries.values.toList() else entries
    val chosenInput = "$selectionKey:${selected.sorted().joinToString(",")}:${selectedRevisions}:${selectedDocuments.sorted().joinToString(",")}"
    val selectionCurrent = listLoaded && loadedBinding == contextBinding() && selected.isNotEmpty() && selected.all { id -> availableEntries.any { it.text("operation_id") == id && it.optInt("operation_revision") == selectedRevisions.optInt(id) && it.text("review_status") == "confirmed" && it.opt("active") != false } }
    fun preparePreview() {
        if (loading || !listLoaded || loadedBinding != contextBinding() || !selectionCurrent || selected.isEmpty() || requestId.isNotBlank() && (preflight?.text("status") != "ready_for_review" || preflightInput != chosenInput)) { invalidate(); problem = "Reload the current journal and explicitly check its selected entries before preparing a preview."; return }
        val body = obj("operation_ids" to JSONArray(selected.sorted()), "selected_document_ids" to JSONArray(selectedDocuments.sorted()))
        val reportId = route.text("report_id")
        if (reportId.isNotBlank()) { body.put("expected_revision", route.getInt("report_revision")); model.enqueue("/reports/$reportId/reissue", body, draftKey = selectionKey) }
        else { body.put("farm_id", farmId).put("request_id", requestId.ifBlank { null }).put("pack_id", CZECH_JOURNAL_PACK).put("reporting_year", year.toInt()); model.enqueue("/reports", body, draftKey = selectionKey) }
        close()
    }
    fun editEntry(id: String, correction: Boolean) { scope.launch {
        val token = beginLoad(); val binding = contextBinding(); val editFarm = farmId
        loading = true; problem = ""; invalidate()
        try {
            val operation = model.sourceRequest("/operations/$id")
            if (!isCurrent(token, binding)) return@launch
            require(operation.data().text("farm_id") == editFarm && operation.data().text("type") == "pesticide_application") { "This is not an authorised application for the selected farm." }
            require(if (correction) operation.data().text("review_status") == "confirmed" && operation.opt("active") != false && operation.data().opt("superseded_by") !is String else operation.data().text("review_status") == "proposed" && operation.opt("active") != false) { "The entry's review status changed. Reload it before choosing an edit or correction." }
            editing = operation to correction
        } catch (error: CancellationException) { throw error }
        catch (error: Throwable) { if (isCurrent(token, binding)) problem = sourceFailure(error) }
        finally { if (isCurrent(token, binding)) loading = false }
    } }
    Sheet("Czech crop-protection journal", close) {
        Text("Record one actual application at a time, then complete and separately review it. Entries on the same field and date stay separate. This prepares a manual journal, not JUDPOR XML transmission or authority acceptance.")
        Choice("Journal farm", farmId, listOf("" to "Choose the recorded farm") + farms.map { it.getString("id") to it.title() }) { if (!loading && !route.has("report_id")) changeContext("farm", it) }
        OutlinedTextField(year, { if (!route.has("report_id")) changeContext("year", it) }, label = { Text("Application year · actual treatment dates decide which entries belong") }, enabled = !route.has("report_id"), modifier = Modifier.fillMaxWidth())
        Choice("Linked letter or request · optional", requestId, listOf("" to "No letter linked · manual journal") + requests.map { it.getString("id") to it.title() }) { if (!loading && !route.has("report_id")) changeContext("request", it) }
        if (!route.has("report_id")) OutlinedButton(onClick = { addRequest = true }, enabled = !loading) { Text("Add optional journal paperwork details") }
        Text(if (requestId.isBlank()) "No letter is linked. Check this journal before approving it." else "The linked request must match this farm, year and Czech journal pack. Its recipient and source details are supplied, not inferred.", style = MaterialTheme.typography.bodySmall)
        if (model.records["requests"].orEmpty().size < (model.totals["requests"] ?: 0)) OutlinedButton(onClick = { model.loadMore("requests") }, enabled = !model.busy) { Text("Load more paperwork choices") }
        if (loading) Text("Loading current journal records and checks…")
        if (problem.isNotBlank()) Text(problem, color = MaterialTheme.colorScheme.error)
        OutlinedButton(onClick = { reload++ }, enabled = !loading) { Text("Reload journal entries and follow-ups") }
        if (farmId.isNotBlank()) {
            CzechHolderRecords(model, farmId, close)
            Button(onClick = { newDraft = UUID.randomUUID().toString() }, enabled = !loading) { Text("Add another actual application") }
        }
        journal?.let { guidance ->
            Text(guidance.text("title"), style = MaterialTheme.typography.titleLarge)
            Text(guidance.text("notice"))
            guidance.optJSONObject("source")?.let { SourceReferences(JSONArray().put(it)) }
            guidance.optJSONObject("counts")?.let { counts -> Text("${counts.optInt("total")} active entries · ${counts.optInt("confirmed")} confirmed · ${counts.optInt("proposed")} proposed · ${counts.optInt("incomplete")} incomplete · ${counts.optInt("pending")} with pending follow-up") }
        }
        journal?.optJSONObject("pagination")?.let { paging ->
            val count = entries.size; val ledgerTotal = paging.getInt("total"); val following = paging.opt("next_offset") as? Number
            Text("Showing ${if (count == 0) 0 else journalOffset + 1}–${journalOffset + count} of $ledgerTotal journal applications, including retained predecessors.", style = MaterialTheme.typography.bodySmall)
            Row { TextButton(onClick = { invalidate(); journalOffset = maxOf(0, journalOffset - 20) }, enabled = !loading && journalOffset > 0) { Text("Previous journal applications") }; TextButton(onClick = { invalidate(); if (following != null) journalOffset = following.toInt() }, enabled = !loading && following != null) { Text("Next journal applications") } }
        }
        if (journal == null && farmId.isNotBlank() && listLoaded) Text("${operations.size} of $total farm activities loaded. Matching crop-treatment applications for this year are shown; this is not a completeness count.", style = MaterialTheme.typography.bodySmall)
        if (!loading && !listLoaded && farmId.isNotBlank()) Text("Journal records are unavailable. Missing entries and follow-ups have not been counted as zero or complete.")
        if (!loading && listLoaded && problem.isBlank() && entries.isEmpty()) Text("No application entries are shown in the current loaded journal records.")
        entries.forEachIndexed { index, entry ->
            val id = entry.getString("operation_id"); val active = entry.opt("active") != false
            Card(Modifier.fillMaxWidth()) { Column(Modifier.padding(14.dp), verticalArrangement = Arrangement.spacedBy(7.dp)) {
                Text("Application ${journalOffset + index + 1} · ${entry.text("title")} · ${entry.text("date")}", fontWeight = FontWeight.Bold)
                Text("${entry.text("review_status")} · revision ${entry.optInt("operation_revision")}" + if (!active) " · retained predecessor, not selected as current" else "")
                entry.optJSONArray("issues")?.objects()?.forEach { Text(it.text("message"), color = if (it.text("severity") == "error") MaterialTheme.colorScheme.error else MaterialTheme.colorScheme.onSurface) }
                Row { Checkbox(id in selected, { include -> selected = if (include) selected + id else selected - id; selectedRevisions = JSONObject(selectedRevisions.toString()).apply { if (include) put(id, entry.getInt("operation_revision")) else remove(id) }; saveSelection(); invalidate() }, enabled = !loading && (id in selected || active && entry.text("review_status") == "confirmed")); Text("Include this exact confirmed application in the report", Modifier.weight(1f).padding(top = 12.dp)) }
                OutlinedButton(onClick = { close(); model.open("operations", id) }) { Text("Open this application for separate review") }
                if (entry.text("review_status") == "proposed" && active) TextButton(onClick = { editEntry(id, false) }, enabled = !loading) { Text("Complete and check this entry") }
                if (entry.text("review_status") == "confirmed" && active) TextButton(onClick = { editEntry(id, true) }, enabled = !loading) { Text("Propose a corrected successor") }
            } }
        }
        if (journal == null && next < total) OutlinedButton(onClick = { scope.launch {
            val token = beginLoad(); val binding = contextBinding(); val loadFarm = farmId; val loadOffset = next
            loading = true; problem = ""; invalidate()
            try { val page = model.sourceRequest("/operations?farm_id=$loadFarm&limit=5&offset=$loadOffset"); if (!isCurrent(token, binding)) return@launch; val received = page.getJSONArray("items").objects(); operations = (operations + received).distinctBy { it.getString("id") }; next = page.optInt("offset", loadOffset) + received.size; total = page.getInt("total") }
            catch (error: CancellationException) { throw error }
            catch (error: Throwable) { if (isCurrent(token, binding)) problem = sourceFailure(error) }
            finally { if (isCurrent(token, binding)) loading = false }
        } }, enabled = !loading) { Text("Load more farm activities to find journal entries") }
        Text("${selected.size} application identities selected. Selection is explicit; no entries are merged by field or date.")
        OutlinedButton(onClick = { selected = emptySet(); selectedRevisions = JSONObject(); saveSelection(); invalidate() }, enabled = !loading && selected.isNotEmpty()) { Text("Clear selected application identities") }
        Text("Supporting evidence for this journal · explicit selection", style = MaterialTheme.typography.titleMedium)
        model.records["documents"].orEmpty().filter { it.data().text("farm_id").isBlank() || it.data().text("farm_id") == farmId }.forEach { document -> Row { Checkbox(document.getString("id") in selectedDocuments, { include -> selectedDocuments = if (include) selectedDocuments + document.getString("id") else selectedDocuments - document.getString("id"); saveSelection(); invalidate() }, enabled = !loading); Text(document.title(), Modifier.weight(1f).padding(top = 12.dp)) } }
        Text("${selectedDocuments.size} supporting documents selected; only loaded document choices are shown.", style = MaterialTheme.typography.bodySmall)
        if (model.records["documents"].orEmpty().size < (model.totals["documents"] ?: 0)) OutlinedButton(onClick = { model.loadMore("documents") }, enabled = !model.busy && !loading) { Text("Load more journal evidence choices") }
        OutlinedButton(onClick = { selectedDocuments = emptySet(); saveSelection(); invalidate() }, enabled = !loading && selectedDocuments.isNotEmpty()) { Text("Clear selected supporting documents") }
        if (selected.isNotEmpty() && !selectionCurrent) Text("A selected entry is unavailable, changed, unconfirmed or replaced. Reload, then remove and explicitly reselect the current entry before checking.", color = MaterialTheme.colorScheme.error)
        if (requestId.isNotBlank()) OutlinedButton(onClick = { scope.launch {
            val checkRevision = currentRequest?.getInt("revision") ?: return@launch
            val token = beginLoad(); val binding = contextBinding(); val checkFarm = farmId; val checkYear = year; val checkRequest = requestId
            val checkOperations = selected.toSet(); val checkDocuments = selectedDocuments.toSet(); val input = chosenInput
            loading = true; problem = ""; invalidate()
            try {
                val result = model.sourceRequest("/requests/$checkRequest/checks?selected_operation_ids=${checkOperations.sorted().joinToString(",")}&selected_document_ids=${checkDocuments.sorted().joinToString(",")}")
                if (!isCurrent(token, binding)) return@launch
                require(result.getJSONObject("selection").getJSONArray("operation_ids").strings().toSet() == checkOperations && result.getJSONObject("selection").getJSONArray("document_ids").strings().toSet() == checkDocuments && result.getString("request_id") == checkRequest && result.getInt("request_revision") == checkRevision && result.getJSONObject("scope").getString("farm_id") == checkFarm && result.getJSONObject("scope").getString("pack_id") == CZECH_JOURNAL_PACK && result.getJSONObject("scope").getInt("reporting_year").toString() == checkYear) { "The checked journal selection changed. Reload and choose the entries again." }
                preflight = result; preflightInput = input
            } catch (error: CancellationException) { throw error }
            catch (error: Throwable) { if (isCurrent(token, binding)) problem = sourceFailure(error) }
            finally { if (isCurrent(token, binding)) loading = false }
        } }, enabled = !loading && requestId.isNotBlank() && selectionCurrent && currentRequest != null) { Text("Check these selected journal entries") }
        preflight?.let { check ->
            Text("Selection check: ${check.text("status").replace('_', ' ')}", style = MaterialTheme.typography.titleMedium)
            Text(check.text("notice"))
            check.optJSONArray("issues")?.objects()?.forEach { Text(it.text("message"), color = if (it.text("severity") == "error") MaterialTheme.colorScheme.error else MaterialTheme.colorScheme.onSurface) }
            Button(onClick = {
                preparePreview()
            }, enabled = !loading && !model.busy && check.text("status") == "ready_for_review" && selectionCurrent && preflightInput == chosenInput) { Text(if (route.has("report_id")) "Prepare separate correction journal with these entries" else "Prepare journal report with these entries") }
        }
        if (requestId.isBlank()) {
            Text("Checking these entries creates a server-validated report preview. Read its outstanding issues and full retained journal details before separately approving it; creating a preview is not confirmation or filing.")
            Button(onClick = { preparePreview() }, enabled = !loading && !model.busy && selectionCurrent && problem.isBlank()) { Text(if (route.has("report_id")) "Check selected entries in a separate correction preview" else "Check selected entries in a journal preview") }
        }
    }
    newDraft?.let { id -> GuidedCapture(model, "pesticide_application", initialFarmId = farmId, draftId = id) { newDraft = null; reload++ } }
    editing?.let { (record, correction) -> GuidedCapture(model, "pesticide_application", record = record, correction = correction) { editing = null; reload++ } }
    if (addRequest) Editor(model, "requests", null, { addRequest = false; reload++ })
}
