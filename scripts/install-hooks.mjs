#!/usr/bin/env node
/**
 * Points git at the versioned hooks in .githooks/. Runs automatically after
 * `npm install` (the "prepare" script), so the privacy guard is active from
 * the first commit on any clone without a manual step.
 *
 * Exits quietly where there is no repository (a Docker build, an npm tarball).
 */
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';

if (existsSync('.git') && existsSync('.githooks')) {
  try {
    execFileSync('git', ['config', 'core.hooksPath', '.githooks'], { stdio: 'ignore' });
    console.log('git hooks installed: privacy-guard runs before every commit and push');
  } catch {
    console.warn('Could not install git hooks. Run: git config core.hooksPath .githooks');
  }
}
