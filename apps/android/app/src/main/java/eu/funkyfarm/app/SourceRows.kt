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

internal fun sourceText(value: Any?): String = when {
    value == null -> "Cell absent from source"
    value === JSONObject.NULL -> "Unknown · JSON null"
    value is String && value.isEmpty() -> "Empty source cell"
    value is String && value == "NULL" -> "NULL · literal source text"
    value is String && value == "UNKNOWN" -> "UNKNOWN · literal source text"
    else -> value.toString()
}

/** A compact locator only; the original cells remain available without reinterpretation. */
@Composable internal fun SourceRowSummary(value: JSONObject, schema: JSONObject?) {
    val columns = schema?.optJSONArray("row_columns")?.objects().orEmpty()
    val holding = schema?.optString("holding_column")
    val identities = schema?.optJSONArray("identity_columns").strings()
    val name = columns.firstOrNull { column -> column.optString("key").split('_').any { it.equals("name", true) } || column.optString("label").contains("name", true) }?.optString("key")
    val fallback = columns.filter { it.optString("type") == "text" && it.optString("key") != holding }.map { it.getString("key") }
    val keys = (identities + listOfNotNull(name) + fallback).distinct().filter { value.has(it) }.take(3)
    if (keys.isEmpty()) Text("Original source cells are available below.", style = MaterialTheme.typography.bodySmall)
    keys.forEach { key ->
        val label = columns.find { it.optString("key") == key }?.optString("label")?.ifBlank { key } ?: key
        val text = sourceText(value.get(key))
        Text("$label: " + if (text.length > 140) text.take(140) + "… · open cells for the full text" else text, style = MaterialTheme.typography.bodySmall)
    }
    if (schema != null && identities.isEmpty()) Text("Source-row reference only; no authority identifier is assumed.", style = MaterialTheme.typography.bodySmall)
}

/** Labels and units describe the source; original values never pass through numeric/date conversion. */
@Composable internal fun SourceRowValues(value: JSONObject, schema: JSONObject?) {
    val columns = schema?.optJSONArray("row_columns")?.objects().orEmpty()
    val keys = (columns.map { it.getString("key") } + value.keys().asSequence().toList()).distinct()
    keys.forEach { key ->
        val column = columns.find { it.optString("key") == key }
        Column(verticalArrangement = Arrangement.spacedBy(3.dp)) {
            Text((column?.optString("label")?.ifBlank { key } ?: "Additional source column") + " ($key)", fontWeight = FontWeight.SemiBold, style = MaterialTheme.typography.labelLarge)
            SelectionContainer { Text(sourceText(if (value.has(key)) value.get(key) else null)) }
            (column?.opt("unit") as? String)?.takeIf { it.isNotBlank() }?.let { Text("Original unit: $it · no conversion applied", style = MaterialTheme.typography.bodySmall) }
            if (column?.optBoolean("previous_year") == true) Text("Previous-year source information, not a new observation.", style = MaterialTheme.typography.bodySmall)
        }
    }
}

@Composable internal fun SourceProfileDefinition(profile: JSONObject) {
    Text(profile.optString("notice"), style = MaterialTheme.typography.bodySmall)
    SourceReferences(profile.optJSONArray("sources"))
    var show by remember(profile.optString("id"), profile.optString("definition_hash")) { mutableStateOf(false) }
    TextButton(onClick = { show = !show }) { Text(if (show) "Hide source column meanings" else "Show source columns and original units") }
    if (show) profile.optJSONArray("row_columns")?.objects()?.forEach { column ->
        Text("${column.optString("label")} (${column.optString("key")})" + (column.opt("unit") as? String)?.takeIf { it.isNotBlank() }?.let { " · original unit $it" }.orEmpty(), style = MaterialTheme.typography.bodySmall)
        if (column.optBoolean("previous_year")) Text("Previous-year source information", style = MaterialTheme.typography.bodySmall)
        column.optJSONArray("values")?.let { Text("Documented source codes: ${it.strings().joinToString(", ")}", style = MaterialTheme.typography.bodySmall) }
    }
}

internal fun sourceProfileId(record: JSONObject): String? = record.data().optJSONArray("sources")?.objects()?.firstNotNullOfOrNull { (it.opt("adapter_profile") as? String)?.takeIf(String::isNotBlank) }

@Composable internal fun SourceFactValue(model: FarmModel, record: JSONObject) {
    val value = record.data().optJSONObject("value") ?: return
    val profileId = sourceProfileId(record)
    LaunchedEffect(profileId, model.serverVersion) { if (profileId != null) model.loadExtra("source-profiles", "/imports/profiles") }
    val profile = model.extras["source-profiles"]?.optJSONArray("items")?.objects()?.find { it.optString("id") == profileId }
    if (profileId != null) Text("Original source row · check this separately before confirming. Current column guidance does not rewrite retained source values.")
    SourceRowValues(value, profile)
    record.data().optJSONArray("sources")?.objects()?.firstOrNull { it.has("import_id") }?.let { source ->
        OutlinedButton(onClick = { model.sourceImports = obj("import_id" to source.getString("import_id")) }) { Text("Open the original source and row review") }
    }
}
