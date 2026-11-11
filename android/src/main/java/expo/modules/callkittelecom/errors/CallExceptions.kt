package expo.modules.callkittelecom.errors

import expo.modules.kotlin.exception.CodedException

/** A stable native error that JavaScript can map to a permission prompt. */
class MissingCallPermissionsException(vararg permissions: String) :
    CodedException(
        message = "Missing permissions: ${permissions.joinToString(separator = ", ")}",
    )
