#!/usr/bin/env node
import { readFileSync, writeFileSync, renameSync, readdirSync, existsSync, mkdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { homedir } from 'node:os';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '..');
const AGENTS_DIR = join(REPO_ROOT, '.pi', 'agents');
const PROFILES_DIR = join(REPO_ROOT, '.pi', 'agent-profiles');

const VALID_THINKING = new Set(['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']);
const DEFAULT_TARGET = pathToFileURL(join(homedir(), '.pi-web', 'subagent-templates.json')).pathname.replace(/^\//, '');

function printHelp() {
  process.stdout.write(
    `Usage: sync-subagent-templates.mjs [--dry-run] [--help]\n` +
    `\n` +
    `Regenerates the pi-web-ui subagent template list from .pi/agents/*.md.\n` +
    `Writes JSON atomically to PI_WEB_TEMPLATES (default: %USERPROFILE%\\.pi-web\\subagent-templates.json).\n` +
    `\n` +
    `  --dry-run   Print the summary without writing anything.\n` +
    `  --help      Show this message and exit.\n`
  );
}

function unquote(v) {
  if (typeof v !== 'string' || v.length < 2) return v;
  const first = v[0], last = v[v.length - 1];
  if ((first === '"' || first === "'") && first === last) return v.slice(1, -1);
  return v;
}

function parseFrontmatter(text, filePath) {
  const m = text.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
  if (!m) {
    process.stderr.write(`warn: no frontmatter in ${filePath}, skipping\n`);
    return null;
  }
  const [, head, body] = m;
  const fields = {};
  for (const line of head.split(/\r?\n/)) {
    const idx = line.indexOf(':');
    if (idx < 0) continue;
    const key = line.slice(0, idx).trim();
    const val = line.slice(idx + 1).trim();
    if (key) fields[key] = unquote(val);
  }
  return { fields, body: body.trim() };
}

function buildAgentEntry(filePath) {
  const text = readFileSync(filePath, 'utf8');
  const parsed = parseFrontmatter(text, filePath);
  if (!parsed) return null;
  const { fields, body } = parsed;
  if (!fields.name) {
    process.stderr.write(`warn: no name in ${filePath}, skipping\n`);
    return null;
  }
  const description = fields.description ?? '';
  const model = fields.model ?? '';
  let thinkingLevel = fields.thinkingLevel ?? '';
  if (!VALID_THINKING.has(thinkingLevel)) thinkingLevel = '';
  return {
    name: fields.name,
    description,
    descriptionEn: description,
    promptMode: 'replace',
    systemPrompt: body,
    systemPromptEn: body,
    enabledSkills: [],
    enabledExtensions: [],
    model,
    thinkingLevel,
    enabled: true,
  };
}

function listMd(dir) {
  if (!existsSync(dir)) return [];
  return readdirSync(dir).filter((f) => f.endsWith('.md'));
}

function main() {
  const args = process.argv.slice(2);
  if (args.includes('--help') || args.includes('-h')) {
    printHelp();
    return 0;
  }
  const dryRun = args.includes('--dry-run');

  const profileStems = new Set(listMd(PROFILES_DIR).map((f) => f.replace(/\.md$/, '')));

  const agentFiles = listMd(AGENTS_DIR).filter((f) => !profileStems.has(f.replace(/\.md$/, '')));
  const agents = [];
  for (const f of agentFiles) {
    const entry = buildAgentEntry(join(AGENTS_DIR, f));
    if (entry) agents.push(entry);
  }
  agents.sort((a, b) => a.name.localeCompare(b.name));

  if (agents.length === 0) {
    process.stderr.write('error: zero agents parsed from .pi/agents/*.md; refusing to overwrite target\n');
    return 1;
  }

  const target = process.env.PI_WEB_TEMPLATES || DEFAULT_TARGET;

  let preserved = [];
  if (existsSync(target)) {
    try {
      const existing = JSON.parse(readFileSync(target, 'utf8'));
      if (Array.isArray(existing)) {
        const newNames = new Set(agents.map((a) => a.name));
        preserved = existing.filter((e) => e && typeof e === 'object' && !newNames.has(e.name));
      }
    } catch (err) {
      process.stderr.write(`warn: could not parse existing ${target}: ${err.message}\n`);
    }
  }

  const output = [...agents, ...preserved];

  if (!dryRun) {
    mkdirSync(dirname(target), { recursive: true });
    const tmp = target + '.tmp';
    writeFileSync(tmp, JSON.stringify(output, null, 2) + '\n', 'utf8');
    renameSync(tmp, target);
  }

  process.stdout.write(
    `roles written: ${agents.length}\n` +
    `preserved:     ${preserved.length}\n` +
    `target:        ${target}\n` +
    `mode:          ${dryRun ? 'dry-run' : 'write'}\n` +
    `roles:         ${agents.map((a) => a.name).join(', ')}\n`
  );
  return 0;
}

process.exit(main());
