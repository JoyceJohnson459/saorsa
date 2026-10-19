import type { EChartsOption } from "echarts"
import { isDark } from "./theme"

/** Chart colors follow the Saorsa tokens of the active theme. */
function tokens() {
  // Reading the reactive flag makes templates that build options re-render when the theme changes.
  void isDark.value
  const style = getComputedStyle(document.documentElement)
  const read = (name: string, fallback: string) => style.getPropertyValue(name).trim() || fallback
  return {
    mint: read("--mint", "#55f68a"),
    blue: read("--blue", "#8cb6ff"),
    orange: read("--orange", "#f5b84b"),
    red: read("--red", "#ef6464"),
    muted: read("--muted", "#91a595"),
    dim: read("--dim", "#5b7060"),
    line: read("--line", "#2c352e"),
    text: read("--text", "#f2f5f3"),
    raised: read("--raised", "#1b221d"),
  }
}

export function palette() {
  const t = tokens()
  return [t.mint, t.blue, t.orange, "#738c78", t.red, "#b5bdfb", "#5fd0c8", "#f1bd84"]
}

const tooltip = () => {
  const t = tokens()
  return {
    backgroundColor: t.raised,
    borderColor: t.line,
    textStyle: { color: t.text, fontSize: 11 },
    extraCssText: "border-radius:8px;box-shadow:0 12px 40px #0006;",
  }
}

export interface SeriesPoint {
  bucket: string
  costMicros: number
  requests: number
  inputTokens: number
  outputTokens: number
}

/**
 * The API only returns buckets that had traffic. Charts need every hour/day of the window (and aligned
 * indexes for period-over-period comparison), so missing buckets are filled with zeros in local time.
 */
export function fillBuckets(points: SeriesPoint[], from: string | Date, to: string | Date, bucket: "hour" | "day"): SeriesPoint[] {
  const step = bucket === "hour" ? 3600_000 : 86400_000
  const floor = (time: number) => {
    const date = new Date(time)
    if (bucket === "hour") date.setMinutes(0, 0, 0)
    else date.setHours(0, 0, 0, 0)
    return date.getTime()
  }
  const byBucket = new Map(points.map((point) => [floor(new Date(point.bucket).getTime()), point]))
  const result: SeriesPoint[] = []
  for (let time = floor(new Date(from).getTime()); time <= new Date(to).getTime(); time += step) {
    const key = floor(time)
    result.push(byBucket.get(key) ?? { bucket: new Date(key).toISOString(), costMicros: 0, requests: 0, inputTokens: 0, outputTokens: 0 })
    // Daylight-saving shifts would drift a fixed step; re-anchor to the bucket boundary each iteration.
    time = key
  }
  return result
}

const label = (value: string, bucket: "hour" | "day") => {
  const date = new Date(value)
  return bucket === "hour" ? `${String(date.getHours()).padStart(2, "0")}:00` : `${date.getMonth() + 1}/${date.getDate()}`
}

/** Cost line for the current period with an optional dashed comparison line for the previous period. */
export function costOption(points: SeriesPoint[], bucket: "hour" | "day", previous?: SeriesPoint[]): EChartsOption {
  const t = tokens()
  const usd = (micros: number) => +(micros / 1e6).toFixed(6)
  return {
    tooltip: { trigger: "axis", ...tooltip(), valueFormatter: (value) => `$${Number(value).toFixed(4)}` },
    grid: { left: 6, right: 10, top: 16, bottom: 4, containLabel: true },
    xAxis: {
      type: "category",
      boundaryGap: false,
      data: points.map((point) => label(point.bucket, bucket)),
      axisLine: { show: false },
      axisTick: { show: false },
      axisLabel: { color: t.dim, fontSize: 10 },
    },
    yAxis: {
      type: "value",
      axisLabel: { color: t.dim, fontSize: 10, formatter: (value: number) => `$${value}` },
      splitLine: { lineStyle: { color: t.line, type: [4, 7] } },
    },
    series: [
      {
        name: "当前周期",
        type: "line",
        smooth: false,
        symbol: "circle",
        symbolSize: 6,
        showSymbol: points.length < 3,
        lineStyle: { width: 2.4, color: t.mint },
        itemStyle: { color: t.mint },
        areaStyle: {
          color: {
            type: "linear",
            x: 0,
            y: 0,
            x2: 0,
            y2: 1,
            colorStops: [
              { offset: 0, color: `${t.mint}36` },
              { offset: 1, color: `${t.mint}00` },
            ],
          },
        },
        data: points.map((point) => usd(point.costMicros)),
      },
      ...(previous?.length
        ? [
            {
              name: "上个周期",
              type: "line" as const,
              smooth: false,
              symbol: "none",
              lineStyle: { width: 1.6, color: "#92a696", type: [5, 5] as [number, number], opacity: 0.7 },
              data: points.map((_, index) => usd(previous[index]?.costMicros ?? 0)),
            },
          ]
        : []),
    ],
  }
}

/** Token bars for analysis pages. */
export function trendOption(points: SeriesPoint[], bucket: "hour" | "day"): EChartsOption {
  const t = tokens()
  const base = costOption(points, bucket)
  return {
    ...base,
    legend: { top: 0, left: 0, itemWidth: 9, itemHeight: 9, textStyle: { color: t.muted, fontSize: 11 } },
    grid: { left: 6, right: 10, top: 36, bottom: 4, containLabel: true },
    yAxis: [
      (base.yAxis as object),
      { type: "value", axisLabel: { color: t.dim, fontSize: 10 }, splitLine: { show: false } },
    ] as EChartsOption["yAxis"],
    tooltip: { trigger: "axis", ...tooltip() },
    series: [
      { ...(base.series as object[])[0], name: "费用 ($)" },
      { name: "输入 Token", type: "bar", yAxisIndex: 1, stack: "tokens", barMaxWidth: 14, itemStyle: { color: `${t.blue}aa`, borderRadius: [0, 0, 0, 0] }, data: points.map((point) => point.inputTokens) },
      { name: "输出 Token", type: "bar", yAxisIndex: 1, stack: "tokens", barMaxWidth: 14, itemStyle: { color: `${t.orange}bb`, borderRadius: [3, 3, 0, 0] }, data: points.map((point) => point.outputTokens) },
    ] as EChartsOption["series"],
  }
}

export function pieOption(rows: Array<{ label: string; costMicros: number; requests: number }>, by: "cost" | "requests" = "cost"): EChartsOption {
  const t = tokens()
  return {
    color: palette(),
    tooltip: { trigger: "item", ...tooltip() },
    legend: { bottom: 0, type: "scroll", textStyle: { color: t.muted, fontSize: 11 }, itemWidth: 9, itemHeight: 9 },
    series: [
      {
        type: "pie",
        radius: ["58%", "76%"],
        center: ["50%", "44%"],
        padAngle: 2,
        itemStyle: { borderRadius: 4 },
        label: { show: false },
        data: rows.map((row) => ({ name: row.label, value: by === "cost" ? +(row.costMicros / 1e6).toFixed(6) : row.requests })),
      },
    ],
  }
}

/** Ring without legend, for layouts that render their own list next to it. */
export function ringOption(rows: Array<{ label: string; value: number }>, center: string, caption: string): EChartsOption {
  const t = tokens()
  return {
    color: palette(),
    tooltip: { trigger: "item", ...tooltip() },
    title: {
      text: center,
      subtext: caption,
      left: "center",
      top: "37%",
      itemGap: 6,
      textStyle: { color: t.text, fontSize: 22, fontWeight: 700 },
      subtextStyle: { color: t.muted, fontSize: 10 },
    },
    series: [{ type: "pie", radius: ["72%", "96%"], padAngle: 2, itemStyle: { borderRadius: 3 }, label: { show: false }, data: rows.map((row) => ({ name: row.label, value: row.value })) }],
  }
}

export function barOption(rows: Array<{ label: string; costMicros: number }>): EChartsOption {
  const t = tokens()
  const top = rows.slice(0, 10).toReversed()
  return {
    tooltip: { trigger: "axis", axisPointer: { type: "shadow" }, ...tooltip(), valueFormatter: (value) => `$${Number(value).toFixed(4)}` },
    grid: { left: 6, right: 24, top: 6, bottom: 4, containLabel: true },
    xAxis: { type: "value", axisLabel: { color: t.dim, fontSize: 10 }, splitLine: { lineStyle: { color: t.line, type: [4, 7] } } },
    yAxis: { type: "category", data: top.map((row) => row.label), axisTick: { show: false }, axisLine: { show: false }, axisLabel: { color: t.muted, fontSize: 11 } },
    series: [{ type: "bar", barMaxWidth: 14, itemStyle: { color: t.mint, borderRadius: [0, 4, 4, 0] }, data: top.map((row) => +(row.costMicros / 1e6).toFixed(6)) }],
  }
}
