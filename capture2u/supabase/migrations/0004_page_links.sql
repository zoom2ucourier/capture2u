-- The web pages a recording showed, with when each one came on screen, so the
-- watch page can link to the page being shown.

alter table public.videos
	add column page_links jsonb;
