// SPDX-License-Identifier: BSD-3-Clause

package server

import (
	"fmt"
	"net/http"
	"strings"
)

// exposedHeaders lists the response headers a cross-origin client needs to
// read. Browsers hide everything but a small safelist from JavaScript, and the
// resume path depends on reading the sequence range off a 416.
var exposedHeaders = strings.Join([]string{
	"X-Audio-Codec",
	"X-Audio-Codecs",
	"X-Audio-SampleRate",
	"X-Audio-Channels",
	"X-Audio-Frame-Samples",
	"X-Audio-Frame-Duration-Ms",
	"X-Audio-Header-Size",
	"X-Audio-Seq-Start",
	"X-Audio-Seq-Oldest",
	"X-Audio-Seq-Current",
}, ", ")

// corsPolicy decides which origins are allowed to call the API.
type corsPolicy struct {
	// allowAll is set by "*".
	allowAll bool
	// allowed is the explicit origin list, compared case-insensitively.
	allowed map[string]struct{}
	// configured records whether any origin was given at all, which is what
	// makes preflight respond rather than 405.
	configured bool
}

// ParseCORSOrigins parses a --cors value: a comma-separated origin list, or
// "*" to allow any. An empty string disables CORS entirely, which is the
// default because the server streams what the desktop is playing.
//
// Origins are validated because the two common mistakes — a trailing slash and
// a missing scheme — produce no visible error at all: the browser simply
// refuses the request and the page reports a network failure.
func ParseCORSOrigins(value string) ([]string, error) {
	var origins []string
	for raw := range strings.SplitSeq(value, ",") {
		origin := strings.TrimSpace(raw)
		if origin == "" {
			continue
		}
		if origin == "*" {
			origins = append(origins, origin)
			continue
		}
		if !strings.HasPrefix(origin, "http://") && !strings.HasPrefix(origin, "https://") {
			return nil, fmt.Errorf("origin %q needs a scheme, for example http://%s", origin, origin)
		}
		if strings.HasSuffix(origin, "/") {
			return nil, fmt.Errorf("origin %q must not end with a slash: an origin is scheme, host and port only",
				origin)
		}
		origins = append(origins, origin)
	}
	return origins, nil
}

func newCORSPolicy(origins []string) corsPolicy {
	policy := corsPolicy{allowed: map[string]struct{}{}}
	for _, origin := range origins {
		if origin == "*" {
			policy.allowAll = true
			policy.configured = true
			continue
		}
		policy.allowed[strings.ToLower(origin)] = struct{}{}
		policy.configured = true
	}
	return policy
}

// enabled reports whether any origin was configured.
func (p corsPolicy) enabled() bool { return p.configured }

// originFor returns the value to echo in Access-Control-Allow-Origin, or "" if
// the request's origin is not allowed.
//
// With "*" the wildcard is echoed rather than the request's origin. That is
// only valid because this API carries no cookies and relies on a bearer token
// instead: a wildcard cannot be combined with credentials.
func (p corsPolicy) originFor(requestOrigin string) string {
	if !p.configured || requestOrigin == "" {
		return ""
	}
	if p.allowAll {
		return "*"
	}
	if _, ok := p.allowed[strings.ToLower(requestOrigin)]; ok {
		return requestOrigin
	}
	return ""
}

// apply writes the CORS response headers for an allowed origin.
func (p corsPolicy) apply(w http.ResponseWriter, r *http.Request) bool {
	origin := p.originFor(r.Header.Get("Origin"))
	if origin == "" {
		return false
	}

	header := w.Header()
	header.Set("Access-Control-Allow-Origin", origin)
	// The response varies by origin, so caches must not serve one origin's
	// response to another. Not needed for the wildcard, which is constant.
	if origin != "*" {
		header.Add("Vary", "Origin")
	}
	header.Set("Access-Control-Allow-Headers", "Authorization, Content-Type")
	header.Set("Access-Control-Allow-Methods", "GET, OPTIONS")
	header.Set("Access-Control-Max-Age", "600")
	// Without this a browser hides every X-Audio-* header from the page, and
	// the resume path cannot read the sequence range off a 416.
	header.Set("Access-Control-Expose-Headers", exposedHeaders)
	return true
}

// withCORS wraps a handler, answering preflight requests and adding the
// headers to actual ones. A request from a disallowed origin is left to fail in
// the browser, which is the correct outcome: the server does not need to reveal
// whether the origin would have been accepted.
func (s *Server) withCORS(next http.Handler) http.Handler {
	if !s.cors.enabled() {
		return next
	}
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		allowed := s.cors.apply(w, r)

		if r.Method == http.MethodOptions {
			if !allowed {
				w.WriteHeader(http.StatusForbidden)
				return
			}
			w.WriteHeader(http.StatusNoContent)
			return
		}
		next.ServeHTTP(w, r)
	})
}
