-- Capture2u schema.
-- Every table has row level security on with no policies: the browser never
-- talks to the database directly. All access goes through the Worker, which
-- uses the service key and enforces who can see what.

create table public.allowed_email_domains (
	domain text primary key
);

insert into public.allowed_email_domains (domain) values
	('zoom2u.com'),
	('locate2u.com'),
	('locatetech.nz'),
	('freightmatch.com.au');

create table public.profiles (
	id uuid primary key references auth.users (id) on delete cascade,
	email text not null unique,
	full_name text,
	avatar_url text,
	role text not null default 'member' check (role in ('member', 'admin')),
	created_at timestamptz not null default now()
);

create table public.videos (
	id text primary key,
	owner_id uuid not null references public.profiles (id) on delete cascade,
	title text not null default 'Untitled recording',
	title_edited boolean not null default false,
	status text not null default 'uploading'
		check (status in ('uploading', 'ready', 'failed')),
	visibility text not null default 'public'
		check (visibility in ('public', 'company', 'private')),
	password_hash text,
	keep boolean not null default false,
	duration_seconds numeric,
	width integer,
	height integer,
	size_bytes bigint,
	mime_type text,
	object_key text,
	thumbnail_key text,
	upload_id text,
	transcript_status text not null default 'pending'
		check (transcript_status in ('pending', 'processing', 'ready', 'failed', 'none')),
	transcript_text text,
	transcript_segments jsonb,
	summary text,
	chapters jsonb,
	ai_status text not null default 'pending'
		check (ai_status in ('pending', 'processing', 'ready', 'failed', 'none')),
	view_count integer not null default 0,
	search tsvector generated always as (
		setweight(to_tsvector('english', coalesce(title, '')), 'A')
		|| setweight(to_tsvector('english', coalesce(summary, '')), 'B')
		|| setweight(to_tsvector('english', coalesce(left(transcript_text, 200000), '')), 'C')
	) stored,
	created_at timestamptz not null default now(),
	updated_at timestamptz not null default now()
);

create index videos_owner_created_idx on public.videos (owner_id, created_at desc);
create index videos_search_idx on public.videos using gin (search);
create index videos_retention_idx on public.videos (created_at) where keep = false;
create index videos_stale_upload_idx on public.videos (created_at) where status = 'uploading';

create table public.video_views (
	video_id text not null references public.videos (id) on delete cascade,
	viewer_key text not null,
	viewed_on date not null default (now() at time zone 'utc')::date,
	viewer_id uuid references public.profiles (id) on delete set null,
	created_at timestamptz not null default now(),
	primary key (video_id, viewer_key, viewed_on)
);

create table public.comments (
	id uuid primary key default gen_random_uuid(),
	video_id text not null references public.videos (id) on delete cascade,
	author_id uuid not null references public.profiles (id) on delete cascade,
	parent_id uuid references public.comments (id) on delete cascade,
	kind text not null default 'text' check (kind in ('text', 'emoji')),
	body text not null check (char_length(body) between 1 and 4000),
	timestamp_seconds numeric,
	created_at timestamptz not null default now()
);

create index comments_video_idx on public.comments (video_id, created_at);

create table public.retention_runs (
	id bigint generated always as identity primary key,
	ran_at timestamptz not null default now(),
	mode text not null,
	cutoff timestamptz not null,
	candidates integer not null,
	deleted integer not null,
	failed integer not null,
	details jsonb
);

alter table public.allowed_email_domains enable row level security;
alter table public.profiles enable row level security;
alter table public.videos enable row level security;
alter table public.video_views enable row level security;
alter table public.comments enable row level security;
alter table public.retention_runs enable row level security;

-- Sign-up is refused at the database for any address outside the allowed
-- domains, whichever sign-in method is used. The Worker checks again on
-- every request.
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
	email_domain text := lower(split_part(new.email, '@', 2));
begin
	if not exists (
		select 1 from public.allowed_email_domains d where d.domain = email_domain
	) then
		raise exception 'Sign-up is limited to company email addresses';
	end if;

	insert into public.profiles (id, email, full_name, avatar_url)
	values (
		new.id,
		lower(new.email),
		coalesce(new.raw_user_meta_data ->> 'full_name', new.raw_user_meta_data ->> 'name'),
		new.raw_user_meta_data ->> 'avatar_url'
	)
	on conflict (id) do nothing;

	return new;
end;
$$;

create trigger on_auth_user_created
	after insert on auth.users
	for each row execute function public.handle_new_user();

create or replace function public.touch_updated_at()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
	new.updated_at := now();
	return new;
end;
$$;

create trigger videos_touch_updated_at
	before update on public.videos
	for each row execute function public.touch_updated_at();

-- One view per viewer per day. Returns true when this call counted.
create or replace function public.record_video_view(
	p_video_id text,
	p_viewer_key text,
	p_viewer_id uuid default null
)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
	inserted integer;
begin
	insert into public.video_views (video_id, viewer_key, viewer_id)
	values (p_video_id, p_viewer_key, p_viewer_id)
	on conflict do nothing;
	get diagnostics inserted = row_count;

	if inserted > 0 then
		update public.videos
		set view_count = view_count + 1, updated_at = updated_at
		where id = p_video_id;
		return true;
	end if;
	return false;
end;
$$;

revoke all on function public.record_video_view(text, text, uuid) from public, anon, authenticated;
revoke all on function public.handle_new_user() from public, anon, authenticated;
