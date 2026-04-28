import Anthropic from "npm:@anthropic-ai/sdk";
import type { MatchRequest, MatchResponse } from "./_shared/types.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const ROLE_LABELS: Record<string, string> = {
  founder: "Practice founder / owner",
  senior: "Senior accountant / manager",
  bookkeeper: "Bookkeeper",
  industry: "Finance Director / CFO (industry)",
  junior: "Junior / newly qualified",
  other: "Accounting professional",
};

const TIME_LABELS: Record<string, string> = {
  "wed-am":   "Wednesday morning (13 May, 10:20–13:00)",
  "wed-pm":   "Wednesday afternoon (13 May, 13:00–18:00)",
  "wed-full": "Wednesday all day (13 May)",
  "thu-am":   "Thursday morning (14 May, 10:20–13:00)",
  "thu-pm":   "Thursday afternoon (14 May, 13:00–18:00)",
  "thu-full": "Thursday all day (14 May)",
};

const CATEGORY_LABELS: Record<string, string> = {
  "practice-management": "Practice management & growth",
  "ai-automation": "AI & automation",
  bookkeeping: "Bookkeeping software",
  "tax-mtd": "Tax, VAT & MTD",
  "doc-management": "Document management",
  payroll: "Payroll",
};

const SYSTEM_PROMPT = `You are an expert conference session matching assistant for UK accounting professionals attending Accountex London 2026 at ExCeL London, 13–14 May 2026.

Your task: rank a pre-filtered shortlist of sessions and exhibitor stands against one attendee's specific profile.

Ranking priorities (in order):
1. Direct relevance to their stated problem — semantic and keyword match
2. Alignment with their selected software/topic categories
3. Fit with their role and seniority level
4. Practical, actionable sessions (workshops, case studies, live demos) over purely aspirational talks
5. Variety of theatres across the top 12 — do not cluster all picks in one track

Output rules — CRITICAL:
- Return ONLY valid JSON. No markdown, no prose, no preamble, no explanation outside the JSON.
- sessions: up to 20 items (ranked best-first), each with session_id, rank (1-based integer), reason
- booths: up to 8 items, each with company_name, stand_number, rank, reason
- themes: 3 to 5 short phrases, max 80 characters each, describing the narrative pattern across the top sessions
- Each reason: 1–2 sentences in second person ("you" / "your firm"), specific to their stated problem, max 200 characters`;

function buildUserPrompt(req: MatchRequest): string {
  const { user_profile, sessions, exhibitors } = req;
  const categoryNames = user_profile.categories
    .map((c) => CATEGORY_LABELS[c] ?? c)
    .join(", ");

  const sessionsCompact = sessions.map((s) => ({
    session_id: s.session_id,
    title: s.title,
    theatre: s.theatre,
    day: s.day,
    time: `${s.start_time}–${s.end_time}`,
    categories: s.categories,
    description: s.description.slice(0, 300),
  }));

  const exhibitorsCompact = exhibitors.map((e) => ({
    company_name: e.company_name,
    stand_number: e.stand_number,
    products: e.normalised_products.slice(0, 5).join(", "),
    description: e.company_description.slice(0, 200),
  }));

  const tw = user_profile.time_window;
  const timeDisplay = Array.isArray(tw)
    ? tw.map((t) => TIME_LABELS[t] ?? t).join(" + ")
    : (TIME_LABELS[tw as string] ?? tw);

  return `Attendee profile:
- First name: ${user_profile.first_name || "Attendee"}
- Role: ${ROLE_LABELS[user_profile.role] ?? user_profile.role}
- Problem statement: "${user_profile.problem}"
- Categories of interest: ${categoryNames}
- Attendance window: ${timeDisplay}

Pre-filtered sessions (${sessionsCompact.length} total):
${JSON.stringify(sessionsCompact, null, 1)}

Pre-filtered exhibitor stands (${exhibitorsCompact.length} total):
${JSON.stringify(exhibitorsCompact, null, 1)}

Return JSON in this exact shape:
{
  "sessions": [{ "session_id": "...", "rank": 1, "reason": "..." }],
  "booths": [{ "company_name": "...", "stand_number": "...", "rank": 1, "reason": "..." }],
  "themes": ["...", "...", "..."]
}`;
}

function fallbackResponse(): MatchResponse {
  return { sessions: [], booths: [], themes: [] };
}

function extractJSON(text: string): MatchResponse | null {
  const match = text.match(/\{[\s\S]*\}/);
  if (!match) return null;
  try {
    return JSON.parse(match[0]) as MatchResponse;
  } catch {
    return null;
  }
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  const apiKey = Deno.env.get("ANTHROPIC_API_KEY");
  if (!apiKey) {
    return new Response(
      JSON.stringify({ fallback: true, error: "ANTHROPIC_API_KEY not set" }),
      { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  }

  let body: MatchRequest;
  try {
    body = await req.json();
  } catch {
    return new Response(JSON.stringify({ fallback: true, error: "Invalid JSON body" }), {
      status: 400,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }

  const anthropic = new Anthropic({ apiKey });
  const userPrompt = buildUserPrompt(body);

  let lastError: string = "";

  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 20000);

      const message = await anthropic.messages.create(
        {
          model: "claude-haiku-4-5-20251001",
          max_tokens: 2048,
          system: [
            {
              type: "text",
              text: SYSTEM_PROMPT,
              // @ts-ignore — cache_control is supported by the API but not yet typed in sdk
              cache_control: { type: "ephemeral" },
            },
          ],
          messages: [{ role: "user", content: userPrompt }],
        },
        { signal: controller.signal },
      );

      clearTimeout(timeoutId);

      const text =
        message.content[0].type === "text" ? message.content[0].text : "";

      let result: MatchResponse | null = null;
      try {
        result = JSON.parse(text) as MatchResponse;
      } catch {
        result = extractJSON(text);
      }

      if (result && Array.isArray(result.sessions)) {
        return new Response(JSON.stringify(result), {
          status: 200,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }

      lastError = "Claude returned unparseable JSON";
    } catch (err) {
      lastError = err instanceof Error ? err.message : String(err);
      const isRetryable =
        lastError.includes("529") ||
        lastError.includes("500") ||
        lastError.includes("overloaded");
      if (!isRetryable || attempt === 1) break;
      await new Promise((r) => setTimeout(r, 1000));
    }
  }

  console.error("match-sessions fallback:", lastError);
  return new Response(JSON.stringify({ ...fallbackResponse(), fallback: true }), {
    status: 200,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
});
