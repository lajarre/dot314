import { describe, expect, test } from "bun:test";

import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionManager } from "@mariozechner/pi-coding-agent";

import { forkCurrentBranchToCwd } from "./move-session";

function userMessage(text: string) {
	return {
		role: "user" as const,
		content: [{ type: "text" as const, text }],
		timestamp: Date.now(),
	};
}

function assistantMessage(text: string) {
	return {
		role: "assistant" as const,
		content: [{ type: "text" as const, text }],
		api: "test",
		provider: "test",
		model: "test",
		usage: {
			input: 1,
			output: 1,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 2,
			cost: {
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				total: 0,
			},
		},
		stopReason: "stop" as const,
		timestamp: Date.now(),
	};
}

function extractText(session: SessionManager): string[] {
	return session
		.buildSessionContext()
		.messages.flatMap((message) => {
			if (typeof message.content === "string") return [message.content];
			return message.content.flatMap((block) => (block.type === "text" ? [block.text] : []));
		});
}

describe("forkCurrentBranchToCwd", () => {
	test("preserves the currently active branch instead of the last-written branch", () => {
		const root = mkdtempSync(join(tmpdir(), "move-session-"));
		const sourceCwd = join(root, "source");
		const targetCwd = join(root, "target");
		const sourceSessionDir = join(root, "source-sessions");
		mkdirSync(sourceCwd);
		mkdirSync(targetCwd);

		const session = SessionManager.create(sourceCwd, sourceSessionDir);
		session.appendMessage(userMessage("root"));
		const forkPoint = session.appendMessage(assistantMessage("root-answer"));
		session.appendMessage(userMessage("branch-a"));
		const activeLeaf = session.appendMessage(assistantMessage("branch-a-answer"));

		session.branch(forkPoint);
		session.appendMessage(userMessage("branch-b"));
		session.appendMessage(assistantMessage("branch-b-answer"));

		// Simulate the user navigating back in /tree before running /move-session.
		session.branch(activeLeaf);

		const sourceSessionFile = session.getSessionFile();
		expect(sourceSessionFile).toBeTruthy();

		const destSessionFile = forkCurrentBranchToCwd(sourceSessionFile!, targetCwd, activeLeaf);
		const movedSession = SessionManager.open(destSessionFile);
		const texts = extractText(movedSession);

		expect(texts).toContain("branch-a-answer");
		expect(texts).not.toContain("branch-b-answer");
		expect(texts.at(-1)).toBe("branch-a-answer");
	});
});
