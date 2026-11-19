import { describe, expect, it } from "vitest";
import { HIDDEN_VALUE, hasSecretName, hasSecretValue, hideSecrets, isSecret, looksLikeSecret, Secrets } from "./secrets.js";
import type { VariableSourceEntity } from "./types.js";

describe("hasSecretName()", () => {
    /**
     * A name whose last words say it is a secret matches, in any casing style.
     *
     * hasSecretName("OPENAI_API_KEY")  // true
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
     * A name that only mentions a secret word, or ends in an ambiguous word, does not match.
     *
     * hasSecretName("tokenLimit")  // false
     */
    it.each(["tokenLimit", "maxTokens", "passwordPolicyUrl", "authorName", "issueKey", "featureBranchPrefix", "secretsDir", "pwd"])(
        "should not match %s",
        (name) => {
            expect(hasSecretName(name)).toBe(false);
        },
    );
});

describe("hasSecretValue()", () => {
    /** A value in a widely used token format matches, wherever it sits. */
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

    /** Ordinary values do not match. */
    it.each(["https://github.com/sous-io/sous", "ssh://git@github.com/sous-io/sous.git", "lc/", "-----BEGIN PUBLIC KEY-----", "sk-short"])(
        "should not match %s",
        (value) => {
            expect(hasSecretValue(value)).toBe(false);
        },
    );
});

describe("looksLikeSecret()", () => {
    /** A secret-sounding name holding a number or a switch is not a secret. */
    it("should ignore a secret-sounding name that holds a number or a switch", () => {
        expect(looksLikeSecret("requireToken", "true")).toBe(false);
        expect(looksLikeSecret("refreshToken", "3600")).toBe(false);
        expect(looksLikeSecret("apiToken", "")).toBe(false);
        expect(looksLikeSecret("apiToken", "abc")).toBe(true);
    });
});

describe("isSecret()", () => {
    /** A declared secret is a secret whatever it is called, as long as it holds something. */
    it("should treat a declared name as a secret whatever it is called", () => {
        const declared = new Set(["deployKey"]);

        expect(isSecret("deployKey", "abc", declared)).toBe(true);
        expect(isSecret("deployKey", "", declared)).toBe(false);
        expect(isSecret("owner", "luke", declared)).toBe(false);
        expect(isSecret("apiToken", { nested: true }, declared)).toBe(false);
    });
});

describe("hideSecrets()", () => {
    /**
     * hideSecrets({ apiToken: "abc", owner: "luke" })  // { apiToken: "(hidden)", owner: "luke" }
     */
    it("should replace every secret value and keep the rest", () => {
        expect(hideSecrets({ apiToken: "abc", owner: "luke", deploy: "x" }, new Set(["deploy"]))).toEqual({
            apiToken: HIDDEN_VALUE,
            owner: "luke",
            deploy: HIDDEN_VALUE,
        });
    });
});

describe("Secrets", () => {
    /** The declared names come from every variable-source entity, asked once. */
    it("should gather declared names from the variable sources", () => {
        let asked = 0;
        const source: VariableSourceEntity = {
            id: "answers",
            description: "recipe answers",
            variables: () => ({}),
            secrets: () => {
                asked++;

                return ["deployKey"];
            },
        };
        const plain: VariableSourceEntity = { id: "plain", description: "plain", variables: () => ({}) };
        const secrets = new Secrets(() => [source, plain], () => ({ project: undefined, env: {}, config: { get: () => undefined } }));

        expect([...secrets.declared()]).toEqual(["deployKey"]);
        expect(secrets.isSecret("deployKey", "abc")).toBe(true);
        expect(secrets.hide({ deployKey: "abc", owner: "luke" })).toEqual({ deployKey: "(hidden)", owner: "luke" });
        expect(secrets.hiddenValue).toBe("(hidden)");
        expect(secrets.hasSecretName("apiToken")).toBe(true);
        expect(secrets.hasSecretValue("AKIAIOSFODNN7EXAMPLE")).toBe(true);
        secrets.declared();
        expect(asked).toBe(1);
    });
});
