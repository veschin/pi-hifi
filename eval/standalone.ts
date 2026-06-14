// Standalone (no pi session) wiring for the pi-hifi engine: resolves models and
// credentials exactly the way pi does - AuthStorage (auth.json + env) and
// ModelRegistry - without ever touching key material here.

import { AuthStorage, ModelRegistry } from "@earendil-works/pi-coding-agent";
import type { ModelRegistryLike } from "../src/roles.ts";

export function createStandaloneRegistry(): ModelRegistryLike {
  const authStorage = AuthStorage.create();
  return ModelRegistry.create(authStorage);
}
