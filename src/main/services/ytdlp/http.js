/**
 * http - plain node https, no dependency and no electron import
 *
 * re-exported from services/ytdlp-updater.js, where every consumer and test
 * already reads it
 */

const crypto = require("crypto")
const { createWriteStream } = require("fs")
const dns = require("dns").promises
const https = require("https")
const net = require("net")
const { pipeline } = require("stream/promises")

const REQUEST_TIMEOUT_MS = 60 * 1000

// how long a single address gets to answer before the next one is tried. the
// os gives up on an unreachable host after ~75s, far too long to sit through
// when a sibling address would have answered in milliseconds
const CONNECT_TIMEOUT_MS = 10 * 1000

const MAX_REDIRECTS = 5
// SHA2-256SUMS is ~2 kb; anything near this is a redirect to something else
const MAX_TEXT_BYTES = 1024 * 1024
const USER_AGENT = "Cliply-Desktop"

function createHttpClient() {
  return {
    /**
     * the Location of a single redirect hop, without following it
     * @param {string} url - url to ask
     * @param {Object} options - {signal}
     * @returns {Promise<string|null>} absolute location, or null when not a redirect
     */
    async getRedirectLocation(url, options = {}) {
      const response = await httpGet(url, options)
      response.resume()

      if (!isRedirect(response) || !response.headers.location) {
        return null
      }

      return new URL(response.headers.location, url).toString()
    },

    /**
     * fetch a small text document
     * @param {string} url - url to fetch
     * @param {Object} options - {signal}
     * @returns {Promise<string>} the body
     */
    async getText(url, options = {}) {
      const response = await followRedirects(url, options)
      let body = ""

      response.setEncoding("utf8")

      for await (const chunk of response) {
        body += chunk

        if (body.length > MAX_TEXT_BYTES) {
          response.destroy()
          throw new Error(`unexpectedly large response from ${url}`)
        }
      }

      return body
    },

    /**
     * stream a file to disk, digesting it on the way past
     * @param {string} url - url to download
     * @param {string} destPath - where to write it
     * @param {Object} options - {signal}
     * @returns {Promise<string>} lowercase sha-256 hex digest
     */
    async download(url, destPath, options = {}) {
      const response = await followRedirects(url, options)
      const hash = crypto.createHash("sha256")

      response.on("data", (chunk) => hash.update(chunk))
      await pipeline(response, createWriteStream(destPath), {
        signal: options.signal || undefined
      })

      return hash.digest("hex")
    }
  }
}

/**
 * GET a url, trying every address its hostname resolves to
 *
 * github serves releases from an anycast host with four A records, and one
 * blackholed address is enough to stall an update indefinitely: https.get
 * resolves through dns.lookup, which returns a single address and never falls
 * back to its siblings, and the node electron 28 ships leaves happy eyeballs
 * off by default. so the addresses are resolved up front and tried in turn.
 *
 * @param {string} url - url to GET
 * @param {Object} options - {signal, timeoutMs, connectTimeoutMs, lookup}
 * @returns {Promise<import("http").IncomingMessage>} the unread response
 */
async function httpGet(url, options = {}) {
  const addresses = await resolveAddresses(new URL(url).hostname, options)

  return withAddressFallback(addresses, (address) =>
    httpGetVia(url, address, options)
  )
}

/**
 * every address a hostname resolves to, in the order the resolver gave them
 *
 * dns.lookup rather than dns.resolve so the os stays in charge - hosts files,
 * vpn split dns and corporate resolvers all still apply
 * @param {string} hostname - host to resolve
 * @param {Object} options - {lookup} for tests
 * @returns {Promise<string[]>} at least one address
 */
async function resolveAddresses(hostname, options = {}) {
  const lookup = options.lookup || dns.lookup
  const found = await lookup(hostname, { all: true, verbatim: true })
  const addresses = found.map((entry) => entry.address)

  if (addresses.length === 0) {
    throw new Error(`could not resolve ${hostname}`)
  }

  return addresses
}

/**
 * run an attempt per address, stopping at the first that gets through
 *
 * only a failure that happened before a connection was established moves on to
 * the next address. a tls, http or abort failure would repeat identically
 * there, so it is surfaced immediately rather than multiplied by four.
 * @param {string[]} addresses - addresses to try, in order
 * @param {(address: string) => Promise<any>} attempt - what to try per address
 * @returns {Promise<any>} the first successful attempt
 */
async function withAddressFallback(addresses, attempt) {
  let lastError = null

  for (const address of addresses) {
    try {
      return await attempt(address)
    } catch (error) {
      if (!error || error.connectFailed !== true) {
        throw error
      }

      lastError = error
    }
  }

  throw lastError
}

/**
 * one GET, pinned to one address
 * @param {string} url - url to GET
 * @param {string} address - the address to reach it at
 * @param {Object} options - {signal, timeoutMs, connectTimeoutMs}
 * @returns {Promise<import("http").IncomingMessage>} the unread response
 */
function httpGetVia(url, address, options = {}) {
  return new Promise((resolve, reject) => {
    let request
    let connected = false

    const fail = (error) => {
      // an abort is the caller's decision, not something a sibling address fixes
      error.connectFailed = !connected && !isAbortError(error)
      reject(error)
    }

    const onConnect = () => {
      connected = true
      // the short fuse only covers reaching the host - from here the longer
      // stalled-transfer guard owns the rest of the response
      request.setTimeout(options.timeoutMs || REQUEST_TIMEOUT_MS)
    }

    try {
      request = https.get(
        url,
        {
          signal: options.signal || undefined,
          headers: { "user-agent": USER_AGENT, accept: "*/*" },
          // the url still carries the hostname, so sni, the host header and
          // certificate validation are all untouched by pinning the address
          lookup: (_hostname, lookupOptions, callback) => {
            const family = net.isIPv6(address) ? 6 : 4

            if (lookupOptions && lookupOptions.all) {
              callback(null, [{ address, family }])
              return
            }

            callback(null, address, family)
          },
          // set here rather than through request.setTimeout so the timer is
          // armed when the socket is created, and so covers the connect itself
          timeout: options.connectTimeoutMs || CONNECT_TIMEOUT_MS
        },
        resolve
      )
    } catch (error) {
      fail(error)
      return
    }

    request.on("socket", (socket) => {
      if (socket.connecting) {
        socket.once("connect", onConnect)
        return
      }

      onConnect()
    })

    request.on("error", fail)
    request.on("timeout", () => {
      request.destroy(
        new Error(
          connected
            ? `request timed out: ${url}`
            : `could not connect to ${address} for ${url}`
        )
      )
    })
  })
}

function isAbortError(error) {
  return Boolean(error) && (error.name === "AbortError" || error.code === "ABORT_ERR")
}

async function followRedirects(url, options = {}, hops = 0) {
  const response = await httpGet(url, options)

  if (isRedirect(response) && response.headers.location) {
    response.resume()

    if (hops >= MAX_REDIRECTS) {
      throw new Error(`too many redirects for ${url}`)
    }

    const next = new URL(response.headers.location, url).toString()
    return followRedirects(next, options, hops + 1)
  }

  if (response.statusCode !== 200) {
    response.resume()
    throw new Error(`HTTP ${response.statusCode} for ${url}`)
  }

  return response
}

function isRedirect(response) {
  return response.statusCode >= 300 && response.statusCode < 400
}

module.exports = {
  createHttpClient,
  httpGet,
  resolveAddresses,
  withAddressFallback,
  httpGetVia,
  isAbortError,
  followRedirects,
  isRedirect,
  REQUEST_TIMEOUT_MS,
  CONNECT_TIMEOUT_MS,
  MAX_REDIRECTS,
  MAX_TEXT_BYTES,
  USER_AGENT
}
