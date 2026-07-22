-- Hand-edited after generation. `ADD COLUMN ... NOT NULL` with no default is a table lock and a
-- failure on any table that already has rows, and both of these do: the catalogs are live in
-- production. Add nullable, fill, then constrain.
ALTER TABLE "building_type" ADD COLUMN "icon" text;--> statement-breakpoint
ALTER TABLE "terrain_type" ADD COLUMN "icon" text;--> statement-breakpoint

-- Keyed on display_name, which is normally the wrong thing to key on — it is the reskin column
-- and will change. It is safe here only because a migration runs once, against exactly the seven
-- terrain rows and one building row that exist the moment it runs. Nothing else may key on it.
--
-- Forest's colour moves with the same statement: dark trees on the old dark-green tile were
-- invisible, so the colour is part of the art change, not a separate tuning edit.
UPDATE "terrain_type" SET "icon" = CASE "display_name"
	WHEN 'Meadow' THEN 'meadow'
	WHEN 'Forest' THEN 'forest'
	WHEN 'Clay pit' THEN 'clay'
	WHEN 'Stone outcrop' THEN 'stone'
	WHEN 'Iron vein' THEN 'iron'
	WHEN 'Mountain' THEN 'mountain'
	WHEN 'Water' THEN 'water'
	-- Anything unrecognised gets no art rather than the wrong art.
	ELSE ''
END;--> statement-breakpoint
UPDATE "terrain_type" SET "color" = '#5c9448' WHERE "display_name" = 'Forest';--> statement-breakpoint
UPDATE "building_type" SET "icon" = CASE "display_name" WHEN 'House' THEN 'house' ELSE '' END;--> statement-breakpoint

ALTER TABLE "building_type" ALTER COLUMN "icon" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "terrain_type" ALTER COLUMN "icon" SET NOT NULL;
