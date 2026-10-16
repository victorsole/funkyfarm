package eu.funkyfarm.app

import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Modifier

@Composable internal fun AdministrationEntryPoints(model: FarmModel) {
    OutlinedButton(onClick = { model.administration = "preparation" to null }, modifier = Modifier.fillMaxWidth()) { Text("Check what needs preparing") }
    TextButton(onClick = { model.administration = "updates" to null }) { Text("Official page changes") }
    TextButton(onClick = { model.administration = "adviser" to null }) { Text("Ask my adviser privately") }
    TextButton(onClick = { model.administration = "help" to null }) { Text("Help with my next step") }
}

@Composable internal fun AdministrationDestination(model: FarmModel) {
    val route = model.administration ?: return
    val close = { model.administration = null }
    val farms = model.records["farms"].orEmpty()
    val chosen = farms.find { it.optString("id") == route.second } ?: farms.singleOrNull()
    when (route.first) {
        "help" -> HelpScreen(model, close)
        "community" -> CommunityScreen(model, close)
        "adviser" -> AdviserScreen(model, chosen, close)
        else -> if (chosen == null) Sheet("Which farm are you working on?", close) {
            if (farms.isEmpty()) Text("Add your farm details first. These preparation checks need the farm's country and context.")
            farms.forEach { farm -> OutlinedButton(onClick = { model.administration = route.first to farm.getString("id") }, modifier = Modifier.fillMaxWidth()) { Text(farm.title()) } }
        } else when (route.first) {
            "updates" -> RegulatoryScreen(model, chosen, close)
            else -> ComplianceScreen(model, chosen, close) { model.administration = "adviser" to chosen.getString("id") }
        }
    }
}

@Composable internal fun AdministrationStatus(model: FarmModel) {
    if (model.busy) Text("Working…", style = MaterialTheme.typography.bodySmall)
    if (model.message.isNotBlank()) {
        Text(model.message, style = MaterialTheme.typography.bodySmall)
        TextButton(onClick = { model.notify("") }) { Text("Dismiss message") }
    }
}
