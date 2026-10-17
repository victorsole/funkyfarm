@file:OptIn(androidx.compose.material3.ExperimentalMaterial3Api::class)
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
import org.json.JSONTokener
import java.math.BigDecimal
import java.time.LocalDate
import java.io.File

@Composable internal fun RecordDetail(model: FarmModel, kind: String, record: JSONObject, edit: () -> Unit, share: (ByteArray, String, String) -> Unit, shareExport: (File, String) -> Unit) {
    val data = record.data()
    Text(record.title(), style = MaterialTheme.typography.headlineMedium, fontWeight = FontWeight.Bold)
    Text("Revision ${record.optInt("revision")} · ${data.optString("status").ifBlank { data.optString("review_status") }}", style = MaterialTheme.typography.labelLarge)
    TextButton(onClick = { model.open(kind, record.getString("id")) }, enabled = !model.busy) { Text("Refresh this record") }
    var editingSale by remember(record.optString("id")) { mutableStateOf(false) }
    if (editingSale) GuidedCapture(model, if (kind == "sales") "sale" else data.optString("type"), record = record) { editingSale = false }
    if (kind == "reports") ReportReview(model, record, shareExport)
    else {
        if (!(kind in listOf("facts", "operations", "purchases", "sales") && data.optString("review_status") == "confirmed") && kind !in listOf("documents", "checklists")) OutlinedButton(onClick = { if (kind == "sales" || (kind == "operations" && data.optString("type") == "pesticide_application")) editingSale = true else edit() }) { Text("Edit saved information") }
        if (kind == "farms") {
            Text("Farm information", style = MaterialTheme.typography.titleLarge)
            listOf("name", "country", "region", "area_ha", "external_id", "notes").forEach { key -> if (data.has(key)) LiteralField(key.replace('_', ' '), data.opt(key)) }
            Text("Facts and evidence", style = MaterialTheme.typography.titleLarge)
            val workspaceFacts = model.records["facts"].orEmpty()
            val factTotal = model.totals["facts"]
            val facts = workspaceFacts.filter { it.data().optString("farm_id") == record.optString("id") }
            if (facts.isEmpty()) Text("No facts for this farm are in the loaded records.")
            facts.forEach { fact -> OutlinedButton(onClick = { model.open("facts", fact.getString("id")) }, modifier = Modifier.fillMaxWidth()) { Column { Text(fact.title()); Text("${literal(fact.data().opt("value"))} ${fact.data().optString("unit").takeUnless { it == "null" }.orEmpty()} · ${fact.data().optString("review_status")}", style = MaterialTheme.typography.bodySmall) } } }
            Text(if (factTotal != null) "${workspaceFacts.size} of $factTotal workspace facts loaded. Only this farm's loaded facts are shown here." else "${workspaceFacts.size} workspace facts loaded; refresh the workspace to check the current total. Only this farm's facts are shown here.", style = MaterialTheme.typography.bodySmall)
            if (factTotal != null && workspaceFacts.size < factTotal) OutlinedButton(onClick = { model.loadMore("facts") }, enabled = !model.busy && !model.offline) { Text("Load more workspace facts for this farm list") }
            var reconcile by remember { mutableStateOf(false) }
            OutlinedButton(onClick = { model.loadExtra("reconciliation:${record.getString("id")}", "/reconciliation?farm_id=${record.getString("id")}"); reconcile = true }) { Text("Compare competing evidence") }
            if (reconcile) Reconciliation(model, record.getString("id")) { reconcile = false }
        } else if (kind == "facts") {
            Text("Check this fact against its source", style = MaterialTheme.typography.titleLarge)
            if (data.optJSONObject("value") != null && sourceProfileId(record) != null) SourceFactValue(model, record) else LiteralField("Value", data.opt("value"))
            listOf("unit", "period", "temporal_basis").forEach { if (data.has(it)) LiteralField(it.replace('_', ' '), data.opt(it)) }
            Sources(data.optJSONArray("sources"))
            if (data.optString("review_status") == "proposed") {
                var checked by remember(record.optString("id"), record.optInt("revision")) { mutableStateOf(false) }
                Row { Checkbox(checked, { checked = it }); Text("I checked this exact value, unit, period and evidence.", Modifier.padding(top = 12.dp)) }
                val reviewKey = "review:${record.getString("id")}:${record.getInt("revision")}"
                var reviewNote by remember(reviewKey) { mutableStateOf(model.draft(reviewKey, obj("note" to "")).optString("note")) }
                OutlinedTextField(reviewNote, { reviewNote = it; model.saveDraft(reviewKey, obj("note" to it)) }, label = { Text(if (data.has("supersedes_id")) "Explain this correction (required)" else "Review note (optional)") }, modifier = Modifier.fillMaxWidth())
                Button(onClick = { model.enqueue("/facts/${record.getString("id")}/review", obj("expected_revision" to record.getInt("revision"), "decision" to "confirmed", "note" to reviewNote), draftKey = reviewKey) }, enabled = checked && !model.busy && (!data.has("supersedes_id") || reviewNote.isNotBlank())) { Text("Confirm this fact") }
                OutlinedButton(onClick = { model.enqueue("/facts/${record.getString("id")}/review", obj("expected_revision" to record.getInt("revision"), "decision" to "rejected", "note" to reviewNote), draftKey = reviewKey) }, enabled = !model.busy) { Text("Reject proposal") }
            } else {
                Text("The recorded review is retained with its history. Issued reports keep their original snapshot.")
                if (data.optString("review_status") == "confirmed") {
                    var correction by remember { mutableStateOf(false) }
                    OutlinedButton(onClick = { correction = true }) { Text("Propose a correction") }
                    if (correction) Editor(model, "facts", record, { correction = false }, correction = true)
                }
            }
            val dependentKey = "dependent:${record.getString("id")}"
            OutlinedButton(onClick = { model.loadExtra(dependentKey, "/facts/${record.getString("id")}/reports") }) { Text("Find reports using this fact") }
            model.extras[dependentKey]?.optJSONArray("items")?.objects()?.forEach { report -> OutlinedButton(onClick = { model.open("reports", report.getString("id")) }) { Text("${report.title()} · ${report.data().optString("status")}") } }
        } else if (kind == "documents") DocumentDetails(model, record, share)
        else if (kind == "checklists") ChecklistDetails(model, record)
        else {
            if (kind == "sales") Text("Sale record · supplied figures, no tax calculation", style = MaterialTheme.typography.titleMedium)
            data.keys().asSequence().filter { it !in listOf("sources", "farm_id", "pack_id") }.forEach { key -> LiteralField(if (kind == "sales" && key == "amount") "Amount received · printed total" else key.replace('_', ' '), data.opt(key)) }
            Sources(data.optJSONArray("sources"))
            if (kind in listOf("operations", "purchases", "sales") && data.optString("review_status") == "proposed") {
                var checked by remember(record.optString("id"), record.optInt("revision")) { mutableStateOf(false) }
                Row { Checkbox(checked, { checked = it }); Text("I checked the actual record, amounts, units, dates and evidence.", Modifier.weight(1f).padding(top = 12.dp)) }
                Button(onClick = { model.enqueue("/$kind/${record.getString("id")}/review", obj("expected_revision" to record.getInt("revision"), "decision" to "confirmed", "note" to "Reviewed in the Android client")) }, enabled = checked && !model.busy) { Text("Confirm this record") }
                OutlinedButton(onClick = { model.enqueue("/$kind/${record.getString("id")}/review", obj("expected_revision" to record.getInt("revision"), "decision" to "rejected", "note" to "Rejected in the Android client")) }, enabled = !model.busy) { Text("Reject proposal") }
            }
            if (kind == "requests") {
                Text("Prepare a reviewed response", style = MaterialTheme.typography.titleLarge)
                Text("A report reuses confirmed facts. Missing prerequisites and source conflicts remain visible in the preview.")
                Button(onClick = { model.enqueue("/reports", obj("farm_id" to data.optString("farm_id"), "request_id" to record.getString("id"), "pack_id" to data.optString("pack_id"), "reporting_year" to data.optInt("reporting_year"))) }, enabled = data.optString("farm_id").isNotBlank() && data.optString("pack_id").isNotBlank() && !model.busy) { Text("Prepare report from this request") }
                model.records["reports"].orEmpty().filter { it.data().optString("request_id") == record.optString("id") }.forEach { report -> OutlinedButton(onClick = { model.open("reports", report.getString("id")) }) { Text("Open report · ${report.data().optString("status")}") } }
                if (data.optString("status") == "responded") Text("A recorded response is a manual tracking state; it does not establish authority acceptance.")
            }
        }
    }
    var details by remember(record.optString("id")) { mutableStateOf(false) }
    TextButton(onClick = { details = !details }) { Text(if (details) "Hide record details" else "Record details") }
    if (details) SelectionContainer { Text(record.toString(2), style = MaterialTheme.typography.bodySmall) }
    if (kind in listOf("farms", "facts", "requests", "operations", "purchases", "sales", "tasks", "checklists")) {
        val historyKey = "history:$kind:${record.getString("id")}"
        TextButton(onClick = { model.loadExtra(historyKey, "/$kind/${record.getString("id")}/history") }) { Text("Load retained revision history") }
        model.extras[historyKey]?.let { history -> SelectionContainer { Text(history.toString(2), style = MaterialTheme.typography.bodySmall) } }
    }
}

@Composable private fun Reconciliation(model: FarmModel, farmId: String, close: () -> Unit) {
    val response = model.extras["reconciliation:$farmId"]
    Sheet("Compare competing evidence", close) {
        Text("Select the supported value after checking its sources. No value wins automatically. A new source revision requires a fresh decision.")
        if (response == null) Text("Loading the current server comparison. An offline copy cannot authorize a new resolution.")
        val conflicts = response?.optJSONArray("items")?.objects().orEmpty()
        if (response != null && conflicts.isEmpty()) Text("No competing confirmed values found for this farm.")
        conflicts.forEach { conflict ->
            val data = conflict.data(); var chosen by remember(conflict.optString("id"), conflict.optLong("revision")) { mutableStateOf("") }
            val draftKey = "reconciliation:${conflict.optString("id")}:${conflict.optLong("revision")}"
            var note by remember(draftKey) { mutableStateOf(model.draft(draftKey, obj("note" to "")).optString("note")) }
            Text("${data.optString("key")} · ${data.opt("period") ?: "static"}", style = MaterialTheme.typography.titleLarge)
            Text("Current state: ${data.optString("status")}")
            data.optJSONArray("candidates")?.objects()?.forEach { candidate -> Card(Modifier.fillMaxWidth()) { Column(Modifier.padding(12.dp)) {
                Row { RadioButton(chosen == candidate.optString("id"), { chosen = candidate.optString("id") }); Text("Use ${literal(candidate.data().opt("value"))} ${candidate.data().optString("unit")}", Modifier.weight(1f).padding(top = 12.dp)) }
                LiteralField("Period", candidate.data().opt("period")); Sources(candidate.data().optJSONArray("sources"))
            } } }
            OutlinedTextField(note, { note = it; model.saveDraft(draftKey, obj("note" to it)) }, label = { Text("Why does this value apply?") }, modifier = Modifier.fillMaxWidth())
            Button(onClick = { model.enqueue("/reconciliation/${conflict.getString("id")}/resolve", obj("farm_id" to farmId, "expected_revision" to conflict.getLong("revision"), "chosen_fact_id" to chosen, "note" to note), draftKey = draftKey); close() }, enabled = chosen.isNotBlank() && note.isNotBlank() && !model.busy) { Text("Record this explicit resolution") }
        }
    }
}

private fun literal(value: Any?): String = when (value) { null -> "Not supplied"; JSONObject.NULL -> "null (unknown)"; is JSONObject -> value.toString(2); is JSONArray -> value.toString(2); else -> value.toString() }
private fun jsonLiteral(value: Any?): String {
    // Android's public JSONArray serializer retains JSON types, quoting and nulls.
    val encoded = JSONArray().put(value ?: JSONObject.NULL).toString()
    return encoded.substring(1, encoded.length - 1)
}
@Composable internal fun LiteralField(label: String, value: Any?) { Column(verticalArrangement = Arrangement.spacedBy(3.dp)) { Text(label.replaceFirstChar { it.uppercase() }, style = MaterialTheme.typography.labelLarge); SelectionContainer { Text(literal(value), style = MaterialTheme.typography.bodyLarge) } } }
@Composable internal fun Sources(sources: JSONArray?) {
    if (sources == null || sources.length() == 0) { Text("No source locations supplied. Check the original evidence before confirming."); return }
    Text("Source evidence", style = MaterialTheme.typography.titleLarge)
    sources.objects().forEach { source -> Card(Modifier.fillMaxWidth()) { Column(Modifier.padding(14.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) {
        source.keys().asSequence().filter { it != "quote" }.forEach { key -> LiteralField(key.replace('_', ' '), source.opt(key)) }
        if (source.has("quote")) { Text("Exact supplied passage", style = MaterialTheme.typography.labelLarge); SelectionContainer { Text(literal(source.opt("quote"))) } }
    } } }
}

@Composable private fun DocumentDetails(model: FarmModel, record: JSONObject, share: (ByteArray, String, String) -> Unit) {
    val data = record.data(); val extraction = data.optJSONObject("extraction")
    Text("Original evidence", style = MaterialTheme.typography.titleLarge)
    Text("${data.optString("media_type")} · ${data.optLong("size_bytes") / 1024} KiB")
    OutlinedButton(onClick = { model.original(record) { bytes -> share(bytes, data.optString("filename", "original"), data.optString("media_type", "application/octet-stream")) } }, enabled = !model.busy) { Text("Open or save original") }
    var transcript by remember(record.optString("id")) { mutableStateOf(model.draft("transcript:${record.optString("id")}", obj("text" to "")).optString("text")) }
    OutlinedTextField(transcript, { transcript = it; model.saveDraft("transcript:${record.optString("id")}", obj("text" to it)) }, label = { Text("Manual transcription (optional)") }, modifier = Modifier.fillMaxWidth().heightIn(min = 120.dp))
    Text("Extraction creates proposals. It cannot confirm facts or send a request.", style = MaterialTheme.typography.bodySmall)
    Button(onClick = { val body = obj("expected_revision" to record.getInt("revision")); if (transcript.isNotBlank()) body.put("text", transcript); model.enqueue("/documents/${record.getString("id")}/extract", body) }, enabled = !model.busy) { Text("Suggest information for review") }
    if (extraction != null) {
        LiteralField("Extraction status", extraction.opt("status"))
        extraction.optJSONArray("warnings")?.let { LiteralField("Limits and warnings", it) }
        extraction.optJSONArray("fields")?.objects()?.forEach { field -> Card(Modifier.fillMaxWidth()) { Column(Modifier.padding(14.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) { Text(field.optString("label", field.optString("key")), fontWeight = FontWeight.Bold); LiteralField("Proposed value", field.opt("value")); Text("Proposed · needs human review"); Sources(field.optJSONArray("sources")) } } }
        extraction.optJSONArray("uncertain_fields")?.let { LiteralField("Uncertain or unreadable", it) }
    }
    var letter by remember { mutableStateOf(false) }
    Text("For a purchase or sale, choose the transaction yourself and check the actual date, parties and printed amounts. Suggestions do not establish money received or goods used.", style = MaterialTheme.typography.bodySmall)
    WebLink(model, "/app/documents/${record.getString("id")}", "Review purchase or sale entries on the website")
    OutlinedButton(onClick = { letter = true }) { Text("Review letter as a new request") }
    if (letter) Editor(model, "requests", null, { letter = false }, document = record)
}

@Composable internal fun ReceiptEditor(model: FarmModel, record: JSONObject, close: () -> Unit) {
    val key = "receipt:${record.getString("id")}"; val initial = model.draft(key, obj("reference" to "", "date" to LocalDate.now().toString()))
    var reference by remember { mutableStateOf(initial.optString("reference")) }; var date by remember { mutableStateOf(initial.optString("date")) }
    Sheet("Manual response reference", close) {
        Text("This records what you supplied. It does not verify delivery or authority acceptance.")
        OutlinedTextField(reference, { reference = it; model.saveDraft(key, obj("reference" to reference, "date" to date)) }, label = { Text("Reference") }, modifier = Modifier.fillMaxWidth())
        OutlinedTextField(date, { date = it; model.saveDraft(key, obj("reference" to reference, "date" to date)) }, label = { Text("Date · YYYY-MM-DD") }, modifier = Modifier.fillMaxWidth())
        Button(onClick = { model.enqueue("/reports/${record.getString("id")}/receipts", obj("expected_revision" to record.getInt("revision"), "reference" to reference, "date" to date), draftKey = key); close() }, enabled = reference.isNotBlank() && runCatching { LocalDate.parse(date) }.isSuccess) { Text("Save manual reference") }
    }
}

private data class InputField(val key: String, val label: String, val required: Boolean = false, val multiline: Boolean = false)
@Composable internal fun Editor(model: FarmModel, kind: String, record: JSONObject?, close: () -> Unit, document: JSONObject? = null, correction: Boolean = false) {
    val data = record?.data() ?: JSONObject()
    val key = "$kind:${if (correction) "correction:" else ""}${record?.optString("id") ?: document?.optString("id") ?: "new"}"
    val year = LocalDate.now().year
    val defaults = JSONObject(data.toString()).apply {
        if (kind in listOf("farms", "requests", "reports") && !has("reporting_year")) put("reporting_year", year)
        if (kind in listOf("farms", "requests") && !has("country")) put("country", "")
        if (kind == "facts" && !has("temporal_basis")) put("temporal_basis", "static")
        if (kind in listOf("requests", "reports", "facts", "operations", "purchases", "sales", "tasks", "checklists") && !has("farm_id") && model.records["farms"].orEmpty().size == 1) put("farm_id", model.records.getValue("farms").single().getString("id"))
        if (kind == "requests" && !has("status")) put("status", "draft")
        if (kind == "tasks" && !has("status")) put("status", "open")
        if (kind in listOf("purchases", "sales") && !has("currency")) put("currency", "EUR")
        if (correction) { put("supersedes_id", record!!.getString("id")); put("review_status", "proposed") }
    }
    var draft by remember(key) { mutableStateOf(model.draft(key, obj("data" to defaults, "expected_revision" to record?.optInt("revision")))) }
    var error by remember { mutableStateOf("") }
    fun update(field: String, value: String) { val copy = JSONObject(draft.toString()); copy.getJSONObject("data").put(field, value); draft = copy; model.saveDraft(key, copy) }
    val current = draft.getJSONObject("data")
    val fields = when (kind) {
        "farms" -> listOf(InputField("name", "Farm name", true), InputField("country", "Home country · EU code", true), InputField("region", "Home region"), InputField("area_ha", "Farm area · hectares"), InputField("external_id", "Existing farm identifier"), InputField("notes", "Farm context", multiline = true))
        "requests" -> listOf(InputField("title", "What is being requested?", true), InputField("recipient", "Office or recipient", true), InputField("country", "Country · EU code", true), InputField("region", "Region"), InputField("reporting_year", "Reporting year", true), InputField("deadline", "Checked deadline · YYYY-MM-DD"), InputField("requirements_text", "Information requested · one question per line", multiline = true), InputField("status", "Status · draft / review / waiting", true))
        "reports" -> listOf(InputField("reporting_year", "Reporting year", true))
        "facts" -> listOf(InputField("key", "Fact key · e.g. area_ha", true), InputField("label", "Plain-language question or label", true), InputField("value_literal", "Value as JSON · e.g. 12.5, true, null or \"wheat\"", true, true), InputField("unit", "Supplied unit"), InputField("period", "Observed period or date"), InputField("temporal_basis", "Time basis · static / campaign_year / calendar_date", true), InputField("source_note", "Manual source note", multiline = true), InputField("source_document_id", "Source document ID (optional)"), InputField("source_quote", "Exact source passage (optional)", multiline = true))
        "purchases" -> listOf(InputField("title", "Purchase or receipt", true), InputField("date", "Purchase date · YYYY-MM-DD", true), InputField("category", "Category"), InputField("quantity", "Quantity"), InputField("unit", "Supplied unit"), InputField("amount", "Amount"), InputField("currency", "Currency · e.g. EUR"), InputField("document_id", "Evidence document ID"), InputField("notes", "Notes", multiline = true))
        "sales" -> listOf(InputField("title", "What did you sell?", true), InputField("date", "Actual sale date · YYYY-MM-DD", true), InputField("category", "Sale category"), InputField("buyer", "Buyer · if supplied"), InputField("invoice_number", "Invoice or receipt reference"), InputField("quantity", "Supplied quantity"), InputField("unit", "Supplied unit"), InputField("amount", "Amount received · printed total", true), InputField("currency", "Currency · e.g. EUR", true), InputField("tax_amount", "Tax amount exactly as printed · optional"), InputField("tax_rate", "Tax rate exactly as printed · optional"), InputField("document_id", "Supporting document"), InputField("notes", "Notes", multiline = true))
        "operations" -> listOf(InputField("title", "Work or observation", true), InputField("date", "Actual date · YYYY-MM-DD", true), InputField("type", "Activity type", true), InputField("quantity", "Quantity"), InputField("unit", "Supplied unit"), InputField("hours", "Time spent · hours"), InputField("document_id", "Evidence document ID"), InputField("notes", "Notes", multiline = true))
        "tasks" -> listOf(InputField("title", "Task", true), InputField("due_date", "Deadline · YYYY-MM-DD"), InputField("status", "Status · open / in_progress / done / cancelled", true), InputField("notes", "Notes", multiline = true))
        else -> listOf(InputField("title", "Checklist name", true), InputField("scheme", "Standard or scheme"), InputField("version", "Selected version"), InputField("deadline", "Deadline · YYYY-MM-DD"), InputField("notes", "Required actions and evidence", multiline = true))
    }
    Sheet(if (correction) "Propose a correction" else if (record == null) "Add ${kind.removeSuffix("s")}" else "Edit ${record.title()}", close) {
        if (record != null && !correction) Text("Your draft keeps revision ${draft.opt("expected_revision")}. A later refresh will not silently replace its baseline.")
        if (correction) Text("This creates a separately reviewed proposal. The original confirmed fact and issued report snapshots are retained. Explain the correction when reviewing it.")
        if (document != null) Text("Check the original before saving. Extracted names, deadlines and addressees are proposals; this creates a private draft request.")
        if (kind == "sales") {
            Text("Keep the actual sale date and supplied source figures. Saving does not confirm the sale or calculate tax.")
            Row { Checkbox(current.optBoolean("credit"), { checked -> val copy = JSONObject(draft.toString()); copy.getJSONObject("data").put("credit", checked); draft = copy; model.saveDraft(key, copy) }); Text("This is a credit or refund", Modifier.weight(1f).padding(top = 12.dp)) }
        }
        if (kind != "farms") Picker("Farm", current.optString("farm_id"), model.records["farms"].orEmpty().map { it.optString("id") to it.title() }) { update("farm_id", it) }
        if (kind in listOf("requests", "reports")) {
            Picker("Reporting pack", current.optString("pack_id"), model.packs.map { pack -> val p = pack.data(); (pack.optString("id").ifBlank { p.optString("id") }) to p.optString("name").ifBlank { p.optString("title", p.optString("id")) } }) { update("pack_id", it) }
            if (model.packs.isEmpty()) Text("Refresh your workspace to load available reviewed pack definitions. No pack is selected automatically.")
        }
        if (fields.any { it.key in listOf("document_id", "source_document_id") }) {
            val sourceKey = if (kind == "facts") "source_document_id" else "document_id"
            Choice("Supporting document · optional", current.optString(sourceKey), listOf("" to "No document selected") + model.records["documents"].orEmpty().map { it.getString("id") to it.title() }) { update(sourceKey, it) }
        }
        fields.filterNot { it.key in listOf("document_id", "source_document_id") }.forEach { field ->
            val defaultValue = when (field.key) { "value_literal" -> if (current.has("value")) jsonLiteral(current.opt("value")) else ""; "requirements_text" -> current.optJSONArray("requirements")?.objects()?.joinToString("\n") { it.optString("label") }.orEmpty(); else -> "" }
            val value = if (current.has(field.key) && current.opt(field.key) != JSONObject.NULL) current.optString(field.key) else defaultValue
            OutlinedTextField(value, { update(field.key, it) }, label = { Text(field.label + if (field.required) " *" else "") }, modifier = Modifier.fillMaxWidth().then(if (field.multiline) Modifier.heightIn(min = 110.dp) else Modifier), singleLine = !field.multiline)
        }
        Text("Saved on this device as you type. No value is confirmed by saving a proposal.", style = MaterialTheme.typography.bodySmall)
        if (error.isNotBlank()) Text(error, color = MaterialTheme.colorScheme.error)
        Button(onClick = {
            runCatching {
                val output = JSONObject(current.toString())
                fields.filter { it.required }.forEach { field -> require((if (field.key == "value_literal" && !current.has(field.key)) output.opt("value")?.let { jsonLiteral(it) }.orEmpty() else current.optString(field.key)).isNotBlank()) { "Complete ${field.label}." } }
                if (kind != "farms") require(output.optString("farm_id").isNotBlank()) { "Choose the farm." }
                if (kind in listOf("requests", "reports")) require(output.optString("pack_id").isNotBlank()) { "Choose an available reporting pack." }
                listOf("date", "deadline", "due_date").forEach { field -> if (output.has(field)) { val value = output.optString(field); if (value.isBlank() || value == "null") output.put(field, JSONObject.NULL) else LocalDate.parse(value) } }
                if (kind in listOf("farms", "requests", "reports")) { val value = output.optString("reporting_year").toIntOrNull() ?: error("Enter a four-digit reporting year."); require(value in 1900..2200); output.put("reporting_year", value) }
                listOf("area_ha", "quantity", "amount", "hours", "tax_amount", "tax_rate").forEach { field -> if (output.has(field) && output.optString(field).isNotBlank()) output.put(field, BigDecimal(output.optString(field))) else output.remove(field) }
                if (kind == "requests") {
                    require(output.optString("status") in listOf("draft", "review", "waiting") || (record != null && output.optString("status") == record.data().optString("status"))) { "Ready and responded are set by report approval and receipts. Choose draft, review or waiting." }
                    if (output.has("requirements_text")) { output.put("requirements", JSONArray(output.optString("requirements_text").lines().filter { it.isNotBlank() }.mapIndexed { index, label -> obj("key" to "question_${index + 1}", "label" to label, "required" to true) })); output.remove("requirements_text") }
                    if (!output.has("requirements")) output.put("requirements", JSONArray())
                }
                if (kind == "facts") {
                    require(output.optString("temporal_basis") in listOf("static", "campaign_year", "calendar_date")) { "Choose a listed time basis." }
                    if (output.has("value_literal")) { val raw = output.getString("value_literal"); val tokener = JSONTokener(raw); val value = tokener.nextValue(); require(tokener.nextClean() == '\u0000') { "Use one JSON literal." }; require(value !is String || raw.trim().startsWith('"')) { "Put text values in double quotes." }; output.put("value", value); output.remove("value_literal") }
                    val sources = output.optJSONArray("sources") ?: JSONArray()
                    val sourceId = output.optString("source_document_id")
                    if (sourceId.isNotBlank()) { val doc = model.records["documents"].orEmpty().find { it.optString("id") == sourceId } ?: error("Choose a document owned by this workspace."); sources.put(obj("document_id" to sourceId, "document_revision" to doc.getInt("revision"), "quote" to output.optString("source_quote"))) }
                    else if (output.optString("source_note").isNotBlank()) sources.put(obj("type" to "manual", "note" to output.optString("source_note")))
                    output.put("sources", sources); output.put("review_status", "proposed"); listOf("source_document_id", "source_quote", "source_note").forEach(output::remove)
                }
                // Keep server-owned approval/history fields out of ordinary patch payloads.
                val writable = when (kind) {
                    "farms" -> setOf("name", "country", "region", "reporting_year", "external_id", "origin", "area_ha", "sites", "parcels", "crops", "people", "reporting_periods", "notes", "address", "coordinates")
                    "facts" -> setOf("farm_id", "key", "label", "value", "unit", "period", "temporal_basis", "sources", "review_status", "supersedes_id", "notes")
                    "requests" -> setOf("farm_id", "title", "recipient", "country", "region", "reporting_year", "deadline", "pack_id", "requirements", "status", "notes", "document_id")
                    "reports" -> setOf("farm_id", "pack_id", "reporting_year", "request_id", "fact_ids", "selected_document_ids")
                    "operations" -> setOf("farm_id", "title", "date", "type", "quantity", "unit", "parcel", "parcel_id", "crop", "product", "operator", "hours", "note", "notes", "document_id", "external_id", "origin", "period", "temporal_basis", "sources", "review_status")
                    "purchases" -> setOf("farm_id", "title", "date", "category", "quantity", "unit", "amount", "currency", "document_id", "supplier", "invoice_number", "tax_amount", "tax_rate", "note", "notes", "external_id", "origin", "credit", "period", "temporal_basis", "sources", "review_status")
                    "sales" -> setOf("farm_id", "title", "date", "category", "quantity", "unit", "amount", "currency", "document_id", "buyer", "invoice_number", "tax_amount", "tax_rate", "note", "notes", "external_id", "origin", "credit", "period", "temporal_basis", "sources", "review_status")
                    "tasks" -> setOf("farm_id", "title", "description", "due_date", "status", "assignee", "request_id", "document_id", "notes")
                    else -> setOf("farm_id", "title", "pack_id", "version", "scheme", "items", "notes", "deadline", "request_id")
                }
                output.keys().asSequence().toList().filter { it !in writable }.forEach { output.remove(it) }
                val body = if (kind == "reports") output else obj("data" to output)
                if (record != null && !correction) body.put("expected_revision", draft.getInt("expected_revision"))
                val path = if (document != null) "/documents/${document.getString("id")}/request" else "/$kind" + (record?.takeUnless { correction }?.let { "/${it.getString("id")}" } ?: "")
                if (document != null) body.put("expected_revision", document.getInt("revision"))
                model.enqueue(path, body, if (record == null || correction) "POST" else "PATCH", key); close()
            }.onFailure { error = it.message ?: "Check your values." }
        }, enabled = !model.busy) { Text(if (kind == "reports") "Prepare report preview" else "Save and send") }
        TextButton(onClick = { model.deleteDraft(key); close() }) { Text("Discard this device draft") }
    }
}

@Composable private fun Picker(label: String, selected: String, options: List<Pair<String, String>>, change: (String) -> Unit) {
    var expanded by remember { mutableStateOf(false) }
    Column { Text(label, style = MaterialTheme.typography.labelLarge); Box { OutlinedButton(onClick = { expanded = true }, modifier = Modifier.fillMaxWidth()) { Text(options.find { it.first == selected }?.second ?: "Choose $label") }; DropdownMenu(expanded, { expanded = false }) { options.forEach { option -> DropdownMenuItem(text = { Text(option.second) }, onClick = { change(option.first); expanded = false }) } } } }
}
