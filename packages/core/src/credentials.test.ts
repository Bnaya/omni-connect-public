import assert from "node:assert/strict";
import { test } from "node:test";
import {
  EnvCredentialProvider,
  MissingCredentialError,
  envVarNames,
  scopedCredentials,
} from "./credentials.ts";

test("env var naming", () => {
  assert.deepEqual(envVarNames({ connector: "yad2", name: "email" }), ["OMNI_YAD2_EMAIL"]);
  assert.deepEqual(
    envVarNames({ connector: "levi-yitzhak", name: "api token", identity: "client-a" }),
    ["OMNI_CLIENT_A__LEVI_YITZHAK_API_TOKEN", "OMNI_LEVI_YITZHAK_API_TOKEN"],
  );
});

test("identity-scoped value wins, default is the fallback", async () => {
  const p = new EnvCredentialProvider({
    OMNI_YAD2_EMAIL: "me@default",
    OMNI_WORK__YAD2_EMAIL: "me@work",
  });
  assert.equal(await p.get({ connector: "yad2", name: "email" }), "me@default");
  assert.equal(await p.get({ connector: "yad2", name: "email", identity: "work" }), "me@work");
  assert.equal(await p.get({ connector: "yad2", name: "email", identity: "home" }), "me@default");
  assert.equal(await p.get({ connector: "yad2", name: "password" }), undefined);
});

test("require throws MissingCredentialError naming the env vars", async () => {
  const creds = scopedCredentials(
    new EnvCredentialProvider({ OMNI_YAD2_PASSWORD: "" }),
    "yad2",
    "work",
  );
  await assert.rejects(creds.require("password"), (err) => {
    assert.ok(err instanceof MissingCredentialError);
    assert.deepEqual(err.locations, ["OMNI_WORK__YAD2_PASSWORD", "OMNI_YAD2_PASSWORD"]);
    assert.ok(!err.message.includes("undefined"));
    return true;
  });
});
