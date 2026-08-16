-- SpectraWolf community edits (Supabase / Postgres)
--
-- One append-only table plus a view that picks the newest row per spectrum.
-- The view DERIVES the index rather than storing one, so it cannot drift from
-- the data; the earlier object-storage version maintained an index by hand and
-- silently dropped a page whenever a read missed its own write.

create table if not exists public.spectra_edits (
  id          bigint generated always as identity primary key,
  gid         text        not null check (gid ~ '^graph-[0-9]{1,4}$'),
  version     text        not null unique,
  author      text        not null default 'anonymous' check (char_length(author) <= 60),
  note        text        default ''                   check (char_length(note)   <= 200),
  em          jsonb,
  ab          jsonb,
  em2         jsonb,   -- second emission trace (CURVE I / CURVE II plates)
  extra       jsonb,   -- contributor-drawn curves: [{name, color, wl, inten}]
  reverted    boolean     not null default false,
  points      integer     not null default 0 check (points >= 0 and points <= 40000),
  created_at  timestamptz not null default now(),
  -- a row must carry a curve unless it is a revert marker
  constraint has_payload check (reverted or em is not null or ab is not null
                                or em2 is not null or extra is not null)
);

create index if not exists spectra_edits_gid_created
  on public.spectra_edits (gid, created_at desc);

create or replace view public.spectra_latest as
select distinct on (gid)
       gid, version, author, note, em, ab, em2, extra, reverted, points, created_at
from public.spectra_edits
order by gid, created_at desc;

alter table public.spectra_edits enable row level security;

drop policy if exists "anyone can read edits"  on public.spectra_edits;
drop policy if exists "anyone can add an edit" on public.spectra_edits;

-- public read, public append.  No update or delete policy exists, so the
-- history is immutable to the publishable key: a revert is a new row, and no
-- visitor can rewrite or erase someone else's version.
create policy "anyone can read edits"  on public.spectra_edits for select using (true);
create policy "anyone can add an edit" on public.spectra_edits for insert with check (true);

grant select on public.spectra_edits, public.spectra_latest to anon;
grant insert on public.spectra_edits to anon;
