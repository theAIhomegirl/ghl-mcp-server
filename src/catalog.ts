import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import type { EndpointDef } from './generator/openapi.ts';

interface GeneratedIndex {
  modules: Array<{ module: string; count: number }>;
}

interface GeneratedModule {
  module: string;
  endpoints: EndpointDef[];
}

// This file runs from src/ (tsx/strip-types) and from dist/src/ (compiled), so
// walk upward until the generated catalog is found instead of hardcoding depth.
export function findGeneratedDir(start = import.meta.dirname): string {
  let current = start;
  for (let hop = 0; hop < 5; hop += 1) {
    const candidate = path.join(current, 'generated', 'index.json');
    if (existsSync(candidate)) return path.dirname(candidate);
    current = path.dirname(current);
  }
  throw new Error('generated/index.json not found. Run `npm run specs:fetch && npm run generate` first.');
}

export function listGeneratedModules(generatedDir = findGeneratedDir()): string[] {
  const index = JSON.parse(readFileSync(path.join(generatedDir, 'index.json'), 'utf8')) as GeneratedIndex;
  return index.modules.map((entry) => entry.module);
}

export function loadEndpoints(modules: string[] | 'all', generatedDir = findGeneratedDir()): EndpointDef[] {
  const available = listGeneratedModules(generatedDir);
  const wanted = modules === 'all' ? available : modules;
  const unknown = wanted.filter((name) => !available.includes(name));
  if (unknown.length) {
    throw new Error(`Unknown GHL_MODULES entries: ${unknown.join(', ')}. Available: ${available.join(', ')}`);
  }
  return wanted.flatMap((name) => {
    const file = JSON.parse(readFileSync(path.join(generatedDir, `${name}.json`), 'utf8')) as GeneratedModule;
    return file.endpoints;
  });
}
