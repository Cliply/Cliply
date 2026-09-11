/**
 * strip the user's paths and credentials out of a log line, before it can
 * reach an issue report or an analytics payload
 */

const os = require("os")

// the user's home folder and signed media urls (which carry their ip address)
// must never reach an issue report or analytics payload
const HOME_DIR = os.homedir()

/**
 * a netscape cookie row, as yt-dlp quotes one back at you
 *
 * both of its loaders print the offending line verbatim - "skipping cookie file
 * entry due to invalid length 8: '...'" and "invalid Netscape format cookies
 * file: '...'" - and the last column of that row is the cookie's value. Those
 * lines are kept in the stderr tail, the tail is attached to a failure, and the
 * report dialog puts the failure in a github issue url and on the clipboard. So
 * a single malformed row was a session token one click from being published.
 *
 * an earlier version kept the six structural columns, on the grounds that
 * knowing which cookie and which domain makes a report useful. That meant
 * matching python's repr of the row, column by column, and it leaked three
 * different ways: an escaped separator was inside the character class so a
 * column ran straight through it, a value containing an apostrophe flips python
 * to double quotes and ended the match early, and a flag spelled `true` matched
 * no pattern at all. Each fix was another clause guessing at repr syntax.
 *
 * so the row goes, whole. Everything from the first flag column to the end of
 * the line is replaced without reading it, which cannot leak a value it never
 * parses, and the diagnostic keeps the part worth having: that a row was
 * refused, and how many columns it had.
 */
const COOKIE_ROW_RE = /(?:\\t|\t)(?:TRUE|FALSE)(?:\\t|\t).*$/gim

// and the same protection for a row too malformed to have a recognisable flag
// column, keyed off yt-dlp's own wording rather than the row's shape
const COOKIE_DIAGNOSTIC_RE =
  /(skipping cookie file entry due to invalid length \d+:|invalid Netscape format cookies file:).*$/gim

const REDACTIONS = [
  [/\/Users\/[^/\\\s"'<>]+/g, "/Users/~"],
  [/\/home\/[^/\\\s"'<>]+/g, "/home/~"],
  [/([A-Za-z]):\\Users\\[^\\<>"|?*\n\r]+/g, "$1:\\Users\\~"],
  [/(https?:\/\/[^\s"'<>]+?)\?[^\s"'<>]*/g, "$1?<redacted>"],
  // the diagnostic first, so a row with no usable flag column is still cut off
  // at yt-dlp's own wording rather than surviving to the shape rule
  [COOKIE_DIAGNOSTIC_RE, "$1 <cookie row redacted>"],
  [COOKIE_ROW_RE, "<cookie row redacted>"]
]

/**
 * redact user paths and signed urls from a log line
 * @param {string} line - raw log line
 * @returns {string} redacted line
 */
function redactLogLine(line) {
  let text = String(line == null ? "" : line)

  if (HOME_DIR && text.includes(HOME_DIR)) {
    text = text.split(HOME_DIR).join("~")
  }

  for (const [pattern, replacement] of REDACTIONS) {
    text = text.replace(pattern, replacement)
  }

  return text
}

module.exports = {
  redactLogLine
}
