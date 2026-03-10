/**
 * Session Move Extension
 *
 * Move the current session into another cwd bucket and relaunch pi in that directory
 *
 * Implementation strategy:
 *  1) Fork the current session file into the target cwd bucket using SessionManager.forkFrom()
 *  2) Clear the fork header's parentSession pointer
 *  3) Tear down the parent's terminal usage (pop kitty protocol, reset modes)
 *  4) Spawn a new pi process in the target cwd with inherited stdio
 *  5) Once the child has spawned, trash the old session file
 *  6) Once the child has spawned, destroy the parent's stdin so it cannot steal key presses
 *  7) Parent stays alive as an inert wrapper, forwarding the child's exit code
 *
 * Usage:
 *   /move-session <targetCwd>
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { SessionManager } from "@mariozechner/pi-coding-agent";
import { randomBytes } from "node:crypto";
import { spawn } from "node:child_process";
import {
    readFileSync,
    statSync,
    unlinkSync,
    writeFileSync,
} from "node:fs";

const TRASH_TIMEOUT_MS = 5000;

type SessionHeader = {
    type: "session";
    version?: number;
    id: string;
    timestamp: string;
    cwd: string;
    parentSession?: string;
};

type SessionEntry = {
    type: string;
    id: string;
    parentId: string | null;
    timestamp: string;
    targetId?: string;
    label?: string;
};

function generateEntryId(seenIds: Set<string>): string {
    let id = "";
    do {
        id = randomBytes(4).toString("hex");
    } while (seenIds.has(id));
    seenIds.add(id);
    return id;
}

export function forkCurrentBranchToCwd(sourceSessionFile: string, targetCwd: string, leafId: string | null): string {
    const content = readFileSync(sourceSessionFile, "utf8").trim();
    if (!content) {
        throw new Error(`Cannot fork: source session file is empty or invalid: ${sourceSessionFile}`);
    }

    const entries = content
        .split("\n")
        .filter((line) => line.trim().length > 0)
        .map((line) => JSON.parse(line) as SessionHeader | SessionEntry);

    const header = entries.find((entry) => entry.type === "session") as SessionHeader | undefined;
    if (!header) {
        throw new Error(`Cannot fork: source session has no header: ${sourceSessionFile}`);
    }

    const nonHeaderEntries = entries.filter((entry) => entry.type !== "session") as SessionEntry[];
    const entriesById = new Map(nonHeaderEntries.map((entry) => [entry.id, entry]));

    const labelsById = new Map<string, string>();
    for (const entry of nonHeaderEntries) {
        if (entry.type !== "label" || !entry.targetId) continue;
        if (entry.label) {
            labelsById.set(entry.targetId, entry.label);
        } else {
            labelsById.delete(entry.targetId);
        }
    }

    const path: SessionEntry[] = [];
    let currentId = leafId;
    while (currentId) {
        const entry = entriesById.get(currentId);
        if (!entry) {
            throw new Error(`Entry ${currentId} not found`);
        }
        path.push(entry);
        currentId = entry.parentId;
    }
    path.reverse();

    const pathWithoutLabels = path.filter((entry) => entry.type !== "label");
    const seenIds = new Set(nonHeaderEntries.map((entry) => entry.id));
    const labelEntries: SessionEntry[] = [];
    let parentId = pathWithoutLabels[pathWithoutLabels.length - 1]?.id || null;
    for (const entry of pathWithoutLabels) {
        const label = labelsById.get(entry.id);
        if (!label) continue;
        const labelEntry: SessionEntry = {
            type: "label",
            id: generateEntryId(seenIds),
            parentId,
            timestamp: new Date().toISOString(),
            targetId: entry.id,
            label,
        };
        labelEntries.push(labelEntry);
        parentId = labelEntry.id;
    }

    const destination = SessionManager.create(targetCwd);
    const destSessionFile = destination.getSessionFile();
    if (!destSessionFile) {
        throw new Error("Internal error: could not allocate destination session file");
    }

    const newHeader: SessionHeader = {
        type: "session",
        version: header.version,
        id: destination.getSessionId(),
        timestamp: new Date().toISOString(),
        cwd: targetCwd,
    };

    const output = [newHeader, ...pathWithoutLabels, ...labelEntries].map((entry) => JSON.stringify(entry)).join("\n") + "\n";
    writeFileSync(destSessionFile, output);
    return destSessionFile;
}

export default function (pi: ExtensionAPI) {
    const trashFileBestEffort = async (filePath: string) => {
        try {
            const { code } = await pi.exec("trash", [filePath], { timeout: TRASH_TIMEOUT_MS });
            if (code === 0) {
                return;
            }
        } catch {
            // ignore
        }

        // If "trash" isn't available, do not fall back to unlink.
        // This extension should never permanently delete session files.
    };

    pi.registerCommand("move-session", {
        description: "Move session to another directory and relaunch pi there",
        handler: async (args, ctx) => {
            await ctx.waitForIdle();

            const rawTargetCwd = args.trim();
            if (!rawTargetCwd) {
                ctx.ui.notify("Usage: /move-session <targetCwd>", "error");
                return;
            }

            let targetCwd = rawTargetCwd;
            if (/^~(?=$|\/)/.test(rawTargetCwd)) {
                const home = process.env.HOME || process.env.USERPROFILE;
                if (!home) {
                    ctx.ui.notify("Cannot expand '~': $HOME is not set", "error");
                    return;
                }
                targetCwd = rawTargetCwd.replace(/^~(?=$|\/)/, home);
            }

            let targetCwdStat;
            try {
                targetCwdStat = statSync(targetCwd);
            } catch (error: any) {
                const code = error?.code;
                if (code === "ENOENT") {
                    ctx.ui.notify(`Path does not exist: ${targetCwd}`, "error");
                } else {
                    ctx.ui.notify(`Cannot access path: ${targetCwd}`, "error");
                }
                return;
            }

            if (!targetCwdStat.isDirectory()) {
                ctx.ui.notify(`Not a directory: ${targetCwd}`, "error");
                return;
            }

            const sourceSessionFile = ctx.sessionManager.getSessionFile();
            if (!sourceSessionFile) {
                ctx.ui.notify("No persistent session file (maybe started with --no-session)", "error");
                return;
            }

            const activeLeafId = ctx.sessionManager.getLeafId();

            try {
                const destSessionFile = forkCurrentBranchToCwd(sourceSessionFile, targetCwd, activeLeafId);

                // --- Tear down the parent's terminal usage ---
                // We do this BEFORE spawning, to avoid nesting Kitty protocol flags.
                process.stdout.write("\x1b[<u");      // Pop kitty keyboard protocol
                process.stdout.write("\x1b[?2004l");  // Disable bracketed paste
                process.stdout.write("\x1b[?25h");    // Show cursor
                process.stdout.write("\r\n");         // Ensure child starts on a clean line

                if (process.stdin.isTTY && process.stdin.setRawMode) {
                    process.stdin.setRawMode(false);
                }

                // Spawn new pi in the target directory
                const child = spawn("pi", ["--session", destSessionFile], {
                    cwd: targetCwd,
                    stdio: "inherit",
                });

                child.once("spawn", () => {
                    // Trash the old session file *after* the new process is actually running
                    void trashFileBestEffort(sourceSessionFile);

                    // Stop the parent from stealing keypresses.
                    // destroy() is important; pause() was not sufficient.
                    process.stdin.removeAllListeners();
                    process.stdin.destroy();

                    // Avoid the parent reacting to Ctrl+C / termination signals.
                    // (The child is the process the user is interacting with.)
                    process.removeAllListeners("SIGINT");
                    process.removeAllListeners("SIGTERM");
                    process.on("SIGINT", () => {});
                    process.on("SIGTERM", () => {});
                });

                child.on("exit", (code) => process.exit(code ?? 0));
                child.on("error", (err) => {
                    process.stderr.write(`Failed to launch pi: ${err.message}\n`);
                    process.exit(1);
                });
            } catch (error: any) {
                ctx.ui.notify(`Failed to move session: ${error?.message ?? String(error)}`, "error");
            }
        },
    });
}
