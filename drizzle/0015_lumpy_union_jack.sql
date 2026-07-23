ALTER TABLE "game_config" ADD COLUMN "settler_baseline" real DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE "game_config" ADD COLUMN "skill_curve" real DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "operation" ADD COLUMN "quality_multiplier" real DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE "operation" ADD CONSTRAINT "operation_quality_positive" CHECK ("operation"."quality_multiplier" > 0);