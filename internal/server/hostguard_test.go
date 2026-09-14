// SPDX-License-Identifier: BSD-3-Clause

package server

import "testing"

// TestHostGuardAllows covers the shapes a Host header actually arrives in.
// Getting one of these wrong is the difference between refusing a rebinding
// attempt and refusing the browser the user is holding.
func TestHostGuardAllows(t *testing.T) {
	tests := []struct {
		name    string
		listen  string
		extra   []string
		host    string
		allowed bool
	}{
		// The default bind: loopback only, and only loopback names.
		{"loopback bind, 127.0.0.1", "127.0.0.1:8642", nil, "127.0.0.1:8642", true},
		{"loopback bind, no port", "127.0.0.1:8642", nil, "127.0.0.1", true},
		{"loopback bind, localhost", "127.0.0.1:8642", nil, "localhost:8642", true},
		{"loopback bind, localhost no port", "127.0.0.1:8642", nil, "localhost", true},
		{"loopback bind, ipv6", "127.0.0.1:8642", nil, "[::1]:8642", true},
		{"loopback bind, 127.0.0.5", "127.0.0.1:8642", nil, "127.0.0.5:8642", true},
		{"loopback bind, case", "127.0.0.1:8642", nil, "LOCALHOST:8642", true},

		// The attack this exists for.
		{"rebinding attempt", "127.0.0.1:8642", nil, "attacker.example:8642", false},
		{"rebinding, no port", "127.0.0.1:8642", nil, "attacker.example", false},
		{"a public ip", "127.0.0.1:8642", nil, "203.0.113.9:8642", false},
		{"no host at all", "127.0.0.1:8642", nil, "", false},

		// A specific bind answers under its own name too.
		{"specific bind", "192.168.1.5:8642", nil, "192.168.1.5:8642", true},
		{"specific bind, unrelated", "192.168.1.5:8642", nil, "192.168.1.6:8642", false},

		// A wildcard bind cannot know its names, so they have to be given.
		{"wildcard bind, loopback still works", "0.0.0.0:8642", nil, "localhost:8642", true},
		{"wildcard bind, unnamed host", "0.0.0.0:8642", nil, "media.lan:8642", false},
		{"wildcard bind, named host", "0.0.0.0:8642", []string{"media.lan"}, "media.lan:8642", true},
		{"wildcard bind, named with port", "0.0.0.0:8642", []string{"media.lan:8642"}, "media.lan:8642", true},
		{"wildcard bind, named, wrong name", "0.0.0.0:8642", []string{"media.lan"}, "other.lan:8642", false},
		{"empty host means wildcard", ":8642", nil, "media.lan:8642", false},
		{"ipv6 wildcard", "[::]:8642", nil, "media.lan:8642", false},

		// The documented escape hatch.
		{"star allows anything", "127.0.0.1:8642", []string{"*"}, "attacker.example:8642", true},

		{"extra names are case-insensitive", "127.0.0.1:8642", []string{"MEDIA.LAN"}, "media.lan", true},
	}

	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			guard, err := NewHostGuard(tc.listen, tc.extra)
			if err != nil {
				t.Fatalf("NewHostGuard(%q, %v): %v", tc.listen, tc.extra, err)
			}
			if got := guard.allows(tc.host); got != tc.allowed {
				t.Errorf("allows(%q) = %v, want %v", tc.host, got, tc.allowed)
			}
		})
	}
}

func TestParseAllowedHosts(t *testing.T) {
	got, err := ParseAllowedHosts(" media.lan , localhost ,, media.lan ")
	if err != nil {
		t.Fatalf("ParseAllowedHosts: %v", err)
	}
	if len(got) != 3 {
		t.Errorf("got %v, want the blank entry dropped", got)
	}

	empty, err := ParseAllowedHosts("")
	if err != nil || len(empty) != 0 {
		t.Errorf("an empty value should give no hosts, got %v (err %v)", empty, err)
	}
}

// The guard is what stops a rebound request, so it has to refuse before the
// handler runs rather than merely log.
func TestHostGuardRefusesWithBadRequest(t *testing.T) {
	guard, err := NewHostGuard("127.0.0.1:8642", nil)
	if err != nil {
		t.Fatal(err)
	}
	if guard.allows("attacker.example") {
		t.Fatal("a foreign Host was allowed")
	}
	if !guard.allows("localhost") {
		t.Fatal("localhost was refused, which would break the default setup")
	}
}
