package eu.funkyfarm.app

import android.content.Intent
import android.net.Uri
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.text.selection.SelectionContainer
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import org.json.JSONArray
import org.json.JSONObject
import java.time.LocalDate

@Composable internal fun ComplianceScreen(model: FarmModel, farm: JSONObject, close: () -> Unit, adviser: () -> Unit) {
    val farmId = farm.getString("id")
    var yearText by remember(farmId) { mutableStateOf(farm.data().optInt("reporting_year", LocalDate.now().year).toString()) }
    val year = yearText.toIntOrNull()?.takeIf { it in 1900..2200 }
    val responseKey = "compliance:$farmId:$year"
    LaunchedEffect(farmId, year, model.serverVersion) { if (year != null) model.loadExtra(responseKey, "/compliance/farms/$farmId?year=$year") }
    val response = model.extras[responseKey]
    var selected by remember(farmId, year) { mutableStateOf<Set<String>>(emptySet()) }
    var answering by remember(farmId, year) { mutableStateOf<JSONObject?>(null) }
    LaunchedEffect(response?.optString("input_fingerprint"), response?.optString("rules_hash")) { selected = emptySet() }
    Sheet("What needs preparing?", close) {
        AdministrationStatus(model)
        Text(farm.title(), style = MaterialTheme.typography.titleLarge)
        Text("Check the obligations that may concern this farm, see the missing evidence, and make a preparation checklist. Final applicability and authority decisions still need the right human review.")
        OutlinedTextField(yearText, { yearText = it }, label = { Text("Reporting year") }, modifier = Modifier.fillMaxWidth())
        if (responseKey in model.privateUnavailable) Text("This farm's preparation checks are not available to your account.")
        else if (response == null) Text("Connect to load the current checks for this farm and year.")
        else {
            response.optJSONArray("issues")?.objects()?.forEach { issue -> Text(issue.optString("message")) }
            response.optJSONArray("profile_questions")?.objects()?.forEach { question ->
                Text(question.optString("prompt").ifBlank { question.optString("label") }, fontWeight = FontWeight.SemiBold)
                Text("This farm detail still needs a checked answer. Your adviser can help you establish the right evidence.", style = MaterialTheme.typography.bodySmall)
                OutlinedButton(onClick = { answering = question }) { Text("Answer what I know") }
                question.optJSONArray("proposal_ids")?.let { proposals -> repeat(proposals.length()) { index -> TextButton(onClick = { close(); model.open("facts", proposals.getString(index)) }) { Text("Review an existing proposed answer") } } }
                question.optJSONArray("conflicting_fact_ids")?.let { facts -> repeat(facts.length()) { index -> TextButton(onClick = { close(); model.open("facts", facts.getString(index)) }) { Text("Check a conflicting answer and its source") } } }
            }
            val obligations = response.optJSONArray("obligations")?.objects().orEmpty()
            if (obligations.isEmpty()) Text("No obligations were returned for this selection. This is not a finding that no obligations apply.")
            obligations.forEach { rule -> Card(Modifier.fillMaxWidth()) { Column(Modifier.padding(16.dp), verticalArrangement = Arrangement.spacedBy(10.dp)) {
                Text(rule.optString("title"), style = MaterialTheme.typography.titleMedium, fontWeight = FontWeight.Bold)
                Text(when (rule.optString("applicability")) { "applies" -> "Relevant to the checked farm details"; "does_not_apply" -> "Not applicable on the checked details"; "conflict" -> "The evidence disagrees · human review needed"; else -> "Whether this applies is not established yet" })
                Text(when (rule.optString("status")) { "ready_for_review" -> "Evidence is ready for your review"; "needs_adviser" -> "Ask an adviser to help with this"; else -> "More information is needed" })
                rule.optJSONObject("deadline")?.let { deadline ->
                    val date = deadline.opt("date").takeUnless { it == JSONObject.NULL }?.toString()
                    if (date != null) Text("${if (deadline.optString("status") == "established") "Established deadline" else "Recorded deadline"}: $date")
                    if (deadline.optString("message").isNotBlank()) Text(deadline.optString("message"), style = MaterialTheme.typography.bodySmall)
                }
                rule.optJSONArray("requirements")?.objects()?.forEach { requirement ->
                    Text(requirement.optString("label"), fontWeight = FontWeight.SemiBold)
                    requirement.optJSONArray("issues")?.let { issues -> repeat(issues.length()) { Text(issues.get(it).let { issue -> if (issue is JSONObject) issue.optString("message", issue.toString()) else issue.toString() }) } }
                    requirement.optJSONArray("steps")?.objects()?.forEach { step -> PreparationStep(model, step, close) }
                }
                rule.optJSONArray("steps")?.objects()?.forEach { step -> PreparationStep(model, step, close) }
                SourceReferences(rule.optJSONArray("citations"))
                PlainLimits(rule.optJSONArray("limits"))
                Row { Checkbox(rule.optString("id") in selected, { checked -> selected = if (checked) selected + rule.getString("id") else selected - rule.getString("id") }, enabled = rule.optString("applicability") != "does_not_apply"); Text("Make a checklist for this", Modifier.weight(1f).padding(top = 12.dp)) }
            } } }
            Button(onClick = { model.enqueue("/compliance/farms/$farmId/checklist", obj("rule_ids" to JSONArray(selected.toList()), "expected_farm_revision" to response.getInt("farm_revision"), "year" to year)); selected = emptySet() }, enabled = selected.isNotEmpty() && year != null && !model.busy) { Text("Create selected preparation checklists") }
            PlainLimits(response.optJSONArray("limits"))
            Text("Reference set: ${response.optString("rules_version")}", style = MaterialTheme.typography.bodySmall)
        }
        OutlinedButton(onClick = adviser) { Text("Ask my adviser about this farm") }
        val checklists = model.records["checklists"].orEmpty().filter { it.data().optString("farm_id") == farmId }
        if (checklists.isNotEmpty()) Text("Your saved preparation checklists", style = MaterialTheme.typography.titleMedium)
        checklists.forEach { checklist -> OutlinedButton(onClick = { close(); model.open("checklists", checklist.getString("id")) }, modifier = Modifier.fillMaxWidth()) { Text(checklist.title()) } }
    }
    answering?.let { question -> PreparationAnswer(model, farm, question) { answering = null } }
}

@Composable private fun PreparationStep(model: FarmModel, step: JSONObject, close: () -> Unit) {
    Column(verticalArrangement = Arrangement.spacedBy(4.dp)) {
        if (step.optString("title").isNotBlank()) Text(step.optString("title"), fontWeight = FontWeight.SemiBold)
        if (step.optString("message").isNotBlank()) Text(step.optString("message"))
        val route = step.optString("href")
        val match = Regex("^/app/(requests|documents|reports|farm)/([0-9a-f-]{36})(?:#[a-z_-]+)?$").matchEntire(route)
        if (match != null) TextButton(onClick = { close(); model.open(if (match.groupValues[1] == "farm") "farms" else match.groupValues[1], match.groupValues[2]) }) { Text("Open this next step") }
        else if (route.startsWith("/app/")) WebLink(model, route, "Continue this step on the website")
    }
}

@Composable internal fun ChecklistDetails(model: FarmModel, record: JSONObject) {
    val key = "checklist-progress:${record.getString("id")}" 
    var draft by remember(key, record.optInt("revision")) { mutableStateOf(model.draft(key, obj("items" to (record.data().optJSONArray("items") ?: JSONArray()), "expected_revision" to record.getInt("revision")))) }
    fun change(index: Int, field: String, value: Any) { val copy = JSONObject(draft.toString()); copy.getJSONArray("items").getJSONObject(index).put(field, value); draft = copy; model.saveDraft(key, copy) }
    Text("Preparation checklist", style = MaterialTheme.typography.titleLarge)
    Text("Mark what you have actually checked. This records preparation progress, not a legal-compliance approval.")
    draft.getJSONArray("items").objects().forEachIndexed { index, item -> Card(Modifier.fillMaxWidth()) { Column(Modifier.padding(14.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
        Row { Checkbox(item.optBoolean("done"), { change(index, "done", it) }); Text(item.optString("label", item.optString("title")), Modifier.weight(1f).padding(top = 12.dp)) }
        item.optString("deadline").takeIf { it.isNotBlank() && it != "null" }?.let { Text("Recorded deadline: $it", style = MaterialTheme.typography.bodySmall) }
        OutlinedTextField(item.optString("note"), { change(index, "note", it) }, label = { Text("What did you check?") }, modifier = Modifier.fillMaxWidth())
        val evidence = item.optJSONArray("evidence_ids").strings()
        model.records["documents"].orEmpty().filter { it.data().optString("farm_id").let { id -> id.isBlank() || id == "null" || id == record.data().optString("farm_id") } }.forEach { document ->
            Row { Checkbox(document.getString("id") in evidence, { checked -> change(index, "evidence_ids", JSONArray(if (checked) evidence + document.getString("id") else evidence - document.getString("id"))) }); Text("Evidence: ${document.title()}", Modifier.weight(1f).padding(top = 12.dp)) }
        }
    } } }
    Button(onClick = { model.enqueue("/checklists/${record.getString("id")}", obj("expected_revision" to draft.getInt("expected_revision"), "data" to obj("items" to draft.getJSONArray("items"))), "PATCH", key) }, enabled = !model.busy) { Text("Save checklist progress") }
    TextButton(onClick = { model.deleteDraft(key); draft = obj("items" to (record.data().optJSONArray("items") ?: JSONArray()), "expected_revision" to record.getInt("revision")) }) { Text("Discard this device edit") }
}

@Composable internal fun SourceReferences(sources: JSONArray?) {
    sources?.let { values -> repeat(values.length()) { index ->
        val source = values.optJSONObject(index)
        if (source != null) {
            val title = source.optString("title").ifBlank { source.optString("label", "Source reference") }
            Text(title, style = MaterialTheme.typography.labelLarge)
            source.optString("quote").takeIf { it.isNotBlank() }?.let { SelectionContainer { Text(it) } }
            source.optString("url").takeIf { it.startsWith("https://") }?.let { OfficialSourceLink(it) }
        } else Text(values.get(index).toString(), style = MaterialTheme.typography.bodySmall)
    } }
}

@Composable internal fun PlainLimits(limits: JSONArray?) { limits?.let { values -> repeat(values.length()) { Text(values.get(it).toString(), style = MaterialTheme.typography.bodySmall) } } }

@Composable internal fun OfficialSourceLink(url: String) {
    val context = LocalContext.current
    TextButton(onClick = { runCatching { val uri = Uri.parse(url); require(uri.scheme == "https" && !uri.host.isNullOrBlank() && uri.userInfo == null); context.startActivity(Intent(Intent.ACTION_VIEW, uri).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)) } }) { Text("Read the source") }
}
