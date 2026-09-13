'use strict';
/**
 * capture - client/request metadata extraction and body sanitisation for
 * ollama-proxy's MongoDB logging.
 *
 * Two safety rules drive everything here:
 *  1. Secrets (authorization / x-api-key) are never stored.
 *  2. Nothing unbounded is stored. Base64 images and oversized text are
 *     replaced with size placeholders, so a single request can never approach
 *     MongoDB's 16 MB document limit or exhaust proxy memory.
 */

const MAX_MSG_CHARS = 4000;   // per-message content cap
const MAX_MESSAGES = 40;      // keep only the most recent N messages
const MAX_FIELD_CHARS = 4000; // cap for prompt / other string fields

function normalizeIp(addr) {
  if (typeof addr !== 'string') return null;
  // IPv4-mapped IPv6 (::ffff:1.2.3.4) is what Node reports for v4 clients.
  const m = addr.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/i);
  return m ? m[1] : addr;
}

/** Classify the source so "is this the internet or my LAN?" is one query. */
function classifyIp(ip) {
  if (!ip) return 'unknown';
  if (ip === '127.0.0.1' || ip === '::1') return 'loopback';
  if (/^10\./.test(ip)) return 'private';
  if (/^192\.168\./.test(ip)) return 'private';
  if (/^172\.(1[6-9]|2\d|3[01])\./.test(ip)) return 'private';
  if (/^(fc|fd)/i.test(ip)) return 'private';
  if (/^169\.254\./.test(ip)) return 'link-local';
  return 'public';
}

// Tailscale assigns peer addresses from 100.64.0.0/10 (RFC 6598 shared space,
// second octet 64-127).
const CGNAT = /^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./;

/**
 * True only when BOTH ends of the connection sit in the 100.64/10 range, i.e.
 * the request arrived on this machine's own Tailscale address (the utun
 * interface) from another tailnet peer.
 *
 * Requiring the LOCAL address to match is what makes this safe: that range is
 * shared with carrier-grade NAT, so a genuine internet client sitting behind a
 * CGN could also present a 100.64.x source address. Such a client arrives on
 * the LAN/WAN interface, so its local address is 192.168.x (or the WAN IP) and
 * it is correctly classified as 'public' instead of being trusted.
 */
function isTailnet(remoteIp, localIp) {
  return CGNAT.test(remoteIp || '') && CGNAT.test(localIp || '');
}

/** Who is calling: address, identity, and which local endpoint was hit. */
function clientInfo(req) {
  const ip = normalizeIp(req.socket && req.socket.remoteAddress);
  const local = normalizeIp(req.socket && req.socket.localAddress);
  const xff = req.headers['x-forwarded-for'];
  return {
    clientIp: ip,
    clientScope: isTailnet(ip, local) ? 'tailnet' : classifyIp(ip),
    clientPort: req.socket ? req.socket.remotePort : null,
    userAgent: req.headers['user-agent'] || null,
    referer: req.headers.referer || req.headers.origin || null,
    // Present only if something upstream proxied the request.
    forwardedFor: typeof xff === 'string' ? xff.split(',')[0].trim() : null,
    // What the client typed as the target: distinguishes WAN-IP, LAN-IP and
    // localhost callers hitting the same listening socket.
    hostHeader: req.headers.host || null,
    localAddress: local,
    localPort: req.socket ? req.socket.localPort : null,
  };
}

function trunc(str, max) {
  if (typeof str !== 'string') return str;
  if (str.length <= max) return str;
  return str.slice(0, max) + `…[+${str.length - max} chars truncated]`;
}

/**
 * OpenAI-style multimodal content is an array of parts; image_url parts carry
 * data: URIs that can be megabytes each. Summarise instead of storing.
 */
function sanitizeContent(content) {
  if (typeof content === 'string') return trunc(content, MAX_MSG_CHARS);
  if (!Array.isArray(content)) return content === undefined ? null : String(content);
  return content.map((part) => {
    if (!part || typeof part !== 'object') return part;
    if (part.type === 'text') return { type: 'text', text: trunc(part.text, MAX_MSG_CHARS) };
    if (part.type === 'image_url') {
      const url = part.image_url && part.image_url.url;
      const len = typeof url === 'string' ? url.length : 0;
      return { type: 'image_url', image: `<omitted ${len} chars>`, dataUri: /^data:/i.test(url || '') };
    }
    return { type: part.type || 'unknown', note: '<omitted>' };
  });
}

/**
 * Extract the interesting parts of a parsed request body.
 * Returns a flat, bounded object safe to store as-is.
 */
function sanitizeBody(bodyObj, rawBytes) {
  const out = { bodyBytes: rawBytes || 0 };
  if (!bodyObj || typeof bodyObj !== 'object') return out;

  out.stream = bodyObj.stream !== false; // Ollama streams unless told otherwise
  // The ollama CLI (and some older SDKs) still send the legacy "name" field and
  // leave "model" empty — e.g. /api/show. Accept either so the log shows what
  // the client actually asked for instead of a blank.
  const askedModel = bodyObj.model || bodyObj.name;
  if (askedModel !== undefined) {
    out.requestedModel = String(askedModel);
    if (!bodyObj.model && bodyObj.name) out.legacyNameField = true;
  }
  if (typeof bodyObj.keep_alive !== 'undefined') out.keepAlive = bodyObj.keep_alive;
  if (typeof bodyObj.temperature !== 'undefined') out.temperature = bodyObj.temperature;

  // Client-supplied options are useful (they reveal num_ctx churn attempts).
  if (bodyObj.options && typeof bodyObj.options === 'object') {
    out.clientOptions = bodyObj.options;
  }
  // OpenAI-compatible requests nest params at the top level instead.
  for (const k of ['max_tokens', 'top_p', 'n', 'stop']) {
    if (typeof bodyObj[k] !== 'undefined') out[k] = bodyObj[k];
  }

  // /api/generate + /v1/completions
  if (typeof bodyObj.prompt === 'string') out.prompt = trunc(bodyObj.prompt, MAX_FIELD_CHARS);

  // /api/chat + /v1/chat/completions
  if (Array.isArray(bodyObj.messages)) {
    out.messageCount = bodyObj.messages.length;
    const kept = bodyObj.messages.slice(-MAX_MESSAGES);
    out.messagesTruncated = bodyObj.messages.length > kept.length;
    out.messages = kept.map((m) => {
      if (!m || typeof m !== 'object') return { raw: trunc(String(m), MAX_MSG_CHARS) };
      const rec = { role: m.role || null, content: sanitizeContent(m.content) };
      // Ollama carries base64 images alongside content; never store them.
      if (Array.isArray(m.images) && m.images.length) {
        rec.images = `<${m.images.length} image(s) omitted, ` +
          `${m.images.reduce((n, i) => n + (typeof i === 'string' ? i.length : 0), 0)} chars total>`;
      }
      if (Array.isArray(m.tools) && m.tools.length) rec.toolCount = m.tools.length;
      return rec;
    });
    // Convenience field: the newest user turn, i.e. "the incoming message".
    const lastUser = [...bodyObj.messages].reverse().find((m) => m && m.role === 'user');
    if (lastUser && typeof lastUser.content === 'string') {
      out.latestUserMessage = trunc(lastUser.content, MAX_FIELD_CHARS);
    }
  }

  // /api/embed(dings) inputs can be large arrays of text.
  if (typeof bodyObj.input === 'string') out.input = trunc(bodyObj.input, MAX_FIELD_CHARS);
  else if (Array.isArray(bodyObj.input)) {
    out.inputCount = bodyObj.input.length;
    out.input = bodyObj.input.slice(0, 5)
      .map((i) => trunc(typeof i === 'string' ? i : JSON.stringify(i), 500));
  }

  return out;
}

module.exports = { clientInfo, sanitizeBody, normalizeIp, classifyIp, isTailnet, trunc,
  MAX_MSG_CHARS, MAX_MESSAGES, MAX_FIELD_CHARS, sanitizeContent };
