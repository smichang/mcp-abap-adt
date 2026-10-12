import * as fs from 'fs/promises';
import * as path from 'path';

export interface McpTextResult {
    isError: boolean;
    // `type` is widened to string because handler cores build results via return_error /
    // return_response, whose inferred content type is { type: string; text: string }.
    content: { type: string; text: string }[];
}

/**
 * Wraps a handler "core" with optional background + output_file behavior, driven by
 * two conventional args any tool can accept:
 *
 *   - background=true  → return immediately (before the core runs) with the target file
 *                        path, then write the core's text result to that file when it
 *                        settles. Use from MCP clients with a short request timeout (the
 *                        Cline CLI enforces a hard ~5s tools/call cap). Errors are written
 *                        to the file too, never lost.
 *   - output_file      → in synchronous mode, also persist the report to this path.
 *                        In background mode, this is the target (a timestamped file in the
 *                        server working directory is used if omitted).
 *
 * The core must resolve to the standard single-text-block MCP result. This helper never
 * throws for expected SAP failures — the core is expected to return { isError:true, … }
 * for those (as every handler here already does); only truly unexpected throws are caught
 * and rendered into the file (background) or rethrown (synchronous, to return_error).
 */
export async function maybeBackground(
    args: any,
    label: string,
    slug: string,
    core: () => Promise<McpTextResult>
): Promise<McpTextResult> {
    const background = args?.background === true;
    const outputFileArg = args?.output_file ? String(args.output_file) : '';

    if (!background) {
        const res = await core();
        if (outputFileArg) {
            const outPath = resolveOutPath(outputFileArg, slug);
            const text = res.content?.[0]?.text ?? '';
            await fs.writeFile(outPath, text, 'utf8').catch(() => { /* non-fatal */ });
            return { isError: res.isError, content: [{ type: 'text', text: `${text}\n\n(written to ${outPath})` }] };
        }
        return res;
    }

    const outPath = resolveOutPath(outputFileArg, slug);
    const started = new Date().toISOString();
    await fs.writeFile(outPath,
        `${label} IN PROGRESS\nStarted: ${started}\n\n(Re-read this file in a few seconds for the result.)\n`,
        'utf8').catch(() => { /* non-fatal */ });

    // Kick off the work WITHOUT awaiting — the stdio server process stays alive, so this
    // promise runs to completion after we return the instant response.
    void (async () => {
        try {
            const res = await core();
            await fs.writeFile(outPath, res.content?.[0]?.text ?? '(no output)', 'utf8');
        } catch (error) {
            const msg = error instanceof Error ? error.message : String(error);
            await fs.writeFile(outPath,
                `${label} FAILED\nStarted: ${started}\n\nReason: ${msg}\n`,
                'utf8').catch(() => { /* non-fatal */ });
        }
    })();

    return {
        isError: false,
        content: [{ type: 'text', text: `${label} started. Result will be written to:\n${outPath}\n\nRead that file in a few seconds.` }]
    };
}

export function resolveOutPath(outputFileArg: string, slug: string): string {
    if (outputFileArg) return path.resolve(outputFileArg);
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    return path.join(process.cwd(), `${slug}-${stamp}.md`);
}

/**
 * Reusable JSON-schema fragment for the two background args. Spread into a tool's
 * inputSchema.properties so every background-capable tool documents them identically.
 */
export const backgroundSchemaProps = {
    background: {
        type: 'boolean' as const,
        description: 'Optional. When true, the tool returns immediately (before any SAP call) with a target file path and writes the result to that file when it completes. Use from MCP clients with a short request timeout (e.g. Cline CLI\'s ~5s cap). Read output_file a few seconds later. Default: false (synchronous — returns the result inline).',
        default: false
    },
    output_file: {
        type: 'string' as const,
        description: 'Optional. Path to write the result to. Relative paths resolve against the server working directory; the absolute path is reported back. Target for background mode (a timestamped file is used if omitted). In synchronous mode, when set, the result is both returned inline and written to this file.'
    }
};
