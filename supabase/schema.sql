-- 闪词 FlashVocab — Supabase 云同步表结构与权限
-- 在 Supabase Dashboard → SQL Editor 中整段执行一次即可。

create table if not exists public.flashvocab_state (
  user_id uuid primary key references auth.users (id) on delete cascade,
  state jsonb not null,
  client_updated_at bigint not null default 0,
  updated_at timestamptz not null default now()
);

alter table public.flashvocab_state enable row level security;

drop policy if exists "flashvocab select own" on public.flashvocab_state;
create policy "flashvocab select own"
  on public.flashvocab_state for select
  using (auth.uid() = user_id);

drop policy if exists "flashvocab insert own" on public.flashvocab_state;
create policy "flashvocab insert own"
  on public.flashvocab_state for insert
  with check (auth.uid() = user_id);

drop policy if exists "flashvocab update own" on public.flashvocab_state;
create policy "flashvocab update own"
  on public.flashvocab_state for update
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

drop policy if exists "flashvocab delete own" on public.flashvocab_state;
create policy "flashvocab delete own"
  on public.flashvocab_state for delete
  using (auth.uid() = user_id);

grant select, insert, update, delete on public.flashvocab_state to authenticated;
revoke all on public.flashvocab_state from anon;

create or replace function public.flashvocab_touch_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists flashvocab_touch_updated_at on public.flashvocab_state;
create trigger flashvocab_touch_updated_at
  before update on public.flashvocab_state
  for each row execute function public.flashvocab_touch_updated_at();
