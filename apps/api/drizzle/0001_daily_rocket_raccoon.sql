CREATE TABLE "challenge" (
	"id" text PRIMARY KEY NOT NULL,
	"title" text NOT NULL,
	"description" text,
	"amount" numeric(10, 2) NOT NULL,
	"currency" text DEFAULT 'USD' NOT NULL,
	"deadline" timestamp with time zone NOT NULL,
	"status" text DEFAULT 'draft' NOT NULL,
	"created_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "ledger" (
	"id" text PRIMARY KEY NOT NULL,
	"challenge_id" text,
	"from_user_id" text,
	"to_user_id" text,
	"actor_user_id" text,
	"amount" numeric(10, 2) NOT NULL,
	"currency" text NOT NULL,
	"type" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "participant" (
	"id" text PRIMARY KEY NOT NULL,
	"challenge_id" text NOT NULL,
	"user_id" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"status_at" timestamp with time zone,
	"joined_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "participant_challenge_id_user_id_unique" UNIQUE("challenge_id","user_id")
);
--> statement-breakpoint
CREATE TABLE "follow" (
	"id" text PRIMARY KEY NOT NULL,
	"follower_id" text NOT NULL,
	"following_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "follow_follower_id_following_id_unique" UNIQUE("follower_id","following_id")
);
--> statement-breakpoint
ALTER TABLE "challenge" ADD CONSTRAINT "challenge_created_by_user_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ledger" ADD CONSTRAINT "ledger_challenge_id_challenge_id_fk" FOREIGN KEY ("challenge_id") REFERENCES "public"."challenge"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ledger" ADD CONSTRAINT "ledger_from_user_id_user_id_fk" FOREIGN KEY ("from_user_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ledger" ADD CONSTRAINT "ledger_to_user_id_user_id_fk" FOREIGN KEY ("to_user_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ledger" ADD CONSTRAINT "ledger_actor_user_id_user_id_fk" FOREIGN KEY ("actor_user_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "participant" ADD CONSTRAINT "participant_challenge_id_challenge_id_fk" FOREIGN KEY ("challenge_id") REFERENCES "public"."challenge"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "participant" ADD CONSTRAINT "participant_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "follow" ADD CONSTRAINT "follow_follower_id_user_id_fk" FOREIGN KEY ("follower_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "follow" ADD CONSTRAINT "follow_following_id_user_id_fk" FOREIGN KEY ("following_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "challenge_created_by_idx" ON "challenge" USING btree ("created_by");--> statement-breakpoint
CREATE INDEX "challenge_status_idx" ON "challenge" USING btree ("status");--> statement-breakpoint
CREATE INDEX "challenge_deadline_idx" ON "challenge" USING btree ("deadline");--> statement-breakpoint
CREATE INDEX "ledger_from_user_idx" ON "ledger" USING btree ("from_user_id");--> statement-breakpoint
CREATE INDEX "ledger_to_user_idx" ON "ledger" USING btree ("to_user_id");--> statement-breakpoint
CREATE INDEX "ledger_challenge_id_idx" ON "ledger" USING btree ("challenge_id");--> statement-breakpoint
CREATE INDEX "participant_user_id_idx" ON "participant" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "participant_challenge_id_idx" ON "participant" USING btree ("challenge_id");--> statement-breakpoint
CREATE INDEX "follow_follower_id_idx" ON "follow" USING btree ("follower_id");--> statement-breakpoint
CREATE INDEX "follow_following_id_idx" ON "follow" USING btree ("following_id");