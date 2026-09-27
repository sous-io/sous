/**
 * Unit tests for the questions `sous repo submit` asks. The prompts are
 * injected, so nothing here needs a terminal.
 */

import { describe, it, expect } from "vitest";
import { submitQuestions, type SubmitPrompts } from "./submit-questions.js";
import type { ProposalSummary } from "../providers/provider.js";

/** Prompts that answer from a table and record what they were asked. */
function scriptedPrompts(answers: { text?: string[]; confirm?: boolean; choose?: unknown } = {}) {
  const asked: string[] = [];
  const texts = [...(answers.text ?? [])];
  const prompts: SubmitPrompts = {
    text: async (message) => {
      asked.push(message);
      return texts.shift() ?? "";
    },
    confirm: async (message) => {
      asked.push(message);
      return answers.confirm ?? true;
    },
    choose: async <T>(message: string) => {
      asked.push(message);
      return answers.choose as T;
    },
  };
  return { prompts, asked };
}

const MERGED: ProposalSummary = { id: "7", state: "merged", title: "Done", draft: false };

describe("submitQuestions()", () => {
  /**
   * At a terminal, a missing title and description are asked for.
   */
  it("should ask for the title and the description at a terminal", async () => {
    const { prompts } = scriptedPrompts({ text: ["A title", "A description."] });
    const questions = submitQuestions({ interactive: true, yes: false, prompts });

    expect(await questions.title()).toBe("A title");
    expect(await questions.body()).toBe("A description.");
  });

  /**
   * With no terminal, the failure names both flags, whichever was missing.
   */
  it("should name both --title and --body when it cannot ask", async () => {
    const questions = submitQuestions({ interactive: false, yes: true });

    await expect(questions.title()).rejects.toThrow(/--title' and '--body/);
    await expect(questions.body()).rejects.toThrow(/--title' and '--body/);
  });

  /**
   * `--yes` answers every confirmation, and continuing after a merge takes a
   * generated branch.
   */
  it("should answer every confirmation with --yes", async () => {
    const lines: string[] = [];
    const questions = submitQuestions({ interactive: false, yes: true, write: (l) => lines.push(l) });

    expect(await questions.confirmCommit([{ status: "??", path: "a.md" }])).toBe(true);
    expect(await questions.proceedDespiteSubmissions([])).toBe(true);
    expect(await questions.nextBranch(MERGED, "sous/submit-x")).toEqual({ kind: "generate" });
  });

  /**
   * Without a terminal and without `--yes`, each confirmation fails naming the
   * flag, and the commit question still lists what it would have committed.
   */
  it("should fail naming --yes when a confirmation cannot be asked", async () => {
    const lines: string[] = [];
    const questions = submitQuestions({
      interactive: false,
      yes: false,
      write: (line) => lines.push(line),
    });

    await expect(questions.confirmCommit([{ status: "??", path: "a.md" }])).rejects.toThrow(
      /--yes/
    );
    expect(lines.join("\n")).toContain("a.md");
    await expect(questions.proceedDespiteSubmissions([])).rejects.toThrow(/--yes/);
    await expect(questions.nextBranch(MERGED, "sous/submit-x")).rejects.toThrow(/--yes/);
  });

  /**
   * At a terminal, continuing after a merge offers to generate a branch, to
   * name one, or to cancel; naming one asks for the name.
   */
  it("should ask for a branch name when the contributor wants to name it", async () => {
    const { prompts, asked } = scriptedPrompts({ choose: "name", text: ["my-branch"] });
    const questions = submitQuestions({ interactive: true, yes: false, prompts });

    expect(await questions.nextBranch(MERGED, "sous/submit-x")).toEqual({
      kind: "name",
      name: "my-branch",
    });
    expect(asked).toEqual([
      "Continue on a new branch?",
      "What should the new branch be called?",
    ]);
  });

  /**
   * Cancelling is an answer, not an error.
   */
  it("should hand back a cancel", async () => {
    const { prompts } = scriptedPrompts({ choose: "cancel" });
    const questions = submitQuestions({ interactive: true, yes: false, prompts });

    expect(await questions.nextBranch(MERGED, "sous/submit-x")).toEqual({ kind: "cancel" });
  });
});
