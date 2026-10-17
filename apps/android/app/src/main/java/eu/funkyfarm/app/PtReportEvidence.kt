package eu.funkyfarm.app

import androidx.compose.foundation.layout.*
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import kotlinx.coroutines.CancellationException
import org.json.JSONObject
import java.util.UUID

private fun ptExtraAnswerEligible(record: JSONObject, farmId: String): Boolean =
    record.data().text("farm_id") == farmId && record.data().text("key") != "pt.ppp.surface_journal" &&
        record.data().text("review_status") == "confirmed" && record.data().opt("superseded_by") !is String

internal fun ptReportEvidencePin(record: JSONObject): JSONObject = obj("id" to record.getString("id"), "revision" to record.getInt("revision"), "title" to record.title())

@Composable internal fun PtReportSelectedChoices(label: String, selected: List<JSONObject>, enabled: Boolean, remove: (String) -> Unit) {
    var page by remember(label) { mutableStateOf(0) }
    val safePage = minOf(page, maxOf(0, (selected.size - 1) / 5)); val start = safePage * 5
    Text("${selected.size} selected $label")
    selected.drop(start).take(5).forEachIndexed { at, pin ->
        Text("${start + at + 1}. ${pin.getString("title")} · selected revision ${pin.getInt("revision")}")
        TextButton(onClick = { remove(pin.getString("id")) }, enabled = enabled) { Text("Remove selected $label ${start + at + 1}") }
    }
    if (selected.size > 5) Row {
        TextButton(onClick = { page = safePage - 1 }, enabled = safePage > 0) { Text("Previous selected $label") }
        TextButton(onClick = { page = safePage + 1 }, enabled = start + 5 < selected.size) { Text("Next selected $label") }
    }
}

/** Recheck only the explicitly selected records; documentary source pins remain separate. */
internal suspend fun ptCheckReportExtras(model: FarmModel, owner: JSONObject, farmId: String, facts: List<JSONObject>, documents: List<JSONObject>) {
    require(facts.size <= 4999 && documents.size <= 250)
    for ((kind, pins) in listOf("facts" to facts, "documents" to documents)) {
        require(pins.map { it.getString("id") }.distinct().size == pins.size)
        for (pin in pins) {
            val id = UUID.fromString(pin.getString("id")).toString()
            val current = model.sourceRequest("/$kind/$id")
            require(model.session === owner && current.getString("id") == id && current.getInt("revision") == pin.getInt("revision") && current.data().text("farm_id") == farmId && (kind != "facts" || ptExtraAnswerEligible(current, farmId))) {
                "A selected extra answer or attachment changed or is no longer available. Compare it, remove the retained selection and explicitly choose its current revision. Nothing was rebased."
            }
        }
    }
}

@Composable internal fun PtReportExtraPicker(model: FarmModel, owner: JSONObject, farmId: String, kind: String, selected: List<JSONObject>, enabled: Boolean, close: () -> Unit, choose: (List<JSONObject>) -> Unit) {
    require(kind == "facts" || kind == "documents")
    val answers = kind == "facts"; val noun = if (answers) "answers" else "documents"
    var offset by remember { mutableStateOf(0) }; var attempt by remember { mutableStateOf(0) }
    var result by remember { mutableStateOf<JSONObject?>(null) }; var problem by remember { mutableStateOf("") }; var loading by remember { mutableStateOf(true) }
    var opened by remember { mutableStateOf<String?>(null) }
    LaunchedEffect(farmId, kind, offset, attempt) {
        result = null; opened = null; problem = ""; loading = true
        try {
            val page = model.sourceRequest("/$kind?farm_id=$farmId&limit=5&offset=$offset")
            if (model.session !== owner) throw CancellationException()
            val rows = page.getJSONArray("items").objects()
            require(rows.size <= 5 && page.getInt("offset") == offset && page.getInt("total") >= offset + rows.size && rows.all { it.data().text("farm_id") == farmId }) { "This farm's selection page could not be read completely." }
            result = page
        } catch (error: CancellationException) { throw error }
        catch (error: Throwable) { problem = sourceFailure(error) }
        finally { loading = false }
    }
    Sheet(if (answers) "Choose extra confirmed answers" else "Choose actual report attachments", close) {
        Text(if (answers) "Only current, separately confirmed answers from this farm can be added. Other Portuguese source journals are excluded. Nothing is selected automatically; the report checks the letter's requirements afterwards." else "These documents will be included as report evidence. This is separate from the source documents used to check the literal journal. Nothing is attached automatically.")
        Text("${selected.size} explicitly selected $noun")
        if (loading) Text("Loading this farm's $noun…")
        if (problem.isNotBlank()) Text(problem, color = MaterialTheme.colorScheme.error)
        OutlinedButton(onClick = { attempt++ }, enabled = !loading) { Text("Reload extra $noun") }
        if (offset > 0 && result == null) TextButton(onClick = { offset = maxOf(0, offset - 5) }, enabled = !loading) { Text("Previous extra $noun") }
        result?.let { page ->
            val rows = page.getJSONArray("items").objects(); val total = page.getInt("total")
            Text("${if (rows.isEmpty()) 0 else offset + 1}–${offset + rows.size} of $total farm $noun")
            if (answers) Text("The range counts every saved farm answer; unconfirmed, retired and other journal records are not offered for selection.", style = MaterialTheme.typography.bodySmall)
            val eligible = rows.filter { !answers || ptExtraAnswerEligible(it, farmId) }
            if (eligible.isEmpty()) Text(if (rows.isEmpty()) "No $noun on this page." else "No eligible confirmed answers on this page. Continue to the next page; unloaded pages are not empty.")
            eligible.forEachIndexed { at, record ->
                val id = record.getString("id"); val pin = selected.find { it.getString("id") == id }; val checked = pin != null
                Row {
                    Checkbox(checked, { added -> choose(if (added) selected + ptReportEvidencePin(record) else selected.filterNot { it.getString("id") == id }) }, enabled = enabled && (checked || selected.size < if (answers) 4999 else 250))
                    Text("${record.title()} · revision ${record.getInt("revision")}", Modifier.weight(1f).padding(top = 12.dp))
                }
                if (pin != null && pin.getInt("revision") != record.getInt("revision")) Text("Selected revision ${pin.getInt("revision")} changed. Remove this choice before explicitly choosing the current version.", color = MaterialTheme.colorScheme.error)
                TextButton(onClick = { opened = if (opened == id) null else id }) { Text("${if (opened == id) "Hide" else "Compare"} ${if (answers) "confirmed answer" else "attachment details"} · choice ${offset + at + 1}") }
                if (opened == id) {
                    if (answers) {
                        LiteralField("Answer", record.data().opt("value")); LiteralField("Unit", record.data().opt("unit")); LiteralField("Period", record.data().opt("period")); LiteralField("Time basis", record.data().opt("temporal_basis"))
                        record.data().optJSONArray("sources")?.objects()?.forEachIndexed { at, source -> source.keys().asSequence().forEach { key -> LiteralField("Source ${at + 1} · ${key.replace('_', ' ')}", source.opt(key)) } }
                    } else listOf("filename", "media_type", "size_bytes", "sha256").forEach { field -> if (record.data().has(field)) LiteralField(field.replace('_', ' '), record.data().opt(field)) }
                }
            }
            Row {
                TextButton(onClick = { offset = maxOf(0, offset - 5) }, enabled = !loading && offset > 0) { Text("Previous extra $noun") }
                TextButton(onClick = { offset += rows.size }, enabled = !loading && rows.isNotEmpty() && offset + rows.size < total) { Text("Next extra $noun") }
            }
        }
    }
}
