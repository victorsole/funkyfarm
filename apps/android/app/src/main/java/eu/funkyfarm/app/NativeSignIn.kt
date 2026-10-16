package eu.funkyfarm.app

import android.content.Context
import android.net.Uri
import android.util.Base64
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import android.content.Intent
import org.json.JSONObject
import java.security.MessageDigest
import java.security.SecureRandom

internal const val NATIVE_SIGN_IN_REDIRECT = "funkyfarmapp://auth/sso"

/** Only the verifier, state and selected origin are retained; provider credentials stay in the browser. */
internal class NativeSignIn(context: Context) {
    private val store = PrivateStore(context, "native-sign-in")
    private fun randomValue() = ByteArray(32).also { SecureRandom().nextBytes(it) }.let { Base64.encodeToString(it, Base64.URL_SAFE or Base64.NO_WRAP or Base64.NO_PADDING) }
    private fun pending(): JSONObject? {
        val saved = store.json("pending.json")
        if (!saved.has("state")) return null
        val age = System.currentTimeMillis() - saved.optLong("created_at")
        if (age !in 0..600_000L) { cancel(); return null }
        return saved
    }
    fun hasPending() = pending() != null
    fun cancel() { store.delete("pending.json") }
    fun start(origin: String, provider: JSONObject): Uri {
        Api(origin) // Same HTTPS/local-development origin restrictions as password sign-in.
        val base = Uri.parse(origin)
        require(base.scheme == "https" || provider.optBoolean("allow_local_development")) { "This provider requires a configured HTTPS service." }
        val id = provider.getString("id")
        require(id.matches(Regex("[a-zA-Z0-9_-]{1,80}"))) { "The provider identifier is invalid." }
        val path = provider.getString("native_start_path")
        require(path == "/api/v1/auth/sso/$id/native/start") { "The provider sign-in route is invalid." }
        val verifier = randomValue(); val state = randomValue()
        val challenge = Base64.encodeToString(MessageDigest.getInstance("SHA-256").digest(verifier.toByteArray(Charsets.US_ASCII)), Base64.URL_SAFE or Base64.NO_WRAP or Base64.NO_PADDING)
        store.save("pending.json", obj("origin" to origin, "provider" to id, "verifier" to verifier, "state" to state, "created_at" to System.currentTimeMillis()))
        return base.buildUpon().encodedPath(path).appendQueryParameter("redirect_uri", NATIVE_SIGN_IN_REDIRECT).appendQueryParameter("state", state).appendQueryParameter("code_challenge", challenge).appendQueryParameter("code_challenge_method", "S256").build()
    }
    fun callback(uri: Uri): Pair<String, JSONObject> {
        require(uri.scheme == "funkyfarmapp" && uri.encodedAuthority == "auth" && uri.encodedPath == "/sso" && uri.fragment == null) { "The sign-in return link is not recognized." }
        require(uri.queryParameterNames.all { it in setOf("state", "code", "error") } && uri.queryParameterNames.all { uri.getQueryParameters(it).size == 1 }) { "The sign-in return link is invalid." }
        val saved = pending() ?: throw IllegalArgumentException("This sign-in has expired or was cancelled. Start again.")
        val state = uri.getQueryParameter("state").orEmpty()
        require(state.length <= 256 && MessageDigest.isEqual(state.toByteArray(Charsets.US_ASCII), saved.getString("state").toByteArray(Charsets.US_ASCII))) { "This return link does not match your sign-in. No account was changed." }
        val error = uri.getQueryParameter("error")
        val code = uri.getQueryParameter("code")
        require((error == null) != (code == null)) { "The sign-in return link is incomplete." }
        cancel() // A matching return can be consumed once; an uncertain exchange requires a fresh browser sign-in.
        if (error != null) throw IllegalArgumentException(if (error == "access_denied") "Sign-in was cancelled in the browser. You can try again or use your password." else "The provider could not finish sign-in. Try again or use your password.")
        require(!code.isNullOrBlank() && code.length <= 512) { "The one-time sign-in code is invalid. Start again." }
        return saved.getString("origin") to obj("code" to code, "code_verifier" to saved.getString("verifier"), "redirect_uri" to NATIVE_SIGN_IN_REDIRECT)
    }
}

@Composable internal fun ProviderSignIn(model: FarmModel, endpoint: String) {
    val context = LocalContext.current
    LaunchedEffect(endpoint) {
        kotlinx.coroutines.delay(350)
        model.loadSignInProviders(endpoint)
    }
    if (model.ssoPending) {
        Text("Finish sign-in in your browser, then return here. No provider password is entered in this app.")
        TextButton(onClick = model::cancelNativeSignIn) { Text("Cancel browser sign-in") }
    } else {
        model.ssoProviders.forEach { provider ->
            OutlinedButton(onClick = { model.beginNativeSignIn(endpoint, provider) { uri -> context.startActivity(Intent(Intent.ACTION_VIEW, uri).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)) } }, enabled = !model.busy && endpoint == model.ssoProviderOrigin, modifier = Modifier.fillMaxWidth()) { Text("Continue with ${provider.optString("name")}") }
        }
        if (model.ssoProviders.isNotEmpty()) Text("Your chosen provider opens in the system browser. Review its consent page before continuing.", style = MaterialTheme.typography.bodySmall)
    }
}
