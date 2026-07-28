ALTER TABLE "game_config" ADD COLUMN "start_x" integer;--> statement-breakpoint
ALTER TABLE "game_config" ADD COLUMN "start_y" integer;--> statement-breakpoint
ALTER TABLE "game_config" ADD CONSTRAINT "game_config_start_x_range" CHECK ("game_config"."start_x" IS NULL OR ("game_config"."start_x" >= 0 AND "game_config"."start_x" < 128));--> statement-breakpoint
ALTER TABLE "game_config" ADD CONSTRAINT "game_config_start_y_range" CHECK ("game_config"."start_y" IS NULL OR ("game_config"."start_y" >= 0 AND "game_config"."start_y" < 128));