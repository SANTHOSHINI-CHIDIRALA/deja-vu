"use client";

import { useRef, useState } from "react";
import type { EvalRow } from "@/lib/eval";

// Validated (dataviz validate_palette.js, dark surface #0f141b): CVD ΔE 27.4, contrast >= 3:1.
export const SERIES = {
  off: { label: "Memory OFF", color: "#3987e5" },
  on: { label: "Memory ON", color: "#c98500" },
} as const;

const W = 760;
const H = 320;
const M = { top: 16, right: 104, bottom: 36, left: 44 };

/** Cumulative root-cause accuracy across the chronological eval replay, with a crosshair tooltip. */
export function LearningChart({ rows }: { rows: EvalRow[] }) {
  const [hover, setHover] = useState<number | null>(null);
  const svgRef = useRef<SVGSVGElement>(null);
  const n = rows.length;
  const iw = W - M.left - M.right;
  const ih = H - M.top - M.bottom;
  const x = (i: number) => M.left + (n <= 1 ? iw / 2 : (i / (n - 1)) * iw);
  const y = (v: number) => M.top + (1 - v) * ih;
  const path = (k: "offAccuracy" | "onAccuracy") => rows.map((r, i) => `${i ? "L" : "M"}${x(i).toFixed(1)},${y(r.cumulative[k]).toFixed(1)}`).join("");

  const onMove = (e: React.PointerEvent<SVGSVGElement>) => {
    const svg = svgRef.current;
    if (!svg || !n) return;
    const rect = svg.getBoundingClientRect();
    const px = ((e.clientX - rect.left) / rect.width) * W;
    const i = Math.round(((px - M.left) / iw) * (n - 1));
    setHover(Math.max(0, Math.min(n - 1, i)));
  };

  const last = rows[n - 1];
  const h = hover !== null ? rows[hover] : null;
  // Keep end labels from colliding.
  let offLabelY = last ? y(last.cumulative.offAccuracy) : 0;
  let onLabelY = last ? y(last.cumulative.onAccuracy) : 0;
  if (Math.abs(offLabelY - onLabelY) < 16) {
    if (onLabelY <= offLabelY) onLabelY = offLabelY - 16;
    else offLabelY = onLabelY - 16;
  }

  return (
    <div className="relative">
      <div className="mb-2 flex flex-wrap gap-4 text-xs text-ink-300" aria-hidden>
        {(["on", "off"] as const).map((k) => (
          <span key={k} className="flex items-center gap-1.5">
            <span className="inline-block h-0.5 w-4 rounded" style={{ background: SERIES[k].color }} />
            {SERIES[k].label}
          </span>
        ))}
      </div>
      <svg
        ref={svgRef}
        viewBox={`0 0 ${W} ${H}`}
        className="w-full touch-none select-none"
        role="img"
        aria-label={`Cumulative root-cause accuracy over ${n} incidents. Memory ON ends at ${Math.round((last?.cumulative.onAccuracy ?? 0) * 100)}%, memory OFF at ${Math.round((last?.cumulative.offAccuracy ?? 0) * 100)}%.`}
        onPointerMove={onMove}
        onPointerLeave={() => setHover(null)}
      >
        {[0, 0.25, 0.5, 0.75, 1].map((t) => (
          <g key={t}>
            <line x1={M.left} x2={W - M.right} y1={y(t)} y2={y(t)} stroke="#243041" strokeWidth={1} />
            <text x={M.left - 8} y={y(t) + 4} textAnchor="end" fontSize={11} fill="#8b98a9">
              {Math.round(t * 100)}%
            </text>
          </g>
        ))}
        {rows.map((r, i) =>
          i % Math.max(1, Math.ceil(n / 10)) === 0 || i === n - 1 ? (
            <text key={r.id} x={x(i)} y={H - M.bottom + 18} textAnchor="middle" fontSize={11} fill="#8b98a9">
              {r.index}
            </text>
          ) : null,
        )}
        <text x={M.left + iw / 2} y={H - 4} textAnchor="middle" fontSize={11} fill="#8b98a9">
          Incident # (chronological, Oct 2026)
        </text>

        {h && <line x1={x(hover!)} x2={x(hover!)} y1={M.top} y2={M.top + ih} stroke="#8b98a9" strokeWidth={1} strokeDasharray="3 3" />}

        {(["off", "on"] as const).map((k) => {
          const key = k === "off" ? "offAccuracy" : "onAccuracy";
          return (
            <g key={k}>
              <path d={path(key)} fill="none" stroke={SERIES[k].color} strokeWidth={2} strokeLinejoin="round" strokeLinecap="round" />
              {rows.map((r, i) => (
                <circle
                  key={r.id}
                  cx={x(i)}
                  cy={y(r.cumulative[key])}
                  r={hover === i ? 5 : 3.5}
                  fill={r[k].correct ? SERIES[k].color : "#0f141b"}
                  stroke={SERIES[k].color}
                  strokeWidth={2}
                />
              ))}
            </g>
          );
        })}

        {last && (
          <>
            <text x={W - M.right + 10} y={onLabelY + 4} fontSize={12} fontWeight={600} fill="#e6ebf1">
              ON {Math.round(last.cumulative.onAccuracy * 100)}%
            </text>
            <text x={W - M.right + 10} y={offLabelY + 4} fontSize={12} fill="#aab5c3">
              OFF {Math.round(last.cumulative.offAccuracy * 100)}%
            </text>
          </>
        )}
      </svg>
      <p className="mt-1 text-[11px] text-ink-400">Filled dot = that incident&apos;s top hypothesis was judged correct; hollow = wrong.</p>

      {h && (
        <div
          className="pointer-events-none absolute top-8 z-10 w-64 rounded-lg border border-ink-700 bg-ink-950/95 p-3 text-xs shadow-xl"
          style={{ left: `clamp(0px, calc(${(x(hover!) / W) * 100}% - 8rem), calc(100% - 16rem))` }}
        >
          <div className="text-ink-400">
            #{h.index} · <span className="font-mono">{h.id}</span> · {h.service}
          </div>
          <div className="mb-2 text-ink-100">{h.title}</div>
          {(["on", "off"] as const).map((k) => (
            <div key={k} className="flex items-center gap-2 py-0.5">
              <span className="inline-block h-0.5 w-3 rounded" style={{ background: SERIES[k].color }} />
              <span className="font-semibold tabular-nums text-ink-100">{Math.round(h.cumulative[k === "on" ? "onAccuracy" : "offAccuracy"] * 100)}%</span>
              <span className="text-ink-400">{SERIES[k].label}</span>
              <span className={`ml-auto ${h[k].correct ? "text-emerald-300" : "text-red-300"}`}>{h[k].correct ? "✓ correct" : "✕ wrong"}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
