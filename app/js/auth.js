import { supabase } from './supabase.js';

export async function sendMagicLink(email) {
  return supabase.auth.signInWithOtp({
    email,
    options: {
      emailRedirectTo: 'https://workiro-ai.com/app/plan/',
    },
  });
}

export async function getSession() {
  const { data } = await supabase.auth.getSession();
  return data.session;
}

export async function getUser() {
  const session = await getSession();
  return session?.user ?? null;
}

// Fires callback with (event, user) on every auth state change.
// Returns the unsubscribe function.
export function onAuthChange(callback) {
  const { data: { subscription } } = supabase.auth.onAuthStateChange(
    (event, session) => callback(event, session?.user ?? null),
  );
  return () => subscription.unsubscribe();
}
