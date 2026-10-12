#!/usr/bin/env node
// Keeps the agent skill small. Fails when SKILL.md, one of its bullets, its description or a
// reference file grows past its limit. Run: npm run check:skill
//
// Rationale: SKILL.md is loaded on every ABAP task, so every word costs context each time.
// History, evidence and long procedures belong in references/, CLAUDE.md or TODO.md.
const fs = require('fs');
const path = require('path');

const LIMITS = { body: 1100, bullet: 40, description: 400, reference: 2200 };
const dir = path.join(__dirname, '..', '.claude', 'skills', 'mcp-abap-adt');
const words = (t) => (t.match(/\S+/g) || []).length;
const problems = [];

const skill = fs.readFileSync(path.join(dir, 'SKILL.md'), 'utf8');
const m = skill.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
if (!m) { console.error('SKILL.md has no frontmatter'); process.exit(1); }
const [, front, body] = m;

const desc = (front.match(/description:\s*>-?\n((?:[ \t]+.*\n?)+)/) || [, ''])[1]
  .split('\n').map((l) => l.trim()).filter(Boolean).join(' ');
if (desc.length > LIMITS.description) problems.push(`description is ${desc.length} characters (max ${LIMITS.description})`);

const bodyWords = words(body);
if (bodyWords > LIMITS.body) problems.push(`SKILL.md body is ${bodyWords} words (max ${LIMITS.body})`);

// A bullet or numbered item = a line starting "- " / "1. " plus its indented continuation lines.
let cur = null;
const flush = () => { if (cur && words(cur.text) > LIMITS.bullet) problems.push(`item at SKILL.md body line ${cur.line} is ${words(cur.text)} words (max ${LIMITS.bullet}): ${cur.text.slice(0, 60)}…`); cur = null; };
body.split('\n').forEach((line, i) => {
  if (/^(- |\d+\. )/.test(line)) { flush(); cur = { line: i + 1, text: line }; }
  else if (cur && /^\s+\S/.test(line)) cur.text += ' ' + line.trim();
  else flush();
});
flush();

const refDir = path.join(dir, 'references');
for (const f of fs.readdirSync(refDir).filter((x) => x.endsWith('.md'))) {
  const n = words(fs.readFileSync(path.join(refDir, f), 'utf8'));
  if (n > LIMITS.reference) problems.push(`references/${f} is ${n} words (max ${LIMITS.reference})`);
}

console.log(`SKILL.md body ${bodyWords}/${LIMITS.body} words, description ${desc.length}/${LIMITS.description} characters`);
if (problems.length) { console.error('\nSkill over budget:\n- ' + problems.join('\n- ')); process.exit(1); }
console.log('Skill within budget.');
