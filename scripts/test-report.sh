#!/usr/bin/env bash
set -euo pipefail

LOG_COMPONENT=test-report
. "${LOGGER_PATH:-scripts/lib/logger.sh}"

REPORT_DIR="${REPORT_DIR:-reports}"
REPORT_FILE="${REPORT_FILE:-}"

if [[ -z "$REPORT_FILE" ]]; then
  timestamp="$(date -u '+%Y%m%dT%H%M%SZ')"
  REPORT_FILE="$REPORT_DIR/test-report-$timestamp.md"
fi

json_file="$(mktemp)"
cleanup() {
  rm -f "$json_file"
}
trap cleanup EXIT

mkdir -p "$(dirname "$REPORT_FILE")"

log_phase "running test suite"
set +e
npm test -- --reporter=json --outputFile="$json_file"
test_status="$?"
set -e

log_phase "writing report"
node - "$json_file" "$REPORT_FILE" "$test_status" <<'NODE'
const fs = require('node:fs');

const [jsonPath, reportPath, statusText] = process.argv.slice(2);
const statusCode = Number(statusText);
const report = JSON.parse(fs.readFileSync(jsonPath, 'utf8'));

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
const generatedAt = new Date().toISOString();

const lines = [
  '# Test Report',
  '',
  `Generated: ${generatedAt}`,
  `Command: npm test -- --reporter=json --outputFile=<temp>`,
  `Exit code: ${statusCode}`,
  '',
  '## Summary',
  '',
  `- Test files: ${suites.length}`,
  `- Tests: ${assertions.length}`,
  `- Passed: ${passed}`,
  `- Failed: ${failed}`,
  `- Pending/other: ${pending}`,
  `- Suite runtime total: ${formatMs(totalDuration)}`,
  '',
  '## Test Files',
  '',
  '| Status | File | Duration | Tests |',
  '|---|---|---:|---:|'
];

for (const suite of suites) {
  const tests = suite.assertionResults ?? [];
  const duration = Number.isFinite(suite.endTime) && Number.isFinite(suite.startTime)
    ? suite.endTime - suite.startTime
    : suite.perfStats?.runtime;

  lines.push(`| ${statusIcon(suite.status)} | ${suite.name} | ${formatMs(duration)} | ${tests.length} |`);
}

lines.push(
  '',
  '## Tests',
  '',
  '| Status | Duration | Test |',
  '|---|---:|---|'
);

for (const test of assertions.toSorted((a, b) => (b.duration ?? 0) - (a.duration ?? 0))) {
  lines.push(`| ${statusIcon(test.status)} | ${formatMs(test.duration)} | ${test.title.replaceAll('|', '\\|')} |`);
}

fs.writeFileSync(reportPath, `${lines.join('\n')}\n`);
NODE

log_info "report written to $REPORT_FILE"
printf '%s\n' "$REPORT_FILE"

exit "$test_status"
