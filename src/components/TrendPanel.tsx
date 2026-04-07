"use client";

import { useCallback, useEffect, useState } from "react";
import { PROVIDER_COLORS, fmtMs } from "./shared";

interface TrendData {
  dates: string[];
  benchmarkTrend: { date: string; provider: string; avg_score: number; models_tested: number }[];
  complaintTrend: { date: string; provider: string; complaints: number; failed_exams: number }[];
  latencyTrend: { date: string; provider: string; avg_latency: number; requests: number }[];
}
// benchmarkTrend kept for API compatibility but not displayed

const PROVIDER_HEX: Record<string, string> = {
  openrouter: "#3b82f6", kilo: "#a855f7", google: "#34d399", groq: "#fb923c",
  cerebras: "#f43e5e", sambanova: "#14b8a6", mistral: "#38bdf8", ollama: "#84cc16",
};

export function TrendPanel() {
  const [data, setData] = useState<TrendData | null>(null);
  const [loading, setLoading] = useState(true);
  const [view, setView] = useState<"complaint" | "latency">("latency");

  const fetchData = useCallback(async () => {
    try {
      const res = await fetch("/api/trend");
      if (res.ok) setData(await res.json());
    } catch { /* silent */ }
    setLoading(false);
  }, []);

  useEffect(() => {
    fetchData();
    const t = setInterval(fetchData, 60000);
    return () => clearInterval(t);
  }, [fetchData]);

  if (loading) return <div className="text-gray-500 text-center py-8">กำลังโหลดแนวโน้ม...</div>;
  if (!data) return null;

  const { dates, complaintTrend, latencyTrend } = data;

  // Get unique providers
  const allProviders = [...new Set([
    ...complaintTrend.map(c => c.provider),
    ...latencyTrend.map(l => l.provider),
  ])];

  const hasData = complaintTrend.length > 0 || latencyTrend.length > 0;
  if (!hasData) {
    return (
      <div className="glass rounded-2xl p-8 text-center text-gray-500">
        <div className="text-4xl mb-3">📈</div>
        <p>ยังไม่มี report card — ครูจะเริ่มบันทึกพัฒนาการนักเรียนอัตโนมัติ</p>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      {/* View Tabs */}
      <div className="flex gap-2">
        {([
          ["complaint", "ใบเตือน"],
          ["latency", "วิ่งเร็วแค่ไหน"],
        ] as const).map(([id, label]) => (
          <button
            key={id}
            onClick={() => setView(id)}
            className={`px-3 py-1.5 rounded-lg text-xs font-medium transition-colors ${
              view === id ? "bg-indigo-500/20 text-indigo-300 border border-indigo-500/40" : "text-gray-500 hover:text-white hover:bg-white/5"
            }`}
          >
            {label}
          </button>
        ))}
      </div>

      {/* Chart Area */}
      <div className="glass rounded-xl p-5">
        {view === "complaint" && (
          <TrendChart
            title="จำนวนร้องเรียน (14 วัน)"
            dates={dates}
            providers={allProviders}
            getData={(date, provider) => {
              const row = complaintTrend.find(c => c.date === date && c.provider === provider);
              return row ? row.complaints : null;
            }}
            maxValue={Math.max(...complaintTrend.map(c => c.complaints), 5)}
            formatValue={(v) => `${v} ครั้ง`}
            color="complaint"
          />
        )}
        {view === "latency" && (
          <TrendChart
            title="ความเร็วเฉลี่ย (14 วัน)"
            dates={dates}
            providers={allProviders}
            getData={(date, provider) => {
              const row = latencyTrend.find(l => l.date === date && l.provider === provider);
              return row ? row.avg_latency : null;
            }}
            maxValue={Math.max(...latencyTrend.map(l => l.avg_latency), 5000)}
            formatValue={(v) => fmtMs(v)}
            color="latency"
          />
        )}
      </div>

      {/* Provider Legend */}
      <div className="flex flex-wrap gap-3 text-[10px] text-gray-500">
        {allProviders.map(p => {
          const hex = PROVIDER_HEX[p] ?? "#6366f1";
          return (
            <span key={p} className="flex items-center gap-1">
              <span className="inline-block h-2 w-2 rounded-full" style={{ background: hex }} />
              {p}
            </span>
          );
        })}
      </div>
    </div>
  );
}

// Mini line chart using SVG
function TrendChart({
  title,
  dates,
  providers,
  getData,
  maxValue,
  formatValue,
  color: _color,
}: {
  title: string;
  dates: string[];
  providers: string[];
  getData: (date: string, provider: string) => number | null;
  maxValue: number;
  formatValue: (v: number) => string;
  color: string;
}) {
  const W = 700;
  const H = 200;
  const PAD = { top: 20, right: 20, bottom: 30, left: 40 };
  const chartW = W - PAD.left - PAD.right;
  const chartH = H - PAD.top - PAD.bottom;

  const [hover, setHover] = useState<{ x: number; y: number; label: string } | null>(null);

  return (
    <div>
      <h4 className="text-sm font-bold text-gray-300 mb-3">{title}</h4>
      <svg viewBox={`0 0 ${W} ${H}`} className="w-full" onMouseLeave={() => setHover(null)}>
        {/* Grid lines */}
        {[0, 0.25, 0.5, 0.75, 1].map(pct => {
          const y = PAD.top + chartH * (1 - pct);
          return (
            <g key={pct}>
              <line x1={PAD.left} y1={y} x2={W - PAD.right} y2={y} stroke="rgba(255,255,255,0.06)" />
              <text x={PAD.left - 5} y={y + 3} textAnchor="end" fill="rgba(255,255,255,0.3)" fontSize="9">
                {formatValue(maxValue * pct)}
              </text>
            </g>
          );
        })}

        {/* X-axis labels */}
        {dates.map((d, i) => {
          if (i % 2 !== 0 && dates.length > 7) return null;
          const x = PAD.left + (i / (dates.length - 1)) * chartW;
          return (
            <text key={d} x={x} y={H - 5} textAnchor="middle" fill="rgba(255,255,255,0.3)" fontSize="9">
              {d.slice(5)}
            </text>
          );
        })}

        {/* Lines per provider */}
        {providers.map(provider => {
          const hex = PROVIDER_HEX[provider] ?? "#6366f1";
          const points: string[] = [];

          dates.forEach((d, i) => {
            const val = getData(d, provider);
            if (val !== null) {
              const x = PAD.left + (i / (dates.length - 1)) * chartW;
              const y = PAD.top + chartH * (1 - val / maxValue);
              points.push(`${x},${y}`);
            }
          });

          if (points.length < 2) return null;

          return (
            <g key={provider}>
              <polyline
                points={points.join(" ")}
                fill="none"
                stroke={hex}
                strokeWidth={2}
                strokeLinecap="round"
                strokeLinejoin="round"
                opacity={0.8}
              />
              {/* Dots */}
              {dates.map((d, i) => {
                const val = getData(d, provider);
                if (val === null) return null;
                const x = PAD.left + (i / (dates.length - 1)) * chartW;
                const y = PAD.top + chartH * (1 - val / maxValue);
                return (
                  <circle
                    key={`${provider}-${d}`}
                    cx={x} cy={y} r={3}
                    fill={hex}
                    opacity={0.9}
                    className="cursor-pointer"
                    onMouseEnter={() => setHover({ x, y, label: `${provider}: ${formatValue(val)} (${d.slice(5)})` })}
                  />
                );
              })}
            </g>
          );
        })}

        {/* Tooltip */}
        {hover && (
          <g>
            <rect x={hover.x - 60} y={hover.y - 25} width={120} height={20} rx={4} fill="rgba(0,0,0,0.8)" stroke="rgba(255,255,255,0.2)" />
            <text x={hover.x} y={hover.y - 12} textAnchor="middle" fill="white" fontSize="9">{hover.label}</text>
          </g>
        )}
      </svg>
    </div>
  );
}
