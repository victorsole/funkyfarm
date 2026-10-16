package eu.funkyfarm.app

import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Modifier
import org.json.JSONObject

private val treatmentTextFields = listOf(
    "product_authorisation" to "Product authorisation printed on the label",
    "dose" to "Actual dose", "dose_unit" to "Dose unit exactly as recorded",
    "treated_size" to "Actual treated area or size", "treated_unit" to "Treated size unit",
    "treated_location" to "Actual treatment location", "start_time" to "Actual start time · HH:mm",
    "crop" to "Crop treated", "eppo_code" to "EPPO crop code · if known",
    "bbch_stage" to "Growth stage · if recorded", "batch_number" to "Product batch number",
    "operator" to "Person who applied the treatment", "contractor" to "Contractor · if used"
)

@Composable internal fun CropTreatmentDetails(draft: JSONObject, update: (String, Any) -> Unit) {
    var expanded by remember { mutableStateOf(treatmentTextFields.any { draft.has(it.first) } || draft.has("treatment_type")) }
    TextButton(onClick = { expanded = !expanded }) { Text(if (expanded) "Hide treatment details" else "Add actual treatment and label details") }
    if (expanded) {
        Text("Copy the actual application and product-label details. An invoice does not establish use, dose, location, time or growth stage. Unknown details can remain blank in a proposal.")
        Choice("What was treated?", draft.optString("treatment_type"), listOf("" to "Not recorded", "surface" to "A field or surface", "closed_space" to "An enclosed space", "seed" to "Seeds")) { update("treatment_type", it) }
        treatmentTextFields.forEach { (key, label) -> OutlinedTextField(draft.opt(key).takeUnless { it == JSONObject.NULL }?.toString().orEmpty(), { update(key, it) }, label = { Text(label) }, modifier = Modifier.fillMaxWidth()) }
        listOf("label_time_required" to "Does the label require the application time?", "label_growth_stage_required" to "Does the label require the growth stage?").forEach { (key, label) ->
            val value = when (draft.opt(key)) { true -> "yes"; false -> "no"; else -> "unknown" }
            Choice(label, value, listOf("unknown" to "Not established", "yes" to "Yes", "no" to "No")) { update(key, when (it) { "yes" -> true; "no" -> false; else -> JSONObject.NULL }) }
        }
        Text("Saving a proposed record is not a finding that the treatment was permitted or that the record is complete.", style = MaterialTheme.typography.bodySmall)
    }
}

internal fun appendTreatmentDetails(data: JSONObject, draft: JSONObject) {
    (treatmentTextFields.map { it.first } + "treatment_type").forEach { key ->
        if (draft.has(key)) {
            val value = draft.opt(key).takeUnless { it == JSONObject.NULL }?.toString().orEmpty()
            if (key in listOf("dose", "treated_size") && value.isNotBlank()) require(value.matches(Regex("[+-]?\\d+(?:[.,]\\d+)?"))) { "Enter the treatment number without thousands separators." }
            data.put(key, value.ifBlank { null } ?: JSONObject.NULL)
        }
    }
    listOf("label_time_required", "label_growth_stage_required").forEach { if (draft.has(it)) data.put(it, draft.get(it)) }
}
