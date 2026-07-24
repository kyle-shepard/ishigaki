CREATE TABLE "operation_worker" (
	"operation_id" integer NOT NULL,
	"character_id" integer NOT NULL,
	"quality_multiplier" real NOT NULL,
	"arrives_at" timestamp with time zone NOT NULL,
	"origin_x" integer NOT NULL,
	"origin_y" integer NOT NULL,
	CONSTRAINT "operation_worker_operation_id_character_id_pk" PRIMARY KEY("operation_id","character_id"),
	CONSTRAINT "operation_worker_quality_positive" CHECK ("operation_worker"."quality_multiplier" > 0)
);
--> statement-breakpoint
ALTER TABLE "operation" DROP CONSTRAINT "operation_character_id_character_id_fk";
--> statement-breakpoint
ALTER TABLE "operation_worker" ADD CONSTRAINT "operation_worker_operation_id_operation_id_fk" FOREIGN KEY ("operation_id") REFERENCES "public"."operation"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "operation_worker" ADD CONSTRAINT "operation_worker_character_id_character_id_fk" FOREIGN KEY ("character_id") REFERENCES "public"."character"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "operation_worker_character_idx" ON "operation_worker" USING btree ("character_id");--> statement-breakpoint
-- Hand-written: drizzle-kit emits DDL only, and the columns below are dropped in the same
-- migration. Without this every in-flight operation would lose its worker and its origin —
-- realms carry forward instead. One row per existing operation; every operation had exactly
-- one worker, which is the whole reason this table exists.
INSERT INTO "operation_worker" ("operation_id", "character_id", "quality_multiplier", "arrives_at", "origin_x", "origin_y")
SELECT "id", "character_id", "quality_multiplier", "travel_done_at", "origin_x", "origin_y" FROM "operation";--> statement-breakpoint
ALTER TABLE "operation" DROP COLUMN "character_id";--> statement-breakpoint
ALTER TABLE "operation" DROP COLUMN "origin_x";--> statement-breakpoint
ALTER TABLE "operation" DROP COLUMN "origin_y";--> statement-breakpoint
ALTER TABLE "operation" DROP COLUMN "travel_done_at";