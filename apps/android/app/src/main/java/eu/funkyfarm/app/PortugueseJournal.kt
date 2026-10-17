package eu.funkyfarm.app

import android.content.Intent
import android.net.Uri
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.text.selection.SelectionContainer
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.launch
import org.json.JSONArray
import org.json.JSONObject
import java.time.LocalDate
import java.util.UUID
import java.net.URI

private const val PT_PACK = "pt-ppp-surface-journal"
private const val PT_FACT = "pt.ppp.surface_journal"
private const val PT_SCHEMA = "pt-ppp-surface-v1"
private val ptKeyboard = KeyboardOptions(autoCorrectEnabled = false)
private fun ptLiteral(value: Any?): String = when { value == null || value === JSONObject.NULL -> "Unknown · null"; value == "" -> "Supplied blank · empty text"; else -> value.toString() }
private fun ptLength(value: String) = value.codePointCount(0, value.length)
private fun ptRowPreview(value: Any?): String = ptLiteral(value).let { text -> if (ptLength(text) <= 120) text else text.substring(0, text.offsetByCodePoints(0, 120)) + "… · open the row for the complete literal text" }
private fun ptCurrent(fact: JSONObject) = fact.data().text("review_status") == "confirmed" && fact.data().opt("superseded_by") !is String
private fun ptDate(row: JSONObject): LocalDate? = (row.opt("actual_date") as? String)?.takeIf { it.matches(Regex("[0-9]{4}-[0-9]{2}-[0-9]{2}")) }?.let { runCatching { LocalDate.parse(it).takeIf { parsed -> parsed.toString() == it && parsed.year in 1..9999 } }.getOrNull() }
private fun ptExclusion(row: JSONObject, year: Int?): String? = when {
    ptDate(row) == null -> "No explicit actual ISO date · retained as an undated draft"
    !row.optBoolean("date_confirmed") -> "The separate actual date has not been confirmed"
    ptDate(row)!!.isAfter(LocalDate.now()) -> "Actual date is in the future"
    year == null -> "Choose the report's selection year"
    ptDate(row)!!.year != year -> "Actual date is outside the selected report year"
    else -> null
}
private fun ptCanWrite(owner: JSONObject, farmId: String): Boolean {
    val workspace = owner.getJSONObject("workspace"); val farms = workspace.optJSONArray("farm_ids")
    if (farms != null && (0 until farms.length()).none { farms.optString(it) == farmId }) return false
    val permissions = workspace.optJSONArray("permissions") ?: JSONArray()
    return workspace.text("role") == "owner" || (0 until permissions.length()).any { permissions.optString(it) == "review" }
}
private fun ptCheckedSchema(pack: JSONObject): JSONObject {
    require(pack.getString("id") == PT_PACK)
    val schema = pack.getJSONObject("manual_schema"); val columns = schema.getJSONArray("columns")
    require(schema.getString("schema_id") == PT_SCHEMA && schema.getString("fact_key") == PT_FACT && columns.length() == 13 && columns.objects().map { it.getString("key") }.distinct().size == 13)
    require(schema.getJSONObject("limits").getInt("block_size") == 16 && schema.getJSONObject("limits").getInt("max_entries") == 256)
    columns.objects().forEach { it.getString("label"); it.getString("column"); it.getString("hint") }
    return schema
}

/** Only the producer review item carries this retained context; no full snapshot is fetched. */
internal fun checkedPortugueseReportContext(item: JSONObject, year: Int): JSONObject {
    val context = item.optJSONObject("journal_context") ?: error("The retained journal source and exclusion details are missing. This page has not been reviewed; reload it before approval.")
    require(context.getString("schema_id") == PT_SCHEMA && context.getInt("reporting_year") == year && context.getString("source_fact_id") == item.getString("fact_id") && context.getInt("source_fact_revision") == item.getInt("fact_revision")) { "The retained journal context does not match this exact answer and report year." }
    UUID.fromString(context.getString("source_fact_id"))
    require(context.getString("source_fact_hash").matches(Regex("[0-9a-fA-F]{64}")))
    val source = context.getJSONObject("source")
    listOf("title", "url", "page_url", "edition").forEach { source.getString(it) }
    require(source.getString("sha256").matches(Regex("[0-9a-fA-F]{64}")))
    val selection = context.getJSONObject("selection"); val ids = selection.getJSONArray("entry_ids")
    require(selection.opt("acknowledged_unresolved") == true && ids.length() in 1..256)
    val selected = (0 until ids.length()).map { UUID.fromString(ids.getString(it)).toString() }
    require(selected.distinct().size == selected.size)
    val excluded = context.getJSONArray("excluded_entries"); require(excluded.length() + selected.size <= 256)
    val excludedIds = (0 until excluded.length()).map { at -> val row = excluded.getJSONObject(at); require(row.getString("reason") in listOf("date_missing", "date_unconfirmed", "future_date", "different_year", "not_selected")); require(row.has("actual_date") && (row.isNull("actual_date") || ptDate(obj("actual_date" to row.get("actual_date"))) != null)); UUID.fromString(row.getString("entry_id")).toString() }
    require(excludedIds.distinct().size == excludedIds.size && excludedIds.none { it in selected })
    context.getString("capability_notice")
    return context
}

@Composable internal fun RetainedPortugueseReportContext(context: JSONObject, position: Int) {
    val source = context.getJSONObject("source"); val selected = context.getJSONObject("selection").getJSONArray("entry_ids"); val excluded = context.getJSONArray("excluded_entries")
    var expanded by remember(context.toString()) { mutableStateOf(false) }; var selectedPage by remember(context.toString()) { mutableStateOf(0) }; var excludedPage by remember(context.toString()) { mutableStateOf(0) }
    Text("Retained manual journal · app selection year ${context.getInt("reporting_year")} · ${selected.length()} selected rows · ${excluded.length()} excluded rows", style = MaterialTheme.typography.titleSmall)
    Text(source.getString("title")); Text(source.getString("edition"), style = MaterialTheme.typography.bodySmall)
    Text(context.getString("capability_notice"))
    TextButton(onClick = { expanded = !expanded }) { Text("${if (expanded) "Hide" else "Show"} retained journal source and exclusions · answer $position") }
    if (!expanded) return
    Text("This is the source-row selection retained in this snapshot, not a lookup of today's source fact. Raw cell values follow as individual paged answers; Entry 1, Entry 2 and so on use this retained selected order. Report approval remains a separate human action.")
    LiteralField("Retained source fact revision", context.getInt("source_fact_revision")); LiteralField("Retained source fact identity", context.getString("source_fact_id")); LiteralField("Retained literal table SHA-256", context.getString("source_fact_hash")); LiteralField("Retained source workbook SHA-256", source.getString("sha256"))
    PtRetainedSourceLink(source.getString("url"), "Open the retained official workbook link")
    PtRetainedSourceLink(source.getString("page_url"), "Open the retained official reference page")
    Text("Selected order · internal source-row identities, not official identifiers", style = MaterialTheme.typography.titleSmall)
    val selectedStart = selectedPage * 16; val selectedEnd = minOf(selectedStart + 16, selected.length())
    Text("${selectedStart + 1}–$selectedEnd of ${selected.length()} selected rows")
    for (at in selectedStart until selectedEnd) Text("Entry ${at + 1} · ${selected.getString(at)}")
    Row { TextButton(onClick = { selectedPage-- }, enabled = selectedPage > 0) { Text("Previous 16 retained selected IDs") }; TextButton(onClick = { selectedPage++ }, enabled = selectedEnd < selected.length()) { Text("Next 16 retained selected IDs") } }
    Text("Rows retained in the source but excluded from this report", style = MaterialTheme.typography.titleSmall)
    if (excluded.length() == 0) Text("No source rows were excluded in this retained selection.")
    else {
        val start = excludedPage * 16; val end = minOf(start + 16, excluded.length()); Text("${start + 1}–$end of ${excluded.length()} excluded rows")
        for (at in start until end) { val row = excluded.getJSONObject(at); Text("Excluded source row ${at + 1} · ${row.getString("entry_id")}"); Text("Separately supplied actual date: ${ptLiteral(row.opt("actual_date"))}"); Text(when (row.getString("reason")) { "date_missing" -> "No separate actual date was supplied; literal text remains in the source."; "date_unconfirmed" -> "The separate actual date had not been explicitly confirmed."; "future_date" -> "The supplied actual date was in the future when this report was prepared."; "different_year" -> "The supplied actual date belongs to a different report selection year."; else -> "The person preparing this report did not select this row." }) }
        Row { TextButton(onClick = { excludedPage-- }, enabled = excludedPage > 0) { Text("Previous 16 retained exclusions") }; TextButton(onClick = { excludedPage++ }, enabled = end < excluded.length()) { Text("Next 16 retained exclusions") } }
    }
    Text("Unresolved literal fields were explicitly acknowledged for this selection. Exclusion is not deletion, and neither selection nor a source edition establishes legal completeness or filing.")
}

@Composable private fun PtRetainedSourceLink(raw: String, label: String) {
    val context = LocalContext.current
    val uri = runCatching { URI(raw).takeIf { it.scheme == "https" && !it.host.isNullOrBlank() && it.rawUserInfo == null } }.getOrNull()
    var error by remember(raw) { mutableStateOf("") }
    if (uri == null) Text("$label · safe HTTPS link unavailable")
    else OutlinedButton(onClick = { runCatching { context.startActivity(Intent(Intent.ACTION_VIEW, Uri.parse(uri.toASCIIString()))) }.onFailure { error = "The browser could not open this source link. Nothing was sent." } }) { Text("$label · opens browser") }
    if (error.isNotBlank()) Text(error, color = MaterialTheme.colorScheme.error)
}

@Composable internal fun PortugueseJournal(model: FarmModel, initialFarmId: String? = null, initialFactId: String? = null, requestId: String? = null, reissueRecord: JSONObject? = null, close: () -> Unit) {
    val owner = model.session ?: return
    val binding = "${model.origin}:${owner.getJSONObject("user").getString("id")}:${owner.getJSONObject("workspace")}:${model.serverVersion}:$initialFarmId:$initialFactId:$requestId:${reissueRecord?.getString("id")}:${reissueRecord?.getInt("revision")}:${reissueRecord?.data()?.text("checksum")}"
    key(binding) { PortugueseJournalHome(model, owner, initialFarmId, initialFactId, requestId, reissueRecord, close) }
}

@Composable private fun PortugueseJournalHome(model: FarmModel, owner: JSONObject, initialFarmId: String?, initialFactId: String?, requestId: String?, reissueRecord: JSONObject?, close: () -> Unit) {
    val farms = model.records["farms"].orEmpty().filter { it.data().text("country") == "PT" }
    var farmId by remember { mutableStateOf(initialFarmId ?: farms.singleOrNull()?.getString("id").orEmpty()) }
    var farm by remember { mutableStateOf<JSONObject?>(null) }; var schema by remember { mutableStateOf<JSONObject?>(null) }
    var request by remember { mutableStateOf<JSONObject?>(null) }; var report by remember { mutableStateOf<JSONObject?>(null) }
    var offset by remember { mutableStateOf(0) }; var page by remember { mutableStateOf<JSONObject?>(null) }; var attempt by remember { mutableStateOf(0) }
    var loading by remember { mutableStateOf(false) }; var problem by remember { mutableStateOf("") }
    var selected by remember { mutableStateOf(initialFactId) }; var editor by remember { mutableStateOf<Pair<JSONObject?, Boolean>?>(null) }
    LaunchedEffect(farmId, offset, attempt) {
        farm = null; schema = null; page = null; request = null; report = null; loading = true; problem = ""
        try {
            if (farmId.isBlank()) return@LaunchedEffect
            val currentFarm = model.sourceRequest("/farms/${UUID.fromString(farmId)}")
            require(currentFarm.getString("id") == farmId && currentFarm.data().text("country") == "PT") { "Choose an authorised Portuguese farm for this record." }
            val definition = ptCheckedSchema(model.sourceRequest("/packs/$PT_PACK"))
            val currentReport = reissueRecord?.let { original ->
                model.sourceRequest("/reports/${UUID.fromString(original.getString("id"))}?view=review").also { current ->
                    require(current.getString("id") == original.getString("id") && current.getInt("revision") == original.getInt("revision") && current.data().getString("checksum") == original.data().getString("checksum") && current.data().text("status") in listOf("draft", "issued") && current.data().text("status") == original.data().text("status") && current.data().text("farm_id") == farmId && current.data().text("pack_id") == PT_PACK && current.data().text("request_id") == original.data().text("request_id") && current.data().getInt("reporting_year") == original.data().getInt("reporting_year")) { "The report or its original scope changed. Reopen that exact report before preparing a fresh preview." }
                }
            }
            require(currentReport == null || requestId == null || requestId == currentReport.data().text("request_id")) { "A correction must keep its original linked letter, including no letter." }
            val linkedRequest = (currentReport?.data()?.text("request_id") ?: requestId.orEmpty()).takeIf(String::isNotBlank)?.let { linked ->
                model.sourceRequest("/requests/${UUID.fromString(linked)}").also { actual -> require(actual.getString("id") == linked && actual.data().text("farm_id") == farmId && actual.data().text("pack_id") == PT_PACK && (currentReport == null || actual.data().getInt("reporting_year") == currentReport.data().getInt("reporting_year"))) { "The actual letter is not a matching Portuguese journal request for this farm and year. No other letter was substituted." } }
            }
            val facts = model.sourceRequest("/facts?farm_id=$farmId&fact_key=$PT_FACT&limit=$SOURCE_FACT_PAGE_SIZE&offset=$offset")
            if (model.session !== owner) throw CancellationException()
            require(facts.getJSONArray("items").objects().all { it.data().text("farm_id") == farmId && it.data().text("key") == PT_FACT }) { "The filtered journal page did not match this farm and source type." }
            farm = currentFarm; schema = definition; page = facts; report = currentReport; request = linkedRequest
            if (currentReport != null || linkedRequest != null) {
                val pointer = currentReport?.let { original -> obj("id" to original.getString("id"), "revision" to original.getInt("revision"), "data" to JSONObject().apply { listOf("farm_id", "pack_id", "request_id", "reporting_year", "checksum", "status", "title").forEach { field -> if (original.data().has(field)) put(field, original.data().get(field)) } }) }
                model.saveDraft("pt-journal-preparation:$farmId", obj("farm_id" to farmId, "request_id" to linkedRequest?.getString("id"), "report" to pointer))
            }
        } catch (error: CancellationException) { throw error }
        catch (error: Throwable) { problem = sourceFailure(error) }
        finally { loading = false }
    }
    Sheet("Portuguese surface-treatment record", close) {
        Text("Manual preparation from DGAV's literal surface-treatment model. Keep the supplied words, identifiers and units. No quantities are calculated, no dated operations are invented and nothing is sent to an authority.")
        if (requestId != null || reissueRecord != null) Text("Linked farm: ${farm?.title() ?: "Checking the exact authorised farm…"}")
        else Choice("Portuguese farm", farmId, listOf("" to "Choose the actual farm") + farms.map { it.getString("id") to it.title() }) { farmId = it; offset = 0; selected = null; editor = null }
        if (model.records["farms"].orEmpty().size < (model.totals["farms"] ?: 0)) OutlinedButton(onClick = { model.loadMore("farms") }, enabled = !model.busy) { Text("Load more farm choices") }
        if (loading) Text("Loading this farm and the retained source model…")
        if (problem.isNotBlank()) Text(problem, color = MaterialTheme.colorScheme.error)
        OutlinedButton(onClick = { attempt++ }, enabled = !loading) { Text("Reload Portuguese journal records") }
        if (schema != null && farm != null) {
            Text(schema!!.getString("notice"))
            report?.let { Text("Preparing a separate ${if (it.data().text("status") == "issued") "correction to the exact issued report" else "fresh preview from the exact draft report"}, revision ${it.getInt("revision")}. The retained snapshot stays unchanged and approval remains a separate step.") }
            if (request != null) Text("Actual linked letter: ${request!!.title()} · selection year ${request!!.data().getInt("reporting_year")}")
            else Text("No letter is linked. This is manual preparation only; a recipient and official process have not been invented.")
            PtSourceEdition(schema!!)
            Button(onClick = { editor = null to false }, enabled = ptCanWrite(owner, farmId)) { Text("Start a literal manual record") }
            if (!ptCanWrite(owner, farmId)) Text("This farm is read-only through your current grant.")
            page?.let { result ->
                val values = result.getJSONArray("items").objects(); val total = result.getInt("total")
                Text("${if (values.isEmpty()) 0 else offset + 1}–${offset + values.size} of $total Portuguese journal facts")
                values.filter { it.data().text("key") == PT_FACT }.forEach { fact -> OutlinedButton(onClick = { selected = fact.getString("id") }) { Text("${fact.title()} · ${fact.data().text("review_status")}" + if (fact.data().opt("superseded_by") is String) " · retained predecessor" else "") } }
                Row { TextButton(onClick = { offset = maxOf(0, offset - SOURCE_FACT_PAGE_SIZE) }, enabled = !loading && offset > 0) { Text("Previous journal facts") }; TextButton(onClick = { offset += values.size }, enabled = !loading && values.isNotEmpty() && offset + values.size < total) { Text("Next journal facts") } }
            }
        }
    }
    val currentFarm = farm; val currentSchema = schema
    if (currentFarm != null && currentSchema != null) {
        editor?.let { (fact, correction) -> PtJournalEditor(model, owner, currentFarm, currentSchema, fact, correction) { editor = null; attempt++ } }
        selected?.let { id -> PtJournalRecord(model, owner, currentFarm, currentSchema, id, report, request, { selected = null; attempt++ }, { fact, correction -> selected = null; editor = fact to correction }, close) }
    }
}

@Composable private fun PtSourceEdition(schema: JSONObject) {
    Text("Retained source model", style = MaterialTheme.typography.titleMedium)
    val source = schema.getJSONObject("source")
    listOf("title", "file", "sheet", "edition", "url", "sha256").forEach { key -> source.opt(key)?.takeUnless { it === JSONObject.NULL }?.let { LiteralField(key.replace('_', ' '), it) } }
    Text("The source edition is not an application date, legal applicability decision or proof of the treatments you type.", style = MaterialTheme.typography.bodySmall)
}

private suspend fun ptCheckDocuments(model: FarmModel, owner: JSONObject, farmId: String, sources: JSONArray): List<JSONObject> {
    return sources.objects().filter { it.text("document_id").isNotBlank() }.map { source ->
        val id = source.getString("document_id"); val revision = source.getInt("document_revision")
        val document = model.sourceRequest("/documents/${UUID.fromString(id)}")
        if (model.session !== owner) throw CancellationException()
        require(document.getString("id") == id && document.data().text("farm_id") == farmId && document.getInt("revision") == revision) { "A selected source document or its farm scope changed. Reopen the journal and choose the current source; no document revision was substituted." }
        obj("id" to id, "revision" to revision, "title" to document.title())
    }
}

@Composable private fun PtJournalRecord(model: FarmModel, owner: JSONObject, farm: JSONObject, schema: JSONObject, id: String, reissue: JSONObject?, request: JSONObject?, back: () -> Unit, edit: (JSONObject, Boolean) -> Unit, closeJournal: () -> Unit) {
    val scope = rememberCoroutineScope(); val farmId = farm.getString("id")
    var fact by remember(id) { mutableStateOf<JSONObject?>(null) }; var attempt by remember(id) { mutableStateOf(0) }
    var loading by remember(id) { mutableStateOf(true) }; var problem by remember(id) { mutableStateOf("") }; var busy by remember(id) { mutableStateOf(false) }
    var documents by remember(id) { mutableStateOf<List<JSONObject>>(emptyList()) }; var sourcesCurrent by remember(id) { mutableStateOf(false) }
    var resume by remember(id) { mutableStateOf<JSONObject?>(null) }
    LaunchedEffect(id, attempt, farm.getInt("revision"), schema.toString()) {
        fact = null; documents = emptyList(); sourcesCurrent = false; loading = true; problem = ""
        try {
            val current = model.sourceRequest("/facts/${UUID.fromString(id)}")
            val freshFarm = model.sourceRequest("/farms/$farmId")
            if (model.session !== owner) throw CancellationException()
            require(current.getString("id") == id && current.data().text("farm_id") == farmId && current.data().text("key") == PT_FACT && current.data().getJSONObject("value").text("schema_id") == PT_SCHEMA && freshFarm.getString("id") == farmId && freshFarm.getInt("revision") == farm.getInt("revision") && freshFarm.data().text("country") == "PT") { "The source journal or farm changed. Return to the current farm before continuing." }
            try { documents = ptCheckDocuments(model, owner, farmId, current.data().optJSONArray("sources") ?: JSONArray()); sourcesCurrent = true }
            catch (error: CancellationException) { throw error }
            catch (error: Throwable) { problem = sourceFailure(error) }
            fact = current
        } catch (error: CancellationException) { throw error }
        catch (error: Throwable) { problem = sourceFailure(error) }
        finally { loading = false }
    }
    Sheet("Read the saved Portuguese journal", back) {
        if (loading) Text("Loading this exact fact, farm and source revisions…")
        if (problem.isNotBlank()) Text(problem, color = MaterialTheme.colorScheme.error)
        OutlinedButton(onClick = { fact = null; attempt++ }, enabled = !loading && !busy) { Text("Reload journal and original source revisions") }
        fact?.let { record -> key(record.getInt("revision"), schema.toString()) {
            val value = record.data().getJSONObject("value"); val rows = value.getJSONArray("entries").objects(); val canWrite = ptCanWrite(owner, farmId)
            var page by remember { mutableStateOf(0) }; var openRow by remember { mutableStateOf<String?>(null) }
            var compared by remember { mutableStateOf<Set<String>>(emptySet()) }; var globalsChecked by remember { mutableStateOf(false) }
            val reviewKey = "pt-journal-review:$id:${record.getInt("revision")}"
            val reviewPending = model.queue().any { it.text("draft_key") == reviewKey }
            var note by remember { mutableStateOf(model.draft(reviewKey, obj("note" to "")).text("note")) }
            Text("${farm.title()} · ${record.data().text("review_status")} · revision ${record.getInt("revision")}")
            val preparation = model.draft("pt-journal-preparation:$farmId", JSONObject())
            if (reissue == null && request == null && preparation.text("farm_id") == farmId && (preparation.optJSONObject("report") != null || preparation.text("request_id").isNotBlank())) {
                OutlinedButton(onClick = { resume = preparation }) { Text(if (preparation.optJSONObject("report") != null) "Resume the separately prepared report correction" else "Resume the actual linked letter preparation") }
                Text("This restores only the saved context pointer after separate fact review. The exact report or letter and your access will be checked again; no rows are selected automatically.", style = MaterialTheme.typography.bodySmall)
            }
            PtSourceEdition(schema)
            Text("Producer / company / authorised entity", style = MaterialTheme.typography.labelLarge); SelectionContainer { Text(ptLiteral(value.opt("identity_text"))) }
            Text("Global observations · whole document", style = MaterialTheme.typography.labelLarge); SelectionContainer { Text(ptLiteral(value.opt("observations_text"))) }
            Text("No totals, code validation, product-use permission or official completeness is established by this literal record.")
            if (!sourcesCurrent) Text("Source document revisions are unavailable or changed, not empty. The literal fact remains visible for comparison, but confirmation and report preparation are blocked. Edit the proposal, or propose a correction with current source references.", color = MaterialTheme.colorScheme.error)
            else if (documents.isEmpty()) Text("No documentary source was selected. The manually supplied values are not fabricated document evidence.")
            record.data().optJSONArray("sources")?.objects()?.filter { it.text("document_id").isBlank() }?.forEach { source -> source.keys().asSequence().forEach { field -> LiteralField("Supplied source ${field.replace('_', ' ')}", source.opt(field)) } }
            documents.forEach { document -> OutlinedButton(onClick = { closeJournal(); model.open("documents", document.getString("id")) }) { Text("Compare actual source · ${document.getString("title")} · revision ${document.getInt("revision")}") } }
            val start = page * 16; val visible = rows.drop(start).take(16)
            Text("${if (visible.isEmpty()) 0 else start + 1}–${start + visible.size} of ${rows.size} retained literal rows")
            visible.forEachIndexed { index, row ->
                Text("Row ${start + index + 1} · raw A: ${ptRowPreview(row.getJSONObject("cells").opt(schema.getJSONArray("columns").getJSONObject(0).getString("key")))}")
                Text("Separate actual date: ${ptLiteral(row.opt("actual_date"))} · ${if (row.optBoolean("date_confirmed")) "explicitly checked" else "not confirmed"}")
                OutlinedButton(onClick = { openRow = row.getString("entry_id") }) { Text("Read all 13 literal cells · row ${start + index + 1}" + if (row.getString("entry_id") in compared) " · compared" else "") }
            }
            Row { TextButton(onClick = { page-- }, enabled = page > 0) { Text("Previous 16 retained rows") }; TextButton(onClick = { page++ }, enabled = start + visible.size < rows.size) { Text("Next 16 retained rows") } }
            if (record.data().text("review_status") == "proposed") {
                OutlinedButton(onClick = { edit(record, false) }, enabled = canWrite && !busy) { Text("Continue editing this proposed table") }
                Row { Checkbox(globalsChecked, { globalsChecked = it }, enabled = canWrite && !busy); Text("I compared the producer identity, global observations and actual source references. Unknown and blank values remain visible.", Modifier.weight(1f).padding(top = 12.dp)) }
                OutlinedTextField(note, { note = it; model.saveDraft(reviewKey, obj("note" to it)) }, label = { Text(if (record.data().has("supersedes_id")) "Explain the literal correction · required" else "What did you compare? · optional review note") }, keyboardOptions = ptKeyboard, enabled = canWrite && !busy && !reviewPending, modifier = Modifier.fillMaxWidth())
                if (reviewPending) Text("This exact confirmation is pending. Use Account → pending changes to retry or compare it; a second confirmation has not been created.")
                Text("${compared.size} of ${rows.size} retained rows explicitly compared. This confirms a private fact, not authority acceptance or legal compliance.")
                Button(onClick = { scope.launch {
                    busy = true; problem = ""
                    try {
                        val latest = model.sourceRequest("/facts/$id"); val currentFarm = model.sourceRequest("/farms/$farmId")
                        require(model.session === owner && latest.getString("id") == id && latest.data().text("farm_id") == farmId && latest.data().text("key") == PT_FACT && latest.getInt("revision") == record.getInt("revision") && currentFarm.getString("id") == farmId && currentFarm.getInt("revision") == farm.getInt("revision") && currentFarm.data().text("country") == "PT") { "The source or farm changed after comparison. Reload before confirming." }
                        ptCheckDocuments(model, owner, farmId, record.data().optJSONArray("sources") ?: JSONArray())
                        model.enqueue("/facts/$id/review", obj("expected_revision" to record.getInt("revision"), "decision" to "confirmed", "note" to note), draftKey = reviewKey); closeJournal(); model.open("facts", id)
                    } catch (error: CancellationException) { throw error }
                    catch (error: Throwable) { problem = sourceFailure(error) }
                    finally { busy = false }
                } }, enabled = canWrite && sourcesCurrent && !reviewPending && globalsChecked && rows.isNotEmpty() && rows.all { it.getString("entry_id") in compared } && (!record.data().has("supersedes_id") || note.isNotBlank()) && !busy && !model.busy) { Text("Confirm this exact literal journal fact") }
            } else if (ptCurrent(record)) {
                OutlinedButton(onClick = { edit(record, true) }, enabled = canWrite && !busy) { Text("Propose a separately reviewed correction") }
                if (sourcesCurrent) PtReportSelection(model, owner, farm, schema, record, reissue, request, closeJournal)
            } else Text("This is a retained rejected or superseded fact. It cannot be selected as a current report source; open the separately confirmed successor.")
            openRow?.let { entryId -> rows.find { it.getString("entry_id") == entryId }?.let { row -> Sheet("Compare retained literal row", { openRow = null }) {
                schema.getJSONArray("columns").objects().forEach { column -> Text("${column.getString("column")} · ${column.getString("label")}", style = MaterialTheme.typography.labelLarge); SelectionContainer { Text(ptLiteral(row.getJSONObject("cells").opt(column.getString("key")))) }; Text(column.getString("hint"), style = MaterialTheme.typography.bodySmall) }
                LiteralField("Separately supplied actual date", row.opt("actual_date")); Text("Actual date explicitly confirmed: ${row.optBoolean("date_confirmed")}")
                if (record.data().text("review_status") == "proposed") Row { Checkbox(entryId in compared, { checked -> compared = if (checked) compared + entryId else compared - entryId }, enabled = canWrite); Text("I compared all 13 literal cells and the separate actual-date choice in this row.", Modifier.weight(1f).padding(top = 12.dp)) }
            } } }
        } }
    }
    resume?.let { context -> PortugueseJournal(model, initialFarmId = farmId, initialFactId = id, requestId = context.text("request_id").takeIf(String::isNotBlank), reissueRecord = context.optJSONObject("report")) { resume = null } }
}

@Composable private fun PtReportSelection(model: FarmModel, owner: JSONObject, farm: JSONObject, schema: JSONObject, fact: JSONObject, reissue: JSONObject?, request: JSONObject?, closeJournal: () -> Unit) {
    val key = "pt-journal-report:${fact.getString("id")}:${reissue?.getString("id") ?: request?.getString("id") ?: "new"}"; val scope = rememberCoroutineScope()
    val contextBinding = "${reissue?.getInt("revision")}:${reissue?.data()?.text("checksum")}:${request?.getString("id")}:${request?.getInt("revision")}"
    val fixedYear = reissue?.data()?.getInt("reporting_year") ?: request?.data()?.getInt("reporting_year")
    fun initial() = obj("farm_revision" to farm.getInt("revision"), "fact_revision" to fact.getInt("revision"), "schema_binding" to schema.toString(), "context_binding" to contextBinding, "year" to fixedYear?.toString().orEmpty(), "entry_ids" to JSONArray(), "extra_facts" to JSONArray(), "attachments" to JSONArray())
    var draft by remember(key) { mutableStateOf(model.draft(key, initial())) }
    var checked by remember { mutableStateOf(false) }; var page by remember { mutableStateOf(0) }; var orderPage by remember { mutableStateOf(0) }; var busy by remember { mutableStateOf(false) }; var problem by remember { mutableStateOf("") }
    var evidencePicker by remember { mutableStateOf<String?>(null) }
    val extraFacts = draft.optJSONArray("extra_facts")?.objects().orEmpty(); val attachments = draft.optJSONArray("attachments")?.objects().orEmpty()
    val rows = fact.data().getJSONObject("value").getJSONArray("entries").objects(); val chosen = draft.getJSONArray("entry_ids").let { values -> (0 until values.length()).map { values.getString(it) } }
    val year = draft.text("year").takeIf { it.matches(Regex("[0-9]{4}")) }?.toIntOrNull()?.takeIf { it in 2000..2200 }
    val matches = draft.getInt("fact_revision") == fact.getInt("revision") && draft.getInt("farm_revision") == farm.getInt("revision") && draft.text("schema_binding") == schema.toString() && draft.text("context_binding") == contextBinding && (fixedYear == null || year == fixedYear)
    val pending = model.queue().any { it.text("draft_key") == key }
    val canWrite = ptCanWrite(owner, farm.getString("id")) && !pending
    fun update(field: String, next: Any) { draft = JSONObject(draft.toString()).put(field, next); model.saveDraft(key, draft); checked = false }
    Text("Choose dated rows for a manual report", style = MaterialTheme.typography.titleLarge)
    Text("The report year is app selection metadata, not a year printed by the source or an inferred application date. Selection starts empty. Only explicitly checked actual dates in that year can be included; raw A is never rewritten.")
    if (pending) Text("An exact report preparation is pending. Retry or compare it in Account → pending changes before editing this selection.")
    if (!matches) Text("This report selection belongs to an older farm, fact or source-model revision. It is retained for comparison and cannot be rebased automatically.", color = MaterialTheme.colorScheme.error)
    if (fixedYear != null) Text("Selection year retained from the actual ${if (reissue != null) "report" else "linked letter"}: $fixedYear")
    else OutlinedTextField(draft.text("year"), { update("year", it) }, label = { Text("Report selection year · YYYY") }, keyboardOptions = ptKeyboard, enabled = matches && canWrite && !busy, modifier = Modifier.fillMaxWidth())
    if (year == null) Text("Choose a four-digit app report year from 2000 to 2200; no treatment date is inferred from it.")
    val start = page * 16; val visible = rows.drop(start).take(16)
    Text("${if (visible.isEmpty()) 0 else start + 1}–${start + visible.size} of ${rows.size} source rows · ${chosen.size} selected")
    visible.forEachIndexed { index, row -> val entryId = row.getString("entry_id"); val exclusion = ptExclusion(row, year)
        Row { Checkbox(entryId in chosen, { selected -> update("entry_ids", JSONArray(if (selected) chosen + entryId else chosen - entryId)) }, enabled = matches && canWrite && !busy); Text("Select retained row ${start + index + 1} · actual date ${ptLiteral(row.opt("actual_date"))}", Modifier.weight(1f).padding(top = 12.dp)) }
        if (exclusion != null) Text("Not ready for this report: $exclusion", color = MaterialTheme.colorScheme.error) else if (entryId !in chosen) Text("Eligible date, but not selected by you. The row remains in the source.")
    }
    Row { TextButton(onClick = { page-- }, enabled = page > 0) { Text("Previous 16 selection rows") }; TextButton(onClick = { page++ }, enabled = start + visible.size < rows.size) { Text("Next 16 selection rows") } }
    Text("Selected report order · no sorting or deduplication", style = MaterialTheme.typography.titleMedium)
    chosen.drop(orderPage * 16).take(16).forEachIndexed { at, entryId -> val position = orderPage * 16 + at; val original = rows.indexOfFirst { it.getString("entry_id") == entryId }
        Text("${position + 1}. ${if (original >= 0) "Source row ${original + 1}" else "Unavailable source row"}")
        Row { TextButton(onClick = { val next = chosen.toMutableList(); val item = next.removeAt(position); next.add(position - 1, item); update("entry_ids", JSONArray(next)) }, enabled = matches && canWrite && position > 0 && !busy) { Text("Move selected row ${position + 1} earlier") }; TextButton(onClick = { val next = chosen.toMutableList(); val item = next.removeAt(position); next.add(position + 1, item); update("entry_ids", JSONArray(next)) }, enabled = matches && canWrite && position < chosen.lastIndex && !busy) { Text("Move selected row ${position + 1} later") } }
    }
    Row { TextButton(onClick = { orderPage-- }, enabled = orderPage > 0) { Text("Previous selected order") }; TextButton(onClick = { orderPage++ }, enabled = (orderPage + 1) * 16 < chosen.size) { Text("Next selected order") } }
    Text("${rows.size - chosen.size} source rows are not selected. They remain in the retained journal, including undated and other-year drafts. Their IDs and exclusion reasons are retained by the report.")
    val identity = fact.data().getJSONObject("value").opt("identity_text") as? String
    if (identity.isNullOrBlank()) Text("A nonblank reviewed producer identity is needed for this app's manual report preparation. This is not a national mandatory-field ruling.", color = MaterialTheme.colorScheme.error)
    Text("Other answers and actual attachments", style = MaterialTheme.typography.titleMedium)
    Text("A linked letter may ask for more than this journal. Choose those confirmed answers and actual documents explicitly. Journal source-document pins are used for validation; they do not automatically attach files. A correction starts with no extra answers or attachments selected, even if the previous report included them.")
    PtReportSelectedChoices("extra confirmed answers", extraFacts, matches && canWrite && !busy) { id -> update("extra_facts", JSONArray(extraFacts.filterNot { it.getString("id") == id })) }
    OutlinedButton(onClick = { evidencePicker = "facts" }, enabled = matches && canWrite && !busy) { Text("Choose extra confirmed answers") }
    PtReportSelectedChoices("actual report attachments", attachments, matches && canWrite && !busy) { id -> update("attachments", JSONArray(attachments.filterNot { it.getString("id") == id })) }
    OutlinedButton(onClick = { evidencePicker = "documents" }, enabled = matches && canWrite && !busy) { Text("Choose actual report attachments") }
    Row { Checkbox(checked, { checked = it }, enabled = matches && canWrite && !busy); Text("I checked the producer identity, global observations, exact selected row order, unresolved literal fields and explicitly selected extra answers and attachments. This is manual preparation, not submission or acceptance.", Modifier.weight(1f).padding(top = 12.dp)) }
    if (problem.isNotBlank()) Text(problem, color = MaterialTheme.colorScheme.error)
    Button(onClick = { scope.launch {
        busy = true; problem = ""
        try {
            val source = model.sourceRequest("/facts/${fact.getString("id")}"); val currentFarm = model.sourceRequest("/farms/${farm.getString("id")}")
            require(model.session === owner && source.getString("id") == fact.getString("id") && source.data().text("key") == PT_FACT && source.getInt("revision") == fact.getInt("revision") && source.data().text("farm_id") == farm.getString("id") && ptCurrent(source) && currentFarm.getString("id") == farm.getString("id") && currentFarm.getInt("revision") == farm.getInt("revision") && currentFarm.data().text("country") == "PT") { "The selected source fact, farm or permission changed. Reopen and compare it; no selection was rebased." }
            ptCheckDocuments(model, owner, farm.getString("id"), source.data().optJSONArray("sources") ?: JSONArray())
            ptCheckReportExtras(model, owner, farm.getString("id"), extraFacts, attachments)
            request?.let { original -> val actual = model.sourceRequest("/requests/${original.getString("id")}"); require(actual.getString("id") == original.getString("id") && actual.getInt("revision") == original.getInt("revision") && actual.data().text("farm_id") == farm.getString("id") && actual.data().text("pack_id") == PT_PACK && actual.data().getInt("reporting_year") == year) { "The linked letter changed. Reopen it before preparing this journal." } }
            val selection = obj("source_fact_id" to fact.getString("id"), "source_fact_revision" to fact.getInt("revision"), "entry_ids" to JSONArray(chosen), "acknowledged_unresolved" to true)
            val selectedFactIds = JSONArray(listOf(fact.getString("id")) + extraFacts.map { it.getString("id") })
            val selectedDocumentIds = JSONArray(attachments.map { it.getString("id") })
            if (reissue != null) {
                val actual = model.sourceRequest("/reports/${reissue.getString("id")}?view=review")
                require(actual.getString("id") == reissue.getString("id") && actual.getInt("revision") == reissue.getInt("revision") && actual.data().text("checksum") == reissue.data().text("checksum") && actual.data().text("status") in listOf("draft", "issued") && actual.data().text("status") == reissue.data().text("status") && actual.data().text("farm_id") == farm.getString("id") && actual.data().text("pack_id") == PT_PACK && actual.data().text("request_id") == reissue.data().text("request_id") && actual.data().getInt("reporting_year") == year) { "The exact report changed. No fresh preview was created against a newer revision." }
                model.enqueue("/reports/${reissue.getString("id")}/reissue", obj("expected_revision" to reissue.getInt("revision"), "snapshot_checksum" to reissue.data().getString("checksum"), "fact_ids" to selectedFactIds, "selected_document_ids" to selectedDocumentIds, "manual_journal_selection" to selection), draftKey = key)
            } else model.enqueue("/reports", obj("farm_id" to farm.getString("id"), "request_id" to request?.getString("id"), "pack_id" to PT_PACK, "reporting_year" to year, "fact_ids" to selectedFactIds, "selected_document_ids" to selectedDocumentIds, "manual_journal_selection" to selection), draftKey = key)
            closeJournal()
        } catch (error: CancellationException) { throw error }
        catch (error: Throwable) { problem = sourceFailure(error); checked = false }
        finally { busy = false }
    } }, enabled = matches && canWrite && checked && year != null && !identity.isNullOrBlank() && chosen.size in 1..256 && chosen.distinct().size == chosen.size && chosen.all { id -> rows.find { it.getString("entry_id") == id }?.let { ptExclusion(it, year) == null } == true } && !busy && !model.busy) { Text(if (reissue == null) "Prepare this exact manual journal report" else if (reissue.data().text("status") == "issued") "Prepare a separate corrected manual journal report" else "Prepare a separate fresh manual journal preview") }
    Text("The next screen is the normal immutable report preview. Review its producer, observations, all literal fields, exclusions and sources before any separate approval or download.")
    TextButton(onClick = { model.deleteDraft(key); draft = initial(); checked = false; page = 0; orderPage = 0 }, enabled = !busy && !pending) { Text("Discard device report selection and start empty") }
    evidencePicker?.let { kind -> PtReportExtraPicker(model, owner, farm.getString("id"), kind, if (kind == "facts") extraFacts else attachments, matches && canWrite && !busy, { evidencePicker = null }) { selected -> update(if (kind == "facts") "extra_facts" else "attachments", JSONArray(selected)) } }
}

@Composable private fun PtNullableInput(label: String, value: Any?, limit: Int, enabled: Boolean, update: (Any) -> Unit) {
    val supplied = value is String
    Row { Checkbox(supplied, { update(if (it) "" else JSONObject.NULL) }, enabled = enabled); Text("$label · value supplied", Modifier.weight(1f).padding(top = 12.dp)) }
    if (supplied) {
        val text = value as String
        OutlinedTextField(text, { update(it) }, label = { Text(label) }, keyboardOptions = ptKeyboard, enabled = enabled, modifier = Modifier.fillMaxWidth())
        if (ptLength(text) > limit) Text("Keep this value within $limit characters; your text has not been shortened.", color = MaterialTheme.colorScheme.error)
        if (text.isEmpty()) Text("Explicit supplied blank. This is different from unknown (null).", style = MaterialTheme.typography.bodySmall)
    } else Text("Unknown · null. Enable value supplied to enter text, including an explicit blank.", style = MaterialTheme.typography.bodySmall)
}

@Composable private fun PtJournalEditor(model: FarmModel, owner: JSONObject, farm: JSONObject, schema: JSONObject, fact: JSONObject?, correction: Boolean, close: () -> Unit) {
    val farmId = farm.getString("id"); val key = "pt-journal:$farmId:${fact?.getString("id") ?: "new"}:${if (correction) "correction" else "edit"}"
    val columns = schema.getJSONArray("columns").objects()
    val initial = obj("farm_revision" to farm.getInt("revision"), "expected_revision" to fact?.optInt("revision"), "schema_binding" to schema.toString(), "value" to (fact?.data()?.optJSONObject("value") ?: obj("schema_id" to PT_SCHEMA, "identity_text" to null, "observations_text" to null, "entries" to JSONArray())), "sources" to (fact?.data()?.optJSONArray("sources") ?: JSONArray()))
    var draft by remember(key) { mutableStateOf(model.draft(key, initial)) }; var rowId by remember { mutableStateOf<String?>(null) }; var page by remember { mutableStateOf(0) }
    var documents by remember { mutableStateOf(false) }; var acknowledgements by remember { mutableStateOf<Set<String>>(emptySet()) }; var problem by remember { mutableStateOf("") }
    val scope = rememberCoroutineScope(); var checking by remember { mutableStateOf(false) }
    val value = draft.getJSONObject("value"); val rows = value.getJSONArray("entries").objects()
    val pending = model.queue().any { it.text("draft_key") == key }
    val editable = !pending && ptCanWrite(owner, farmId) && draft.getInt("farm_revision") == farm.getInt("revision") && draft.text("schema_binding") == schema.toString() && (fact == null || draft.optInt("expected_revision") == fact.getInt("revision") && (if (correction) ptCurrent(fact) else fact.data().text("review_status") == "proposed"))
    fun save(next: JSONObject) { if (model.session === owner) { draft = next; model.saveDraft(key, next); model.clearCheck(key); acknowledgements = emptySet() } }
    fun valueField(name: String, next: Any) { save(JSONObject(draft.toString()).apply { getJSONObject("value").put(name, next) }) }
    fun replaceRows(next: List<JSONObject>) { valueField("entries", JSONArray(next)) }
    fun body(): JSONObject {
        require(editable) { "The farm or source fact changed. Keep this draft for comparison; it cannot be rebased automatically." }
        val literal = JSONObject(value.toString()); val retained = rows.filter { row -> columns.any { column -> (row.getJSONObject("cells").opt(column.getString("key")) as? String)?.isNotBlank() == true } }
        require(rows.filterNot { it in retained }.all { it.opt("actual_date") == null || it.opt("actual_date") === JSONObject.NULL }) { "A row with only a separate actual date needs at least one supplied raw cell, or remove that row explicitly." }
        require(retained.size <= 256)
        listOf("identity_text" to 1000, "observations_text" to 8000).forEach { (field, limit) -> val raw = literal.opt(field); require(raw === JSONObject.NULL || raw is String && ptLength(raw) <= limit) { "Check the literal $field length." } }
        retained.forEach { row -> require(row.getJSONObject("cells").keys().asSequence().toSet() == columns.map { it.getString("key") }.toSet()); columns.forEach { column -> val raw = row.getJSONObject("cells").get(column.getString("key")); require(raw === JSONObject.NULL || raw is String && ptLength(raw) <= 2000) { "Each literal cell may contain at most 2000 characters." } } }
        literal.put("entries", JSONArray(retained))
        val data = obj("farm_id" to farmId, "key" to PT_FACT, "label" to "Portuguese literal surface-treatment record", "value" to literal, "unit" to null, "period" to null, "temporal_basis" to "static", "sources" to draft.getJSONArray("sources"), "review_status" to "proposed")
        if (correction) data.put("supersedes_id", fact!!.getString("id"))
        require(data.toString().toByteArray(Charsets.UTF_8).size <= 512_000) { "This literal table exceeds the 512,000-byte fact budget. Keep a smaller source journal; nothing was truncated." }
        return obj("kind" to "facts", "data" to data).apply { if (fact != null && !correction) put("record_id", fact.getString("id")).put("expected_revision", draft.getInt("expected_revision")) }
    }
    LaunchedEffect(farm.getInt("revision"), fact?.optInt("revision"), schema.toString()) { model.clearCheck(key); acknowledgements = emptySet() }
    Sheet(if (correction) "Propose a corrected Portuguese record" else "Edit a literal Portuguese record", close) {
        Text(farm.title()); Text("Partial and undated drafts are allowed. Raw A is never parsed into an actual date. Empty placeholder rows are omitted when saving; explicit blank cells inside a nonempty row remain blank, not zero or null.")
        if (correction) Text("This creates a new proposed successor. The confirmed source and issued reports remain unchanged until a human separately confirms the correction.")
        if (pending) Text("This exact literal table delivery is pending. Its approved body and retry identity stay fixed. Retry or compare it in Account → pending changes before editing this draft.")
        if (!editable) Text("This device draft belongs to an older farm or fact revision, or your current grant is read-only. Compare it before discarding; no save is enabled.", color = MaterialTheme.colorScheme.error)
        PtNullableInput(schema.getJSONObject("identity").getString("label"), value.opt("identity_text"), 1000, editable) { valueField("identity_text", it) }
        PtNullableInput(schema.getJSONObject("observations").getString("label") + " · whole document", value.opt("observations_text"), 8000, editable) { valueField("observations_text", it) }
        val start = page * 16; val visible = rows.drop(start).take(16)
        Text("${if (visible.isEmpty()) 0 else start + 1}–${start + visible.size} of ${rows.size} draft rows · maximum 256")
        visible.forEachIndexed { index, row ->
            Text("Row ${start + index + 1} · ${ptRowPreview(row.getJSONObject("cells").opt(columns.first().getString("key")))}", fontWeight = FontWeight.Bold)
            Row { OutlinedButton(onClick = { rowId = row.getString("entry_id") }) { Text("Edit literal row ${start + index + 1}") }; TextButton(onClick = { replaceRows(rows.filterNot { it.getString("entry_id") == row.getString("entry_id") }); page = minOf(page, maxOf(0, (rows.size - 2) / 16)) }, enabled = editable) { Text("Remove row ${start + index + 1}") } }
            Row { TextButton(onClick = { val copy = rows.toMutableList(); val position = start + index; val item = copy.removeAt(position); copy.add(position - 1, item); replaceRows(copy) }, enabled = editable && start + index > 0) { Text("Move row ${start + index + 1} earlier") }; TextButton(onClick = { val copy = rows.toMutableList(); val position = start + index; val item = copy.removeAt(position); copy.add(position + 1, item); replaceRows(copy) }, enabled = editable && start + index < rows.lastIndex) { Text("Move row ${start + index + 1} later") } }
        }
        Row { TextButton(onClick = { page-- }, enabled = page > 0) { Text("Previous 16 rows") }; TextButton(onClick = { page++ }, enabled = start + visible.size < rows.size) { Text("Next 16 rows") } }
        Button(onClick = { val row = obj("entry_id" to UUID.randomUUID().toString(), "cells" to JSONObject().apply { columns.forEach { put(it.getString("key"), JSONObject.NULL) } }, "actual_date" to null, "date_confirmed" to false); replaceRows(rows + row); page = rows.size / 16; rowId = row.getString("entry_id") }, enabled = editable && rows.size < 256) { Text("Add a literal row") }
        Text("Optional actual document references", style = MaterialTheme.typography.titleMedium)
        draft.getJSONArray("sources").objects().forEachIndexed { index, source -> Text("Document ${source.text("document_id")} · selected revision ${source.opt("document_revision")}"); TextButton(onClick = { save(JSONObject(draft.toString()).put("sources", JSONArray(draft.getJSONArray("sources").objects().filterIndexed { at, _ -> at != index }))) }, enabled = editable) { Text("Remove source reference ${index + 1}") } }
        OutlinedButton(onClick = { documents = true }, enabled = editable) { Text("Choose an actual source document · optional") }
        Text("Typing the table does not fabricate documentary evidence. You may leave source references empty.")
        if (problem.isNotBlank()) Text(problem, color = MaterialTheme.colorScheme.error)
        OutlinedButton(onClick = { scope.launch {
            checking = true; problem = ""; model.clearCheck(key); acknowledgements = emptySet()
            try {
                val input = body(); val fresh = model.sourceRequest("/farms/$farmId")
                require(model.session === owner && fresh.getString("id") == farmId && fresh.getInt("revision") == draft.getInt("farm_revision") && fresh.data().text("country") == "PT") { "The farm changed. Reopen the current farm before checking this draft." }
                fact?.let { original ->
                    val current = model.sourceRequest("/facts/${original.getString("id")}")
                    require(model.session === owner && current.getString("id") == original.getString("id") && current.getInt("revision") == draft.getInt("expected_revision") && current.data().text("farm_id") == farmId && current.data().text("key") == PT_FACT && (if (correction) ptCurrent(current) else current.data().text("review_status") == "proposed")) { "The source fact changed. Reopen it and compare this retained draft; it cannot be rebased automatically." }
                }
                ptCheckDocuments(model, owner, farmId, input.getJSONObject("data").getJSONArray("sources")); model.checkCapture(key, input)
            }
            catch (error: CancellationException) { throw error }
            catch (error: Throwable) { problem = sourceFailure(error) }
            finally { checking = false }
        } }, enabled = editable && !checking && !model.busy) { Text("Check this literal draft") }
        model.extras["check:$key"]?.optJSONObject("result")?.let { check ->
            check.optJSONArray("issues")?.objects()?.forEach { Text(it.text("message"), color = if (it.text("severity") == "error") MaterialTheme.colorScheme.error else MaterialTheme.colorScheme.onSurface) }
            val required = check.optJSONArray("requires_acknowledgement").strings()
            required.forEach { code -> Row { Checkbox(code in acknowledgements, { checked -> acknowledgements = if (checked) acknowledgements + code else acknowledgements - code }); Text(check.optJSONArray("issues")?.objects()?.find { it.text("code") == code }?.text("message") ?: code, Modifier.weight(1f).padding(top = 12.dp)) } }
            Button(onClick = { runCatching { model.submitCapture(key, body(), acknowledgements.toList()); close() }.onFailure { problem = it.message ?: "Check this literal draft again." } }, enabled = editable && check.optBoolean("can_save") && required.all { it in acknowledgements } && !model.busy) { Text("Save proposed literal record · separate confirmation required") }
        }
        TextButton(onClick = { model.deleteDraft(key); model.clearCheck(key); close() }, enabled = !pending) { Text("Discard this device table draft") }
    }
    rowId?.let { id -> rows.find { it.getString("entry_id") == id }?.let { row -> PtLiteralRowEditor(schema, row, editable, { next -> replaceRows(rows.map { if (it.getString("entry_id") == id) next else it }) }) { rowId = null } } }
    if (documents) PtDocumentPicker(model, owner, farmId, { documents = false }) { document -> val sources = draft.getJSONArray("sources").objects().filterNot { it.text("document_id") == document.getString("id") } + obj("document_id" to document.getString("id"), "document_revision" to document.getInt("revision")); save(JSONObject(draft.toString()).put("sources", JSONArray(sources))); documents = false }
}

@Composable private fun PtLiteralRowEditor(schema: JSONObject, row: JSONObject, enabled: Boolean, update: (JSONObject) -> Unit, close: () -> Unit) {
    fun change(name: String, value: Any) { update(JSONObject(row.toString()).put(name, value)) }
    Sheet("Literal treatment row", close) {
        Text("Copy all values exactly. Supplied zero, blank, unknown and not-applicable wording are distinct. No unit conversion, grouping or amount calculation is performed.")
        schema.getJSONArray("columns").objects().forEach { column ->
            Text("${column.getString("column")} · ${column.getString("source_header")}", style = MaterialTheme.typography.labelLarge)
            Text(column.getString("hint"), style = MaterialTheme.typography.bodySmall)
            column.opt("unit")?.takeUnless { it === JSONObject.NULL }?.let { unit -> Text("Printed unit: " + if (unit is JSONArray) (0 until unit.length()).joinToString(" or ") { unit.getString(it) } else unit.toString()) }
            PtNullableInput(column.getString("label"), row.getJSONObject("cells").opt(column.getString("key")), 2000, enabled) { value -> update(JSONObject(row.toString()).apply { getJSONObject("cells").put(column.getString("key"), value) }) }
        }
        Text("Separate actual date · app selection metadata", style = MaterialTheme.typography.titleMedium)
        Text("This is not a replacement for raw A above. Enter only a date you actually established; it is never inferred from the source edition, farm year or raw date text.")
        OutlinedTextField((row.opt("actual_date") as? String).orEmpty(), { update(JSONObject(row.toString()).put("actual_date", if (it.isEmpty()) JSONObject.NULL else it).put("date_confirmed", false)) }, label = { Text("Actual date · YYYY-MM-DD · optional for a draft") }, keyboardOptions = ptKeyboard, enabled = enabled, modifier = Modifier.fillMaxWidth())
        Row { Checkbox(row.optBoolean("date_confirmed"), { change("date_confirmed", it) }, enabled = enabled && ptDate(row)?.let { !it.isAfter(LocalDate.now()) } == true); Text("I separately checked this actual date. It is not an automatic reading of raw A.", Modifier.weight(1f).padding(top = 12.dp)) }
        ptExclusion(row, ptDate(row)?.year)?.let { Text(it, style = MaterialTheme.typography.bodySmall) }
    }
}

@Composable private fun PtDocumentPicker(model: FarmModel, owner: JSONObject, farmId: String, close: () -> Unit, select: (JSONObject) -> Unit) {
    var offset by remember { mutableStateOf(0) }; var page by remember { mutableStateOf<JSONObject?>(null) }; var attempt by remember { mutableStateOf(0) }; var problem by remember { mutableStateOf("") }
    LaunchedEffect(offset, attempt) { page = null; problem = ""; try { val result = model.sourceRequest("/documents?farm_id=$farmId&limit=5&offset=$offset"); if (model.session !== owner) throw CancellationException(); require(result.getJSONArray("items").objects().all { it.data().text("farm_id") == farmId }); page = result } catch (error: CancellationException) { throw error } catch (error: Throwable) { problem = sourceFailure(error) } }
    Sheet("Choose an actual source document", close) {
        Text("Only documents explicitly assigned to this farm are offered. Selecting records its current revision, not a claim that the contents are true.")
        if (problem.isNotBlank()) Text(problem, color = MaterialTheme.colorScheme.error)
        OutlinedButton(onClick = { attempt++ }) { Text("Reload source documents") }
        page?.let { result -> val rows = result.getJSONArray("items").objects(); val total = result.getInt("total"); Text("${if (rows.isEmpty()) 0 else offset + 1}–${offset + rows.size} of $total farm documents"); if (rows.isEmpty()) Text("No assigned documents on this page. Manual capture may remain without documentary evidence."); rows.forEach { document -> OutlinedButton(onClick = { select(document) }) { Text("${document.title()} · revision ${document.getInt("revision")}") } }; Row { TextButton(onClick = { offset = maxOf(0, offset - 5) }, enabled = offset > 0) { Text("Previous source documents") }; TextButton(onClick = { offset += rows.size }, enabled = rows.isNotEmpty() && offset + rows.size < total) { Text("Next source documents") } } }
    }
}
