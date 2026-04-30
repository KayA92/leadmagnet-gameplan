// Supabase project credentials — safe to commit (anon key is public).
// The Anthropic API key is stored only as a Supabase secret and never appears here.

export const SUPABASE_URL = 'https://dcaoxlzvhfvaqxzdmavc.supabase.co';

export const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImRjYW94bHp2aGZ2YXF4emRtYXZjIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzY5NDE2NDAsImV4cCI6MjA5MjUxNzY0MH0.qCP7lL8OqsqwQrrUZNzOKJWMYjhGN2t-1mxi0AkWWts';

export const EDGE_FUNCTION_URL = `${SUPABASE_URL}/functions/v1/match-sessions`;
