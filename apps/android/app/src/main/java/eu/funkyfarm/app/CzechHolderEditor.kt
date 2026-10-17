package eu.funkyfarm.app

import androidx.compose.foundation.layout.*
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import org.json.JSONArray
import org.json.JSONObject
import java.time.LocalDate

@Composable internal fun CzechHolderEditor(model: FarmModel, farmId: String, record: JSONObject? = null, correction: Boolean = false, close: () -> Unit) {
    val key = "cz-holder:$farmId:${record?.getString("id") ?: "new"}:${if (correction) "correction" else "edit"}"
    val source = record?.data()?.optJSONObject("value") ?: JSONObject()
    val initial = obj("value" to source, "note" to "", "document_id" to "", "expected_revision" to record?.optInt("revision"))
    var draft by remember(key) { mutableStateOf(model.draft(key, initial)) }
    var acknowledgements by remember(key) { mutableStateOf<Set<String>>(emptySet()) }; var problem by remember(key) { mutableStateOf("") }
    val value = draft.getJSONObject("value")
    fun update(keyName: String, next: Any, nested: Boolean = true) {
        draft = JSONObject(draft.toString()).apply { if (nested) getJSONObject("value").put(keyName, next) else put(keyName, next) }
        model.saveDraft(key, draft); model.clearCheck(key); acknowledgements = emptySet()
    }
    fun body(): JSONObject {
        require(record == null || correction || record.data().text("review_status") == "proposed") { "Only an unconfirmed holder proposal can be edited. Propose a separate correction to a confirmed holder." }
        require(draft.text("note").isNotBlank()) { "Record the source where you checked the holder identity." }
        val holder = JSONObject(value.toString())
        holder.optJSONObject("identification_number")?.let { identification -> if (identification.text("status") != "provided") identification.remove("value") }
        if (holder.text("birth_date").isBlank()) holder.remove("birth_date") else LocalDate.parse(holder.getString("birth_date"))
        val sources = record?.data()?.optJSONArray("sources")?.let { JSONArray(it.toString()) } ?: JSONArray()
        sources.put(obj("kind" to "manual", "note" to draft.getString("note")))
        if (draft.text("document_id").isNotBlank()) sources.put(obj("kind" to "document", "document_id" to draft.getString("document_id"), "note" to draft.getString("note")))
        val data = obj("farm_id" to farmId, "key" to CZECH_HOLDER_KEY, "label" to "Czech crop-protection record holder", "value" to holder, "unit" to null, "period" to null, "temporal_basis" to "static", "sources" to sources, "review_status" to "proposed")
        if (correction) data.put("supersedes_id", record!!.getString("id"))
        return obj("kind" to "facts", "data" to data).apply { if (record != null && !correction) put("record_id", record.getString("id")).put("expected_revision", draft.getInt("expected_revision")) }
    }
    Sheet(if (correction) "Propose corrected holder details" else "Record the journal holder", close) {
        Text("Copy the actual holder and business address from your records. The farm's display name does not establish the holder. Saving creates a proposed static fact; a human must separately compare and confirm it.")
        if (correction) Text("The confirmed holder stays active until this separate successor is reviewed and confirmed. Issued journal reports stay unchanged.")
        Choice("Holder type", value.text("kind"), listOf("" to "Choose the actual holder type", "natural_person" to "Natural person", "legal_person" to "Legal person")) { selected ->
            val copy = JSONObject(value.toString()).put("kind", selected)
            if (selected != "natural_person") copy.remove("birth_date")
            draft = JSONObject(draft.toString()).put("value", copy); model.saveDraft(key, draft); model.clearCheck(key); acknowledgements = emptySet()
        }
        OutlinedTextField(value.text("name"), { update("name", it) }, label = { Text("Holder's full name or legal name") }, keyboardOptions = czechLiteralKeyboardOptions, modifier = Modifier.fillMaxWidth())
        OutlinedTextField(value.text("address"), { update("address", it) }, label = { Text("Holder's business address") }, keyboardOptions = czechLiteralKeyboardOptions, modifier = Modifier.fillMaxWidth())
        val identification = value.optJSONObject("identification_number") ?: JSONObject()
        Choice("Identification number", identification.text("status"), listOf("" to "Choose what is actually known", "provided" to "A number is assigned and supplied", "not_assigned" to "No number assigned · explicitly established", "unknown" to "Unknown · still needs checking")) { update("identification_number", obj("status" to it)) }
        if (identification.text("status") == "provided") OutlinedTextField(identification.text("value"), { update("identification_number", JSONObject(identification.toString()).put("value", it)) }, label = { Text("Identification number exactly as recorded") }, keyboardOptions = czechLiteralKeyboardOptions, modifier = Modifier.fillMaxWidth())
        if (value.text("kind") == "natural_person" && identification.text("status") == "not_assigned") OutlinedTextField(value.text("birth_date"), { update("birth_date", it) }, label = { Text("Actual birth date · YYYY-MM-DD") }, keyboardOptions = czechLiteralKeyboardOptions, modifier = Modifier.fillMaxWidth())
        if (identification.text("status") == "unknown") Text("Unknown identification stays unresolved; it is not treated as an exemption or an invented number.")
        Choice("Supporting identity document · optional", draft.text("document_id"), listOf("" to "No document selected") + model.records["documents"].orEmpty().map { it.getString("id") to it.title() }) { update("document_id", it, nested = false) }
        OutlinedTextField(draft.text("note"), { update("note", it, nested = false) }, label = { Text("Where did you check this holder identity? · required") }, keyboardOptions = czechLiteralKeyboardOptions, modifier = Modifier.fillMaxWidth())
        if (problem.isNotBlank()) Text(problem, color = MaterialTheme.colorScheme.error)
        OutlinedButton(onClick = { runCatching { model.checkCapture(key, body()) }.onFailure { problem = it.message ?: "Check the holder details." } }, enabled = !model.busy) { Text("Check holder details") }
        model.extras["check:$key"]?.optJSONObject("result")?.let { check ->
            check.optJSONArray("issues")?.objects()?.forEach { Text(it.optString("message"), color = if (it.optString("severity") == "error") MaterialTheme.colorScheme.error else MaterialTheme.colorScheme.onSurface) }
            val required = check.optJSONArray("requires_acknowledgement").strings()
            required.forEach { code -> Row { Checkbox(code in acknowledgements, { checked -> acknowledgements = if (checked) acknowledgements + code else acknowledgements - code }); Text(check.optJSONArray("issues")?.objects()?.find { it.optString("code") == code }?.optString("message") ?: "Acknowledge this holder check", Modifier.weight(1f).padding(top = 12.dp)) } }
            Button(onClick = { runCatching { model.submitCapture(key, body(), acknowledgements.toList()); close() }.onFailure { problem = it.message ?: "Check the holder again." } }, enabled = check.optBoolean("can_save") && required.all { it in acknowledgements } && !model.busy) { Text("Save holder proposal for separate review") }
        }
        TextButton(onClick = { model.deleteDraft(key); model.clearCheck(key); close() }) { Text("Discard this holder draft") }
    }
}

@Composable internal fun CzechHolderRecords(model: FarmModel, farmId: String, closeJournal: () -> Unit) {
    var facts by remember(farmId) { mutableStateOf<List<JSONObject>>(emptyList()) }; var offset by remember(farmId) { mutableStateOf(0) }
    var next by remember(farmId) { mutableStateOf(0) }; var total by remember(farmId) { mutableStateOf(0) }; var attempt by remember(farmId) { mutableStateOf(0) }
    var loading by remember(farmId) { mutableStateOf(true) }; var problem by remember(farmId) { mutableStateOf("") }; var editing by remember(farmId) { mutableStateOf(false) }
    LaunchedEffect(farmId, offset, attempt, model.serverVersion) {
        loading = true; problem = ""
        try {
            val response = model.sourceRequest("/facts?farm_id=$farmId&limit=$SOURCE_FACT_PAGE_SIZE&offset=$offset")
            val received = response.getJSONArray("items").objects()
            facts = if (offset == 0) received else (facts + received).distinctBy { it.getString("id") }
            total = response.getInt("total"); next = response.optInt("offset", offset) + received.size
        } catch (error: Throwable) { problem = sourceFailure(error) }
        finally { loading = false }
    }
    Text("Journal holder", style = MaterialTheme.typography.titleMedium)
    Text("A separately confirmed static holder fact is needed. A newly saved proposal is not confirmed.")
    if (loading) Text("Loading holder records…")
    if (problem.isNotBlank()) Text(problem, color = MaterialTheme.colorScheme.error)
    facts.filter { it.data().text("key") == CZECH_HOLDER_KEY }.forEach { fact -> OutlinedButton(onClick = { closeJournal(); model.open("facts", fact.getString("id")) }) { Text("Review holder · ${fact.data().optJSONObject("value")?.text("name").orEmpty()} · ${fact.data().text("review_status")}") } }
    if (next < total) OutlinedButton(onClick = { offset = next; attempt++ }, enabled = !loading) { Text("Load more farm facts to find holder records") }
    OutlinedButton(onClick = { offset = 0; facts = emptyList(); attempt++ }, enabled = !loading) { Text("Reload holder records") }
    OutlinedButton(onClick = { editing = true }) { Text("Record holder details") }
    if (editing) CzechHolderEditor(model, farmId) { editing = false }
}
