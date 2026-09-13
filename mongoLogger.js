'use strict';
/**
 * mongoLogger - best-effort MongoDB request logging for ollama-proxy.
 *
 * HARD REQUIREMENT: this module must never break inference. Every entry point
 * is fire-and-forget, every failure is swallowed, and a missing driver, a down
 * mongod, or a slow insert can only ever result in dropped log documents.
 * The proxy keeps serving requests regardless of what happens here.
 */

const FLUSH_MS = 2000;      // max time a doc waits before being written
const FLUSH_SIZE = 50;      // or until this many have queued
const MAX_BUF = 5000;       // hard memory cap; oldest docs are dropped past it
const RECONNECT_MS = 30000; // backoff between reconnect attempts

let cfg = { enabled: false };
let client = null;
let collection = null;
let buf = [];
let timer = null;
let flushing = false;
let connecting = false;
let warned = false;
let connectedSig = null;
let ttlNote = '';

function warnOnce(msg) {
  if (warned) return;
  warned = true;
  // Deliberately console, not the proxy's log(): avoid a require cycle.
  console.log(`[${new Date().toISOString()}] mongo-logger: ${msg} (logging disabled; proxy unaffected)`);
}

function note(msg) {
  console.log(`[${new Date().toISOString()}] mongo-logger: ${msg}`);
}

function signature(c) {
  // ttlDays included so changing it re-runs the index setup on hot-reload.
  return `${c.uri}|${c.db}|${c.collection}|${c.ttlDays || ''}`;
}

async function connect() {
  if (connecting) return;
  connecting = true;
  ttlNote = '';
  try {
    // Lazy require: a missing/broken driver must not prevent proxy.js loading.
    const { MongoClient } = require('mongodb');
    client = new MongoClient(cfg.uri, {
      serverSelectionTimeoutMS: 3000,
      connectTimeoutMS: 3000,
      maxPoolSize: 4,
    });
    await client.connect();
    collection = client.db(cfg.db).collection(cfg.collection);
    // Idempotent; makes the common "who hit me and when" queries fast.
    await collection.createIndex({ ts: -1 }).catch(() => {});
    await collection.createIndex({ clientIp: 1, ts: -1 }).catch(() => {});
    await collection.createIndex({ route: 1, ts: -1 }).catch(() => {});
    // Optional growth guard. The proxy port is reachable from the internet, so a
    // scanner could otherwise grow this collection without bound. Off unless
    // ttlDays is set, so nothing is ever deleted silently.
    if (Number.isFinite(cfg.ttlDays) && cfg.ttlDays > 0) {
      const seconds = Math.round(cfg.ttlDays * 86400);
      // Existing index with a different expireAfterSeconds must be modified,
      // not re-created, or createIndex throws IndexOptionsConflict.
      await collection.createIndex({ ts: 1 }, { expireAfterSeconds: seconds }).catch((err) => {
        if (err && err.codeName === 'IndexOptionsConflict') {
          return collection.db.command({
            collMod: cfg.collection,
            index: { name: 'ts_1', expireAfterSeconds: seconds },
          });
        }
        return null;
      }).catch(() => {});
      ttlNote = `ttl=${cfg.ttlDays}d`;
    }
    connectedSig = signature(cfg);
    warned = false;
    note(`connected -> ${cfg.db}.${cfg.collection} (${cfg.uri})${ttlNote ? ' ' + ttlNote : ''}`);
  } catch (err) {
    client = null;
    collection = null;
    connectedSig = null;
    warnOnce(`cannot connect: ${err.message}`);
    scheduleReconnect();
  } finally {
    connecting = false;
  }
}

function scheduleReconnect() {
  if (timer) return;
  timer = setTimeout(() => { timer = null; connect(); }, RECONNECT_MS);
  if (timer.unref) timer.unref();
}

function scheduleFlush() {
  if (timer) return;
  timer = setTimeout(() => { timer = null; flush(); }, FLUSH_MS);
  if (timer.unref) timer.unref();
}

async function flush() {
  if (flushing || buf.length === 0) return;
  if (!collection) { scheduleReconnect(); return; }
  flushing = true;
  const batch = buf.splice(0, buf.length);
  try {
    await collection.insertMany(batch, { ordered: false });
  } catch (err) {
    // Drop the batch rather than re-queue: re-queueing risks unbounded memory
    // growth and retry storms if mongod is down for a long time.
    warnOnce(`insert failed, dropped ${batch.length} doc(s): ${err.message}`);
    collection = null;
    connectedSig = null;
    if (client) { client.close().catch(() => {}); client = null; }
    scheduleReconnect();
  } finally {
    flushing = false;
    if (buf.length >= FLUSH_SIZE) flush();
    else if (buf.length) scheduleFlush();
  }
}

/**
 * Pick up a (possibly hot-reloaded) logging config. Reconnects only when the
 * connection details actually changed.
 */
function applyConfig(next) {
  cfg = next && typeof next === 'object' ? next : { enabled: false };
  if (!cfg.enabled) {
    if (client) { client.close().catch(() => {}); client = null; }
    collection = null;
    connectedSig = null;
    buf = [];
    return;
  }
  if (!cfg.uri || !cfg.db || !cfg.collection) {
    warnOnce('enabled but uri/db/collection missing');
    cfg = { ...cfg, enabled: false };
    return;
  }
  if (connectedSig !== signature(cfg)) {
    if (client) { client.close().catch(() => {}); client = null; }
    collection = null;
    connect();
  }
}

/** Queue one request document. Never throws, never blocks the caller. */
function record(doc) {
  if (!cfg.enabled) return;
  try {
    doc.ts = new Date();
    buf.push(doc);
    if (buf.length > MAX_BUF) buf.splice(0, buf.length - MAX_BUF);
    if (buf.length >= FLUSH_SIZE) flush();
    else scheduleFlush();
  } catch {
    /* logging must never propagate */
  }
}

/** Flush pending docs, then close. Returns a promise; safe to ignore. */
async function shutdown() {
  try {
    if (timer) { clearTimeout(timer); timer = null; }
    await flush();
    if (client) await client.close();
  } catch {
    /* best effort */
  }
}

module.exports = { applyConfig, record, shutdown, FLUSH_MS };
