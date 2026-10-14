/**
 * Credentials and identities. DRAFT.
 *
 * An *identity* is "who am I acting as": the owner has several clients/projects,
 * each with its own accounts. A connector asks for a credential by short name
 * ("email", "password", "api_token"); the provider resolves it for the current
 * identity. Today: env vars. Later: 1Password / Bitwarden / sops / OS keychain,
 * behind the same interface.
 *
 * Env var naming (lookup order, first hit wins):
 *   1. OMNI_<IDENTITY>__<CONNECTOR>_<NAME>   (identity-scoped; note the double underscore)
 *   2. OMNI_<CONNECTOR>_<NAME>               (default identity, the convention in CLAUDE.md)
 * All parts are upper-cased, and non-alphanumerics become "_".
 * e.g. connector "yad2", name "email" -> OMNI_YAD2_EMAIL, or OMNI_CLIENTA__YAD2_EMAIL.
 */

export type CredentialRequest = {
  connector: string;
  name: string;
  identity?: string;
};

export interface CredentialProvider {
  /** Returns the secret, or undefined when not configured. Never logs the value. */
  get(req: CredentialRequest): Promise<string | undefined>;
  /** Where a human should put this secret (for handoff messages). Must not reveal values. */
  describe(req: CredentialRequest): string[];
}

/** A connector-scoped view handed to operations via the context. */
export interface Credentials {
  get(name: string): Promise<string | undefined>;
  /** Like get, but throws MissingCredentialError (which becomes a "credentials" handoff). */
  require(name: string): Promise<string>;
}

export class MissingCredentialError extends Error {
  /** Where the human should set it, e.g. ["OMNI_YAD2_EMAIL"]. */
  locations: string[];
  constructor(locations: string[]) {
    super(`Missing credential. Set one of: ${locations.join(", ")}`);
    this.name = "MissingCredentialError";
    this.locations = locations;
  }
}

function envPart(s: string): string {
  return s.toUpperCase().replace(/[^A-Z0-9]+/g, "_");
}

export function envVarNames(req: CredentialRequest): string[] {
  const base = `${envPart(req.connector)}_${envPart(req.name)}`;
  const names: string[] = [];
  if (req.identity) names.push(`OMNI_${envPart(req.identity)}__${base}`);
  names.push(`OMNI_${base}`);
  return names;
}

export class EnvCredentialProvider implements CredentialProvider {
  #env: Record<string, string | undefined>;
  constructor(env: Record<string, string | undefined> = process.env) {
    this.#env = env;
  }
  async get(req: CredentialRequest): Promise<string | undefined> {
    for (const name of envVarNames(req)) {
      const value = this.#env[name];
      if (value !== undefined && value !== "") return value;
    }
    return undefined;
  }
  describe(req: CredentialRequest): string[] {
    return envVarNames(req);
  }
}

export function scopedCredentials(
  provider: CredentialProvider,
  connector: string,
  identity?: string,
): Credentials {
  return {
    get: (name) => provider.get({ connector, name, identity }),
    async require(name) {
      const value = await provider.get({ connector, name, identity });
      if (value === undefined)
        throw new MissingCredentialError(provider.describe({ connector, name, identity }));
      return value;
    },
  };
}
