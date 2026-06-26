"use client";

// ── カイゼンくん 成長ダッシュボード ──
// 「声が集まる → 直る → 学びになる」の現在地を1画面で見せる。
// データは /api/stats（Notion改善チケットDBの集計・60秒キャッシュ）。
import { useEffect, useState } from "react";
import type { KaizenStats } from "@/lib/stats";
// 状態の色は lib/board.ts の正本から取得（「議論」と「議論中」のズレを防ぐ）。
import { metaOf } from "@/lib/board";

function fmtDate(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return `${d.getMonth() + 1}/${d.getDate()}`;
}

export default function DashboardPage() {
  const [stats, setStats] = useState<KaizenStats | null>(null);
  const [error, setError] = useState("");

  useEffect(() => {
    fetch("/api/stats")
      .then(async (r) => {
        const data = await r.json();
        if (!r.ok) throw new Error(data?.error || "読み込みに失敗しました");
        setStats(data as KaizenStats);
      })
      .catch((e) => setError((e as Error).message));
  }, []);

  if (error) {
    return (
      <div className="dash">
        <DashHeader />
        <div className="error">読み込みエラー：{error}</div>
      </div>
    );
  }
  if (!stats) {
    return (
      <div className="dash">
        <DashHeader />
        <div className="typing">集計中…</div>
      </div>
    );
  }

  const maxWeek = Math.max(1, ...stats.weekly.map((w) => w.count));

  return (
    <div className="dash">
      <DashHeader stats={stats} />

      <div className="dash-cards">
        <Card label="集まった声（累計）" value={stats.total} unit="件" />
        <Card label="今月の声" value={stats.thisMonth} unit="件" />
        <Card label="改修完了" value={stats.done} unit="件" />
        <Card label="完了率" value={stats.doneRate} unit="%" />
        <Card label="学びDB還元" value={stats.learned} unit="件" />
      </div>

      <section className="dash-section">
        <h2>声の集まり（週次・直近8週）</h2>
        <div className="dash-bars">
          {stats.weekly.map((w) => (
            <div key={w.label} className="dash-bar-col" title={`${w.label} ${w.count}件`}>
              <div className="dash-bar-num">{w.count > 0 ? w.count : ""}</div>
              <div
                className="dash-bar"
                style={{ height: `${Math.max(4, (w.count / maxWeek) * 120)}px` }}
              />
              <div className="dash-bar-label">{w.label}</div>
            </div>
          ))}
        </div>
      </section>

      <section className="dash-section">
        <h2>カイゼンの流れ（いまどの段に何件あるか）</h2>
        <div className="dash-funnel">
          {stats.funnel.map((f) => (
            <div key={f.stage} className="dash-funnel-item">
              <div className="dash-funnel-count">{f.count}</div>
              <div className="dash-funnel-stage">{f.stage}</div>
            </div>
          ))}
        </div>
      </section>

      <section className="dash-section">
        <h2>システム別</h2>
        <table className="dash-table">
          <thead>
            <tr>
              <th>システム</th>
              <th className="num">声</th>
              <th className="num">完了</th>
            </tr>
          </thead>
          <tbody>
            {stats.bySystem.map((s) => (
              <tr key={s.name}>
                <td>{s.name}</td>
                <td className="num">{s.total}</td>
                <td className="num">{s.done}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>

      <section className="dash-section">
        <h2>最近の声</h2>
        <div className="dash-recent">
          {stats.recent.map((r) => (
            <div key={r.ticketId + r.createdTime} className="dash-recent-row">
              <span className="dash-recent-date">{fmtDate(r.createdTime)}</span>
              <span
                className="dash-recent-state"
                style={{ color: metaOf(r.state).color }}
              >
                {r.state}
              </span>
              <span className="dash-recent-title">
                {r.title}
                <small>
                  {r.system}
                  {r.reporter ? `／${r.reporter}` : ""}（{r.ticketId}）
                </small>
              </span>
            </div>
          ))}
          {stats.recent.length === 0 && (
            <div className="typing">まだ声がありません。各システム右下のフクロウ博士からどうぞ。</div>
          )}
        </div>
      </section>

      <div className="footer">
        カイゼンくん 成長ダッシュボード ／ 集計 {new Date(stats.generatedAt).toLocaleString("ja-JP")}
      </div>
    </div>
  );
}

function DashHeader({ stats }: { stats?: KaizenStats }) {
  // 進行中件数を計算（受付・検討・提案中・改修中）
  const inProgressCount = stats
    ? stats.funnel
        .filter(f => f.stage === "受付" || f.stage === "検討・提案中" || f.stage === "改修中")
        .reduce((sum, f) => sum + f.count, 0)
    : 0;

  return (
    <header className="header">
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img src="/kaizen-kun.png" alt="" className="dash-logo" />
      <div>
        <h1>カイゼンくん 成長ダッシュボード</h1>
        <div className="sub">声が集まる → 直る → 学びになる、の現在地</div>
      </div>
      {stats && inProgressCount > 0 && (
        <div className="progress-badge">
          進行中 {inProgressCount} 件
        </div>
      )}
    </header>
  );
}

function Card({ label, value, unit }: { label: string; value: number; unit: string }) {
  return (
    <div className="dash-card">
      <div className="dash-card-label">{label}</div>
      <div className="dash-card-value">
        {value}
        <small>{unit}</small>
      </div>
    </div>
  );
}
