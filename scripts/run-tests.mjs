import { spawnSync } from 'node:child_process';
import { readdir } from 'node:fs/promises';
import { relative, resolve } from 'node:path';

const compiledTestsDirectory = resolve('dist', 'tests');

async function discoverTests(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const tests = [];

  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    const entryPath = resolve(directory, entry.name);
    if (entry.isDirectory()) {
      tests.push(...await discoverTests(entryPath));
    } else if (entry.isFile() && entry.name.endsWith('.test.js')) {
      tests.push(relative(process.cwd(), entryPath));
    }
  }

  return tests;
}

let testFiles;
try {
  testFiles = await discoverTests(compiledTestsDirectory);
} catch (error) {
  console.error(`Unable to discover compiled tests in ${compiledTestsDirectory}. Run npm run build first.`);
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}

if (testFiles) {
  if (testFiles.length === 0) {
    console.error(`No compiled *.test.js files found in ${compiledTestsDirectory}.`);
    process.exitCode = 1;
  } else {
    console.log(`Discovered ${testFiles.length} compiled test files:`);
    for (const testFile of testFiles) console.log(`- ${testFile}`);
    const result = spawnSync(process.execPath, ['--test', ...testFiles], { stdio: 'inherit' });
    if (result.error) {
      console.error(result.error.message);
      process.exitCode = 1;
    } else {
      process.exitCode = result.status ?? 1;
    }
  }
}
