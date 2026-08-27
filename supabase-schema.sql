-- Run once in Supabase SQL Editor. Never place a service_role key in the extension.
create extension if not exists pgcrypto;

create table if not exists public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  email text not null,
  display_name text not null default '',
  role text not null default 'user' check (role in ('owner','admin','user')),
  status text not null default 'active' check (status in ('active','paused','suspended','banned')),
  access_granted boolean not null default false,
  permissions jsonb not null default '{"unfollow":true,"engage":true,"api_keys":true}'::jsonb,
  assigned_api_ids jsonb not null default '[]'::jsonb,
  last_seen_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.audit_logs (
  id bigint generated always as identity primary key,
  actor_id uuid references auth.users(id) on delete set null,
  target_id uuid references auth.users(id) on delete set null,
  action text not null,
  details jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create table if not exists public.app_settings (
  id boolean primary key default true check (id = true),
  owner_telegram text not null default '@yourusername',
  custom_apis jsonb not null default '[]'::jsonb,
  updated_at timestamptz not null default now()
);
insert into public.app_settings (id) values (true) on conflict (id) do nothing;

create table if not exists public.extension_config (
  id boolean primary key default true check (id = true),
  config_version bigint not null default 1,
  maintenance_mode boolean not null default false,
  policy jsonb not null default '{"allow_unfollow":true,"allow_engage":true,"allow_ai":true,"allow_user_api_keys":true,"allow_custom_providers":true,"fallback_enabled":true}'::jsonb,
  updated_by uuid references auth.users(id) on delete set null,
  updated_at timestamptz not null default now()
);
insert into public.extension_config (id) values (true) on conflict (id) do nothing;

alter table public.profiles add column if not exists access_granted boolean not null default false;
alter table public.profiles add column if not exists assigned_api_ids jsonb not null default '[]'::jsonb;
alter table public.app_settings add column if not exists custom_apis jsonb not null default '[]'::jsonb;
alter table public.profiles drop constraint if exists profiles_status_check;
alter table public.profiles add constraint profiles_status_check check (status in ('active','paused','suspended','banned'));

create or replace function public.handle_new_user() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  insert into public.profiles (id, email, display_name, role, access_granted)
  values (
    new.id,
    lower(coalesce(new.email, '')),
    coalesce(new.raw_user_meta_data->>'full_name', ''),
    case when lower(coalesce(new.email, '')) = 'rubelislam20235@gmail.com' then 'owner' else 'user' end,
    lower(coalesce(new.email, '')) = 'rubelislam20235@gmail.com'
  ) on conflict (id) do nothing;
  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created after insert on auth.users
for each row execute function public.handle_new_user();

create or replace function public.is_admin() returns boolean
language sql stable security definer set search_path = public as $$
  select exists(select 1 from public.profiles where id = auth.uid() and role in ('owner','admin') and status = 'active');
$$;

create or replace function public.protect_profile_privileges() returns trigger
language plpgsql security definer set search_path = public as $$
declare actor_role text;
begin
  select role into actor_role from public.profiles where id = auth.uid();
  if old.role = 'owner' then
    if actor_role <> 'owner' then raise exception 'Only the owner can modify owner privileges'; end if;
    new.role := 'owner';
    new.status := 'active';
    new.access_granted := true;
  elsif actor_role = 'user' then
    new.role := old.role;
    new.status := old.status;
    new.access_granted := old.access_granted;
    new.permissions := old.permissions;
    new.assigned_api_ids := old.assigned_api_ids;
  elsif actor_role = 'admin' then
    if new.role = 'owner' then
      raise exception 'Only the owner can modify owner privileges';
    end if;
  end if;
  new.updated_at := now();
  return new;
end;
$$;

drop trigger if exists protect_profile_privileges on public.profiles;
create trigger protect_profile_privileges before update on public.profiles
for each row execute function public.protect_profile_privileges();

alter table public.profiles enable row level security;
alter table public.audit_logs enable row level security;
alter table public.app_settings enable row level security;
alter table public.extension_config enable row level security;

drop policy if exists profiles_read on public.profiles;
create policy profiles_read on public.profiles for select to authenticated
using (id = auth.uid() or public.is_admin());

drop policy if exists profiles_self_update on public.profiles;
create policy profiles_self_update on public.profiles for update to authenticated
using (id = auth.uid()) with check (id = auth.uid());

drop policy if exists profiles_admin_update on public.profiles;
create policy profiles_admin_update on public.profiles for update to authenticated
using (public.is_admin()) with check (public.is_admin());

drop policy if exists audit_insert on public.audit_logs;
create policy audit_insert on public.audit_logs for insert to authenticated
with check (actor_id = auth.uid());

drop policy if exists audit_admin_read on public.audit_logs;
create policy audit_admin_read on public.audit_logs for select to authenticated
using (actor_id = auth.uid() or public.is_admin());

drop policy if exists app_settings_read on public.app_settings;
create policy app_settings_read on public.app_settings for select to authenticated using (true);
drop policy if exists app_settings_admin_update on public.app_settings;
create policy app_settings_admin_update on public.app_settings for update to authenticated
using (public.is_admin()) with check (public.is_admin());

drop policy if exists extension_config_read on public.extension_config;
create policy extension_config_read on public.extension_config for select to authenticated using (true);
drop policy if exists extension_config_admin_update on public.extension_config;
create policy extension_config_admin_update on public.extension_config for update to authenticated
using (public.is_admin()) with check (public.is_admin());

create or replace function public.bump_extension_config_version() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  new.config_version := old.config_version + 1;
  new.updated_at := now();
  new.updated_by := auth.uid();
  return new;
end;
$$;
drop trigger if exists bump_extension_config_version on public.extension_config;
create trigger bump_extension_config_version before update on public.extension_config
for each row execute function public.bump_extension_config_version();

-- Existing owner account bootstrap, if it was created before this schema.
insert into public.profiles (id, email, role, access_granted)
select id, lower(email), 'owner', true from auth.users where lower(email) = 'rubelislam20235@gmail.com'
on conflict (id) do update set role = 'owner', status = 'active', access_granted = true;
