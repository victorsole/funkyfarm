package eu.funkyfarm.app

import androidx.compose.foundation.layout.*
import androidx.compose.foundation.text.selection.SelectionContainer
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import org.json.JSONObject

@Composable internal fun AdviserScreen(model: FarmModel, initialFarm: JSONObject?, close: () -> Unit) {
    val farms = model.records["farms"].orEmpty()
    var farmId by remember { mutableStateOf(initialFarm?.optString("id") ?: farms.firstOrNull()?.optString("id").orEmpty()) }
    var selectedId by remember { mutableStateOf<String?>(null) }
    val recipientsKey = "adviser-recipients:$farmId"; val questionsKey = "adviser-questions:$farmId"
    LaunchedEffect(farmId, model.serverVersion) { if (farmId.isNotBlank()) { model.loadExtra(recipientsKey, "/adviser/recipients?farm_id=$farmId"); model.loadExtra(questionsKey, "/adviser/questions?farm_id=$farmId") } }
    val draftKey = "adviser-question:$farmId"
    var draft by remember(draftKey) { mutableStateOf(model.draft(draftKey, obj("recipient_id" to "", "title" to "", "body" to ""))) }
    fun change(key: String, value: String) { draft = JSONObject(draft.toString()).put(key, value); model.saveDraft(draftKey, draft) }
    Sheet("Ask my adviser privately", close) {
        AdministrationStatus(model)
        Text("Only the named adviser with an existing grant for this farm can receive this private question. Asking does not grant new access or publish anything.")
        Choice("Which farm?", farmId, farms.map { it.getString("id") to it.title() }) { farmId = it }
        val recipients = model.extras[recipientsKey]?.optJSONArray("items")?.objects().orEmpty()
        if (recipients.isEmpty()) {
            Text("No granted adviser is available in this list. Use the website to review an invitation or the person's access first.")
            WebLink(model, "/app/advisers", "Review adviser access on the website")
        } else {
            Choice("Who should receive it?", draft.optString("recipient_id"), recipients.map { it.getString("user_id") to it.optString("display_name") }) { change("recipient_id", it) }
            OutlinedTextField(draft.optString("title"), { change("title", it) }, label = { Text("What do you need help with?") }, modifier = Modifier.fillMaxWidth())
            OutlinedTextField(draft.optString("body"), { change("body", it) }, label = { Text("Your private question") }, modifier = Modifier.fillMaxWidth().heightIn(min = 120.dp))
            Button(onClick = { model.enqueue("/adviser/questions", obj("farm_id" to farmId, "recipient_id" to draft.getString("recipient_id"), "title" to draft.getString("title"), "body" to draft.getString("body")), draftKey = draftKey); close() }, enabled = draft.optString("title").isNotBlank() && draft.optString("body").isNotBlank() && recipients.any { it.optString("user_id") == draft.optString("recipient_id") } && !model.busy) { Text("Send this private question") }
        }
        Text("Saved questions", style = MaterialTheme.typography.titleLarge)
        model.extras[questionsKey]?.optJSONArray("items")?.objects()?.forEach { question -> Card(onClick = { selectedId = question.getString("id") }, modifier = Modifier.fillMaxWidth()) { Column(Modifier.padding(16.dp)) { Text(question.title(), fontWeight = FontWeight.Bold); Text(question.data().optString("status").replace('_', ' ')) } } }
        OutlinedButton(onClick = { if (farmId.isNotBlank()) model.loadExtra(questionsKey, "/adviser/questions?farm_id=$farmId") }, enabled = !model.busy) { Text("Refresh private questions") }
    }
    LaunchedEffect(selectedId, model.serverVersion) { selectedId?.let { model.loadExtra("adviser-question:$it", "/adviser/questions/$it") } }
    selectedId?.let { id -> model.extras["adviser-question:$id"]?.let { question -> AdviserQuestion(model, question) { selectedId = null } } }
}

@Composable private fun AdviserQuestion(model: FarmModel, question: JSONObject, close: () -> Unit) {
    val data = question.data(); val key = "adviser-reply:${question.getString("id")}" 
    var draft by remember(key) { mutableStateOf(model.draft(key, obj("body" to "", "expected_revision" to question.getInt("revision")))) }
    Sheet(question.title(), close) {
        AdministrationStatus(model)
        SelectionContainer { Text(data.optString("body")) }
        Text("Private conversation · ${data.optString("status").replace('_', ' ')}")
        data.optJSONArray("responses")?.objects()?.forEach { reply -> Card(Modifier.fillMaxWidth()) { Column(Modifier.padding(14.dp)) { Text(reply.optString("display_name", "Response"), fontWeight = FontWeight.SemiBold); SelectionContainer { Text(reply.optString("body")) } } } }
        if (data.optString("status") != "closed") {
            OutlinedTextField(draft.optString("body"), { draft = JSONObject(draft.toString()).put("body", it); model.saveDraft(key, draft) }, label = { Text("Your private reply") }, modifier = Modifier.fillMaxWidth().heightIn(min = 110.dp))
            Button(onClick = { model.enqueue("/adviser/questions/${question.getString("id")}/reply", obj("expected_revision" to draft.getInt("expected_revision"), "body" to draft.getString("body")), draftKey = key); close() }, enabled = draft.optString("body").isNotBlank() && !model.busy) { Text("Send this private reply") }
            if (model.session?.optJSONObject("workspace")?.optString("role") == "owner") OutlinedButton(onClick = { model.enqueue("/adviser/questions/${question.getString("id")}/close", obj("expected_revision" to question.getInt("revision"))); close() }, enabled = !model.busy) { Text("Close this question") }
        }
        TextButton(onClick = { model.deleteDraft(key); close() }) { Text("Discard this device reply") }
    }
}
