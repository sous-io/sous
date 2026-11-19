import { describe, expect, it } from "vitest";
import { parseDocument } from "./text-document.js";
import { parseYamlStream } from "./yaml-stream.js";

const STREAM = `# A service and its deployment
---
kind: Service # the front door
metadata:
  name: web
---   # the workload
kind: Deployment
spec:
  replicas: 1
---
kind: ConfigMap
data:
  mode: "loose"
`;

describe("parseDocument() with several documents", () => {
    /**
     * parseDocument refuses a YAML text holding several documents: a path cannot say which one it means.
     *
     * parseDocument("a: 1\n---\nb: 2\n", "yaml");   // -> throws "Source contains multiple documents"
     */
    it("should refuse a stream of several documents", () => {
        expect(() => parseDocument("a: 1\n---\nb: 2\n", "yaml")).toThrow(/multiple documents/);
    });
});

describe("parseYamlStream()", () => {
    /**
     * parseYamlStream should count the documents and read each one; comments and directives
     * before a `---` line belong to no document.
     *
     * parseYamlStream("a: 1\n---\nb: 2\n").count();   // -> 2
     */
    it("should count the documents and read each", () => {
        const stream = parseYamlStream(STREAM);

        expect(stream.count()).toBe(3);
        expect(stream.document(0).value()).toEqual({ kind: "Service", metadata: { name: "web" } });
        expect(stream.document(1).value()).toEqual({ kind: "Deployment", spec: { replicas: 1 } });
        expect(stream.document(2).atPath("data.mode").get()).toBe("loose");
        expect(parseYamlStream("%YAML 1.2\n---\na: 1\n").count()).toBe(1);
        expect(parseYamlStream("a: 1\n...\nb: 2\n").count()).toBe(2);
        expect(parseYamlStream("").count()).toBe(1);
        expect(parseYamlStream(STREAM).toString()).toBe(STREAM);
    });

    /**
     * Editing the first, middle or last document changes only that document; every other byte,
     * the `---` lines included, stays.
     */
    it("should edit the first, middle and last document and keep the others byte for byte", () => {
        const first = parseYamlStream(STREAM);

        first.document(0).atPath("metadata.name").set("api");
        expect(first.toString()).toBe(STREAM.replace("name: web", "name: api"));

        const middle = parseYamlStream(STREAM);

        middle.document(1).atPath("spec.replicas").set(3);
        expect(middle.toString()).toBe(STREAM.replace("replicas: 1", "replicas: 3"));

        const last = parseYamlStream(STREAM);

        last.document(2).atPath("data.mode").set("strict");
        last.document(2).atPath("data.extra").set(true);
        expect(last.toString()).toBe(STREAM.replace('mode: "loose"\n', 'mode: "strict"\n  extra: true\n'));
    });

    /**
     * A document's comments can be edited too, and a CRLF stream keeps its line endings.
     */
    it("should edit a document's comments in a CRLF stream", () => {
        const text = "a: 1\r\n---\r\nb: 2 # old\r\n";
        const stream = parseYamlStream(text);

        stream.document(1).setComment("b", "after", "new");
        stream.document(1).setComment("b", "before", "about b");
        expect(stream.toString()).toBe("a: 1\r\n---\r\n# about b\r\nb: 2 # new\r\n");
    });

    /**
     * A text with one document is a stream of one: document 0 edits exactly as parseDocument does.
     */
    it("should treat a single-document file as before", () => {
        for (const text of ["a: 1 # c\nb:\n  - x\n", "---\na: 1\n", ""]) {
            const stream = parseYamlStream(text);
            const doc = parseDocument(text, "yaml");

            expect(stream.count()).toBe(1);
            stream.document(0).atPath("b").set(["y"]);
            doc.atPath("b").set(["y"]);
            expect(stream.toString()).toBe(doc.toString());
        }
    });

    /**
     * An index past the end, and a stream with a broken document, are errors.
     */
    it("should refuse a missing document and an invalid stream", () => {
        expect(() => parseYamlStream("a: 1\n---\nb: 2\n").document(2)).toThrow(/holds 2 documents, so it has no document 2/);
        expect(() => parseYamlStream("a: 1\n---\nb: [\n")).toThrow(/not valid/);
    });
});
