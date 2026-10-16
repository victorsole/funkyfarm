package eu.funkyfarmers.app

import android.content.Context
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import android.util.AtomicFile
import org.json.JSONObject
import java.io.File
import java.security.KeyStore
import java.security.MessageDigest
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec

/** Files, tokens and drafts are encrypted before touching disk. Keys never leave AndroidKeyStore. */
class PrivateStore(private val context: Context, account: String) {
    private val identity = MessageDigest.getInstance("SHA-256").digest(account.toByteArray()).joinToString("") { "%02x".format(it) }
    private val alias = "funkyfarmers.$identity"
    private val directory = File(context.noBackupFilesDir, identity).apply { mkdirs() }
    private val keyStore = KeyStore.getInstance("AndroidKeyStore").apply { load(null) }
    private fun key(): SecretKey = (keyStore.getKey(alias, null) as? SecretKey) ?: KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, "AndroidKeyStore").run {
        init(KeyGenParameterSpec.Builder(alias, KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT)
            .setBlockModes(KeyProperties.BLOCK_MODE_GCM).setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE).build())
        generateKey()
    }
    @Synchronized fun put(name: String, bytes: ByteArray) {
        require(name.matches(Regex("[a-zA-Z0-9._-]{1,100}")))
        val cipher = Cipher.getInstance("AES/GCM/NoPadding").apply { init(Cipher.ENCRYPT_MODE, key()) }
        val atomic = AtomicFile(File(directory, name))
        val stream = atomic.startWrite()
        try { stream.write(cipher.iv); stream.write(cipher.doFinal(bytes)); atomic.finishWrite(stream) }
        catch (error: Throwable) { atomic.failWrite(stream); throw error }
    }
    @Synchronized fun read(name: String): ByteArray? {
        require(name.matches(Regex("[a-zA-Z0-9._-]{1,100}")))
        val file = File(directory, name)
        if (!file.exists()) return null
        val encrypted = AtomicFile(file).openRead().use { it.readBytes() }
        require(encrypted.size >= 28) { "The saved private data is incomplete." }
        return Cipher.getInstance("AES/GCM/NoPadding").run {
            init(Cipher.DECRYPT_MODE, key(), GCMParameterSpec(128, encrypted.copyOfRange(0, 12)))
            doFinal(encrypted.copyOfRange(12, encrypted.size))
        }
    }
    fun json(name: String) = read(name)?.toString(Charsets.UTF_8)?.let(::JSONObject) ?: JSONObject()
    fun save(name: String, value: JSONObject) = put(name, value.toString().toByteArray())
    @Synchronized fun delete(name: String) { AtomicFile(File(directory, name)).delete() }
    @Synchronized fun purge() {
        directory.listFiles()?.forEach { require(it.parentFile == directory); it.delete() }
        directory.delete()
        if (keyStore.containsAlias(alias)) keyStore.deleteEntry(alias)
    }
}
