/**
 * memory-tools.ts — Pi extension: recall + verify_claim tool bindings (Plan 2 §5.3)
 *
 * Ported from glitch-ai .opencode/plugins/{recall,verify-claim}.js → Pi registerTool.
 * Detection/wrap logic ports nearly line-for-line; only the binding changes.
 *
 * Tools:
 *   recall      — FTS5 memory search via search-memory.mjs
 *   verify_claim— grep/filesystem claim verification (R5 protocol)
 */

import { spawnSync, execSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

const STOP_WORDS = new Set([
  "is", "are", "the", "a", "an", "in", "on", "at", "to", "for", "of", "by", "with",
  "uses", "using", "have", "has", "been", "was", "were", "will", "would", "could",
  "should", "may", "might", "shall", "can", "does", "do", "did", "this", "that",
  "these", "those", "its", "their", "our", "your", "my", "his", "her", "not", "no",
  "nor", "but", "or", "and", "we", "it", "as", "be", "if", "from", "than", "so",
]);

function extractTerms(claim: string): string[] {
  const cleaned = claim.replace(/[.,!?;:'"]/g, "");
  const words = cleaned.split(/\s+/);
  const meaningful = words
    .map((w) => w.trim())
    .filter((w) => w.length > 2 && !STOP_WORDS.has(w.toLowerCase()));
  return [...new Set(meaningful)].slice(0, 5);
}

function sanitizeTerm(term: string): string {
  return String(term).replace(/[^a-zA-Z0-9_\-/]/g, "");
}

function runGrep(term: string, dir: string): string[] {
  try {
    const safeTerm = sanitizeTerm(term);
    const result = execSync(
      `grep -rli "${safeTerm}" --include="*.ts" --include="*.tsx" --include="*.js" --include="*.jsx" --include="*.py" --include="*.go" --include="*.rs" --include="*.json" --include="*.yaml" --include="*.yml" --include="*.md" "${dir}" 2>nul || echo "___NO_MATCHES___"`,
      { encoding: "utf-8", timeout: 10000, cwd: dir },
    );
    return result
      .trim()
      .split("\n")
      .filter((l) => l.trim() && l !== "___NO_MATCHES___" && !l.includes("No matches found"));
  } catch {
    return [];
  }
}

export default function (pi: ExtensionAPI) {
    // Prefer cwd, fall back to glitch-ai (where better-sqlite3/@huggingface deps live)
  let dir = process.cwd();
  const fallbackRoot = "E:/Glitch AI/glitch-ai";
  const scriptInCwd = join(dir, "glitch-memorycore", "plugins", "embed-search", "search-memory.mjs");
  const scriptInFallback = join(fallbackRoot, "glitch-memorycore", "plugins", "embed-search", "search-memory.mjs");
  if (!existsSync(scriptInCwd) || !existsSync(join(dir, "glitch-memorycore", "plugins", "embed-search", "memory-search.db"))) {
    if (existsSync(scriptInFallback)) dir = fallbackRoot;
  }

  // --- recall ---
  pi.registerTool({
    name: "recall",
    label: "Recall",
    description:
      "Search Glitch's memory using full-text search over all memory files. " +
      "Call this when you need to find past preferences, decisions, patterns, post-mortems, " +
      "reminders, or any information stored in memory. Use conversational queries like " +
      "\"Troy's UI design preferences\" or \"memory compaction protocol decisions\".",
    parameters: Type.Object({
      query: Type.String({ description: "Natural language search query. Be specific." }),
      limit: Type.Optional(Type.Number({ description: "Max results (default 5)", default: 5 })),
      include_json: Type.Optional(Type.Boolean({ description: "Return raw JSON", default: false })),
    }),
    async execute(_id, params) {
      const searchScript = join(dir, "glitch-memorycore", "plugins", "embed-search", "search-memory.mjs");
      const dbPath = join(dir, "glitch-memorycore", "plugins", "embed-search", "memory-search.db");
      const query = params.query;
      const limit = params.limit || 5;

      if (!existsSync(searchScript)) {
        return {
          content: [
            {
              type: "text",
              text: `🔍 Recall: Search script not found at ${searchScript}\n\nRun index-memory.mjs first: node glitch-memorycore/plugins/embed-search/index-memory.mjs`,
            },
          ],
          details: undefined,
        } as any;
      }
      if (!existsSync(dbPath)) {
        return {
          content: [
            {
              type: "text",
              text: `🔍 Recall: Memory index not found. No database at ${dbPath}\n\nRun index-memory.mjs first.`,
            },
          ],
          details: undefined,
        } as any;
      }

      try {
        const proc = spawnSync(
          "node",
          [searchScript, "-q", query, "--json", "--limit", String(limit)],
          { encoding: "utf-8", timeout: 15000, cwd: dir },
        );
        if (proc.error) throw proc.error;
        if (proc.status !== 0) throw new Error(proc.stderr || `exit code ${proc.status}`);

        const parsed = JSON.parse(proc.stdout);
        const results = Array.isArray(parsed) ? parsed : parsed.results || [];
        const total = Array.isArray(parsed) ? parsed.length : parsed.total || results.length;

        if (results.length === 0) {
          return {
            content: [
              {
                type: "text",
                text: `🔍 Recall: "${query}" — 0 results found\n\nNo matches in memory index. Try different terms or rebuild: node glitch-memorycore/plugins/embed-search/index-memory.mjs`,
              },
            ],
            details: undefined,
          } as any;
        }

        const lines = [`🔍 Recall: "${query}" — ${results.length} result(s) from ${total} match(es)`, ``];
        for (let i = 0; i < results.length; i++) {
          const r = results[i];
          const filePath = (r.file_path || "").replace(/\\/g, "/");
          const section = r.section_heading || "(unknown section)";
          const score = r.score !== undefined ? r.score.toFixed(2) : "N/A";
          const content = r.content || "";
          lines.push(`[${i + 1}] ${filePath}`);
          lines.push(`    Section: ${section}  |  Score: ${score}`);
          if (content) lines.push(`    ${content.replace(/\n/g, "\n    ")}`);
          lines.push(``);
        }
        lines.push(`Tip: Read the full context with read tool at the file paths above.`);

        return {
          content: [{ type: "text", text: lines.join("\n") }],
          details: undefined,
        } as any;
      } catch (e: any) {
        const errMsg = e.message || String(e);
        if (errMsg.includes("better-sqlite3")) {
          return {
            content: [
              {
                type: "text",
                text: "🔍 Recall: Missing dependency 'better-sqlite3'. Run: cd glitch-memorycore/plugins/embed-search && npm install",
              },
            ],
            details: undefined,
          } as any;
        }
        return {
          content: [{ type: "text", text: `🔍 Recall: Search failed — ${errMsg.slice(0, 200)}` }],
          details: undefined,
        } as any;
      }
    },
  });

  // --- verify_claim ---
  pi.registerTool({
    name: "verify_claim",
    label: "Verify Claim",
    description:
      "Verify a factual claim about code, infrastructure, file existence, or technology choices. " +
      "Call this BEFORE asserting any unverified claim about what exists or doesn't exist in the codebase.",
    parameters: Type.Object({
      claim: Type.String({ description: "The claim to verify. Be specific." }),
      search_dirs: Type.Optional(
        Type.Array(Type.String(), { description: "Directories to search", default: ["."] }),
      ),
      search_terms: Type.Optional(
        Type.Array(Type.String(), { description: "Override auto-extracted terms" }),
      ),
    }),
    async execute(_id, params) {
      const claim = params.claim;
      const searchTerms = params.search_terms || extractTerms(claim);

      if (!searchTerms || searchTerms.length === 0) {
        return {
          content: [
            {
              type: "text",
              text: `🔍 Verify Claim: "${claim}"\n\nStatus: UNVERIFIED (confidence: 0.0)\nSummary: Could not extract meaningful search terms.\n\nRecommendation: Provide search_terms parameter.`,
            },
          ],
          details: undefined,
        } as any;
      }

      const evidence: { term: string; matchedFiles: string[]; matchCount: number }[] = [];
      for (const term of searchTerms) {
        const matches = runGrep(term, dir);
        const uniquePaths = [...new Set(matches.map((m) => m.replace(/\\/g, "/")))];
        evidence.push({ term, matchedFiles: uniquePaths, matchCount: uniquePaths.length });
      }

      const totalMatches = evidence.reduce((sum, e) => sum + e.matchCount, 0);
      const uniqueFiles = [...new Set(evidence.flatMap((e) => e.matchedFiles))];

      let status: string;
      let confidence: number;
      let summary: string;

      if (totalMatches >= 3) {
        status = "VERIFIED";
        confidence = 1.0;
        summary = `Found ${totalMatches} matches across ${uniqueFiles.length} files. Claim is strongly supported.`;
      } else if (totalMatches >= 1) {
        status = "VERIFIED";
        confidence = 0.7;
        summary = `Found ${totalMatches} match(es) across ${uniqueFiles.length} file(s). Claim is weakly supported — verify context before asserting.`;
      } else {
        status = "UNVERIFIED";
        confidence = 0.0;
        summary = `Searched ${searchTerms.length} terms. Found 0 matches for any term.`;
      }

      const evidenceLines = evidence
        .map(
          (e) =>
            `  • "${e.term}" → ${e.matchCount > 0 ? `${e.matchCount} file(s): ${e.matchedFiles.slice(0, 5).join(", ")}${e.matchedFiles.length > 5 ? ` +${e.matchedFiles.length - 5} more` : ""}` : "0 files"}`,
        )
        .join("\n");

      let recommend: string;
      if (confidence >= 1.0) {
        recommend = "Claim is VERIFIED. Safe to assert with confidence.";
      } else if (confidence >= 0.7) {
        recommend = "Claim has some support but verify context before asserting. Say 'Based on what I found...' rather than stating as absolute fact.";
      } else {
        recommend = "Claim is UNVERIFIED. Do NOT state this as fact. Say 'Let me check' and verify properly.";
      }

      return {
        content: [
          {
            type: "text",
            text: [
              `🔍 Verify Claim: "${claim}"`,
              ``,
              `Status: ${status} (confidence: ${confidence})`,
              `Summary: ${summary}`,
              ``,
              `Terms Searched: ${searchTerms.join(", ")}`,
              ``,
              `Evidence:`,
              evidenceLines,
              ``,
              `Recommendation: ${recommend}`,
            ].join("\n"),
          },
        ],
        details: undefined,
      } as any;
    },
  });
}
