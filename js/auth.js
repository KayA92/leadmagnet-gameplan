import { supabase } from './supabase.js';

export async function sendMagicLink(email, redirectTo) {
  return supabase.auth.signInWithOtp({
    email,
    options: {
      emailRedirectTo: redirectTo ?? `${window.location.origin}/magic-link-confirm/?`,
    },
  });
}

export async function getSession() {
  const { data } = await supabase.auth.getSession();
  return data.session;
}

export async function getUser() {
  const { data: { user } } = await supabase.auth.getUser();
  return user ?? null;
}

// Fires callback with (event, user) on every auth state change.
// Returns the unsubscribe function.
export function onAuthChange(callback) {
  const { data: { subscription } } = supabase.auth.onAuthStateChange(
    (event, session) => callback(event, session?.user ?? null),
  );
  return () => subscription.unsubscribe();
}

export async function signInAnon() {
  return supabase.auth.signInAnonymously();
}

export async function updateUserEmail(email, redirectTo) {
  return supabase.auth.updateUser({
    email,
    options: { emailRedirectTo: redirectTo },
  });
}

export async function checkEmailStatus(email) {
  return supabase.rpc('check_email_status', { p_email: email.toLowerCase().trim() });
}
