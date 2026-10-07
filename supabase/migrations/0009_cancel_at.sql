-- Lot Current: the end date of a cancellation the dealership has scheduled.
--
-- The Billing Portal cancels at the end of the paid period (scripts/
-- stripe-setup-lib.mjs: subscription_cancel mode at_period_end). Stripe then
-- keeps the subscription trialing or active until that date and only says
-- so in cancel_at / cancel_at_period_end; the status changes when the
-- period ends (customer.subscription.deleted). Without this column the
-- manager view went on saying "renews <date>" or "first charge <date>"
-- after a manager had cancelled.
--
-- cancel_at  when Stripe will end the subscription: the event's cancel_at,
--            or its period end when only cancel_at_period_end is set. Null
--            when nothing is scheduled; the billing function writes it on
--            every subscription event, so undoing the cancellation in the
--            portal clears it again (functions/_shared/billing.mjs,
--            applyStripeEvent).
--
-- The first change made after the project applied 0001 to 0008, so it is a
-- file of its own (supabase/README.md, step 2). The table's grants and its
-- row-level security policy cover the new column as they cover the others:
-- members read it, only the billing function writes it.

alter table public.subscriptions add column cancel_at timestamptz;
comment on column public.subscriptions.cancel_at is 'When Stripe will end the subscription after a cancellation the dealership scheduled (the end of the paid period, from the Billing Portal); null when nothing is scheduled.';
