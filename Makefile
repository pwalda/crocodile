# Crocodile build & packaging.
#
# Common targets:
#   make build        # debug build of the whole workspace
#   make release      # optimized build of all binaries + examples
#   make test         # run the workspace test suite
#   make lint         # clippy with warnings-as-errors
#   make check        # fmt-check + lint + test (the pre-commit gate)
#   make dist         # produce a distributable bundle in ./dist
#   make run-server   # run the coordination server (needs DATABASE_URL)
#   make run-gui      # run the desktop GUI
#   make db-up/db-down# start / stop the dev Postgres via docker compose
#   make clean

CARGO ?= cargo
DIST  := dist

# The workspace binaries we ship.
BINS      := crocodile-server crocodile-gui
EXAMPLES  := two_peer_call group_call

.PHONY: build release test lint fmt fmt-check check dist run-server run-gui \
        db-up db-down clean

build:
	$(CARGO) build --workspace

release:
	$(CARGO) build --release --workspace --bins
	$(CARGO) build --release --examples

test:
	$(CARGO) test --workspace

lint:
	$(CARGO) clippy --all-targets -- -D warnings

fmt:
	$(CARGO) fmt

fmt-check:
	$(CARGO) fmt --check

# The gate we expect to be green before every commit.
check: fmt-check lint test

# Assemble a distributable bundle: the binaries, examples, README,
# architecture doc, and docker-compose for the dev database.
dist: release
	@rm -rf $(DIST)
	@mkdir -p $(DIST)/bin
	@for b in $(BINS); do cp target/release/$$b $(DIST)/bin/; done
	@for e in $(EXAMPLES); do cp target/release/examples/$$e $(DIST)/bin/; done
	@cp README.md ARCHITECTURE.md docker-compose.yml $(DIST)/
	@cp crates/server/Dockerfile $(DIST)/server.Dockerfile
	@echo "Bundle assembled in ./$(DIST)"
	@ls -lh $(DIST)/bin

run-server:
	DATABASE_URL=$${DATABASE_URL:-postgres://crocodile:crocodile_dev@localhost:5432/crocodile} \
	BIND_ADDR=$${BIND_ADDR:-0.0.0.0:8080} \
	$(CARGO) run --release --bin crocodile-server

run-gui:
	$(CARGO) run --release --bin crocodile-gui

db-up:
	docker compose up -d

db-down:
	docker compose down

clean:
	$(CARGO) clean
	rm -rf $(DIST)
