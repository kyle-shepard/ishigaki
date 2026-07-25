-- Hand-edited: the generated statement was a single ADD COLUMN ... NOT NULL, which cannot land on a
-- table that already holds rows. Split into add / backfill / constrain, so a world with journeys
-- under way survives the deploy instead of failing it.
ALTER TABLE "operation_worker" ADD COLUMN "path" integer[];--> statement-breakpoint

-- Every leg in flight was a straight line from its origin to its operation's destination, so that is
-- exactly the two-point route it becomes: the body carries on walking the line it was already on and
-- arrives when it was always going to. 48 is GRID_SIZE as of this migration, written as a literal on
-- purpose — a migration is a fact about the past, and must not change meaning if the map grows.
UPDATE "operation_worker" w
SET "path" = ARRAY[w."origin_y" * 48 + w."origin_x", o."dest_y" * 48 + o."dest_x"]
FROM "operation" o
WHERE o."id" = w."operation_id";--> statement-breakpoint

ALTER TABLE "operation_worker" ALTER COLUMN "path" SET NOT NULL;
