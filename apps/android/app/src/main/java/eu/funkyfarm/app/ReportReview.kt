package eu.funkyfarm.app

import androidx.compose.foundation.layout.*
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import kotlinx.coroutines.CancellationException
import org.json.JSONArray
import org.json.JSONObject
import java.io.File

private val reportSections = linkedMapOf("fields" to "Answers and source rows", "operations" to "Farm activities", "evidence" to "Evidence documents", "blockers" to "Needs attention", "changes" to "Changes since preparation", "receipts" to "Manual response references", "reissues" to "Correction reports")
private val approvalSections = listOf("fields", "operations", "evidence")

/** Migrate only old cached projections, without retaining eager snapshots or review capabilities. */
internal fun compactCachedReport(record: JSONObject): JSONObject {
    val data = record.data(); val snapshot = data.optJSONObject("snapshot") ?: JSONObject()
    val compact = JSONObject()
    listOf("farm_id", "request_id", "pack_id", "reporting_year", "status", "checksum", "correction_of", "approval", "filing_status", "created_by", "title").forEach { if (data.has(it)) compact.put(it, data.get(it)) }
    val counts = obj(*listOf("fields", "facts", "operations", "evidence").map { key -> key to (snapshot.optJSONObject("counts")?.optInt(key) ?: snapshot.optJSONArray(key)?.length() ?: 0) }.toTypedArray())
    val pack = snapshot.optJSONObject("pack") ?: JSONObject(); val farm = snapshot.optJSONObject("farm") ?: JSONObject()
    compact.put("transport_view", "summary").put("snapshot", obj("pack" to obj("id" to pack.opt("id"), "title" to pack.opt("title"), "version" to pack.opt("version")), "farm" to obj("id" to farm.opt("id"), "revision" to farm.opt("revision"), "name" to farm.opt("name"), "country" to farm.opt("country")), "reporting_year" to snapshot.opt("reporting_year"), "capability_notice" to snapshot.opt("capability_notice"), "counts" to counts))
    return JSONObject().apply { listOf("id", "kind", "workspace_id", "revision", "created_at", "updated_at").forEach { if (record.has(it)) put(it, record.get(it)) }; put("data", compact) }
}

private fun reviewBinding(record: JSONObject): String {
    val review = record.data().getJSONObject("review")
    return "${review.getInt("report_revision")}:${review.getString("snapshot_checksum")}:${review.getString("check_fingerprint")}"
}

private fun addVisited(ranges: List<IntRange>, offset: Int, count: Int): List<IntRange> {
    if (count == 0) return ranges
    val result = mutableListOf<IntRange>()
    (ranges + listOf(offset until offset + count)).sortedBy { it.first }.forEach { range ->
        val previous = result.lastOrNull()
        if (previous != null && range.first <= previous.last + 1) result[result.lastIndex] = previous.first..maxOf(previous.last, range.last) else result.add(range)
    }
    return result
}

@Composable internal fun ReportReview(model: FarmModel, record: JSONObject, share: (File, String) -> Unit) {
    val owner = model.session ?: return
    key(owner, model.origin, record.getString("id"), record.getInt("revision"), model.serverVersion) {
        val id = record.getString("id")
        var metadata by remember { mutableStateOf<JSONObject?>(null) }
        var loading by remember { mutableStateOf(true) }; var problem by remember { mutableStateOf("") }; var reload by remember { mutableStateOf(0) }
        DisposableEffect(id, owner) { onDispose { model.cancelReportExport() } }
        LaunchedEffect(reload) {
            metadata = null; loading = true; problem = ""
            try {
                val session = model.sourceRequest("/auth/session")
                require(session.getJSONObject("user").getString("id") == owner.getJSONObject("user").getString("id") && session.getJSONObject("workspace").getString("id") == owner.getJSONObject("workspace").getString("id")) { "The signed-in workspace changed. Open the report again." }
                val current = model.sourceRequest("/reports/$id?view=review")
                val review = current.data().getJSONObject("review")
                require(current.data().optString("transport_view") == "review" && review.getInt("report_revision") == current.getInt("revision")) { "The current report review is unavailable. Reload before continuing." }
                require(review.getString("snapshot_checksum") == current.data().getString("checksum")) { "The report snapshot identity changed. Reload before continuing." }
                require(listOf("snapshot_checksum", "check_fingerprint").all { review.getString(it).matches(Regex("[a-f0-9]{64}")) }) { "The report review identity is incomplete. Reload before continuing." }
                require(reportSections.keys.all { review.getJSONObject("sections").has(it) && review.getJSONObject("sections").getInt(it) >= 0 }) { "The report section counts are unavailable." }
                metadata = current
            } catch (error: CancellationException) { throw error }
            catch (error: Throwable) { problem = error.message ?: "The current review could not be loaded. No section has been treated as empty." }
            finally { loading = false }
        }
        Text("Review this report", style = MaterialTheme.typography.titleLarge)
        Text("Open every page of the selected answers, activities and evidence before acknowledging this exact version. Opening other records starts a new review when you return.")
        if (loading) Text("Checking your session and current report…")
        if (problem.isNotBlank()) Text(problem, color = MaterialTheme.colorScheme.error)
        OutlinedButton(onClick = { metadata = null; reload++ }, enabled = !loading && !model.exporting) { Text("Reload report review and current checks") }
        metadata?.let { current -> key(reviewBinding(current)) { ReportReviewPages(model, current, share) { metadata = null; reload++ } } }
        if (!loading && metadata == null) Text("Review is unavailable. Unloaded answers, activities and evidence have not been counted as empty; approval is disabled.")
    }
}

private data class ReviewPageError(val section: String, val offset: Int, val message: String)

@Composable private fun ReportReviewPages(model: FarmModel, record: JSONObject, share: (File, String) -> Unit, reload: () -> Unit) {
    val data = record.data(); val review = data.getJSONObject("review"); val counts = review.getJSONObject("sections")
    val id = record.getString("id"); val binding = reviewBinding(record)
    var portugueseCorrection by remember { mutableStateOf(false) }
    fun prepareCorrection() {
        if (data.text("pack_id") == CZECH_JOURNAL_PACK) model.czechJournal = obj("farm_id" to data.getString("farm_id"), "year" to data.getInt("reporting_year"), "request_id" to data.text("request_id"), "report_id" to id, "report_revision" to record.getInt("revision"))
        else if (data.text("pack_id") == "pt-ppp-surface-journal") portugueseCorrection = true
        else model.enqueue("/reports/$id/reissue", obj("expected_revision" to record.getInt("revision")))
    }
    if (portugueseCorrection) PortugueseJournal(model, initialFarmId = data.getString("farm_id"), reissueRecord = record) { portugueseCorrection = false }
    var section by remember { mutableStateOf("fields") }; var offset by remember { mutableStateOf(0) }; var attempt by remember { mutableStateOf(0) }
    var page by remember { mutableStateOf<JSONObject?>(null) }; var loading by remember { mutableStateOf(true) }
    var failed by remember { mutableStateOf<List<ReviewPageError>>(emptyList()) }; var invalid by remember { mutableStateOf(false) }
    var visited by remember { mutableStateOf<Map<String, List<IntRange>>>(emptyMap()) }
    var starts by remember { mutableStateOf<Map<String, Set<Int>>>(emptyMap()) }; var checked by remember { mutableStateOf(false) }
    fun navigate(target: String, start: Int) { checked = false; page = null; loading = true; section = target; offset = start; attempt++ }
    LaunchedEffect(binding, section, offset, attempt) {
        page = null; loading = true; checked = false
        if (invalid) { loading = false; return@LaunchedEffect }
        try {
            val response = model.sourceRequest("/reports/$id/review?section=$section&expected_revision=${review.getInt("report_revision")}&snapshot_checksum=${review.getString("snapshot_checksum")}&check_fingerprint=${review.getString("check_fingerprint")}&offset=$offset&limit=5")
            val items = response.getJSONArray("items")
            require((0 until items.length()).all { items.optJSONObject(it) != null }) { "A complete report item could not be read. Nothing on this page has been counted as reviewed." }
            if (section == "fields" && data.text("pack_id") == "pt-ppp-surface-journal") items.objects().filter { it.text("manual_journal_role") == "identity" }.forEach { item ->
                try { checkedPortugueseReportContext(item, data.getInt("reporting_year")) }
                catch (error: Exception) { throw IllegalArgumentException("The retained journal source, selected order or exclusions could not be read completely. Reload the report review; this page has not been counted as reviewed.", error) }
            }
            require(response.getString("section") == section && response.getInt("report_revision") == review.getInt("report_revision") && response.getString("snapshot_checksum") == review.getString("snapshot_checksum") && response.getString("check_fingerprint") == review.getString("check_fingerprint")) { "This page belongs to a different report review. Reload the report." }
            require(response.getInt("total") == counts.getInt(section) && response.getInt("offset") == offset && items.length() <= 5 && offset + items.length() <= response.getInt("total")) { "The page range changed. Reload the report review." }
            val expectedNext = offset + items.length()
            require(if (expectedNext < response.getInt("total")) items.length() > 0 && response.opt("next_offset") is Number && response.getInt("next_offset") == expectedNext else response.isNull("next_offset")) { "The next complete page could not be identified. Reload the report." }
            page = response
            visited = visited + (section to addVisited(visited[section].orEmpty(), offset, items.length()))
            starts = starts + (section to (starts[section].orEmpty() + offset))
            failed = failed.filterNot { it.section == section && it.offset == offset }
        } catch (error: CancellationException) { throw error }
        catch (error: Throwable) {
            val message = error.message ?: "This page could not be loaded. It has not been counted as empty."
            failed = failed.filterNot { it.section == section && it.offset == offset } + ReviewPageError(section, offset, message)
            if (error is ApiFailure && error.status in listOf(401, 403, 404, 409) || error is IllegalArgumentException) { invalid = true; visited = emptyMap() }
        } finally { loading = false }
    }
    val issued = data.optString("status") == "issued"
    Text(if (issued) "Approved snapshot · revision ${record.getInt("revision")}" else "Report preview · revision ${record.getInt("revision")}", style = MaterialTheme.typography.titleMedium)
    data.optJSONObject("snapshot")?.let { snapshot ->
        (snapshot.opt("capability_notice") as? String)?.let { Text(it) }
        snapshot.optJSONObject("farm")?.let { Text("Farm: ${it.optString("name")} · ${it.optString("country")}") }
        snapshot.optJSONObject("pack")?.let { Text("${it.optString("title")} · source version ${it.optString("version")}", style = MaterialTheme.typography.bodySmall) }
    }
    data.optJSONObject("amendment")?.optString("message")?.takeIf(String::isNotBlank)?.let { Text(it) }
    (data.opt("approval_blocked_reason") as? String)?.takeIf(String::isNotBlank)?.let { Text(it) }
    Choice("Which part would you like to check?", section, reportSections.map { (key, title) -> key to "$title (${counts.getInt(key)})" }) { if (!loading && !model.exporting) navigate(it, 0) }
    if (invalid) {
        Text("The report or its current checks changed, or access could not be verified. Previously opened ranges no longer count. Reload the complete review before continuing.", color = MaterialTheme.colorScheme.error)
        OutlinedButton(onClick = reload) { Text("Start a fresh report review") }
    }
    failed.forEach { error ->
        Text("${reportSections[error.section]} · page starting at ${error.offset + 1}: ${error.message}", color = MaterialTheme.colorScheme.error)
        if (!invalid) OutlinedButton(onClick = { navigate(error.section, error.offset) }, enabled = !loading) { Text("Retry ${reportSections[error.section]?.lowercase()} page") }
    }
    if (loading) Text("Loading a complete page of ${reportSections[section]?.lowercase()}…")
    if (!loading && page == null) Text("This section is not loaded. It has not been treated as empty.")
    page?.let { loaded ->
        val items = loaded.getJSONArray("items").objects(); val total = loaded.getInt("total")
        Text(if (total == 0) "No items in this verified section (0 of 0)." else "Showing ${offset + 1}–${offset + items.size} of $total · ${reportSections[section]}", style = MaterialTheme.typography.titleMedium)
        items.forEachIndexed { index, item -> ReportReviewItem(model, section, item, offset + index + 1) }
        val previous = starts[section].orEmpty().filter { it < offset }.maxOrNull() ?: 0
        val next = loaded.opt("next_offset") as? Number
        Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            OutlinedButton(onClick = { navigate(section, previous) }, enabled = !loading && !invalid && offset > 0) { Text("Previous page") }
            OutlinedButton(onClick = { if (next != null) navigate(section, next.toInt()) }, enabled = !loading && !invalid && next != null) { Text("Next page") }
        }
        TextButton(onClick = { navigate(section, offset) }, enabled = !loading && !invalid) { Text("Reload this page") }
    }
    approvalSections.forEach { key ->
        val opened = visited[key].orEmpty().sumOf { it.last - it.first + 1 }
        Text("${reportSections[key]}: $opened of ${counts.getInt(key)} opened" + if (counts.getInt(key) == 0) " · none selected in this verified report" else "", style = MaterialTheme.typography.bodySmall)
    }
    val allOpened = approvalSections.all { key -> visited[key].orEmpty().sumOf { it.last - it.first + 1 } == counts.getInt(key) }
    val approvalPending = model.queue().any { it.optString("path").substringBefore('?') == "/reports/$id/approve" }
    val canAcknowledge = !issued && data.optBoolean("can_approve") && counts.getInt("blockers") == 0 && allOpened && page != null && !loading && !invalid && failed.isEmpty() && !model.busy && !approvalPending
    if (!issued) {
        Row { Checkbox(checked, { checked = it }, enabled = canAcknowledge); Text("I reviewed this exact report and its evidence.", Modifier.weight(1f).padding(top = 12.dp)) }
        if (!allOpened) Text("Open the remaining answer, activity and evidence pages before acknowledging this version.")
        if (approvalPending) Text("This report already has a pending approval. Use Pending changes in Account to retry the same saved decision or resolve its conflict; do not submit a second approval.")
        Button(onClick = {
            model.enqueue("/reports/$id/approve", obj("expected_revision" to review.getInt("report_revision"), "snapshot_checksum" to review.getString("snapshot_checksum"), "check_fingerprint" to review.getString("check_fingerprint")))
            checked = false
        }, enabled = checked && canAcknowledge) { Text("Approve this report") }
        Text("The service checks current sources, permissions and this exact review again before approval.", style = MaterialTheme.typography.bodySmall)
        if (counts.getInt("blockers") > 0) OutlinedButton(onClick = { prepareCorrection() }, enabled = !model.busy && !invalid) { Text("Prepare a fresh preview with current evidence") }
    } else {
        data.optJSONObject("approval")?.let { approval -> approval.keys().asSequence().forEach { LiteralField("Approval · ${it.replace('_', ' ')}", approval.get(it)) } }
        Text("Save or share approved export", style = MaterialTheme.typography.titleLarge)
        val formats = data.optJSONArray("supported_formats").strings().filter { it in listOf("pdf", "csv", "json", "xlsx") }
        if (formats.isEmpty()) Text("Export formats are not available from this current review. Reload to check again.")
        formats.forEach { format ->
            Button(onClick = { model.export(record, format) { file -> share(file, reportMime(format)) } }, enabled = !model.busy && !invalid && !model.exporting) { Text("Export ${format.uppercase()}") }
        }
        if (model.exporting) { Text("Saving the complete export to private storage…"); OutlinedButton(onClick = { model.cancelReportExport(true) }) { Text("Cancel export and remove incomplete file") } }
        Text("Files stream to private storage, up to 512 MiB with 32 MiB kept free. Only a complete file reaches the Android save/share chooser. Signing out removes device exports.", style = MaterialTheme.typography.bodySmall)
        var receipt by remember { mutableStateOf(false) }
        OutlinedButton(onClick = { receipt = true }, enabled = !invalid && !model.busy) { Text("Record a manual response reference") }
        if (receipt) ReceiptEditor(model, record) { receipt = false }
        OutlinedButton(onClick = { prepareCorrection() }, enabled = !model.busy && !invalid) { Text("Prepare a separate correction draft") }
        Text("The issued report stays immutable. A correction needs its own review and approval; a manual reference does not establish acceptance.")
    }
}

private fun reportMime(format: String) = when (format) { "pdf" -> "application/pdf"; "csv" -> "text/csv"; "xlsx" -> "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"; else -> "application/json" }

@Composable private fun ReportReviewItem(model: FarmModel, section: String, item: JSONObject, position: Int) {
    Card(Modifier.fillMaxWidth()) { Column(Modifier.padding(14.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
        when (section) {
            "fields" -> {
                Text("Answer $position · ${item.optString("label", item.optString("field"))}", fontWeight = FontWeight.Bold)
                (item.opt("group_label") as? String)?.let { Text(it, style = MaterialTheme.typography.bodySmall) }
                item.optJSONObject("journal_context")?.takeIf { it.text("schema_id") == "pt-ppp-surface-v1" }?.let { RetainedPortugueseReportContext(it, position) }
                val sourceRow = !item.optBoolean("missing") && item.optJSONObject("row_schema") != null && item.optJSONObject("value") != null
                if (item.optBoolean("missing")) Text("Missing answer · this still needs attention.", color = MaterialTheme.colorScheme.error)
                if (sourceRow) SourceRowSummary(item.getJSONObject("value"), item.getJSONObject("row_schema")) else Text("Value preview: ${reportValuePreview(item.opt("value"))}")
                var expanded by remember(position, item.optString("fact_id"), item.optInt("fact_revision")) { mutableStateOf(false) }
                val description = if (sourceRow) "retained cells" else "complete value"
                TextButton(onClick = { expanded = !expanded }) { Text("${if (expanded) "Hide" else "Show"} $description · answer $position") }
                if (expanded) {
                    if (sourceRow) {
                        SourceRowValues(item.getJSONObject("value"), item.getJSONObject("row_schema"))
                        Text("Column meanings and original units are retained in this report's snapshot.", style = MaterialTheme.typography.bodySmall)
                    } else if (item.text("fact_key") == CZECH_HOLDER_KEY && item.optJSONObject("value") != null) CzechHolderValue(item.getJSONObject("value"))
                    else LiteralField(if (item.optBoolean("missing")) "Missing answer" else "Complete snapshot value", item.opt("value"))
                    listOf("unit", "period", "temporal_basis").forEach { if (item.has(it)) LiteralField(it.replace('_', ' '), item.get(it)) }
                    ReportSourceLinks(model, item.optJSONArray("sources"))
                    (item.opt("fact_id") as? String)?.let { identity -> OutlinedButton(onClick = { model.open("facts", identity) }) { Text("Check source fact · revision ${item.optInt("fact_revision")}") } }
                }
            }
            "operations" -> {
                Text("Activity $position · ${item.data().optString("title", "Farm activity")}", fontWeight = FontWeight.Bold)
                Text("Retained activity revision ${item.optInt("revision")}")
                item.data().keys().asSequence().filter { it != "sources" && (it != "cz_ppp" || item.optJSONObject("journal_entry") == null) }.forEach { LiteralField(it.replace('_', ' '), item.data().get(it)) }
                item.optJSONObject("journal_entry")?.let { journal ->
                    var expanded by remember(position, item.getString("id"), item.optInt("revision")) { mutableStateOf(false) }
                    Text("Retained Czech journal details are included for this exact application and revision.")
                    TextButton(onClick = { expanded = !expanded }) { Text("${if (expanded) "Hide" else "Show"} retained journal entry · activity $position") }
                    if (expanded) RetainedCzechJournal(journal)
                }
                if (item.data().has("sources")) ReportSourceLinks(model, item.data().optJSONArray("sources"))
                OutlinedButton(onClick = { model.open("operations", item.getString("id")) }) { Text("Open current activity for comparison") }
            }
            "evidence" -> {
                Text("Evidence $position · ${item.optString("name", "Document")}", fontWeight = FontWeight.Bold)
                LiteralField("Retained document revision", item.opt("revision"))
                if (item.has("data_checksum")) LiteralField("Retained source identity", item.get("data_checksum"))
                OutlinedButton(onClick = { model.open("documents", item.getString("id")) }) { Text("Open evidence document") }
            }
            "receipts" -> {
                Text("Manual reference $position · acceptance not verified", fontWeight = FontWeight.Bold)
                item.data().keys().asSequence().forEach { LiteralField(it.replace('_', ' '), item.data().get(it)) }
            }
            "reissues" -> {
                Text("Correction report $position · ${item.optString("status")}", fontWeight = FontWeight.Bold)
                OutlinedButton(onClick = { model.open("reports", item.getString("id")) }) { Text("Open this correction report") }
            }
            else -> {
                Text(item.optString("label", item.optString("code", "Review item $position")), fontWeight = FontWeight.Bold)
                Text(item.optString("message"))
                var expanded by remember(section, position) { mutableStateOf(false) }
                if (section == "changes") {
                    TextButton(onClick = { expanded = !expanded }) { Text("${if (expanded) "Hide" else "Show"} complete change · item $position") }
                }
                if (section != "changes" || expanded) {
                    listOf("previous", "current").forEach { key -> item.optJSONObject(key)?.let { values ->
                        Text(if (key == "previous") "Retained previous values" else "Current values", style = MaterialTheme.typography.titleSmall)
                        values.keys().asSequence().forEach { field -> if (field == "value" && values.optJSONObject(field) != null) SourceRowValues(values.getJSONObject(field), null) else LiteralField(field.replace('_', ' '), values.get(field)) }
                    } }
                    listOf("previous_text", "current_text").forEach { if (item.has(it)) LiteralField(it.replace('_', ' '), item.get(it)) }
                    item.keys().asSequence().filter { it !in listOf("label", "message", "previous", "current", "previous_text", "current_text") }.forEach { LiteralField(it.replace('_', ' '), item.get(it)) }
                    (item.opt("fact_id") as? String)?.let { id -> OutlinedButton(onClick = { model.open("facts", id) }) { Text("Open the affected fact") } }
                    (item.opt("operation_id") as? String)?.let { id -> OutlinedButton(onClick = { model.open("operations", id) }) { Text("Open the affected activity") } }
                }
            }
        }
    } }
}

private fun reportValuePreview(value: Any?): String = when (value) {
    is JSONObject -> "Structured value · ${value.length()} entries. Open the complete value below."
    is JSONArray -> "List value · ${value.length()} entries. Open the complete value below."
    else -> sourceText(value).let { if (it.length > 160) it.take(160) + "… · preview only; open the complete value below" else it }
}

@Composable private fun ReportSourceLinks(model: FarmModel, sources: JSONArray?) {
    Sources(sources)
    sources?.objects()?.forEach { source ->
        (source.opt("document_id") as? String)?.let { id -> TextButton(onClick = { model.open("documents", id) }) { Text("Open original source document") } }
        (source.opt("import_id") as? String)?.let { id -> TextButton(onClick = { model.sourceImports = obj("import_id" to id) }) { Text("Open original source rows") } }
        val kind = source.optString("record_kind"); val id = source.opt("record_id") as? String
        if (id != null && kind in listOf("facts", "operations", "purchases", "sales")) TextButton(onClick = { model.open(kind, id) }) { Text("Open source record for comparison") }
    }
}
