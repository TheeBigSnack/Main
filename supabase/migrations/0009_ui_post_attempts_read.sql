-- Lot Current: who reads the post attempts (time per post).
--
-- 0002_rls.sql let every member of a dealership read all of its post
-- attempts, so a salesperson could read a colleague's: which cars they
-- tried, how long each post took and why one stopped. Only the manager view
-- reads them (manager/manager.js; the sync function writes them and reads
-- none), and the texts that say who sees them say the managers do
-- (legal/questions-for-attorney.md 8.4, the website's FAQ).
--
-- From here on a salesperson reads their own attempts and a manager reads
-- every attempt of the dealership. Writing is unchanged: a salesperson
-- records and corrects their own (the sync function's upsert, whose
-- conflicting row is always the caller's own: user_id is in its key), a
-- manager corrects any, and only managers delete. v_salesperson_summary runs
-- under the caller's rights, so a salesperson's own median comes back and a
-- colleague's is null; a manager's view is unchanged.
--
-- A change made after the project applied 0001 to 0008, so it is a file of
-- its own: it replaces 0002's select policy and leaves that file as it was
-- deployed. A fresh build applies 0002 and then this, and ends the same.

drop policy if exists "members read their dealership's post attempts" on public.post_attempts;
drop policy if exists "salespeople read their own post attempts, managers all of their dealership's" on public.post_attempts;

create policy "salespeople read their own post attempts, managers all of their dealership's"
  on public.post_attempts for select to authenticated
  using ((public.is_member(dealership_id) and user_id = auth.uid()) or public.is_manager(dealership_id));
