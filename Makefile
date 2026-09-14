# linux-ws-audio
#
# The Go binaries link the capture library, so the library has to exist before
# `go build` runs. Every target that compiles Go therefore depends on `lib`.

SHELL := /bin/bash

CAPTURE_DIR   := capture
CAPTURE_BUILD := $(CAPTURE_DIR)/build
CAPTURE_LIB   := $(CAPTURE_BUILD)/libwsaudio.so

BIN_DIR := bin
PREFIX  ?= /usr/local

GO      ?= go
CMAKE   ?= cmake
BUILD_TYPE ?= Release

CAPTURE_SOURCES := $(shell find $(CAPTURE_DIR)/src $(CAPTURE_DIR)/include \
                     $(CAPTURE_DIR)/CMakeLists.txt -type f 2>/dev/null)

.PHONY: all lib build build-lib test test-go test-lib run clean install fmt vet help

all: build

## lib: build the capture shared library from the submodule
lib: $(CAPTURE_LIB)

$(CAPTURE_LIB): $(CAPTURE_SOURCES)
	@if [ ! -f $(CAPTURE_DIR)/CMakeLists.txt ]; then \
		echo "error: the capture submodule is empty. Run:"; \
		echo "  git submodule update --init --recursive"; \
		exit 1; \
	fi
	$(CMAKE) -S $(CAPTURE_DIR) -B $(CAPTURE_BUILD) -G Ninja \
		-DCMAKE_BUILD_TYPE=$(BUILD_TYPE)
	$(CMAKE) --build $(CAPTURE_BUILD)

## build: build the Go binaries
build: lib
	@mkdir -p $(BIN_DIR)
	$(GO) build -o $(BIN_DIR)/wsaudiod ./cmd/wsaudiod
	$(GO) build -o $(BIN_DIR)/wsclient  ./cmd/wsclient
	@echo "built $(BIN_DIR)/wsaudiod and $(BIN_DIR)/wsclient"

## test: run every test, including the ones that need the capture library
test: test-lib test-go

## test-go: run the Go tests
test-go: lib
	$(GO) test ./...

## test-lib: run the capture library's own self test against the live audio server
test-lib: lib
	$(CAPTURE_BUILD)/wsaudio_selftest

## run: build and start the server
run: build
	$(BIN_DIR)/wsaudiod

## fmt: format the Go sources
fmt:
	$(GO) fmt ./...

## vet: vet the Go sources
vet: lib
	$(GO) vet ./...

## install: install the library, the headers and the server
install: build
	$(CMAKE) --install $(CAPTURE_BUILD) --prefix $(PREFIX)
	install -Dm755 $(BIN_DIR)/wsaudiod $(DESTDIR)$(PREFIX)/bin/wsaudiod
	install -Dm755 $(BIN_DIR)/wsclient  $(DESTDIR)$(PREFIX)/bin/wsclient

## clean: remove build outputs
clean:
	rm -rf $(BIN_DIR) $(CAPTURE_BUILD)

## help: list the targets
help:
	@grep -E '^## ' $(MAKEFILE_LIST) | sed 's/## /  /'
