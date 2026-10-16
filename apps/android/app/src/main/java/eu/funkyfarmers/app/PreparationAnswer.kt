package eu.funkyfarmers.app

import androidx.compose.foundation.layout.*
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import org.json.JSONArray
import org.json.JSONObject

@Composable internal fun PreparationAnswer(model: FarmModel, farm: JSONObject, question: JSONObject, close: () -> Unit) {
    val factKey = question.optString("fact_key").ifBlank { question.getString("key") }
    val period = question.opt("period").takeUnless { it == JSONObject.NULL }
    val basis = question.optString("temporal_basis")
    val key = "preparation-answer:${farm.getString("id")}:$factKey:$basis:$period"
    var draft by remember(key) { mutableStateOf(model.draft(key, obj("value" to "", "note" to ""))) }
    var acknowledged by remember(key) { mutableStateOf<Set<String>>(emptySet()) }
    var error by remember(key) { mutableStateOf("") }
    fun update(name: String, value: Any) { draft = JSONObject(draft.toString()).put(name, value); model.saveDraft(key, draft); model.clearCheck(key); acknowledged = emptySet() }
    val choices = question.optJSONArray("choices")?.objects().orEmpty()
    fun body(): JSONObject {
        require(basis.isNotBlank() && period != null) { "The source did not supply the time context. Refresh the checks before answering." }
        val value: Any = when (question.optString("value_type")) {
            "boolean" -> when (draft.optString("value")) { "yes" -> true; "no" -> false; else -> throw IllegalArgumentException("Choose yes or no, or leave this question unanswered.") }
            "choice" -> choices.find { JSONArray().put(it.get("value")).toString() == draft.optString("value") }?.get("value") ?: throw IllegalArgumentException("Choose an answer from the supplied options.")
            else -> draft.optString("value").also { require(it.isNotBlank()) { "Write the answer you can support." } }
        }
        require(draft.optString("note").isNotBlank()) { "Explain where this answer comes from." }
        return obj("kind" to "facts", "data" to obj("farm_id" to farm.getString("id"), "key" to factKey, "label" to question.optString("label"), "value" to value, "period" to period, "temporal_basis" to basis, "sources" to JSONArray().put(obj("kind" to "manual", "note" to draft.optString("note")))), "reporting_year" to period.toString().toIntOrNull())
    }
    Sheet(question.optString("label", "Farm detail"), close) {
        AdministrationStatus(model)
        Text(question.optString("prompt"))
        Text("Answer for $period. Save only what you can support; this becomes a proposal for a separate human review.", style = MaterialTheme.typography.bodySmall)
        SourceReferences(question.optJSONArray("sources"))
        when (question.optString("value_type")) {
            "boolean" -> Choice("Your answer", draft.optString("value"), listOf("yes" to "Yes", "no" to "No")) { update("value", it) }
            "choice" -> Choice("Your answer", draft.optString("value"), choices.map { option -> JSONArray().put(option.get("value")).toString() to option.optString("label") }) { update("value", it) }
            else -> OutlinedTextField(draft.optString("value"), { update("value", it) }, label = { Text("Your answer") }, modifier = Modifier.fillMaxWidth())
        }
        OutlinedTextField(draft.optString("note"), { update("note", it) }, label = { Text("What source or observation supports this?") }, modifier = Modifier.fillMaxWidth().heightIn(min = 100.dp))
        if (error.isNotBlank()) Text(error, color = MaterialTheme.colorScheme.error)
        OutlinedButton(onClick = { runCatching { model.checkCapture(key, body()) }.onFailure { error = it.message.orEmpty() } }, enabled = !model.busy) { Text("Check this answer") }
        model.extras["check:$key"]?.optJSONObject("result")?.let { check ->
            check.optJSONArray("issues")?.objects()?.forEach { Text(it.optString("message")) }
            val required = check.optJSONArray("requires_acknowledgement").strings()
            required.forEach { code -> Row { Checkbox(code in acknowledged, { checked -> acknowledged = if (checked) acknowledged + code else acknowledged - code }); Text(check.optJSONArray("issues")?.objects()?.find { it.optString("code") == code }?.optString("message") ?: "Acknowledge this check", Modifier.weight(1f).padding(top = 12.dp)) } }
            Button(onClick = { runCatching { model.submitCapture(key, body(), acknowledged.toList()); close(); model.administration = null }.onFailure { error = it.message.orEmpty() } }, enabled = check.optBoolean("can_save") && required.all { it in acknowledged } && !model.busy) { Text("Save proposed answer") }
        }
        TextButton(onClick = { model.deleteDraft(key); model.clearCheck(key); close() }) { Text("Discard this device answer") }
    }
}
