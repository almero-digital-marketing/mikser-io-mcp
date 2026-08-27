// Re-export of mikser-io's own harness, which ships in the package
// (`mikser-io/testing/harness.js`) so every sibling plugin imports ONE
// copy instead of keeping its own.
//
// A copy drifts. This one had: it predated the `runtime.catalog` stub, so
// a plugin reading the catalog through the singleton — which is how every
// mikser-io import resolves it — saw `undefined` here and a populated
// catalog in the engine.
//
// This file stays so the importers in this folder resolve unchanged.
export * from 'mikser-io/testing/harness.js'
