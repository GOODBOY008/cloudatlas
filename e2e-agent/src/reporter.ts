/**
 * HTML + JSON reporter.
 * Generates a self-contained HTML report (screenshots embedded as data URIs)
 * and a machine-readable JSON summary.
 */

import * as fs from 'fs';
import * as path from 'path';
import type { TestResult, SuiteResult } from './types.js';

// ─── Public API ──────────────────────────────────────────────────────────────

export function generateReport(
  results: TestResult[],
  reportsDir: string,
  screenshotsDir: string,
): { htmlPath: string; jsonPath: string } {
  fs.mkdirSync(reportsDir, { recursive: true });

  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const htmlPath = path.join(reportsDir, `report-${timestamp}.html`);
  const latestPath = path.join(reportsDir, 'latest.html');
  const jsonPath = path.join(reportsDir, `results-${timestamp}.json`);

  const suites = groupBySuite(results);
  const html = buildHtml(suites, timestamp, screenshotsDir);

  fs.writeFileSync(htmlPath, html, 'utf-8');
  fs.writeFileSync(latestPath, html, 'utf-8');
  fs.writeFileSync(jsonPath, JSON.stringify(buildJson(results, timestamp), null, 2), 'utf-8');

  return { htmlPath: latestPath, jsonPath };
}

export function printSummary(results: TestResult[]): void {
  const passed = results.filter(r => r.status === 'passed').length;
  const failed = results.filter(r => r.status === 'failed').length;
  const errors = results.filter(r => r.status === 'error').length;
  const total = results.length;
  const totalMs = results.reduce((a, r) => a + r.durationMs, 0);

  console.log('\n' + '═'.repeat(60));
  console.log('  AI Agent E2E Test Results');
  console.log('═'.repeat(60));
  console.log(`  Total:   ${total} scenarios  (${(totalMs / 1000).toFixed(1)}s)`);
  console.log(`  ✓ Pass:  ${passed}`);
  if (failed > 0) console.log(`  ✗ Fail:  ${failed}`);
  if (errors > 0) console.log(`  ⚠ Error: ${errors}`);
  console.log('═'.repeat(60));

  for (const r of results) {
    const icon = r.status === 'passed' ? '✓' : r.status === 'failed' ? '✗' : '⚠';
    const ms = `${(r.durationMs / 1000).toFixed(1)}s`;
    console.log(`  ${icon} [${r.scenario.id}] ${r.scenario.name} (${ms})`);
    if (r.status !== 'passed') {
      console.log(`      → ${r.failureReason ?? r.summary}`);
    }
  }
  console.log('');
}

// ─── Internals ───────────────────────────────────────────────────────────────

function groupBySuite(results: TestResult[]): SuiteResult[] {
  const map = new Map<string, TestResult[]>();
  for (const r of results) {
    const suite = r.scenario.suite;
    if (!map.has(suite)) map.set(suite, []);
    map.get(suite)!.push(r);
  }
  return [...map.entries()].map(([suiteName, suiteResults]) => ({
    suiteName,
    results: suiteResults,
    totalMs: suiteResults.reduce((a, r) => a + r.durationMs, 0),
    passed: suiteResults.filter(r => r.status === 'passed').length,
    failed: suiteResults.filter(r => r.status === 'failed').length,
    errors: suiteResults.filter(r => r.status === 'error').length,
    skipped: suiteResults.filter(r => r.status === 'skipped').length,
  }));
}

function buildJson(results: TestResult[], timestamp: string) {
  const passed = results.filter(r => r.status === 'passed').length;
  const failed = results.filter(r => r.status === 'failed').length;
  return {
    timestamp,
    total: results.length,
    passed,
    failed,
    errors: results.filter(r => r.status === 'error').length,
    durationMs: results.reduce((a, r) => a + r.durationMs, 0),
    scenarios: results.map(r => ({
      id: r.scenario.id,
      name: r.scenario.name,
      suite: r.scenario.suite,
      status: r.status,
      summary: r.summary,
      failureReason: r.failureReason,
      durationMs: r.durationMs,
      steps: r.steps.length,
      screenshots: r.screenshotPaths.length,
    })),
  };
}

function statusBadge(status: string): string {
  const map: Record<string, [string, string]> = {
    passed: ['#22c55e', 'PASS'],
    failed: ['#ef4444', 'FAIL'],
    error: ['#f97316', 'ERROR'],
    skipped: ['#6b7280', 'SKIP'],
  };
  const [color, label] = map[status] ?? ['#6b7280', status.toUpperCase()];
  return `<span style="background:${color};color:#fff;padding:2px 8px;border-radius:4px;font-size:11px;font-weight:700">${label}</span>`;
}

function embedScreenshots(paths: string[]): string {
  if (paths.length === 0) return '';
  const imgs = paths
    .filter(p => fs.existsSync(p))
    .map(p => {
      const b64 = fs.readFileSync(p).toString('base64');
      const name = path.basename(p);
      return `<figure style="margin:6px 0">
        <img src="data:image/png;base64,${b64}" alt="${name}"
             style="max-width:100%;border:1px solid #333;border-radius:4px;cursor:pointer"
             onclick="this.style.maxWidth=this.style.maxWidth==='100%'?'none':'100%'"/>
        <figcaption style="font-size:10px;color:#888;margin-top:2px">${name}</figcaption>
      </figure>`;
    })
    .join('\n');
  return `<div class="screenshots">${imgs}</div>`;
}

function renderStep(step: { tool: string; input: object; result: string; timestamp: number }, idx: number): string {
  const inputStr = JSON.stringify(step.input).slice(0, 120);
  const isAssert = step.tool.startsWith('assert_');
  const isPass = step.result.startsWith('✓');
  const rowColor = isAssert ? (isPass ? '#14532d' : '#450a0a') : 'transparent';
  return `<tr style="background:${rowColor}">
    <td style="color:#888;padding:3px 8px;white-space:nowrap">${idx + 1}</td>
    <td style="padding:3px 8px;color:#a78bfa;white-space:nowrap">${step.tool}</td>
    <td style="padding:3px 8px;color:#9ca3af;font-family:monospace;font-size:11px">${htmlEsc(inputStr)}</td>
    <td style="padding:3px 8px;color:#d1d5db;font-size:11px">${htmlEsc(step.result.slice(0, 200))}</td>
  </tr>`;
}

function htmlEsc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function buildHtml(suites: SuiteResult[], timestamp: string, _screenshotsDir: string): string {
  const totalPassed = suites.reduce((a, s) => a + s.passed, 0);
  const totalFailed = suites.reduce((a, s) => a + s.failed, 0);
  const totalErrors = suites.reduce((a, s) => a + s.errors, 0);
  const totalCount = suites.reduce((a, s) => a + s.results.length, 0);
  const totalMs = suites.reduce((a, s) => a + s.totalMs, 0);
  const passRate = totalCount > 0 ? Math.round((totalPassed / totalCount) * 100) : 0;

  const suiteHtml = suites.map(suite => {
    const scenarioHtml = suite.results.map((r, _i) => {
      const stepsHtml = r.steps.map((s, si) => renderStep(s, si)).join('\n');
      const id = `scenario-${r.scenario.id.replace(/[^a-z0-9]/gi, '-')}`;
      return `
      <div class="scenario" id="${id}" style="border:1px solid #374151;border-radius:8px;margin:8px 0;overflow:hidden">
        <div style="padding:12px 16px;background:#1f2937;display:flex;justify-content:space-between;align-items:center;cursor:pointer"
             onclick="toggle('${id}-body')">
          <div>
            <span style="color:#9ca3af;font-size:12px;margin-right:8px">${htmlEsc(r.scenario.id)}</span>
            <span style="font-weight:600">${htmlEsc(r.scenario.name)}</span>
          </div>
          <div style="display:flex;align-items:center;gap:12px">
            <span style="color:#6b7280;font-size:12px">${(r.durationMs / 1000).toFixed(1)}s · ${r.steps.length} steps</span>
            ${statusBadge(r.status)}
          </div>
        </div>
        <div id="${id}-body" style="display:none;padding:16px;background:#111827">
          <p style="color:#d1d5db;margin:0 0 8px"><strong>Summary:</strong> ${htmlEsc(r.summary)}</p>
          ${r.failureReason ? `<p style="color:#f87171;margin:0 0 8px"><strong>Failure:</strong> ${htmlEsc(r.failureReason)}</p>` : ''}
          <p style="color:#6b7280;font-size:12px;margin:0 0 4px"><strong>Goal:</strong> ${htmlEsc(r.scenario.goal)}</p>
          ${r.steps.length > 0 ? `
          <details style="margin-top:12px">
            <summary style="cursor:pointer;color:#a78bfa;font-size:13px">Steps (${r.steps.length})</summary>
            <table style="width:100%;margin-top:8px;border-collapse:collapse;font-size:12px">
              <thead><tr style="color:#6b7280;text-align:left">
                <th style="padding:3px 8px">#</th><th style="padding:3px 8px">Tool</th>
                <th style="padding:3px 8px">Input</th><th style="padding:3px 8px">Result</th>
              </tr></thead>
              <tbody>${stepsHtml}</tbody>
            </table>
          </details>` : ''}
          ${embedScreenshots(r.screenshotPaths)}
        </div>
      </div>`;
    }).join('\n');

    const suiteIcon = suite.failed + suite.errors > 0 ? '✗' : '✓';
    const suiteColor = suite.failed + suite.errors > 0 ? '#ef4444' : '#22c55e';
    return `
    <section style="margin-bottom:32px">
      <h2 style="font-size:16px;font-weight:700;color:${suiteColor};margin:0 0 12px;display:flex;align-items:center;gap:8px">
        <span>${suiteIcon}</span>
        <span style="text-transform:capitalize">${htmlEsc(suite.suiteName)}</span>
        <span style="font-weight:400;color:#6b7280;font-size:13px">
          ${suite.passed}/${suite.results.length} passed · ${(suite.totalMs / 1000).toFixed(1)}s
        </span>
      </h2>
      ${scenarioHtml}
    </section>`;
  }).join('\n');

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8"/>
  <meta name="viewport" content="width=device-width,initial-scale=1"/>
  <title>CloudAtlas AI Agent E2E Report</title>
  <style>
    * { box-sizing: border-box; }
    body { font-family: -apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;
           background: #030712; color: #f9fafb; margin: 0; padding: 24px; }
    a { color: #818cf8; }
    details summary { list-style: none; }
    details summary::-webkit-details-marker { display: none; }
  </style>
  <script>
    function toggle(id) {
      var el = document.getElementById(id);
      el.style.display = el.style.display === 'none' ? 'block' : 'none';
    }
    function expandAll() {
      document.querySelectorAll('[id$="-body"]').forEach(e => e.style.display = 'block');
    }
    function collapseAll() {
      document.querySelectorAll('[id$="-body"]').forEach(e => e.style.display = 'none');
    }
  </script>
</head>
<body>
  <header style="margin-bottom:32px">
    <div style="display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:12px">
      <div>
        <h1 style="font-size:22px;font-weight:800;margin:0;color:#6366f1">
          ☁ CloudAtlas — AI Agent E2E Report
        </h1>
        <p style="color:#6b7280;margin:4px 0 0;font-size:13px">
          Generated ${new Date(timestamp.replace(/-/g, ':')).toLocaleString()} ·
          Model: Claude · ${(totalMs / 1000).toFixed(1)}s total
        </p>
      </div>
      <div style="display:flex;gap:8px">
        <button onclick="expandAll()" style="background:#374151;border:none;color:#d1d5db;padding:6px 12px;border-radius:6px;cursor:pointer;font-size:12px">Expand All</button>
        <button onclick="collapseAll()" style="background:#374151;border:none;color:#d1d5db;padding:6px 12px;border-radius:6px;cursor:pointer;font-size:12px">Collapse All</button>
      </div>
    </div>

    <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(120px,1fr));gap:12px;margin-top:20px">
      ${statCard('Total', totalCount, '#6366f1')}
      ${statCard('Passed', totalPassed, '#22c55e')}
      ${statCard('Failed', totalFailed, '#ef4444')}
      ${statCard('Errors', totalErrors, '#f97316')}
      ${statCard('Pass Rate', passRate + '%', passRate >= 80 ? '#22c55e' : '#ef4444')}
    </div>
  </header>

  <main>${suiteHtml}</main>
</body>
</html>`;
}

function statCard(label: string, value: number | string, color: string): string {
  return `<div style="background:#111827;border:1px solid #1f2937;border-radius:8px;padding:16px;text-align:center">
    <div style="font-size:28px;font-weight:800;color:${color}">${value}</div>
    <div style="font-size:12px;color:#6b7280;margin-top:4px">${label}</div>
  </div>`;
}
