-- Instant links, cuts, Slack alerts, mentions, uploads and the browser extension.

alter table public.videos
	add column cuts jsonb,
	add column suggested_cuts jsonb,
	add column optimized boolean not null default true,
	add column raw_object_key text,
	add column source text not null default 'recording'
		check (source in ('recording', 'extension', 'upload'));

create index videos_raw_object_idx on public.videos (updated_at)
	where raw_object_key is not null;

alter table public.profiles
	add column slack_alerts boolean not null default true,
	add column slack_user_id text,
	add column slack_checked_at timestamptz;

alter table public.comments
	add column mentions uuid[] not null default '{}';

create table public.extension_keys (
	id uuid primary key default gen_random_uuid(),
	user_id uuid not null references public.profiles (id) on delete cascade,
	key_hash text not null unique,
	created_at timestamptz not null default now(),
	last_used_at timestamptz
);

create index extension_keys_user_idx on public.extension_keys (user_id, created_at desc);

alter table public.extension_keys enable row level security;
