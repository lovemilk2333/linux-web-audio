// SPDX-License-Identifier: BSD-3-Clause

package server

import (
	"fmt"
	"net"
	"net/http"
	"strings"
)

// ParseAllowedHosts splits a --allowed-hosts value into names.
//
// Validation happens where the policy is built, since that is where the listen
// address is known too.
func ParseAllowedHosts(value string) ([]string, error) {
	var hosts []string
	for name := range strings.SplitSeq(value, ",") {
		trimmed := strings.TrimSpace(name)
		if trimmed != "" {
			hosts = append(hosts, trimmed)
		}
	}
	return hosts, nil
}

// hostGuard rejects requests whose Host header names something this server is
// not reachable as.
//
// This is the defence against DNS rebinding, and it is the reason it exists
// rather than a blanket "require a token": binding to loopback keeps other
// machines out, but it does not keep out the *victim's own browser*. A page on
// attacker.example can flip its DNS to 127.0.0.1, at which point the browser
// sees one origin, skips CORS, and reads the stream. The one thing that gives
// it away is the Host header still naming attacker.example.
//
// So loopback requests keep working with no configuration, and a rebound one
// does not, without asking the user for a token they do not need locally.
type hostGuard struct {
	// allowAny disables the check, for a deployment whose Host cannot be
	// enumerated up front.
	allowAny bool
	allowed  map[string]struct{}
}

// NewHostGuard builds a policy from the address being listened on and any
// extra names the operator allows.
//
// A wildcard bind cannot enumerate what it will be reached as, so it only
// admits loopback plus the extras; anything else has to be named.
func NewHostGuard(listen string, extra []string) (hostGuard, error) {
	guard := hostGuard{allowed: map[string]struct{}{}}

	for _, name := range extra {
		trimmed := strings.TrimSpace(name)
		if trimmed == "" {
			continue
		}
		if trimmed == "*" {
			guard.allowAny = true
			continue
		}
		host := hostOnly(trimmed)
		if host == "" {
			return hostGuard{}, fmt.Errorf("invalid --allowed-hosts entry %q", name)
		}
		guard.allowed[host] = struct{}{}
	}

	// The address actually bound is obviously a name this server answers to.
	if host, _, err := net.SplitHostPort(listen); err == nil {
		if trimmed := hostOnly(host); trimmed != "" && !isWildcard(host) {
			guard.allowed[trimmed] = struct{}{}
		}
	}
	return guard, nil
}

// hostOnly lowercases a Host header or address and drops its port and any IPv6
// brackets, leaving the name to compare.
func hostOnly(hostport string) string {
	host := hostport
	if trimmed, _, err := net.SplitHostPort(hostport); err == nil {
		host = trimmed
	}
	return strings.Trim(strings.ToLower(strings.TrimSpace(host)), "[]")
}

func isWildcard(host string) bool {
	switch strings.TrimSpace(host) {
	case "", "0.0.0.0", "::", "[::]":
		return true
	}
	return false
}

// allows reports whether a Host header may be served.
func (g hostGuard) allows(hostport string) bool {
	if g.allowAny {
		return true
	}

	host := hostOnly(hostport)
	if host == "" {
		// HTTP/1.0 clients may omit Host entirely, and a missing one gives no
		// evidence either way. Refused, since the whole point is that a
		// rebound request is identified by the name it carries.
		return false
	}
	if _, ok := g.allowed[host]; ok {
		return true
	}
	// Loopback names are always this machine, whatever the operator bound to.
	if host == "localhost" {
		return true
	}
	if ip := net.ParseIP(host); ip != nil && ip.IsLoopback() {
		return true
	}
	return false
}

// middleware enforces the policy on every endpoint, including /healthz: a
// probe that reveals whether the service is up is still information.
func (s *Server) withHostGuard(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if s.hostGuard.allows(r.Host) {
			next.ServeHTTP(w, r)
			return
		}
		s.cfg.Log.Warn("refused a request whose Host is not served here",
			"host", r.Host, "remote", r.RemoteAddr, "path", r.URL.Path)
		writeJSONError(w, http.StatusBadRequest, fmt.Sprintf(
			"this server does not answer to %q. It serves loopback names and any host given to "+
				"--allowed-hosts; a request arriving under an unexpected name can be a DNS "+
				"rebinding attempt.", r.Host))
	})
}
