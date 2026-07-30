ALTER TABLE "game_config" ADD COLUMN "terrain_hash" text;--> statement-breakpoint
ALTER TABLE "terrain_type" ADD COLUMN "char" text;--> statement-breakpoint
ALTER TABLE "terrain_type" ADD COLUMN "capacity" integer;--> statement-breakpoint
ALTER TABLE "terrain_type" ADD CONSTRAINT "terrain_type_char_unique" UNIQUE("char");