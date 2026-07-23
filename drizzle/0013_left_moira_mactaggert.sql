ALTER TABLE "game_config" ADD COLUMN "food_per_capita_hour" real DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "game_config" ADD COLUMN "starve_per_hour" real DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "resource" ADD COLUMN "is_sustenance" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "settlement" ADD COLUMN "population_accrued" real DEFAULT 0 NOT NULL;