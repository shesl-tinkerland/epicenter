ALTER TABLE "ledger" ADD COLUMN "participant_id" text;--> statement-breakpoint
ALTER TABLE "participant" ADD COLUMN "invited_by" text;--> statement-breakpoint
ALTER TABLE "participant" ADD COLUMN "accepted_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "ledger" ADD CONSTRAINT "ledger_participant_id_participant_id_fk" FOREIGN KEY ("participant_id") REFERENCES "public"."participant"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "participant" ADD CONSTRAINT "participant_invited_by_user_id_fk" FOREIGN KEY ("invited_by") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "ledger_participant_id_idx" ON "ledger" USING btree ("participant_id");--> statement-breakpoint
CREATE INDEX "participant_invited_by_idx" ON "participant" USING btree ("invited_by");