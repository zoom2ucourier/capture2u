create table public.login_codes (
	email text primary key,
	code_hash text,
	expires_at timestamptz not null,
	attempts integer not null default 0,
	failed_count integer not null default 0,
	sent_count integer not null default 0,
	window_started_at timestamptz not null default now(),
	last_sent_at timestamptz not null default now()
);

alter table public.login_codes enable row level security;

create table public.folders (
	id uuid primary key default gen_random_uuid(),
	owner_id uuid not null references public.profiles (id) on delete cascade,
	name text not null check (char_length(name) between 1 and 80),
	shared boolean not null default false,
	created_at timestamptz not null default now()
);

create index folders_owner_idx on public.folders (owner_id, name);
create index folders_shared_idx on public.folders (name) where shared;

alter table public.folders enable row level security;

alter table public.videos
	add column folder_id uuid references public.folders (id) on delete set null,
	add column trim_start_seconds numeric,
	add column trim_end_seconds numeric,
	add column first_view_notified_at timestamptz;

create index videos_folder_idx on public.videos (folder_id) where folder_id is not null;

alter table public.profiles
	add column email_notifications boolean not null default true;

create unique index comments_one_reaction_idx
	on public.comments (video_id, author_id, body)
	where kind = 'emoji';

-- Sign-in codes: at most 5 codes and 10 wrong guesses per address per hour,
-- 5 guesses per code, and 30 seconds between sends. Both functions lock the
-- row so parallel requests cannot get around the limits.
create or replace function public.issue_login_code(
	p_email text,
	p_code_hash text,
	p_ttl_seconds integer
)
returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
	entry public.login_codes%rowtype;
	inserted integer;
begin
	select * into entry from public.login_codes where email = p_email for update;

	if not found then
		insert into public.login_codes (email, code_hash, expires_at, sent_count)
		values (p_email, p_code_hash, now() + make_interval(secs => p_ttl_seconds), 1)
		on conflict (email) do nothing;
		get diagnostics inserted = row_count;
		if inserted = 0 then
			return 'wait';
		end if;
		return 'ok';
	end if;

	if entry.last_sent_at > now() - interval '30 seconds' then
		return 'wait';
	end if;

	if entry.window_started_at > now() - interval '1 hour' then
		if entry.sent_count >= 5 or entry.failed_count >= 10 then
			return 'limit';
		end if;
		update public.login_codes
		set code_hash = p_code_hash,
			expires_at = now() + make_interval(secs => p_ttl_seconds),
			attempts = 0,
			sent_count = sent_count + 1,
			last_sent_at = now()
		where email = p_email;
	else
		update public.login_codes
		set code_hash = p_code_hash,
			expires_at = now() + make_interval(secs => p_ttl_seconds),
			attempts = 0,
			failed_count = 0,
			sent_count = 1,
			window_started_at = now(),
			last_sent_at = now()
		where email = p_email;
	end if;

	return 'ok';
end;
$$;

create or replace function public.check_login_code(
	p_email text,
	p_code_hash text
)
returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
	entry public.login_codes%rowtype;
begin
	select * into entry from public.login_codes where email = p_email for update;

	if not found or entry.code_hash is null then
		return 'invalid';
	end if;
	if entry.failed_count >= 10 and entry.window_started_at > now() - interval '1 hour' then
		return 'locked';
	end if;
	if entry.expires_at < now() then
		return 'expired';
	end if;
	if entry.attempts >= 5 then
		return 'locked';
	end if;

	if entry.code_hash = p_code_hash then
		update public.login_codes
		set code_hash = null, attempts = 0
		where email = p_email;
		return 'ok';
	end if;

	update public.login_codes
	set attempts = attempts + 1, failed_count = failed_count + 1
	where email = p_email;
	return 'invalid';
end;
$$;

revoke all on function public.issue_login_code(text, text, integer) from public, anon, authenticated;
revoke all on function public.check_login_code(text, text) from public, anon, authenticated;
