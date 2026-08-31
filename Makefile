NODE ?= node

.PHONY: all build test check deps-proof clean

all: build

## build: produce the runnable artifact at dist/shed.mjs
build:
	@$(NODE) tools/bundle.mjs

## test: run the standard-library test suite
test:
	@$(NODE) --test

## check: build, test, and prove the dependency manifest is empty
check: build test deps-proof

## deps-proof: regenerate the zero-dependency evidence file
deps-proof:
	@$(NODE) tools/deps-proof.mjs > deps-proof.txt
	@cat deps-proof.txt

clean:
	@rm -rf dist
