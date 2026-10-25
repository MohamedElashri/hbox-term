# hbox-term development tasks. `make` lists them.

CARGO_MANIFEST := --manifest-path src-tauri/Cargo.toml
DEBUG_BINARY := src-tauri/target/debug/hbox-term
RELEASE_BINARY := src-tauri/target/release/hbox-term

.DEFAULT_GOAL := help
.PHONY: help install dev build build-debug run run-release check test test-ts test-rust lint fmt fmt-check bench clean

help: ## List the targets
	@grep -E '^[a-z-]+:.*## ' $(MAKEFILE_LIST) | awk -F ':.*## ' '{printf "  \033[36m%-12s\033[0m %s\n", $$1, $$2}'

node_modules: package-lock.json
	npm ci
	@touch node_modules

install: node_modules ## Install JavaScript dependencies (npm ci)

dev: node_modules ## Run the app with hot reload (tauri dev)
	npm run tauri dev

build: node_modules ## Release bundles for this OS (.deb/.rpm/.AppImage or .app/.dmg)
	npm run tauri build

build-debug: node_modules ## Debug binary with the frontend embedded, no bundles
	npm run tauri build -- --debug --no-bundle

run: build-debug ## Build and start the debug binary
	$(DEBUG_BINARY)

run-release: node_modules ## Build and start an optimized binary, e.g. for bench/throughput.sh
	npm run tauri build -- --no-bundle
	$(RELEASE_BINARY)

check: node_modules ## Type-check and build the frontend, cargo check the backend
	npm run check

test: test-ts test-rust ## Run all tests

test-ts: node_modules ## Frontend tests (node --test)
	node --test tests/

test-rust: ## Backend tests (cargo test)
	cargo test $(CARGO_MANIFEST) --lib

lint: node_modules ## TypeScript type check and clippy
	npx tsc --noEmit
	cargo clippy $(CARGO_MANIFEST)

fmt: ## Format the Rust code
	cargo fmt $(CARGO_MANIFEST)

fmt-check: ## Check formatting of the Rust code
	cargo fmt $(CARGO_MANIFEST) --check

bench: ## Output throughput benchmark; run it inside hbox-term and another terminal
	bench/throughput.sh

clean: ## Remove build output (frontend dist and Rust target)
	rm -rf dist
	cargo clean $(CARGO_MANIFEST)
