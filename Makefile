NODE ?= node

.PHONY: all build test check deps-proof clean

all: build

## build: produce the runnable artifact at dist/shed.mjs
build:
	@$(NODE) tools/bundle.mjs

## test: run the standard-library test suite
test:
	@$(NODE) --test

## check: build, test, prove zero deps, and verify the docs are intact
check: build test docs deps-proof

## docs: fail if a shipped document is empty or gutted
docs:
	@$(NODE) tools/check-docs.mjs

## deps-proof: regenerate the zero-dependency evidence file
deps-proof:
	@$(NODE) tools/deps-proof.mjs > deps-proof.txt
	@cat deps-proof.txt

clean:
	@rm -rf dist
