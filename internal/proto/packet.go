// SPDX-License-Identifier: BSD-3-Clause

// Package proto implements the wire format streamed over HTTP: a fixed 16-byte
// header followed by one encoded audio packet.
//
// Layout (all integers big-endian):
//
//	offset  size  field
//	 0       4    magic "WEBU"
//	 4       1    version
//	 5       1    flags
//	 6       2    seq       uint16
//	 8       4    timestamp uint32, in samples at the stream's sample rate
//	12       4    payload length
//	16       N    payload
//
// Both seq and timestamp wrap around. Comparisons must use the helpers here
// rather than the raw operators.
package proto

import (
	"encoding/binary"
	"errors"
	"fmt"
)

const (
	// Magic identifies the stream. It is the ASCII string "WEBU".
	Magic = 0x57454255
	// Version is the current wire format version.
	Version = 1
	// HeaderSize is the fixed size of the packet header in bytes.
	HeaderSize = 16
	// MaxPayload caps what Unmarshal will accept, so a corrupt length field
	// cannot make a client allocate without bound.
	MaxPayload = 1 << 20
)

// Header flags.
const (
	// FlagDiscontinuity marks a gap: packets were dropped before this one.
	FlagDiscontinuity uint8 = 1 << 0
	// FlagSilence marks a frame of synthesized silence.
	FlagSilence uint8 = 1 << 1
	// FlagUnderrun marks a frame the capture source failed to deliver in time.
	FlagUnderrun uint8 = 1 << 2
	// FlagCatchup marks a packet replayed from history rather than sent live.
	FlagCatchup uint8 = 1 << 3
)

// ErrShortBuffer is returned when a buffer is too small for the header.
var ErrShortBuffer = errors.New("proto: buffer shorter than the header")

// Header is the decoded packet header.
type Header struct {
	Version   uint8
	Flags     uint8
	Seq       uint16
	Timestamp uint32
	Length    uint32
}

// String renders the header for logs.
func (h Header) String() string {
	return fmt.Sprintf("seq=%d ts=%d len=%d flags=%s", h.Seq, h.Timestamp, h.Length, FlagsString(h.Flags))
}

// FlagsString renders a flag set as a comma-separated list.
func FlagsString(flags uint8) string {
	if flags == 0 {
		return "-"
	}
	var out []byte
	appendFlag := func(flag uint8, name string) {
		if flags&flag == 0 {
			return
		}
		if len(out) > 0 {
			out = append(out, ',')
		}
		out = append(out, name...)
	}
	appendFlag(FlagDiscontinuity, "discontinuity")
	appendFlag(FlagSilence, "silence")
	appendFlag(FlagUnderrun, "underrun")
	appendFlag(FlagCatchup, "catchup")
	return string(out)
}

// AppendHeader writes h into dst, which must be at least HeaderSize long.
func AppendHeader(dst []byte, h Header) {
	_ = dst[HeaderSize-1] // bounds check hint
	binary.BigEndian.PutUint32(dst[0:4], Magic)
	dst[4] = h.Version
	dst[5] = h.Flags
	binary.BigEndian.PutUint16(dst[6:8], h.Seq)
	binary.BigEndian.PutUint32(dst[8:12], h.Timestamp)
	binary.BigEndian.PutUint32(dst[12:16], h.Length)
}

// Marshal encodes a complete packet: header plus payload.
func Marshal(h Header, payload []byte) []byte {
	h.Version = Version
	h.Length = uint32(len(payload))
	buf := make([]byte, HeaderSize+len(payload))
	AppendHeader(buf, h)
	copy(buf[HeaderSize:], payload)
	return buf
}

// AppendPacket appends a whole packet to dst, growing it as needed. It is the
// allocation-light form used by the streaming handlers.
func AppendPacket(dst []byte, h Header, payload []byte) []byte {
	var scratch [HeaderSize]byte
	AppendHeader(scratch[:], Header{
		Version:   Version,
		Flags:     h.Flags,
		Seq:       h.Seq,
		Timestamp: h.Timestamp,
		Length:    uint32(len(payload)),
	})
	dst = append(dst, scratch[:]...)
	return append(dst, payload...)
}

// UnmarshalHeader decodes the header at the start of buf.
func UnmarshalHeader(buf []byte) (Header, error) {
	if len(buf) < HeaderSize {
		return Header{}, ErrShortBuffer
	}
	if binary.BigEndian.Uint32(buf[0:4]) != Magic {
		return Header{}, errors.New("proto: bad magic")
	}
	h := Header{
		Version:   buf[4],
		Flags:     buf[5],
		Seq:       binary.BigEndian.Uint16(buf[6:8]),
		Timestamp: binary.BigEndian.Uint32(buf[8:12]),
		Length:    binary.BigEndian.Uint32(buf[12:16]),
	}
	if h.Version != Version {
		return h, fmt.Errorf("proto: unsupported version %d", h.Version)
	}
	if h.Length > MaxPayload {
		return h, fmt.Errorf("proto: payload length %d exceeds the %d byte limit", h.Length, MaxPayload)
	}
	return h, nil
}

// Unmarshal decodes a complete packet, returning the header and payload. The
// payload aliases buf.
func Unmarshal(buf []byte) (Header, []byte, error) {
	h, err := UnmarshalHeader(buf)
	if err != nil {
		return h, nil, err
	}
	if uint32(len(buf)-HeaderSize) < h.Length {
		return h, nil, fmt.Errorf("proto: buffer holds %d payload bytes, header claims %d",
			len(buf)-HeaderSize, h.Length)
	}
	return h, buf[HeaderSize : HeaderSize+int(h.Length)], nil
}

/* Sequence arithmetic. The sequence number is 16 bits and wraps, so it must be
 * compared as a distance on a circle rather than as an integer. */

// SeqDistance returns how many steps forward from a to b, assuming the two are
// less than half the sequence space apart. Natural uint16 overflow does the
// wrapping, so 65535 -> 0 reports a distance of 1.
func SeqDistance(from, to uint16) uint16 {
	return to - from
}

// SeqDiff returns the signed shortest distance from a to b, in
// [-32768, 32767]. Positive means b is ahead of a.
func SeqDiff(from, to uint16) int32 {
	return int32(int16(to - from))
}

// SeqAhead reports whether a is strictly ahead of b.
func SeqAhead(a, b uint16) bool {
	return SeqDiff(b, a) > 0
}

// SeqInWindow reports whether seq lies in the inclusive window [oldest, current],
// advancing forward from oldest.
func SeqInWindow(seq, oldest, current uint16) bool {
	return SeqDiff(oldest, seq) >= 0 && SeqDiff(seq, current) >= 0
}
