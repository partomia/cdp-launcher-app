.PHONY: dev build dmg clean test lint

# ── Development ───────────────────────────────────────────────────────────────
dev:
	cargo tauri dev

# ── Production build ──────────────────────────────────────────────────────────
build:
	cargo tauri build

# ── DMG packaging ─────────────────────────────────────────────────────────────
dmg: build
	@mkdir -p dist
	@APP_PATH=$$(find src-tauri/target/release/bundle/macos -name "*.app" 2>/dev/null | head -1); \
	if [ -z "$$APP_PATH" ]; then \
		echo "No .app bundle found — run 'make build' first"; exit 1; \
	fi; \
	hdiutil create -volname "CDP Launcher" \
		-srcfolder "$$APP_PATH" \
		-ov -format UDZO \
		dist/cdp-launcher.dmg && \
	echo "DMG created at dist/cdp-launcher.dmg"

# ── Clean ─────────────────────────────────────────────────────────────────────
clean:
	rm -rf target/ src-tauri/target/ dist/ node_modules/

# ── Tests ─────────────────────────────────────────────────────────────────────
test:
	cargo test --manifest-path src-tauri/Cargo.toml
	npm test

# ── Lint ──────────────────────────────────────────────────────────────────────
lint:
	cargo clippy --manifest-path src-tauri/Cargo.toml -- -D warnings
	npm run lint
	npm run format:check
