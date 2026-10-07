import { describe, it, expect } from "vitest";
import { hasSecretName, hasSecretValue, isSecretVariable, looksLikeSecret } from "./secrets.js";

describe("hasSecretName()", () => {
  /**
   * A name whose last words say it is a secret matches, in any casing style.
   *
   * hasSecretName("OPENAI_API_KEY")  // true
   * hasSecretName("githubToken")     // true
   */
  it.each([
    "OPENAI_API_KEY",
    "openaiApiKey",
    "openai-api-key",
    "githubToken",
    "GITHUB_TOKEN",
    "dbPassword",
    "DB_PASSWD",
    "clientSecret",
    "AWS_SECRET_ACCESS_KEY",
    "sshPrivateKey",
    "googleCredentials",
    "apikey",
    "signingKey",
  ])("should match %s", (name) => {
    expect(hasSecretName(name)).toBe(true);
  });

  /**
   * A name that only mentions a secret word, or ends in an ambiguous word,
   * does not match.
   *
   * hasSecretName("tokenLimit")  // false
   * hasSecretName("maxTokens")   // false
   */
  it.each([
    "tokenLimit",
    "maxTokens",
    "passwordPolicyUrl",
    "authorName",
    "issueKey",
    "featureBranchPrefix",
    "secretsDir",
    "pwd",
  ])("should not match %s", (name) => {
    expect(hasSecretName(name)).toBe(false);
  });
});

describe("hasSecretValue()", () => {
  /**
   * A value in a widely used token format matches, wherever it sits in the
   * string.
   *
   * hasSecretValue("ghp_" + 36 characters)  // true
   */
  it.each([
    ["a GitHub token", "ghp_" + "A1b2".repeat(9)],
    ["a GitHub fine-grained token", "github_pat_" + "a".repeat(30)],
    ["a GitLab token", "glpat-" + "x".repeat(20)],
    ["an AWS access key id", "AKIAIOSFODNN7EXAMPLE"],
    ["a Slack token", "xoxb-1234567890-abcdef"],
    ["a Stripe live key", "sk_live_" + "a".repeat(24)],
    ["an Anthropic key", "sk-ant-api03-" + "a".repeat(30)],
    ["an OpenAI key", "sk-proj-" + "a".repeat(40)],
    ["a Google API key", "AIza" + "a".repeat(35)],
    ["an npm token", "npm_" + "a".repeat(36)],
    ["a JSON Web Token", "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0In0.abcdefghijk"],
    ["a private key", "-----BEGIN OPENSSH PRIVATE KEY-----\nabc"],
    ["a URL carrying a password", "postgres://admin:s3cret@db.example:5432/app"],
  ])("should match %s", (_label, value) => {
    expect(hasSecretValue(value)).toBe(true);
  });

  /**
   * Ordinary values do not match, including a URL with a user name but no
   * password and a public key.
   *
   * hasSecretValue("https://github.com/sous-io/sous")  // false
   */
  it.each([
    "https://github.com/sous-io/sous",
    "ssh://git@github.com/sous-io/sous.git",
    "lc/",
    "-----BEGIN PUBLIC KEY-----",
    "sk-short",
  ])("should not match %s", (value) => {
    expect(hasSecretValue(value)).toBe(false);
  });
});

describe("looksLikeSecret()", () => {
  /**
   * A secret-sounding name holding a number or a switch is not a secret, so a
   * setting like `requireToken: "true"` still shows.
   *
   * looksLikeSecret("requireToken", "true")  // false
   * looksLikeSecret("apiToken", "abc")       // true
   */
  it("should ignore a secret-sounding name that holds a number or a switch", () => {
    expect(looksLikeSecret("requireToken", "true")).toBe(false);
    expect(looksLikeSecret("refreshToken", "3600")).toBe(false);
    expect(looksLikeSecret("apiToken", "")).toBe(false);
    expect(looksLikeSecret("apiToken", "abc")).toBe(true);
  });
});

describe("isSecretVariable()", () => {
  /**
   * A declared secret is a secret whatever it is called, as long as it holds
   * something; a value that is not a string never is.
   *
   * isSecretVariable("deployKey", "abc", new Set(["deployKey"]))  // true
   */
  it("should treat a declared name as a secret whatever it is called", () => {
    const declared = new Set(["deployKey"]);
    expect(isSecretVariable("deployKey", "abc", declared)).toBe(true);
    expect(isSecretVariable("deployKey", "", declared)).toBe(false);
    expect(isSecretVariable("owner", "luke", declared)).toBe(false);
    expect(isSecretVariable("apiToken", { nested: true }, declared)).toBe(false);
  });
});
