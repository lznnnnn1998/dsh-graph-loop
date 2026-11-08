#!/usr/bin/env python3
"""Extract criteria-level correctness from one Harbor trial/job directory.

Terminal-Bench reward is binary: any failed verifier criterion writes 0.0, so a
35/37 near-miss and a no-op look identical. This helper records the verifier's
own per-criterion/per-test result alongside the reward. It never invents a
number: a trial with no recognizable verifier report returns `null` totals and
`criteria_source = "unavailable"`.

Usage:
  python3 criteria.py <job-or-trial-dir>   # prints one JSON object
  from criteria import extract_criteria    # import for run-subset.sh
"""

from __future__ import annotations

import json
import re
import sys
from pathlib import Path
from typing import Any


def _trial_dirs(root: Path) -> list[Path]:
    """A Harbor job dir holds one trial dir; a trial dir holds `verifier/`."""
    if (root / 'verifier').is_dir():
        return [root]
    return sorted(path for path in root.iterdir() if path.is_dir() and (path / 'verifier').is_dir())


def _from_reward_details(verifier: Path) -> dict[str, Any] | None:
    path = verifier / 'reward-details.json'
    if not path.is_file():
        return None
    try:
        data = json.loads(path.read_text())
    except (OSError, json.JSONDecodeError):
        return None
    reward = data.get('reward') if isinstance(data, dict) else None
    criteria = reward.get('criteria') if isinstance(reward, dict) else None
    if not isinstance(criteria, list) or not criteria:
        return None
    passed = 0
    failed: list[dict[str, Any]] = []
    for entry in criteria:
        if not isinstance(entry, dict):
            continue
        value = entry.get('value')
        raw = entry.get('raw')
        ok = value == 1.0 or raw is True
        if ok:
            passed += 1
        else:
            failed.append({
                'name': entry.get('name'),
                'value': value,
                'description': entry.get('description'),
            })
    return {
        'criteria_passed': passed,
        'criteria_total': len(criteria),
        'criteria_failed': failed,
        'criteria_source': 'reward-details.json',
    }


def _from_ctrf(verifier: Path) -> dict[str, Any] | None:
    path = verifier / 'ctrf.json'
    if not path.is_file():
        return None
    try:
        data = json.loads(path.read_text())
    except (OSError, json.JSONDecodeError):
        return None
    results = data.get('results') if isinstance(data, dict) else None
    tests = results.get('tests') if isinstance(results, dict) else None
    if not isinstance(tests, list) or not tests:
        return None
    passed = sum(1 for test in tests if isinstance(test, dict) and test.get('status') == 'passed')
    failed = [
        {'name': test.get('name'), 'message': (test.get('message') or '')[:500]}
        for test in tests
        if isinstance(test, dict) and test.get('status') != 'passed'
    ]
    return {
        'criteria_passed': passed,
        'criteria_total': len(tests),
        'criteria_failed': failed,
        'criteria_source': 'ctrf.json',
    }


_PYTEST_SUMMARY = re.compile(
    r'(?P<passed>\d+)\s+passed(?:,\s*(?P<failed>\d+)\s+failed)?'
    r'(?:,\s*(?P<errors>\d+)\s+error(?:s)?)?'
    r'(?:,\s*(?P<skipped>\d+)\s+skipped)?'
)


def _from_pytest_stdout(verifier: Path) -> dict[str, Any] | None:
    path = verifier / 'test-stdout.txt'
    if not path.is_file():
        return None
    try:
        text = path.read_text(errors='replace')
    except OSError:
        return None
    matches = list(_PYTEST_SUMMARY.finditer(text))
    if not matches:
        return None
    last = matches[-1]
    passed = int(last.group('passed'))
    failed = int(last.group('failed') or 0)
    errors = int(last.group('errors') or 0)
    total = passed + failed + errors
    if total == 0:
        return None
    return {
        'criteria_passed': passed,
        'criteria_total': total,
        'criteria_failed': [],
        'criteria_source': 'pytest-stdout',
        'criteria_note': f'{failed} failed, {errors} error(s) in the pytest summary; names are not in stdout',
    }


def _from_playwright(verifier: Path) -> dict[str, Any] | None:
    path = verifier / 'playwright-report.json'
    if not path.is_file():
        return None
    try:
        data = json.loads(path.read_text())
    except (OSError, json.JSONDecodeError):
        return None
    stats = data.get('stats') if isinstance(data, dict) else None
    if not isinstance(stats, dict):
        return None
    expected = int(stats.get('expected') or 0)
    unexpected = int(stats.get('unexpected') or 0)
    flaky = int(stats.get('flaky') or 0)
    total = expected + unexpected + flaky
    if total == 0:
        return None
    return {
        'criteria_passed': expected,
        'criteria_total': total,
        'criteria_failed': [],
        'criteria_source': 'playwright-report.json',
        'criteria_note': f'{unexpected} unexpected, {flaky} flaky; test names are not in the summary',
    }


def extract_criteria(root: str | Path) -> dict[str, Any]:
    """Best available criteria result for one trial/job directory."""
    root = Path(root)
    trials = _trial_dirs(root)
    if not trials:
        return {'criteria_passed': None, 'criteria_total': None, 'criteria_failed': [], 'criteria_source': 'unavailable'}
    # One trial is the norm. If a retry produced several, aggregate by summing
    # only when every trial exposes the same report kind; otherwise use the
    # first trial and say so.
    reports = []
    for trial in trials:
        verifier = trial / 'verifier'
        report = (
            _from_reward_details(verifier)
            or _from_ctrf(verifier)
            or _from_pytest_stdout(verifier)
            or _from_playwright(verifier)
        )
        if report is not None:
            reports.append(report)
    if not reports:
        return {'criteria_passed': None, 'criteria_total': None, 'criteria_failed': [], 'criteria_source': 'unavailable'}
    def attach_tests(report: dict[str, Any], verifier: Path) -> dict[str, Any]:
        # A rubric report may include a meta criterion (e.g.
        # `pytest_completed_successfully`) that is not a test. Keep the executed
        # test count separately so the evaluator can report both.
        if report['criteria_source'] == 'ctrf.json':
            return report
        tests = _from_ctrf(verifier)
        if tests is None:
            return report
        return {
            **report,
            'tests_passed': tests['criteria_passed'],
            'tests_total': tests['criteria_total'],
            'tests_failed': tests['criteria_failed'][:50],
            'tests_source': 'ctrf.json',
        }

    if len(reports) == 1:
        return attach_tests(reports[0], trials[0] / 'verifier')
    sources = {report['criteria_source'] for report in reports}
    if len(sources) == 1:
        return {
            'criteria_passed': sum(report['criteria_passed'] for report in reports),
            'criteria_total': sum(report['criteria_total'] for report in reports),
            'criteria_failed': [item for report in reports for item in report['criteria_failed']],
            'criteria_source': f"{reports[0]['criteria_source']} (summed over {len(reports)} trials)",
        }
    first = reports[0]
    return {**attach_tests(first, trials[0] / 'verifier'), 'criteria_note': f'{len(reports)} trials with mixed reports; showing the first'}


def main(argv: list[str]) -> int:
    if len(argv) != 2:
        print(__doc__, file=sys.stderr)
        return 2
    print(json.dumps(extract_criteria(argv[1]), indent=2))
    return 0


if __name__ == '__main__':
    raise SystemExit(main(sys.argv))
