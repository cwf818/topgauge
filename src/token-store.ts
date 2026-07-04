// Compatibility shim: token-store responsibilities now live in
// src/status-store.ts. Keep this file as a narrow re-export surface so
// existing imports and tests continue to compile during the refactor.

export {
  appendSample,
  projectHash,
  readAllSamples,
  readSamples,
  resetStateRoot,
  sampleFilePath,
  setStateRoot,
  stateRoot,
} from "./status-store.ts";
