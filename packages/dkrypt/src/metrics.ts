type MetricLabelValue = string | number | boolean;

interface MetricLabels {
  [key: string]: MetricLabelValue | undefined;
}

interface MetricValue {
  name: string;
  labels: Record<string, MetricLabelValue>;
  value: number;
}

interface HistogramValue {
  name: string;
  labels: Record<string, MetricLabelValue>;
  count: number;
  sum: number;
  bucketCounts: number[];
}

type OtlpAnyValue = { stringValue: string } | { boolValue: boolean } | { intValue: string } | { doubleValue: number };

interface OtlpMetric {
  name: string;
  unit: string;
  sum?: {
    aggregationTemporality: number;
    isMonotonic: boolean;
    dataPoints: Array<{
      attributes: Array<{ key: string; value: OtlpAnyValue }>;
      startTimeUnixNano: string;
      timeUnixNano: string;
      asInt: string;
    }>;
  };
  histogram?: {
    aggregationTemporality: number;
    dataPoints: Array<{
      attributes: Array<{ key: string; value: OtlpAnyValue }>;
      startTimeUnixNano: string;
      timeUnixNano: string;
      count: string;
      sum: number;
      bucketCounts: string[];
      explicitBounds: number[];
    }>;
  };
  gauge?: {
    dataPoints: Array<{
      attributes: Array<{ key: string; value: OtlpAnyValue }>;
      timeUnixNano: string;
      asDouble: number;
    }>;
  };
}

export interface OtlpMetricsPayload {
  resourceMetrics: Array<{
    resource: { attributes: Array<{ key: string; value: OtlpAnyValue }> };
    scopeMetrics: Array<{ scope: { name: string }; metrics: OtlpMetric[] }>;
  }>;
}

const maxMetricSeries = 2048;
const histogramBounds = [1, 5, 10, 25, 50, 100, 250, 500, 1000, 2500, 5000, 10000, 30000, 60000, 300000, 1800000];
const processStartTimeUnixNano = String(BigInt(Date.now()) * 1_000_000n);
const counters = new Map<string, MetricValue>();
const histograms = new Map<string, HistogramValue>();
const gauges = new Map<string, MetricValue>();
const counterNames = new Set<string>();
let droppedSeriesCount = 0;

function normalizedLabels(labels: MetricLabels): Record<string, MetricLabelValue> {
  return Object.fromEntries(Object.entries(labels).filter(([, value]) => value !== undefined).sort(([a], [b]) => a.localeCompare(b))) as Record<string, MetricLabelValue>;
}

function key(name: string, labels: Record<string, MetricLabelValue>): string {
  return `${name}:${JSON.stringify(labels)}`;
}

function escapeLabel(value: string): string {
  return value.replaceAll('\\', '\\\\').replaceAll('"', '\\"').replaceAll('\n', '\\n');
}

function labelText(labels: Record<string, MetricLabelValue>): string {
  const values = Object.entries(labels).map(([name, value]) => `${name}="${escapeLabel(String(value))}"`);
  return values.length > 0 ? `{${values.join(',')}}` : '';
}

function attributeValue(value: MetricLabelValue): OtlpAnyValue {
  if (typeof value === 'boolean') return { boolValue: value };
  if (typeof value === 'number') return Number.isSafeInteger(value) ? { intValue: String(value) } : { doubleValue: value };
  return { stringValue: value };
}

function attributes(labels: Record<string, MetricLabelValue>): Array<{ key: string; value: OtlpAnyValue }> {
  return Object.entries(labels).map(([key, value]) => ({ key, value: attributeValue(value) }));
}

function metricSeriesCount(): number {
  return counters.size + histograms.size + gauges.size;
}

function bucketIndex(value: number): number {
  const index = histogramBounds.findIndex((bound) => value <= bound);
  return index === -1 ? histogramBounds.length : index;
}

function histogramUnit(name: string): string {
  if (name.endsWith('_ms')) return 'ms';
  if (name.endsWith('_bytes')) return 'By';
  if (name.endsWith('_seconds')) return 's';
  if (name.endsWith('_percent')) return '%';
  return '1';
}

export function incrementMetric(name: string, labels: MetricLabels = {}, amount = 1): void {
  if (!Number.isSafeInteger(amount) || amount <= 0) return;
  counterNames.add(name);
  const normalized = normalizedLabels(labels);
  const metricKey = key(name, normalized);
  const current = counters.get(metricKey);
  if (current) {
    current.value += amount;
    return;
  }
  if (metricSeriesCount() >= maxMetricSeries) {
    droppedSeriesCount += amount;
    return;
  }
  counters.set(metricKey, { name, labels: normalized, value: amount });
}

export function observeMetric(name: string, value: number, labels: MetricLabels = {}): void {
  if (!Number.isFinite(value)) return;
  const normalized = normalizedLabels(labels);
  const metricKey = key(name, normalized);
  const current = histograms.get(metricKey);
  if (current) {
    current.count += 1;
    current.sum += value;
    current.bucketCounts[bucketIndex(value)] += 1;
    return;
  }
  if (metricSeriesCount() >= maxMetricSeries) {
    droppedSeriesCount += 1;
    return;
  }
  const bucketCounts = Array.from({ length: histogramBounds.length + 1 }, () => 0);
  bucketCounts[bucketIndex(value)] = 1;
  histograms.set(metricKey, { name, labels: normalized, count: 1, sum: value, bucketCounts });
}

export function setGaugeMetric(name: string, value: number, labels: MetricLabels = {}): void {
  if (!Number.isFinite(value)) return;
  const normalized = normalizedLabels(labels);
  const metricKey = key(name, normalized);
  const current = gauges.get(metricKey);
  if (current) {
    current.value = value;
    return;
  }
  if (metricSeriesCount() >= maxMetricSeries) {
    droppedSeriesCount += 1;
    return;
  }
  gauges.set(metricKey, { name, labels: normalized, value });
}

export function createOtlpMetricsPayload(serviceName: string, timestampMs = Date.now()): OtlpMetricsPayload {
  const timeUnixNano = String(BigInt(Math.trunc(timestampMs)) * 1_000_000n);
  const metrics: OtlpMetric[] = [];
  for (const name of counterNames) {
    const dataPoints = [...counters.values()]
      .filter((metric) => metric.name === name)
      .map((metric) => ({
        attributes: attributes(metric.labels),
        startTimeUnixNano: processStartTimeUnixNano,
        timeUnixNano,
        asInt: String(metric.value),
      }));
    if (dataPoints.length > 0) metrics.push({
      name: `dkrypt_${name}`,
      unit: '1',
      sum: { aggregationTemporality: 2, isMonotonic: true, dataPoints },
    });
  }
  for (const name of new Set([...histograms.values()].map((metric) => metric.name))) {
    const dataPoints = [...histograms.values()]
      .filter((metric) => metric.name === name)
      .map((metric) => ({
        attributes: attributes(metric.labels),
        startTimeUnixNano: processStartTimeUnixNano,
        timeUnixNano,
        count: String(metric.count),
        sum: metric.sum,
        bucketCounts: metric.bucketCounts.map(String),
        explicitBounds: histogramBounds,
      }));
    metrics.push({
      name: `dkrypt_${name}`,
      unit: histogramUnit(name),
      histogram: { aggregationTemporality: 2, dataPoints },
    });
  }
  for (const name of new Set([...gauges.values()].map((metric) => metric.name))) {
    const dataPoints = [...gauges.values()]
      .filter((metric) => metric.name === name)
      .map((metric) => ({ attributes: attributes(metric.labels), timeUnixNano, asDouble: metric.value }));
    metrics.push({ name: `dkrypt_${name}`, unit: histogramUnit(name), gauge: { dataPoints } });
  }
  if (droppedSeriesCount > 0) metrics.push({
    name: 'dkrypt_metric_series_dropped_total',
    unit: '1',
    sum: {
      aggregationTemporality: 2,
      isMonotonic: true,
      dataPoints: [{ attributes: [], startTimeUnixNano: processStartTimeUnixNano, timeUnixNano, asInt: String(droppedSeriesCount) }],
    },
  });
  return {
    resourceMetrics: [{
      resource: { attributes: [{ key: 'service.name', value: { stringValue: serviceName } }] },
      scopeMetrics: [{ scope: { name: 'dkrypt' }, metrics }],
    }],
  };
}

export function renderMetrics(): string {
  const lines: string[] = [];
  for (const name of counterNames) lines.push(`# TYPE dkrypt_${name} counter`);
  lines.push('# TYPE dkrypt_metric_series_dropped_total counter');
  for (const metric of counters.values()) lines.push(`dkrypt_${metric.name}${labelText(metric.labels)} ${metric.value}`);
  lines.push(`dkrypt_metric_series_dropped_total ${droppedSeriesCount}`);
  for (const name of new Set([...gauges.values()].map((metric) => metric.name))) lines.push(`# TYPE dkrypt_${name} gauge`);
  for (const metric of gauges.values()) lines.push(`dkrypt_${metric.name}${labelText(metric.labels)} ${metric.value}`);
  for (const metric of histograms.values()) {
    lines.push(`# TYPE dkrypt_${metric.name} summary`);
    lines.push(`dkrypt_${metric.name}_count${labelText(metric.labels)} ${metric.count}`);
    lines.push(`dkrypt_${metric.name}_sum${labelText(metric.labels)} ${metric.sum}`);
  }
  return `${lines.join('\n')}\n`;
}

export function resetMetrics(): void {
  counters.clear();
  histograms.clear();
  gauges.clear();
  counterNames.clear();
  droppedSeriesCount = 0;
}
