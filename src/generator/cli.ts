// Reads ./specs/*.json and writes one endpoint catalog per module into ./generated.
// Every input schema is round-tripped through Zod here so a spec quirk fails at
// generate time instead of when a client lists tools.
import { readdir, readFile, mkdir, writeFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import { convertSpec, type EndpointDef, type OpenApiSpec } from './openapi.ts';

const ROOT = path.resolve(import.meta.dirname, '..', '..');
const SPEC_DIR = path.join(ROOT, 'specs');
const OUT_DIR = path.join(ROOT, 'generated');

interface ModuleSummary {
  module: string;
  count: number;
  byClass: Record<string, number>;
}

async function readJson<T>(filePath: string): Promise<T> {
  return JSON.parse(await readFile(filePath, 'utf8')) as T;
}

function validateWithZod(endpoint: EndpointDef): string | undefined {
  try {
    z.fromJSONSchema(endpoint.inputSchema as Parameters<typeof z.fromJSONSchema>[0]);
    return undefined;
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}

async function main(): Promise<void> {
  const common = await readJson<OpenApiSpec>(path.join(SPEC_DIR, 'common', 'common-schemas.json'));
  const specFiles = (await readdir(SPEC_DIR)).filter((name) => name.endsWith('.json')).sort();

  await rm(OUT_DIR, { recursive: true, force: true });
  await mkdir(OUT_DIR, { recursive: true });

  const summaries: ModuleSummary[] = [];
  const failures: string[] = [];
  const allNames = new Set<string>();

  for (const file of specFiles) {
    const module = file.replace(/\.json$/, '');
    const spec = await readJson<OpenApiSpec>(path.join(SPEC_DIR, file));
    const endpoints = convertSpec(module, spec, common);

    const byClass: Record<string, number> = {};
    for (const endpoint of endpoints) {
      byClass[endpoint.operationClass] = (byClass[endpoint.operationClass] ?? 0) + 1;
      if (allNames.has(endpoint.name)) failures.push(`${endpoint.name}: duplicate tool name across modules`);
      allNames.add(endpoint.name);
      if (endpoint.name.length > 64) failures.push(`${endpoint.name}: name exceeds 64 chars`);
      const zodError = validateWithZod(endpoint);
      if (zodError) failures.push(`${endpoint.name}: ${zodError}`);
    }

    await writeFile(path.join(OUT_DIR, `${module}.json`), JSON.stringify({ module, endpoints }, null, 2));
    summaries.push({ module, count: endpoints.length, byClass });
  }

  await writeFile(path.join(OUT_DIR, 'index.json'), JSON.stringify({ modules: summaries }, null, 2));

  const total = summaries.reduce((sum, summary) => sum + summary.count, 0);
  console.log(`Generated ${total} endpoints across ${summaries.length} modules -> ${OUT_DIR}`);
  for (const summary of summaries) {
    console.log(`  ${summary.module.padEnd(22)} ${String(summary.count).padStart(3)}  ${JSON.stringify(summary.byClass)}`);
  }
  if (failures.length) {
    console.error(`\n${failures.length} problems:`);
    failures.forEach((failure) => console.error(`  - ${failure}`));
    process.exitCode = 1;
  }
}

await main();
