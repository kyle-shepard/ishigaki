ALTER TABLE "operation" ALTER COLUMN "building_type_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "operation" ALTER COLUMN "complete_at" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "operation" ADD COLUMN "accrued_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "resource" ADD COLUMN "units_per_hour" real DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "operation" ADD CONSTRAINT "operation_build_is_complete" CHECK ("operation"."type" <> 'build' OR ("operation"."building_type_id" IS NOT NULL AND "operation"."complete_at" IS NOT NULL));--> statement-breakpoint
ALTER TABLE "operation" ADD CONSTRAINT "operation_gather_accrues" CHECK ("operation"."type" <> 'gather' OR "operation"."accrued_at" IS NOT NULL);