// Downloads HighLevel's official OpenAPI specs into ./specs so the generator
// works from the same source of truth as the public docs.
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

const REPO = 'GoHighLevel/highlevel-api-docs';
const BRANCH = 'main';
const SPEC_DIR = path.resolve(import.meta.dirname, '..', 'specs');

// GitHub's unauthenticated API allows 60 req/hr; a token lifts that when available.
const headers: Record<string, string> = process.env.GITHUB_TOKEN
  ? { Authorization: `Bearer ${process.env.GITHUB_TOKEN}` }
  : {};

async function listSpecFiles(): Promise<string[]> {
  const res = await fetch(`https://api.github.com/repos/${REPO}/contents/apps?ref=${BRANCH}`, { headers });
  if (!res.ok) throw new Error(`GitHub API ${res.status}: ${await res.text()}`);
  const entries = (await res.json()) as Array<{ name: string; type: string }>;
  return entries.filter((entry) => entry.type === 'file' && entry.name.endsWith('.json')).map((entry) => entry.name);
}

async function download(name: string): Promise<void> {
  const url = `https://raw.githubusercontent.com/${REPO}/${BRANCH}/apps/${name}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${name}: HTTP ${res.status}`);
  await writeFile(path.join(SPEC_DIR, name), await res.text());
}

async function downloadCommonSchemas(): Promise<void> {
  const url = `https://raw.githubusercontent.com/${REPO}/${BRANCH}/common/common-schemas.json`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`common-schemas.json: HTTP ${res.status}`);
  await mkdir(path.join(SPEC_DIR, 'common'), { recursive: true });
  await writeFile(path.join(SPEC_DIR, 'common', 'common-schemas.json'), await res.text());
}

await mkdir(SPEC_DIR, { recursive: true });
const names = await listSpecFiles();
// Every spec $refs ../common/common-schemas.json for shared error DTOs, so it must come along.
await Promise.all([...names.map(download), downloadCommonSchemas()]);
console.log(`Fetched ${names.length} specs (+ common schemas) into ${SPEC_DIR}`);
