package main

import (
	"encoding/binary"
	"fmt"
	"io"
	"os"
)

// wavWriter streams 32-bit float PCM into a WAV file.
//
// The size fields are written as placeholders and patched in Close, which is
// how a WAV can be produced from a stream whose length is not known up front.
type wavWriter struct {
	file        *os.File
	dataBytes   uint32
	sampleRate  int
	channels    int
	headerBytes int64
}

func newWavWriter(path string, sampleRate, channels int) (*wavWriter, error) {
	file, err := os.Create(path)
	if err != nil {
		return nil, err
	}

	w := &wavWriter{file: file, sampleRate: sampleRate, channels: channels}

	bits := uint16(32)
	blockAlign := uint16(channels * 4)
	byteRate := uint32(sampleRate * channels * 4)

	// The literal tags interleave with the numeric fields, so each is written
	// with the call that suits it: binary.Write cannot encode a string.
	writeTag := func(tag string) error {
		_, err := io.WriteString(file, tag)
		return err
	}

	if err := writeTag("RIFF"); err != nil {
		file.Close()
		return nil, err
	}
	if err := writeLE(file, uint32(0)); err != nil { // patched in Close
		file.Close()
		return nil, err
	}
	if err := writeTag("WAVEfmt "); err != nil {
		file.Close()
		return nil, err
	}
	for _, v := range []any{
		uint32(16), // fmt chunk size
		uint16(3),  // format 3 = IEEE float
		uint16(channels),
		uint32(sampleRate),
		byteRate,
		blockAlign,
		bits,
	} {
		if err := writeLE(file, v); err != nil {
			file.Close()
			return nil, err
		}
	}
	if err := writeTag("data"); err != nil {
		file.Close()
		return nil, err
	}
	if err := writeLE(file, uint32(0)); err != nil { // patched in Close
		file.Close()
		return nil, err
	}

	w.headerBytes = 44
	return w, nil
}

func writeLE(w io.Writer, v any) error {
	return binary.Write(w, binary.LittleEndian, v)
}

// WriteFloat32 appends interleaved float samples.
func (w *wavWriter) WriteFloat32(samples []float32) error {
	if err := binary.Write(w.file, binary.LittleEndian, samples); err != nil {
		return err
	}
	w.dataBytes += uint32(len(samples) * 4)
	return nil
}

// Close patches the RIFF and data sizes and closes the file.
func (w *wavWriter) Close() error {
	if _, err := w.file.Seek(4, io.SeekStart); err != nil {
		w.file.Close()
		return err
	}
	if err := writeLE(w.file, 36+w.dataBytes); err != nil {
		w.file.Close()
		return err
	}
	if _, err := w.file.Seek(w.headerBytes-4, io.SeekStart); err != nil {
		w.file.Close()
		return err
	}
	if err := writeLE(w.file, w.dataBytes); err != nil {
		w.file.Close()
		return err
	}

	if err := w.file.Close(); err != nil {
		return err
	}
	seconds := float64(w.dataBytes) / float64(w.sampleRate*w.channels*4)
	fmt.Printf("wrote %s: %.3f s of audio, %d bytes\n", w.file.Name(), seconds, w.dataBytes)
	return nil
}
