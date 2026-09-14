# linux-web-audio
#
# This repository does not contain the capture library. That is a separate
# GPL-3.0 project the user installs, and cgo finds it with pkg-config.
# `make check-lib` explains how to install it if it is missing.

SHELL := /bin/bash

BIN_DIR := bin
PREFIX  ?= $(HOME)/.local

GO         ?= go
BUILD_TYPE ?= Release

CAPTURE_REPO := https://github.com/lovemilk2333/linux-web-audio-capture

.PHONY: all build check-lib test run fmt vet install clean help

all: build

## check-lib: verify the capture library is installed and findable by pkg-config
check-lib:
	@if ! pkg-config --exists webacapture; then \
		echo "error: libwebaudio is not installed, or pkg-config cannot find it."; \
		echo; \
		echo "It is a separate project, not part of this repository:"; \
		echo; \
		echo "    git clone $(CAPTURE_REPO)"; \
		echo "    cd linux-web-audio-capture"; \
		echo "    cmake -S . -B build -G Ninja -DCMAKE_BUILD_TYPE=$(BUILD_TYPE)"; \
		echo "    cmake --build build"; \
		echo "    cmake --install build --prefix $(PREFIX)"; \
		echo; \
		echo "A user-local install ($(PREFIX)) also needs, in this shell:"; \
		echo; \
		echo "    export PKG_CONFIG_PATH=$(PREFIX)/lib/pkgconfig"; \
		echo "    export LD_LIBRARY_PATH=$(PREFIX)/lib"; \
		echo; \
		exit 1; \
	fi
	@echo "capture library: $$(pkg-config --modversion webacapture)"

## build: build the binaries
build: check-lib
	@mkdir -p $(BIN_DIR)
	$(GO) build -o $(BIN_DIR)/webaudiod ./cmd/webaudiod
	$(GO) build -o $(BIN_DIR)/webclient  ./cmd/webclient
	@echo "built $(BIN_DIR)/webaudiod and $(BIN_DIR)/webclient"

## test: run the Go tests
test: check-lib
	$(GO) test ./...

## run: build and start the server
run: build
	$(BIN_DIR)/webaudiod

## fmt: format the Go sources
fmt:
	$(GO) fmt ./...

## vet: vet the sources
vet: check-lib
	$(GO) vet ./...

## install: install the binaries
install: build
	install -Dm755 $(BIN_DIR)/webaudiod $(DESTDIR)$(PREFIX)/bin/webaudiod
	install -Dm755 $(BIN_DIR)/webclient  $(DESTDIR)$(PREFIX)/bin/webclient

## clean: remove build outputs
clean:
	rm -rf $(BIN_DIR)

## help: list the targets
help:
	@grep -E '^## ' $(MAKEFILE_LIST) | sed 's/## /  /'
