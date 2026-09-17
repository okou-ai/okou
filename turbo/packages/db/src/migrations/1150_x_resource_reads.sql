CREATE TABLE "x_resource_reads" (
	"utc_day" date NOT NULL,
	"resource_type" varchar(10) NOT NULL,
	"resource_id" varchar(32) NOT NULL,
	CONSTRAINT "x_resource_reads_utc_day_resource_type_resource_id_pk" PRIMARY KEY("utc_day","resource_type","resource_id"),
	CONSTRAINT "x_resource_read_day_check" CHECK (isfinite("x_resource_reads"."utc_day")),
	CONSTRAINT "x_resource_read_type_check" CHECK ("x_resource_reads"."resource_type" IN ('post', 'user')),
	CONSTRAINT "x_resource_read_id_check" CHECK ("x_resource_reads"."resource_id" ~ '^[0-9]{1,32}$')
);
