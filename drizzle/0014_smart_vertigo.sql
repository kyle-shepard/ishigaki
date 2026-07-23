CREATE TABLE "profession" (
	"id" serial PRIMARY KEY NOT NULL,
	"display_name" text NOT NULL,
	CONSTRAINT "profession_display_name_unique" UNIQUE("display_name")
);
--> statement-breakpoint
CREATE TABLE "profession_skill" (
	"profession_id" integer NOT NULL,
	"skill_id" integer NOT NULL,
	"value" real NOT NULL,
	CONSTRAINT "profession_skill_profession_id_skill_id_pk" PRIMARY KEY("profession_id","skill_id")
);
--> statement-breakpoint
CREATE TABLE "skill" (
	"id" serial PRIMARY KEY NOT NULL,
	"display_name" text NOT NULL,
	"stat_a" text NOT NULL,
	"stat_b" text NOT NULL,
	CONSTRAINT "skill_display_name_unique" UNIQUE("display_name"),
	CONSTRAINT "skill_stat_a_valid" CHECK ("skill"."stat_a" IN ('strength','dexterity','constitution','intelligence')),
	CONSTRAINT "skill_stat_b_valid" CHECK ("skill"."stat_b" IN ('strength','dexterity','constitution','intelligence'))
);
--> statement-breakpoint
ALTER TABLE "character" ADD COLUMN "profession_id" integer;--> statement-breakpoint
ALTER TABLE "character" ADD COLUMN "name" text;--> statement-breakpoint
ALTER TABLE "character" ADD COLUMN "strength" integer;--> statement-breakpoint
ALTER TABLE "character" ADD COLUMN "dexterity" integer;--> statement-breakpoint
ALTER TABLE "character" ADD COLUMN "constitution" integer;--> statement-breakpoint
ALTER TABLE "character" ADD COLUMN "intelligence" integer;--> statement-breakpoint
ALTER TABLE "operation" ADD COLUMN "profession_id" integer;--> statement-breakpoint
ALTER TABLE "resource" ADD COLUMN "skill_id" integer;--> statement-breakpoint
ALTER TABLE "profession_skill" ADD CONSTRAINT "profession_skill_profession_id_profession_id_fk" FOREIGN KEY ("profession_id") REFERENCES "public"."profession"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "profession_skill" ADD CONSTRAINT "profession_skill_skill_id_skill_id_fk" FOREIGN KEY ("skill_id") REFERENCES "public"."skill"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "character" ADD CONSTRAINT "character_profession_id_profession_id_fk" FOREIGN KEY ("profession_id") REFERENCES "public"."profession"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "operation" ADD CONSTRAINT "operation_profession_id_profession_id_fk" FOREIGN KEY ("profession_id") REFERENCES "public"."profession"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "resource" ADD CONSTRAINT "resource_skill_id_skill_id_fk" FOREIGN KEY ("skill_id") REFERENCES "public"."skill"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "character" ADD CONSTRAINT "character_tier" CHECK (("character"."profession_id" IS NULL AND "character"."name" IS NULL AND "character"."strength" IS NULL AND "character"."dexterity" IS NULL AND "character"."constitution" IS NULL AND "character"."intelligence" IS NULL)
			 OR ("character"."profession_id" IS NOT NULL AND "character"."name" IS NOT NULL AND "character"."strength" IS NOT NULL AND "character"."dexterity" IS NOT NULL AND "character"."constitution" IS NOT NULL AND "character"."intelligence" IS NOT NULL));--> statement-breakpoint
ALTER TABLE "operation" ADD CONSTRAINT "operation_train_is_complete" CHECK ("operation"."type" <> 'train' OR ("operation"."profession_id" IS NOT NULL AND "operation"."complete_at" IS NOT NULL));