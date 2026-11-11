package expo.modules.callkittelecom.push

import android.content.Context
import android.util.Base64
import java.util.UUID
import org.json.JSONArray
import org.json.JSONObject

data class NormalizedCallPush(
    val profileId: String,
    val event: String,
    val callId: String,
    val accountId: String?,
    val callerName: String?,
    val callerHandle: String,
    val expiresAt: String?,
    val revision: Long?,
)

/** Persisted declarative mapping used before React Native is available. */
object PushPayloadProfileStore {
    private const val PREFERENCES = "expo_callkit_telecom_push_profiles"
    private const val KEY_PROFILES = "profiles"

    fun save(context: Context, json: String) {
        val profiles = JSONArray(json)
        require(profiles.length() > 0) { "At least one push payload profile is required" }
        context.getSharedPreferences(PREFERENCES, Context.MODE_PRIVATE)
            .edit()
            .putString(KEY_PROFILES, profiles.toString())
            .apply()
    }

    fun read(context: Context): String? =
        context.getSharedPreferences(PREFERENCES, Context.MODE_PRIVATE).getString(KEY_PROFILES, null)

    fun normalize(context: Context, data: Map<String, String>): NormalizedCallPush? {
        val saved = read(context) ?: return null
        val payload = JSONObject()
        data.forEach { (key, value) -> payload.put(key, decodeJsonValue(value)) }
        val profiles = JSONArray(saved)
        for (index in 0 until profiles.length()) {
            val profile = profiles.getJSONObject(index)
            if (!matches(profile.optJSONArray("match"), payload)) continue
            normalize(profile, payload)?.let { return it }
        }
        return null
    }

    private fun normalize(profile: JSONObject, payload: JSONObject): NormalizedCallPush? {
        val fields = profile.getJSONObject("fields")
        val eventField = fields.getJSONObject("event")
        val rawEvent = resolve(eventField, payload)?.toString() ?: return null
        val event = eventField.getJSONObject("values").optString(rawEvent).takeIf { it.isNotBlank() }
            ?: return null
        val callId =
            resolve(fields.getJSONObject("callId"), payload)?.toString()?.takeIf { it.isNotBlank() }
                ?: if (event == "incoming") UUID.randomUUID().toString() else return null
        val callerField = fields.getJSONObject("callerHandle")
        val resolvedCaller = resolve(callerField, payload)?.toString()?.takeIf { it.isNotBlank() }
        if (resolvedCaller == null && callerField.optBoolean("required")) return null
        val callerHandle = resolvedCaller ?: callId
        return NormalizedCallPush(
            profileId = profile.getString("id"),
            event = event,
            callId = callId,
            accountId = fields.optJSONObject("accountId")?.let { resolve(it, payload)?.toString() },
            callerName = fields.optJSONObject("callerName")?.let { resolve(it, payload)?.toString() },
            callerHandle = callerHandle,
            expiresAt = fields.optJSONObject("expiresAt")?.let { resolve(it, payload)?.toString() },
            revision = fields.optJSONObject("revision")?.let { resolve(it, payload)?.toString()?.toLongOrNull() },
        )
    }

    private fun matches(rules: JSONArray?, payload: JSONObject): Boolean {
        if (rules == null) return true
        for (index in 0 until rules.length()) {
            val rule = rules.getJSONObject(index)
            if (resolvePath(payload, rule.getString("path")) != rule.opt("equals")) return false
        }
        return true
    }

    private fun resolve(mapping: JSONObject, payload: JSONObject): Any? {
        val value =
            when {
                mapping.has("constant") -> mapping.opt("constant")
                mapping.has("path") -> resolvePath(payload, mapping.getString("path"))
                else -> null
            }
        return if (value == null || value == JSONObject.NULL) mapping.opt("defaultValue") else value
    }

    private fun resolvePath(root: JSONObject, path: String): Any? {
        var current: Any? = root
        for (segment in path.split('.')) {
            current = decodeJsonValue(current)
            current = (current as? JSONObject)?.opt(segment) ?: return null
        }
        return current
    }

    private fun decodeJsonValue(value: Any?): Any? {
        if (value !is String) return value
        return decodeString(value)
    }

    private fun decodeString(value: String): Any =
        try {
            when {
                value.trimStart().startsWith("{") -> JSONObject(value)
                value.trimStart().startsWith("[") -> JSONArray(value)
                else -> decodeBase64Json(value) ?: value
            }
        } catch (_: Throwable) {
            value
        }

    private fun decodeBase64Json(value: String): Any? =
        try {
            val decoded = String(Base64.decode(value, Base64.DEFAULT), Charsets.UTF_8)
            when {
                decoded.trimStart().startsWith("{") -> JSONObject(decoded)
                decoded.trimStart().startsWith("[") -> JSONArray(decoded)
                else -> null
            }
        } catch (_: Throwable) {
            null
        }
}
