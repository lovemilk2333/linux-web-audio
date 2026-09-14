package proto

import (
	"bytes"
	"encoding/binary"
	"testing"
)

func TestMarshalRoundTrip(t *testing.T) {
	payload := []byte{1, 2, 3, 4, 5}
	raw := Marshal(Header{Flags: FlagSilence, Seq: 4242, Timestamp: 960_000}, payload)

	if len(raw) != HeaderSize+len(payload) {
		t.Fatalf("packet length = %d, want %d", len(raw), HeaderSize+len(payload))
	}

	h, got, err := Unmarshal(raw)
	if err != nil {
		t.Fatalf("Unmarshal: %v", err)
	}
	if h.Seq != 4242 {
		t.Errorf("Seq = %d, want 4242", h.Seq)
	}
	if h.Timestamp != 960_000 {
		t.Errorf("Timestamp = %d, want 960000", h.Timestamp)
	}
	if h.Flags != FlagSilence {
		t.Errorf("Flags = %d, want %d", h.Flags, FlagSilence)
	}
	if h.Version != Version {
		t.Errorf("Version = %d, want %d", h.Version, Version)
	}
	if !bytes.Equal(got, payload) {
		t.Errorf("payload = %v, want %v", got, payload)
	}
}

func TestMagicIsWSAU(t *testing.T) {
	raw := Marshal(Header{}, nil)
	if string(raw[0:4]) != "WSAU" {
		t.Errorf("magic bytes = %q, want %q", raw[0:4], "WSAU")
	}
	// The constant has to agree with the bytes actually written.
	if binary.BigEndian.Uint32(raw[0:4]) != Magic {
		t.Errorf("Magic constant does not match the emitted bytes")
	}
}

func TestUnmarshalRejectsBadInput(t *testing.T) {
	tests := []struct {
		name string
		buf  []byte
	}{
		{"empty", nil},
		{"short header", make([]byte, HeaderSize-1)},
		{"bad magic", func() []byte {
			b := Marshal(Header{}, nil)
			b[0] = 'X'
			return b
		}()},
		{"bad version", func() []byte {
			b := Marshal(Header{}, nil)
			b[4] = Version + 1
			return b
		}()},
		{"truncated payload", func() []byte {
			b := Marshal(Header{}, []byte{1, 2, 3, 4})
			return b[:HeaderSize+2]
		}()},
		{"absurd length", func() []byte {
			b := Marshal(Header{}, nil)
			binary.BigEndian.PutUint32(b[12:16], MaxPayload+1)
			return b
		}()},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			if _, _, err := Unmarshal(tc.buf); err == nil {
				t.Fatal("expected an error, got nil")
			}
		})
	}
}

// The sequence number is 16 bits wide, so everything that compares it has to
// cope with wraparound rather than treating it as an integer.
func TestSeqWraparound(t *testing.T) {
	if got := SeqDistance(65535, 0); got != 1 {
		t.Errorf("SeqDistance(65535, 0) = %d, want 1", got)
	}
	if got := SeqDistance(65534, 1); got != 3 {
		t.Errorf("SeqDistance(65534, 1) = %d, want 3", got)
	}
	if got := SeqDiff(65535, 0); got != 1 {
		t.Errorf("SeqDiff(65535, 0) = %d, want 1", got)
	}
	if got := SeqDiff(0, 65535); got != -1 {
		t.Errorf("SeqDiff(0, 65535) = %d, want -1", got)
	}

	if !SeqAhead(0, 65535) {
		t.Error("SeqAhead(0, 65535) = false, want true: 0 follows 65535")
	}
	if SeqAhead(65535, 0) {
		t.Error("SeqAhead(65535, 0) = true, want false")
	}
}

func TestSeqInWindow(t *testing.T) {
	tests := []struct {
		name                 string
		seq, oldest, current uint16
		want                 bool
	}{
		{"inside", 100, 50, 150, true},
		{"at oldest", 50, 50, 150, true},
		{"at current", 150, 50, 150, true},
		{"before oldest", 49, 50, 150, false},
		{"after current", 151, 50, 150, false},
		{"spanning the wrap", 5, 65500, 10, true},
		{"spanning the wrap, before", 65499, 65500, 10, false},
		{"spanning the wrap, after", 11, 65500, 10, false},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			if got := SeqInWindow(tc.seq, tc.oldest, tc.current); got != tc.want {
				t.Errorf("SeqInWindow(%d, %d, %d) = %v, want %v",
					tc.seq, tc.oldest, tc.current, got, tc.want)
			}
		})
	}
}

func TestAppendPacketMatchesMarshal(t *testing.T) {
	h := Header{Flags: FlagCatchup, Seq: 7, Timestamp: 100}
	payload := []byte{9, 8, 7}

	want := Marshal(h, payload)
	got := AppendPacket([]byte{0xAA, 0xBB}, h, payload)
	if !bytes.Equal(got[2:], want) {
		t.Errorf("AppendPacket did not append the same bytes as Marshal")
	}
	if got[0] != 0xAA || got[1] != 0xBB {
		t.Errorf("AppendPacket disturbed the existing prefix: %v", got[:2])
	}
}
