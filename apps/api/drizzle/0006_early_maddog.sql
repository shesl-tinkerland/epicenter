ALTER TABLE "ledger" DROP CONSTRAINT "ledger_type_valid";--> statement-breakpoint
ALTER TABLE "participant" DROP CONSTRAINT "participant_status_valid";--> statement-breakpoint
ALTER TABLE "ledger" DROP CONSTRAINT "ledger_participant_id_participant_id_fk";
--> statement-breakpoint
DROP INDEX "ledger_participant_id_idx";--> statement-breakpoint
ALTER TABLE "challenge" ADD COLUMN "outcome" text DEFAULT 'pending' NOT NULL;--> statement-breakpoint
ALTER TABLE "challenge" ADD COLUMN "outcome_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "challenge" ADD COLUMN "outcome_actor_id" text;--> statement-breakpoint
ALTER TABLE "challenge" ADD CONSTRAINT "challenge_outcome_actor_id_user_id_fk" FOREIGN KEY ("outcome_actor_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "challenge_outcome_idx" ON "challenge" USING btree ("outcome");--> statement-breakpoint
ALTER TABLE "ledger" DROP COLUMN "participant_id";--> statement-breakpoint
ALTER TABLE "participant" DROP COLUMN "status";--> statement-breakpoint
ALTER TABLE "participant" DROP COLUMN "status_at";--> statement-breakpoint
ALTER TABLE "challenge" ADD CONSTRAINT "challenge_outcome_valid" CHECK (outcome IN ('pending', 'done', 'missed'));--> statement-breakpoint
ALTER TABLE "ledger" ADD CONSTRAINT "ledger_type_valid" CHECK (type IN ('challenge_outcome', 'payment'));