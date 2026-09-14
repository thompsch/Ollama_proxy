# ollama-proxy

A filtering reverse proxy that exposes **only specific Ollama models — under fake
names —** to other computers on your network. Your real Ollama server stays bound
to `127.0.0.1:11434` and is never reachable directly.

## Files

| File | Purpose |
|---|---|
| `proxy.js` | The proxy (no runtime deps; `mongodb` is optional, for request logging) |
| `mongoLogger.js` | Optional Mongo request logger (batches writes, fails open) |
| `capture.js` | Client-IP/scope extraction + body sanitising for the logger |
| `config.json` | Aliases, port, upstream, API keys, logging — **gitignored (holds secrets)** |
| `config.json.example` | Committed template; copy to `config.json` on a new machine |
| `package.json` | Declares the optional `mongodb` dependency |
| `package-lock.json` | Pins the driver version so `npm ci` is reproducible |
| `node_modules/` | Installed driver (only needed if logging is enabled) — gitignored |
| `proxy.log` | Runtime log — gitignored (contains client IPs and request bodies) |
| `node` | Symlink to the Node binary used by launchd — gitignored, machine-specific |
| `com.botboy.ollama-proxy.daemon.plist` | Source-of-truth LaunchDaemon plist |
| `install-daemon.sh` | Bootstraps deps, then installs/starts the LaunchDaemon (run with sudo) |
| `.gitignore` | Keeps `config.json*`, logs, `node_modules` and `node` out of git |

## Install on a new machine

```bash
git clone git@github.com:thompsch/Ollama_proxy.git ~/.ollama-proxy
cd ~/.ollama-proxy
cp config.json.example config.json && chmod 600 config.json
$EDITOR config.json        # set model aliases + generate auth.keys
sudo ./install-daemon.sh   # node symlink + npm ci + LaunchDaemon
```

`install-daemon.sh` is idempotent and also provisions the `node` symlink and
runs `npm ci`, so a bare clone becomes a running boot-time daemon in one step.
It seeds `config.json` from the template when absent and forces mode `0600`,
because that file holds API keys.

⚠️ **`config.json` is deliberately not in the repo.** Its `auth.keys` grant
access to an internet-forwarded Ollama, so they must never be committed — the
repo is public. Share config *shape* via `config.json.example`; keep values local.

**Portability:** `com.botboy.ollama-proxy.daemon.plist` and `install-daemon.sh`
hardcode `/Users/botboy/.ollama-proxy` (launchd needs absolute paths). On a
different username or clone location, edit `PROXY_DIR` in `install-daemon.sh`
and the paths in the plist before running the installer.

## Startup (launchd)

The proxy runs as the `com.botboy.ollama-proxy` system LaunchDaemon — it starts
at BOOT (no login required), restarts automatically if it crashes, and survives
the DHCP race because it binds the wildcard address. Install/reinstall with:

```bash
sudo ~/.ollama-proxy/install-daemon.sh
```

After editing the plist, re-run the installer; `kickstart` alone won't pick up
plist changes.

## Port layout

| Address | What | Who can reach it |
|---|---|---|
| `127.0.0.1:11434` | Real Ollama (all 12 models) | Only this Mac |
| `100.x.y.z:11434` (`<machine>.<tailnet>.ts.net`) | ollama-proxy (aliases only) | **Tailnet peers only** — encrypted, keyless |
| `*:11434` (any other local address, e.g. `192.168.0.100`) | ollama-proxy (aliases only) | The whole local network |

> **The router's `11434` port-forward was REMOVED on 2026-09-14.** The proxy is no
> longer reachable from the public internet. It binds `0.0.0.0:11434` (so it still
> answers on LAN + tailnet), but nothing on the WAN points at it. Port `88`
> (the chatbot's forward) remains open.

The proxy binds `0.0.0.0:11434`; Ollama stays bound to `127.0.0.1:11434`. The
two coexist (specific loopback bind wins for loopback traffic), so local clients
reach real Ollama while LAN/WAN clients reach the proxy. Binding the wildcard
also removes the old `EADDRNOTAVAIL` boot race where the DHCP address didn't
exist yet — and for the same reason it automatically covers the Tailscale
`utun` interface, so joining a tailnet needed no bind change at all. Never set
Ollama's OLLAMA_HOST to 0.0.0.0 — it would expose all models directly and race
the proxy for the wildcard bind.

## WAN availability

Measured router port-forwards (11434 verified closed 2026-09-14):

| WAN port | Forwards to | Service | Status |
|---|---|---|---|
| `11434` | — (forward removed) | ollama-proxy | **CLOSED** — internet cannot reach it |
| `88` | `192.168.0.100:80` | **chatbot** (`~/chatbot`) | open |
| `80` | — | not forwarded | closed |

- chatbot: `http://<WAN-IP>:88/` — note the port *translation*: WAN 88 lands on
  the chatbot's port 80. This is why `~/ca13b/server.js` uses `CHAT_PORT = 88`
  while the chatbot itself listens on 80 and nothing listens on 88 locally.
- proxy: **no public address**. It serves LAN (`192.168.0.100:11434`) and
  tailnet (`<machine>.<tailnet>.ts.net:11434`) clients only. Real Ollama stays
  bound to `127.0.0.1:11434` and is never reachable by proxy clients either.

**The ollama-proxy has never listened on port 88.** Its bind history in
`proxy.log` is only `0.0.0.0:11434` (current), `192.168.0.100:11434` (the old
pre-wildcard config that hit the `EADDRNOTAVAIL` DHCP race) and `0.0.0.0:11435`
(`proxy.js`'s fallback default when `listenPort` is missing from config.json).
Port 88 belongs to the chatbot's forward, not to Ollama.

**Security notes for network exposure:**
- **The internet cannot reach the proxy** (router `11434` forward removed
  2026-09-14), so the WAN attack surface is gone entirely. `auth.mode:
  "public-only"` with per-app keys still exists and still runs, but with no
  public forward the keys now only matter for **LAN hygiene/attribution** — the
  tailnet and LAN are trusted scopes (keyless by design). If you ever re-open a
  public forward, the keys immediately become load-bearing again. See
  "Authentication" below for the full mode table and key management.
- Tailnet traffic is device-authenticated + encrypted end-to-end; LAN traffic
  is not encrypted (fine for a home network).
- The proxy is no longer WAN-exposed, so the old "test your public port from
  outside" instructions no longer apply — there is no public port to test. LAN
  and tailnet paths work from inside the network as normal. (For reference: this
  router does no NAT hairpin, so a `curl http://<WAN-IP>:11434/...` from inside
  the LAN would time out even if a forward existed — don't use that as a health
  check for the proxy.)
- The whole setup assumes the Mac keeps the IP 192.168.0.100 — set a DHCP
  reservation on the router; if the IP changes, the proxy's LAN and tailnet
  references and the chatbot's port-88 forward break.

## Remote client usage

Remote computers point at the standard Ollama port on this machine's LAN IP (the proxy answers there):

```bash
# Ollama CLI (lists only the exposed models - see "models" in config.json)
OLLAMA_HOST=192.168.0.100:11434 ollama list
OLLAMA_HOST=192.168.0.100:11434 ollama run gemma4:12b

# OpenAI-compatible clients
#   base_url: http://192.168.0.100:11434/v1
#   model:    gemma4:12b

# Raw API
curl http://192.168.0.100:11434/api/chat -d '{"model":"gemma4:12b","messages":[...]}'
```

## Changing which models are exposed / their fake names

Edit `models` in `config.json` — aliases map to real model names
(`ollama list` shows the real names). **The proxy hot-reloads the config**,
no restart needed:

> ⚠️ **Every value in `models` must be a name that currently exists in
> `ollama list`, and every model you want reachable from the LAN/WAN must be
> listed.** A missing or stale entry (e.g. after `ollama cp`/re-pull renames a
> model) makes the proxy answer `404 {"error":"model not found"}` for it — while
> the SAME model still works on `127.0.0.1:11434`, because that address bypasses
> the proxy and reaches real Ollama directly. That asymmetry looks exactly like
> "Ollama works on localhost but is dead from the network". After any rename or
> edit, verify with:
>
> ```bash
> diff <(curl -s http://127.0.0.1:11434/api/tags | grep -o '"name":"[^"]*"' | sort) \
>      <(curl -s http://192.168.0.100:11434/api/tags | grep -o '"name":"[^"]*"' | sort)
> ```
>
> Check `~/.ollama-proxy/proxy.log` for `REJECT ... (unknown/not exposed)` lines
> to see which client requests the allowlist is dropping.

```json
"models": {
  "assistant": "ChatBot:latest",
  "my-coder":  "qwen3-coder:latest"
}
```

## Authentication / locking down who can use it

**The internet cannot reach the proxy** (router `11434` forward removed
2026-09-14), so the keys below are no longer load-bearing for security — they're
now optional **LAN attribution**. `auth.mode: "public-only"` remains set, which
is correct: it keeps every local/tailnet tool working with zero config and
would instantly re-lock the door if a public forward were ever re-added. The
keys still exist and agents may present them; it just no longer matters for
access on the tailnet/LAN (both trusted scopes).

```jsonc
"auth": {
  "mode": "public-only",   // "off" | "public-only" | "always"
  "keys": {
    "cline":  "opk_...",   // code agent (Cline / IDE agent)
    "codex":  "opk_...",   // code agent (Codex / CLI agent)
    "agent3": "opk_...",   // spare
    "agent4": "opk_..."    // spare
  }
}
```

**Configuring a code agent to use this proxy:** point its Ollama base URL at
`http://<machine>.<tailnet>.ts.net:11434` (recommended — see *Tailscale* below)
or `http://192.168.0.100:11434` on the LAN. **There is no public (WAN) address**
— the router forward was removed, so internet agents must use Tailscale. No key
is required on the tailnet or LAN, but you may add one for `authApp`
attribution in Mongo. Most agents expose an OpenAI-compatible setting:

```sh
# env-var style (works for most CLIs / SDKs) — tailnet path
export OLLAMA_HOST=http://<machine>.<tailnet>.ts.net:11434
export OPENAI_BASE_URL=http://<machine>.<tailnet>.ts.net:11434/v1
# OPENAI_API_KEY is optional on the tailnet; add it if you want attribution

# LAN alternative (no key needed either)
export OPENAI_BASE_URL=http://192.168.0.100:11434/v1
```

Give each agent **its own key** — that is what makes `authApp` attribution in
Mongo meaningful, and lets you revoke one agent without touching the others.

Print the current keys with:

```bash
node -e 'const c=require(process.env.HOME+"/.ollama-proxy/config.json");for(const[a,k]of Object.entries(c.auth.keys))console.log(a,"=",k)'
```

| mode | Who needs a key | Use when |
|---|---|---|
| `off` | nobody | trusted LAN only, port NOT forwarded |
| `public-only` | internet clients only | **current** — internet is closed at the router anyway; keys now just do LAN attribution |
| `always` | everyone | maximum strictness; every client must carry a key |

**Correction to an earlier claim in this file:** the ollama CLI *can* send a key.
`OLLAMA_API_KEY` was added in v0.3.12 (this machine runs v0.33.3), so `always`
would NOT break the CLI — it would just require `OLLAMA_API_KEY` everywhere.
`public-only` is still the better default: it locks the internet door while
leaving every LAN tool working with zero configuration. Switch to `always` only
if you also want to stop unauthorised *LAN* devices.

Clients send the key as `Authorization: Bearer <secret>`, `X-Api-Key: <secret>`,
or (ollama CLI only) `OLLAMA_API_KEY=<secret>`. OpenAI-compatible clients do this
natively via their "API key" field.

### Tailscale — the preferred path for remote agents

This machine is on a tailnet: MagicDNS name `<machine>.<tailnet>.ts.net`,
Tailscale IP `100.x.y.z`. **Remote agents should use the tailnet address
rather than the public WAN IP** — encrypted, keyless, and immune to your ISP
changing your public IP:

```sh
export OLLAMA_HOST=http://<machine>.<tailnet>.ts.net:11434
export OPENAI_BASE_URL=http://<machine>.<tailnet>.ts.net:11434/v1
# no API key needed on the tailnet
```

Prefer the MagicDNS **name** over the `100.x` IP — the name is stable, while the
IP can change if the device is removed from the tailnet and re-added.

`auth.trustTailnet: true` (current setting) admits any approved tailnet device
without a key, so the header-less ollama CLI and minimal agents work with zero
configuration. Tailnet traffic is recorded as `clientScope: "tailnet"`.

**A valid key still wins, even from a trusted scope.** An agent that *does* send
its key is attributed to that app (`authApp: "cline"`), not to `tailnet`; a
keyless tailnet client falls back to `authApp: "tailnet"`. So you get per-app
attribution wherever the agent supports keys, and keyless fallback where it
doesn't. Set `auth.trustTailnet: false` to demand keys from tailnet clients too.

**Tailnet detection cannot be spoofed.** `clientScope: "tailnet"` requires BOTH
ends of the TCP connection to sit in `100.64.0.0/10` — i.e. the request must
arrive on this machine's own Tailscale address (the utun interface). That range
is shared with carrier-grade NAT, so a real internet client behind a CGN could
also present a `100.64.x` source address; such a client arrives on the LAN/WAN
interface (local address `192.168.0.100` or the WAN IP) and is correctly
classified `public`, never trusted.

> **Once your agents are tailnet nodes, you can delete the router's 11434
> forward entirely** and still reach Ollama from anywhere. That *removes* the
> public exposure instead of merely authenticating it — strictly better than
> keeping the forward open with keys.

**Scope cannot be spoofed.** `clientScope` is derived from `req.socket.remoteAddress`
— the real TCP source — never from a header. `X-Forwarded-For` is *stored* for
logging (`forwardedFor`) but is not consulted for the auth decision, so an
internet client cannot pretend to be a LAN client by sending a private IP in XFF.

**Per-app keys give attribution, not just authorisation.** Each successful
request records `authApp` (the key's name) in Mongo, so you can see *which app*
did what. Rejections record `reason: "missing api key"` vs `"invalid api key"`.
The key value itself is never logged or stored.

Managing keys — all hot-reload, no restart:

```bash
# add / rename / revoke a key (revoking = delete its entry)
node -e 'const fs=require("fs"),p=process.env.HOME+"/.ollama-proxy/config.json";
  const c=JSON.parse(fs.readFileSync(p,"utf8"));
  c.auth.keys["my-new-app"]="opk_"+require("crypto").randomBytes(24).toString("base64url");
  fs.writeFileSync(p,JSON.stringify(c,null,2)+"\n");console.log("keys:",Object.keys(c.auth.keys))'
# any request then triggers the hot-reload, or restart:
kill -TERM $(pgrep -f '\.ollama-proxy/proxy.js')   # launchd relaunches in ~1s
```

Behaviour notes:
- If a mode requires keys but none are configured, the proxy **fails closed**
  (`401`, logged as `AUTHMISCONFIGURED`) rather than open.
- The legacy single `"apiKey"` field still works; it is treated as a key named
  `legacy`.
- Verified 2026-09-13 with four keys (`cline`, `codex`, `agent3`, `agent4`):
  each key → 200; revoked/legacy key values → **401**; no key → 401;
  `X-Api-Key` variant → 200; `authApp` recorded correctly as `cline` / `codex`.
  External nodes (IR/JP/UA) without a key get **401** while loopback/LAN keep
  200, and real inference works over both `/api/chat` and `/v1/chat/completions`.
  Note: testing keys requires `mode: "always"` on a scratch instance — under
  `public-only` the LAN address is auth-exempt, so key tests there prove nothing.
- ✅ **The ollama CLI now works through this proxy** (fixed 2026-09-13). Two
  separate bugs had been blocking it, and both are fixed:
  1. **`GET /` health check** — the CLI probes `/` first and treats a non-200 as
     "server not running", refusing to proceed. The proxy's `default:` case
     returned 403 for it (this is what the historical `BLOCK GET /` entries
     since 2026-09-07 were). Now answered with `Ollama is running`, exactly like
     real Ollama, revealing no version and no models — and still behind auth, so
     internet scanners get 401.
  2. **Legacy `name` field** — the CLI sends `POST /api/show` with
     `{"model":"","name":"gemma4:12b"}`, i.e. an *empty* `model` plus the
     legacy `name`. The proxy only read `model`, so every CLI `ollama show`
     got a spurious `404 model not found`. Model resolution now accepts
     `model || name`, and both fields are rewritten to the real name when
     forwarding. The log records `legacyNameField: true` when this happens.
     Any older SDK still using `name` benefits too.

  Verified against the live proxy via the LAN/WAN address with a key:
  `GET /` → 200, `ollama list` / `ps` / `show` (all 5 models) / `run` → OK.

## How it starts on boot

The proxy is owned by the `com.botboy.ollama-proxy` system LaunchDaemon
(`/Library/LaunchDaemons/com.botboy.ollama-proxy.plist`, installed from the
plist in this directory by `install-daemon.sh`). It starts at BOOT with no
login required, and `KeepAlive` restarts it if it crashes. The chatbot's boot
script (`~/chatbot/start-chatbot.sh`) does NOT start the proxy -- the proxy is
a fully independent service and survives chatbot restarts.

```bash
tail -f ~/.ollama-proxy/proxy.log                 # logs
pgrep -fl 'ollama-proxy/proxy.js'                 # is it running?
launchctl print system/com.botboy.ollama-proxy    # launchd state
sudo launchctl kickstart -k system/com.botboy.ollama-proxy   # restart it
```

To change startup behavior, edit `com.botboy.ollama-proxy.daemon.plist` in this
directory and re-run `sudo ~/.ollama-proxy/install-daemon.sh` (kickstart alone
won't pick up plist changes).

If you upgrade Node via nvm, re-point the symlink:
`ln -sf ~/.nvm/versions/node/<new>/bin/node ~/.ollama-proxy/node`

## What the proxy enforces

- `/api/tags`, `/api/ps`, `/v1/models` pass through **real** Ollama metadata,
  filtered to the exposed models (real names, sizes, quantization). Synthetic
  alias-only payloads are used only while Ollama itself is unreachable.
- Every **native** model request (`/api/chat`, `/api/generate`, `/api/embed*`)
  gets `options.num_ctx` forced to `numCtx` from `config.json` (default 8192).
  This neutralizes both oversized `num_ctx` (huge KV caches, reloads, evictions)
  and omitted `num_ctx` (Ollama would fall back to its `OLLAMA_CONTEXT_LENGTH`
  default, which churns the resident models whenever that default differs).
- ⚠️ **The OpenAI-compatible routes are the exception.** Ollama's
  `/v1/chat/completions`, `/v1/completions` and `/v1/embeddings` ignore the
  `options` object entirely (`options` is not a supported request field — the
  OpenAI API has no way to set context size), so `numCtx` CANNOT be enforced
  there. Those requests load the model at Ollama's own `OLLAMA_CONTEXT_LENGTH`
  default, NOT at `numCtx`.
  - Currently harmless: `com.ollama.ollama.plist` sets
    `OLLAMA_CONTEXT_LENGTH=8192`, matching `numCtx` here and the chatbot's
    `OLLAMA_NUM_CTX=8192`, so all three paths agree and nothing churns.
    Verified 2026-09-13 — a `/v1/chat/completions` call carrying no `num_ctx`
    loaded `qwen2.5-coder:1.5b` at CONTEXT 8192.
  - The agreement is implicit, so keep those values equal. If
    `OLLAMA_CONTEXT_LENGTH` ever drops below `numCtx`, an OpenAI-compatible
    remote client and the chatbot will reload the same model at different
    contexts — visible as `ollama ps` CONTEXT flipping between the two values,
    and as slow or hung replies.
  - ⚠️ Editing the plist alone does nothing: the daemon must be restarted
    (`launchctl bootout` / `bootstrap`) or the RUNNING process keeps its old
    environment. Confirm what the live process actually has with
    `ps eww -p $(pgrep -f 'ollama serve') | tr ' ' '\n' | grep OLLAMA` — the file
    on disk and the running env can disagree, and only the running env matters.
  - Alternatively expose a `PARAMETER num_ctx 8192` Modelfile variant
    (`ollama create`) so OpenAI-compatible clients can pin it explicitly.
- Requests must be for an exposed model name (the `models` map in `config.json`);
  anything else gets `404 model not found`. With identity aliases the real names
  are used as-is.
- The `model` field in all responses (including streaming NDJSON and OpenAI SSE
  chunks) is rewritten back to the alias.
- The `numCtx` value in `config.json` hot-reloads along with the `models` map —
  no restart needed.
- `/api/show` is proxied but the `modelfile` (contains the real name) and
  `license` fields are stripped.
- Management endpoints (`/api/pull`, `/api/push`, `/api/delete`, `/api/copy`,
  `/api/create`, `/api/blobs`) and every other path are blocked (`403`).
- Supported endpoints: `/api/chat`, `/api/generate`, `/api/embed`,
  `/api/embeddings`, `/api/show`, `/api/tags`, `/api/ps`, `/api/version`,
  `/v1/models`, `/v1/chat/completions`, `/v1/completions`, `/v1/embeddings`.

## Request logging to MongoDB (optional)

Because the proxy is reachable from the internet, every request can be recorded
to MongoDB for later forensics ("who hit me, from where, with what prompt").
Enabled by default in this install.

```jsonc
"logging": {
  "mongo": {
    "enabled": true,
    "uri": "mongodb://127.0.0.1:27017",
    "db": "chatbot",           // shared with the chatbot app
    "collection": "ollamaProxyRequests",
    "ttlDays": 30              // OPTIONAL - NOT set in this install; omit = keep forever
  }
}
```

> This install currently has logging **enabled** but `ttlDays` **unset**, so
> documents are retained indefinitely. See the growth guard below.

- **One document per request**, written on response finish (or on client
  disconnect), so successful *and* blocked *and* aborted requests all appear.
- Records: client IP + scope (`loopback`/`private`/`public`), port, user-agent,
  referer, `X-Forwarded-For`, host header, method, route, status, duration,
  bytes out, outcome, requested/real model, alias, and the **incoming messages**
  (plus `clientOptions` and `appliedNumCtx`, so `num_ctx` churn is visible).
- Outcome values: `ok`, `reject` (model not exposed), `block` (route not
  allowed / destructive), `unauthorized`, `bad_json`, `config_error`, `aborted`.
- Writes are **batched** (flushed every 2 s or at 100 docs) and flushed on
  SIGTERM/SIGINT before exit — verified: a request followed by an immediate
  `kill -TERM` still lands.
- Indexes created automatically: `{ts:-1}`, `{clientIp:1,ts:-1}`,
  `{route:1,ts:-1}`, plus `{ts:1}` with `expireAfterSeconds` when `ttlDays` is set.

**Fails open — logging can never break the proxy.** Verified with the Mongo
instance pointed at a dead port and with `node_modules/` deleted entirely: the
proxy logged one warning and kept serving inference normally (200s, unchanged
latency). Recovering needs no restart — fix `uri` in `config.json` and the
hot-reload reconnects.

**Nothing sensitive is stored.** Authorization headers and attempted API keys
are never recorded; `messages` are capped per-message and in total; base64
`images` are replaced with a size placeholder. A 950 KB request body was
recorded as 8.3 KB.

⚠️ **Growth guard.** This port is internet-exposed, so a scanner can grow the
collection without bound. `ttlDays` is off by default, so **nothing is deleted
silently** — set it deliberately. Changing it hot-reloads via `collMod`, so no
restart is needed and no `IndexOptionsConflict`.

Useful queries:

```js
use chatbot
// who is hitting me from the internet, and what did they ask for?
db.ollamaProxyRequests.find({ clientScope: "public" })
  .sort({ ts: -1 }).limit(20)
  .pretty()
// anything rejected or blocked (attack / misconfigured-client surface)
db.ollamaProxyRequests.find({ outcome: { $ne: "ok" } }).sort({ ts: -1 }).limit(20)
// context churn: what clients ask for vs what the proxy applies
db.ollamaProxyRequests.find(
  { appliedNumCtx: { $exists: true } },
  { clientIp: 1, realModel: 1, "clientOptions.num_ctx": 1, appliedNumCtx: 1, ts: 1 }
).sort({ ts: -1 }).limit(20)
// slowest requests (stalls, evictions, reloads)
db.ollamaProxyRequests.find().sort({ ms: -1 }).limit(10)
```

