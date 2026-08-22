// download correlation ids
//
// the renderer generates the id it will filter progress events on and sends it
// with the request, so its listener is correlated from the moment it subscribes
// - before the acknowledgement even arrives. that makes the id untrusted input,
// so it is validated here rather than taken at face value.

const crypto = require("crypto")

// ids come back out as event keys and go into log lines, so keep them to the
// shape a correlation id actually has - no newlines, no control characters,
// nothing long enough to be a payload
const DOWNLOAD_ID_PATTERN = /^[A-Za-z0-9._:-]{1,128}$/

/**
 * use the renderer's correlation id when it sent one
 *
 * a malformed id is rejected rather than silently replaced: the renderer's
 * listener filters on the id it generated, so substituting our own would run
 * the download with nobody watching it.
 *
 * that applies to whitespace too. Trimming "  abc  " down to "abc" is the same
 * substitution in miniature - main would then emit events under an id the
 * renderer never matches - so a padded id is rejected, not repaired.
 *
 * @param {string} requested - id from the request
 * @param {string} type - used only for the fallback id
 * @returns {string|null} a collision-resistant download id, or null if invalid
 */
function resolveDownloadId(requested, type) {
  if (requested === undefined || requested === null || requested === "") {
    // direct api callers (and older clients) still get a unique id
    return `${type}_${crypto.randomUUID()}`
  }

  if (typeof requested !== "string") {
    return null
  }

  // the pattern admits no whitespace, so it is returned exactly as sent
  return DOWNLOAD_ID_PATTERN.test(requested) ? requested : null
}

module.exports = { resolveDownloadId, DOWNLOAD_ID_PATTERN }
