#!/usr/bin/env node

import { readFileSync, existsSync } from 'node:fs';
import { resolve, relative } from 'node:path';

const DEFAULT_PATH = 'data/samples/design-system.html';
const SECTIONS = ['color', 'typography', 'spacing', 'radius', 'shadow', 'breakpoints', 'transition', 'components', 'all'];

function parseArgs(argv) {
  const args = argv.slice(2);
  const opts = { path: DEFAULT_PATH, section: 'all', json: false, pretty: false, env: false, css: false, validate: false, help: false };
  for (let i = 0; i < args.length; i++) {
    switch (args[i]) {
      case '--path':    opts.path = args[++i]; break;
      case '--section': opts.section = args[++i]; break;
      case '--json':    opts.json = true; break;
      case '--pretty':  opts.pretty = true; break;
      case '--env':     opts.env = true; break;
      case '--css':     opts.css = true; break;
      case '--validate': opts.validate = true; break;
      case '--help':
      case '-h':        opts.help = true; break;
      default:
        process.stderr.write(`Unknown flag: ${args[i]}\n`);
        process.exit(1);
    }
  }
  return opts;
}

function showHelp() {
  const text = `
extract-design-tokens.mjs - Extract design tokens from JSON-LD in HTML

USAGE
  node scripts/extract-design-tokens.mjs [options]

OPTIONS
  --path <path>      Path to HTML file (default: data/samples/design-system.html)
  --section <name>   Extract one section: color, typography, spacing, radius,
                     shadow, breakpoints, transition, components, or all (default: all)
  --json             Output raw JSON (for piping)
  --pretty           Pretty-print terminal output (default if no --json).
                     Color tokens display their full scale (50-950) underneath.
  --env              Output as env vars: DSP_COLOR_PRIMARY=#6366f1
                     (scale entries: DSP_COLOR_PRIMARY_50=#eef2ff, etc.)
  --css              Output as CSS custom properties: --ds-color-primary: #6366f1;
                     (scale entries: --ds-color-primary-50: #eef2ff;, etc.)
  --validate         Cross-reference JSON-LD against CSS custom properties in HTML
  --help, -h         Show this help

EXIT CODES
  1  File not found
  2  No JSON-LD block found
  3  JSON parse error
`.trim();
  process.stdout.write(text + '\n');
}

function extractJsonLd(html) {
  const match = html.match(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/);
  if (!match) {
    process.stderr.write('Error: No JSON-LD block found in HTML file\n');
    process.exit(2);
  }
  try {
    return JSON.parse(match[1]);
  } catch (err) {
    process.stderr.write(`Error: Failed to parse JSON-LD: ${err.message}\n`);
    process.exit(3);
  }
}

function extractCssVars(html) {
  const vars = new Map();
  const styleMatch = html.match(/<style>([\s\S]*?)<\/style>/);
  if (!styleMatch) return vars;
  const css = styleMatch[1];
  const propRegex = /(--ds-[\w-]+)\s*:\s*([^;]+)/g;
  let m;
  while ((m = propRegex.exec(css)) !== null) {
    vars.set(m[1], m[2].trim());
  }
  return vars;
}

function normalizeForCompare(val) {
  return String(val)
    .replace(/\s+/g, ' ')
    .replace(/,\s*/g, ',')
    .trim();
}

function toEnvKey(cssVar) {
  return 'DSP_' + cssVar.replace(/^--ds-/, '').replace(/-/g, '_').toUpperCase();
}

function flattenTokens(obj, prefix = '') {
  const result = {};
  for (const [key, val] of Object.entries(obj)) {
    const fullKey = prefix ? `${prefix}-${key}` : key;
    if (val && typeof val === 'object' && !Array.isArray(val)) {
      if (val.value !== undefined && val.cssVar) {
        result[val.cssVar] = val.value;
        for (const [subKey, subVal] of Object.entries(val)) {
          if (subKey !== 'value' && subKey !== 'cssVar' && subKey !== 'usage' && subKey !== 'px') {
            if (subVal && typeof subVal === 'object' && !Array.isArray(subVal)) {
              Object.assign(result, flattenTokens(subVal, fullKey));
            }
          }
        }
      } else if (val.value !== undefined) {
        result[fullKey] = val.value;
      } else {
        Object.assign(result, flattenTokens(val, fullKey));
      }
    }
  }
  return result;
}

function flattenComponents(obj) {
  const result = {};
  for (const [compName, comp] of Object.entries(obj)) {
    if (comp.tokens) {
      for (const [prop, val] of Object.entries(comp.tokens)) {
        const key = `--ds-comp-${compName}-${prop}`;
        result[key] = val;
      }
    }
    for (const [k, v] of Object.entries(comp)) {
      if (k === 'tokens') continue;
      if (Array.isArray(v)) {
        result[`--ds-comp-${compName}-${k}`] = v.join(', ');
      }
    }
  }
  return result;
}

function getSectionData(designSystem, section) {
  if (section === 'all') return designSystem;
  if (section === 'components') return { components: designSystem.components };
  if (designSystem.tokens[section]) return { tokens: { [section]: designSystem.tokens[section] } };
  process.stderr.write(`Error: Unknown section "${section}". Valid: ${SECTIONS.join(', ')}\n`);
  process.exit(1);
}

function formatPretty(data, meta) {
  const lines = [];
  lines.push(`Design System v${meta.version}`);
  lines.push('');

  if (data.tokens) {
    for (const [category, tokens] of Object.entries(data.tokens)) {
      lines.push(`${capitalize(category)} Tokens`);
      formatTokenGroup(tokens, '  ', lines);
      lines.push('');
    }
  }

  if (data.components) {
    lines.push('Components');
    for (const [name, comp] of Object.entries(data.components)) {
      lines.push(`  ${capitalize(name)}`);
      for (const [key, val] of Object.entries(comp)) {
        if (key === 'tokens') {
          lines.push(`    tokens:`);
          for (const [tk, tv] of Object.entries(val)) {
            lines.push(`      ${tk}: ${tv}`);
          }
        } else if (Array.isArray(val)) {
          lines.push(`    ${key}: ${val.join(', ')}`);
        } else {
          lines.push(`    ${key}: ${val}`);
        }
      }
    }
    lines.push('');
  }

  return lines.join('\n');
}

function formatTokenGroup(tokens, indent, lines) {
  for (const [key, val] of Object.entries(tokens)) {
    if (val && typeof val === 'object' && !Array.isArray(val)) {
      if (val.value !== undefined && val.cssVar) {
        const extra = val.px ? ` (${val.px})` : '';
        const usage = val.usage ? ` - ${val.usage}` : '';
        lines.push(`${indent}${key.padEnd(20)} ${String(val.value).padEnd(16)} (${val.cssVar})${extra}${usage}`);
        if (val.scale && typeof val.scale === 'object') {
          lines.push(`${indent}  scale:`);
          for (const [step, stepVal] of Object.entries(val.scale)) {
            if (stepVal && stepVal.value) {
              const marker = step === '500' ? ' <- base' : '';
              lines.push(`${indent}    ${step.padEnd(4)} ${String(stepVal.value).padEnd(9)} (${stepVal.cssVar})${marker}`);
            }
          }
        }
      } else if (val.value !== undefined) {
        lines.push(`${indent}${key}: ${val.value}`);
      } else {
        lines.push(`${indent}${key}:`);
        formatTokenGroup(val, indent + '  ', lines);
      }
    }
  }
}

function capitalize(s) {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

function outputJson(data) {
  process.stdout.write(JSON.stringify(data, null, 2) + '\n');
}

function outputEnv(data) {
  const allVars = {};
  if (data.tokens) {
    for (const tokens of Object.values(data.tokens)) {
      Object.assign(allVars, flattenTokens(tokens));
    }
  }
  if (data.components) {
    Object.assign(allVars, flattenComponents(data.components));
  }
  for (const [cssVar, value] of Object.entries(allVars)) {
    process.stdout.write(`${toEnvKey(cssVar)}=${value}\n`);
  }
}

function outputCss(data) {
  const allVars = {};
  if (data.tokens) {
    for (const tokens of Object.values(data.tokens)) {
      Object.assign(allVars, flattenTokens(tokens));
    }
  }
  if (data.components) {
    Object.assign(allVars, flattenComponents(data.components));
  }
  process.stdout.write(':root {\n');
  for (const [cssVar, value] of Object.entries(allVars)) {
    process.stdout.write(`  ${cssVar}: ${value};\n`);
  }
  process.stdout.write('}\n');
}

function validate(data, html) {
  const cssVars = extractCssVars(html);
  const jsonVars = {};

  if (data.tokens) {
    for (const tokens of Object.values(data.tokens)) {
      Object.assign(jsonVars, flattenTokens(tokens));
    }
  }

  let mismatches = 0;
  let matched = 0;
  let missingInCss = 0;
  const mismatchLines = [];

  for (const [cssVar, jsonVal] of Object.entries(jsonVars)) {
    const normalizedJson = normalizeForCompare(jsonVal);
    const cssVal = cssVars.get(cssVar);

    if (cssVal === undefined) {
      missingInCss++;
      mismatchLines.push(`  MISSING in CSS: ${cssVar} (JSON-LD has: ${jsonVal})`);
      continue;
    }

    const normalizedCss = normalizeForCompare(cssVal);
    if (normalizedJson !== normalizedCss) {
      mismatches++;
      mismatchLines.push(`  MISMATCH: ${cssVar}`);
      mismatchLines.push(`    JSON-LD: ${jsonVal}`);
      mismatchLines.push(`    CSS:     ${cssVal}`);
    } else {
      matched++;
    }
  }

  let missingInJson = 0;
  for (const cssVar of cssVars.keys()) {
    if (!(cssVar in jsonVars)) {
      missingInJson++;
      mismatchLines.push(`  MISSING in JSON-LD: ${cssVar} (CSS has: ${cssVars.get(cssVar)})`);
    }
  }

  const lines = [];
  lines.push('Validation Report');
  lines.push(`  Matched:        ${matched}`);
  lines.push(`  Mismatches:     ${mismatches}`);
  lines.push(`  Missing in CSS: ${missingInCss}`);
  lines.push(`  Missing in JSON-LD: ${missingInJson}`);
  lines.push('');

  if (mismatchLines.length > 0) {
    lines.push('Details:');
    lines.push(...mismatchLines);
  } else {
    lines.push('All values match.');
  }

  process.stdout.write(lines.join('\n') + '\n');

  if (mismatches > 0 || missingInCss > 0 || missingInJson > 0) {
    process.exit(1);
  }
}

function main() {
  const opts = parseArgs(process.argv);

  if (opts.help) {
    showHelp();
    return;
  }

  const filePath = resolve(opts.path);

  if (!existsSync(filePath)) {
    process.stderr.write(`Error: File not found: ${filePath}\n`);
    process.exit(1);
  }

  const html = readFileSync(filePath, 'utf-8');
  const jsonLd = extractJsonLd(html);
  const meta = { version: jsonLd.version || '0.0.0', name: jsonLd.name || 'Design System' };
  const designSystem = jsonLd.designSystem;

  if (!designSystem) {
    process.stderr.write('Error: JSON-LD has no "designSystem" property\n');
    process.exit(3);
  }

  if (opts.validate) {
    validate(designSystem, html);
    return;
  }

  const sectionData = getSectionData(designSystem, opts.section);

  if (opts.json) {
    outputJson(sectionData);
  } else if (opts.env) {
    outputEnv(sectionData);
  } else if (opts.css) {
    outputCss(sectionData);
  } else {
    process.stdout.write(formatPretty(sectionData, meta) + '\n');
  }
}

main();
