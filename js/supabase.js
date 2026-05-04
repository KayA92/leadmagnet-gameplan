import { createClient } from 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/+esm';
import { SUPABASE_URL, SUPABASE_ANON_KEY } from './config.js';

export const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
  auth: {
    flowType: 'implicit',       // avoids PKCE code_verifier requirement — verifyOtp works without it
    detectSessionInUrl: false,  // prevents Supabase auto-consuming URL tokens during createClient() init
  },
});
