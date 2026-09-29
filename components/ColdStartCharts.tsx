"use client";

import { useRef, useState } from "react";
import { MEMORY_SERIES, SERIES } from "@/lib/chart-colors";
import type { ColdRow } from "@/lib/eval";
import { FAMILY_LABELS } from "@/lib/types";

const W = 760;
const M = { top: 14, right: 96, bottom: 26, left: 48 };
const H_ACC = 280;
const H_MEM = 150;

interface Props {
  rows: ColdRow[];
  window: number;
}

/**
 * Two small multiples on a shared x-axis (incident #): rolling accuracy for memory ON vs OFF,
 * and the number of memories in the bank. One crosshair drives both. No dual y-axis.
 */
export function ColdStartCharts({ rows, window }: Props) {
  const [hover, setHover] = useState<number | null>(null);
  const n = rows.length;
  const iw = W - M.left - M.right;
  const x = (i: number) => M.left + (n <= 1 ? iw / 2 : (i / (n - 1)) * iw);
  const evalStart = rows.findIndex((r) => r.phase === "eval");
  const maxMem = Math.max(10, ...rows.map((r) => r.memoriesBefore));
  const memTop = niceCeil(maxMem);
  const h = hover !== null ? rows[hover] : null;

  return (
    <div className="relative">
      <Legend />
      <Panel
        height={H_ACC}
        n={n}
        x={x}
        onHover={setHover}
        hover={hover}
        evalStart={evalStart}
        yTicks={[0, 0.25, 0.5, 0.75, 1].map((t) => ({ v: t, label: `${Math.round(t * 100)}%` }))}
        yScale={(v, ih) => M.top + (1 - v) * ih}
        label={`Rolling accuracy (last ${window} incidents)`}
        series={(["off", "on"] as const).map((k) => ({
          key: k,
          color: SERIES[k].color,
          values: rows.map((r) => r.rolling[k]),
          correct: rows.map((r) => r[k].correct),
          endLabel: `${SERIES[k].label.replace("Memory ", "")} ${Math.round((rows.at(-1)?.rolling[k] ?? 0) * 100)}%`,
          emphasis: k === "on",
        }))}
        ariaLabel={`Rolling ${window}-incident accuracy. Memory ON ends at ${Math.round((rows.at(-1)?.rolling.on ?? 0) * 100)}%, memory OFF at ${Math.round((rows.at(-1)?.rolling.off ?? 0) * 100)}%.`}
      />
      <Panel
        height={H_MEM}
        n={n}
        x={x}
        onHover={setHover}
        hover={hover}
        evalStart={evalStart}
        yTicks={[0, memTop / 2, memTop].map((v) => ({ v, label: v >= 1000 ? `${(v / 1000).toFixed(1)}k` : String(v) }))}
        yScale={(v, ih) => M.top + (1 - v / memTop) * ih}
        label="Memories in the bank when the alert fired"
        area
        series={[
          {
            key: "mem",
            color: MEMORY_SERIES.color,
            values: rows.map((r) => r.memoriesBefore),
            endLabel: `${rows.at(-1)?.memoriesBefore ?? 0}`,
            emphasis: false,
          },
        ]}
        xAxis
        ariaLabel={`Memories in the bank grow from 0 to ${rows.at(-1)?.memoriesBefore ?? 0} over ${n} incidents.`}
      />

      {h && (
        <div
          className="pointer-events-none absolute top-10 z-10 w-72 rounded-lg border border-ink-700 bg-ink-950/95 p-3 text-xs shadow-xl"
          style={{ left: `clamp(0px, calc(${(x(hover!) / W) * 100}% - 9rem), calc(100% - 18rem))` }}
        >
          <div className="text-ink-400">
            #{h.index} · <span className="font-mono">{h.id}</span> · {h.phase === "eval" ? "held-out (Oct)" : "history"}
          </div>
          <div className="mb-2 text-ink-100">{FAMILY_LABELS[h.family]}</div>
          {(["on", "off"] as const).map((k) => (
            <div key={k} className="flex items-center gap-2 py-0.5">
              <span className="inline-block h-0.5 w-3 rounded" style={{ background: SERIES[k].color }} />
              <span className="font-semibold tabular-nums text-ink-100">{Math.round(h.rolling[k] * 100)}%</span>
              <span className="text-ink-400">{SERIES[k].label}</span>
              <span className={`ml-auto ${h[k].correct ? "text-emerald-300" : "text-red-300"}`}>{h[k].correct ? "✓ this one" : "✕ this one"}</span>
            </div>
          ))}
          <div className="flex items-center gap-2 py-0.5">
            <span className="inline-block h-0.5 w-3 rounded" style={{ background: MEMORY_SERIES.color }} />
            <span className="font-semibold tabular-nums text-ink-100">{h.memoriesBefore}</span>
            <span className="text-ink-400">memories in bank</span>
          </div>
        </div>
      )}
      <p className="mt-1 text-[11px] text-ink-400">
        Filled dot = that incident&apos;s top hypothesis was judged correct; hollow = wrong. Each incident is diagnosed first, then its resolution is
        retained.
      </p>
    </div>
  );
}

function Legend() {
  return (
    <div className="mb-2 flex flex-wrap gap-4 text-xs text-ink-300" aria-hidden>
      {(["on", "off"] as const).map((k) => (
        <span key={k} className="flex items-center gap-1.5">
          <span className="inline-block h-0.5 w-4 rounded" style={{ background: SERIES[k].color }} />
          {SERIES[k].label}
        </span>
      ))}
      <span className="flex items-center gap-1.5">
        <span className="inline-block h-0.5 w-4 rounded" style={{ background: MEMORY_SERIES.color }} />
        Memories in bank
      </span>
    </div>
  );
}

interface PanelSeries {
  key: string;
  color: string;
  values: number[];
  correct?: boolean[];
  endLabel: string;
  emphasis: boolean;
}

function Panel({
  height,
  n,
  x,
  hover,
  onHover,
  evalStart,
  yTicks,
  yScale,
  series,
  label,
  area = false,
  xAxis = false,
  ariaLabel,
}: {
  height: number;
  n: number;
  x: (i: number) => number;
  hover: number | null;
  onHover: (i: number | null) => void;
  evalStart: number;
  yTicks: { v: number; label: string }[];
  yScale: (v: number, ih: number) => number;
  series: PanelSeries[];
  label: string;
  area?: boolean;
  xAxis?: boolean;
  ariaLabel: string;
}) {
  const svgRef = useRef<SVGSVGElement>(null);
  const bottom = xAxis ? M.bottom + 14 : 8;
  const ih = height - M.top - bottom;
  const y = (v: number) => yScale(v, ih);
  const iw = W - M.left - M.right;

  const onMove = (e: React.PointerEvent<SVGSVGElement>) => {
    const svg = svgRef.current;
    if (!svg || !n) return;
    const rect = svg.getBoundingClientRect();
    const px = ((e.clientX - rect.left) / rect.width) * W;
    onHover(Math.max(0, Math.min(n - 1, Math.round(((px - M.left) / iw) * (n - 1)))));
  };

  // Nudge end labels apart when they would collide.
  const ends = series.map((s) => ({ s, y: y(s.values.at(-1) ?? 0) }));
  if (ends.length === 2 && Math.abs(ends[0]!.y - ends[1]!.y) < 16) {
    const [a, b] = ends[0]!.y <= ends[1]!.y ? [ends[0]!, ends[1]!] : [ends[1]!, ends[0]!];
    if (b.y - 16 >= M.top) a.y = b.y - 16;
    else b.y = a.y + 16; // no room above the plot: push the lower label down instead
  }

  return (
    <div>
      <div className="mt-2 text-[11px] font-medium text-ink-300">{label}</div>
      <svg
        ref={svgRef}
        viewBox={`0 0 ${W} ${height}`}
        className="w-full touch-none select-none"
        role="img"
        aria-label={ariaLabel}
        onPointerMove={onMove}
        onPointerLeave={() => onHover(null)}
      >
        {yTicks.map((t) => (
          <g key={t.label}>
            <line x1={M.left} x2={W - M.right} y1={y(t.v)} y2={y(t.v)} stroke="#243041" strokeWidth={1} />
            <text x={M.left - 8} y={y(t.v) + 4} textAnchor="end" fontSize={11} fill="#8b98a9">
              {t.label}
            </text>
          </g>
        ))}
        {evalStart > 0 && (
          <g>
            <line x1={x(evalStart) - 4} x2={x(evalStart) - 4} y1={M.top} y2={M.top + ih} stroke="#8b98a9" strokeWidth={1} strokeDasharray="2 4" />
            {!xAxis && (
              <text x={x(evalStart)} y={M.top + ih - 8} fontSize={11} fill="#aab5c3">
                Oct: held-out incidents →
              </text>
            )}
          </g>
        )}
        {xAxis && (
          <>
            {Array.from({ length: n }, (_, i) => i)
              .filter((i) => i === 0 || (i + 1) % 10 === 0)
              .map((i) => (
                <text key={i} x={x(i)} y={height - bottom + 16} textAnchor="middle" fontSize={11} fill="#8b98a9">
                  {i + 1}
                </text>
              ))}
            <text x={M.left + iw / 2} y={height - 4} textAnchor="middle" fontSize={11} fill="#8b98a9">
              Incident # (chronological, Mar → Oct 2026)
            </text>
          </>
        )}
        {hover !== null && <line x1={x(hover)} x2={x(hover)} y1={M.top} y2={M.top + ih} stroke="#8b98a9" strokeWidth={1} strokeDasharray="3 3" />}

        {series.map((s) => {
          const d = s.values.map((v, i) => `${i ? "L" : "M"}${x(i).toFixed(1)},${y(v).toFixed(1)}`).join("");
          return (
            <g key={s.key}>
              {area && n > 1 && <path d={`${d}L${x(n - 1)},${y(0)}L${x(0)},${y(0)}Z`} fill={s.color} opacity={0.15} />}
              <path d={d} fill="none" stroke={s.color} strokeWidth={2} strokeLinejoin="round" strokeLinecap="round" />
              {s.correct &&
                s.values.map((v, i) => (
                  <circle
                    key={i}
                    cx={x(i)}
                    cy={y(v)}
                    r={hover === i ? 4.5 : 2.75}
                    fill={s.correct![i] ? s.color : "#0f141b"}
                    stroke={s.color}
                    strokeWidth={1.5}
                  />
                ))}
            </g>
          );
        })}
        {ends.map(({ s, y: ly }) => (
          <text key={s.key} x={W - M.right + 10} y={ly + 4} fontSize={12} fontWeight={s.emphasis ? 600 : 400} fill={s.emphasis ? "#e6ebf1" : "#aab5c3"}>
            {s.endLabel}
          </text>
        ))}
      </svg>
    </div>
  );
}

function niceCeil(v: number): number {
  const mag = 10 ** Math.floor(Math.log10(v));
  const f = v / mag;
  const nice = f <= 1 ? 1 : f <= 2 ? 2 : f <= 2.5 ? 2.5 : f <= 5 ? 5 : f <= 7.5 ? 7.5 : 10;
  return nice * mag;
}
