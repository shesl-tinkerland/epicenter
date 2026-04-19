DROP INDEX "ledger_from_user_idx";--> statement-breakpoint
DROP INDEX "ledger_to_user_idx";--> statement-breakpoint
DROP INDEX "participant_challenge_id_idx";--> statement-breakpoint
DROP INDEX "doi_user_id_idx";--> statement-breakpoint
DROP INDEX "follow_follower_id_idx";--> statement-breakpoint
ALTER TABLE "asset" ALTER COLUMN "uploaded_at" SET DATA TYPE timestamp with time zone;--> statement-breakpoint
ALTER TABLE "asset" ALTER COLUMN "uploaded_at" SET DEFAULT now();--> statement-breakpoint
ALTER TABLE "durable_object_instance" ALTER COLUMN "created_at" SET DATA TYPE timestamp with time zone;--> statement-breakpoint
ALTER TABLE "durable_object_instance" ALTER COLUMN "created_at" SET DEFAULT now();--> statement-breakpoint
ALTER TABLE "durable_object_instance" ALTER COLUMN "last_accessed_at" SET DATA TYPE timestamp with time zone;--> statement-breakpoint
ALTER TABLE "durable_object_instance" ALTER COLUMN "last_accessed_at" SET DEFAULT now();--> statement-breakpoint
ALTER TABLE "durable_object_instance" ALTER COLUMN "storage_measured_at" SET DATA TYPE timestamp with time zone;--> statement-breakpoint
ALTER TABLE "challenge" ADD COLUMN "updated_at" timestamp with time zone DEFAULT now() NOT NULL;--> statement-breakpoint
ALTER TABLE "participant" ADD COLUMN "updated_at" timestamp with time zone DEFAULT now() NOT NULL;--> statement-breakpoint
CREATE INDEX "ledger_from_user_id_idx" ON "ledger" USING btree ("from_user_id");--> statement-breakpoint
CREATE INDEX "ledger_to_user_id_idx" ON "ledger" USING btree ("to_user_id");--> statement-breakpoint
CREATE INDEX "durable_object_instance_user_id_idx" ON "durable_object_instance" USING btree ("user_id");--> statement-breakpoint
ALTER TABLE "challenge" ADD CONSTRAINT "challenge_status_valid" CHECK (status IN ('draft', 'sent', 'live', 'cancelled'));--> statement-breakpoint
ALTER TABLE "ledger" ADD CONSTRAINT "ledger_type_valid" CHECK (type IN ('participant_status', 'participant_status_reversal', 'payment'));--> statement-breakpoint
ALTER TABLE "participant" ADD CONSTRAINT "participant_status_valid" CHECK (status IN ('pending', 'done', 'missed'));