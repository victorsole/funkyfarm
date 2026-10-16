package eu.funkyfarm.app

import androidx.compose.foundation.layout.*
import androidx.compose.foundation.text.selection.SelectionContainer
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp

@Composable internal fun HelpScreen(model: FarmModel, close: () -> Unit) {
    val farms = model.records["farms"].orEmpty()
    var farmId by remember { mutableStateOf(farms.firstOrNull()?.optString("id").orEmpty()) }
    val draftKey = "help-question:$farmId"
    val saved = model.draft(draftKey, obj("message" to "", "language" to "en"))
    var message by remember(draftKey) { mutableStateOf(saved.optString("message")) }
    var language by remember(draftKey) { mutableStateOf(saved.optString("language", "en")) }
    var includeContext by remember(draftKey) { mutableStateOf(false) }
    var askConsent by remember { mutableStateOf(false) }
    LaunchedEffect(Unit) { model.loadExtra("chat-status", "/assistant/chat/status") }
    val status = model.extras["chat-status"]
    val response = model.extras["chat-answer:$farmId"]?.takeIf { result -> result.optJSONObject("_request")?.let { input -> input.optString("farm_id") == farmId && input.optString("message") == message && input.optString("language") == language && input.optBoolean("include_farm_context") == includeContext } == true }
    Sheet("A hand with the next step", close) {
        AdministrationStatus(model)
        Text("Use your own assistant account", style = MaterialTheme.typography.titleLarge, fontWeight = FontWeight.Bold)
        Text("Continue on the website to review the official ChatGPT or Claude connection route. Enter provider credentials only on its official consent page. This app does not ask you to paste an API key.")
        WebLink(model, "/app/help", "Review my ChatGPT or Claude connection on the website")
        Text("Ask the farm's local assistant", style = MaterialTheme.typography.titleLarge)
        Text("If it is available, this uses the owner-hosted model. It can explain sources and preparation steps; it cannot confirm farm facts, approve reports or file anything.")
        status?.optString("privacy_notice")?.takeIf { it.isNotBlank() }?.let { Text(it, style = MaterialTheme.typography.bodySmall) }
        Text(when (status?.optString("status")) { "ready" -> "The local assistant is available"; "disabled" -> "The local assistant is disabled"; "model_missing" -> "The local model is not installed"; "unreachable" -> "The local model cannot be reached"; "configuration_error" -> "The local model needs configuration"; else -> "Checking local availability" })
        OutlinedButton(onClick = { model.loadExtra("chat-status", "/assistant/chat/status") }, enabled = !model.busy) { Text("Check availability again") }
        if (farms.isEmpty()) Text("Set up your farm before asking a farm-specific question.")
        else Choice("Which farm is this question about?", farmId, farms.map { it.getString("id") to it.title() }) { farmId = it }
        val languages = status?.optJSONArray("languages")?.objects()?.map { it.optString("code") to it.optString("name") }.orEmpty().ifEmpty { listOf("en" to "English") }
        Choice("Answer language", language, languages) { language = it; model.forgetExtra("chat-answer:$farmId"); model.saveDraft(draftKey, obj("message" to message, "language" to language)) }
        OutlinedTextField(message, { message = it; model.forgetExtra("chat-answer:$farmId"); model.saveDraft(draftKey, obj("message" to message, "language" to language)) }, label = { Text("What are you trying to do?") }, modifier = Modifier.fillMaxWidth().heightIn(min = 130.dp))
        val maximum = status?.optJSONObject("limits")?.optInt("message_max_chars", 2000) ?: 2000
        val maximumBytes = status?.optJSONObject("limits")?.optInt("message_max_utf8_bytes", 1200) ?: 1200
        val withinLimit = message.length <= maximum && message.toByteArray(Charsets.UTF_8).size <= maximumBytes
        Text("${message.length} / $maximum characters", style = MaterialTheme.typography.bodySmall)
        if (!withinLimit) Text("Shorten your question to fit the local model's message limit.", color = MaterialTheme.colorScheme.error)
        Row { Checkbox(includeContext, { includeContext = it; model.forgetExtra("chat-answer:$farmId") }); Text("Include this farm's private context in this question", Modifier.weight(1f).padding(top = 12.dp)) }
        Text(if (includeContext) "The selected farm's permitted context will be read by the owner-hosted model for this question. Check the farm selection and the question before continuing." else "Your question is sent to the owner-hosted model. Private farm-record context is off.", style = MaterialTheme.typography.bodySmall)
        Button(onClick = { if (includeContext) askConsent = true else model.postExtra("chat-answer:$farmId", "/assistant/chat", obj("farm_id" to farmId, "message" to message, "language" to language, "include_farm_context" to false)) }, enabled = status?.optBoolean("available") == true && farmId.isNotBlank() && message.isNotBlank() && withinLimit && !model.busy) { Text("Ask this question") }
        if (response != null) {
            Text(if (response.optString("status") == "unknown") "The assistant could not establish an answer" else "Assistant's explanation", style = MaterialTheme.typography.titleMedium)
            SelectionContainer { Text(response.optString("answer")) }
            response.optString("context_notice").takeIf { it.isNotBlank() }?.let { Text(it, style = MaterialTheme.typography.bodySmall) }
            SourceReferences(response.optJSONArray("citations"))
            Text("Check the cited source before making a consequential decision. This answer did not change a record or approve a report.", style = MaterialTheme.typography.bodySmall)
        }
    }
    if (askConsent) AlertDialog(onDismissRequest = { askConsent = false }, title = { Text("Include this farm's private context?") }, text = { Text("The owner-hosted model will receive the permitted context for ${farms.find { it.optString("id") == farmId }?.title().orEmpty()} with this question. Nothing is approved or sent to an authority.") }, confirmButton = { TextButton(onClick = { askConsent = false; model.postExtra("chat-answer:$farmId", "/assistant/chat", obj("farm_id" to farmId, "message" to message, "language" to language, "include_farm_context" to true)) }) { Text("Include context and ask") } }, dismissButton = { TextButton(onClick = { askConsent = false }) { Text("Keep working") } })
}
