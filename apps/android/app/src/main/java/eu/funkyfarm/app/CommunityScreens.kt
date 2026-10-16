package eu.funkyfarm.app

import androidx.compose.foundation.layout.*
import androidx.compose.foundation.text.selection.SelectionContainer
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import org.json.JSONObject

private val communityCategories = listOf("general" to "General farming", "paperwork" to "Paperwork", "cap" to "CAP preparation", "inspections" to "Inspections", "sustainability" to "Sustainability", "records" to "Farm records")

@Composable internal fun CommunityScreen(model: FarmModel, close: () -> Unit) {
    var category by remember { mutableStateOf("general") }; var country by remember { mutableStateOf("") }; var composing by remember { mutableStateOf(false) }; var selectedId by remember { mutableStateOf<String?>(null) }
    val key = "community-list:$category:$country"
    fun reload() { model.loadExtra(key, "/community?category=$category" + if (country.isBlank()) "" else "&country=$country") }
    LaunchedEffect(category, country, model.serverVersion) { reload() }
    Sheet("Ask other farmers", close) {
        AdministrationStatus(model)
        Text("Only deliberately published text is shared. Your private farm records, documents and adviser conversations are not attached. Community replies are not verified professional advice.")
        Choice("Topic", category, communityCategories) { category = it }
        Choice("Country · optional", country, listOf("" to "All countries") + countryOptions()) { country = it }
        Button(onClick = { composing = true }) { Text("Write a question to share") }
        OutlinedButton(onClick = { reload() }, enabled = !model.busy) { Text("Refresh shared questions") }
        model.extras[key]?.optJSONArray("items")?.objects()?.forEach { question -> Card(onClick = { selectedId = question.getString("id") }, modifier = Modifier.fillMaxWidth()) { Column(Modifier.padding(16.dp)) { Text(question.title(), fontWeight = FontWeight.Bold); Text(question.data().optString("body").take(180)) } } }
    }
    if (composing) PublishCommunityQuestion(model) { composing = false }
    LaunchedEffect(selectedId, model.serverVersion) { selectedId?.let { model.loadExtra("community:$it", "/community/$it") } }
    selectedId?.let { id -> model.extras["community:$id"]?.let { response -> CommunityQuestion(model, id, response) { selectedId = null } } }
}

@Composable private fun PublishCommunityQuestion(model: FarmModel, close: () -> Unit) {
    val key = "community-new-question"
    var draft by remember { mutableStateOf(model.draft(key, obj("title" to "", "body" to "", "country" to "", "category" to "general"))) }
    var consent by remember { mutableStateOf(false) }
    fun change(name: String, value: String) { draft = JSONObject(draft.toString()).put(name, value); model.saveDraft(key, draft); consent = false }
    Sheet("A question for other farmers", close) {
        AdministrationStatus(model)
        OutlinedTextField(draft.optString("title"), { change("title", it) }, label = { Text("Question title") }, modifier = Modifier.fillMaxWidth())
        OutlinedTextField(draft.optString("body"), { change("body", it) }, label = { Text("Text you want to share") }, modifier = Modifier.fillMaxWidth().heightIn(min = 140.dp))
        Choice("Topic", draft.optString("category"), communityCategories) { change("category", it) }
        Choice("Country shown with the question · optional", draft.optString("country"), listOf("" to "No country shown") + countryOptions()) { change("country", it) }
        Row { Checkbox(consent, { consent = it }); Text("I want other signed-in users to read this exact text and the country I selected.", Modifier.weight(1f).padding(top = 12.dp)) }
        Text("Keep private identifiers and information you do not intend to share out of this text. Withdrawal cannot remove copies other readers have already kept.", style = MaterialTheme.typography.bodySmall)
        Button(onClick = { model.enqueue("/community", obj("title" to draft.getString("title"), "body" to draft.getString("body"), "category" to draft.getString("category"), "country" to draft.optString("country").ifBlank { null }, "publish" to true), draftKey = key); close() }, enabled = consent && draft.optString("title").isNotBlank() && draft.optString("body").isNotBlank() && !model.busy) { Text("Publish this question") }
        TextButton(onClick = { model.deleteDraft(key); close() }) { Text("Discard this device draft") }
    }
}

@Composable private fun CommunityQuestion(model: FarmModel, id: String, response: JSONObject, close: () -> Unit) {
    val question = response.optJSONObject("question") ?: return
    val data = question.data(); val key = "community-reply:$id"
    var text by remember(key) { mutableStateOf(model.draft(key, obj("body" to "")).optString("body")) }
    var consent by remember { mutableStateOf(false) }; var report by remember { mutableStateOf(false) }; var reason by remember { mutableStateOf("") }
    Sheet(question.title(), close) {
        AdministrationStatus(model)
        SelectionContainer { Text(data.optString("body")) }
        response.optJSONArray("replies")?.objects()?.forEach { reply -> Card(Modifier.fillMaxWidth()) { SelectionContainer { Text(reply.data().optString("body"), Modifier.padding(14.dp)) } } }
        OutlinedTextField(text, { text = it; consent = false; model.saveDraft(key, obj("body" to it)) }, label = { Text("A reply you want to share") }, modifier = Modifier.fillMaxWidth().heightIn(min = 110.dp))
        Row { Checkbox(consent, { consent = it }); Text("Publish this exact reply for other readers", Modifier.weight(1f).padding(top = 12.dp)) }
        Button(onClick = { model.enqueue("/community/$id/replies", obj("body" to text, "publish" to true), draftKey = key); close() }, enabled = consent && text.isNotBlank() && !model.busy) { Text("Publish reply") }
        if (question.optBoolean("is_author")) OutlinedButton(onClick = { model.enqueue("/community/$id/withdraw", JSONObject()); close() }, enabled = !model.busy) { Text("Withdraw my question from sharing") }
        TextButton(onClick = { report = !report }) { Text("Report this question") }
        if (report) { OutlinedTextField(reason, { reason = it }, label = { Text("Why should it be reviewed?") }, modifier = Modifier.fillMaxWidth()); OutlinedButton(onClick = { model.enqueue("/community/$id/report", obj("reason" to reason)); close() }, enabled = reason.isNotBlank() && !model.busy) { Text("Send this moderation report") } }
    }
}
