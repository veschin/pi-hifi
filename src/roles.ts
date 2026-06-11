// Role -> (Model, auth) resolution. Provider-agnostic: a role bound to "session"
// uses whatever model the host pi session is running; explicit "<provider>/<id>"
// pins the role. Auth is always resolved through pi's ModelRegistry (auth.json,
// env vars) - this code never reads credentials itself.

import type { Api, Model } from "@earendil-works/pi-ai";
import type { ApodexConfig, RoleName } from "./types.ts";
import { DEFAULT_HEAVY_MODEL, SESSION_MODEL } from "./config.ts";

/** Minimal surface of pi's ModelRegistry that we depend on. */
export interface ModelRegistryLike {
  find(provider: string, modelId: string): Model<Api> | undefined;
  getApiKeyAndHeaders(
    model: Model<Api>,
  ): Promise<{ ok: true; apiKey?: string; headers?: Record<string, string> } | { ok: false; error: string }>;
}

export interface ResolvedRole {
  role: RoleName;
  model: Model<Api>;
  apiKey: string | undefined;
  headers: Record<string, string> | undefined;
}

export interface RoleResolverOptions {
  config: ApodexConfig;
  registry: ModelRegistryLike;
  /** Active session model, if running inside a pi session. */
  sessionModel?: Model<Api>;
}

export class RoleResolutionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RoleResolutionError";
  }
}

export class RoleResolver {
  private readonly config: ApodexConfig;
  private readonly registry: ModelRegistryLike;
  private readonly sessionModel: Model<Api> | undefined;
  private readonly cache = new Map<RoleName, ResolvedRole>();

  constructor(opts: RoleResolverOptions) {
    this.config = opts.config;
    this.registry = opts.registry;
    this.sessionModel = opts.sessionModel;
  }

  getRoleSpec(role: RoleName): ApodexConfig["roles"][RoleName] {
    return this.config.roles[role];
  }

  /**
   * Resolution order for a role:
   *   spec "provider/id"  -> that model (error if unknown or no key);
   *   spec "session"      -> session model, else DEFAULT_HEAVY_MODEL, else error.
   * A pinned model whose key is missing falls back to the session model with a
   * thrown error only when no fallback exists - silent degradation is forbidden,
   * so the fallback path is reported via the `fallbackNote` on the result.
   */
  async resolve(role: RoleName): Promise<ResolvedRole & { fallbackNote?: string }> {
    const cached = this.cache.get(role);
    if (cached) return cached;

    const spec = this.config.roles[role];
    let fallbackNote: string | undefined;

    let model: Model<Api> | undefined;
    if (spec.model === SESSION_MODEL) {
      model = this.sessionModel;
      if (!model) {
        const [provider, ...rest] = DEFAULT_HEAVY_MODEL.split("/");
        model = this.registry.find(provider as string, rest.join("/"));
        if (model) fallbackNote = `role ${role}: no session model; using default ${DEFAULT_HEAVY_MODEL}`;
      }
      if (!model) {
        throw new RoleResolutionError(
          `role ${role}: spec is "session" but no session model is active and default ${DEFAULT_HEAVY_MODEL} is unknown to the registry`,
        );
      }
    } else {
      const slash = spec.model.indexOf("/");
      const provider = spec.model.slice(0, slash);
      const modelId = spec.model.slice(slash + 1);
      model = this.registry.find(provider, modelId);
      if (!model) {
        if (this.sessionModel) {
          fallbackNote = `role ${role}: model ${spec.model} not found in registry; falling back to session model ${this.sessionModel.provider}/${this.sessionModel.id}`;
          model = this.sessionModel;
        } else {
          throw new RoleResolutionError(`role ${role}: model ${spec.model} not found in registry and no session fallback`);
        }
      }
    }

    const auth = await this.registry.getApiKeyAndHeaders(model);
    if (!auth.ok) {
      // Pinned model without a key: try the session model before giving up.
      if (this.sessionModel && model !== this.sessionModel) {
        const sessionAuth = await this.registry.getApiKeyAndHeaders(this.sessionModel);
        if (sessionAuth.ok) {
          const resolved: ResolvedRole & { fallbackNote?: string } = {
            role,
            model: this.sessionModel,
            apiKey: sessionAuth.apiKey,
            headers: sessionAuth.headers,
            fallbackNote: `role ${role}: no credentials for ${model.provider}/${model.id} (${auth.error}); using session model ${this.sessionModel.provider}/${this.sessionModel.id}`,
          };
          this.cache.set(role, resolved);
          return resolved;
        }
      }
      throw new RoleResolutionError(`role ${role}: cannot authenticate ${model.provider}/${model.id}: ${auth.error}`);
    }

    const resolved: ResolvedRole & { fallbackNote?: string } = {
      role,
      model,
      apiKey: auth.apiKey,
      headers: auth.headers,
    };
    if (fallbackNote !== undefined) resolved.fallbackNote = fallbackNote;
    this.cache.set(role, resolved);
    return resolved;
  }
}
