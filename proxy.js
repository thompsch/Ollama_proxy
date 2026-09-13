#!/usr/bin/env node
/**
 * ollama-proxy - filtering reverse proxy for Ollama.
 * Exposes ONLY the models listed in config.json (under fake/alias names).
 * Real Ollama stays on 127.0.0.1:11434 and is never reachable directly.
 */
'use strict';

const http = require('http');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { Transform } = require('stream');
const mongoLogger = require('./mongoLogger');
const { clientInfo, sanitizeBody } = require('./capture');

const CONFIG_PATH = path.join(__dirname, 'config.json');

let config = null;
let aliasToReal = new Map(); // alias -> real model name
let realToAlias = new Map(); // real model name -> alias
let configMtime = 0;

function log(msg) {
  console.log(`[${new Date().toISOString()}] ${msg}`);
}

function loadConfig() {
  const st = fs.statSync(CONFIG_PATH);
  if (config && st.mtimeMs === configMtime) return;
  const next = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
  const a2r = new Map(Object.entries(next.models || {}));
  if (a2r.size === 0) throw new Error('config.json: "models" map is empty');
  const r2a = new Map();
  for (const [alias, real] of a2r) {
    if (typeof real !== 'string' || !real) throw new Error(`config.json: bad mapping for "${alias}"`);
    if (!r2a.has(real)) r2a.set(real, alias);
  }
  config = next;
  aliasToReal = a2r;
  realToAlias = r2a;
  configMtime = st.mtimeMs;
  log(`config loaded: ${a2r.size} alias(es) -> ${[...new Set(a2r.values())].length} model(s)`);
  // Picks up logging changes on the same hot-reload path as the alias map.
  mongoLogger.applyConfig((next.logging && next.logging.mongo) || { enabled: false });
}

// Fake metadata: deterministic per alias, reveals nothing about the real model
function fakeDigest(alias) {
  return 'sha256:' + crypto.createHash('sha256').update('ollama-proxy:' + alias).digest('hex');
}
function fakeSize(alias) {
  const h = parseInt(fakeDigest(alias).slice(7, 15), 16);
  return 800000000 + (h % 19200000000); // ~0.8 GB .. ~20 GB
}
function fakeParams(alias) {
  const gb = fakeSize(alias) / 1000000000;
  return `${Math.max(1, Math.round(gb * 0.9))}B`;
}

function syntheticOllamaTags() {
  const modified = new Date().toISOString().replace(/\.\d+Z$/, 'Z');
  return {
    models: [...aliasToReal.keys()].map((alias) => ({
      name: alias,
      model: alias,
      modified_at: modified,
      size: fakeSize(alias),
      digest: fakeDigest(alias),
      details: {
        parent_model: '',
        format: 'gguf',
        family: 'llama',
        families: ['llama'],
        parameter_size: fakeParams(alias),
        quantization_level: 'Q4_K_M',
      },
    })),
  };
}

function syntheticOpenAIModels() {
  const now = Math.floor(Date.now() / 1000);
  return {
    object: 'list',
    data: [...aliasToReal.keys()].map((alias) => ({
      id: alias,
      object: 'model',
      created: now,
      owned_by: 'ollama',
    })),
  };
}

function sendJson(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Content-Length': Buffer.byteLength(body),
  });
  res.end(body);
}

function readBody(req, cb) {
  const chunks = [];
  let size = 0;
  req.on('data', (c) => {
    size += c.length;
    if (size > 512 * 1024 * 1024) {
      req.destroy();
      return;
    }
    chunks.push(c);
  });
  req.on('end', () => cb(Buffer.concat(chunks)));
  req.on('error', () => {});
}

// Small JSON GET helper for the tags/ps/models passthrough endpoints. Returns
// null (-> the caller uses its fallback payload) on any failure so a down
// Ollama never wedges the proxy's metadata routes.
function fetchUpstreamJson(route, cb) {
  const upstream = new URL(config.upstream);
  const req = http.get(
    {
      protocol: upstream.protocol,
      hostname: upstream.hostname,
      port: upstream.port || (upstream.protocol === 'https:' ? 443 : 80),
      path: route,
      headers: { accept: 'application/json' },
    },
    (upRes) => {
      const chunks = [];
      upRes.on('data', (c) => chunks.push(c));
      upRes.on('end', () => {
        if (upRes.statusCode !== 200) return cb(null);
        try {
          cb(JSON.parse(Buffer.concat(chunks).toString('utf8')));
        } catch {
          cb(null);
        }
      });
      upRes.on('error', () => cb(null));
    }
  );
  req.on('error', () => cb(null));
  req.setTimeout(5000, () => req.destroy());
}

function resolveModel(name) {
  if (typeof name !== 'string') return null;
  if (aliasToReal.has(name)) return aliasToReal.get(name);
  if (realToAlias.has(name)) return name; // real name of an exposed model
  return null;
}

function aliasForReal(real) {
  return realToAlias.get(real) || real;
}

// Streaming-safe rewrite of "model":"<real>" -> "model":"<alias>"
function modelRewriter(real, alias) {
  const needle = `"model":"${real}"`;
  const repl = `"model":"${alias}"`;
  const keep = needle.length - 1;
  let tail = '';
  return new Transform({
    transform(chunk, enc, cb) {
      let buf = tail + chunk.toString('utf8');
      if (buf.includes(needle)) buf = buf.split(needle).join(repl);
      if (buf.length > keep) {
        tail = buf.slice(buf.length - keep);
        cb(null, buf.slice(0, buf.length - keep));
      } else {
        tail = buf;
        cb(null, '');
      }
    },
    flush(cb) {
      if (tail && tail.includes(needle)) tail = tail.split(needle).join(repl);
      cb(null, tail);
    },
  });
}

function upstreamRequest(req, headers, body, onRes) {
  const upstream = new URL(config.upstream);
  return http.request(
    {
      protocol: upstream.protocol,
      hostname: upstream.hostname,
      port: upstream.port || (upstream.protocol === 'https:' ? 443 : 80),
      method: req.method,
      path: req.url,
      headers,
    },
    onRes
  );
}

function cleanHeaders(req, body) {
  const headers = { ...req.headers };
  delete headers.host;
  delete headers.connection;
  delete headers['content-length'];
  delete headers.authorization;
  delete headers['x-api-key'];
  if (body) headers['content-length'] = Buffer.byteLength(body);
  return headers;
}

// Buffered forward: post-process JSON response (strip keys, rewrite model)
function forwardBuffered(req, res, body, rewriteModel, strip) {
  const upReq = upstreamRequest(req, cleanHeaders(req, body), body, (upRes) => {
    const chunks = [];
    upRes.on('data', (c) => chunks.push(c));
    upRes.on('end', () => {
      let text = Buffer.concat(chunks).toString('utf8');
      if (strip && (upRes.headers['content-type'] || '').includes('application/json')) {
        try {
          const obj = JSON.parse(text);
          for (const key of strip) delete obj[key];
          text = JSON.stringify(obj);
        } catch { /* leave as-is */ }
      }
      if (rewriteModel) {
        text = text.split(`"model":"${rewriteModel[0]}"`).join(`"model":"${rewriteModel[1]}"`);
      }
      res.writeHead(upRes.statusCode, {
        'content-type': upRes.headers['content-type'] || 'application/json',
      });
      res.end(text);
    });
    upRes.on('error', () => res.destroy());
  });
  upReq.on('error', (err) => {
    log(`upstream error: ${err.message}`);
    if (!res.headersSent) sendJson(res, 502, { error: 'upstream unavailable' });
    else res.destroy();
  });
  req.on('aborted', () => upReq.destroy());
  if (body) upReq.write(body);
  upReq.end();
}

function forwardStreaming(req, res, body, real, alias) {
  const upReq = upstreamRequest(req, cleanHeaders(req, body), body, (upRes) => {
    res.writeHead(upRes.statusCode, upRes.headers);
    upRes.pipe(modelRewriter(real, alias)).pipe(res);
  });
  upReq.on('error', (err) => {
    log(`upstream error: ${err.message}`);
    if (!res.headersSent) sendJson(res, 502, { error: 'upstream unavailable' });
    else res.destroy();
  });
  req.on('aborted', () => upReq.destroy());
  if (body) upReq.write(body);
  upReq.end();
}

function forwardPlain(req, res) {
  const upReq = upstreamRequest(req, cleanHeaders(req, null), null, (upRes) => {
    res.writeHead(upRes.statusCode, upRes.headers);
    upRes.pipe(res);
  });
  upReq.on('error', (err) => {
    log(`upstream error: ${err.message}`);
    if (!res.headersSent) sendJson(res, 502, { error: 'upstream unavailable' });
    else res.destroy();
  });
  req.pipe(upReq);
}

// POST endpoints that carry a "model" field in the JSON body
function handleModelEndpoint(req, res, { strip = null } = {}, rec) {
  readBody(req, (raw) => {
    let bodyObj;
    try {
      bodyObj = JSON.parse(raw.toString('utf8') || '{}');
    } catch {
      if (rec) rec.set({ outcome: 'bad_json', bodyBytes: raw.length });
      log(`BADJSON ${req.url} from ${rec ? rec.ip : '?'} (${raw.length} bytes)`);
      return sendJson(res, 400, { error: 'invalid JSON body' });
    }
    // Capture the client's ORIGINAL body (esp. options.num_ctx) before the
    // forced-context override below rewrites it.
    if (rec) rec.setBody(bodyObj, raw.length);

    // The ollama CLI (and some older SDKs) still send the legacy "name" field
    // and leave "model" empty — e.g. POST /api/show. Accept either, otherwise
    // those clients get a spurious "model not found".
    const requested = bodyObj.model || bodyObj.name || '';
    const real = resolveModel(requested);
    if (!real) {
      if (rec) rec.set({ outcome: 'reject', reason: 'model not exposed' });
      log(`REJECT ${req.url} model="${requested}" from ${rec ? rec.ip : '?'} (${rec ? rec.scope : '?'})`);
      return sendJson(res, 404, { error: 'model not found' });
    }
    const alias = aliasForReal(real);
    // Force a single context window for every model request, matching the
    // chatbot (bots.ts) and the warmup script. Oversized or omitted num_ctx
    // from clients can otherwise allocate huge KV caches and force reloads /
    // evictions of the resident models.
    const appliedNumCtx = config.numCtx || 8192;
    bodyObj.options = { ...(bodyObj.options || {}), num_ctx: appliedNumCtx };
    // Rewrite every field that carries the model name (both the current
    // "model" and, when the client used it, the legacy "name").
    const patched = { ...bodyObj, model: real };
    if (bodyObj.name !== undefined) patched.name = real;
    const body = JSON.stringify(patched);
    if (rec) rec.set({ realModel: real, alias, appliedNumCtx });
    log(`OK ${req.url} ${alias} -> ${real}${bodyObj.stream === false ? '' : ' (stream)'} from ${rec ? rec.ip : '?'}`);
    if (strip || bodyObj.stream === false) {
      forwardBuffered(req, res, body, [real, alias], strip);
    } else {
      forwardStreaming(req, res, body, real, alias);
    }
  });
}

/**
 * Per-request recorder.
 *
 * Wraps res.writeHead/write/end so status and byte counts are captured without
 * touching any of the existing response paths, then writes exactly ONE Mongo
 * document when the response finishes (or the client disconnects). Callers only
 * accumulate context via rec.set(); they never have to remember to log.
 */
function beginRecord(req, res) {
  const started = process.hrtime.bigint();
  const meta = clientInfo(req);
  const pending = {};
  let status = null;
  let bytesOut = 0;
  let done = false;

  const origWriteHead = res.writeHead.bind(res);
  res.writeHead = function (code, ...rest) {
    if (status === null && typeof code === 'number') status = code;
    return origWriteHead(code, ...rest);
  };
  const origWrite = res.write.bind(res);
  res.write = function (chunk, ...rest) {
    if (chunk) bytesOut += chunk.length || 0;
    return origWrite(chunk, ...rest);
  };
  const origEnd = res.end.bind(res);
  res.end = function (chunk, ...rest) {
    if (chunk && typeof chunk !== 'function') bytesOut += chunk.length || 0;
    return origEnd(chunk, ...rest);
  };

  function emit(outcome) {
    if (done) return;
    done = true;
    const ms = Number(process.hrtime.bigint() - started) / 1e6;
    mongoLogger.record({
      ...meta,
      method: req.method,
      route: req.url.split('?')[0],
      url: req.url,
      status: status === null ? res.statusCode || null : status,
      ms: Math.round(ms * 100) / 100,
      bytesOut,
      outcome,
      ...pending,
    });
  }

  // Normal completion (fires after a stream has fully drained).
  res.on('finish', () => emit(pending.outcome || 'ok'));
  // Client vanished mid-stream: recorded distinctly so stalls are visible.
  res.on('close', () => {
    if (!res.writableEnded) emit(pending.outcome || 'aborted');
  });

  return {
    ip: meta.clientIp,
    scope: meta.clientScope,
    set(fields) { Object.assign(pending, fields); },
    // Attach a sanitised view of a parsed request body.
    setBody(bodyObj, rawBytes) { Object.assign(pending, sanitizeBody(bodyObj, rawBytes)); },
  };
}

/**
 * Authentication.
 *
 * Supports multiple named keys so each app can have its own credential, which
 * both authorises it and identifies it in the log (`authApp`). Scopes:
 *   off         - no auth anywhere (previous behaviour)
 *   public-only - loopback/LAN pass freely, internet clients need a key
 *   always      - every client needs a key
 *
 * "public-only" is the default because local tooling cannot send keys: the
 * ollama CLI has no header support, so "always" would break `ollama` on this
 * Mac and on every LAN machine, while still locking the internet door.
 *
 * Returns the app name on success, or null when the request was rejected (the
 * 401 has already been sent). The attempted key is never logged or stored.
 */
function authenticate(req, res, rec) {
  const auth = config.auth || {};
  const mode = auth.mode || (config.apiKey ? 'always' : 'off');
  if (mode === 'off') return 'anonymous';

  // Build the key -> app-name map FIRST, so trusted scopes can still attribute
  // a request to a specific app when the client does present a key.
  // `apiKey` (legacy single key) still works.
  const keys = {};
  if (typeof config.apiKey === 'string' && config.apiKey) keys[config.apiKey] = 'legacy';
  for (const [name, secret] of Object.entries(auth.keys || {})) {
    if (typeof secret === 'string' && secret) keys[secret] = name;
  }

  const header = req.headers.authorization || '';
  const presented = header.startsWith('Bearer ') ? header.slice(7) : req.headers['x-api-key'];
  const app = typeof presented === 'string' && presented ? keys[presented] : undefined;

  // Scopes that need no key in "public-only" mode. Deliberately an allowlist
  // rather than "anything that isn't public": a new scope must never inherit
  // trust by accident. A valid key still wins, so per-app attribution survives.
  const TRUSTED_LOCAL = new Set(['loopback', 'private', 'link-local']);

  // The tailnet is encrypted and device-authenticated, but Tailscale only says
  // WHICH MACHINE called, not which app. With auth.trustTailnet=true any
  // approved tailnet device is admitted key-less (so the header-less ollama CLI
  // works from agents); set it to false to demand per-app keys there too.
  if (mode === 'public-only') {
    if (TRUSTED_LOCAL.has(rec.scope)) return app || `local:${rec.scope}`;
    if (rec.scope === 'tailnet' && auth.trustTailnet === true) return app || 'tailnet';
  }

  if (Object.keys(keys).length === 0) {
    // Auth demanded but no keys configured: fail closed rather than open.
    rec.set({ outcome: 'unauthorized', reason: 'auth enabled but no keys configured' });
    log(`AUTHMISCONFIGURED ${req.method} ${req.url.split('?')[0]} from ${rec.ip} (${rec.scope})`);
    sendJson(res, 401, { error: 'unauthorized' });
    return null;
  }

  if (!app) {
    // Record whether a key was presented at all, never its value.
    rec.set({
      outcome: 'unauthorized',
      reason: presented ? 'invalid api key' : 'missing api key',
    });
    log(`UNAUTHORIZED ${req.method} ${req.url.split('?')[0]} from ${rec.ip} (${rec.scope})`);
    sendJson(res, 401, { error: 'unauthorized' });
    return null;
  }
  return app;
}

// ---------------------------------------------------------------------------
// Server
// ---------------------------------------------------------------------------
const BLOCKED = new Set([
  '/api/pull', '/api/push', '/api/delete', '/api/copy', '/api/create',
  '/api/blobs',
]);

const server = http.createServer((req, res) => {
  // Created first so every request is recorded, including config failures.
  const rec = beginRecord(req, res);

  try { loadConfig(); } catch (err) {
    rec.set({ outcome: 'config_error', error: err.message });
    log(`config error: ${err.message} (from ${rec.ip})`);
    return sendJson(res, 500, { error: 'proxy config error' });
  }

  // API key / per-app auth (see authenticate()). Must run before any routing.
  const authApp = authenticate(req, res, rec);
  if (authApp === null) return; // 401 already sent
  rec.set({ authApp });

  const route = req.url.split('?')[0];

  if (BLOCKED.has(route)) {
    rec.set({ outcome: 'block', reason: 'destructive route' });
    log(`BLOCK ${req.method} ${route} from ${rec.ip} (${rec.scope})`);
    return sendJson(res, 403, { error: 'forbidden' });
  }

  switch (route) {
    // ---- health check ------------------------------------------------------
    // The ollama CLI (and many SDKs) do `HEAD/GET /` before anything else and
    // treat a non-200 as "server not running", refusing to proceed. Real Ollama
    // answers "Ollama is running" here. Deliberately reveals nothing else: no
    // version, no models. Still behind auth, so internet scanners get 401.
    case '/':
    case '':
      res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('Ollama is running');
      return;

    // ---- metadata: real upstream data filtered to the exposed models ----
    // (falls back to the synthetic alias-only payloads when Ollama is down)
    case '/api/tags':
    case '/api/tags/':
      return fetchUpstreamJson('/api/tags', (tags) => {
        if (!tags || !Array.isArray(tags.models)) {
          return sendJson(res, 200, syntheticOllamaTags());
        }
        return sendJson(res, 200, {
          models: tags.models.filter((m) => m && resolveModel(m.name)),
        });
      });

    case '/api/ps':
    case '/api/ps/':
      return fetchUpstreamJson('/api/ps', (ps) => {
        if (!ps || !Array.isArray(ps.models)) {
          return sendJson(res, 200, { models: [] });
        }
        return sendJson(res, 200, {
          models: ps.models.filter((m) => m && resolveModel(m.name)),
        });
      });

    case '/v1/models':
      return fetchUpstreamJson('/v1/models', (body) => {
        if (!body || !Array.isArray(body.data)) {
          return sendJson(res, 200, syntheticOpenAIModels());
        }
        return sendJson(res, 200, {
          ...body,
          data: body.data.filter((m) => m && resolveModel(m.id)),
        });
      });

    case '/api/version':
      return forwardPlain(req, res);

    // ---- model endpoints (alias -> real, responses scrubbed) ----
    case '/api/chat':
    case '/api/generate':
      return handleModelEndpoint(req, res, {}, rec);

    case '/api/embed':
    case '/api/embeddings':
      return handleModelEndpoint(req, res, {}, rec);

    case '/api/show':
      // Strips "modelfile" (contains real name in FROM line) and "license"
      return handleModelEndpoint(req, res, { strip: ['modelfile', 'license'] }, rec);

    // ---- OpenAI-compatible endpoints ----
    case '/v1/chat/completions':
    case '/v1/completions':
    case '/v1/embeddings':
      return handleModelEndpoint(req, res, {}, rec);

    default:
      rec.set({ outcome: 'block', reason: 'route not allowed' });
      log(`BLOCK ${req.method} ${route} (not allowed) from ${rec.ip} (${rec.scope})`);
      return sendJson(res, 403, { error: 'forbidden' });
  }
});

try { loadConfig(); } catch (err) {
  console.error(`FATAL: ${err.message}`);
  process.exit(1);
}

const port = config.listenPort || 11435;
const host = config.listenHost || '0.0.0.0';
server.listen(port, host, () => {
  log(`ollama-proxy listening on http://${host}:${port} (upstream: ${config.upstream})`);
  log(`exposed aliases: ${[...aliasToReal.keys()].join(', ')}`);
  const lg = (config.logging && config.logging.mongo) || {};
  log(`mongo logging: ${lg.enabled ? `ON -> ${lg.db}.${lg.collection}` : 'OFF'}`);
  const a = config.auth || {};
  const am = a.mode || (config.apiKey ? 'always' : 'off');
  const n = Object.keys(a.keys || {}).length + (config.apiKey ? 1 : 0);
  log(`auth: ${am}${am === 'off' ? ' (OPEN - no key required)' : ` (${n} key(s))`}`);
});

// Flush pending log docs on shutdown so a restart never drops the last batch.
let shuttingDown = false;
function gracefulShutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  log(`${signal}: shutting down`);
  server.close();
  // Hard deadline: launchd must see the process exit promptly.
  const deadline = setTimeout(() => process.exit(0), 4000);
  if (deadline.unref) deadline.unref();
  mongoLogger.shutdown().then(() => process.exit(0), () => process.exit(0));
}
process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT', () => gracefulShutdown('SIGINT'));

process.on('uncaughtException', (err) => log(`uncaught: ${err.stack || err.message}`));
