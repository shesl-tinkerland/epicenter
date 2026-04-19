CREATE TABLE "ledger" (
	"id" text PRIMARY KEY NOT NULL,
	"wager_id" text,
	"from_user_id" text NOT NULL,
	"to_user_id" text NOT NULL,
	"actor_user_id" text,
	"amount" numeric(10, 2) NOT NULL,
	"currency" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "ledger_no_self_transfer" CHECK (from_user_id <> to_user_id)
);
--> statement-breakpoint
CREATE TABLE "wager" (
	"id" text PRIMARY KEY NOT NULL,
	"committer_id" text NOT NULL,
	"title" text NOT NULL,
	"description" text,
	"amount" numeric(10, 2) NOT NULL,
	"currency" text DEFAULT 'USD' NOT NULL,
	"deadline" timestamp with time zone NOT NULL,
	"outcome" text,
	"outcome_at" timestamp with time zone,
	"outcome_actor_id" text,
	"cancelled_at" timestamp with time zone,
	"cancelled_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "wager_amount_positive" CHECK (amount > 0),
	CONSTRAINT "wager_outcome_valid" CHECK (outcome IS NULL OR outcome IN ('done', 'missed'))
);
--> statement-breakpoint
CREATE TABLE "witness" (
	"id" text PRIMARY KEY NOT NULL,
	"wager_id" text NOT NULL,
	"user_id" text NOT NULL,
	"added_by" text,
	"joined_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "witness_wager_id_user_id_unique" UNIQUE("wager_id","user_id")
);
--> statement-breakpoint
CREATE TABLE "follow" (
	"id" text PRIMARY KEY NOT NULL,
	"follower_id" text NOT NULL,
	"following_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "follow_follower_id_following_id_unique" UNIQUE("follower_id","following_id"),
	CONSTRAINT "follow_no_self_follow" CHECK (follower_id <> following_id)
);
--> statement-breakpoint
DROP INDEX "doi_user_id_idx";--> statement-breakpoint
ALTER TABLE "asset" ALTER COLUMN "uploaded_at" SET DATA TYPE timestamp with time zone;--> statement-breakpoint
ALTER TABLE "asset" ALTER COLUMN "uploaded_at" SET DEFAULT now();--> statement-breakpoint
ALTER TABLE "durable_object_instance" ALTER COLUMN "created_at" SET DATA TYPE timestamp with time zone;--> statement-breakpoint
ALTER TABLE "durable_object_instance" ALTER COLUMN "created_at" SET DEFAULT now();--> statement-breakpoint
ALTER TABLE "durable_object_instance" ALTER COLUMN "last_accessed_at" SET DATA TYPE timestamp with time zone;--> statement-breakpoint
ALTER TABLE "durable_object_instance" ALTER COLUMN "last_accessed_at" SET DEFAULT now();--> statement-breakpoint
ALTER TABLE "durable_object_instance" ALTER COLUMN "storage_measured_at" SET DATA TYPE timestamp with time zone;--> statement-breakpoint
ALTER TABLE "ledger" ADD CONSTRAINT "ledger_wager_id_wager_id_fk" FOREIGN KEY ("wager_id") REFERENCES "public"."wager"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ledger" ADD CONSTRAINT "ledger_from_user_id_user_id_fk" FOREIGN KEY ("from_user_id") REFERENCES "public"."user"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ledger" ADD CONSTRAINT "ledger_to_user_id_user_id_fk" FOREIGN KEY ("to_user_id") REFERENCES "public"."user"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ledger" ADD CONSTRAINT "ledger_actor_user_id_user_id_fk" FOREIGN KEY ("actor_user_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wager" ADD CONSTRAINT "wager_committer_id_user_id_fk" FOREIGN KEY ("committer_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wager" ADD CONSTRAINT "wager_outcome_actor_id_user_id_fk" FOREIGN KEY ("outcome_actor_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wager" ADD CONSTRAINT "wager_cancelled_by_user_id_fk" FOREIGN KEY ("cancelled_by") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "witness" ADD CONSTRAINT "witness_wager_id_wager_id_fk" FOREIGN KEY ("wager_id") REFERENCES "public"."wager"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "witness" ADD CONSTRAINT "witness_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "witness" ADD CONSTRAINT "witness_added_by_user_id_fk" FOREIGN KEY ("added_by") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "follow" ADD CONSTRAINT "follow_follower_id_user_id_fk" FOREIGN KEY ("follower_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "follow" ADD CONSTRAINT "follow_following_id_user_id_fk" FOREIGN KEY ("following_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "ledger_from_user_idx" ON "ledger" USING btree ("from_user_id");--> statement-breakpoint
CREATE INDEX "ledger_to_user_idx" ON "ledger" USING btree ("to_user_id");--> statement-breakpoint
CREATE INDEX "ledger_wager_idx" ON "ledger" USING btree ("wager_id");--> statement-breakpoint
CREATE INDEX "wager_committer_idx" ON "wager" USING btree ("committer_id");--> statement-breakpoint
CREATE INDEX "witness_user_idx" ON "witness" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "follow_following_id_idx" ON "follow" USING btree ("following_id");--> statement-breakpoint
CREATE INDEX "durable_object_instance_user_id_idx" ON "durable_object_instance" USING btree ("user_id");