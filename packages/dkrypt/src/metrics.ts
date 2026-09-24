interface MetricLabels {
  [key: string]: string | number | boolean | undefined;
}

interface MetricValue {
  name: string;
  labels: Record<string, string>;
  value: number;
}

const counters = new Map<string, MetricValue>();
const histograms = new Map<string, { count: number; sum: number }>();
const counterNames = new Set<string>();

function normalizedLabels(labels: MetricLabels): Record<string, string> {
  return Object.fromEntries(Object.entries(labels).filter(([, value]) => value !== undefined).map(([key, value]) => [key, String(value)]).sort(([a], [b]) => a.localeCompare(b)));
}

function key(name: string, labels: Record<string, string>): string {
  return `${name}:${JSON.stringify(labels)}`;
}

function escapeLabel(value: string): string {
  return value.replaceAll('\\', '\\\\').replaceAll('"', '\\"').replaceAll('\n', '\\n');
}

function labelText(labels: Record<string, string>): string {
  const values = Object.entries(labels).map(([name, value]) => `${name}="${escapeLabel(value)}"`);
  return values.length > 0 ? `{${values.join(',')}}` : '';
}

export function incrementMetric(name: string, labels: MetricLabels = {}, amount = 1): void {
  counterNames.add(name);
  const normalized = normalizedLabels(labels);
  const metricKey = key(name, normalized);
  const current = counters.get(metricKey);
  if (current) current.value += amount;
  else counters.set(metricKey, { name, labels: normalized, value: amount });
}

export function observeMetric(name: string, value: number): void {
  const current = histograms.get(name) ?? { count: 0, sum: 0 };
  current.count += 1;
  current.sum += value;
  histograms.set(name, current);
}

export function renderMetrics(): string {
  const lines: string[] = [];
  for (const name of counterNames) lines.push(`# TYPE dkrypt_${name} counter`);
  for (const metric of counters.values()) lines.push(`dkrypt_${metric.name}${labelText(metric.labels)} ${metric.value}`);
  for (const [name, metric] of histograms) {
    lines.push(`# TYPE dkrypt_${name} summary`);
    lines.push(`dkrypt_${name}_count ${metric.count}`);
    lines.push(`dkrypt_${name}_sum ${metric.sum}`);
  }
  return `${lines.join('\n')}\n`;
}

export function resetMetrics(): void {
  counters.clear();
  histograms.clear();
  counterNames.clear();
}
