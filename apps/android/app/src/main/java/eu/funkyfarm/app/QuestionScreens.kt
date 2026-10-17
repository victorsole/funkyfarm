package eu.funkyfarm.app

import androidx.compose.foundation.layout.*
import androidx.compose.foundation.text.selection.SelectionContainer
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import org.json.JSONArray
import org.json.JSONObject
import java.math.BigDecimal
import java.time.LocalDate

@Composable internal fun GuidedQuestions(model: FarmModel, farm: JSONObject, close: () -> Unit) {
    val requests = model.records["requests"].orEmpty().filter { it.data().optString("farm_id") == farm.optString("id") }
    var requestId by remember(farm.optString("id")) { mutableStateOf(requests.firstOrNull()?.optString("id").orEmpty()) }
    var answering by remember { mutableStateOf<JSONObject?>(null) }
    var loadedQuestions by remember(requestId) { mutableStateOf<JSONObject?>(null) }
    var questionFailure by remember(requestId) { mutableStateOf("") }; var reload by remember { mutableStateOf(0) }
    LaunchedEffect(requestId, model.serverVersion, reload) {
        loadedQuestions = null; questionFailure = ""
        if (requestId.isNotBlank()) try { loadedQuestions = model.sourceRequest("/workflow/questions?request_id=$requestId") }
        catch (error: Throwable) { questionFailure = sourceFailure(error) }
    }
    val response = loadedQuestions
    Sheet("A few answers for your paperwork", close) {
        Text("${farm.title()}. Start with the request you are working on. These questions focus on answers that still need attention; checked answers count towards your progress.")
        if (requests.isEmpty()) {
            Text("Add the letter or request first so the questions match the actual recipient, year and reporting pack.")
            Button(onClick = { model.tab = "Paperwork"; close() }) { Text("Go to paperwork") }
        } else Choice("Which request?", requestId, requests.map { it.getString("id") to it.title() }) { requestId = it; answering = null }
        if (questionFailure.isNotBlank()) { Text(questionFailure, color = MaterialTheme.colorScheme.error); Text("Current questions and journal counts are unavailable. Missing answers or entries have not been counted as zero or complete."); OutlinedButton(onClick = { reload++ }) { Text("Retry current questions and journal counts") } }
        else if (response != null) {
            Text("${response.optInt("completed_count")} of ${response.optInt("total_count")} answers checked", style = MaterialTheme.typography.titleMedium)
            response.optJSONArray("blocked_reasons")?.let { reasons -> repeat(reasons.length()) { Text(reasons.get(it).toString()) } }
            response.optJSONArray("journals")?.objects()?.forEach { journal -> Card(Modifier.fillMaxWidth()) { Column(Modifier.padding(16.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                Text(journal.text("title"), style = MaterialTheme.typography.titleMedium, fontWeight = FontWeight.Bold)
                Text(journal.text("notice"))
                journal.optJSONObject("counts")?.let { Text("${it.optInt("total")} active applications · ${it.optInt("proposed")} proposed · ${it.optInt("incomplete")} incomplete · ${it.optInt("pending")} pending follow-up") }
                if (journal.text("pack_id") == CZECH_JOURNAL_PACK) Button(onClick = { close(); model.czechJournal = obj("farm_id" to farm.getString("id"), "request_id" to requestId, "year" to response.getJSONObject("request").data().optInt("reporting_year")) }) { Text("Complete and review individual journal applications") }
            } } }
            response.optJSONArray("source_tables")?.objects()?.forEach { table -> Card(Modifier.fillMaxWidth()) { Column(Modifier.padding(16.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                Text(table.optString("label"), style = MaterialTheme.typography.titleMedium, fontWeight = FontWeight.Bold)
                Text("${table.optInt("confirmed_count")} confirmed source rows · ${table.optInt("proposed_count")} waiting for review")
                Text("These counts do not establish eligibility or a complete application. Keep the original source units and review each proposed row separately.", style = MaterialTheme.typography.bodySmall)
                OutlinedButton(onClick = { close(); model.sourceImports = obj("profile_id" to table.getString("profile_id"), "farm_id" to farm.getString("id")) }) { Text("Bring in this source table") }
                TextButton(onClick = { close(); model.sourceImports = obj("mode" to "facts", "profile_id" to table.getString("profile_id"), "farm_id" to farm.getString("id")) }) { Text("Review saved rows from this table") }
            } } }
            OutlinedButton(onClick = { reload++ }, enabled = !model.busy) { Text("Refresh checked answers and source rows") }
            response.optJSONArray("questions")?.objects()?.forEach { question -> Card(Modifier.fillMaxWidth()) { Column(Modifier.padding(16.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                Text(question.optString("prompt").ifBlank { question.optString("label") }, style = MaterialTheme.typography.titleMedium, fontWeight = FontWeight.Bold)
                (question.opt("physical_label") as? String)?.takeIf { it.isNotBlank() }?.let { Text(it, style = MaterialTheme.typography.labelLarge) }
                (question.opt("period") as? String)?.takeIf { it.isNotBlank() }?.let { Text("Applies to $it", style = MaterialTheme.typography.bodySmall) }
                val checked = question.optJSONArray("confirmed")?.objects().orEmpty()
                val proposed = question.optJSONArray("proposals")?.objects().orEmpty()
                checked.forEach { record -> Text("Checked answer: ${displayValue(record.data().opt("value"))} ${record.data().optString("unit").takeUnless { it == "null" }.orEmpty()}"); TextButton(onClick = { close(); model.open("facts", record.getString("id")) }) { Text("See this answer and its source") } }
                proposed.forEach { record -> OutlinedButton(onClick = { close(); model.open("facts", record.getString("id")) }) { Text("Review saved answer · ${displayValue(record.data().opt("value"))}") } }
                if (checked.isEmpty()) Text(if (question.optBoolean("required")) "An answer is still needed." else "Optional answer.")
                if (question.optString("state") == "conflict") {
                    Text("The checked sources disagree. Compare them before recording another answer.")
                    OutlinedButton(onClick = { close(); model.tab = "My fields"; model.open("farms", farm.getString("id")) }) { Text("Compare the farm's competing evidence") }
                } else if (question.text("key") == CZECH_HOLDER_KEY || question.text("capture_kind") == "journal_holder") Button(onClick = { close(); model.czechJournal = obj("farm_id" to farm.getString("id"), "request_id" to requestId, "year" to response.getJSONObject("request").data().optInt("reporting_year")) }) { Text("Record and separately review holder details") }
                else Button(onClick = { answering = question }) { Text(if (checked.isEmpty()) "Answer this question" else "Add a corrected answer") }
            } } }
        } else if (requestId.isNotBlank()) Text("Loading questions for this request. A connection is needed to check new answers; your unfinished answers remain saved on this device.")
    }
    answering?.let { question -> response?.optJSONObject("request")?.let { request -> QuestionAnswer(model, request, question) { answering = null } } }
}

@Composable private fun QuestionAnswer(model: FarmModel, request: JSONObject, question: JSONObject, close: () -> Unit) {
    val questionId = (question.opt("id") as? String)?.takeIf { it.isNotBlank() }
    val parcelId = (question.opt("parcel_id") as? String)?.takeIf { it.isNotBlank() }
    val suppliedPeriod = (question.opt("period") as? String)?.takeIf { it.isNotBlank() }
    val physicalLabel = (question.opt("physical_label") as? String).orEmpty()
    // Legacy key-only drafts stay separate: two fields or events can ask the same question.
    val key = "guided-answer:${request.getString("id")}:${questionId ?: "unresolved:${question.getString("key")}"}"
    var draft by remember(key) { mutableStateOf(model.draft(key, obj("question_id" to questionId, "parcel_id" to parcelId, "physical_label" to physicalLabel, "value" to "", "unit" to question.optString("unit").takeUnless { it == "null" }.orEmpty(), "period" to suppliedPeriod.orEmpty(), "temporal_basis" to (question.opt("temporal_basis") as? String).orEmpty(), "expected_request_revision" to request.getInt("revision"), "note" to "", "unknown" to false))) }
    var acknowledgements by remember { mutableStateOf<Set<String>>(emptySet()) }
    var error by remember { mutableStateOf("") }
    fun update(name: String, value: Any) { draft = JSONObject(draft.toString()).put(name, value); model.saveDraft(key, draft); model.clearAnswer(key); acknowledgements = emptySet() }
    val type = question.optString("value_type", "text")
    val choices = question.optJSONArray("choices")
    fun body(): JSONObject {
        require(questionId != null && draft.optString("question_id") == questionId) { "Refresh the questions before answering this field or event." }
        require((draft.opt("parcel_id") as? String) == parcelId) { "This draft belongs to a different field. Refresh the questions." }
        val raw = draft.optString("value")
        val value: Any = if (draft.optBoolean("unknown")) JSONObject.NULL else when (type) {
            "number", "integer", "decimal" -> { require(raw.matches(Regex("[+-]?\\d+(?:[.,]\\d+)?"))) { "Enter the number without thousands separators, or choose unknown." }; raw }
            "boolean" -> when (raw) { "true" -> true; "false" -> false; "null" -> JSONObject.NULL; else -> error("Choose yes, no or unknown.") }
            "choice" -> { require(draft.has("choice_value")) { "Choose one of the supplied answers." }; draft.get("choice_value") }
            "date" -> LocalDate.parse(raw).toString()
            else -> { require(raw.isNotBlank()) { "Enter your answer or choose unknown." }; raw }
        }
        val sources = JSONArray()
        val documentId = draft.optString("document_id")
        if (documentId.isNotBlank()) {
            val document = model.records["documents"].orEmpty().find { it.optString("id") == documentId } ?: error("Choose a document available to this account.")
            val source = obj("document_id" to documentId, "document_revision" to document.getInt("revision"))
            if (draft.optString("quote").isNotBlank()) source.put("quote", draft.getString("quote"))
            if (draft.optString("page").isNotBlank()) source.put("page", draft.getString("page").toInt().also { require(it > 0) })
            sources.put(source)
        } else if (draft.optString("note").isNotBlank()) sources.put(obj("type" to "manual", "note" to draft.getString("note")))
        require(draft.optString("note").isNotBlank()) { "Say where you checked this answer." }
        require(draft.optString("temporal_basis") in listOf("static", "campaign_year", "calendar_date")) { "Choose when this answer applies." }
        val basis = draft.getString("temporal_basis")
        var period = (draft.opt("period") as? String)?.takeIf { it.isNotBlank() }
        if (suppliedPeriod != null) require(period == suppliedPeriod) { "Keep the actual period supplied for this question." }
        if (basis == "calendar_date") {
            if (period == null && type == "date" && value is String) period = value
            require(period != null) { "Enter the actual observation date. A reporting year alone is not a date." }
            val date = LocalDate.parse(period)
            require(date.year == request.data().getInt("reporting_year")) { "Use an actual date in this request's reporting year." }
            if (type == "date" && value is String) require(value == period) { "The answer date and observation date must describe the same event." }
        }
        if (basis == "static") require(period == null) { "A standing farm detail has no annual or observation date." }
        return obj("request_id" to request.getString("id"), "expected_request_revision" to draft.getInt("expected_request_revision"), "question_id" to questionId, "parcel_id" to parcelId, "key" to question.getString("key"), "value" to value, "unit" to draft.optString("unit").ifBlank { null }, "temporal_basis" to basis, "period" to period, "sources" to sources, "note" to draft.optString("note"))
    }
    Sheet(question.optString("label", "Your answer"), close) {
        Text(question.optString("prompt").ifBlank { question.optString("label") }, style = MaterialTheme.typography.titleLarge)
        if (physicalLabel.isNotBlank()) Text(physicalLabel, style = MaterialTheme.typography.titleMedium)
        if (questionId == null) Text("Refresh the questions before saving. This answer needs its specific field and event context.")
        if (type == "boolean") Choice("Your answer", draft.optString("value"), listOf("true" to "Yes", "false" to "No", "null" to "I do not know yet")) { update("value", it) }
        else {
            if (choices != null && choices.length() > 0) {
                val options = (0 until choices.length()).map { index -> index.toString() to choices.getJSONObject(index).optString("label") }
                Choice("Choose an answer", draft.optString("choice_index"), options) { index -> update("choice_value", choices.getJSONObject(index.toInt()).get("value")); update("choice_index", index) }
            } else OutlinedTextField(draft.optString("value"), { update("value", it) }, label = { Text(if (type == "date") "Date · YYYY-MM-DD" else "Your answer") }, modifier = Modifier.fillMaxWidth())
            Row { Checkbox(draft.optBoolean("unknown"), { update("unknown", it) }); Text("I do not know yet", Modifier.weight(1f).padding(top = 12.dp)) }
        }
        if (question.has("unit") && question.opt("unit") != JSONObject.NULL) OutlinedTextField(draft.optString("unit"), { update("unit", it) }, label = { Text("Unit exactly as recorded") }, modifier = Modifier.fillMaxWidth())
        if (question.opt("temporal_basis") !is String) Choice("When does this answer apply?", draft.optString("temporal_basis"), listOf("static" to "A standing farm detail", "campaign_year" to "This reporting year", "calendar_date" to "An actual observation date")) { basis -> update("temporal_basis", basis); if (basis == "static") update("period", "") }
        if (suppliedPeriod != null) Text("This question concerns $suppliedPeriod. Choose a different question to answer another field or event.", style = MaterialTheme.typography.bodySmall)
        else if (draft.optString("temporal_basis") in listOf("campaign_year", "calendar_date")) {
            if (draft.optString("temporal_basis") == "calendar_date" && type == "date" && draft.optString("period").isBlank()) Text("The date you enter above is the actual date of this event.", style = MaterialTheme.typography.bodySmall)
            else OutlinedTextField(draft.optString("period"), { update("period", it) }, label = { Text(if (draft.optString("temporal_basis") == "calendar_date") "Actual observation date · YYYY-MM-DD" else "Year this answer concerns") }, modifier = Modifier.fillMaxWidth())
        }
        Choice("Which document supports this? · optional", draft.optString("document_id"), listOf("" to "A manual answer / no document selected") + model.records["documents"].orEmpty().map { it.getString("id") to it.title() }) { update("document_id", it) }
        if (draft.optString("document_id").isNotBlank()) {
            OutlinedTextField(draft.optString("page"), { update("page", it) }, label = { Text("Source page · if known") }, modifier = Modifier.fillMaxWidth())
            OutlinedTextField(draft.optString("quote"), { update("quote", it) }, label = { Text("Exact passage from the source · optional") }, modifier = Modifier.fillMaxWidth().heightIn(min = 90.dp))
        }
        OutlinedTextField(draft.optString("note"), { update("note", it) }, label = { Text("Where did this answer come from?") }, modifier = Modifier.fillMaxWidth())
        val keepPending = (type == "boolean" && draft.optString("value") == "null") || (type == "choice" && draft.optBoolean("unknown"))
        if (keepPending) {
            Text("Keep this question pending until you know the answer. Unknown is never treated as no.")
            OutlinedButton(onClick = close) { Text("Keep unanswered for now") }
        }
        question.optJSONArray("source_references")?.let { references -> if (references.length() > 0) { Text("References supplied for this question", style = MaterialTheme.typography.titleMedium); SelectionContainer { Text(references.toString(2), style = MaterialTheme.typography.bodySmall) } } }
        if (error.isNotBlank()) Text(error, color = MaterialTheme.colorScheme.error)
        OutlinedButton(onClick = { runCatching { model.previewAnswer(key, body()) }.onFailure { error = it.message ?: "Check this answer." } }, enabled = !model.busy && !keepPending && questionId != null) { Text("Check my answer") }
        model.extras["answer:$key"]?.optJSONObject("result")?.optJSONObject("check")?.let { check ->
            check.optJSONArray("issues")?.objects()?.forEach { issue -> Text(issue.optString("message")) }
            val required = check.optJSONArray("requires_acknowledgement")?.let { codes -> (0 until codes.length()).map { codes.getString(it) } }.orEmpty()
            required.forEach { code -> val message = check.optJSONArray("issues")?.objects()?.find { it.optString("code") == code }?.optString("message") ?: code.replace('_', ' '); Row { Checkbox(code in acknowledgements, { selected -> acknowledgements = if (selected) acknowledgements + code else acknowledgements - code }); Text(message, Modifier.weight(1f).padding(top = 12.dp)) } }
            Button(onClick = { runCatching { model.saveAnswer(key, body(), acknowledgements.toList()); close() }.onFailure { error = it.message ?: "Check this answer again." } }, enabled = check.optBoolean("can_save") && required.all { it in acknowledgements } && !model.busy && questionId != null) { Text("Save answer for review") }
        }
        Text("Saving keeps this as a proposal. You or your adviser must still check and confirm the exact answer before it can support an approved report.", style = MaterialTheme.typography.bodySmall)
    }
}

private fun displayValue(value: Any?): String = when (value) { null, JSONObject.NULL -> "Unknown"; true -> "Yes"; false -> "No"; else -> value.toString() }
