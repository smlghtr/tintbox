import { describe, expect, it } from 'vitest';

const ALL_RAW = import.meta.glob<string>('../**/*.ts', {
  query: '?raw',
  import: 'default',
  eager: true,
});

const nonTestEntries = Object.entries(ALL_RAW).filter(([path]) => !path.endsWith('.test.ts'));

describe('architecture boundaries', () => {
  it('core/ never imports outside core/ and uses no DOM globals', () => {
    const coreFiles = nonTestEntries.filter(([p]) => p.startsWith('./') || p.startsWith('../core/'));
    expect(coreFiles.length).toBeGreaterThan(0);
    for (const [file, text] of coreFiles) {
      const imports = [...text.matchAll(/from\s+['"]([^'"]+)['"]/g)].map((m) => m[1]);
      for (const imp of imports) {
        expect(imp, `${file} imports ${imp}`).toMatch(/^\.\//);
      }
      expect(text, `${file} references DOM globals`).not.toMatch(
        /\b(window|document|HTMLElement|HTMLCanvasElement)\b/,
      );
    }
  });

  it('state/ only imports from core/ or state/', () => {
    const stateFiles = nonTestEntries.filter(([p]) => p.startsWith('../state/'));
    expect(stateFiles.length).toBeGreaterThan(0);
    for (const [file, text] of stateFiles) {
      const imports = [...text.matchAll(/from\s+['"]([^'"]+)['"]/g)].map((m) => m[1]);
      for (const imp of imports) {
        expect(imp, `${file} imports ${imp}`).toMatch(/^(\.\/|\.\.\/core\/)/);
      }
    }
  });

  it('non-test source has no any, @ts-ignore, or console.log', () => {
    for (const [file, text] of nonTestEntries) {
      expect(text, `${file} uses any`).not.toMatch(/:\s*any\b|\bas\s+any\b/);
      expect(text, `${file} uses @ts-ignore`).not.toMatch(/@ts-ignore/);
      expect(text, `${file} uses console.log`).not.toMatch(/\bconsole\.log\b/);
    }
  });
});
