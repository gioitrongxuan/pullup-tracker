import { serve } from 'https://deno.land/std@0.168.0/http/server.ts';

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
  });
}

interface SessionRecord { reps: number; created_at: string; }
interface DayRecord { date: string; reps: number; }

function groupByDay(sessions: SessionRecord[]): DayRecord[] {
  const map: Record<string, number> = {};
  for (const s of sessions) {
    const date = s.created_at.slice(0, 10); // yyyy-mm-dd UTC
    map[date] = (map[date] ?? 0) + s.reps;
  }
  return Object.entries(map)
    .map(([date, reps]) => ({ date, reps }))
    .sort((a, b) => b.date.localeCompare(a.date));
}

serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: CORS_HEADERS });
  }

  try {
    const { sessions } = await req.json();

    const apiKey = Deno.env.get('DEEPSEEK_API_KEY');
    if (!apiKey) return json({ error: 'DEEPSEEK_API_KEY not set' }, 500);
    if (!sessions?.length) return json({ error: 'No sessions provided' }, 400);

    // Aggregate to daily totals
    const days = groupByDay(sessions as SessionRecord[]);
    if (!days.length) return json({ error: 'No data after grouping' }, 400);

    const totalDays  = days.length;
    const totalReps  = days.reduce((s, d) => s + d.reps, 0);
    const avgPerDay  = (totalReps / totalDays).toFixed(1);
    const best       = days.reduce((a, b) => b.reps > a.reps ? b : a);
    const last7days  = days.slice(0, 7);
    const prev7days  = days.slice(7, 14);
    const avg7       = last7days.reduce((s, d) => s + d.reps, 0) / last7days.length;
    const avgPrev7   = prev7days.length
      ? prev7days.reduce((s, d) => s + d.reps, 0) / prev7days.length
      : null;

    // Group daily totals by day-of-week
    const byDow: Record<number, number[]> = {};
    days.forEach(d => {
      const dow = new Date(d.date + 'T12:00:00Z').getDay();
      if (!byDow[dow]) byDow[dow] = [];
      byDow[dow].push(d.reps);
    });
    const dowAvg = Object.entries(byDow).map(([dow, reps]) => ({
      dow: Number(dow),
      avg: (reps.reduce((a, b) => a + b, 0) / reps.length).toFixed(1),
    }));

    const prompt = `Dữ liệu tập kéo xà của người dùng (thống kê theo ngày):
- Tổng số ngày tập: ${totalDays}
- Trung bình mỗi ngày tập: ${avgPerDay} lần
- Kỷ lục trong 1 ngày: ${best.reps} lần (${best.date})
- TB 7 ngày tập gần nhất: ${avg7.toFixed(1)} lần
- TB 7 ngày tập trước đó: ${avgPrev7 !== null ? avgPrev7.toFixed(1) : 'chưa đủ dữ liệu'} lần
- Hiệu suất theo thứ trong tuần: ${JSON.stringify(dowAvg)}
- 5 ngày tập gần nhất: ${JSON.stringify(last7days.slice(0, 5))}

Trả về JSON, không có text khác:
{
  "trend": "improving|declining|stable",
  "trend_pct": 12,
  "summary": "nhận xét tổng quan 1-2 câu tiếng Việt, thẳng thắn",
  "best_dow": 3,
  "best_dow_label": "Thứ Tư",
  "weekly_data": [{"dow":0,"avg":0},{"dow":1,"avg":8},…{"dow":6,"avg":0}],
  "recommendations": ["lời khuyên ngắn 1", "lời khuyên ngắn 2", "lời khuyên ngắn 3"],
  "next_goal": 15
}`;

    const upstream = await fetch('https://api.deepseek.com/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model: 'deepseek-chat',
        messages: [
          { role: 'system', content: 'Fitness analytics assistant. Return ONLY valid JSON, no markdown, no explanation.' },
          { role: 'user',   content: prompt },
        ],
        response_format: { type: 'json_object' },
        temperature: 0.3,
      }),
    });

    if (!upstream.ok) {
      const detail = await upstream.text();
      return json({ error: `DeepSeek ${upstream.status}`, detail }, 502);
    }

    const raw    = await upstream.json();
    const result = JSON.parse(raw.choices[0].message.content);
    return json(result);

  } catch (err) {
    return json({ error: (err as Error).message }, 500);
  }
});
