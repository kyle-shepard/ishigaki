ALTER TABLE "operation" DROP CONSTRAINT "operation_build_is_complete";--> statement-breakpoint
ALTER TABLE "operation" ALTER COLUMN "started_at" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "operation" ADD COLUMN "crew_size" integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE "operation" ADD CONSTRAINT "operation_in_progress_has_started" CHECK ("operation"."status" <> 'in-progress' OR "operation"."started_at" IS NOT NULL);--> statement-breakpoint
ALTER TABLE "operation" ADD CONSTRAINT "operation_build_is_complete" CHECK ("operation"."type" <> 'build' OR "operation"."status" = 'queued' OR ("operation"."building_type_id" IS NOT NULL AND "operation"."complete_at" IS NOT NULL));