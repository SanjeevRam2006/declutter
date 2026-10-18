-- Run this once in Supabase SQL Editor.
create table if not exists public.declutter_chats (
  user_id uuid not null references auth.users(id) on delete cascade,
  chat_id text not null,
  title text not null default 'Saved chat',
  messages jsonb not null default '[]'::jsonb,
  saved_at timestamptz not null default now(),
  primary key (user_id, chat_id)
);

alter table public.declutter_chats enable row level security;

-- The server uses the service-role key for these requests, so no public client
-- policy is required. This keeps saved transcripts out of the browser client.
revoke all on table public.declutter_chats from anon, authenticated;
grant all on table public.declutter_chats to service_role;
