#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';

const reportDir = process.env.REPORT_DIR || 'reports';
const reportFile = process.env.REPORT_FILE || join(reportDir, `test-report-${timestamp()}.md`);
const tempDir = mkdtempSync(join(tmpdir(), 'pg-phoenix-report-'));
const jsonFile = join(tempDir, 'vitest.json');

function log(message) {
  process.stderr.write(`${new Date().toISOString()} INFO  [test-report] ${message}\n`);
}

function timestamp() {
  return new Date().toISOString().replaceAll('-', '').replaceAll(':', '').replace(/\.\d{3}Z$/, 'Z');
}

function formatMs(value) {
  if (!Number.isFinite(value)) {
    return 'n/a';
  }

  if (value < 1000) {
    return `${Math.round(value)} ms`;
  }

  return `${(value / 1000).toFixed(2)} s`;
}

function statusIcon(status) {
  return status === 'passed' ? 'PASS' : 'FAIL';
}

function escapeTableText(value) {
  return String(value).replaceAll('|', '\\|');
}

function progressBar(value, maxValue) {
  if (!Number.isFinite(value) || value <= 0 || !Number.isFinite(maxValue) || maxValue <= 0) {
    return '';
  }

  const barWidth = 20;
  const filledWidth = Math.max(1, Math.round((value / maxValue) * barWidth));
  return `[${'#'.repeat(filledWidth)}${'-'.repeat(barWidth - filledWidth)}]`;
}

function formatDurationCell(value, maxValue) {
  const bar = progressBar(value, maxValue);
  return bar ? `${formatMs(value)} \`${bar}\`` : formatMs(value);
}

function buildReport(report, statusCode, elapsedMs) {
  const suites = report.testResults ?? [];
  const assertions = suites.flatMap((suite) =>
    (suite.assertionResults ?? []).map((test) => ({
      file: suite.name,
      title: test.fullName || test.title,
      status: test.status,
      duration: test.duration
    }))
  );

  const totalDuration = suites.reduce((sum, suite) => {
    if (Number.isFinite(suite.endTime) && Number.isFinite(suite.startTime)) {
      return sum + suite.endTime - suite.startTime;
    }

    return sum + (suite.perfStats?.runtime ?? 0);
  }, 0);

  const passed = assertions.filter((test) => test.status === 'passed').length;
  const failed = assertions.filter((test) => test.status === 'failed').length;
  const pending = assertions.length - passed - failed;
  const suiteRows = suites.map((suite) => {
    const tests = suite.assertionResults ?? [];
    const duration = Number.isFinite(suite.endTime) && Number.isFinite(suite.startTime)
      ? suite.endTime - suite.startTime
      : suite.perfStats?.runtime;

    return {
      status: suite.status,
      name: suite.name,
      duration,
      tests: tests.length
    };
  });
  const maxSuiteDuration = Math.max(0, ...suiteRows.map((suite) => suite.duration ?? 0));
  const sortedAssertions = assertions.toSorted((a, b) => (b.duration ?? 0) - (a.duration ?? 0));
  const maxTestDuration = Math.max(0, ...sortedAssertions.map((test) => test.duration ?? 0));

  const lines = [
    '# Test Report',
    '',
    `Generated: ${new Date().toISOString()}`,
    'Command: npm test -- --reporter=json --outputFile=<temp>',
    `Exit code: ${statusCode}`,
    '',
    '## Summary',
    '',
    `- Test files: ${suites.length}`,
    `- Tests: ${assertions.length}`,
    `- Passed: ${passed}`,
    `- Failed: ${failed}`,
    `- Pending/other: ${pending}`,
    `- Wall-clock runtime: ${formatMs(elapsedMs)}`,
    `- Suite runtime total: ${formatMs(totalDuration)}`,
    '',
    '## Test Files',
    '',
    '| Status | File | Duration | Tests |',
    '|---|---|---:|---:|'
  ];

  for (const suite of suiteRows) {
    lines.push(`| ${statusIcon(suite.status)} | ${escapeTableText(suite.name)} | ${formatDurationCell(suite.duration, maxSuiteDuration)} | ${suite.tests} |`);
  }

  lines.push('', '## Tests', '', '| Status | Duration | Test |', '|---|---:|---|');

  for (const test of sortedAssertions) {
    lines.push(`| ${statusIcon(test.status)} | ${formatDurationCell(test.duration, maxTestDuration)} | ${escapeTableText(test.title)} |`);
  }

  return `${lines.join('\n')}\n`;
}

try {
  mkdirSync(dirname(reportFile), { recursive: true });

  log('------ running test suite ------');
  const startedAt = Date.now();
  const npmCommand = process.platform === 'win32' ? 'npm.cmd' : 'npm';
  const result = spawnSync(npmCommand, ['test', '--', '--reporter=json', `--outputFile=${jsonFile}`], {
    stdio: 'inherit'
  });
  const elapsedMs = Date.now() - startedAt;
  const statusCode = result.status ?? 1;

  log('------ writing report ------');
  const report = JSON.parse(readFileSync(jsonFile, 'utf8'));
  writeFileSync(reportFile, buildReport(report, statusCode, elapsedMs));
  log(`report written to ${reportFile}`);
  process.stdout.write(`${reportFile}\n`);
  process.exit(statusCode);
} finally {
  rmSync(tempDir, { recursive: true, force: true });
}
