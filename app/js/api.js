import { EDGE_FUNCTION_URL, SUPABASE_ANON_KEY } from './config.js';

// Calls the match-sessions Edge Function with retry logic.
// Returns the ranked plan or { fallback: true } if all attempts fail.
export async function matchSessions(userProfile, sessions, exhibitors) {
  const body = JSON.stringify({ user_profile: userProfile, sessions, exhibitors });

  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 25000);

      const res = await fetch(EDGE_FUNCTION_URL, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${SUPABASE_ANON_KEY}`,
          'apikey': SUPABASE_ANON_KEY,
        },
        body,
        signal: controller.signal,
      });

      clearTimeout(timeoutId);

      if (res.status === 429) {
        // Rate limit — surface to caller for user-facing retry
        return { fallback: true, rateLimited: true };
      }

      if (!res.ok && (res.status >= 500)) {
        if (attempt === 0) {
          await new Promise(r => setTimeout(r, 1000));
          continue;
        }
        return { fallback: true };
      }

      const data = await res.json();
      return data;
    } catch (err) {
      if (attempt === 0) {
        await new Promise(r => setTimeout(r, 1000));
        continue;
      }
      console.error('matchSessions error:', err);
      return { fallback: true };
    }
  }

  return { fallback: true };
}
