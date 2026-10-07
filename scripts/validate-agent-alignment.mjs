import { readdirSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
const AGENTS_DIR = join(ROOT, '.opencode', 'agents');
const CONFIG_DIR = join(ROOT, 'config');

function parseFrontmatter(content) {
  const parts = content.split('---');
  if (parts.length < 3) return null;
  const yaml = parts[1];
  const result = {};
  let currentKey = null;
  let inMultiline = false;

  for (const line of yaml.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) {
      if (inMultiline && !line.startsWith(' ') && !line.startsWith('\t') && trimmed === '') {
        inMultiline = false;
      }
      continue;
    }

    if (inMultiline) {
      if (line.startsWith('  ') || line.startsWith('\t')) continue;
      inMultiline = false;
    }

    if (!line.startsWith(' ') && !line.startsWith('\t')) {
      const match = trimmed.match(/^([\w][\w-]*):\s*(.*)$/);
      if (match) {
        currentKey = match[1];
        const value = match[2].trim();
        if (value === '' || value.startsWith('>') || value.startsWith('|')) {
          result[currentKey] = {};
          if (value.startsWith('>') || value.startsWith('|')) {
            inMultiline = true;
            result[currentKey] = undefined;
          }
        } else {
          result[currentKey] = value.replace(/^["']|["']$/g, '');
        }
      }
    } else if (currentKey && result[currentKey] !== undefined && typeof result[currentKey] === 'object') {
      const match = trimmed.match(/^([\w][\w-]*):\s*(.*)$/);
      if (match) {
        result[currentKey][match[1]] = match[2].trim().replace(/^["']|["']$/g, '');
      }
    }
  }

  return result;
}

function readAgentFiles() {
  const files = readdirSync(AGENTS_DIR).filter(f => f.endsWith('.md'));
  const map = {};

  for (const file of files) {
    const content = readFileSync(join(AGENTS_DIR, file), 'utf-8');
    const fm = parseFrontmatter(content);
    if (!fm || !fm.name) continue;

    map[fm.name] = {
      file,
      model: fm.model || null,
      mode: fm.mode || null,
      temperature: fm.temperature || null,
      permissions: fm.permission && typeof fm.permission === 'object' ? { ...fm.permission } : {},
    };
  }

  return map;
}

function readConfigTemplates() {
  const files = readdirSync(CONFIG_DIR).filter(f => f.startsWith('opencode-') && f.endsWith('.json'));
  const map = {};

  for (const file of files) {
    const content = readFileSync(join(CONFIG_DIR, file), 'utf-8');
    let config;
    try {
      config = JSON.parse(content);
    } catch {
      console.error(`Warning: failed to parse ${file}`);
      continue;
    }

    if (!config.agent || typeof config.agent !== 'object') continue;

    const agents = {};
    for (const [name, def] of Object.entries(config.agent)) {
      agents[name] = {
        model: def.model || null,
        mode: def.mode || null,
        temperature: def.temperature != null ? String(def.temperature) : null,
        permissions: def.permission && typeof def.permission === 'object' ? { ...def.permission } : {},
      };
    }

    map[file] = agents;
  }

  return map;
}

function isPlaceholder(value) {
  return value && value.startsWith('__') && value.endsWith('__');
}

function compareAgent(agentFile, configDef, agentName, configFile) {
  const mismatches = [];

  if (agentFile.model && configDef.model && !isPlaceholder(configDef.model) && !isPlaceholder(agentFile.model)) {
    if (agentFile.model !== configDef.model) {
      mismatches.push({ field: 'model', fileValue: agentFile.model, configValue: configDef.model });
    }
  }

  if (agentFile.mode && configDef.mode) {
    if (agentFile.mode !== configDef.mode) {
      mismatches.push({ field: 'mode', fileValue: agentFile.mode, configValue: configDef.mode });
    }
  }

  if (agentFile.temperature && configDef.temperature) {
    if (agentFile.temperature !== configDef.temperature) {
      mismatches.push({ field: 'temperature', fileValue: agentFile.temperature, configValue: configDef.temperature });
    }
  }

  const allPermKeys = new Set([...Object.keys(agentFile.permissions), ...Object.keys(configDef.permissions)]);
  for (const key of allPermKeys) {
    const fv = agentFile.permissions[key];
    const cv = configDef.permissions[key];
    if (fv !== undefined && cv !== undefined && fv !== cv) {
      mismatches.push({ field: `permission.${key}`, fileValue: fv, configValue: cv });
    }
  }

  return mismatches;
}

function run() {
  const agentFiles = readAgentFiles();
  const configTemplates = readConfigTemplates();

  const agentNames = Object.keys(agentFiles).sort();
  const configNames = Object.keys(configTemplates).sort();

  const issues = [];
  const missingFromConfig = [];
  const filesWithIssues = new Set();
  const configsWithIssues = new Set();

  for (const agentName of agentNames) {
    const af = agentFiles[agentName];

    for (const configFile of configNames) {
      const agents = configTemplates[configFile];

      if (!agents[agentName]) {
        missingFromConfig.push({ agent: agentName, file: af.file, config: configFile });
        continue;
      }

      const mismatches = compareAgent(af, agents[agentName], agentName, configFile);
      if (mismatches.length > 0) {
        issues.push({ agentFile: af.file, config: configFile, agent: agentName, mismatches });
        filesWithIssues.add(af.file);
        configsWithIssues.add(configFile);
      }
    }
  }

  const totalMismatches = issues.reduce((sum, i) => sum + i.mismatches.length, 0);

  console.log('## Agent Alignment Report');
  console.log(`Checked: ${agentNames.length} agent files against ${configNames.length} config templates`);
  console.log();

  if (missingFromConfig.length > 0) {
    console.log('### Agents Missing from Config Templates');
    console.log('_(These agent files have no inline definition in the given config — may be intentional)_');
    console.log();
    for (const { agent, file, config } of missingFromConfig) {
      console.log(`- **${file}** not in \`${config}\``);
    }
    console.log();
  }

  if (issues.length > 0) {
    console.log('### Mismatches Found');
    console.log();
    for (const { agentFile, config, agent, mismatches } of issues) {
      console.log(`#### ${agentFile} vs ${config}`);
      console.log('| Field | Agent File | Config Template |');
      console.log('|-------|-----------|-----------------|');
      for (const m of mismatches) {
        console.log(`| ${m.field} | ${m.fileValue} | ${m.configValue} |`);
      }
      console.log();
    }
  } else {
    console.log('### No Mismatches Found');
    console.log();
  }

  console.log('### Summary');
  console.log(`- **Total mismatches**: ${totalMismatches}`);
  console.log(`- **Files with issues**: ${filesWithIssues.size}/${agentNames.length} agent files`);
  console.log(`- **Configs with issues**: ${configsWithIssues.size}/${configNames.length} config templates`);
  console.log(`- **Agents missing from configs**: ${missingFromConfig.length} (may be intentional)`);

  if (totalMismatches > 0) {
    process.exit(1);
  }
}

run();
