create extension if not exists pgcrypto;

create table if not exists public.app_settings (
  key text primary key,
  value text not null,
  updated_at timestamptz not null default now(),
  updated_by uuid references auth.users(id)
);

create table if not exists public.attendees (
  id text primary key,
  name text not null,
  email text not null default '',
  unique_id text not null default '',
  qr_code text not null,
  qr_code_normalized text not null unique,
  company text not null default '',
  ticket_type text not null default '',
  checked_in boolean not null default false,
  check_in_time timestamptz,
  checked_in_by uuid references auth.users(id),
  imported_at timestamptz not null default now(),
  source_row integer not null,
  original jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists attendees_search_idx on public.attendees
using gin (
  to_tsvector(
    'simple',
    coalesce(name, '') || ' ' ||
      coalesce(email, '') || ' ' ||
      coalesce(unique_id, '') || ' ' ||
      coalesce(qr_code, '') || ' ' ||
      coalesce(company, '') || ' ' ||
      coalesce(ticket_type, '')
  )
);

create or replace function public.set_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists set_app_settings_updated_at on public.app_settings;
create trigger set_app_settings_updated_at
before update on public.app_settings
for each row
execute function public.set_updated_at();

drop trigger if exists set_attendees_updated_at on public.attendees;
create trigger set_attendees_updated_at
before update on public.attendees
for each row
execute function public.set_updated_at();

alter table public.app_settings enable row level security;
alter table public.attendees enable row level security;

drop policy if exists "Authenticated staff can read settings" on public.app_settings;
create policy "Authenticated staff can read settings"
on public.app_settings
for select
to authenticated
using (true);

drop policy if exists "Authenticated staff can write settings" on public.app_settings;
create policy "Authenticated staff can write settings"
on public.app_settings
for all
to authenticated
using (true)
with check (true);

drop policy if exists "Authenticated staff can read attendees" on public.attendees;
create policy "Authenticated staff can read attendees"
on public.attendees
for select
to authenticated
using (true);

drop policy if exists "Authenticated staff can import attendees" on public.attendees;
create policy "Authenticated staff can import attendees"
on public.attendees
for insert
to authenticated
with check (true);

drop policy if exists "Authenticated staff can update attendees" on public.attendees;
create policy "Authenticated staff can update attendees"
on public.attendees
for update
to authenticated
using (true)
with check (true);

drop policy if exists "Authenticated staff can clear attendees" on public.attendees;
create policy "Authenticated staff can clear attendees"
on public.attendees
for delete
to authenticated
using (true);

insert into public.app_settings (key, value)
values ('event_name', 'Event Check-In')
on conflict (key) do nothing;
